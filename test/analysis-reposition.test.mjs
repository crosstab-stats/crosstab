/**
 * @file analysis-reposition.test.mjs
 * #190 — moving an analysis in the Steps view.
 *
 * Reported as "arrows show on analysis runs in syntax but not steps". The arrows were missing
 * because the operation did not exist: `AnalysisLog#move` was a deliberate no-op, so Syntax
 * view could reorder an analysis (Run re-parses the whole script) and Steps view could not.
 *
 * Three pieces had to be true for the arrows to mean anything, and each is tested here:
 *
 *  1. **The position can change, log-natively.** `at` is the number of transforms applied when
 *     the analysis ran, and a fresh `runAnalysis` op for the same `runId` replaces the payload
 *     — the projection already folds the newest op per run as authoritative, so no new op type
 *     and no fold change, and concurrent moves resolve last-writer-wins by HLC.
 *  2. **The output follows.** Re-running the moved analysis appends its block at the bottom, so
 *     without a reorder History would say "position 2" while Output said "last" — exactly the
 *     history-and-output-disagree failure the position-faithful replay exists to prevent.
 *  3. **The ordering rule is the same one everything else uses** — by data position, then by
 *     the order they were run — so Output, History and the script text cannot disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnalysisLog } from '../core/analysis-log.js';
import { ProjectLog } from '../core/project-log.js';
import { reorderRunBlocks } from '../core/results-pane.js';
import { PluginActions } from '../core/plugin-actions.js';

const bus = { emit() {}, on() { return () => {}; } };
const freshLog = () => new AnalysisLog(bus, new ProjectLog());

// =============================================================================
// 1. The position
// =============================================================================

test('repositioning rewrites `at` without adding or losing a run', () => {
  const log = freshLog();
  log.record({ pluginId: 'p', run: 'run', label: 'Frequencies', inputs: {}, at: 3 });
  const { runId } = log.entries()[0];

  const moved = log.reposition(runId, 1);
  assert.equal(moved.at, 1);
  assert.equal(log.count, 1, 'a move is not a second analysis');
  assert.equal(log.entries()[0].at, 1);
  assert.equal(log.entries()[0].runId, runId, 'identity survives, so its output stays its own');
  // Everything else about the run is carried over untouched.
  assert.equal(log.entries()[0].label, 'Frequencies');
  assert.deepEqual(log.entries()[0].inputs, {});
});

test('a move is expressed as ops, so it survives a save and reload', () => {
  // The whole point of doing this log-natively rather than mutating an array: toJSON is the
  // raw op stream, and replaying it has to land on the moved position.
  const log = freshLog();
  log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 4 });
  const { runId } = log.entries()[0];
  log.reposition(runId, 0);

  const reloaded = freshLog();
  reloaded.load(log.toJSON());
  assert.equal(reloaded.count, 1);
  assert.equal(reloaded.entries()[0].at, 0);
  assert.equal(reloaded.entries()[0].runId, runId);
});

test('repositioning clamps, ignores a no-op, and refuses an unknown run', () => {
  const log = freshLog();
  log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 2 });
  const { runId } = log.entries()[0];

  assert.equal(log.reposition(runId, -5).at, 0, 'a negative position is 0, not a broken prefix');
  assert.equal(log.reposition(runId, 2.7).at, 2, 'a position is a whole number of transforms');
  const before = log.toJSON().length;
  log.reposition(runId, 2); // already there
  assert.equal(log.toJSON().length, before, 'a move to where it already is writes nothing');
  assert.equal(log.reposition('no-such-run', 1), null);
});

test('a removed analysis cannot be moved back into existence', () => {
  const log = freshLog();
  log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 1 });
  const { runId } = log.entries()[0];
  log.remove(0);
  assert.equal(log.count, 0);
  assert.equal(log.reposition(runId, 0), null);
  assert.equal(log.count, 0, 're-appending a payload for a deleted run would resurrect it');
});

// =============================================================================
// 2. The output order
// =============================================================================

/** An output model: two run-owned groups with a transform's note between them. */
const MODEL = [
  { kind: 'text', tag: 'op1' },
  { kind: 'section', runId: 'A' },
  { kind: 'table', runId: 'A' },
  { kind: 'text', tag: 'op2' },
  { kind: 'section', runId: 'B' },
  { kind: 'table', runId: 'B' },
];

const shape = (m) => m.map((b) => b.runId || `[${b.tag}]`).join(' ');

test('run groups swap slots; everything else stays where it is', () => {
  // A transform's confirmation line is anchored to the data step around it, not to an
  // analysis, so it must not travel with the reorder.
  assert.equal(shape(reorderRunBlocks(MODEL, ['B', 'A'])), '[op1] B B [op2] A A');
});

test('an order that matches leaves the model identical', () => {
  const out = reorderRunBlocks(MODEL, ['A', 'B']);
  assert.deepEqual(out, MODEL);
});

test('nothing is ever dropped', () => {
  // The property that matters most: losing a block loses a user's result. Every input block
  // comes out, whatever the order says — including runs the caller did not mention.
  for (const order of [['B', 'A'], ['A'], ['B'], [], ['ghost', 'B', 'A'], ['A', 'B', 'ghost']]) {
    const out = reorderRunBlocks(MODEL, order);
    assert.equal(out.length, MODEL.length, `lost a block for ${JSON.stringify(order)}`);
    for (const b of MODEL) assert.ok(out.includes(b), `missing ${JSON.stringify(b)}`);
  }
});

test('a model with one run or no runs is returned untouched', () => {
  const one = [{ kind: 'section', runId: 'A' }, { kind: 'text', tag: 't' }];
  assert.deepEqual(reorderRunBlocks(one, ['A']), one);
  const none = [{ kind: 'text' }, { kind: 'text', tag: 't' }];
  assert.deepEqual(reorderRunBlocks(none, ['A']), none);
  assert.deepEqual(reorderRunBlocks([], ['A']), []);
});

test('three runs reorder as a whole, not pairwise', () => {
  const m = [
    { kind: 'section', runId: 'A' },
    { kind: 'section', runId: 'B' },
    { kind: 'section', runId: 'C' },
  ];
  assert.equal(shape(reorderRunBlocks(m, ['C', 'A', 'B'])), 'C A B');
});

// =============================================================================
// 3. The whole operation, through the real PluginActions
// =============================================================================

/**
 * The sequence that makes a move honest: rebuild the data to the new prefix, run JUST this
 * analysis there, put the data back, then reorder the output. Driven through the real
 * `repositionAnalysis` with fakes for the pieces it only pokes.
 */
function harness(transforms = ['t1', 't2', 't3']) {
  const rebuilds = [];
  const invoked = [];
  const reorders = [];
  const removed = [];
  const log = freshLog();
  const actions = new PluginActions({
    loader: {
      setActiveInputs() {},
      clearActiveInputs() {},
      invoke: async (pluginId) => { invoked.push({ pluginId, atRebuild: rebuilds.at(-1) }); },
    },
    results: {
      clear() {},
      beginAnalysis() {},
      endAnalysis() {},
      appendText() {},
      appendError(m) { throw new Error(`unexpected failure: ${m}`); },
      getModel: () => [],
      assignRun() {},
      removeRun: (id) => removed.push(id),
      reorderRuns: (order) => reorders.push(order),
    },
    bus: { emit() {}, on() { return () => {}; } },
    analysisLog: log,
    dataStore: {
      getTransforms: () => transforms,
      replaceTransforms: async (t) => { rebuilds.push(t.length); },
    },
  });
  return { actions, log, rebuilds, invoked, reorders, removed };
}

test('moving an analysis rebuilds to the new position, re-runs it, and restores the data', async () => {
  const h = harness();
  h.log.record({ pluginId: 'builtin-frequencies', run: 'run', label: 'Freq', inputs: {}, at: 3 });
  const { runId } = h.log.entries()[0];

  assert.equal(await h.actions.repositionAnalysis(runId, 1), true);
  assert.equal(h.log.entries()[0].at, 1);
  // Rebuilt to the 1-transform prefix, then back to all three. Leaving the dataset rewound
  // would be a far worse bug than a wrong table.
  assert.deepEqual(h.rebuilds, [1, 3]);
  // And it ran AT that prefix, not against the final data.
  assert.deepEqual(h.invoked, [{ pluginId: 'builtin-frequencies', atRebuild: 1 }]);
});

test('the stale output is dropped first and the new order applied after', async () => {
  const h = harness();
  h.log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 0 });
  h.log.record({ pluginId: 'p', run: 'run', label: 'B', inputs: {}, at: 3 });
  const b = h.log.entries()[1].runId;

  await h.actions.repositionAnalysis(b, 0);
  // Removed before re-running: if the run fails, an empty slot is honest; the old block left
  // in place would claim a result for a position it never ran at.
  assert.deepEqual(h.removed, [b]);
  // Both analyses now sit at 0, so order falls back to the order they were run.
  assert.equal(h.reorders.length, 1);
  assert.deepEqual(h.reorders[0], h.log.entries().map((e) => e.runId));
});

test('the data is restored even when the analysis throws', async () => {
  const h = harness();
  h.log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 3 });
  const { runId } = h.log.entries()[0];
  // A plugin that fails at the new position (its variable may not exist there yet) must not
  // leave the grid rewound to a prefix.
  h.actions = new PluginActions({
    loader: { setActiveInputs() {}, clearActiveInputs() {}, invoke: async () => { throw new Error('boom'); } },
    results: {
      clear() {}, beginAnalysis() {}, endAnalysis() {}, appendText() {}, appendError() {},
      getModel: () => [], assignRun() {}, removeRun() {}, reorderRuns() {},
    },
    bus: { emit() {}, on() { return () => {}; } },
    analysisLog: h.log,
    dataStore: { getTransforms: () => ['t1', 't2', 't3'], replaceTransforms: async (t) => { h.rebuilds.push(t.length); } },
  });
  await h.actions.repositionAnalysis(runId, 0);
  assert.deepEqual(h.rebuilds, [0, 3], 'the final rebuild has to happen in a finally');
});

test('an unknown run, or no move at all, changes nothing', async () => {
  const h = harness();
  h.log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 2 });
  assert.equal(await h.actions.repositionAnalysis('nope', 0), false);
  assert.deepEqual(h.rebuilds, [], 'a missing run must not rebuild the dataset');
  assert.deepEqual(h.invoked, []);
});

test('the position is clamped to the transforms that exist', async () => {
  const h = harness(['t1', 't2']);
  h.log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {}, at: 0 });
  const { runId } = h.log.entries()[0];
  await h.actions.repositionAnalysis(runId, 99);
  assert.equal(h.log.entries()[0].at, 2, 'past the end is the end, not a broken prefix');
});
