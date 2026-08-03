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
