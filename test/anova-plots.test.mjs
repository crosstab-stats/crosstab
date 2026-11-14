/**
 * @file anova-plots.test.mjs
 * The charts the ANOVA offers, and the one bug that found itself on the way there.
 *
 * ## What is tested, and why it is the function and not the helpers
 *
 * The chart MODELS are pure and could be checked on their own, but the thing that broke
 * here was not a model — it was `valueLabel`, called by the descriptives table and
 * defined nowhere in the plugin (since 38aa2a2, the Type III rewrite). `node --check`
 * cannot see an undefined identifier, no test imported the module, and the failure landed
 * AFTER the R had run, so a Factorial ANOVA burned its whole computation and then threw.
 *
 * So these tests run the real `factorial` and `repeated` against a fake `app`: a canned R
 * result in the shape `unpackR` expects, and recorders for the output verbs. That is the
 * shallowest harness that would have caught it, and it exercises every line the GUI does
 * except the R itself.
 *
 * What it does NOT cover: whether R returns what the canned result claims. That needs
 * WebR and is the job of the validation scripts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { factorial, repeated, cellChartModel, pairsForestModel, unflattenColumns, subjectRows, bucketRaw } =
  await import('../plugins/builtin-anova/index.js');

/** An R list as the bridge delivers it: parallel names/values, vectors as bare arrays. */
const rList = (obj) => ({ names: Object.keys(obj), values: Object.values(obj) });

/** Two factors, 2x2, four cells of three observations each. */
function factorialResult({ raw = [], cellIdx = [], tukey = {} } = {}) {
  return rList({
    terms: ['F1', 'F2', 'F1:F2'],
    ss: [12, 8, 2],
    df: [1, 1, 1],
    F: [6, 4, 1],
    p: [0.02, 0.05, 0.33],
    ssRes: [16],
    dfRes: [8],
    ssTot: [38],
    n: [12],
    levF: [1.1],
    levP: [0.4],
    levDf1: [3],
    levDf2: [8],
    fModel: [3.7],
    pModel: [0.06],
    cellName: ['1.1', '2.1', '1.2', '2.2'],
    cellMean: [10, 14, 11, 20],
    cellSD: [1, 1.2, 1.1, 1.4],
    cellN: [3, 3, 3, 3],
    grandMean: [13.75],
    grandSD: [4.1],
    rawY: raw,
    rawCell: cellIdx,
    tkFac: tukey.fac ?? [],
    tkA: tukey.a ?? [],
    tkB: tukey.b ?? [],
    tkDiff: tukey.diff ?? [],
    tkLo: tukey.lo ?? [],
    tkHi: tukey.hi ?? [],
  });
}

function repeatedResult({ flat = [], pairs = {} } = {}) {
  return rList({
    means: [10, 12, 15],
    sds: [2, 2.2, 2.4],
    n: [4],
    k: [3],
    ssCond: [52],
    dfCond: [2],
    msCond: [26],
    F: [9],
    p: [0.01],
    ssRes: [17],
    dfRes: [6],
    msRes: [2.8],
    mauW: [NaN],
    mauChi: [NaN],
    mauDf: [NaN],
    mauP: [NaN],
    ggE: [NaN],
    hfE: [NaN],
    lbE: [NaN],
    ggP: [NaN],
    hfP: [NaN],
    lbP: [NaN],
    rawFlat: flat,
    pdI: pairs.i ?? [],
    pdJ: pairs.j ?? [],
    pdDiff: pairs.diff ?? [],
    pdLo: pairs.lo ?? [],
    pdHi: pairs.hi ?? [],
    pdLevel: pairs.level ?? [NaN],
  });
}

/** A fake host: records what the plugin writes, and hands back a canned R result. */
function fakeApp(result, variables) {
  const out = { tables: [], texts: [], charts: [], errors: [], rCode: '' };
  return {
    out,
    data: { getVariableMeta: async () => variables },
    webr: {
      run: async (code) => {
        out.rCode = code;
        return { result };
      },
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, ...o }); },
      appendText: async (s) => { out.texts.push(s); },
      appendChart: async (m) => { out.charts.push(m); },
      appendError: async (e) => { out.errors.push(e); },
    },
  };
}

const VARS = [
  { name: 'pay', label: 'Annual pay' },
  { name: 'deg', label: 'Degree', valueLabels: { 1: 'Bachelor’s', 2: 'Master’s' } },
  { name: 'sex', label: 'Sex', valueLabels: { 1: 'Women', 2: 'Men' } },
];

// =============================================================================
// The bug that was already there
// =============================================================================

test('a factorial ANOVA completes — valueLabel is defined', async () => {
  // The regression test for `valueLabel is not defined`: before the fix this threw
  // while building the FIRST table, with the R already spent.
  const app = fakeApp(factorialResult(), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'] });
  assert.deepEqual(app.out.errors, []);
  assert.equal(app.out.tables.length, 3); // descriptives, Levene, effects
});

test('cell rows carry value LABELS, not codes', async () => {
  const app = fakeApp(factorialResult(), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'] });
  const rows = app.out.tables[0].rows.map((r) => r[0]);
  assert.ok(rows.includes('Bachelor’s × Women'), `got ${JSON.stringify(rows)}`);
  assert.ok(rows.includes('Master’s × Men'), `got ${JSON.stringify(rows)}`);
});

// =============================================================================
// Nothing is drawn unless it was asked for
// =============================================================================

test('no plots input means no charts, and no chart data crosses the bridge', async () => {
  // Replay safety: an analysis recorded before this feature has no `plots` key, and it
  // must produce exactly what it produced then — including not paying to ship raw values.
  const app = fakeApp(factorialResult(), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'] });
  assert.equal(app.out.charts.length, 0);
  assert.doesNotMatch(app.out.rCode, /rawY <- d\$\.y/);
  assert.doesNotMatch(app.out.rCode, /TukeyHSD/);
});

test('ticking a plot is what puts its data in the R', async () => {
  const app = fakeApp(factorialResult(), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['means'] });
  assert.match(app.out.rCode, /rawY <- d\$\.y/);
  assert.doesNotMatch(app.out.rCode, /TukeyHSD/); // still not asked for
});

// =============================================================================
// The means / profile plot
// =============================================================================

const RAW = {
  raw: [9, 10, 11, 13, 14, 15, 10, 11, 12, 19, 20, 21],
  cellIdx: [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4],
};

test('the means plot is a categorical model with raw observations attached', async () => {
  const app = fakeApp(factorialResult(RAW), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['means'] });
  assert.equal(app.out.charts.length, 1);
  const m = app.out.charts[0];
  assert.equal(m.kind, 'categorical');
  assert.equal(m.view.mark, 'bar');
  // The default that matters: the question an ANOVA answers is about means, so the
  // interval around the mean is the default ruler — not the SD of individuals.
  assert.equal(m.view.errorBars, 'ci95');
  assert.deepEqual(m.categories.map((c) => c.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(m.series.map((s) => s.label), ['Women', 'Men']);
  assert.deepEqual(m.series[0].values, [10, 14]);
  assert.deepEqual(m.series[1].values, [11, 20]);
  // Raw values are what make the error bars adjustable rather than baked.
  assert.deepEqual(m.series[0].rawValues, [[9, 10, 11], [13, 14, 15]]);
  assert.deepEqual(m.series[1].rawValues, [[10, 11, 12], [19, 20, 21]]);
});

test('the profile plot is the same data, drawn as lines', async () => {
  const app = fakeApp(factorialResult(RAW), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['means', 'profile'] });
  assert.equal(app.out.charts.length, 2);
  assert.equal(app.out.charts[1].view.mark, 'line');
  assert.deepEqual(
    app.out.charts[1].series.map((s) => s.values),
    app.out.charts[0].series.map((s) => s.values),
  );
});

// =============================================================================
// The difference plot
// =============================================================================

test('Tukey contrasts become a forest plot with a zero reference line', async () => {
  const app = fakeApp(factorialResult({
    tukey: { fac: [1, 2], a: ['2', '2'], b: ['1', '1'], diff: [6.5, 4], lo: [2, -1], hi: [11, 9] },
  }), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['tukey'] });
  assert.equal(app.out.charts.length, 2); // one per factor
  const m = app.out.charts[0];
  assert.equal(m.kind, 'forest');
  assert.equal(m.refLine, 0);
  assert.equal(m.studies.length, 1);
  assert.equal(m.studies[0].label, 'Master’s − Bachelor’s');
  assert.deepEqual([m.studies[0].est, m.studies[0].lo, m.studies[0].hi], [6.5, 2, 11]);
  assert.equal(app.out.charts[1].studies[0].label, 'Men − Women');
  // ...and the note that says why this chart is the honest answer to "how much more".
  assert.ok(app.out.texts.some((t) => /overlap/.test(t)));
});

test('a factor whose contrasts failed is skipped, not drawn empty', async () => {
  const app = fakeApp(factorialResult({
    tukey: { fac: [1], a: ['2'], b: ['1'], diff: [6.5], lo: [2], hi: [11] },
  }), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['tukey'] });
  assert.equal(app.out.charts.length, 1);
});

// =============================================================================
// Repeated measures
// =============================================================================

const RM_VARS = [
  { name: 't1', label: 'Baseline' },
  { name: 't2', label: 'Week 6' },
  { name: 't3', label: 'Week 12' },
];
// Column-major, as R's unlist delivers a 4x3 frame.
const RM_FLAT = [9, 10, 11, 10, 11, 12, 13, 12, 14, 15, 16, 15];

test('condition means ride on the same categorical kind', async () => {
  const app = fakeApp(repeatedResult({ flat: RM_FLAT }), RM_VARS);
  await repeated(app, { vars: ['t1', 't2', 't3'], plots: ['means'] });
  const m = app.out.charts[0];
  assert.equal(m.kind, 'categorical');
  assert.deepEqual(m.categories.map((c) => c.label), ['Baseline', 'Week 6', 'Week 12']);
  assert.deepEqual(m.series[0].values, [10, 12, 15]);
  assert.deepEqual(m.series[0].rawValues[0], [9, 10, 11, 10]);
  assert.equal(m.view.errorBars, 'ci95');
  // The caveat is not optional: between-subject bars are the wrong ruler for a
  // within-subject comparison, and saying so is the difference between a chart that
  // informs and one that misleads.
  assert.ok(app.out.texts.some((t) => /within-subjects comparison/.test(t)));
});

test('subject lines reuse the before-after kind', async () => {
  const app = fakeApp(repeatedResult({ flat: RM_FLAT }), RM_VARS);
  await repeated(app, { vars: ['t1', 't2', 't3'], plots: ['subjects'] });
  const m = app.out.charts[0];
  assert.equal(m.kind, 'paired');
  assert.equal(m.subjects.length, 4);
  // Subject 1 is the FIRST row of each column, which in column-major order is every
  // 4th element: 9, 11, 14.
  assert.deepEqual(m.subjects[0].values, [9, 11, 14]);
  assert.deepEqual(m.subjects[3].values, [10, 12, 15]);
  assert.deepEqual(m.conditions.map((c) => c.label), ['Baseline', 'Week 6', 'Week 12']);
});

test('too many subjects says so instead of drawing a smear', async () => {
  const n = 400;
  const flat = Array.from({ length: n * 2 }, (_, i) => i);
  const res = repeatedResult({ flat });
  res.values[res.names.indexOf('n')] = [n];
  res.values[res.names.indexOf('k')] = [2];
  const app2 = fakeApp(res, RM_VARS.slice(0, 2));
  await repeated(app2, { vars: ['t1', 't2'], plots: ['subjects'] });
  assert.equal(app2.out.charts.length, 0);
  assert.ok(app2.out.texts.some((t) => /Per-subject lines skipped/.test(t)));
});

test('pairwise differences are Bonferroni-labelled in the heading', async () => {
  const app = fakeApp(repeatedResult({
    pairs: { i: [1, 1, 2], j: [2, 3, 3], diff: [2, 5, 3], lo: [0.5, 3, 1], hi: [3.5, 7, 5], level: [0.98333] },
  }), RM_VARS);
  await repeated(app, { vars: ['t1', 't2', 't3'], plots: ['diff'] });
  const m = app.out.charts[0];
  assert.equal(m.kind, 'forest');
  assert.equal(m.refLine, 0);
  assert.deepEqual(m.studies.map((s) => s.label), ['Week 6 − Baseline', 'Week 12 − Baseline', 'Week 12 − Week 6']);
  assert.match(m.valueHeading, /98\.3% CI/);
});

// =============================================================================
// The pure pieces
// =============================================================================

test('bucketRaw groups by R\'s 1-based cell index and drops non-finite values', () => {
  assert.deepEqual(bucketRaw([1, 2, 3, NaN], [1, 2, 1, 2], 2), [[1, 3], [2]]);
  assert.deepEqual(bucketRaw([1], [9], 2), [[], []]); // an index outside the cells
});

test('unflattenColumns and subjectRows are inverses of the frame', () => {
  const cols = unflattenColumns([1, 2, 3, 4, 5, 6], 3, 2);
  assert.deepEqual(cols, [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(subjectRows(cols), [[1, 4], [2, 5], [3, 6]]);
  assert.deepEqual(unflattenColumns([1, 2], 3, 2), []); // short vector: nothing, not junk
});

test('a one-factor call names its single series after the measure', () => {
  const m = cellChartModel({
    cells: ['1', '2'],
    means: [3, 4],
    labelFor: (fi, lvl) => `L${lvl}`,
    title: 't',
    xTitle: 'x',
    yTitle: 'Mean pay',
  });
  assert.equal(m.series.length, 1);
  assert.equal(m.series[0].label, 'Mean pay');
  assert.equal(m.view.legend, 'none');
  assert.ok(!('errorBars' in m.view), 'no raw values, so no error-bar default to promise');
});

test('a missing cell is a gap, not a zero', () => {
  // An empty cell in an unbalanced design must not read as "the mean here is 0".
  const m = cellChartModel({
    cells: ['1.1', '2.1', '1.2'],
    means: [10, 14, 11],
    raw: [[10], [14], [11]],
    labelFor: (fi, lvl) => `L${lvl}`,
    title: 't',
    xTitle: 'x',
    yTitle: 'y',
  });
  assert.deepEqual(m.series[1].values, [11, null]);
  assert.deepEqual(m.series[1].rawValues, [[11], []]);
});

test('pairsForestModel carries no pooled summary', () => {
  // Contrasts are not studies: a pooled diamond under them would be meaningless.
  const m = pairsForestModel({ pairs: [{ label: 'a − b', diff: 1, lo: 0, hi: 2 }], title: 't', xTitle: 'x', valueHeading: 'h' });
  assert.ok(!('summary' in m));
  assert.equal(m.studies[0].key, 'p0');
});

// =============================================================================
// The models actually render — through the real chart kinds, not a shape check
// =============================================================================

// Core ships no chart kinds; the builtin-charts plugin does. Register the real ones so
// these assertions drive the shipping renderer. A model that satisfies every shape test
// above and still draws nothing would be the failure worth catching.
await import('./chart-kinds-harness.mjs');
const { defaultView, renderChart } = await import('../core/chart-renderer.js');
const draw = (model) => renderChart(model, { ...defaultView(model), ...(model.view || {}) });

test('the means plot really draws bars AND error-bar whiskers', async () => {
  const app = fakeApp(factorialResult(RAW), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['means'] });
  const svg = draw(app.out.charts[0]);
  assert.match(svg, /<svg/);
  assert.ok((svg.match(/<rect/g) || []).length >= 4, 'four cells, four bars');
  // Three strokes per whisker (stem + two caps) x 4 cells. If rawValues ever stopped
  // reaching the renderer, the bars would still draw and only these would vanish.
  assert.ok((svg.match(/<line /g) || []).length >= 12, `error bars missing: ${svg.slice(0, 200)}`);
});

test('the profile plot draws polylines, not bars', async () => {
  const app = fakeApp(factorialResult(RAW), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['profile'] });
  const svg = draw(app.out.charts[0]);
  assert.match(svg, /<polyline/);
});

test('the difference plot draws its zero line', async () => {
  const app = fakeApp(factorialResult({
    tukey: { fac: [1], a: ['2'], b: ['1'], diff: [6.5], lo: [2], hi: [11] },
  }), VARS);
  await factorial(app, { dv: 'pay', facs: ['deg', 'sex'], plots: ['tukey'] });
  const svg = draw(app.out.charts[0]);
  assert.match(svg, /<svg/);
  assert.match(svg, /Master/); // the contrast is labelled in the figure
  assert.ok(!/Unsupported/.test(svg));
});

test('the before-after plot draws one polyline per subject', async () => {
  const app = fakeApp(repeatedResult({ flat: RM_FLAT }), RM_VARS);
  await repeated(app, { vars: ['t1', 't2', 't3'], plots: ['subjects'] });
  const svg = draw(app.out.charts[0]);
  assert.equal((svg.match(/<polyline/g) || []).length, 4, 'four subjects, four lines');
});
