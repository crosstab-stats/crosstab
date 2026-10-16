/**
 * @file settings-store.test.mjs
 * The unified settings registry, and the behaviours it had to preserve exactly.
 *
 * Six modules each rebuilt the same five pieces around `localStorage` — key, accepted
 * values, default, validate-on-read, and a `try/catch` on both sides because storage
 * throws outright in Safari private mode and in a sandboxed frame. Folding them together
 * is only safe if the fold is behaviour-preserving, and two of those behaviours are not
 * what a naive unification would produce:
 *
 *  - **`screen.mode` is tri-state.** `small`, `full`, or null for "nobody has said" —
 *    the null is what lets the viewport decide. A default here would read as a choice.
 *  - **`screen.autoNoteSeen` answers `true` when storage THROWS.** Not its fallback: if a
 *    dismissal cannot be remembered, reporting "not seen" re-shows the note on every
 *    load, nagging exactly the user whose browser cannot be told to stop.
 *
 * And the quiet catastrophe this guards against: renaming a key. It costs nothing to
 * type, passes every test that does not check, and silently resets the preferences of
 * every existing user on upgrade.
 *
 * The suite runs with no `localStorage` at all, so each test installs its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { defineSetting, listSettings, settingIds } from '../core/settings.js';
import { loadVarOrder, saveVarOrder, loadVarDisplay, saveVarDisplay } from '../core/var-order.js';
import { storedScreenMode, saveScreenMode, autoNoteSeen, dismissAutoNote } from '../core/screen-mode.js';
import { isDebug, setDebug } from '../core/debug.js';
import { getEncryptionPolicy, setEncryptionPolicy, defaultEncrypt } from '../core/at-rest.js';
import {
  getRelayUrls, setRelayUrls, getTurnConfig, setTurnConfig, DEFAULT_RELAYS,
} from '../core/live-sync.js';

/** A `localStorage` stand-in; `explode` makes every call throw, as private mode does. */
function fakeStorage(seed = {}, { explode = false } = {}) {
  const map = new Map(Object.entries(seed));
  const boom = () => { throw new DOMException('denied', 'SecurityError'); };
  return {
    getItem: (k) => (explode ? boom() : (map.has(k) ? map.get(k) : null)),
    setItem: (k, v) => (explode ? boom() : void map.set(k, String(v))),
    removeItem: (k) => (explode ? boom() : void map.delete(k)),
    map,
  };
}

/** Run `fn` against a given storage, then put the environment back. */
function withStorage(store, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const prev = globalThis.localStorage;
  globalThis.localStorage = store;
  try { return fn(store); } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
}

// =============================================================================
// The keys. This is the test that matters most.
// =============================================================================

test('every setting still uses the key its module shipped with', () => {
  // Renaming any of these resets that preference for every existing user, silently and
  // irreversibly. If one of these fails, the fix is to restore the key — never to update
  // the expectation.
  const byId = Object.fromEntries(listSettings().map((s) => [s.id, s]));
  assert.equal(byId['varlist.order'].key, 'crosstab.varlist.sort');
  assert.deepEqual(byId['varlist.order'].legacyKeys, ['crosstab.varpicker.sort']);
  assert.equal(byId['varlist.display'].key, 'crosstab.varlist.display');
  assert.equal(byId['screen.mode'].key, 'crosstab.screen-mode');
  assert.equal(byId['screen.autoNoteSeen'].key, 'crosstab.screen-mode.noted');
  assert.equal(byId['debug.logging'].key, 'crosstab_debug');
  assert.equal(byId['privacy.encryption'].key, 'crosstab.encryption-policy');
  assert.equal(byId['collab.relays'].key, 'crosstab.relays');
  assert.equal(byId['collab.turn'].key, 'crosstab.turn');
});

test('a setting cannot collide with another by id or by key', () => {
  assert.throws(() => defineSetting({ id: 'varlist.order', key: 'whatever' }), /already defined/);
  assert.throws(() => defineSetting({ id: 'something.else', key: 'crosstab.varlist.sort' }),
    /reuses the key/);
});

// =============================================================================
// Reading: stored, absent, and nonsense
// =============================================================================

test('a stored preference is read back', () => {
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'name-desc', 'crosstab.varlist.display': 'both' }), () => {
    assert.equal(loadVarOrder(), 'name-desc');
    assert.equal(loadVarDisplay(), 'both');
  });
});

test('nothing stored means the default the surfaces had before the choice existed', () => {
  withStorage(fakeStorage(), () => {
    assert.equal(loadVarOrder(), 'file');
    assert.equal(loadVarDisplay(), 'label');
  });
});

test('a value outside the accepted set degrades to the default', () => {
  // Hand-edited storage, or a value from a build that offered an order this one dropped.
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'by-vibes' }), () => {
    assert.equal(loadVarOrder(), 'file');
  });
});

test('the legacy key is still honoured, and the current one wins', () => {
  withStorage(fakeStorage({ 'crosstab.varpicker.sort': 'label' }), () => {
    assert.equal(loadVarOrder(), 'label', 'a preference set before the rename must survive');
  });
  withStorage(fakeStorage({ 'crosstab.varpicker.sort': 'label', 'crosstab.varlist.sort': 'name' }), () => {
    assert.equal(loadVarOrder(), 'name');
  });
});

test('a legacy key is read but never written', () => {
  withStorage(fakeStorage({ 'crosstab.varpicker.sort': 'label' }), (s) => {
    saveVarOrder('name-desc');
    assert.equal(s.map.get('crosstab.varlist.sort'), 'name-desc');
    assert.equal(s.map.get('crosstab.varpicker.sort'), 'label', 'the old key is left as it was');
  });
});

// =============================================================================
// Writing
// =============================================================================

test('writing an unaccepted value is a no-op, not a throw or a corrupted entry', () => {
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'name' }), (s) => {
    saveVarOrder('by-vibes');
    assert.equal(s.map.get('crosstab.varlist.sort'), 'name', 'the good value must survive a bad write');
  });
});

test('storage that throws on write loses the preference without taking the app with it', () => {
  withStorage(fakeStorage({}, { explode: true }), () => {
    assert.doesNotThrow(() => saveVarOrder('name'));
    assert.doesNotThrow(() => saveVarDisplay('both'));
    assert.doesNotThrow(() => dismissAutoNote());
  });
});

// =============================================================================
// The two behaviours a naive fold would get wrong
// =============================================================================

test('screen mode is tri-state: null means nobody has said, so the viewport decides', () => {
  withStorage(fakeStorage(), () => assert.equal(storedScreenMode(), null));
  withStorage(fakeStorage({ 'crosstab.screen-mode': 'full' }), () => assert.equal(storedScreenMode(), 'full'));
  // Not a mode ⇒ not a choice. It must not fall back to 'full', which would outrank the
  // viewport on the strength of a corrupted entry.
  withStorage(fakeStorage({ 'crosstab.screen-mode': 'medium' }), () => assert.equal(storedScreenMode(), null));
  withStorage(fakeStorage({}, { explode: true }), () => assert.equal(storedScreenMode(), null));
});

test('a dismissal that cannot be remembered reads as seen, so the note stops nagging', () => {
  withStorage(fakeStorage(), () => assert.equal(autoNoteSeen(), false));
  withStorage(fakeStorage({ 'crosstab.screen-mode.noted': '1' }), () => assert.equal(autoNoteSeen(), true));
  // The asymmetry. Fallback is "not seen"; on a THROW the answer is the opposite.
  withStorage(fakeStorage({}, { explode: true }), () => assert.equal(autoNoteSeen(), true));
});

test('screen mode round-trips through its own accessors', () => {
  withStorage(fakeStorage(), (s) => {
    saveScreenMode('small');
    assert.equal(s.map.get('crosstab.screen-mode'), 'small');
    assert.equal(storedScreenMode(), 'small');
    saveScreenMode('sideways');
    assert.equal(storedScreenMode(), 'small', 'a bad write must not clear a good choice');
  });
});

// =============================================================================
// Debug: off is an ABSENT key, and the value is free-form
// =============================================================================

test('turning debug off removes the key rather than writing a falsy string', () => {
  withStorage(fakeStorage(), (s) => {
    setDebug(true);
    assert.equal(s.map.get('crosstab_debug'), '1');
    assert.equal(isDebug(), true);
    setDebug(false);
    assert.equal(s.map.has('crosstab_debug'), false, '"0" would read as truthy to the gate');
    assert.equal(isDebug(), false);
  });
});

test('a tag list is a valid gate value — the setting is free-form on purpose', () => {
  // The menu checkbox writes '1'; a developer in the console narrows it to tags. A
  // `values` list would have quietly rejected the second.
  withStorage(fakeStorage({ 'crosstab_debug': 'ws-mgr,app' }), () => {
    setDebug(true); // re-reads the gate
  });
  withStorage(fakeStorage({}, { explode: true }), () => {
    assert.doesNotThrow(() => setDebug(true));
  });
  setDebug(false); // leave the process as we found it
});

// =============================================================================
// What a Settings screen would see
// =============================================================================

test('listSettings reports each declared setting with its current value', () => {
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'label-desc' }), () => {
    const row = listSettings().find((s) => s.id === 'varlist.order');
    assert.equal(row.value, 'label-desc');
    assert.equal(row.group, 'Variables');
    assert.ok(row.label && row.hint, 'a screen needs something to print');
    assert.deepEqual(row.options.map(([v]) => v).slice(0, 2), ['file', 'file-desc']);
  });
});

test('state, caches and credentials are NOT settings', () => {
  // The boundary is the point of the registry: a Settings screen enumerating plugin
  // install state would invite someone to "fix" it, and one enumerating the Dropbox
  // config would print a token.
  const keys = listSettings().map((s) => s.key);
  for (const notASetting of [
    'crosstab.plugins.catalog', 'crosstab.plugins.disabled', 'crosstab.plugins.user',
    'crosstab.dropbox.config', 'crosstab.identity', 'crosstab.launcher.seen',
    'crosstab.oauth.result', 'crosstab.offline.resume',
  ]) {
    // The encryption policy and the collab config are NOT in this list: they are
    // settings, and they are declared (owner, 2026-10-15). Dropbox stays out because it
    // is a credential store rather than a preference.
    assert.ok(!keys.includes(notASetting), `${notASetting} must not be a declared setting`);
  }
});

test('every declared id is namespaced, so a screen can group them', () => {
  for (const id of settingIds()) assert.match(id, /^[a-z]+\.[a-zA-Z]+$/, id);
});

// =============================================================================
// Shaped settings — stored as JSON, with their own write rules
// =============================================================================

test('the encryption policy merges what is stored OVER the defaults', () => {
  // The stored value may be a partial. A target nobody has ruled on keeps following the
  // default — including after the default changes — which a stored full snapshot would
  // have quietly frozen.
  withStorage(fakeStorage({ 'crosstab.encryption-policy': JSON.stringify({ local: true }) }), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: true });
  });
  withStorage(fakeStorage(), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: false });
  });
});

test('the policy a caller receives is theirs to mutate', () => {
  // It has always been a fresh object. Handing back the frozen DEFAULTS instead would
  // turn a stray write into a silent no-op — or a throw, in a strict-mode caller.
  withStorage(fakeStorage(), () => {
    const a = getEncryptionPolicy();
    a.local = true;
    assert.equal(getEncryptionPolicy().local, false, 'the default must not be edited in place');
    assert.equal(defaultEncrypt('export'), true);
  });
});

test('a corrupt policy falls back to the defaults rather than throwing', () => {
  withStorage(fakeStorage({ 'crosstab.encryption-policy': '{not json' }), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: false });
  });
  // An array is JSON, and is not a policy.
  withStorage(fakeStorage({ 'crosstab.encryption-policy': '[1,2]' }), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: false });
  });
  withStorage(fakeStorage({}, { explode: true }), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: false });
  });
});

test('setting the policy writes a patch merged over what was there', () => {
  withStorage(fakeStorage(), (s) => {
    assert.deepEqual(setEncryptionPolicy({ local: true }), { export: true, folder: true, local: true });
    assert.deepEqual(JSON.parse(s.map.get('crosstab.encryption-policy')),
      { export: true, folder: true, local: true });
    setEncryptionPolicy({ export: false });
    assert.equal(getEncryptionPolicy().local, true, 'the earlier choice must survive');
    assert.equal(getEncryptionPolicy().export, false);
  });
});

test('relays fall back to the curated list, and an empty override CLEARS', () => {
  withStorage(fakeStorage(), (s) => {
    assert.deepEqual(getRelayUrls(), DEFAULT_RELAYS);
    setRelayUrls(['wss://mine.example.edu/mqtt']);
    assert.deepEqual(getRelayUrls(), ['wss://mine.example.edu/mqtt']);
    // "Use no relays" is not something anyone can mean, so [] removes the override
    // rather than storing emptiness.
    setRelayUrls([]);
    assert.equal(s.map.has('crosstab.relays'), false);
    assert.deepEqual(getRelayUrls(), DEFAULT_RELAYS);
    setRelayUrls(['wss://a']);
    setRelayUrls(null);
    assert.deepEqual(getRelayUrls(), DEFAULT_RELAYS);
  });
});

test('a stored relay list that is not a non-empty array is ignored', () => {
  for (const junk of ['[]', '"wss://a"', '{"a":1}', 'null', 'not json']) {
    withStorage(fakeStorage({ 'crosstab.relays': junk }), () => {
      assert.deepEqual(getRelayUrls(), DEFAULT_RELAYS, junk);
    });
  }
});

test('the TURN config round-trips and clears', () => {
  withStorage(fakeStorage(), (s) => {
    assert.equal(getTurnConfig(), null);
    setTurnConfig({ urls: 'turn:relay.example.edu', username: 'u', credential: 'p' });
    assert.equal(getTurnConfig().urls, 'turn:relay.example.edu');
    setTurnConfig(null);
    assert.equal(s.map.has('crosstab.turn'), false);
    assert.equal(getTurnConfig(), null);
  });
  withStorage(fakeStorage({ 'crosstab.turn': 'not json' }), () => {
    assert.equal(getTurnConfig(), null, 'a corrupt entry must not throw at connect time');
  });
});

// =============================================================================
// The secret
// =============================================================================

test('listSettings never prints the TURN credential', () => {
  // The whole point of the registry is that a screen can enumerate it. A TURN entry
  // holds a username and a credential, so enumerating must not mean disclosing.
  withStorage(fakeStorage({
    'crosstab.turn': JSON.stringify({ urls: 'turn:x', username: 'u', credential: 'SECRET' }),
  }), () => {
    const row = listSettings().find((r) => r.id === 'collab.turn');
    assert.equal(row.secret, true);
    assert.equal(row.value, undefined, 'a secret setting must not report its value');
    assert.equal(row.isSet, true, 'but a screen may still say that one is configured');
    assert.ok(!JSON.stringify(listSettings()).includes('SECRET'),
      'the credential must not appear anywhere in the listing');
  });
  withStorage(fakeStorage(), () => {
    assert.equal(listSettings().find((r) => r.id === 'collab.turn').isSet, false);
  });
});

test('isSet distinguishes a chosen value from a default', () => {
  // What a screen needs to show "Default" beside an untouched setting rather than
  // implying the user picked it.
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'name' }), () => {
    const byId = Object.fromEntries(listSettings().map((r) => [r.id, r]));
    assert.equal(byId['varlist.order'].isSet, true);
    assert.equal(byId['varlist.display'].isSet, false);
    assert.equal(byId['varlist.display'].value, 'label', 'still reports the effective value');
  });
});

test('a shaped setting reports its effective value to a screen', () => {
  withStorage(fakeStorage({ 'crosstab.encryption-policy': JSON.stringify({ local: true }) }), () => {
    const row = listSettings().find((r) => r.id === 'privacy.encryption');
    assert.deepEqual(row.value, { export: true, folder: true, local: true });
    assert.equal(row.group, 'Privacy');
  });
});

test('listSettings is the authority on what is declared', () => {
  // The header deliberately quotes no count — `listSettings()` answers that, and a
  // number in prose would be a second copy of it with no failure mode. What is worth
  // pinning is that the authority WORKS: every declared setting comes back, with the
  // metadata a Settings screen would need.
  const rows = listSettings();
  assert.equal(rows.length, settingIds().length);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.id && r.key, `${r.id}: a row needs an id and a key`);
    assert.ok('value' in r && 'isSet' in r, `${r.id}: a screen needs the value and whether it is set`);
  }
});
