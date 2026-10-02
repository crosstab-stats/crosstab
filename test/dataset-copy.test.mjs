/**
 * @file dataset-copy.test.mjs
 * "Copy dataset" — the building-block library's replacement (2026-10-02), to a NEW project or
 * into an EXISTING one (the second half replaces "add building block to a project").
 *
 * The owner's framing is the specification: *"copy the original source plus the relevant log
 * actions to a new project … the cleaned data would still be in the form of 'original source
 * data + actions taken to clean it' which reproducibility likes (and which building blocks
 * lacked)."* So what is under test is **which ops count as "this dataset"** and **what must
 * not come with them** — both decisions, both invisible by looking at the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsTo, copyBundle, copyName, copyTargets, datasetIdTaken, datasetSlice, describeSlice,
  unionById,
} from '../core/dataset-copy.js';

let n = 0;
/** An op with an HLC that sorts in creation order. */
const op = (target, type, payload = {}, over = {}) => {
  n += 1;
  return { id: `op${n}`, hlc: `000000000000${String(n).padStart(4, '0')}|a`, target, owner: 'core', type, payload, ...over };
};
const src = (dsId, label) => op(`ds:${dsId}/data`, 'load', { src: { label, meta: [{ name: 'x' }], parquet: new Uint8Array([1]) } });

/** A project log: two datasets, each with a source and some cleaning, plus other tiers. */
function fixture() {
  return [
    op('coll/ds:1', 'addDataset', { id: 1, name: 'GSS extract' }),
    op('coll/ds:12', 'addDataset', { id: 12, name: 'Decoy' }),
    op('project', 'rename', { name: 'My working project' }),
    src(1, 'gss.sav'),
    op('ds:1/var:age', 'recode', { into: 'ageGroup' }),
    op('ds:1/rows', 'filter', { expr: 'age > 17' }),
    src(12, 'other.csv'),
    op('ds:12/var:q1', 'recode', { into: 'q1r' }),
    op('analysis', 'runAnalysis', { fn: 'builtin-frequencies.run' }),
    op('ws:builtin-caqdas/codebook', 'wsSaveState', { blob: 1 }),
    op('item:builtin-caqdas/segments/s1', 'put', { quote: 'a participant said this' }),
    op('plugin:builtin-spatial', 'activatePlugin', { key: 'x' }),
    op('asset:a1', 'put', { bytes: 1 }),
  ];
}

// --- which ops are "this dataset" --------------------------------------------

test('a dataset is its collection entry plus everything targeting it', () => {
  const slice = datasetSlice(fixture(), 1);
  assert.deepEqual(slice.map((o) => o.target), ['coll/ds:1', 'ds:1/data', 'ds:1/var:age', 'ds:1/rows']);
});

test('ds:1 does NOT swallow ds:12 — the trailing slash is the whole guard', () => {
  // Without it, a prefix match on "ds:1" takes ds:12's ops too, and the copy carries a
  // second dataset's transforms into a project that has no such dataset. Ten datasets in
  // and this is the id that proves it.
  assert.ok(belongsTo({ target: 'ds:1/var:age' }, 1));
  assert.ok(!belongsTo({ target: 'ds:12/var:q1' }, 1));
  assert.ok(belongsTo({ target: 'coll/ds:1' }, 1));
  assert.ok(!belongsTo({ target: 'coll/ds:12' }, 1));
});

test('nothing from any other tier travels', () => {
  // The point of the list: a copy prepared for a student must not smuggle the author's
  // analyses, the project name, or — the one that actually matters — coded passages of
  // real participant data.
  const targets = datasetSlice(fixture(), 1).map((o) => o.target);
  for (const foreign of ['project', 'analysis', 'ws:builtin-caqdas/codebook',
    'item:builtin-caqdas/segments/s1', 'plugin:builtin-spatial', 'asset:a1']) {
    assert.ok(!targets.includes(foreign), `${foreign} must not travel`);
  }
});

test('a malformed or absent target is simply not ours', () => {
  assert.ok(!belongsTo({}, 1));
  assert.ok(!belongsTo({ target: null }, 1));
  assert.ok(!belongsTo(null, 1));
  assert.deepEqual(datasetSlice(null, 1), []);
});

// --- what the bundle says ----------------------------------------------------

test('the bundle starts the new project with nothing but the dataset', () => {
  const b = copyBundle({ log: fixture(), activeId: 12, activePlugins: ['p'], output: [{ x: 1 }] }, 1);
  assert.equal(b.activeId, 1, 'the copied dataset is the active one, not the source project’s');
  assert.deepEqual(b.output, []);
  assert.deepEqual(b.analysisLog, []);
  assert.equal(b.activePlugins, null);
});

test('the co-authoring identity is NOT carried — a copy is not the same room', () => {
  // Carrying it would silently put two different projects in one live session, where each
  // would receive the other's ops as if they were its own history.
  const b = copyBundle({ log: fixture(), collabId: 'room-1', collabSecret: 's' }, 1);
  assert.equal(b.collabId, null);
  assert.equal(b.collabSecret, null);
});

test('op ids and the dataset id are preserved, not re-minted', () => {
  // Same decision #166 made for record blocks: op identity is the merge key, so a copy that
  // keeps it can be recognised as shared ancestry later instead of duplicating everything.
  // It is also what makes the Parquet sidecar names (src_<opId>.parquet) line up.
  const log = fixture();
  const b = copyBundle({ log }, 1);
  const original = log.filter((o) => o.target.startsWith('ds:1/'));
  assert.deepEqual(b.log.filter((o) => o.target.startsWith('ds:1/')).map((o) => o.id),
    original.map((o) => o.id));
  assert.ok(b.log.some((o) => o.target === 'coll/ds:1'));
});

// --- what the user is told before it happens ---------------------------------

test('the summary counts the source separately from the cleaning steps', () => {
  // "Source plus the actions taken to clean it" is the promise; these are the two halves of
  // it, and the step count is what the hint shows.
  const d = describeSlice(datasetSlice(fixture(), 1));
  assert.equal(d.sources, 1);
  assert.equal(d.steps, 2);
  assert.equal(d.retracted, 0);
});

test('undone and retracted work is COUNTED but not counted as a step', () => {
  // The ops still travel — the fold hides them, so the data is identical either way, and a
  // tidied log would misrepresent what was done. But a step count that included a recode
  // the author backed out of would overstate the cleaning.
  const log = fixture();
  const recode = log.find((o) => o.target === 'ds:1/var:age');
  log.push(op('ds:1/undo', 'undo', { opId: recode.id }));
  const slice = datasetSlice(log, 1);
  const d = describeSlice(slice);
  assert.equal(d.steps, 1, 'the undone recode is not a cleaning step');
  assert.equal(d.retracted, 1);
  assert.ok(slice.some((o) => o.id === recode.id), 'but it is still carried, undo and all');
});

test('a retract works the same way as an undo', () => {
  const log = fixture();
  const filter = log.find((o) => o.target === 'ds:1/rows');
  log.push(op('ds:1/retract', 'retract', { opId: filter.id }));
  assert.equal(describeSlice(datasetSlice(log, 1)).steps, 1);
});

test('a live source with no bytes is named, so the caller can refuse', () => {
  // The co-author case: an op arrives over the wire ahead of its Parquet. Writing the
  // project anyway would produce a `load` pointing at a file nobody ever wrote — openable,
  // and empty, with nothing saying why.
  const log = [
    op('coll/ds:3', 'addDataset', { id: 3, name: 'Incoming' }),
    op('ds:3/data', 'load', { src: { label: 'peer.parquet', meta: [] } }),
  ];
  const d = describeSlice(datasetSlice(log, 3));
  assert.deepEqual(d.missingBytes, ['peer.parquet']);
});

test('a source already written to disk counts as present', () => {
  // On the save path bytes have been replaced by a file ref; that is not a missing source.
  const log = [op('ds:4/data', 'load', { src: { label: 'f', meta: [], file: 'src_op1.parquet' } })];
  assert.deepEqual(describeSlice(datasetSlice(log, 4)).missingBytes, []);
});

test('a dataset with no source at all reports none, so the copy can be refused', () => {
  const log = [op('coll/ds:5', 'addDataset', { id: 5, name: 'Empty' })];
  assert.equal(describeSlice(datasetSlice(log, 5)).sources, 0);
});

// --- naming ------------------------------------------------------------------

test('the copy is named after the dataset, and never collides with an existing project', () => {
  assert.equal(copyName('GSS extract', []), 'GSS extract');
  assert.equal(copyName('GSS extract', ['GSS extract']), 'GSS extract (2)');
  assert.equal(copyName('GSS extract', ['GSS extract', 'GSS extract (2)']), 'GSS extract (3)');
  assert.equal(copyName('GSS extract', ['  gss EXTRACT ']), 'GSS extract (2)', 'case and spacing are not a new name');
});

test('an unnamed dataset still yields a usable project name', () => {
  assert.equal(copyName('', []), 'Dataset');
  assert.equal(copyName('   ', []), 'Dataset');
  assert.equal(copyName(undefined, ['Dataset']), 'Dataset (2)');
});

// --- copying into an EXISTING project ----------------------------------------
//
// The owner's extension (2026-10-02): *"what about extending the 'copy dataset' we just built
// to allow copying into an existing project? It fully replaces the 'add building block to an
// existing project' functionality we no longer have."* It is the same slice, unioned into the
// destination's log by op id — which is what receiving a co-author's ops already does.

test('copying in is a union by op id — the destination keeps everything it had', () => {
  const log = fixture();
  const theirs = [op('coll/ds:9', 'addDataset', { id: 9, name: 'Their data' }), src(9, 'theirs.csv')];
  const merged = unionById(theirs, datasetSlice(log, 1));
  assert.deepEqual(merged.slice(0, 2).map((o) => o.target), ['coll/ds:9', 'ds:9/data'],
    'their ops keep their positions');
  assert.deepEqual(merged.slice(2).map((o) => o.target),
    ['coll/ds:1', 'ds:1/data', 'ds:1/var:age', 'ds:1/rows']);
});

test('copying the same dataset twice is a no-op the second time', () => {
  // Idempotence falls out of the merge key rather than being argued for, which is the whole
  // reason this is a union and not an append.
  const log = fixture();
  const slice = datasetSlice(log, 1);
  const once = unionById([], slice);
  const twice = unionById(once, slice);
  assert.deepEqual(twice.map((o) => o.id), once.map((o) => o.id));
});

test('a destination already holding a DIFFERENT dataset with that id is refused', () => {
  // 48 bits of CSPRNG means this is a deliberate act — most likely the destination is a copy
  // of this same project. Merging would fuse two histories of one id.
  const slice = datasetSlice(fixture(), 1);
  const theirs = [op('coll/ds:1', 'addDataset', { id: 1, name: 'Something else entirely' })];
  assert.equal(datasetIdTaken(theirs, slice, 1), true);
});

test('a destination that already has THIS dataset (same ops) is not a collision', () => {
  // Re-copying is allowed and idempotent; only a rival id is a problem.
  const slice = datasetSlice(fixture(), 1);
  assert.equal(datasetIdTaken(slice, slice, 1), false);
  assert.equal(datasetIdTaken([], slice, 1), false);
});

test('unionById tolerates an absent log on either side', () => {
  assert.deepEqual(unionById(null, null), []);
  assert.deepEqual(unionById(undefined, [op('ds:1/x', 'recode')]).length, 1);
});

// --- which projects can receive one ------------------------------------------

const projectRow = (over = {}) => ({
  key: 'opfs:p1', name: 'A project', kind: 'opfs', projectId: 'p1', isOpen: false, ...over,
});

test('the open project is not offered — that would be "duplicate here", a different verb', () => {
  // Also the practical reason: writing under a live session would be overwritten by its next
  // autosave, so offering it would be offering a silent no-op.
  const { options } = copyTargets([projectRow(), projectRow({ projectId: 'p2', name: 'Open one', isOpen: true })]);
  assert.deepEqual(options, [{ value: 'p1', label: 'A project' }]);
});

test('folder and cloud projects are counted out loud, not silently dropped', () => {
  // They need their backend connected (sometimes a user gesture) before anything can be
  // written, which is separate work — so the form says so rather than looking complete.
  const { options, elsewhere } = copyTargets([
    projectRow(),
    { key: 'loc:1', name: 'In Dropbox', kind: 'dropbox', projectId: null, isOpen: false },
    { key: 'loc:2', name: 'In a folder', kind: 'folder', projectId: null, isOpen: false },
  ]);
  assert.deepEqual(options.map((o) => o.label), ['A project']);
  assert.equal(elsewhere, 2);
});

test('identically-named destinations are told apart — an unchoosable option is a wrong write', () => {
  // Found in the browser: a dev session had four "Untitled project" rows in the picker, and
  // nothing to pick between them. In a destination list that is not cosmetic — choosing the
  // wrong one writes a dataset into the wrong project.
  const { options } = copyTargets([
    projectRow({ projectId: 'a', name: 'Untitled project', datasetCount: 2, lastOpenedAt: 1 }),
    projectRow({ projectId: 'b', name: 'Untitled project', datasetCount: 5, lastOpenedAt: 2 }),
    projectRow({ projectId: 'c', name: 'Course pack', datasetCount: 1, lastOpenedAt: 3 }),
  ], { stamp: (r) => `t${r.lastOpenedAt}` });
  assert.equal(new Set(options.map((o) => o.label)).size, options.length, 'every label distinct');
  assert.deepEqual(options.map((o) => o.label), [
    'Untitled project — 2 datasets, t1',
    'Untitled project — 5 datasets, t2',
    'Course pack',
  ], 'and ONLY the duplicates carry the extra detail');
});

test('a project whose size the catalog does not know still gets a usable label', () => {
  const { options } = copyTargets([
    projectRow({ projectId: 'a', name: 'Same', datasetCount: null, lastOpenedAt: 0, savedAt: 0 }),
    projectRow({ projectId: 'b', name: 'Same', datasetCount: 1, lastOpenedAt: 5 }),
  ], { stamp: (r) => (r.lastOpenedAt ? 'then' : 'never opened') });
  assert.deepEqual(options.map((o) => o.label), [
    'Same — unknown size, never opened',
    'Same — 1 dataset, then',
  ]);
});

test('no projects at all is an empty list, not a crash', () => {
  assert.deepEqual(copyTargets([]), { options: [], elsewhere: 0 });
  assert.deepEqual(copyTargets(null), { options: [], elsewhere: 0 });
});
