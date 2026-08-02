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

test('slice: one dataset\'s data ops are read back in HLC order, isolated from other tiers', () => {
  const { log, tick } = peer(1000);
  log.append(addDs(5, 'wide')); // collection tier
  tick(1100); const load = log.append({ target: 'ds:5/source', owner: 'core', type: 'load', payload: { seq: 1 } });
  tick(1200); const recode = log.append({ target: 'ds:5/var:income', owner: 'core', type: 'recodeVar', payload: {} });
  tick(1150); const other = log.append({ target: 'ds:9/source', owner: 'core', type: 'load', payload: {} }); // a different dataset
  const mine = log.slice((o) => o.target.startsWith('ds:5/'));
  assert.deepEqual(mine.map((o) => o.id), [load.id, recode.id], 'only ds:5 ops, in HLC order');
  assert.ok(!mine.includes(other));
  assert.equal(log.slice((o) => o.target.startsWith('coll/')).length, 1);
});

test('serialize/restore: the whole log round-trips and the clock stays monotonic', () => {
  const a = peer(1000);
  a.log.append(addDs(1, 'a'));
  a.tick(1100); a.log.append({ target: 'ds:1/var:x', owner: 'core', type: 'computeVar', payload: { name: 'x' } });
  const wire = a.log.serialize();
  // A fresh peer restores from the wire form → identical projection state.
  const b = peer(1); // deliberately-behind clock: restore must advance it past the saved ops
  b.log.restore(wire);
  assert.deepEqual(b.log.ops().map((o) => o.id), wire.map((o) => o.id), 'ops round-trip in order');
  assert.deepEqual(b.log.state('collection'), [{ id: 1, name: 'a' }]);
  // b's next local op sorts AFTER everything restored (clock advanced past saved HLCs).
  const next = b.log.append(addDs(2, 'b'));
  const maxSaved = Math.max(...wire.map((o) => o.hlc.wall));
  assert.ok(next.hlc.wall >= maxSaved, 'restored clock did not regress');
});

test('serialize is HLC-ordered regardless of append/receive interleaving', () => {
  const a = peer(1000);
  const o1 = a.log.append(addDs(1, 'a'));
  const b = peer(1000);
  b.tick(1050); const o2 = b.log.append(addDs(2, 'b'));
  a.log.receiveOps([o2]); // arrives after o1 but has a later HLC → sorts after
  assert.deepEqual(a.log.serialize().map((o) => o.id), [o1.id, o2.id]);
});

test('scoped undo/redo: undoWhere targets one tier on the shared log, leaving others', () => {
  // The DataStore relies on this to undo ONLY its own dataset's ops on the one log.
  const { log, tick } = peer(1000);
  const ds5 = (o) => o.target.startsWith('ds:5/');
  log.append(addDs(5, 'wide'));                                                  // collection tier
  tick(1100); const a = log.append({ target: 'ds:5/var:x', owner: 'core', type: 'computeVar', payload: { name: 'x' } });
  tick(1200); const b = log.append({ target: 'ds:5/var:y', owner: 'core', type: 'computeVar', payload: { name: 'y' } });
  assert.equal(log.canUndoWhere(ds5), true);
  const undone = log.undoWhere(ds5);
  assert.equal(undone.id, b.id, 'undid the highest-HLC ds:5 op');
  assert.deepEqual(log.slice(ds5).map((o) => o.id), [a.id], 'only a remains live in the slice');
  assert.deepEqual(log.state('collection'), [{ id: 5, name: 'wide' }], 'the collection tier is untouched');
  assert.deepEqual(log.undoneOps(ds5).map((o) => o.id), [b.id]);
  // redoWhere re-applies it
  assert.equal(log.redoWhere(ds5).id, b.id);
  assert.deepEqual(log.slice(ds5).map((o) => o.id), [a.id, b.id]);
});

test('clearWhere hard-drops matching ops from both active and redo (rollback of an invalid op)', () => {
  const { log } = peer(1000);
  const a = log.append({ target: 'ds:5/rows', owner: 'core', type: 'filterCases', payload: { expr: 'bad(' } });
  log.clearWhere((o) => o.id === a.id); // as DataStore does when a transform's SQL fails
  assert.equal(log.slice((o) => o.target.startsWith('ds:5/')).length, 0);
  assert.equal(log.canUndo, false);
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
