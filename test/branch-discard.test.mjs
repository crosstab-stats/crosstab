/**
 * @file branch-discard.test.mjs
 * A new action discards the branch below the cursor (#191 T4).
 *
 * `rewindTo` has documented this since it was written — *"a subsequent fresh operation
 * discards whatever is still ahead (standard linear branch-discard), so the timeline stays
 * linear"* — and it was never implemented. Probed on the real modules before this existed:
 *
 *     A,B,C                        live: a,b,c    future: —
 *     undo C                       live: a,b      future: c
 *     append D (while C undone)    live: a,b,d    future: c
 *     redo once                    live: a,b,c,d  future: —
 *
 * `c` came back ABOVE `d`, because the fold orders by HLC. So the History panel drew
 * undone rows below the applied ones while a redo inserted them in the middle, and a
 * stashed analysis output could be restored into a data state that had moved on
 * underneath it. The owner's assumption — that a data change after an undo invalidates
 * the future — was the right rule, and simply wasn't true yet.
 *
 * The discard is an explicit `retract` per op: append-only, auditable, and it propagates
 * on merge instead of reading as the peer's addition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLog } from '../core/project-log.js';
import { foldDataOps } from '../core/data-fold.js';
import { UndoCoordinator } from '../core/undo-coordinator.js';
import { CoreEvents } from '../core/event-bus.js';

const mine = (o) => typeof o.target === 'string' && o.target.startsWith('ds:1');
const add = (log, name) => log.append({
  target: `ds:1/var:${name}`, owner: 'core', type: 'computeVar', payload: { name, expr: '1' },
});
const live = (log) => foldDataOps(log.slice(mine)).map((s) => s.name).join(',');
const ahead = (log) => log.undoneOps(mine).map((o) => o.payload.name).join(',');

test('a retracted op is no longer redoable, and no longer counts as "ahead"', () => {
  const log = new ProjectLog();
  add(log, 'a');
  const c = add(log, 'c');
  log.undoWhere(mine);
  assert.equal(ahead(log), 'c', 'undone, so it is ahead of the cursor');

  log.append({ target: c.target, owner: 'core', type: 'retract', payload: { opId: c.id } });
  assert.equal(ahead(log), '', 'retracted: gone, not merely hidden');
  assert.equal(log.topRedoable(mine), null, 'and a redo must not be able to resurrect it');
  assert.equal(live(log), 'a');
});

/** The coordinator with fakes for everything it only pokes. */
function harness() {
  const log = new ProjectLog();
  const listeners = new Map();
  const removed = [];
  const bus = {
    emit: (name, payload) => { for (const fn of listeners.get(name) ?? []) fn(payload); },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
  };
  const undo = new UndoCoordinator({
    datasets: { canUndo: true, canRedo: false, undo: async () => {}, redo: async () => {} },
    analysisLog: { entries: () => [] },
    results: { removeRun: (id) => removed.push(id), removeByTag() {} },
    pluginActions: {},
    bus,
    projectLog: log,
    itemStore: { loadFromLog() {} },
    onItemsChanged: async () => {},
  });
  return { log, bus, undo, removed };
}

test('a NEW data action discards whatever was still ahead', () => {
  const { log, bus } = harness();
  add(log, 'a');
  add(log, 'b');
  add(log, 'c');
  log.undoWhere(mine);
  assert.equal(ahead(log), 'c');

  add(log, 'd');
  bus.emit(CoreEvents.DATA_CHANGED, { reason: 'transform' });

  assert.equal(live(log), 'a,b,d');
  assert.equal(ahead(log), '', 'the branch below the cursor is gone');
  assert.equal(log.topRedoable(mine), null, 'so `c` can never reappear between `b` and `d`');
});

test('a browse-only reason does NOT discard — rewinding is not an edit', () => {
  // Rewinding emits DATA_CHANGED too. If that discarded, clicking a History row would
  // destroy the branch you clicked back to see, and fast-forwarding would be impossible.
  const { log, bus } = harness();
  add(log, 'a');
  add(log, 'b');
  log.undoWhere(mine);
  bus.emit(CoreEvents.DATA_CHANGED, { reason: 'rewind' });
  assert.equal(ahead(log), 'b', 'still redoable');
});

test('a new ANALYSIS discards the data branch too — one timeline, one cursor', () => {
  const { log, bus } = harness();
  add(log, 'a');
  add(log, 'b');
  log.undoWhere(mine);
  assert.equal(ahead(log), 'b');

  bus.emit('analysislog:recorded', { runId: 'r1', label: 'Frequencies' });
  assert.equal(ahead(log), '', 'the timeline is one list, so one new action clears one future');
});

test('discarding a withdrawn analysis drops its stashed output', () => {
  // Otherwise a later fast-forward could restore a result whose steps no longer exist.
  const { log, bus, removed } = harness();
  const run = log.append({
    target: 'analysis:r9', owner: 'core', type: 'runAnalysis', payload: { runId: 'r9', label: 'A' },
  });
  log.undoWhere((o) => o.id === run.id);
  bus.emit(CoreEvents.DATA_CHANGED, { reason: 'transform' });
  assert.deepEqual(removed, ['r9']);
});

test('the discard does not recurse through the DATA_CHANGED its own retracts emit', () => {
  const { log, bus } = harness();
  add(log, 'a');
  add(log, 'b');
  log.undoWhere(mine);
  const before = log.slice(() => true).length;
  bus.emit(CoreEvents.DATA_CHANGED, { reason: 'transform' });
  bus.emit(CoreEvents.DATA_CHANGED, { reason: 'transform' }); // nothing left ahead
  assert.equal(log.slice(() => true).length, before + 1, 'exactly one retract, not a cascade');
});
