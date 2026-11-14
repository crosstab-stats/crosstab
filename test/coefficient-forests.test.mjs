/**
 * @file coefficient-forests.test.mjs
 * One figure, thirteen models: the coefficient plot the whole regression family prints.
 *
 * ## Why one builder
 *
 * Every regression in this project ends the same way — a column of terms, an estimate
 * each, an interval — and none of them drew it. That made it the single most repeated
 * missing figure in the chart-coverage survey, and it is also the one most likely to be
 * implemented thirteen slightly different ways: with and without the intercept, against
 * zero or one, on a linear axis where a log one is needed.
 *
 * So `coefficientForest` makes those three decisions once and this file holds them to it,
 * per plugin, through the real exported functions.
 *
 * ## The three decisions
 *
 *  - the intercept is dropped, because it is not on the same footing as the slopes and
 *    its magnitude squashes every term that matters;
 *  - ratios (OR, HR, IRR, RRR) get a log axis and a reference at 1, differences get a
 *    linear axis and a reference at 0;
 *  - a term whose interval is missing keeps its point rather than vanishing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { coefficientForest } = globalThis.ctStd;

await import('./chart-kinds-harness.mjs');
const { renderChart, defaultView } = await import('../core/chart-renderer.js');
const draw = (m) => renderChart(m, { ...defaultView(m), ...(m.view || {}) });

const rList = (obj) => ({ names: Object.keys(obj), values: Object.values(obj) });

function fakeApp(result, variables = []) {
  const out = { tables: [], texts: [], charts: [], errors: [], rCode: '' };
  const run = async (code) => { out.rCode = code; return { result }; };
  return {
    out,
    data: { getVariableMeta: async () => variables },
    webr: {
      run,
      runOrThrow: async (code) => { out.rCode = code; return result; },
      installPackages: async () => {},
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, ...o }); },
      appendText: async (s) => { out.texts.push(s); },
      appendChart: async (m) => { out.charts.push(m); },
      appendError: async (e) => { out.errors.push(e); },
    },
  };
}

// =============================================================================
// The builder's own decisions
// =============================================================================

test('the intercept is dropped, and kept when asked', () => {
  const args = { terms: ['(Intercept)', 'age'], est: [40, 0.5], lo: [35, 0.2], hi: [45, 0.8], title: 't', xTitle: 'B' };
  assert.deepEqual(coefficientForest(args).studies.map((s) => s.label), ['age']);
  assert.deepEqual(
    coefficientForest({ ...args, keepIntercept: true }).studies.map((s) => s.label),
    ['(Intercept)', 'age'],
  );
  // The spellings a model can hand back for the same row.
  for (const name of ['(Intercept)', 'Intercept', '(intercept)', 'const', 'Constant']) {
    assert.equal(coefficientForest({ ...args, terms: [name, 'age'] }).studies.length, 1, name);
  }
});

test('ratios get a log axis and a null at one; differences do not', () => {
  const base = { terms: ['age'], est: [1.4], lo: [1.1], hi: [1.8], title: 't', xTitle: 'x' };
  const ratio = coefficientForest({ ...base, ratio: true });
  assert.equal(ratio.refLine, 1);
  assert.equal(ratio.view.logScale, true);
  const diff = coefficientForest(base);
  assert.equal(diff.refLine, 0);
  assert.equal(diff.view, undefined);
});

test('a term with no interval keeps its point', () => {
  // A missing CI is a gap in the bar, not a reason to hide that the term was fitted.
  const m = coefficientForest({ terms: ['a', 'b'], est: [1, 2], lo: [0.5], hi: [1.5], title: 't', xTitle: 'x' });
  assert.equal(m.studies.length, 2);
  assert.ok(Number.isNaN(m.studies[1].lo));
  assert.match(draw(m), /<svg/);
});

test('a model with nothing left to draw returns null rather than an empty frame', () => {
  assert.equal(coefficientForest({ terms: ['(Intercept)'], est: [3], title: 't', xTitle: 'x' }), null);
  assert.equal(coefficientForest({ terms: [], est: [], title: 't', xTitle: 'x' }), null);
});

// =============================================================================
// Per plugin, through the real function
// =============================================================================

const COEF = { terms: ['(Intercept)', 'age', 'sex'], est: [40, 0.5, -2], se: [2, 0.15, 0.8] };
// builtin-regression maps its own field names through normalizeResult.
const REG = { ...COEF, estimate: COEF.est };

test('linear regression draws its coefficients', async () => {
  const { run } = await import('../plugins/builtin-regression/index.js');
  const app = fakeApp(rList({
    ...REG, t: [20, 3.3, -2.5], p: [0, 0.001, 0.013],
    ciLo: [36, 0.2, -3.6], ciHi: [44, 0.8, -0.4],
    r: [0.6], r2: [0.36], adjR2: [0.35], sigma: [5], n: [200],
    ssReg: [100], ssRes: [180], dfReg: [2], dfResid: [197], fstat: [55], fp: [0],
    vifTerms: [], vif: [], dw: [1.9], bpP: [0.3], swP: [0.2],
    fitted: [], resid: [], std: [], leverage: [], cook: [],
  }), [{ name: 'pay', label: 'Pay' }]);
  await run(app, { dv: 'pay', ivs: ['age', 'sex'], plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest, 'no forest emitted');
  assert.deepEqual(forest.studies.map((s) => s.label), ['age', 'sex']);
  assert.equal(forest.refLine, 0);
});

test('the count models draw incidence-rate ratios on a log axis', async () => {
  const { poisson } = await import('../plugins/builtin-countmodels/index.js');
  const app = fakeApp(rList({
    ...COEF, z: [20, 3.3, -2.5], p: [0, 0.001, 0.013],
    lo: [3.5, 0.2, -3.6], hi: [4.2, 0.8, -0.4], dispersion: [1.1], n: [300], theta: [NaN],
  }), [{ name: 'visits', label: 'Visits' }]);
  await poisson(app, { dv: 'visits', ivs: ['age', 'sex'], plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.equal(forest.refLine, 1);
  assert.equal(forest.view.logScale, true);
  // exp() was applied: the estimate is a ratio, not a log-count.
  assert.ok(forest.studies[0].est > 1 && forest.studies[0].est < 2);
});

test('the Cox model draws hazard ratios', async () => {
  const { cox } = await import('../plugins/builtin-survival/index.js');
  const app = fakeApp(rList({
    terms: ['age', 'sex'], coef: [0.04, -0.3], hr: [1.04, 0.74], se: [0.01, 0.1],
    z: [4, -3], p: [0, 0.003], lo: [1.02, 0.61], hi: [1.06, 0.9],
    n: [500], nevent: [120], concordance: [0.68], lrChi: [20], lrDf: [2], lrP: [0],
    waldChi: [19], waldDf: [2], waldP: [0], scoreChi: [20], scoreDf: [2], scoreP: [0],
    eventLevel: ['1'], zphTerm: [], zphChi: [], zphDf: [], zphP: [],
  }), [{ name: 'months', label: 'Months' }, { name: 'dead', label: 'Status' }]);
  await cox(app, { time: 'months', status: 'dead', event: '1', preds: ['age', 'sex'], plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.equal(forest.refLine, 1);
  assert.deepEqual(forest.studies.map((s) => s.est), [1.04, 0.74]);
});

test('marginal effects keep every row, intercept included', async () => {
  // dy/dx has no intercept to drop — every row IS an effect, so dropping one by its name
  // would silently lose a predictor literally called "const" in someone's data.
  const { margins } = await import('../plugins/builtin-margins/index.js');
  // builtin-margins names this field `term`, singular.
  const app = fakeApp(rList({
    term: ['age', 'sex'], est: [0.01, -0.08], se: [0.003, 0.02],
    z: [3.3, -4], p: [0.001, 0], lo: [0.004, -0.12], hi: [0.016, -0.04],
    n: [400], pos: ['1'],
  }), [{ name: 'y', label: 'Outcome' }]);
  await margins(app, { dv: 'y', ivs: ['age', 'sex'], family: 'logit', kind: 'ame', plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.equal(forest.studies.length, 2);
  assert.equal(forest.refLine, 0);
});

test('the mixed model draws fixed effects and a caterpillar of the groups', async () => {
  const { linear } = await import('../plugins/builtin-multilevel/index.js');
  const app = fakeApp(rList({
    reLab: ['School A', 'School B', 'School C'], reEst: [1.2, -0.4, -0.9], reSe: [0.3, 0.3, 0.35],
    ...COEF, df: [100, 100, 100], t: [20, 3.3, -2.5], p: [0, 0.001, 0.013],
    reGrp: ['.g', 'Residual'], reTerm: ['(Intercept)', 'NA'], reVar: [1.5, 4], reSd: [1.2, 2],
    icc: [0.27], nobs: [900], ngrp: [3], aic: [100], bic: [120],
  }), [{ name: 'score', label: 'Score' }, { name: 'school', label: 'School' }]);
  await linear(app, { y: 'score', fixed: ['age', 'sex'], group: 'school', plots: ['coef', 're'] });
  const forests = app.out.charts.filter((c) => c.kind === 'forest');
  assert.equal(forests.length, 2);
  // The caterpillar is sorted, which is what makes it a caterpillar rather than a list.
  const cat = forests[1];
  assert.deepEqual(cat.studies.map((s) => s.label), ['School C', 'School B', 'School A']);
  assert.ok(cat.studies[0].est < cat.studies[2].est);
});

test('quantile regression draws a coefficient path with its band', async () => {
  const { quantile } = await import('../plugins/builtin-limdep/index.js');
  const app = fakeApp(rList({
    terms: ['(Intercept)', 'educ'], taus: [0.25, 0.5, 0.75],
    est: [10, 2, 12, 3, 15, 5], se: [1, 0.4, 1, 0.4, 1.2, 0.5],
    p: [0, 0.01, 0, 0.001, 0, 0], n: [800],
  }), [{ name: 'pay', label: 'Pay' }]);
  await quantile(app, { y: 'pay', ivs: ['educ'], taus: '0.25,0.5,0.75', plots: ['path'] });
  const band = app.out.charts.find((c) => c.kind === 'band');
  assert.ok(band, 'no band emitted');
  // One panel per predictor, intercept excluded, three points across the quantiles.
  assert.equal(app.out.charts.length, 1);
  assert.deepEqual(band.series[0].points.map((p) => p.x), [0.25, 0.5, 0.75]);
  assert.deepEqual(band.series[0].points.map((p) => p.y), [2, 3, 5]);
  assert.ok(band.series[0].points[0].lo < 2 && band.series[0].points[0].hi > 2);
  // Zero is the question the path is asked, so zero is on the chart.
  assert.ok(band.guides.some((g) => g.at === 0));
  assert.match(draw(band), /<svg/);
});

test('nothing is drawn unless it was ticked', async () => {
  const { run } = await import('../plugins/builtin-regression/index.js');
  const app = fakeApp(rList({
    ...REG, t: [20, 3.3, -2.5], p: [0, 0.001, 0.013], ciLo: [36, 0.2, -3.6], ciHi: [44, 0.8, -0.4],
    r: [0.6], r2: [0.36], adjR2: [0.35], sigma: [5], n: [200],
    ssReg: [100], ssRes: [180], dfReg: [2], dfResid: [197], fstat: [55], fp: [0],
    vifTerms: [], vif: [], dw: [1.9], bpP: [0.3], swP: [0.2],
    fitted: [], resid: [], std: [], leverage: [], cook: [],
  }), [{ name: 'pay', label: 'Pay' }]);
  await run(app, { dv: 'pay', ivs: ['age', 'sex'] });
  assert.equal(app.out.charts.filter((c) => c.kind === 'forest').length, 0);
});
