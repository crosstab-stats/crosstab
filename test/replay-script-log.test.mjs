/**
 * @file replay-script-log.test.mjs
 * Regression: running a script that contains an analysis line must not throw.
 *
 * Reported (owner, 2026-09-25) from the real route — blank project, import data, import a
 * faculty `.do`, click Run: **"Cannot read properties of undefined (reading 'wall')"**,
 * while the output rendered correctly and the faculty member confirmed the numbers.
 *
 * Both halves of that description were the diagnosis. `'wall'` is an HLC field, and the
 * throw came from the LAST statement of `replayScript`: it called `AnalysisLog#load`,
 * which is the project-restore path and takes raw envelope ops, with the folded entry
 * list instead. `load` hands them to `receiveOps` → `hlc.receive(op.hlc)` → `undefined.wall`.
 * Everything before that line had already run, which is exactly why the output was right.
 *
 * It needed only ONE `run` line in the script to fire — `entries` is empty otherwise, and
 * an empty array through the same path throws nothing. So the do-file editor's Run was
 * broken for every script that analysed anything, and fine for every script that did not.
 *
 * These tests drive the real `PluginActions#replayScript` against fakes for the pieces it
 * only needs to poke (loader, results, bus, data store), and a REAL `AnalysisLog` over a
 * real `ProjectLog` — the HLC has to be genuine or the bug cannot reproduce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PluginActions } from '../core/plugin-actions.js';
import { AnalysisLog } from '../core/analysis-log.js';
import { ProjectLog } from '../core/project-log.js';

/** The pieces replayScript touches but this test does not care about. */
function harness() {
  const invoked = [];
  const rebuilds = [];
  const bus = { emit() {}, on() { return () => {}; } };
  const results = {
    cleared: 0,
    clear() { this.cleared += 1; },
    beginAnalysis() {},
    endAnalysis() {},
    appendText() {},
    appendError(msg) { throw new Error(`unexpected analysis failure: ${msg}`); },
    getModel: () => [],
    assignRun() {},
  };
  const loader = {
    setActiveInputs() {},
    clearActiveInputs() {},
    invoke: async (pluginId, fn, args) => { invoked.push({ pluginId, fn, args }); },
  };
  const dataStore = { replaceTransforms: async (t) => { rebuilds.push(t.length); } };
  const analysisLog = new AnalysisLog(bus, new ProjectLog());
  const actions = new PluginActions({ loader, menus: null, results, ui: null, bus, analysisLog, dataStore });
  // `analysisEntryFor` reads the live plugin registry; registering a plugin is a whole
  // other apparatus, and what is under test here is what replayScript does with the
  // entry, not how it is enriched.
  actions.analysisEntryFor = (a) => ({
    pluginId: a.pluginId,
    pluginName: 'Frequencies',
    origin: 'built-in',
    label: 'Frequencies…',
    run: a.run,
    specs: [],
    inputs: a.inputs || {},
  });
  return { actions, analysisLog, results, invoked, rebuilds };
}

const TRANSFORM = { kind: 'transform', op: { type: 'setVariable', name: 'q1', patch: { label: 'Party' } } };
const ANALYSIS = { kind: 'analysis', ref: { pluginId: 'builtin-frequencies', run: 'run', inputs: { vars: ['q1'] } } };

test('a script with an analysis line replays without throwing', async () => {
  const { actions, analysisLog, invoked } = harness();
  // The whole bug: this call threw "Cannot read properties of undefined (reading 'wall')".
  const { unknown } = await actions.replayScript([TRANSFORM, ANALYSIS]);
  assert.equal(unknown, 0);
  assert.equal(invoked.length, 1, 'the analysis should have been invoked');
  const entries = analysisLog.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].pluginId, 'builtin-frequencies');
  assert.deepEqual(entries[0].inputs, { vars: ['q1'] });
  // Positioned at the transform it followed, so the script round-trips in order.
  assert.equal(entries[0].at, 1);
  // Every logged run carries an identity (what output removal and merge key off).
  assert.ok(entries[0].runId, 'a replayed run needs a runId');
});

test('the log ends up holding exactly the script’s analyses, not the previous Run’s too', async () => {
  const { actions, analysisLog } = harness();
  // A Run that analysed something, then a Run of a script that analyses something else:
  // the first analysis must be gone, not sitting above the new one.
  analysisLog.record({ pluginId: 'builtin-descriptives', run: 'run', label: 'Descriptives…', inputs: { vars: ['age'] } });
  assert.equal(analysisLog.count, 1);
  await actions.replayScript([TRANSFORM, ANALYSIS]);
  const entries = analysisLog.entries();
  assert.deepEqual(entries.map((e) => e.pluginId), ['builtin-frequencies']);
});

test('a script with no analyses leaves an empty log and still rebuilds the data', async () => {
  // The case that always worked, and hid the bug: no entries, so nothing dereferenced.
  const { actions, analysisLog, rebuilds } = harness();
  const { unknown } = await actions.replayScript([TRANSFORM, TRANSFORM]);
  assert.equal(unknown, 0);
  assert.equal(analysisLog.count, 0);
  assert.deepEqual(rebuilds, [2], 'the full transform set is applied once, up front');
});

test('analyses run in script order and each is positioned at its own data state', async () => {
  const { actions, analysisLog, rebuilds } = harness();
  // analysis, transform, analysis — the second must see the extra transform, so the data
  // is rebuilt back to the first analysis's prefix and forward again.
  await actions.replayScript([ANALYSIS, TRANSFORM, ANALYSIS]);
  assert.deepEqual(analysisLog.entries().map((e) => e.at), [0, 1]);
  // 1 up-front apply (all transforms) + rebuild to the 0-transform prefix + back to final.
  assert.deepEqual(rebuilds, [1, 0, 1]);
});

test('an analysis line whose plugin is not active is counted, not fatal', async () => {
  const { actions, analysisLog } = harness();
  actions.analysisEntryFor = () => null; // no active plugin provides it
  const { unknown } = await actions.replayScript([TRANSFORM, ANALYSIS]);
  assert.equal(unknown, 1);
  assert.equal(analysisLog.count, 0);
});

test('AnalysisLog#load still takes RAW ops — the contract replayScript was violating', () => {
  const log = new AnalysisLog({ emit() {}, on() { return () => {}; } }, new ProjectLog());
  log.record({ pluginId: 'p', run: 'run', label: 'A', inputs: {} });
  const ops = log.toJSON();
  assert.ok(ops[0].hlc, 'toJSON must emit envelope ops carrying their HLC');
  // Round trip through load() is what project restore does, and it works.
  log.load(ops);
  assert.equal(log.count, 1);
  // Handing it folded entries is the mistake that caused the crash. Pinned so the two
  // shapes can never be confused again without a test saying so.
  assert.throws(() => log.load(log.entries()), /wall|hlc/i);
});
