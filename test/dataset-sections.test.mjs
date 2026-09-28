/**
 * @file dataset-sections.test.mjs
 * #179 step 1 — the script and its replay honour which dataset an analysis ran against.
 *
 * **The bug, stated plainly.** An analysis entry records `at` (how many transforms had been
 * applied when it ran) *and* `datasetId` (of which dataset). The one-true-log was never at
 * fault: one `ProjectLog`, data ops targeted `ds:<id>/…`, every live run stamped with its
 * dataset. Every *reader* ignored the second field:
 *
 *  - `serialize()` took the ACTIVE dataset's transforms and EVERY analysis, placing each by
 *    `at` alone — so in a two-dataset project one dataset's analyses were interleaved into the
 *    other's timeline by a number that measured something else.
 *  - `replayScript()` then applied all of it to the active dataset and re-ran every analysis
 *    against it. No error; the output simply described the wrong data.
 *  - `repositionAnalysis()` clamped `at` to the active dataset's transform count and rebuilt
 *    *that* dataset underneath an analysis belonging to another.
 *  - And `analysisEntryFor()` rebuilds an entry from a script line, which says nothing about
 *    data — while `#execute` stamps no provenance either (only the live run paths do). So a
 *    Syntax Run *dropped* `datasetId` from every analysis it replayed, which is the field
 *    `clearFor` uses to decide whose analyses a re-import invalidates.
 *
 * The fix is a `dataset "Name"` statement: one section per dataset, `at` read inside its own
 * section. Two properties are worth more than the rest and are tested first:
 *
 *  1. **A single-dataset project is byte-identical.** No statement is emitted, no behaviour
 *     changes, every existing script still round-trips. This is the overwhelmingly common case
 *     and it must pay nothing.
 *  2. **An unknown dataset name aborts before anything changes.** A script naming a dataset
 *     this project does not have is a typo or a script from elsewhere; running it against
 *     whatever happens to be in front of us is the failure mode this whole entry is about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, serialize, serializeProject } from '../core/crosstab-syntax.js';
import { PluginActions } from '../core/plugin-actions.js';

const T = (name) => ({ type: 'computeVar', name, varType: 'numeric', expr: '1' });
const DROP = (name) => ({ type: 'dropVars', names: [name] });
const run = (label, datasetId, at) => ({
  runId: `r-${label}`, pluginId: 'p', run: 'go', pluginName: 'P', origin: 'built-in',
  label, inputs: {}, specs: [], at, datasetId,
});

// =============================================================================
// Serializing
// =============================================================================

test('a single-dataset project serializes exactly as it always did', () => {
  // The back-compat guarantee: no `dataset` statement, byte-for-byte the old output.
  const applied = [T('z'), DROP('q9')];
  const analyses = [run('Frequencies', 7, 1)];
  const before = serialize(applied, analyses);
  assert.equal(serializeProject([{ id: 7, name: 'Survey', applied }], analyses), before);
  assert.equal(before.includes('dataset '), false, 'no heading for a project with one dataset');
});

test('each analysis is written under the dataset it actually ran against', () => {
  const text = serializeProject(
    [{ id: 1, name: 'Wave 1', applied: [T('z')] }, { id: 2, name: 'Wave 2', applied: [DROP('q9')] }],
    [run('Freq on W1', 1, 1), run('Xtab on W2', 2, 0)],
  );
  const lines = text.split('\n').filter(Boolean);
  const idx = (s) => lines.findIndex((l) => l.includes(s));
  assert.ok(idx('dataset "Wave 1"') < idx('Freq on W1'));
  assert.ok(idx('Freq on W1') < idx('dataset "Wave 2"'), 'W1’s analysis stays in W1’s section');
  assert.ok(idx('dataset "Wave 2"') < idx('Xtab on W2'));
});

test('`at` is read inside its own section, so position survives', () => {
  // Wave 2 has one transform and an analysis at 0 — BEFORE it. Placed by `at` against the
  // other dataset's longer transform list, it would have landed after everything.
  const text = serializeProject(
    [{ id: 1, name: 'W1', applied: [T('a'), T('b'), T('c')] }, { id: 2, name: 'W2', applied: [DROP('x')] }],
    [run('early', 2, 0)],
  );
  const w2 = text.slice(text.indexOf('dataset "W2"')).split('\n').filter(Boolean);
  assert.match(w2[1], /early/, 'the analysis comes before W2’s own transform');
  assert.match(w2[2], /^drop x/);
});

test('an analysis too old to know its dataset goes in the first section, not nowhere', () => {
  // Runs recorded before `datasetId` was tracked cannot be attributed, and dropping them from
  // the script would silently delete work on the next Run.
  const text = serializeProject(
    [{ id: 1, name: 'W1', applied: [] }, { id: 2, name: 'W2', applied: [] }],
    [run('legacy', null, 0), run('stranger', 99, 0)],
  );
  const first = text.indexOf('dataset "W1"');
  const second = text.indexOf('dataset "W2"');
  assert.ok(text.indexOf('legacy') > first && text.indexOf('legacy') < second);
  assert.ok(text.indexOf('stranger') > first && text.indexOf('stranger') < second,
    'an id this project no longer has is unattributable too');
});

// =============================================================================
// Parsing
// =============================================================================

test('the dataset statement parses quoted and bare, and refuses empty', () => {
  assert.deepEqual(parse('dataset "Wave 2"').steps, [{ kind: 'dataset', name: 'Wave 2', line: 1 }]);
  assert.deepEqual(parse('dataset Wave2').steps, [{ kind: 'dataset', name: 'Wave2', line: 1 }]);
  assert.match(parse('dataset').errors[0].message, /expected a dataset name/, 'a bare `dataset` is a mistake, and says so');
  assert.match(parse('dataset "" ').errors[0].message, /expected a dataset name/);
});

test('a multi-dataset script round-trips through parse', () => {
  const text = serializeProject(
    [{ id: 1, name: 'Wave 1', applied: [T('z')] }, { id: 2, name: 'Wave 2', applied: [DROP('q9')] }],
    [run('Freq', 1, 1)],
  );
  const { steps, errors } = parse(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.kind), ['dataset', 'transform', 'analysis', 'dataset', 'transform']);
  assert.equal(steps[0].name, 'Wave 1');
  assert.equal(steps[3].name, 'Wave 2');
});

// =============================================================================
// Replay — where the wrong data was actually analysed
// =============================================================================

/** A PluginActions wired to fakes, plus the log of what it did. */
function harness({ datasets, active }) {
  const seen = { transforms: [], executed: [], cleared: 0, activeAtExec: [] };
  const state = new Map(datasets.map((d) => [String(d.id), d.transforms ?? []]));
  let activeId = active ?? datasets[0].id;

  const dataStore = {
    list: () => datasets.map((d) => ({ id: d.id, name: d.name })),
    get activeId() { return activeId; },
    setActive: (id) => { activeId = id; },
    getTransforms: () => state.get(String(activeId)) ?? [],
    replaceTransforms: async (t) => {
      if (t.some((op) => op?.type === 'BAD')) throw new Error('bad data step');
      state.set(String(activeId), t.slice());
      seen.transforms.push({ dataset: activeId, count: t.length });
    },
  };
  const entries = [];
  const actions = new PluginActions({
    loader: { setActiveInputs() {}, invoke: async () => {}, clearActiveInputs() {} },
    menus: { register: () => () => {} },
    results: {
      clear: () => { seen.cleared += 1; },
      beginAnalysis() {}, endAnalysis() {}, appendError() {}, appendText() {},
      getModel: () => [], assignRun() {}, removeRun() {}, reorderRuns() {},
    },
    ui: {},
    bus: { emit() {} },
    importers: {}, exporters: {}, outputExporters: {},
    analysisLog: {
      entries: () => entries.slice(),
      clear: () => { entries.length = 0; },
      restore: (e) => entries.push(e),
      reposition: () => true,
    },
    dataStore,
  });
  // Stand in for plugin wiring: a script line becomes a replayable entry.
  actions.analysisEntryFor = (ref) => ({
    pluginId: ref.pluginId, run: ref.run, inputs: ref.inputs, label: ref.inputs?.tag ?? ref.run,
    pluginName: 'P', origin: 'built-in', specs: [],
  });
  const origExec = actions.constructor.prototype;
  void origExec;
  return {
    actions,
    seen,
    entries,
    state,
    get activeId() { return activeId; },
    /** Record what dataset was active as each analysis executed. */
    watch() {
      const inner = actions.analysisEntryFor.bind(actions);
      actions.analysisEntryFor = (ref) => {
        const e = inner(ref);
        seen.activeAtExec.push({ tag: e.label, dataset: activeId });
        return e;
      };
    },
  };
}

const SCRIPT_TWO = [
  'dataset "Wave 1"',
  'compute z = 1',
  'run p.go {"tag":"on-w1"}',
  'dataset "Wave 2"',
  'run p.go {"tag":"on-w2"}',
  'drop q9',
].join('\n');

test('each analysis runs against its own dataset, at its own position', async () => {
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 1 });
  h.watch();
  const { steps } = parse(SCRIPT_TWO);
  await h.actions.replayScript(steps);

  assert.deepEqual(h.seen.activeAtExec, [
    { tag: 'on-w1', dataset: 1 },
    { tag: 'on-w2', dataset: 2 },
  ], 'the pre-fix replay ran both against the active dataset');
  // Wave 1's analysis sits after its one transform; Wave 2's before its one transform.
  assert.deepEqual(h.entries.map((e) => [e.label, e.datasetId, e.at]), [
    ['on-w1', 1, 1],
    ['on-w2', 2, 0],
  ]);
});

test('a replayed analysis keeps its provenance instead of losing it', async () => {
  // `analysisEntryFor` knows nothing about data and `#execute` stamps nothing, so before this
  // every Syntax Run un-attributed the whole log — and `clearFor` reads that field.
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 1 });
  await h.actions.replayScript(parse(SCRIPT_TWO).steps);
  assert.ok(h.entries.every((e) => e.datasetId != null), 'no entry may come back unattributed');
});

test('each dataset is left holding its own transforms', async () => {
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 1 });
  await h.actions.replayScript(parse(SCRIPT_TWO).steps);
  assert.deepEqual(h.state.get('1').map((o) => o.type), ['computeVar']);
  assert.deepEqual(h.state.get('2').map((o) => o.type), ['dropVars']);
});

test('the user’s dataset tab is put back where they left it', async () => {
  // The script says what to run, not what the user should be looking at afterwards.
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 1 });
  await h.actions.replayScript(parse(SCRIPT_TWO).steps);
  assert.equal(h.activeId, 1);
});

test('steps before the first dataset statement belong to the active dataset', async () => {
  // Which is what makes every script written before this statement existed still correct.
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 2 });
  await h.actions.replayScript(parse('compute z = 1\nrun p.go {"tag":"implicit"}').steps);
  assert.deepEqual(h.entries.map((e) => [e.label, e.datasetId]), [['implicit', 2]]);
  assert.deepEqual(h.state.get('2').map((o) => o.type), ['computeVar']);
});

test('re-entering a dataset continues its section rather than restarting the count', async () => {
  const h = harness({ datasets: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], active: 1 });
  const { steps } = parse([
    'dataset "A"', 'compute a = 1',
    'dataset "B"', 'compute b = 1',
    'dataset "A"', 'compute a2 = 1', 'run p.go {"tag":"late"}',
  ].join('\n'));
  await h.actions.replayScript(steps);
  // Two transforms of A precede it — not one, which is what a fresh section would have said.
  assert.deepEqual(h.entries.map((e) => [e.label, e.datasetId, e.at]), [['late', 1, 2]]);
  assert.deepEqual(h.state.get('1').map((o) => o.name), ['a', 'a2']);
});

test('an unknown dataset name aborts before anything is applied or cleared', async () => {
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }], active: 1 });
  await assert.rejects(
    () => h.actions.replayScript(parse('dataset "Wave 9"\ncompute z = 1').steps),
    /Wave 9.*not open/s,
  );
  assert.equal(h.seen.cleared, 0, 'the previous output must still be on screen');
  assert.deepEqual(h.seen.transforms, [], 'and no data touched');
});

test('the error names the datasets that DO exist', async () => {
  // Opened from a text editor, where "no such dataset" leaves the reader guessing at spelling.
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }, { id: 2, name: 'Wave 2' }], active: 1 });
  await assert.rejects(
    () => h.actions.replayScript(parse('dataset "wave 3"').steps),
    /"Wave 1", "Wave 2"/,
  );
});

test('a dataset name matches case-insensitively when there is no exact hit', async () => {
  const h = harness({ datasets: [{ id: 1, name: 'Wave 1' }], active: 1 });
  await h.actions.replayScript(parse('dataset "wave 1"\nrun p.go {"tag":"x"}').steps);
  assert.deepEqual(h.entries.map((e) => e.datasetId), [1]);
});

test('a bad data step in the SECOND section still aborts before any output is cleared', async () => {
  // The atomicity promise: every section's transforms are applied before the output pane is
  // touched, so a failure anywhere leaves the previous results standing.
  const h = harness({ datasets: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], active: 1 });
  h.actions.analysisEntryFor = () => null;
  const steps = [
    { kind: 'dataset', name: 'A' }, { kind: 'transform', op: T('ok') },
    { kind: 'dataset', name: 'B' }, { kind: 'transform', op: { type: 'BAD' } },
  ];
  await assert.rejects(() => h.actions.replayScript(steps), /bad data step/);
  assert.equal(h.seen.cleared, 0);
});
