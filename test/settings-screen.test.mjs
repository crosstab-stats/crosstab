/**
 * @file settings-screen.test.mjs
 * The Settings screen's data model, and the two things it must refuse to do.
 *
 * The screen itself is a dialog and is the owner's to look at. What is testable — and
 * what matters — is everything upstream of the DOM: which settings appear, how each is
 * presented, and whether a write by id goes through the same rules the declaring module's
 * own setter does. Those are the parts that would be wrong silently.
 *
 * Two refusals are asserted hardest, because both were decisions rather than oversights:
 *
 *  - **A setting with no `label` does not appear.** Not a filter invented for this screen:
 *    `screen.autoNoteSeen` has carried the comment *"Not offered to a Settings screen (no
 *    `label`)"* since before the screen existed. A label is what marks a declaration as a
 *    preference rather than a lifecycle flag.
 *  - **A `secret` is never printed.** `listSettings` already withholds the value and
 *    reports only `isSet`; a screen that rendered it anyway would have made that care
 *    pointless. The TURN entry carries a credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  defineSetting, listSettings, setSetting, clearSetting, _resetRegistry,
} from '../core/settings.js';
import {
  settingsGroups, controlFor, describeValue, linesToArray, arrayToLines, GROUP_ORDER,
} from '../core/settings-screen.js';

/** A localStorage stand-in — `node --test` has none, and settings.js reads it at call time. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
  return map;
}

test.beforeEach(() => {
  _resetRegistry();
  fakeStorage();
});

// ---------------------------------------------------------------------------------------
// Which settings appear
// ---------------------------------------------------------------------------------------

test('a setting with no label is not shown', () => {
  defineSetting({ id: 'a.shown', key: 'k1', label: 'Shown', group: 'Appearance' });
  defineSetting({ id: 'a.flag', key: 'k2', values: ['1'] }); // the autoNoteSeen shape
  const ids = settingsGroups().flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(ids, ['a.shown']);
});

test('groups come out in reading order, and an unknown group is never dropped', () => {
  defineSetting({ id: 'z.adv', key: 'k1', label: 'A', group: 'Advanced' });
  defineSetting({ id: 'a.app', key: 'k2', label: 'B', group: 'Appearance' });
  defineSetting({ id: 'm.new', key: 'k3', label: 'C', group: 'Nebulous' });
  defineSetting({ id: 'n.none', key: 'k4', label: 'D' });
  const groups = settingsGroups().map((g) => g.group);
  assert.deepEqual(groups, ['Appearance', 'Advanced', 'Nebulous', 'Other']);
  // Appearance before Advanced is the declared order, not alphabetical or declaration
  // order — both of which would have put Advanced first here.
  assert.ok(GROUP_ORDER.indexOf('Appearance') < GROUP_ORDER.indexOf('Advanced'));
});

// ---------------------------------------------------------------------------------------
// How each is presented
// ---------------------------------------------------------------------------------------

test('the control follows from the declaration, most restrictive answer first', () => {
  assert.equal(controlFor({ options: [[1, 'one']] }), 'select');
  assert.equal(controlFor({ json: true, value: ['a'] }), 'lines');
  assert.equal(controlFor({}), 'text');
  assert.equal(controlFor({ secret: true }), 'secret');
  assert.equal(controlFor({ editedAt: 'elsewhere' }), 'route');
  // Order matters: a routed setting that also has options is still routed, and a secret
  // must never fall through to a text box.
  assert.equal(controlFor({ editedAt: 'x', options: [[1, 'one']], secret: true }), 'route');
  assert.equal(controlFor({ secret: true, options: [[1, 'one']] }), 'secret');
  // A shaped OBJECT is not line-editable: the encryption policy has its own dialog, and a
  // generic JSON box would be a second place its shape was defined.
  assert.equal(controlFor({ json: true, value: { on: true } }), 'text');
});

test('a secret reports only whether it is configured', () => {
  defineSetting({ id: 's.turn', key: 'turn', json: true, secret: true, label: 'TURN', group: 'Collaboration' });
  const unset = listSettings().find((s) => s.id === 's.turn');
  assert.equal(describeValue(unset), 'Not configured');
  assert.equal(unset.value, undefined, 'listSettings withholds it');

  fakeStorage({ turn: JSON.stringify([{ urls: 'turn:x', username: 'u', credential: 'SECRET' }]) });
  const set = listSettings().find((s) => s.id === 's.turn');
  assert.equal(describeValue(set), 'Configured');
  assert.equal(set.value, undefined);
  assert.ok(!JSON.stringify(set).includes('SECRET'), 'the credential is nowhere in the row');
});

test('a routed row shows the option LABEL, not the stored token', () => {
  // "Small screen" is what the control that owns the setting says. A screen reporting
  // `small` beside it would read as a different setting.
  const spec = { options: [['small', 'Small screen'], ['full', 'Full layout']], value: 'small' };
  assert.equal(describeValue(spec), 'Small screen');
  assert.equal(describeValue({ ...spec, value: null }), 'Default');
  assert.equal(describeValue({ value: ['a', 'b'] }), '2 entries');
  assert.equal(describeValue({ value: ['a'] }), '1 entry');
  assert.equal(describeValue({ value: { on: true } }), 'Configured');
  assert.equal(describeValue({ value: '' }), 'Default');
});

test('the line editor round-trips, and blank lines are not entries', () => {
  assert.deepEqual(linesToArray('a\n\n  b  \nc'), ['a', 'b', 'c']);
  assert.deepEqual(linesToArray(''), []);
  assert.deepEqual(linesToArray(null), []);
  assert.equal(arrayToLines(['a', 'b']), 'a\nb');
  assert.equal(arrayToLines(null), '');
  assert.deepEqual(linesToArray(arrayToLines(['x', 'y'])), ['x', 'y']);
});

// ---------------------------------------------------------------------------------------
// Writing by id — the thing the registry could not do before
// ---------------------------------------------------------------------------------------

test('setSetting goes through the declaring module rules, not around them', () => {
  const api = defineSetting({
    id: 'w.mode', key: 'mode', values: ['small', 'full'], fallback: null, label: 'Mode',
  });
  assert.equal(setSetting('w.mode', 'full'), true);
  assert.equal(api.get(), 'full');
  // An unaccepted value is refused and changes nothing — the screen needs the false to
  // avoid leaving a control showing something that was never stored.
  assert.equal(setSetting('w.mode', 'enormous'), false);
  assert.equal(api.get(), 'full');
  assert.equal(setSetting('nonexistent.id', 'x'), false);
});

test('a coerce that adjusts a value still counts as accepted', () => {
  // The bug in the first version of setSetting: it inferred acceptance by comparing
  // before/after, so writing a coerced value over an identical one looked like a refusal.
  const api = defineSetting({
    id: 'w.urls', key: 'urls', json: true, label: 'URLs',
    coerce: (v) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : undefined),
  });
  assert.equal(setSetting('w.urls', ['HTTP://A']), true);
  assert.deepEqual(api.get(), ['http://a']);
  assert.equal(setSetting('w.urls', ['HTTP://A']), true, 'idempotent is still accepted');
  assert.equal(setSetting('w.urls', 'not an array'), false);
});

test('clearSetting restores the stored ABSENCE, which no value can express', () => {
  // `screen.mode` unset means "let the viewport decide". Writing a default instead would
  // read as a choice and outrank the viewport.
  const api = defineSetting({ id: 'w.m', key: 'm', values: ['small', 'full'], fallback: null, label: 'M' });
  setSetting('w.m', 'small');
  assert.equal(api.get(), 'small');
  assert.equal(clearSetting('w.m'), true);
  assert.equal(api.get(), null);
  assert.equal(listSettings().find((s) => s.id === 'w.m').isSet, false);
  assert.equal(clearSetting('nope'), false);
});

test('apply is called with what was STORED, and only on a successful write', () => {
  const seen = [];
  defineSetting({
    id: 'w.ap', key: 'ap', json: true, label: 'Ap',
    coerce: (v) => (typeof v === 'string' ? v.trim() : undefined),
    apply: (v) => seen.push(v),
  });
  setSetting('w.ap', '  padded  ');
  assert.deepEqual(seen, ['padded'], 'the coerced value, not the input');
  setSetting('w.ap', 42);
  assert.deepEqual(seen, ['padded'], 'a refused write applies nothing');
  clearSetting('w.ap');
  assert.deepEqual(seen, ['padded', null], 'clearing applies the fallback that is now in force');
});

test('the real settings declare the apply/route split they need', async () => {
  // Against the actual modules: a setting that cannot take effect on a write must be
  // ROUTED, or the screen offers a control that silently does nothing. The variable-list
  // settings are read into instance state by data-views.js, which is exactly that case.
  _resetRegistry();
  fakeStorage();
  for (const m of ['../core/at-rest.js', '../core/debug.js', '../core/live-sync.js',
    '../core/screen-mode.js', '../core/var-order.js']) {
    await import(m);
  }
  const byId = new Map(listSettings().map((s) => [s.id, s]));

  // The variable-list pair were ROUTED until #210, on the reasoning that `data-views.js`
  // caches them in instance state so a write from the screen would not show. The owner
  // pointed out that a row showing a value it cannot change is a dead row — right, and the
  // answer was to make the change ARRIVE rather than keep the control away from it. They
  // are editable now, and what makes that safe is the `apply` hook plus subscribers.
  for (const id of ['varlist.order', 'varlist.display']) {
    assert.equal(byId.get(id).editedAt, undefined, `${id} is no longer routed`);
    assert.equal(typeof byId.get(id).apply, 'function', `${id} tells the surfaces`);
  }
  // Still routed, and rightly: the encryption policy has a whole dialog of its own.
  assert.equal(byId.get('privacy.encryption').editedAt, 'File ▸ Encryption settings…');
  assert.equal(typeof byId.get('screen.mode').apply, 'function', 'the layout must change');
  assert.equal(typeof byId.get('debug.logging').apply, 'function', 'the gate is cached');
  // And the two that had no UI at all before this screen are editable in it.
  assert.equal(controlFor(byId.get('collab.relays')), 'lines');
  assert.equal(controlFor(byId.get('collab.turn')), 'secret');
  // The lifecycle flag stays hidden.
  assert.ok(!settingsGroups().flatMap((g) => g.items).some((s) => s.id === 'screen.autoNoteSeen'));
});

test('a write from anywhere reaches the surfaces that cache the value', async () => {
  // The whole reason these two could become editable (#210). `data-views.js` reads both
  // into instance state at construction, so without a notification a change from the
  // Settings screen would leave the grid showing the old order — which is exactly what
  // made them read-only in the first place.
  _resetRegistry();
  fakeStorage();
  const varOrder = await import('../core/var-order.js?fresh=210');
  let fired = 0;
  const off = varOrder.onVarViewChange(() => { fired += 1; });

  // A refused value notifies nobody: there is nothing to re-read.
  assert.equal(setSetting('varlist.order', 'not-an-order'), false);
  assert.equal(fired, 0);

  assert.equal(setSetting('varlist.order', 'name-desc'), true);
  assert.equal(fired, 1);
  assert.equal(setSetting('varlist.display', 'both'), true);
  assert.equal(fired, 2);
  // Clearing is a change too — back to the default order is still a new order.
  clearSetting('varlist.order');
  assert.equal(fired, 3);

  off();
  setSetting('varlist.display', 'name');
  assert.equal(fired, 3, 'unsubscribing actually unsubscribes');
});

test('the views subscribe, and correct their own controls too', () => {
  // A list that re-sorted while its dropdown still read the old choice would be worse
  // than either problem alone.
  const views = readFileSync('core/data-views.js', 'utf8');
  assert.equal((views.match(/onVarViewChange\(/g) || []).length, 2,
    'both DataView and VariableView subscribe');
  assert.equal((views.match(/#syncVarView\(\) \{/g) || []).length, 2, 'and each re-reads');
  assert.match(views, /this\.orderSelect\.value = order/);
  assert.match(views, /this\.displaySelect\.value = display/);
});
