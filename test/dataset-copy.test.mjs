/**
 * @file dataset-copy.test.mjs
 * "Copy dataset to a new project" — the building-block library's replacement (2026-10-02).
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
  belongsTo, copyBundle, copyName, datasetSlice, describeSlice,
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
