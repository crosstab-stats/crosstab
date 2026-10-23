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
import { readFileSync } from 'node:fs';
import { mergeDatasetMeta } from '../core/collab-sync.js';
import { decideSync } from '../core/folder-sync.js';
import { HLC, hlcEncode } from '../core/hlc.js';
import { ProjectLog } from '../core/project-log.js';

const SYNC = await readFile(new URL('../core/project-sync.js', import.meta.url), 'utf8');
const MGR = await readFile(new URL('../core/dataset-manager.js', import.meta.url), 'utf8');

/** A fixed wall time, so no test depends on the real clock. */
const BASE = 1_700_000_000_000;

/** Two stamps from one clock: A then B, so B is unambiguously later. */
const CLOCK = new HLC({ now: () => BASE });
const STAMP_A = hlcEncode(CLOCK.tick());
const STAMP_B = hlcEncode(CLOCK.tick());

/** A manifest whose only interesting field is `datasetMeta`. */
const withMeta = (datasetMeta, savedAt) => ({
  name: 'Thesis', savedAt, activeId: 1, activePlugins: null, output: null,
  collabId: 'c1', collabSecret: 's1', log: [], datasetMeta,
});

/** The smallest thing that answers `getSelectedVariables`. */
const fakeStore = (selected, at = null) => ({
  getSelectedVariables: () => selected,
  selectedAt: at,
  applied: null,
  setSelectedVariables(names) { this.applied = names; },
});

/** `DatasetManager#datasetMeta` without a DatasetManager — the shape under test is the
 * object it builds, and standing one up needs DuckDB. */
function buildMeta(entries) {
  const out = {};
  for (const [id, ds] of entries) {
    const selected = ds.getSelectedVariables?.() ?? [];
    if (selected.length) out[String(id)] = { selected, ...(ds.selectedAt ? { at: ds.selectedAt } : {}) };
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

test('a selection carries WHEN it changed, so two machines can be ordered', () => {
  const meta = buildMeta([[1, fakeStore(['age'], STAMP_A)]]);
  assert.deepEqual(meta, { 1: { selected: ['age'], at: STAMP_A } });
  // Omitted rather than written as null when there is no stamp: an entry either carries
  // one or does not, and `newerMeta` reads a missing stamp as "predates this rule".
  assert.deepEqual(buildMeta([[1, fakeStore(['age'])]]), { 1: { selected: ['age'] } });
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
  assert.match(restore, /setSelectedVariables\?\.\(names, \{ at:/);
  assert.doesNotMatch(restore, /#selected\s*=/);
  // And the SAVED stamp travels with it — restoring must not claim to be a change made
  // now, or merely opening the project on a second machine would outrank the selection
  // the first one is still editing.
  assert.match(restore, /typeof meta\.at === 'string' \? meta\.at : null/);
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
  const at = store.indexOf('setSelectedVariables(names,');
  const setter = store.slice(at, store.indexOf('get selectedAt()', at));
  assert.doesNotMatch(setter, /#append\(|#log\.append/, 'no op is written');
  assert.match(setter, /SELECTION_CHANGED/, 'it announces itself, which is how the save is triggered');
  // It does touch the log — for a STAMP, not an op. That stamp is what lets two machines
  // order their selections instead of sorting them; see `mergeDatasetMeta`.
  assert.match(setter, /stampNow/);
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

// =============================================================================
// Two machines, one folder
// =============================================================================

test('the later selection wins, whichever side it arrives on', () => {
  const lab = { 1: { selected: ['age', 'sex'], at: STAMP_A } };
  const home = { 1: { selected: ['income'], at: STAMP_B } };
  // Both argument orders, because `decideSync` chooses them by content signature and the
  // saving machine is NOT reliably `mine`.
  assert.deepEqual(mergeDatasetMeta(home, lab), home, 'home saving');
  assert.deepEqual(mergeDatasetMeta(lab, home), home, 'lab saving');
});

test('this is the bug it replaces: the winner no longer depends on how the names sort', () => {
  // The old rule was `{...theirs, ...mine}` - "mine wins per key" - and `mine` is the
  // lexicographically smaller content signature, so `["age","sex"]` beat `["income"]`
  // no matter which was newer. Worse, the merge result is written back and reloaded, so
  // the loser could never win: every save put the old selection back.
  const older = { 1: { selected: ['aaa'], at: STAMP_A } };
  const newer = { 1: { selected: ['zzz'], at: STAMP_B } };
  assert.deepEqual(mergeDatasetMeta(older, newer)[1].selected, ['zzz'], 'newest wins going up');
  const olderLate = { 1: { selected: ['zzz'], at: STAMP_A } };
  const newerEarly = { 1: { selected: ['aaa'], at: STAMP_B } };
  assert.deepEqual(mergeDatasetMeta(olderLate, newerEarly)[1].selected, ['aaa'], 'and going down');
});

test('two peers changing DIFFERENT datasets both survive', () => {
  // Which is why this merges per key rather than picking one whole manifest.
  const a = { 1: { selected: ['age'], at: STAMP_A } };
  const b = { 2: { selected: ['income'], at: STAMP_A } };
  assert.deepEqual(mergeDatasetMeta(a, b), { 1: a[1], 2: b[2] });
});

test('a stamped selection beats an unstamped one', () => {
  // An entry with no stamp was written before this rule existed, so anything explicit
  // outranks it. Not a migration - just the only defensible reading of "unknown when".
  const old = { 1: { selected: ['legacy'] } };
  const stamped = { 1: { selected: ['fresh'], at: STAMP_A } };
  assert.deepEqual(mergeDatasetMeta(old, stamped)[1].selected, ['fresh']);
  assert.deepEqual(mergeDatasetMeta(stamped, old)[1].selected, ['fresh']);
});

test('both peers compute the SAME merge - the property decideSync exists for', () => {
  // Convergence is the whole reason `decideSync` normalises the argument order. The new
  // rule must not cost it: equal stamps and missing stamps both have to resolve the same
  // way from either side, which is why ties fall to the first argument.
  const pairs = [
    [{ 1: { selected: ['a'], at: STAMP_A } }, { 1: { selected: ['b'], at: STAMP_B } }],
    [{ 1: { selected: ['a'], at: STAMP_A } }, { 1: { selected: ['b'], at: STAMP_A } }],
    [{ 1: { selected: ['a'] } }, { 1: { selected: ['b'] } }],
    [{}, { 1: { selected: ['b'], at: STAMP_B } }],
  ];
  for (const [x, y] of pairs) {
    const fromX = decideSync(withMeta(x, 2000), withMeta(y, 1000)).manifest.datasetMeta;
    const fromY = decideSync(withMeta(y, 1000), withMeta(x, 2000)).manifest.datasetMeta;
    assert.deepEqual(fromX, fromY, `divergent for ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
  }
});

test('null and missing meta are not crashes', () => {
  assert.deepEqual(mergeDatasetMeta(null, null), {});
  assert.deepEqual(mergeDatasetMeta(undefined, { 1: { selected: ['a'] } }), { 1: { selected: ['a'] } });
  assert.deepEqual(mergeDatasetMeta({ 1: { selected: ['a'] } }, null), { 1: { selected: ['a'] } });
});

test('the real decideSync keeps the change the user just made', () => {
  // The end-to-end version of the bug report: she selects something at home, saves into
  // the OneDrive folder, and the folder already holds the lab's manifest. Measured at
  // 4 of 8 reverting before the fix.
  const cases = [
    [['age', 'sex'], ['income']], [['income'], ['age', 'sex']],
    [['a'], ['b']], [['b'], ['a']],
    [['age', 'sex'], ['age', 'sex', 'income']], [['age', 'sex', 'income'], ['age', 'sex']],
    [['zzz'], ['aaa']], [['aaa'], ['zzz']],
  ];
  for (const [labSel, homeSel] of cases) {
    const lab = withMeta({ 1: { selected: labSel, at: STAMP_A } }, 1000);
    const home = withMeta({ 1: { selected: homeSel, at: STAMP_B } }, 2000);
    const got = decideSync(home, lab).manifest.datasetMeta?.[1]?.selected;
    assert.deepEqual(got, homeSel, `lab=${JSON.stringify(labSel)} home=${JSON.stringify(homeSel)}`);
  }
});

// =============================================================================
// Clock skew — the case the HLC is for
// =============================================================================

test('a loaded stamp advances the clock, so the next local change outranks it', () => {
  // The lab PC runs ten minutes fast, so its stamp is from the future. Restoring it on
  // the home machine must fold it in — otherwise the next click at home is stamped
  // BEHIND it and loses, permanently, since the merge result is written back.
  const fromLab = hlcEncode(new HLC({ now: () => BASE + 600_000 }).tick()); // +10 min

  const home = new ProjectLog({ hlc: new HLC({ now: () => BASE }) });
  home.receiveStamp(fromLab);
  const next = home.stampNow();
  assert.ok(next > fromLab, `${next} must sort after ${fromLab}`);

  // And the merge then keeps her change, which is the whole point.
  assert.deepEqual(
    mergeDatasetMeta({ 1: { selected: ['hers'], at: next } }, { 1: { selected: ['lab'], at: fromLab } })[1].selected,
    ['hers'],
  );
});

test('without folding it in, a fast peer would win forever', () => {
  // The negative control: the same scenario with the stamp NOT received. This is what
  // the code did before `receiveStamp`, and it is why a passing wall-clock-agrees test
  // was not evidence.
  const fromLab = hlcEncode(new HLC({ now: () => BASE + 600_000 }).tick());
  const naive = new ProjectLog({ hlc: new HLC({ now: () => BASE }) });
  const next = naive.stampNow();
  assert.ok(next < fromLab, 'the untouched clock really does stamp behind the fast peer');
});

test('a malformed stamp fails to advance the clock rather than breaking the load', () => {
  const log = new ProjectLog();
  for (const bad of [null, undefined, '', 'not-a-stamp', 42, {}]) {
    assert.doesNotThrow(() => log.receiveStamp(bad), String(bad));
  }
  assert.match(log.stampNow(), /^\d+:\d+$/);
});

test('the restore path is what calls it', () => {
  // The unit above proves the method works; this proves the loaded selection reaches it.
  const store = readFileSync(new URL('../core/data-store.js', import.meta.url), 'utf8');
  const at = store.indexOf('setSelectedVariables(names,');
  const setter = store.slice(at, store.indexOf('get selectedAt()', at));
  assert.match(setter, /if \(at\) this\.#log\?\.receiveStamp\?\.\(at\)/);
});
