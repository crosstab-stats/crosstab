/**
 * Headless tests for foldDataOps (core/data-fold.js) — the pure ordering fold that
 * turns one dataset's HLC-ordered op slice into the live, ordered step list rederive
 * replays. Covers the two structural op types the migration introduces: `retract`
 * (log-native deletion) and `reorder` (user-editable pipeline order).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldDataOps, liveStepIds } from '../core/data-fold.js';

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
});
