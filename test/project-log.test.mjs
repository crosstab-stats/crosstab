/**
 * Headless tests for the unified-log aggregate primitive (core/project-log.js).
 * A small "dataset collection" projection stands in for a real read-model, so we can
 * exercise append/fold, receive/dedup, merge (union / delete-propagation / conflict),
 * undo/redo, and two-peer convergence without any DuckDB/DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';

// A stand-in projection: the dataset COLLECTION (System 2). Ops target `coll/ds:<id>`.
const collection = {
  key: 'collection',
  match: (op) => op.owner === 'core' && op.target.startsWith('coll/'),
  fold: (ops) => {
    const names = new Map();
    for (const op of ops) {
      if (op.type === 'addDataset') names.set(op.payload.id, op.payload.name);
      else if (op.type === 'renameDataset') { if (names.has(op.payload.id)) names.set(op.payload.id, op.payload.name); }
      else if (op.type === 'removeDataset') names.delete(op.payload.id);
    }
    return [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.id - b.id);
  },
};

const addDs = (id, name) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'addDataset', payload: { id, name } });
const rmDs = (id) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'removeDataset', payload: { id } });
const renameDs = (id, name) => ({ target: `coll/ds:${id}`, owner: 'core', type: 'renameDataset', payload: { id, name } });

/** A peer with a controllable clock, so HLC order is deterministic across the test. */
function peer(startWall) {
  let wall = startWall;
  const log = new ProjectLog({ hlc: new HLC({ now: () => wall }) }).register(collection);
  return { log, tick: (w) => { wall = w; } };
}

test('append + fold: the projection reflects the ops', () => {
  const { log } = peer(1000);
  log.append(addDs(1, 'gss'));
  log.append(addDs(2, 'anes'));
  assert.deepEqual(log.state('collection'), [{ id: 1, name: 'gss' }, { id: 2, name: 'anes' }]);
});

test('fold honours op order: rename then remove', () => {
  const { log } = peer(1000);
  log.append(addDs(1, 'gss'));
  log.append(renameDs(1, 'GSS 2022'));
  assert.deepEqual(log.state('collection'), [{ id: 1, name: 'GSS 2022' }]);
  log.append(rmDs(1));
  assert.deepEqual(log.state('collection'), []);
});

test('receiveOps dedups by id and advances the clock', () => {
  const a = peer(1000);
  const o = a.log.append(addDs(1, 'gss'));
  const b = peer(1000);
  b.log.receiveOps([o]);
  b.log.receiveOps([o]); // duplicate delivery — must not double-add
  assert.deepEqual(b.log.state('collection'), [{ id: 1, name: 'gss' }]);
  // b's clock advanced past o, so b's next op sorts AFTER o.
  const o2 = b.log.append(addDs(2, 'anes'));
  assert.ok(o.hlc.wall <= o2.hlc.wall);
});

test('merge: disjoint additions union and both peers converge byte-identically', () => {
  const a = peer(1000);
  const shared = a.log.append(addDs(1, 'base'));   // common ancestor op
  const b = peer(1000);
  b.log.receiveOps([shared]);
  a.tick(1100); const aOp = a.log.append(addDs(2, 'mine'));
  b.tick(1200); const bOp = b.log.append(addDs(3, 'theirs'));

  const ra = a.log.merge(b.log.ops());
  const rb = b.log.merge(a.log.ops());
  assert.equal(ra.conflicts.length, 0);
  a.log.adopt(ra.ops); b.log.adopt(rb.ops);
  const expected = [{ id: 1, name: 'base' }, { id: 2, name: 'mine' }, { id: 3, name: 'theirs' }];
  assert.deepEqual(a.log.state('collection'), expected);
  assert.deepEqual(b.log.state('collection'), expected);
  // byte-identical op order on both peers (convergence)
  assert.deepEqual(a.log.ops().map((o) => o.id), b.log.ops().map((o) => o.id));
  void aOp; void bOp;
});

test('THESIS: a dataset deletion propagates as a real merged op (no absence-inference)', () => {
  // Both peers share datasets 1 and 2. A deletes 2; B does nothing to it.
  const a = peer(1000);
  const s1 = a.log.append(addDs(1, 'keep'));
  const s2 = a.log.append(addDs(2, 'goner'));
  const b = peer(1000);
  b.log.receiveOps([s1, s2]);
  assert.deepEqual(b.log.state('collection').map((d) => d.id), [1, 2]);

  a.tick(1100); a.log.append(rmDs(2)); // a records a REAL removeDataset op

  const rb = b.log.merge(a.log.ops());
  assert.equal(rb.conflicts.length, 0);
  b.log.adopt(rb.ops);
  assert.deepEqual(b.log.state('collection').map((d) => d.id), [1], 'ds 2 removed on B too — the op carried the delete');
});

test('merge: concurrent edits to the SAME dataset surface a conflict (never silent)', () => {
  const a = peer(1000);
  const s1 = a.log.append(addDs(1, 'orig'));
  const b = peer(1000);
  b.log.receiveOps([s1]);
  a.tick(1100); a.log.append(renameDs(1, 'A-name'));
  b.tick(1150); b.log.append(renameDs(1, 'B-name'));
  const r = a.log.merge(b.log.ops());
  assert.ok(r.conflicts.length >= 1, 'same-target concurrent rename is surfaced');
  assert.equal(r.conflicts[0].target, 'coll/ds:1');
});

test('undo/redo walk the log by HLC; a fresh op discards the redo branch', () => {
  const { log, tick } = peer(1000);
  log.append(addDs(1, 'a'));
  tick(1100); log.append(addDs(2, 'b'));
  assert.equal(log.canUndo, true);
  log.undo();
  assert.deepEqual(log.state('collection').map((d) => d.id), [1]); // newest op undone
  log.redo();
  assert.deepEqual(log.state('collection').map((d) => d.id), [1, 2]);
  log.undo();
  tick(1200); log.append(addDs(3, 'c')); // fresh op after undo
  assert.equal(log.canRedo, false, 'redo branch discarded');
  assert.deepEqual(log.state('collection').map((d) => d.id), [1, 3]);
});
