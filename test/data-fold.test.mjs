/**
 * Headless tests for foldDataOps (core/data-fold.js) — the pure ordering fold that
 * turns one dataset's HLC-ordered op slice into the live, ordered step list rederive
 * replays. Covers the two structural op types the migration introduces: `retract`
 * (log-native deletion) and `reorder` (user-editable pipeline order).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldDataOps, liveStepIds, barrierDroppedIds } from '../core/data-fold.js';

// A minimal op (already HLC-ordered by the caller; order here = array order).
const op = (id, type, payload = {}) => ({ id, type, payload });

test('plain data ops pass through, flattened for the replay switch', () => {
  const steps = foldDataOps([
    op('a', 'load', { src: { meta: [] }, label: 'base' }),
    op('b', 'recodeVar', { name: 'inc2', source: 'income' }),
  ]);
  assert.deepEqual(steps, [
    { id: 'a', author: undefined, type: 'load', src: { meta: [] }, label: 'base' },
    { id: 'b', author: undefined, type: 'recodeVar', name: 'inc2', source: 'income' },
  ]);
});

test('a retract op drops its target step (log-native deletion)', () => {
  const steps = foldDataOps([
    op('a', 'load'),
    op('b', 'computeVar', { name: 'bmi' }),
    op('r', 'retract', { opId: 'b' }),
  ]);
  assert.deepEqual(liveStepIds([op('a', 'load'), op('b', 'computeVar'), op('r', 'retract', { opId: 'b' })]), ['a']);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, 'a');
});

test('retract is order-independent: retract can precede nothing / dangling opId is harmless', () => {
  // retract of an id that isn't present just no-ops.
  assert.deepEqual(liveStepIds([op('a', 'load'), op('r', 'retract', { opId: 'ghost' })]), ['a']);
});

test('a reorder op sets replay order; unlisted ops keep HLC order after the named ones', () => {
  const ops = [
    op('load', 'load'),
    op('t1', 'computeVar', { name: 'x' }),
    op('t2', 'computeVar', { name: 'y' }),
    op('ro', 'reorder', { order: ['load', 't2', 't1'] }),
  ];
  assert.deepEqual(liveStepIds(ops), ['load', 't2', 't1']);
});

test('reorder + a later-added op: the newcomer (unlisted) lands last in HLC order', () => {
  const ops = [
    op('load', 'load'),
    op('t1', 'setVariable', {}),
    op('ro', 'reorder', { order: ['t1', 'load'] }),
    op('t2', 'filterCases', {}), // appended after the reorder; not named in it
  ];
  assert.deepEqual(liveStepIds(ops), ['t1', 'load', 't2']);
});

test('latest reorder wins (input is HLC-ordered, so the last reorder seen is newest)', () => {
  const ops = [
    op('a', 'load'),
    op('b', 'computeVar'),
    op('ro1', 'reorder', { order: ['b', 'a'] }),
    op('ro2', 'reorder', { order: ['a', 'b'] }),
  ];
  assert.deepEqual(liveStepIds(ops), ['a', 'b']);
});

test('retract of a reordered step: gone from the result even though the reorder names it', () => {
  const ops = [
    op('a', 'load'),
    op('b', 'computeVar'),
    op('ro', 'reorder', { order: ['b', 'a'] }),
    op('r', 'retract', { opId: 'b' }),
  ];
  assert.deepEqual(liveStepIds(ops), ['a']);
});

test('empty / nullish input', () => {
  assert.deepEqual(foldDataOps([]), []);
  assert.deepEqual(foldDataOps(undefined), []);
  assert.deepEqual(barrierDroppedIds(undefined), []);
});

// --- the replace barrier (#149 B1) -----------------------------------------------
// A `load` restarts the projection, so everything before it is dead. Deriving that
// from the load itself (instead of retracting the prior steps at import time) makes a
// replace-import ONE undoable action, which is what stopped Ctrl+Z bricking a dataset.

test('a later load supersedes everything before it (replace barrier)', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar', { name: 'bmi' }),
    op('s2', 'load'), // replace-import
  ];
  assert.deepEqual(liveStepIds(ops), ['s2']);
  assert.deepEqual(barrierDroppedIds(ops), ['s1', 't1']);
});

test('undoing the replacing load brings the whole previous pipeline back', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar', { name: 'bmi' }),
    op('s2', 'load'),
    op('u', 'undo', { opId: 's2' }), // ONE Ctrl+Z
  ];
  assert.deepEqual(liveStepIds(ops), ['s1', 't1']);
  assert.deepEqual(barrierDroppedIds(ops), []); // nothing is behind a barrier now
});

test('steps after the replacing load survive it; appends/joins are not barriers', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar'),
    op('s2', 'load'),
    op('s3', 'append'),
    op('t2', 'recodeVar'),
    op('s4', 'join'),
  ];
  assert.deepEqual(liveStepIds(ops), ['s2', 's3', 't2', 's4']);
});

test('the barrier is fixed by HLC order — a reorder cannot revive a superseded step', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar'),
    op('s2', 'load'),
    op('ro', 'reorder', { order: ['s1', 't1', 's2'] }), // names the dead ops explicitly
  ];
  assert.deepEqual(liveStepIds(ops), ['s2']); // reorder moves things; it never resurrects them
});

test('an undone load is not a barrier (only live ops bound the replay)', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar'),
    op('s2', 'load'),
    op('u', 'undo', { opId: 's2' }),
    op('r', 'redo', { opId: 's2' }), // …and back again
  ];
  assert.deepEqual(liveStepIds(ops), ['s2']);
});

test('a retracted load stops acting as a barrier', () => {
  const ops = [
    op('s1', 'load'),
    op('t1', 'computeVar'),
    op('s2', 'load'),
    op('r', 'retract', { opId: 's2' }),
  ];
  assert.deepEqual(liveStepIds(ops), ['s1', 't1']);
});

// --- identity is the OP's, and a payload cannot take it -------------------------------
// Found 2026-10-13 by browser-verifying #190's History arrows. Moving an analysis grew the
// transform list 1 → 2 → 5 → 10 → 20 → 30, and `replaceTransforms(getTransforms())` —
// replacing the list with exactly what was already there — appended every time.
//
// The chain: getTransforms() returns FLATTENED steps, which include `id`.
// replaceTransforms clones what it is given into the new ops' payloads. flattenStep used
// to spread the payload LAST, so the stale `id` shadowed the new op's real one. The fold
// then reported one id for thirty distinct ops, and the next rebuild's `retract(step.id)`
// retracted an already-retracted op instead of the live one. Nothing threw; the data was
// only correct because the transform under test was idempotent.

test('a payload carrying an id cannot shadow the op it belongs to', () => {
  const steps = foldDataOps([
    op('real-1', 'computeVar', { name: 'x', expr: 'a + 1', id: 'STALE', author: 'ghost' }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, 'real-1', 'the op owns its identity; the payload does not');
  assert.equal(steps[0].name, 'x', 'and the rest of the payload still comes through');
  assert.equal(steps[0].expr, 'a + 1');
});

test('distinct ops stay distinct even when their payloads all claim one id', () => {
  // This is the shape the bug produced: thirty live ops, one reported id, so retracting
  // "each" of them retracted the same one thirty times and the rest stayed live.
  const steps = foldDataOps([
    op('a', 'computeVar', { name: 'x', id: 'SAME' }),
    op('b', 'computeVar', { name: 'y', id: 'SAME' }),
    op('c', 'computeVar', { name: 'z', id: 'SAME' }),
  ]);
  assert.deepEqual(steps.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(new Set(steps.map((s) => s.id)).size, 3, 'three ops, three identities');
});

test('retracting by the folded id actually removes that step', () => {
  // The property the bug broke: what the fold reports as a step's id must be the id a
  // retract has to name. If they differ, retraction silently does nothing.
  const ops = [
    op('a', 'computeVar', { name: 'x', id: 'STALE' }),
    op('b', 'computeVar', { name: 'y' }),
  ];
  const before = foldDataOps(ops);
  const retractFirst = [...ops, op('r', 'retract', { opId: before[0].id })];
  const after = foldDataOps(retractFirst);
  assert.deepEqual(after.map((s) => s.name), ['y'], 'the step named by its folded id is gone');
});

test('author is the op\u2019s too', () => {
  const steps = foldDataOps([
    { id: 'a', type: 'computeVar', author: 'alice', payload: { name: 'x', author: 'ghost' } },
  ]);
  assert.equal(steps[0].author, 'alice');
});
