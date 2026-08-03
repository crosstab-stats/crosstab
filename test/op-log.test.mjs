/**
 * Headless tests for the unified op-log primitives (core/op-log.js): the envelope,
 * the shared-id merge base, HLC ordering, and reads[] dangling detection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOp, opIds, sharedAncestor, orderByHlc, unresolvedReads } from '../core/op-log.js';

const hlc = (wall, counter = 0) => ({ wall, counter });
const op = (id, { target = 't', owner = 'core', type = 'x', reads = [], wall = id * 10 } = {}) =>
  makeOp({ target, owner, type, reads }, { id, hlc: hlc(wall), author: { authorId: 'a' } });

test('makeOp stamps fields, defaults reads to [], mints an id when absent', () => {
  const o = makeOp({ target: 'ds:1/var:x', owner: 'core', type: 'recodeVar' }, { hlc: hlc(1) });
  assert.equal(o.target, 'ds:1/var:x');
  assert.equal(o.owner, 'core');
  assert.deepEqual(o.reads, []);
  assert.ok(o.id && typeof o.id === 'string');
});

test('makeOp requires routing fields (fail loudly, never merge into limbo)', () => {
  assert.throws(() => makeOp({ owner: 'core', type: 'x' }, { hlc: hlc(1) }), /target/);
  assert.throws(() => makeOp({ target: 't', type: 'x' }, { hlc: hlc(1) }), /owner/);
  assert.throws(() => makeOp({ target: 't', owner: 'core' }, { hlc: hlc(1) }), /type/);
  assert.throws(() => makeOp({ target: 't', owner: 'core', type: 'x' }, {}), /hlc/);
});

test('sharedAncestor is the id-set intersection (the merge base) in mine order', () => {
  const mine = [op(1), op(2), op(3)];
  const theirs = [op(2), op(3), op(4)];
  const base = sharedAncestor(mine, theirs);
  assert.deepEqual(base.map((o) => o.id), [2, 3]);
  assert.deepEqual([...opIds([op(1), op(2)])].sort(), [1, 2]);
});

test('sharedAncestor is empty when two branches share no history (independent forks)', () => {
  assert.deepEqual(sharedAncestor([op(1)], [op(2)]), []);
});

test('orderByHlc interleaves by time (not mine-then-theirs) with id as a stable tiebreak', () => {
  // Two peers' concurrent ops, given by creation time regardless of which "side".
  const a1 = op('a1', { wall: 100 });
  const a2 = op('a2', { wall: 300 });
  const b1 = op('b1', { wall: 200 });
  const ordered = orderByHlc([a2, b1, a1]).map((o) => o.id);
  assert.deepEqual(ordered, ['a1', 'b1', 'a2']); // 100, 200, 300 — true temporal interleave
});

test('orderByHlc breaks exact-tie deterministically by id (both peers converge)', () => {
  const x = op('x', { wall: 500 });
  const y = op('y', { wall: 500 });
  assert.deepEqual(orderByHlc([y, x]).map((o) => o.id), ['x', 'y']);
  assert.deepEqual(orderByHlc([x, y]).map((o) => o.id), ['x', 'y']); // order-independent
});

test('unresolvedReads: clean when every reader follows its writer', () => {
  const writer = op('w', { target: 'ds:1/var:income', wall: 10 });
  const reader = op('r', { target: 'ds:1/var:incBand', reads: ['ds:1/var:income'], wall: 20 });
  assert.deepEqual(unresolvedReads([writer, reader]), []);
});

test('unresolvedReads: flags a reader that lands BEFORE its writer (dangling, surfaced not repaired)', () => {
  const writer = op('w', { target: 'ds:1/var:income', wall: 20 });
  const reader = op('r', { target: 'ds:1/var:incBand', reads: ['ds:1/var:income'], wall: 10 });
  // Ordered by HLC the reader (t=10) precedes the writer (t=20) → income not yet available.
  const problems = unresolvedReads(orderByHlc([writer, reader]));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].op.id, 'r');
  assert.deepEqual(problems[0].missing, ['ds:1/var:income']);
});

test('unresolvedReads: a target satisfied by the base (checkpoint/import) is not dangling', () => {
  const reader = op('r', { target: 'ds:1/var:incBand', reads: ['ds:1/var:income'], wall: 10 });
  assert.deepEqual(unresolvedReads([reader], { base: ['ds:1/var:income'] }), []);
});

test('unresolvedReads: a read of something that never exists is dangling (removed-var case)', () => {
  const reader = op('r', { target: 'ds:1/var:z', reads: ['ds:1/var:gone'], wall: 10 });
  const problems = unresolvedReads([reader]);
  assert.deepEqual(problems.map((p) => p.missing), [['ds:1/var:gone']]);
});
