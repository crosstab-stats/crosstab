/**
 * @file dataset-rename-refs.test.mjs
 * #179 follow-up — renaming a dataset re-points the analyses that name it.
 *
 * Qualified variable references resolve by dataset NAME (`Wave 2:income`), so a rename left
 * saved analyses pointing at something that no longer existed: the next Syntax Run failed,
 * loudly and correctly, but still failed. The owner's call was that a rename is rare enough to
 * pay for: *"could we have the dataset rename trigger a scan through the history looking for
 * steps that use the old name and update them? Obviously the OneTrueLog being write-only means
 * these will appear in that as 'edit step foo to baz'."*
 *
 * Which is exactly how it is done, and the append-only part is the half worth testing. One fresh
 * `runAnalysis` per affected analysis — the same mechanism `reposition` already uses — so the
 * re-pointing IS part of the history rather than an edit hiding behind it, it merges
 * last-writer-wins by HLC like any other op, and the old spelling stays recoverable.
 *
 * Three things could go quietly wrong, and each has a test:
 *
 *  1. **A text input rewritten.** A chart title reading "Wave 2: results" is prose, not a
 *     reference. Rewriting it would corrupt output on a rename.
 *  2. **An unaffected analysis re-appended anyway.** Every project would then grow an op per
 *     analysis on every rename, for nothing.
 *  3. **The hook not firing from the verb.** Three call sites rename a dataset; if re-pointing
 *     were a thing callers opt into, two of them would forget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AnalysisLog } from '../core/analysis-log.js';
import { DatasetManager } from '../core/dataset-manager.js';
import { ProjectLog } from '../core/project-log.js';
import { retargetRefs } from '../core/var-ref.js';

const SPECS = [{ name: 'vars', kind: 'variables' }, { name: 'title', kind: 'text' }];
const entry = (runId, inputs) => ({
  runId, pluginId: 'p', run: 'go', pluginName: 'P', origin: 'built-in',
  label: runId, specs: SPECS, inputs, at: 0, datasetId: 1,
});

/** A log holding one spanning analysis and one ordinary one. */
function logWith() {
  const log = new AnalysisLog(null, new ProjectLog());
  log.record(entry('spanning', { vars: ['age', 'Wave 2:income'], title: 'Wave 2: results' }));
  log.record(entry('local', { vars: ['age'], title: 'plain' }));
  return log;
}

// =============================================================================
// The rewrite
// =============================================================================

test('a rename re-points the references that name the old dataset', () => {
  const log = logWith();
  assert.equal(log.retargetDataset('Wave 2', 'Follow-up'), 1);
  const found = log.entries().find((e) => e.runId === 'spanning');
  assert.deepEqual(found.inputs.vars, ['age', 'Follow-up:income']);
});

test('prose is left alone', () => {
  // The failure that would have been invisible until someone read their own output.
  const log = logWith();
  log.retargetDataset('Wave 2', 'Follow-up');
  assert.equal(log.entries().find((e) => e.runId === 'spanning').inputs.title, 'Wave 2: results');
});

test('an analysis that never named it is not touched', () => {
  const log = logWith();
  const before = log.toJSON().length;
  log.retargetDataset('Wave 2', 'Follow-up');
  // One new op, not two: the local analysis is not re-appended for nothing.
  assert.equal(log.toJSON().length, before + 1);
  assert.deepEqual(log.entries().find((e) => e.runId === 'local').inputs.vars, ['age']);
});

test('a rename that changes nothing appends nothing', () => {
  const log = logWith();
  const before = log.toJSON().length;
  assert.equal(log.retargetDataset('Wave 2', 'Wave 2'), 0);
  assert.equal(log.retargetDataset('', 'x'), 0);
  assert.equal(log.retargetDataset('Nobody', 'x'), 0);
  assert.equal(log.toJSON().length, before);
});

test('the rewrite is append-only, and the fold still shows one entry per run', () => {
  // The whole point of doing it this way: the history gains a visible "re-pointed" op rather
  // than a mutation, and the projection keeps taking the newest op per runId.
  const log = logWith();
  const before = log.toJSON().length;
  log.retargetDataset('Wave 2', 'Follow-up');
  const after = log.toJSON();
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].type, 'runAnalysis');
  assert.equal(after[after.length - 1].payload.runId, 'spanning');
  assert.equal(log.entries().length, 2, 'no duplicate run in the folded list');
});

test('re-pointing does not change the numbers or the position', () => {
  // Only the spelling of where the data came from. `at`, `datasetId` and the run's identity all
  // survive, so nothing needs re-running and the script keeps its place.
  const log = logWith();
  const was = log.entries().find((e) => e.runId === 'spanning');
  log.retargetDataset('Wave 2', 'Follow-up');
  const now = log.entries().find((e) => e.runId === 'spanning');
  assert.equal(now.at, was.at);
  assert.equal(now.datasetId, was.datasetId);
  assert.equal(now.label, was.label);
});

test('a second rename re-points again, from the name it now has', () => {
  const log = logWith();
  log.retargetDataset('Wave 2', 'Follow-up');
  assert.equal(log.retargetDataset('Follow-up', 'Wave 3'), 1);
  assert.deepEqual(log.entries().find((e) => e.runId === 'spanning').inputs.vars, ['age', 'Wave 3:income']);
  // ...and the old name no longer matches anything.
  assert.equal(log.retargetDataset('Wave 2', 'Wave 4'), 0);
});

test('a case-only rename still restamps the references', () => {
  // Resolution is case-insensitive, so these would keep working — but the stored reference
  // should read the way the dataset now spells itself.
  const log = new AnalysisLog(null, new ProjectLog());
  log.record(entry('r', { vars: ['wave 2:income'] }));
  assert.equal(log.retargetDataset('Wave 2', 'WAVE 2'), 1);
  assert.deepEqual(log.entries()[0].inputs.vars, ['WAVE 2:income']);
});

test('retargetRefs refuses to guess without specs', () => {
  // An entry with no declared inputs (a host action) has no variable inputs to rewrite, and
  // scanning every value would be how a title gets mangled.
  assert.equal(retargetRefs({ vars: ['Wave 2:x'] }, [], 'Wave 2', 'W3'), null);
  assert.equal(retargetRefs({ vars: ['Wave 2:x'] }, undefined, 'Wave 2', 'W3'), null);
});

// =============================================================================
// Firing from the verb
// =============================================================================

test('the rename verb itself fires the hook, with both names', () => {
  const m = new DatasetManager({ emit() {}, on() {} }, {}, new ProjectLog());
  m.add('Wave 2', { activate: true });
  const seen = [];
  m.onRenamed((id, from, to) => seen.push([from, to]));
  m.rename(m.activeId, 'Follow-up');
  assert.deepEqual(seen, [['Wave 2', 'Follow-up']]);
  assert.deepEqual(m.list().map((d) => d.name), ['Follow-up']);
});

test('a no-op rename fires nothing', () => {
  const m = new DatasetManager({ emit() {}, on() {} }, {}, new ProjectLog());
  m.add('Wave 2', { activate: true });
  let n = 0;
  m.onRenamed(() => { n += 1; });
  m.rename(m.activeId, 'Wave 2');
  assert.equal(n, 0);
});

test('a hook that throws does not undo the rename the user asked for', () => {
  const m = new DatasetManager({ emit() {}, on() {} }, {}, new ProjectLog());
  m.add('Wave 2', { activate: true });
  m.onRenamed(() => { throw new Error('boom'); });
  let second = false;
  m.onRenamed(() => { second = true; });
  m.rename(m.activeId, 'Follow-up');
  assert.deepEqual(m.list().map((d) => d.name), ['Follow-up']);
  assert.ok(second, 'one failing consequence must not cancel the others');
});

test('the disposer removes the hook', () => {
  const m = new DatasetManager({ emit() {}, on() {} }, {}, new ProjectLog());
  m.add('A', { activate: true });
  let n = 0;
  const off = m.onRenamed(() => { n += 1; });
  off();
  m.rename(m.activeId, 'B');
  assert.equal(n, 0);
});

test('boot wires the hook once, not each rename site', () => {
  // Three places rename a dataset (the sidebar, the launcher, an import that names its own).
  // Re-pointing is a consequence of the verb, so it is wired where the log is built.
  const app = readFileSync(new URL('../core/app.js', import.meta.url), 'utf8');
  assert.match(app, /datasets\.onRenamed\(\(id, from, to\) => \{/);
  assert.match(app, /analysisLog\.retargetDataset\(from, to\)/);
});

// =============================================================================
// The output that NAMES a dataset
// =============================================================================

/**
 * The owner spotted this the moment the rewrite landed: *"if the output generated that title
 * based on the dataset name automatically, then wouldn't renaming the dataset generate a state
 * where the output identified a source that doesn't exist? Or worse, if the user renames Wave2
 * to Wave1 and then Wave3 to Wave2, wouldn't the non-renamed chart 'Wave2: results' now be
 * implying a data source that is not the actual source?"*
 *
 * Both, and the second is the argument. A dangling reference is a puzzle; a confidently wrong
 * one is a false record — the reader has no way to know the name has moved.
 *
 * Only one place in the host writes a dataset name into output: the cross-dataset note. It is
 * not a finding — it is the host saying which datasets a run read — so it is the host's to keep
 * true. A plugin's output stays what it was ([[output-outlives-its-maker]]).
 */
test('the cross-dataset note is tagged to its run, so it can be restated', () => {
  const src = readFileSync(new URL('../core/plugin-actions.js', import.meta.url), 'utf8');
  assert.match(src, /appendText\(text, \{ tag: PluginActions\.#spanTag\(e\.runId\) \}\)/);
  assert.match(src, /refreshSpanNotes\(\)/);
});

test('restating reads the CURRENT inputs, so a re-pointed run gets the new name', async () => {
  // The whole chain in one: rename → inputs re-pointed → note rebuilt from them.
  const { PluginActions } = await import('../core/plugin-actions.js');
  const log = new AnalysisLog(null, new ProjectLog());
  log.record(entry('spanning', { vars: ['age', 'Wave 2:income'] }));

  const written = [];
  const actions = new PluginActions({
    loader: {}, menus: { register: () => () => {} },
    results: {
      appendText: (t, o) => written.push({ t, tag: o?.tag }),
      updateTextByTag: (tag, t) => { written.push({ t, tag, update: true }); return true; },
    },
    ui: {}, bus: { emit() {} }, importers: {}, exporters: {}, outputExporters: {},
    analysisLog: log,
    dataStore: {
      list: () => [{ id: 1, name: 'Wave 1', rowCount: 1200, active: true }, { id: 2, name: 'Follow-up', rowCount: 1540 }],
      activeId: 1,
    },
  });

  log.retargetDataset('Wave 2', 'Follow-up');
  assert.equal(actions.refreshSpanNotes(), 1);
  const note = written.find((w) => w.update);
  assert.match(note.t, /Follow-up \(1,540 rows\)/, 'the new name, with its live row count');
  assert.equal(note.t.includes('Wave 2'), false, 'and no trace of the old one');
  assert.equal(note.tag, 'span:spanning');
});

test('a single-dataset analysis has no note to restate', async () => {
  const { PluginActions } = await import('../core/plugin-actions.js');
  const log = new AnalysisLog(null, new ProjectLog());
  log.record(entry('local', { vars: ['age'] }));
  const actions = new PluginActions({
    loader: {}, menus: { register: () => () => {} },
    results: { appendText() {}, updateTextByTag: () => true },
    ui: {}, bus: { emit() {} }, importers: {}, exporters: {}, outputExporters: {},
    analysisLog: log,
    dataStore: { list: () => [{ id: 1, name: 'Wave 1', rowCount: 10, active: true }], activeId: 1 },
  });
  assert.equal(actions.refreshSpanNotes(), 0);
});

test('updateTextByTag is for host text, and is not on the plugin surface', async () => {
  // A plugin must not gain an "edit my past output" verb: its output is the artefact of a run.
  const broker = readFileSync(new URL('../core/plugin-broker.js', import.meta.url), 'utf8');
  assert.equal(broker.includes('updateTextByTag'), false);
});
