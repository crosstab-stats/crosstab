/**
 * @file project-duplicate.test.mjs
 * Duplicating a project re-mints every op id, and every reference to one.
 *
 * The owner's spec (2026-10-17): *"fresh opIDs, fork should include current state with
 * full log (yes, even things like step reordering). Duplicate in my mind means a full
 * duplicate and not just 'snapshot what it looks like now'."*
 *
 * So this is not a flatten-and-save. The whole log travels — undo markers, retractions,
 * reorders and all — which means every op id has to move together with everything that
 * names one. Four things do, and missing any of them fails silently:
 *
 *  - `op.id`;
 *  - `payload.opId` on `undo` / `redo` / `retract`;
 *  - `payload.order` on `reorder` — an ARRAY of ids, and the case the owner called out:
 *    miss it and the fork's steps quietly revert to their original order;
 *  - `payload.src.file`, which is `src_<opId>.parquet`, so the bytes land under a name
 *    nothing reads.
 *
 * The contrast worth keeping in view is {@link copyBundle}, which deliberately PRESERVES
 * op ids when copying a dataset into another project: there, shared identity is what
 * lets the two be recognised as common ancestry later. A fork wants the opposite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { reidentifyLog, copyBundle } from '../core/copy-to-project.js';

/** Deterministic ids, so assertions can name them. */
function minter() {
  let n = 0;
  return () => `new-${++n}`;
}

const hlc = (t) => ({ t, c: 0, node: 'n1' });

/** A log with one source, one transform, a reorder over both, an undo and a retract. */
function sampleLog() {
  return [
    {
      id: 'a', hlc: hlc(1), target: 'ds:1/src', owner: 'core', type: 'load', reads: [],
      payload: { src: { file: 'src_a.parquet', label: 'survey.csv', meta: {} } },
    },
    { id: 'b', hlc: hlc(2), target: 'ds:1/t', owner: 'core', type: 'computeVar', reads: ['ds:1/src'], payload: { name: 'x' } },
    { id: 'c', hlc: hlc(3), target: 'ds:1/order', owner: 'core', type: 'reorder', reads: [], payload: { order: ['b', 'a'] } },
    { id: 'd', hlc: hlc(4), target: 'ds:1/t', owner: 'core', type: 'undo', reads: [], payload: { opId: 'b' } },
    { id: 'e', hlc: hlc(5), target: 'ds:1/t', owner: 'core', type: 'retract', reads: [], payload: { opId: 'a' } },
  ];
}

test('every op gets a fresh id', () => {
  const out = reidentifyLog(sampleLog(), minter());
  assert.deepEqual(out.map((o) => o.id), ['new-1', 'new-2', 'new-3', 'new-4', 'new-5']);
});

test('a reorder carries the NEW ids, in the same order', () => {
  // The owner's case. Left alone, the fork's reorder would name ops that no longer
  // exist, the fold would ignore it, and the steps would silently revert to log order.
  const out = reidentifyLog(sampleLog(), minter());
  const reorder = out.find((o) => o.type === 'reorder');
  assert.deepEqual(reorder.payload.order, ['new-2', 'new-1'],
    'the order must be remapped AND keep its sequence');
});

test('undo and retract still point at the ops they act on', () => {
  const out = reidentifyLog(sampleLog(), minter());
  const byType = Object.fromEntries(out.map((o) => [o.type, o]));
  assert.equal(byType.undo.payload.opId, 'new-2', 'undo must follow the op it hid');
  assert.equal(byType.retract.payload.opId, 'new-1', 'retract must follow the op it dropped');
});

test('a source op’s sidecar name follows its new id', () => {
  // `src_<opId>.parquet` — if the name keeps the old id the bytes are written where
  // nothing looks for them, and the fork opens with an empty dataset.
  const out = reidentifyLog(sampleLog(), minter());
  const src = out.find((o) => o.type === 'load');
  assert.equal(src.payload.src.file, 'src_new-1.parquet');
  assert.equal(src.payload.src.label, 'survey.csv', 'the rest of the source is untouched');
});

test('a reference to an op defined LATER still resolves', () => {
  // Ids are minted in one pass before anything is rewritten, so order cannot matter.
  const log = [
    { id: 'u', hlc: hlc(1), target: 't', owner: 'core', type: 'undo', reads: [], payload: { opId: 'z' } },
    { id: 'z', hlc: hlc(2), target: 't', owner: 'core', type: 'computeVar', reads: [], payload: {} },
  ];
  const out = reidentifyLog(log, minter());
  assert.equal(out[0].payload.opId, out[1].id);
});

test('HLC stamps, targets, reads and authors are NOT touched', () => {
  // Re-stamping would reorder the log, and a full duplicate must not do that. `reads`
  // holds TARGETS rather than op ids, so remapping it would corrupt the causal edges.
  const log = sampleLog().map((o) => ({ ...o, author: { authorId: 'me' } }));
  const out = reidentifyLog(log, minter());
  out.forEach((o, i) => {
    assert.deepEqual(o.hlc, log[i].hlc);
    assert.equal(o.target, log[i].target);
    assert.deepEqual(o.reads, log[i].reads);
    assert.deepEqual(o.author, log[i].author);
    assert.equal(o.type, log[i].type);
  });
});

test('the input log is not mutated', () => {
  const log = sampleLog();
  const before = JSON.stringify(log);
  reidentifyLog(log, minter());
  assert.equal(JSON.stringify(log), before);
});

test('ids are unique, and no old id survives anywhere', () => {
  const out = reidentifyLog(sampleLog());
  const ids = out.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'a collision would merge two ops into one');
  // Checked as VALUES, not as substrings of the JSON: an HLC stamp has a field called
  // `c`, so a naive text search for the old id "c" matches `"c":0` and fails on nothing.
  const OLD = new Set(['a', 'b', 'c', 'd', 'e']);
  for (const o of out) {
    assert.ok(!OLD.has(o.id), `op still has its old id: ${o.id}`);
    assert.ok(!OLD.has(o.payload?.opId), `a reference still names an old id: ${o.payload?.opId}`);
    for (const x of o.payload?.order ?? []) assert.ok(!OLD.has(x), `a reorder still names ${x}`);
    const file = o.payload?.src?.file;
    if (file) assert.ok(!/src_[abcde]\.parquet/.test(file), `sidecar still named for an old id: ${file}`);
  }
});

test('an empty or junk log is handled rather than thrown at', () => {
  assert.deepEqual(reidentifyLog([]), []);
  assert.deepEqual(reidentifyLog(null), []);
  assert.deepEqual(reidentifyLog(undefined), []);
  const odd = reidentifyLog([null, { id: 'x', type: 'noop' }], minter());
  assert.equal(odd[0], null);
  assert.equal(odd[1].id, 'new-1');
});

// =============================================================================
// The contrast that must not be "tidied away"
// =============================================================================

test('copyBundle still PRESERVES ids — the opposite call, deliberately', () => {
  // A dataset copied into another project keeps its identity so the two can later be
  // recognised as sharing ancestry. A fork re-mints so they cannot. If someone ever
  // makes these agree, one of the two features breaks quietly.
  const bundle = { log: sampleLog(), activeId: 1 };
  const copied = copyBundle(bundle, 1);
  const kept = copied.log.filter((o) => ['a', 'b', 'c', 'd', 'e'].includes(o.id));
  assert.ok(kept.length > 0, 'copyBundle must not re-mint');
});
