/**
 * @file diagnostic-charts.test.mjs
 * The last baked SVG plots move to the host chart layer (#131 follow-up).
 *
 * Three plots were still drawn *inside R* with `svglite` and appended as finished pictures:
 * regression's **Residuals vs Fitted** and **Normal Q–Q**, and assumption checks' per-variable
 * **Q–Q plot**. A baked picture is the one output shape the app cannot do anything with — no
 * palette, no live controls, no re-editing, and no getting at the numbers behind it — and it
 * cost every user an `svglite` download that the offline cache dutifully pre-fetched.
 *
 * What is worth guarding here, in order of how badly it would hurt to get wrong:
 *
 *  1. **The guide line is a `reference`, not a `trend`.** These two look alike in a diff and
 *     say different things. A trend is a *finding* — red, and printed with its equation and
 *     R². A reference is what the plot *means*: zero residual, the normal line. So it is grey,
 *     dashed, and carries no equation, because printing `Y = 0 + 1(X)` beside a Q–Q plot
 *     states a tautology. Both default to on when the model supplies them, and each has its
 *     own switch, so neither can turn the other on or off.
 *  2. **The line goes behind the points.** A guide painted over the data hides the outliers
 *     that are the entire reason for looking at a residual plot. (It did, in the first draft.)
 *  3. **Each variable's Q–Q plot gets its own points.** The assumption plugin returns every
 *     variable's points in ONE concatenated vector with an index column, because R's per-column
 *     results are ragged and would not survive the flat marshalling. An off-by-one in the split
 *     would silently plot the wrong variable's distribution under the right variable's name —
 *     wrong in a way no number on the screen would contradict.
 *  4. **Nothing baked is left.** A regression on the guard, not the behaviour: the moment a
 *     plot goes back to `appendPlot(svgstring(...))` it stops being re-editable and the
 *     `svglite` download comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; builtin-charts does. Register the real ones locally.
await import('./chart-kinds-harness.mjs');

const { defaultView, chartUiSpec, renderChart } = await import('../core/chart-renderer.js');
const { run: regression } = await import('../plugins/builtin-regression/index.js');
const { normality } = await import('../plugins/builtin-assumptions/index.js');

// =============================================================================
// The scatter kind's reference line
// =============================================================================

const SCATTER = (extra) => ({
  kind: 'scatter',
  title: 'd',
  points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }],
  axes: { x: { title: 'x' }, y: { title: 'y' } },
  ...extra,
});

test('a reference line is on by default, and is its own switch', () => {
  // On by default is the point: a Q–Q plot with no normal line has nothing to compare
  // against, and a residual plot with no zero line has no zero.
  const ref = defaultView(SCATTER({ reference: { slope: 0, intercept: 0, label: 'Zero line' } }));
  assert.equal(ref.referenceLine, true);
  assert.equal(ref.trendLine, false, 'a reference must not switch the trend line on with it');

  // And the two are independent: a plot may carry both, one, or neither.
  const both = defaultView(SCATTER({
    reference: { slope: 0, intercept: 0 }, trend: { slope: 1, intercept: 0, r2: 0.9 },
  }));
  assert.equal(both.referenceLine, true);
  assert.equal(both.trendLine, true);
});

test('the reference line is named in its own control, so it can be turned off', () => {
  const model = SCATTER({ reference: { slope: 0, intercept: 0, label: 'Zero line' } });
  const ctl = chartUiSpec(model).controls.find((c) => c.id === 'referenceLine');
  assert.ok(ctl, 'a line that cannot be switched off is not a control');
  assert.equal(ctl.label, 'Zero line', 'the label says what the line IS, not "reference line"');
  assert.equal(ctl.type, 'check');
  assert.equal(ctl.default, true);
  assert.ok(ctl.group, 'every control declares a group (chart-groups.test.mjs)');
});

test('a scatter with no reference is untouched — no control, no line', () => {
  // The existing correlation/scatter output must render exactly as it did.
  const plain = SCATTER({});
  assert.equal(defaultView(plain).referenceLine, false);
  assert.equal(chartUiSpec(plain).controls.some((c) => c.id === 'referenceLine'), false);
  const svg = renderChart(plain, defaultView(plain));
  assert.equal(svg.includes('stroke-dasharray="5 4"'), false, 'no dashed guide appeared');
});

test('the reference line draws, and stops drawing when unchecked', () => {
  const model = SCATTER({ reference: { slope: 0, intercept: 0, label: 'Zero line' } });
  const on = renderChart(model, defaultView(model));
  assert.ok(on.includes('stroke-dasharray="5 4"'), 'the guide is dashed, like qqline was');
  const off = renderChart(model, { ...defaultView(model), referenceLine: false });
  assert.equal(off.includes('stroke-dasharray="5 4"'), false);
});

test('the reference line sits behind the points', () => {
  // Painted after the circles it would cover the outliers, which are the only reason anyone
  // opens a residual plot. SVG has no z-index: order IS the answer.
  const model = SCATTER({ reference: { slope: 1, intercept: 0, label: 'Normal line' } });
  const svg = renderChart(model, defaultView(model));
  const guide = svg.indexOf('stroke-dasharray="5 4"');
  const firstPoint = svg.indexOf('<circle');
  assert.ok(guide > -1 && firstPoint > -1, 'both the guide and the points are drawn');
  assert.ok(guide < firstPoint, 'the guide must be emitted before the first point');
});

test('a reference line prints no equation, where a trend line does', () => {
  const ref = SCATTER({ reference: { slope: 1, intercept: 0, label: 'Normal line' } });
  const refSvg = renderChart(ref, defaultView(ref));
  assert.equal(/Y\s*=/.test(refSvg), false, '“Y = 0 + 1(X)” on a Q–Q plot is a tautology');
  assert.equal(refSvg.includes('R²'), false);

  const trend = SCATTER({ trend: { slope: 1, intercept: 0, r2: 0.9 } });
  const trendSvg = renderChart(trend, { ...defaultView(trend), trendLine: true });
  assert.ok(/Y\s*=/.test(trendSvg), 'the trend line still reports itself — it is a finding');
});

test('a reference line with no usable slope is skipped rather than drawn at NaN', () => {
  // Fewer than 3 finite values: R sends back NA, and a line to NaN would blank the plot.
  const model = SCATTER({ reference: { slope: NaN, intercept: NaN, label: 'Normal line' } });
  assert.equal(renderChart(model, defaultView(model)).includes('stroke-dasharray="5 4"'), false);
});

// =============================================================================
// builtin-regression: the two diagnostics
// =============================================================================

/** An R list in the shape webR hands back. */
const rList = (obj) => ({
  names: Object.keys(obj),
  values: Object.values(obj).map((v) => ({ values: Array.isArray(v) ? v : [v] })),
});

/** Drive a plugin function with R stubbed out; collect what it appended. */
async function invoke(fn, inputs, result, meta = []) {
  const out = { charts: [], tables: [], texts: [], errors: [], plots: 0, rCode: '' };
  const app = {
    data: { getVariableMeta: async () => meta },
    webr: { run: async (code) => { out.rCode = code; return { result }; } },
    results: {
      appendChart: async (model) => { out.charts.push(model); },
      appendTable: async (t, o) => { out.tables.push({ ...t, caption: o?.caption ?? '' }); },
      appendText: async (s) => { out.texts.push(s); },
      appendError: async (s) => { out.errors.push(s); },
      appendPlot: async () => { out.plots += 1; },
    },
  };
  await fn(app, inputs);
  return out;
}

const REG_RESULT = rList({
  terms: ['(Intercept)', 'age'], estimate: [1, 2], se: [0.1, 0.2], t: [10, 10], p: [0.01, 0.02],
  ciLo: [0.8, 1.6], ciHi: [1.2, 2.4], vifNames: ['age'], vif: [NaN],
  r2: 0.5, adjr2: 0.45, fstat: 100, fdf1: 1, fdf2: 8, fp: 0.001, n: 10,
  swW: 0.97, swP: 0.6, dw: 2.1, nInf: 0, maxCook: 0.2, thr: 0.4,
  fitted: [1, 2, 3, 4], resid: [0.5, -0.5, 0.25, -0.25],
  qqx: [-1.2, -0.4, 0.4, 1.2], qqy: [-0.5, -0.25, 0.25, 0.5], qqSlope: 0.6, qqInt: 0,
});

test('regression appends the two diagnostics as chart models, not pictures', async () => {
  const out = await invoke(regression, { dv: 'income', ivs: ['age'] }, REG_RESULT,
    [{ name: 'income', label: 'Income' }, { name: 'age', label: 'Age' }]);
  assert.equal(out.plots, 0, 'nothing may go through appendPlot any more');
  assert.deepEqual(out.charts.map((c) => c.title), ['Residuals vs Fitted', 'Normal Q–Q (residuals)']);
  assert.ok(out.charts.every((c) => c.kind === 'scatter'));
});

test('the residual plot pairs each fitted value with its own residual', async () => {
  const { charts } = await invoke(regression, { dv: 'y', ivs: ['x'] }, REG_RESULT);
  const resid = charts[0];
  assert.deepEqual(resid.points, [
    { x: 1, y: 0.5 }, { x: 2, y: -0.5 }, { x: 3, y: 0.25 }, { x: 4, y: -0.25 },
  ]);
  // Zero, not a fitted trend: a residual plot is read against y = 0.
  assert.deepEqual(resid.reference, { slope: 0, intercept: 0, label: 'Zero line' });
  assert.equal(resid.trend, undefined);
  assert.equal(resid.yTitle, 'Residuals');
});

test('the Q–Q plot carries the quartile line R computed, not a fitted one', async () => {
  const { charts } = await invoke(regression, { dv: 'y', ivs: ['x'] }, REG_RESULT);
  const qq = charts[1];
  assert.deepEqual(qq.points, [
    { x: -1.2, y: -0.5 }, { x: -0.4, y: -0.25 }, { x: 0.4, y: 0.25 }, { x: 1.2, y: 0.5 },
  ]);
  assert.deepEqual(qq.reference, { slope: 0.6, intercept: 0, label: 'Normal line' });
  assert.equal(qq.xTitle, 'Theoretical quantiles');
});

test('regression asks R for numbers and no longer asks it to draw', async () => {
  const { rCode } = await invoke(regression, { dv: 'y', ivs: ['x'] }, REG_RESULT);
  assert.ok(rCode.includes('plot.it = FALSE'), 'qqnorm must not open a device');
  for (const drawing of ['svgstring', 'library(svglite)', 'qqline(', 'abline(', 'dev.off()']) {
    assert.equal(rCode.includes(drawing), false, `R is still drawing: ${drawing}`);
  }
});

// =============================================================================
// builtin-assumptions: one Q–Q plot per variable, out of one concatenated vector
// =============================================================================

const META2 = [
  { name: 'income', label: 'Household income' },
  { name: 'age', label: 'Age in years' },
];

/** Two variables with DIFFERENT point counts — the case a ragged list could not express. */
const NORM_RESULT = rList({
  n: [3, 4], skew: [0.1, 0.2], kurt: [-0.5, 0.3], W: [0.95, 0.98], p: [0.4, 0.7],
  qqx: [-1, 0, 1, /* age: */ -1.2, -0.4, 0.4, 1.2],
  qqy: [10, 20, 30, /* age: */ 1, 2, 3, 4],
  qqi: [1, 1, 1, 2, 2, 2, 2],
  qqSlope: [10, 1.5], qqInt: [20, 2.5],
});

test('each variable gets its own Q–Q plot, named and populated from its own points', async () => {
  const out = await invoke(normality, { vars: ['income', 'age'] }, NORM_RESULT, META2);
  assert.equal(out.plots, 0);
  assert.deepEqual(out.charts.map((c) => c.title), [
    'Q–Q plot — Household income', 'Q–Q plot — Age in years',
  ]);
  // The split, which is the thing that could go wrong invisibly.
  assert.deepEqual(out.charts[0].points, [{ x: -1, y: 10 }, { x: 0, y: 20 }, { x: 1, y: 30 }]);
  assert.deepEqual(out.charts[1].points, [
    { x: -1.2, y: 1 }, { x: -0.4, y: 2 }, { x: 0.4, y: 3 }, { x: 1.2, y: 4 },
  ]);
  assert.deepEqual(out.charts[0].reference, { slope: 10, intercept: 20, label: 'Normal line' });
  assert.deepEqual(out.charts[1].reference, { slope: 1.5, intercept: 2.5, label: 'Normal line' });
});

test('a variable R could not plot is left out of the charts but stays in the table', async () => {
  // n < 3: R returns numeric(0) for its points, so the index vector simply never names it.
  // The Shapiro–Wilk row still has to appear, with its dashes — the absence of a plot is not
  // a reason to drop the variable from the output.
  const out = await invoke(normality, { vars: ['income', 'age'] }, rList({
    n: [2, 4], skew: [NaN, 0.2], kurt: [NaN, 0.3], W: [NaN, 0.98], p: [NaN, 0.7],
    qqx: [-1.2, -0.4, 0.4, 1.2], qqy: [1, 2, 3, 4], qqi: [2, 2, 2, 2],
    qqSlope: [NaN, 1.5], qqInt: [NaN, 2.5],
  }), META2);
  assert.deepEqual(out.charts.map((c) => c.title), ['Q–Q plot — Age in years']);
  assert.equal(out.tables[0].rows.length, 2, 'both variables are still reported');
  assert.equal(out.tables[0].rows[0][0], 'Household income');
});

test('no points at all is a quiet no-chart, not a crash', async () => {
  // Every variable under n = 3: R sends back NULL for the concatenated vectors.
  const out = await invoke(normality, { vars: ['income'] }, rList({
    n: [1], skew: [NaN], kurt: [NaN], W: [NaN], p: [NaN],
    qqSlope: [NaN], qqInt: [NaN],
  }), META2);
  assert.deepEqual(out.charts, []);
  assert.equal(out.tables.length, 1);
});

// =============================================================================
// The guard: nothing bakes a plot any more
// =============================================================================

test('neither plugin declares svglite or bakes an SVG', async () => {
  // Beyond tidiness: the offline cache pre-fetches the R packages of every ENABLED plugin, so
  // a stale `rPackages` entry is a download that every user pays for and nothing uses.
  const { readFileSync } = await import('node:fs');
  for (const id of ['builtin-regression', 'builtin-assumptions']) {
    const src = readFileSync(`plugins/${id}/index.js`, 'utf8');
    // Code, not prose — both files still explain in a comment WHY svglite is gone.
    for (const baked of ['library(svglite)', 'svgstring(', 'appendPlot(', 'stripSize(']) {
      assert.equal(src.includes(baked), false, `${id} still has ${baked}`);
    }
    const mod = await import(`../plugins/${id}/index.js`);
    assert.deepEqual(mod.manifest.rPackages, [], `${id} still declares R packages`);
  }
});
