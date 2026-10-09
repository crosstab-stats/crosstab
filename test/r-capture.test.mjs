/**
 * @file r-capture.test.mjs
 * Recording the R each analysis actually ran, and folding it into the R export.
 *
 * ## Why the source is kept at all
 *
 * The owner's call, 2026-10-09: *"captured R in the project might actually be a good
 * thing. It strengthens the reproducibility a bit because now if someone opens a bundle
 * that used plugins they don't have the base R is right there for them to see during an
 * audit."*
 *
 * That is the load-bearing reason, and it is a stronger one than the export: a project
 * can outlive the plugin that produced its numbers, and until now a reader of such a
 * bundle saw a table, an attribution line, and nothing else. It is the same principle as
 * "output outlives its maker" — which this project already applies to how a result is
 * DRAWN — carried over to how it was COMPUTED.
 *
 * The export gets the other half of what was promised with it: the idiomatic line a tutor
 * would write, and the engine's own code recorded beneath it. Those two can legitimately
 * differ (frequency weights, Type III sums of squares), and where they do, the recorded
 * source is the only place a reader can find out why.
 *
 * ## What is checked here
 *
 *  1. The collector's caps — because this payload is PERSISTED, and an analysis is free
 *     to evaluate R in a loop.
 *  2. The sink discipline, so one analysis cannot swallow another's source.
 *  3. The carry: a live run persists it; a replay does not write it back.
 *  4. The export: it appears, it is commented, it survives having no idiomatic spelling
 *     (the audit case), and it is matched by identity rather than by position.
 *  5. The two bugs found while building this, so they stay fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureInto,
  capturing,
  collectR,
  noteR,
  R_CAPTURE_MAX_RUNS,
} from '../core/r-capture.js';
import { AnalysisLog } from '../core/analysis-log.js';
import { ProjectLog } from '../core/project-log.js';
import { PluginActions } from '../core/plugin-actions.js';
import { serialize } from '../core/crosstab-syntax.js';
import { scriptToR, scriptToStata } from '../core/script-export.js';

// =============================================================================
// 1. The collector and its caps
// =============================================================================

test('nothing is collected unless someone is collecting', () => {
  assert.equal(capturing(), false);
  noteR('this should go nowhere'); // must not throw with no sink open
  const c = collectR();
  assert.equal(capturing(), true);
  c.dispose();
  assert.equal(capturing(), false, 'disposing closes the sink, so later runs are not attributed');
});

test('an analysis that never touched R leaves no field behind', () => {
  const c = collectR();
  c.dispose();
  assert.equal(c.take(), null, 'a charting plugin must not stamp an empty rSource on its entry');
});

test('every evaluation of one analysis is kept, in order', () => {
  const c = collectR();
  noteR('library(nlme)');
  noteR('fit <- lme(y ~ x, random = ~1 | id)');
  c.dispose();
  const got = c.take();
  assert.deepEqual(got.runs, ['library(nlme)', 'fit <- lme(y ~ x, random = ~1 | id)']);
  assert.equal(got.dropped, 0);
});

test('a runaway number of evaluations is capped, and says how many it dropped', () => {
  // A bootstrap calling webr.run per resample would otherwise write a thousand copies of
  // the same model into the saved project. Truncating is fine; truncating silently is not.
  const c = collectR();
  for (let i = 0; i < R_CAPTURE_MAX_RUNS + 7; i += 1) noteR(`run ${i}`);
  c.dispose();
  const got = c.take();
  assert.equal(got.runs.length, R_CAPTURE_MAX_RUNS);
  assert.equal(got.dropped, 7);
});

test('a single enormous evaluation is dropped rather than bloating the log', () => {
  const c = collectR();
  noteR('small <- 1');
  noteR('x'.repeat(40000));
  c.dispose();
  const got = c.take();
  assert.deepEqual(got.runs, ['small <- 1']);
  assert.equal(got.dropped, 1);
});

test('a sink that throws cannot take the analysis down with it', () => {
  const dispose = captureInto(() => { throw new Error('sink exploded'); });
  assert.doesNotThrow(() => noteR('summary(fit)'), 'recording provenance must never fail a run');
  dispose();
});

test('a stale disposer cannot close an outer sink', () => {
  // The discipline that matters: if an inner capture forgets to dispose, or disposes late,
  // it must not leave the outer analysis collecting — or stop it collecting.
  const outer = collectR();
  const inner = collectR();
  noteR('inner only');
  inner.dispose();
  noteR('outer only');
  outer.dispose();
  assert.deepEqual(inner.take().runs, ['inner only']);
  assert.deepEqual(outer.take().runs, ['outer only'], 'the outer sink resumed when the inner closed');
  // Disposing the inner one again is a no-op, not a reopening.
  inner.dispose();
  assert.equal(capturing(), false);
});

// =============================================================================
// 2. The carry — through the real runner, at a real entry point
// =============================================================================

const bus = { emit() {}, on() { return () => {}; } };

/** `runHost` is the entry point behind Transform ▸ Run R script…; it shares `#execute`
 * with every plugin analysis, which is the seam the capture is installed on. */
function harness(runner) {
  const log = new AnalysisLog(bus, new ProjectLog());
  const errors = [];
  const actions = new PluginActions({
    loader: { setActiveInputs() {}, clearActiveInputs() {}, invoke: async () => {} },
    results: {
      clear() {}, beginAnalysis() {}, endAnalysis() {}, appendText() {},
      appendError(m) { errors.push(m); },
      getModel: () => [], assignRun() {}, removeRun() {}, reorderRuns() {},
    },
    bus,
    analysisLog: log,
    dataStore: { getTransforms: () => [], replaceTransforms: async () => {} },
  });
  actions.registerHost('probe', runner);
  return { actions, log, errors };
}

test('a live run records the R it evaluated, on the log entry', async () => {
  const h = harness(async () => {
    noteR('# df <- the active dataset, columns: age\nx <- df[["age"]]\nmean(x, na.rm = TRUE)');
  });
  const { ok } = await h.actions.runHost({ host: 'probe', label: 'Probe', inputs: {} });
  assert.equal(ok, true);
  const [entry] = h.log.entries();
  assert.ok(Array.isArray(entry.rSource), 'the entry carries the source');
  assert.match(entry.rSource[0], /mean\(x, na\.rm = TRUE\)/);
  assert.equal(entry.rSourceDropped, undefined, 'nothing was dropped, so no field');
});

test('it survives the log — which is the whole point of persisting it', async () => {
  const h = harness(async () => { noteR('t.test(a, b, paired = TRUE)'); });
  await h.actions.runHost({ host: 'probe', label: 'Probe', inputs: {} });
  // Round-trip through the project log exactly as saving and reopening does.
  const reloaded = new AnalysisLog(bus, new ProjectLog());
  reloaded.load(h.log.toJSON());
  assert.match(reloaded.entries()[0].rSource[0], /paired = TRUE/);
});

test('a failed run records nothing, because it is not recorded at all', async () => {
  const h = harness(async () => {
    noteR('fit <- aov(y ~ g)');
    throw new Error('R said no');
  });
  const { ok } = await h.actions.runHost({ host: 'probe', label: 'Probe', inputs: {} });
  assert.equal(ok, false);
  assert.equal(h.log.count, 0);
  assert.equal(h.errors.length, 1);
});

test('a replay does not write the source back into the log', async () => {
  // Replays happen when a project is OPENED. Appending to the log on open is the clobber
  // this project has already been bitten by once, so a replay deliberately leaves the
  // recorded source alone — an older project simply has none, and the export says so by
  // omitting the block rather than by inventing one.
  const h = harness(async () => { noteR('chisq.test(tbl)'); });
  const old = { pluginId: 'p', run: 'run', label: 'Older project', inputs: {}, at: 0 };
  h.log.record(old);
  const before = h.log.entries()[0];
  assert.equal(before.rSource, undefined);

  await h.actions.replay({ ...before, host: 'probe' });
  assert.equal(h.log.entries()[0].rSource, undefined, 'the stored entry is untouched by a replay');
  assert.equal(h.log.count, 1, 'and a replay is not a second analysis');
});

// =============================================================================
// 3. The export
// =============================================================================

const ONEWAY = {
  runId: 'a1',
  pluginId: 'builtin-compare',
  run: 'oneway',
  label: 'One-way ANOVA…',
  pluginName: 'Compare Means',
  inputs: { y: ['prestg10'], g: ['degree'] },
  at: 0,
  rSource: [
    '# df <- the active dataset, columns: prestg10, degree\n'
      + 'y <- df[["prestg10"]]\n'
      + 'g <- df[["degree"]]\n'
      + 'fit <- aov(y ~ factor(g))',
  ],
};
const MYSTERY = {
  runId: 'a2',
  pluginId: 'thirdparty-mystery',
  run: 'go',
  label: 'Mystery Procedure',
  pluginName: 'Someone Else’s Plugin',
  inputs: { v: ['age'] },
  at: 0,
  rSource: ['y <- df[["age"]]\nquantile(y, probs = c(.1, .9), na.rm = TRUE)'],
};

const scriptFor = (entries) => serialize([{ type: 'load', name: 'gss' }], entries);
const exportR = (entries) => scriptToR(scriptFor(entries), { analyses: entries }).text;

test('the exact R lands under the idiomatic line, commented', () => {
  const out = exportR([ONEWAY]);
  const lines = out.split('\n');
  const idiom = lines.findIndex((l) => l.startsWith('fit <- aov(prestg10 ~ factor(degree)'));
  const exact = lines.findIndex((l) => l.includes('fit <- aov(y ~ factor(g))'));
  assert.ok(idiom > 0, 'the tutor-facing line is live code');
  assert.ok(exact > idiom, 'the recorded source sits beneath it');
  assert.ok(lines[exact].trimStart().startsWith('#'), 'and is commented — it binds data this file does not build');
  // The binding note travels with it, or the reader cannot tell what `y` was.
  assert.match(out, /#\s+# df <- the active dataset, columns: prestg10, degree/);
});

test('the file says once, at the top, that the commented R is not a second script', () => {
  const out = exportR([ONEWAY]);
  assert.match(out, /the R CrossTab actually ran, commented/);
  // And not at all when there is nothing recorded to explain.
  const plain = { ...ONEWAY, rSource: undefined };
  assert.doesNotMatch(exportR([plain]), /actually ran, commented/);
});

test('an analysis with no idiomatic spelling still exports what it ran', () => {
  // The audit case the owner described: a bundle whose results came from a plugin the
  // reader does not have. There is no `R_ANALYSES` row for it and there never will be,
  // so the recorded source is the only account of the result this file can give.
  const out = exportR([MYSTERY]);
  assert.match(out, /not translated/, 'the line itself cannot be translated');
  assert.match(out, /#\s+quantile\(y, probs = c\(\.1, \.9\), na\.rm = TRUE\)/);
});

test('the source is matched by identity, so an edited line does not borrow it', () => {
  // The Syntax editor can be hand-edited before exporting. A line whose inputs no longer
  // match the run that was recorded must lose the block: the stored R described the line
  // as it WAS, and showing it under a changed line would misattribute the result.
  const text = scriptFor([ONEWAY]).replace('"prestg10"', '"realinc"');
  const out = scriptToR(text, { analyses: [ONEWAY] }).text;
  assert.match(out, /fit <- aov\(realinc ~ factor\(degree\)/, 'the edited line still translates');
  assert.doesNotMatch(out, /fit <- aov\(y ~ factor\(g\)\)/, 'but not with the old run’s source under it');
});

test('two runs of the same analysis each get their own source', () => {
  const second = { ...ONEWAY, runId: 'a3', rSource: ['fit <- aov(y ~ factor(g))  # the second run'] };
  const out = exportR([ONEWAY, second]);
  assert.match(out, /fit <- aov\(y ~ factor\(g\)\)$/m);
  assert.match(out, /# the second run/);
});

test('a truncated record says so in the file', () => {
  const out = exportR([{ ...ONEWAY, rSourceDropped: 998 }]);
  assert.match(out, /998 further evaluation\(s\), past the record size cap/);
});

test('only the R dialect carries it — Stata and SPSS are a different promise', () => {
  // Those two exist so somebody can carry on in the tool they already use. A block of R
  // in a .do file is noise, and would not run there.
  const out = scriptToStata(scriptFor([ONEWAY])).text;
  assert.doesNotMatch(out, /aov\(y ~ factor\(g\)\)/);
});

// =============================================================================
// 4. The two bugs this work turned up
// =============================================================================

test('the run’s label finally prints as a heading', () => {
  // It never did. `analysisToLine` writes the label as a trailing comment and the parser
  // strips comments before handing the statement over, so `a.label` was always undefined
  // and the `# --- … ---` heading was dead code. The label comes off the log entry now.
  const out = exportR([ONEWAY]);
  assert.match(out, /^# --- One-way ANOVA ---$/m);
  assert.doesNotMatch(out, /One-way ANOVA…/, 'a menu label ends in an ellipsis; a heading should not');
});

test('a single-variable slot holding two variables bails instead of emitting `a,b`', () => {
  // `${i.y}` relied on a one-element array stringifying without its brackets. Two
  // variables produced `aov(a,b ~ …)`: a script that looks right and does not run, which
  // is the one outcome this exporter exists to avoid.
  const bad = { ...ONEWAY, rSource: undefined, inputs: { y: ['prestg10', 'realinc'], g: ['degree'] } };
  const out = exportR([bad]);
  assert.doesNotMatch(out, /aov\(prestg10,realinc/);
  assert.match(out, /one variable expected here, but the run carries 2/);
});

test('a variable name R cannot spell bare is refused, not mangled', () => {
  const bad = { ...ONEWAY, rSource: undefined, inputs: { y: ['my var'], g: ['degree'] } };
  assert.match(exportR([bad]), /not a valid R variable name/);
});
