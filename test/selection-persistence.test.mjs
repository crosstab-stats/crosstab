/**
 * @file selection-persistence.test.mjs
 * The data grid's variable selection survives a reload — and is NOT an op.
 *
 * ## Why this is the opposite call from the picker's
 *
 * Picker selections were ruled *"purely ephemeral to that run"*, because they are one
 * run's inputs and must not change project state. The grid's are the project's own
 * working state; they are VISIBLE, so persisting them cannot violate the
 * pre-select-never-apply-invisibly rule; and they are the pre-fill for the variable
 * picker, Compute and Recode — so losing them makes the FIRST analysis after reopening
 * cost more clicks than the second.
 *
 * ## Where it lives, and where it must not
 *
 * In `datasetMeta`, the manifest's existing "per-dataset non-log state" slot — plumbed
 * end to end and standing empty since `libraryLink` went with the building-block library.
 * NOT in the log: clicking a column header is not a change to the data, and an op would
 * put a high-frequency, zero-audit entry in History and in the exported do-file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SYNC = await readFile(new URL('../core/project-sync.js', import.meta.url), 'utf8');
const MGR = await readFile(new URL('../core/dataset-manager.js', import.meta.url), 'utf8');

/** The smallest thing that answers `getSelectedVariables`. */
const fakeStore = (selected) => ({
  getSelectedVariables: () => selected,
  applied: null,
  setSelectedVariables(names) { this.applied = names; },
});

/** `DatasetManager#datasetMeta` without a DatasetManager — the shape under test is the
 * object it builds, and standing one up needs DuckDB. */
function buildMeta(entries) {
  const out = {};
  for (const [id, ds] of entries) {
    const selected = ds.getSelectedVariables?.() ?? [];
    if (selected.length) out[String(id)] = { selected };
  }
  return out;
}

// =============================================================================
// What a save carries
// =============================================================================

test('each dataset contributes its own selection, keyed by id', () => {
  const meta = buildMeta([[1, fakeStore(['age', 'sex'])], [2, fakeStore(['income'])]]);
  assert.deepEqual(meta, { 1: { selected: ['age', 'sex'] }, 2: { selected: ['income'] } });
});

test('a dataset with nothing selected contributes NO key', () => {
  // Absent and "deliberately nothing" read the same here, and writing `{selected: []}`
  // for every dataset on every save would grow the manifest for no information.
  const meta = buildMeta([[1, fakeStore([])], [2, fakeStore(['a'])]]);
  assert.deepEqual(Object.keys(meta), ['2']);
});

test('the manager really builds it, and the snapshot really sends it', () => {
  // The slot was plumbed end to end and carried `{}` for weeks after its only tenant was
  // removed; a test that only checked the shape would not notice it still did.
  assert.match(MGR, /^  datasetMeta\(\) \{/m);
  assert.match(SYNC, /const datasetMeta = this\.#datasets\.datasetMeta\?\.\(\) \?\? \{\};/);
  assert.doesNotMatch(SYNC, /const datasetMeta = \{\};/, 'the empty placeholder is gone');
});

// =============================================================================
// What a load restores
// =============================================================================

test('restoring goes through setSelectedVariables, which filters unknown names', () => {
  // A variable renamed or dropped since the save falls out there, which is the right
  // outcome and needs no special case here. Assigning the array directly would keep a
  // name the dataset no longer has.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /setSelectedVariables\?\.\(names\)/);
  assert.doesNotMatch(restore, /#selected\s*=/);
});

test('restoring happens AFTER the datasets are reconstructed', () => {
  // `setSelectedVariables` drops names it does not recognise, so restoring before the
  // columns are known would silently discard the whole selection.
  const rebuild = MGR.indexOf('await ds.rawRestore(');
  const restore = MGR.indexOf('for (const map of [this.#datasets, this.#binned])');
  assert.ok(rebuild > 0 && restore > rebuild, 'selection restore must follow rawRestore');
});

test('a binned dataset keeps its selection too', () => {
  // Deleted is a status in the log, not a different kind of storage, and a restore after
  // a reload is meant to be free — including what was selected in it.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /this\.#binned/);
});

test('the lookup bridges the key types, which a shape test cannot see', () => {
  // The Maps are keyed by the NUMERIC dataset id; JSON object keys are always strings.
  // Iterating the meta and calling `#datasets.get(objectKey)` therefore never matched,
  // and nothing in Node noticed — the selection simply came back empty in the browser.
  // Driving from the datasets and indexing the meta with `String(id)` is what fixes it.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /datasetMeta\?\.\[String\(id\)\]/);
  assert.doesNotMatch(restore, /#datasets\.get\(id\)/, 'the Map must not be indexed by a JSON key');
});

test('a meta entry with no usable selection is skipped', () => {
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /Array\.isArray\(names\)/, 'a non-array is not a selection');
  assert.match(restore, /names\.length/, 'nor is an empty one worth applying');
});

// =============================================================================
// It is saved, but it is not an op
// =============================================================================

test('a selection change marks the project dirty', () => {
  // Without this it would persist only by accident — whenever some other edit happened
  // to trigger a save afterwards, which is the most confusing possible version of
  // "sometimes it remembers".
  assert.match(SYNC, /SELECTION_CHANGED, \(\) => this\.#onChange\(null\)/);
});

test('…and marks NO dataset dirty, so no Parquet is rewritten', () => {
  // At this frequency it matters: a save that re-wrote every source because someone
  // clicked a column header would be a real cost. `null` is what says "manifest only".
  const line = SYNC.slice(SYNC.indexOf('SELECTION_CHANGED, () =>'), SYNC.indexOf('SELECTION_CHANGED, () =>') + 80);
  assert.match(line, /#onChange\(null\)/);
});

test('the selection is not written to the log', async () => {
  // Clicking a column header is not a change to the data. An op would put a
  // high-frequency, zero-audit entry in the History panel and the exported do-file.
  const store = await readFile(new URL('../core/data-store.js', import.meta.url), 'utf8');
  const setter = store.slice(store.indexOf('setSelectedVariables(names)'), store.indexOf('setSelectedVariables(names)') + 260);
  assert.doesNotMatch(setter, /#append\(|#log\.append/);
  assert.match(setter, /SELECTION_CHANGED/, 'it announces itself, which is how the save is triggered');
});

test('restoring on load does not dirty the project', () => {
  // Otherwise merely OPENING a project would bump its savedAt — conflating "looked at"
  // with "saved", which is the exact distinction `markOpened` exists to keep.
  assert.match(SYNC, /#onChange\(summary\) \{\s*\n\s*if \(this\.#loading\) return;/);
  const open = SYNC.slice(SYNC.indexOf('async #loadProject('), SYNC.indexOf('async #loadProject(') + 3000);
  const guard = open.indexOf('this.#loading = true');
  const load = open.indexOf('loadBundle(bundle)');
  assert.ok(guard >= 0 && load > guard, 'loadBundle must run inside the loading guard');
});
