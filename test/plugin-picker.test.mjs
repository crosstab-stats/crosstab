/**
 * @file plugin-picker.test.mjs
 * The rules behind the shared plugin picker — one screen, two hosts (owner, 2026-10-01).
 *
 * Extracted from the render code for the reason #173 did the same to the project manager:
 * *which* affordances a row offers, and what a search does to the order of the list, are
 * DECISIONS. They rot quietly inside DOM code — an over-generous action list looks exactly
 * like a correct one until someone clicks it, and a capability that exists on one of two
 * surfaces looks like a design until someone asks why.
 *
 * The unification itself is the thing under test here: before this, the launcher's picker and
 * Edit ▸ Plugins were separate renderers of one catalogue, and the drift between them was
 * invisible to every test in the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerSections, rowActions, rowMeta } from '../core/plugin-picker.js';

/** A catalogue row as `PluginManager#list` returns it. */
const row = (over = {}) => ({
  key: 'builtin-frequencies.js',
  id: 'builtin-frequencies',
  name: 'Frequencies',
  category: 'Describe',
  version: '1',
  keywords: [],
  disciplines: [],
  menu: ['Frequencies…'],
  enabled: true,
  activated: true,
  origin: 'built-in',
  removable: false,
  editable: false,
  webAllowed: false,
  apiCompat: 'ok',
  ...over,
});

// --- the row's actions -------------------------------------------------------

test('a built-in offers three actions, and that is what makes two columns fit', () => {
  // The manager's row carried up to six icons in a single-column list. The launcher's layout
  // won the merge, so the common row has to stay narrow — it does, because four of the six
  // are conditional on the plugin, not on the surface.
  assert.deepEqual(rowActions(row()), ['about', 'fork', 'export']);
});

test('the SAME actions on both surfaces — the launcher withheld them by accident, not design', () => {
  // The owner was explicitly unconvinced that authoring belongs only in-session: "an argument
  // I'm not entirely convinced of yet". The signature is the guarantee: (plugin, {hasCreator}) — one required parameter, and no
  // mode among them, so there is no per-surface filtering left to drift.
  assert.equal(rowActions.length, 1);
  const authored = row({ origin: 'authored', editable: true, removable: true });
  assert.deepEqual(rowActions(authored), ['about', 'fork', 'export', 'edit', 'remove']);
});

test('"what does this add?" is on every row, always, and first', () => {
  // The only path to that answer on a touch screen: the row tooltip needs a pointer that can
  // rest somewhere (#177, and the owner on a phone, 2026-09-26). A row that offers nothing
  // else still offers this.
  for (const p of [row(), row({ origin: 'url' }), row({ editable: true, removable: true })]) {
    assert.equal(rowActions(p, { hasCreator: false })[0], 'about');
  }
});

test('no creator attached means no Copy and no Edit — but everything else stands', () => {
  const authored = row({ origin: 'authored', editable: true, removable: true });
  assert.deepEqual(rowActions(authored, { hasCreator: false }), ['about', 'export', 'remove']);
});

test('the network-grant revoke appears only for a plugin that actually has the grant', () => {
  assert.ok(!rowActions(row({ webAllowed: true, id: null })).includes('web'));
  assert.ok(rowActions(row({ webAllowed: true })).includes('web'));
  assert.ok(!rowActions(row()).includes('web'));
});

// --- the row's note ----------------------------------------------------------

test('a healthy built-in says nothing — "built-in" on fifty rows was noise', () => {
  assert.equal(rowMeta(row(), 'live'), null);
  assert.equal(rowMeta(row(), 'select'), null);
});

test('provenance is stated whenever it is NOT ours, because then it is a trust question', () => {
  for (const origin of ['url', 'file', 'authored', 'package']) {
    assert.equal(rowMeta(row({ origin }), 'select'), origin);
  }
});

test('live mode shows the two states that contradict the checkbox', () => {
  // "On but never loaded" is the one a user must see: the box is ticked and the analyses are
  // missing. In select mode neither state exists yet — nothing has been asked to load.
  assert.equal(rowMeta(row({ enabled: true, activated: false }), 'live'), 'failed');
  assert.equal(rowMeta(row({ enabled: false }), 'live'), 'disabled');
  assert.equal(rowMeta(row({ enabled: false, activated: false }), 'select'), null);
});

test('a failed plugin reports the failure, not its origin', () => {
  // Both are true; only one is actionable.
  assert.equal(rowMeta(row({ origin: 'url', activated: false }), 'live'), 'failed');
});

// --- sections ----------------------------------------------------------------

const LIST = [
  row({ key: 'a', id: 'a', name: 'Assumptions', category: 'Test', menu: ["Levene's test…", 'Shapiro–Wilk…'], disciplines: ['Psychology'] }),
  row({ key: 'b', id: 'b', name: 'Compare', category: 'Test', keywords: ['levene'], menu: ['t-test…'], disciplines: ['Psychology'] }),
  row({ key: 'c', id: 'c', name: 'Spatial', category: 'Maps', menu: ['Map…'], disciplines: ['Geography'] }),
];

test('with no query and no discipline it is one list', () => {
  const { sections } = pickerSections(LIST);
  assert.deepEqual(sections.map((s) => s.title), ['All plugins']);
  assert.equal(sections[0].items.length, 3);
});

test('a query that names an ANALYSIS leads with what provides it', () => {
  // Searching "levene" used to reach only the plugin with the word in its keywords, while the
  // one with the actual test was invisible (#183). The launcher's picker never had this
  // behaviour at all — it matched substrings of names — so the merge inherits the better half.
  const { sections, hits } = pickerSections(LIST, { query: 'levene' });
  assert.deepEqual(sections.map((s) => s.title), ['Adds what you searched for', 'Other matches']);
  assert.deepEqual(sections[0].items.map((p) => p.name), ['Assumptions']);
  assert.deepEqual(sections[1].items.map((p) => p.name), ['Compare']);
  assert.deepEqual(hits.get('a'), ["Levene's test…"]);
});

test('a discipline pins its field to the top and still lists everything else', () => {
  const { sections } = pickerSections(LIST, { discipline: 'Psychology' });
  assert.deepEqual(sections.map((s) => s.title), ['Recommended for Psychology', 'All other plugins']);
  assert.deepEqual(sections[0].items.map((p) => p.name), ['Assumptions', 'Compare']);
  assert.deepEqual(sections[1].items.map((p) => p.name), ['Spatial']);
});

test('a discipline nothing matches says "All plugins", not "All OTHER plugins"', () => {
  // The word "other" promises a section above it. There isn't one.
  const { sections } = pickerSections(LIST, { discipline: 'Dentistry' });
  assert.deepEqual(sections.map((s) => s.title), ['All plugins']);
});

test('a query outranks the discipline dropdown', () => {
  // The user typed a thing; the dropdown is a standing preference.
  const { sections } = pickerSections(LIST, { query: 'levene', discipline: 'Geography' });
  assert.deepEqual(sections.map((s) => s.title), ['Adds what you searched for', 'Other matches']);
});

test('a query every plugin answers is not split into "providers" and "the rest"', () => {
  const all = pickerSections(LIST, { query: 'e' });
  assert.equal(all.sections.length, 1, 'a 1-of-1 split would be two headings over one group');
});

test('nothing matching is no sections at all, so the host can say so once', () => {
  const { sections } = pickerSections(LIST, { query: 'zzzz' });
  assert.deepEqual(sections, []);
});
