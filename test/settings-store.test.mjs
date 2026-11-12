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
import { controlFor } from '../core/settings-screen.js';
import { loadVarOrder, saveVarOrder, loadVarDisplay, saveVarDisplay } from '../core/var-order.js';
import { storedScreenMode, saveScreenMode, autoNoteSeen, dismissAutoNote } from '../core/screen-mode.js';
import { isDebug, setDebug } from '../core/debug.js';
import { getEncryptionPolicy, setEncryptionPolicy, defaultEncrypt } from '../core/at-rest.js';
import {
  getRelayUrls, setRelayUrls, getTurnConfig, setTurnConfig, DEFAULT_RELAYS,
} from '../core/live-sync.js';
// Imported for its DECLARATION as much as its functions: the registry is populated by
// the modules this file imports, so a "X is not a setting" assertion about a module
// nobody imported here would have proved nothing at all.
import { getIdentity, setIdentity } from '../core/user-identity.js';
// Likewise, and it caught the same trap twice: `crosstab.plugins.user` sat in the
// "not a setting" list below while this file never imported the module that could have
// declared it, so the assertion could not have failed whatever the code did.
import '../core/plugin-manager.js';
// Same reason again, for the two exclusions revisited on 2026-11-12.
import '../core/launcher.js';
import '../core/dropbox-session.js';

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
  assert.equal(byId['collab.identity'].key, 'crosstab.identity');
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
    'crosstab.plugins.catalog', 'crosstab.plugins.catalogVersion',
    'crosstab.plugins.disabled',
    'crosstab.oauth.result', 'crosstab.offline.resume',
  ]) {
    // What is left after four rounds of this, and why each one stays out:
    //  - the catalogue + its version are a regenerable CACHE, and there is already a real
    //    control for it (the launcher's "Get updates" clears it and re-probes). The
    //    version is also not the number anyone would read it as: it is a cache epoch
    //    bumped when the catalog SHAPE changes, so it sits still across most releases.
    //  - `plugins.disabled` is install state over sixty-odd built-ins, which is the list
    //    the original exclusion was right to fear on a preferences screen.
    //  - the oauth result and the offline resume are alive for one round trip; a row would
    //    show a value already gone by the time it was read.
    //
    // `crosstab.dropbox.config` and `crosstab.launcher.seen` LEFT this list on 2026-11-12.
    // Both exclusions were written about a category rather than the member: "Credentials"
    // for a key that provably holds no token (PKCE app key + folder; the session tokens
    // are memory-only by design), and "first-run flags" for a flag someone other than the
    // intended user routinely sets — the IT technician who tests the shortcut.
    // `crosstab.plugins.user` left this list on the owner's report (2026-11-12) that
    // plugins added from a file or a URL were missing from the Settings screen. The
    // exclusion had been written as the family `crosstab.plugins.*`, and the wildcard was
    // doing damage: the *disabled* set above really is install state, but this key is the
    // set of sources the user chose — one kind of which is third-party code re-fetched
    // and run on every launch. Declared ROUTED, and the manager stays its only writer.
    // The encryption policy and the collab config are NOT in this list: they are
    // settings, and they are declared (owner, 2026-10-15). Dropbox stays out because it
    // is a credential store rather than a preference.
    //
    // `crosstab.identity` left this list on the owner's report that their name,
    // initials, colour and auto-join toggle were missing from the Settings screen. The
    // blob holds a minted `authorId` as well, which is still data — so it is declared
    // ROUTED and summarised, never printed raw and never clearable from the screen.
    // See the identity tests below.
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

// =============================================================================
// Stored CONTENTS are validated too, not just the shape
// =============================================================================

test('a non-boolean in the stored policy does not change the posture', () => {
  // `shouldEncrypt` is `!!policy[target]`, so before this a stored `{export: 0}`
  // silently stopped encrypting exports and `{local: "no"}` silently started
  // encrypting local storage. A value that is not a boolean is "not said", so the
  // default for that target stands.
  withStorage(fakeStorage({
    'crosstab.encryption-policy': JSON.stringify({ export: 0, folder: 'yes', local: 'no' }),
  }), () => {
    assert.deepEqual(getEncryptionPolicy(), { export: true, folder: true, local: false });
  });
  // A real boolean is still honoured.
  withStorage(fakeStorage({ 'crosstab.encryption-policy': JSON.stringify({ export: false }) }), () => {
    assert.equal(getEncryptionPolicy().export, false);
  });
});

test('an unknown key in the stored policy is dropped', () => {
  withStorage(fakeStorage({
    'crosstab.encryption-policy': JSON.stringify({ local: true, smuggled: true }),
  }), () => {
    assert.deepEqual(Object.keys(getEncryptionPolicy()).sort(), ['export', 'folder', 'local']);
  });
});

test('relay entries are validated, not just the array', () => {
  // They go straight to the rendezvous client as broker URLs.
  withStorage(fakeStorage({
    'crosstab.relays': JSON.stringify(['wss://ok.example/mqtt', 'http://nope', 42, null]),
  }), () => {
    assert.deepEqual(getRelayUrls(), ['wss://ok.example/mqtt']);
  });
  // ws: is allowed — an institution's own broker may be plain inside its network.
  withStorage(fakeStorage({ 'crosstab.relays': JSON.stringify(['ws://intranet:8083/mqtt']) }), () => {
    assert.deepEqual(getRelayUrls(), ['ws://intranet:8083/mqtt']);
  });
});

test('a relay list with nothing valid left falls back to the curated defaults', () => {
  withStorage(fakeStorage({ 'crosstab.relays': JSON.stringify(['javascript:alert(1)', {}]) }), () => {
    assert.deepEqual(getRelayUrls(), DEFAULT_RELAYS);
  });
});

test('validation happens on READ, so a value stored by an older build is checked', () => {
  // The property that makes the registry worth having: nothing trusts what is in
  // storage because it was valid when it was written.
  withStorage(fakeStorage({ 'crosstab.varlist.sort': 'an-order-this-build-dropped' }), () => {
    assert.equal(loadVarOrder(), 'file');
  });
  withStorage(fakeStorage({ 'crosstab.screen-mode': 'medium' }), () => {
    assert.equal(storedScreenMode(), null);
  });
});

// =============================================================================
// The identity profile — a blob that is part data and part preference
// =============================================================================

test('your name, initials, colour and auto-join are things the Settings screen can see', () => {
  // The owner's report: all four were editable only from the avatar button in the top
  // bar, and a screen whose whole purpose is to enumerate what is settable listed none
  // of them.
  const row = listSettings().find((s) => s.id === 'collab.identity');
  assert.ok(row, 'the identity profile has to be declared to be listed');
  assert.ok(row.label && row.hint, 'a screen needs something to print');
  assert.equal(row.group, 'Collaboration');
  assert.ok(row.editedAt, 'routed: the real editor already exists');
});

test('the summary says who you are without printing the minted authorId', () => {
  // `authorId` is the one field in this blob the user never chose, and it is what every
  // attribution they have ever made points at. A screen listing settings prints what was
  // chosen, not the identifier underneath it.
  const spec = listSettings().find((s) => s.id === 'collab.identity');
  const line = spec.summary({
    authorId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    name: 'Jane Public', initials: 'JP', color: '#0072b2', autoLive: true,
  });
  assert.match(line, /Jane Public \(JP\)/);
  assert.match(line, /auto-join live rooms on/);
  assert.ok(!line.includes('f47ac10b'), 'the authorId must never reach the screen');

  assert.match(spec.summary({ authorId: 'x', name: '', initials: '', autoLive: false }),
    /No name set · auto-join live rooms off/);
  assert.equal(spec.summary(null), 'Not set');
});

test('the identity row can be opened but never cleared', () => {
  // Clearing this key re-mints `authorId`, which orphans every attribution the user has
  // made. `controlFor` returning 'route' is what keeps the Clear/Default buttons off the
  // row — see the screen, which offers them for every kind except route and secret.
  const spec = listSettings().find((s) => s.id === 'collab.identity');
  assert.equal(controlFor(spec), 'route');
});

test('identity still round-trips through the registry accessors', () => {
  // It used to hand-roll the same JSON-plus-try/catch the registry does. Behaviour has
  // to be identical: mint on first read, persist on write, and read back what was set.
  withStorage(fakeStorage(), (store) => {
    const first = getIdentity();
    assert.ok(first.authorId, 'an authorId is minted on first use');
    assert.equal(first.set, false);
    assert.ok(store.map.has('crosstab.identity'), 'and persisted immediately');

    setIdentity({ name: 'Jane Public', autoLive: true });
    const back = getIdentity();
    assert.equal(back.authorId, first.authorId, 'the authorId survives a rename');
    assert.equal(back.name, 'Jane Public');
    assert.equal(back.initials, 'JP', 'initials still derive from the name');
    assert.equal(back.autoLive, true);
    assert.equal(back.set, true);

    const row = listSettings().find((s) => s.id === 'collab.identity');
    assert.match(row.summary(row.value), /Jane Public \(JP\) · auto-join live rooms on/);
  });
});

test('a corrupt identity is re-minted rather than crashing the app', () => {
  // The coerce is deliberately permissive — it is the only home of the authorId — so it
  // rejects only what has no usable one.
  for (const junk of ['not json at all', '[]', '{}', 'null', JSON.stringify({ name: 'no id' })]) {
    withStorage(fakeStorage({ 'crosstab.identity': junk }), () => {
      const id = getIdentity();
      assert.ok(id.authorId, `re-minted from ${junk}`);
      assert.ok(id.color, 'and given a stable colour');
    });
  }
});

test('an identity field this build does not know about is kept, not dropped', () => {
  // It is one blob and this module is its only writer, so a value written by a newer
  // build (or by a feature added later) must survive a round trip through the registry.
  withStorage(fakeStorage({
    'crosstab.identity': JSON.stringify({ authorId: 'a1', name: 'Jo', somethingNew: 42 }),
  }), () => {
    const row = listSettings().find((s) => s.id === 'collab.identity');
    assert.equal(row.value.somethingNew, 42);
  });
});

// =============================================================================
// Plugins you added yourself (owner report, 2026-11-12)
// =============================================================================

/** The row as the Settings screen would see it, with this storage in place. */
const addedRow = (userJson) => {
  let row = null;
  withStorage(fakeStorage(userJson === undefined ? {} : { 'crosstab.plugins.user': userJson }), () => {
    row = listSettings().find((s) => s.id === 'plugins.added');
  });
  return row;
};

test('plugins added from a file or a URL appear on the Settings screen', () => {
  const row = addedRow(JSON.stringify([
    { key: 'https://plugins.example.org/thing.js', kind: 'url', url: 'https://plugins.example.org/thing.js' },
    { key: 'local:1', kind: 'file', name: 'my-plugin.js' },
  ]));
  assert.ok(row, 'the whole report was that this row did not exist');
  assert.equal(row.group, 'Plugins');
  assert.ok(row.label && row.hint, 'a screen needs something to print');
});

test('the summary names the HOST a plugin is fetched from', () => {
  // The point of showing this at all: a URL plugin is third-party code re-fetched and
  // executed on every launch. The host is the trust decision; a count alone would say
  // nothing about whose code this is.
  const row = addedRow(JSON.stringify([
    { key: 'u1', kind: 'url', url: 'https://plugins.example.org/a.js' },
    { key: 'u2', kind: 'url', url: 'https://plugins.example.org/b.js' },
    { key: 'local:1', kind: 'file', name: 'mine.js' },
    { key: 'authored:1', kind: 'authored', name: 'scratch' },
  ]));
  const s = row.summary(row.value);
  assert.match(s, /2 from the web \(plugins\.example\.org\)/, 'counted and named, once per host');
  assert.match(s, /1 from a file/);
  assert.match(s, /1 created here/);
  assert.ok(s.indexOf('from the web') < s.indexOf('from a file'), 'the web ones read first');
});

test('a package counts as a file, because a copy lives here either way', () => {
  const row = addedRow(JSON.stringify([
    { key: 'p1', kind: 'package', name: 'bundle.ctplugin' },
    { key: 'local:1', kind: 'file', name: 'single.js' },
  ]));
  assert.match(row.summary(row.value), /2 from a file/);
});

test('many hosts are summarised rather than listed to the horizon', () => {
  const row = addedRow(JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ key: `u${i}`, kind: 'url', url: `https://h${i}.example/a.js` })),
  ));
  const s = row.summary(row.value);
  assert.match(s, /6 from the web/);
  assert.match(s, /\+3 more/, 'three named, the rest counted');
});

test('nothing added says so, rather than reading as broken', () => {
  assert.equal(addedRow(undefined).summary([]), 'None — only the built-ins');
});

test('a URL that no longer parses still counts', () => {
  // An entry is still loaded-and-run whether or not its URL survives `new URL`. Dropping
  // it from the count would under-report exactly the kind this row exists to surface.
  const row = addedRow(JSON.stringify([{ key: 'u1', kind: 'url', url: 'not a url' }]));
  assert.match(row.summary(row.value), /1 from the web/);
});

test('a corrupt index degrades to "none" instead of breaking the screen', () => {
  for (const junk of ['not json', '{}', 'null', '42']) {
    const row = addedRow(junk);
    assert.deepEqual(row.value, [], `${junk} -> fallback`);
    assert.equal(row.summary(row.value), 'None — only the built-ins');
  }
});

test('junk entries inside a good index are ignored', () => {
  const row = addedRow(JSON.stringify([null, 'nope', { noKey: true }, { key: 'u1', kind: 'url', url: 'https://x.test/a.js' }]));
  assert.equal(row.value.length, 1, 'only the entry with a usable key');
});

test('the row is routed and offers no Clear', () => {
  // Routed because the manager is the real editor — it lists origins and has Remove. And
  // un-clearable on purpose: wiping this index would orphan every OPFS source and package
  // it points at, which is data loss dressed up as a preference reset.
  const row = addedRow(JSON.stringify([{ key: 'u1', kind: 'url', url: 'https://x.test/a.js' }]));
  assert.equal(controlFor(row), 'route');
  assert.ok(row.editedAt && /Plugins/.test(row.editedAt), 'and it says where the real control is');
});

test('the plugin manager is still the only writer of its index', () => {
  // `set()` here reports that a value was ACCEPTED, not that it reached the disk;
  // plugin-manager's writeJSON reports a real quota failure. That difference cost an
  // authored plugin once — it loaded, worked, and was gone on reload.
  const src = readFileSync('core/plugin-manager.js', 'utf8');
  assert.match(src, /writeJSON\(LS_USER/, 'the manager keeps its own reporting write path');
  // Bound the slice BEFORE reading it. `indexOf` answers -1 for a declaration that is not
  // there, which silently yields an empty string that passes any doesNotMatch — the exact
  // vacuous-assertion shape that let "crosstab.plugins.user is not a setting" stand for
  // months. Caught here by running this file against the pre-change code.
  const from = src.indexOf('const addedPluginsSetting');
  const to = src.indexOf('const CATALOG_VERSION');
  assert.ok(from > 0 && to > from, 'the declaration must be findable, or this proves nothing');
  const decl = src.slice(from, to);
  assert.doesNotMatch(decl.replace(/\/\*[\s\S]*?\*\//g, ''), /\.set\(/,
    'the declaration must not become a second writer of this key');
});

// =============================================================================
// Network access granted to plugins (found by audit, 2026-11-12)
// =============================================================================

/** The web-grants row as the Settings screen would see it. */
const grantRow = (json) => {
  let row = null;
  withStorage(fakeStorage(json === undefined ? {} : { 'crosstab.plugins.web': json }), () => {
    row = listSettings().find((s) => s.id === 'plugins.webAccess');
  });
  return row;
};

test('standing network grants are visible somewhere other than a one-letter badge', () => {
  // A grant is a permission given once in a modal about a thing that then happens
  // silently forever. Before this the only trace was a `web` badge on a row inside the
  // plugin manager.
  const row = grantRow(JSON.stringify({ 'builtin-x': ['https://api.example.com'] }));
  assert.ok(row, 'the row must exist at all');
  assert.equal(row.group, 'Plugins');
  assert.equal(row.key, 'crosstab.plugins.web', 'and over the key the manager already used');
});

test('the summary names the hosts, not just a count', () => {
  const row = grantRow(JSON.stringify({
    'p.one': ['https://api.example.com'],
    'p.two': ['https://cdn.other.net'],
  }));
  const s = row.summary(row.value);
  assert.match(s, /2 plugins/);
  assert.match(s, /api\.example\.com/);
  assert.match(s, /cdn\.other\.net/);
});

test('a plain-http grant keeps its scheme, because that is the notable one', () => {
  // `https://` on every entry is noise that makes the rows harder to scan; an http grant
  // is the one a person should notice.
  const row = grantRow(JSON.stringify({ a: ['http://legacy.local'], b: ['https://api.example.com'] }));
  const s = row.summary(row.value);
  assert.match(s, /http:\/\/legacy\.local/, 'cleartext stays visible');
  assert.doesNotMatch(s, /https:\/\//, 'and the ordinary case is not repeated at you');
});

test('one plugin is a plugin, not 1 plugins', () => {
  assert.match(grantRow(JSON.stringify({ a: ['https://x.test'] })).summary({ a: ['https://x.test'] }), /1 plugin ·/);
});

test('many hosts are summarised', () => {
  const v = { a: ['https://h1.test', 'https://h2.test'], b: ['https://h3.test', 'https://h4.test', 'https://h5.test'] };
  assert.match(grantRow(JSON.stringify(v)).summary(v), /\+2 more/);
});

test('the same host granted to two plugins is named once', () => {
  const v = { a: ['https://same.test'], b: ['https://same.test'] };
  const s = grantRow(JSON.stringify(v)).summary(v);
  assert.equal(s.match(/same\.test/g).length, 1, 'hosts are deduplicated for reading');
  assert.match(s, /2 plugins/, 'but both plugins still count');
});

test('nothing granted says so', () => {
  assert.equal(grantRow(undefined).summary({}), 'None granted');
  assert.equal(grantRow('{}').summary({}), 'None granted');
});

test('the dropped legacy format reads as nothing granted, never as a grant', () => {
  // v1 was a flat `[id, …]` array meaning "this plugin may reach ANY host". The manager
  // intentionally drops it rather than migrating (#89), so the screen must agree — showing
  // it as a live grant would describe a permission that no longer exists.
  const row = grantRow(JSON.stringify(['old-plugin-id', 'another']));
  assert.deepEqual(row.value, {});
  assert.equal(row.summary(row.value), 'None granted');
});

test('a corrupt or partial grants object degrades rather than throwing', () => {
  for (const junk of ['not json', 'null', '42', '"text"']) {
    const row = grantRow(junk);
    assert.deepEqual(row.value, {}, junk);
  }
  const mixed = grantRow(JSON.stringify({ good: ['https://x.test'], bad: 'not-an-array', empty: [] }));
  assert.deepEqual(Object.keys(mixed.value), ['good'], 'only usable entries survive');
});

test('the grants row is routed, and offers no Clear — on purpose', () => {
  // The grants live in a Map on the manager for the life of the page; the stored object is
  // persistence, not the source of truth. A Clear here would delete the key behind the
  // manager's back and leave every grant live in memory, so the "revoked" plugin would
  // keep fetching with no prompt until a reload. A revoke that does not revoke is worse
  // than no button.
  const row = grantRow(JSON.stringify({ a: ['https://x.test'] }));
  assert.equal(controlFor(row), 'route');
  assert.ok(/Plugins/.test(row.editedAt), 'and it points at the manager, where revoke lives');
});

test('the manager is still the only writer of the grants key', () => {
  const src = readFileSync('core/plugin-manager.js', 'utf8');
  assert.match(src, /writeJSON\(LS_WEB/, 'the manager keeps #persistWeb');
  const from = src.indexOf('const webGrantsSetting');
  const to = src.indexOf('/** Bump when the catalog');
  assert.ok(from > 0 && to > from, 'the declaration must be findable, or this proves nothing');
  const decl = src.slice(from, to);
  assert.doesNotMatch(decl.replace(/\/\*[\s\S]*?\*\//g, ''), /\.set\(|\.clear\(/,
    'the declaration must not become a second writer, or an in-memory grant outlives it');
});

test('revoking in the manager is what the row sends you to', () => {
  // The row would be theatre if the destination had no control. `revokeWeb` is wired to a
  // per-plugin action in the picker.
  const picker = readFileSync('core/plugin-picker.js', 'utf8');
  assert.match(picker, /revokeWeb\(/, 'the manager can actually take a grant back');
  const sync = readFileSync('core/project-sync.js', 'utf8');
  assert.match(sync, /'plugins\.webAccess':\s*\(\)\s*=>\s*this\.onOpenPlugins/, 'and the row opens it');
});

// =============================================================================
// Two exclusions revisited (owner, 2026-11-12)
// =============================================================================

const rowFor = (id, seed = {}) => {
  let row = null;
  withStorage(fakeStorage(seed), () => { row = listSettings().find((s) => s.id === id); });
  return row;
};

test('the launcher first-run flag is something a person can put back', () => {
  // The case that moved it: an IT technician sets up the shortcut and launches it once to
  // check it works. The flag is now set on a device whose real user has never seen it, and
  // there was no way back.
  const row = rowFor('launcher.seen', { 'crosstab.launcher.seen': '1' });
  assert.ok(row, 'it must be on the screen, not merely in the registry');
  assert.equal(row.key, 'crosstab.launcher.seen');
  assert.equal(row.group, 'Advanced');
  assert.equal(controlFor(row), 'select', 'two real states, chosen directly');
  assert.deepEqual(row.options.map(([v]) => v), ['1', '']);
});

test('choosing "curated set" actually defeats the seeding, not just the label', () => {
  // The reader used to be a bare `getItem`, which is TRUTHY for an empty string — so a
  // stored '' would have read as "seen" and the row would have done nothing at all. The
  // accessor is what makes the two options mean what they say.
  const src = readFileSync('core/launcher.js', 'utf8');
  assert.match(src, /seenSetting\.get\(\) === '1'/, 'the seed reads through the accessor');
  assert.doesNotMatch(src, /localStorage\.getItem\(LS_SEEN\)/, 'and not around it');
  assert.match(src, /seenSetting\.set\('1'\)/, 'markSeen writes through it too');
});

test('both routes to a fresh start land on the same behaviour', () => {
  // The row's second option stores ''; the screen's Default button clears the key. Both
  // must read as "not seen", or one of the two controls is a lie.
  for (const seed of [{}, { 'crosstab.launcher.seen': '' }]) {
    const row = rowFor('launcher.seen', seed);
    assert.notEqual(row.value, '1', JSON.stringify(seed));
  }
  assert.equal(rowFor('launcher.seen', { 'crosstab.launcher.seen': '1' }).value, '1');
});

test('the label describes what the flag does, not what its name suggests', () => {
  // There is no welcome screen to re-show: the launcher IS the onboarding and opens every
  // launch. A row promising to bring one back would describe a feature that does not
  // exist. Its only effect is which set the plugin picker is pre-ticked from.
  const row = rowFor('launcher.seen');
  assert.doesNotMatch(row.label + row.hint, /welcome|getting started/i);
  assert.match(row.label + row.hint, /plugin/i);
});

test('Dropbox is on the screen, and is not called a credential', () => {
  // The exclusion read "Credentials — a screen that enumerates settings must never be the
  // thing that prints a token". The rule is right; the premise was wrong. This key holds a
  // PKCE app key (the sign-in dialog itself says it is not a secret) and a folder path.
  // The tokens are memory-only by design, so there is no token here to print.
  const row = rowFor('storage.dropbox', {
    'crosstab.dropbox.config': JSON.stringify({ appKey: 'abcdefghijklmno', basePath: '/CrossTab/study' }),
  });
  assert.ok(row, 'it must appear at all');
  assert.notEqual(controlFor(row), 'secret',
    'calling it secret would restate the wrong premise in a new place');
  assert.equal(row.group, 'Privacy');
});

test('the Dropbox summary says the folder, never the key', () => {
  const v = { appKey: 'abcdefghijklmno', basePath: '/CrossTab/study' };
  const row = rowFor('storage.dropbox', { 'crosstab.dropbox.config': JSON.stringify(v) });
  const s = row.summary(row.value);
  assert.match(s, /App key saved/);
  assert.match(s, /\/CrossTab\/study/, 'the folder is the part worth reading');
  assert.doesNotMatch(s, /abcdefghijklmno/, 'identifiers are not printed by default');
});

test('an unconfigured or half-configured Dropbox reads honestly', () => {
  assert.equal(rowFor('storage.dropbox').summary({}), 'Not set up');
  const half = rowFor('storage.dropbox', { 'crosstab.dropbox.config': JSON.stringify({ basePath: '/x' }) });
  assert.match(half.summary(half.value), /No app key yet · \/x/);
});

test('the Dropbox row only ever describes fields the module would load', () => {
  // A token written by a future build (or by hand) must not become something this screen
  // displays. The coerce narrows to the same PUBLIC_FIELDS loadConfig does.
  const row = rowFor('storage.dropbox', {
    'crosstab.dropbox.config': JSON.stringify({ appKey: 'k', basePath: '/p', accessToken: 'SECRET-TOKEN' }),
  });
  assert.deepEqual(Object.keys(row.value).sort(), ['appKey', 'basePath']);
  assert.doesNotMatch(JSON.stringify(row.value) + row.summary(row.value), /SECRET-TOKEN/);
});

test('a corrupt Dropbox entry degrades to "not set up"', () => {
  for (const junk of ['not json', 'null', '[]', '42']) {
    const row = rowFor('storage.dropbox', { 'crosstab.dropbox.config': junk });
    assert.deepEqual(row.value, {}, junk);
  }
});

test('the Dropbox row has somewhere to go, and a way to forget', () => {
  // A routed row with no opener can only name a location — which was the whole original
  // complaint. The dialog gained a settings mode so this row has a real destination, and
  // Forget is the action a person actually wants from a connection they are reviewing.
  const row = rowFor('storage.dropbox');
  assert.equal(controlFor(row), 'route');
  const sync = readFileSync('core/project-sync.js', 'utf8');
  assert.match(sync, /'storage\.dropbox':\s*\(\)\s*=>\s*this\.onOpenDropbox/);
  const app = readFileSync('core/app.js', 'utf8');
  assert.match(app, /promptDropbox\(loadDbxConfig\(\),\s*\{\s*settings:\s*true\s*\}\)/);
  assert.match(app, /res\.forget\s*\?\s*\{\}\s*:\s*res/, 'Forget clears through the module writer');
});

test('the settings mode does not sign you in', () => {
  // The two flow modes end in a sign-in, which is why their buttons say so. A "Save"
  // button that silently authenticated would be exactly the surprise this dialog's own
  // hint text exists to prevent.
  const app = readFileSync('core/app.js', 'utf8');
  const dlg = app.slice(app.indexOf('function promptDropbox'), app.indexOf('function promptPassword'));
  assert.ok(dlg.length > 200, 'the dialog must be findable, or this proves nothing');
  assert.match(dlg, /settings \? 'Save'/, 'the primary button is Save, not Sign in');
  assert.match(dlg, /Nothing here signs you in/, 'and it says so');
  assert.match(dlg, /formnovalidate/, 'Forget works with the required app key left empty');
});
