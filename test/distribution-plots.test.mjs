/**
 * @file distribution-plots.test.mjs
 * The figures that ARE the argument: rank tests, resampling, and the ROC curve.
 *
 * Three families whose charts are not decoration on a result but the result itself —
 *
 *  - a rank test is a statement about distributions, so a bar of means beside it would
 *    contradict the test being run;
 *  - a bootstrap or permutation p-value is a claim about a sampling distribution the
 *    reader has never seen, and printing two bounds asks them to take its shape on trust;
 *  - a ROC curve is the standard discrimination figure, and it is drawable here only
 *    because the chance diagonal became a frame-level reference line.
 *
 * All of them run the real exported function against a canned R result and render what
 * comes out through the real chart kinds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');
const { renderChart, defaultView } = await import('../core/chart-renderer.js');
const draw = (m) => renderChart(m, { ...defaultView(m), ...(m.view || {}) });

const rList = (obj) => ({ names: Object.keys(obj), values: Object.values(obj) });

function fakeApp(result, variables = []) {
  const out = { tables: [], texts: [], charts: [], errors: [], rCode: '' };
  return {
    out,
    data: {
      getVariableMeta: async () => variables,
      // builtin-bootstrap hands the replicates back as a dataset as well, so you can
      // describe or plot them yourself; without this verb the run stops before its own
      // chart.
      create: async (spec) => { out.created = spec; return 'ds1'; },
    },
    webr: {
      run: async (code) => { out.rCode = code; return { result }; },
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

const VARS = [
  { name: 'pay', label: 'Annual pay' },
  { name: 'deg', label: 'Degree', valueLabels: { 1: 'Bachelor’s', 2: 'Master’s' } },
  { name: 't1', label: 'Before' },
  { name: 't2', label: 'After' },
];

// =============================================================================
// Rank tests
// =============================================================================

test('Mann-Whitney draws the distributions, not the means', async () => {
  const { mannWhitney } = await import('../plugins/builtin-nonparametric/index.js');
  const app = fakeApp(rList({
    levels: ['1', '2'], n: [4, 4], meanRank: [2.5, 6.5], sumRank: [10, 26],
    U: [0], W: [10], Z: [-2.31], p: [0.021], r: [0.82],
    rawY: [1, 2, 3, 4, 7, 8, 9, 10], rawG: [1, 1, 1, 1, 2, 2, 2, 2],
  }), VARS);
  await mannWhitney(app, { y: 'pay', g: 'deg', plots: ['dist'] });
  const box = app.out.charts[0];
  assert.equal(box.kind, 'box');
  assert.deepEqual(box.groups.map((g) => g.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(box.groups[1].values, [7, 8, 9, 10]);
  assert.match(draw(box), /<svg/);
});

test('Kruskal-Wallis draws one box per group, in the table\'s order', async () => {
  const { kruskal } = await import('../plugins/builtin-nonparametric/index.js');
  const app = fakeApp(rList({
    levels: ['1', '2'], n: [3, 3], meanRank: [2, 5], H: [3.86], df: [1], p: [0.049], eps2: [0.64],
    rawY: [1, 2, 3, 7, 8, 9], rawG: [1, 1, 1, 2, 2, 2],
  }), VARS);
  await kruskal(app, { y: 'pay', g: 'deg', plots: ['dist'] });
  assert.deepEqual(app.out.charts[0].groups.map((g) => g.label), ['Bachelor’s', 'Master’s']);
});

test('Wilcoxon draws the pairs and the signed differences against zero', async () => {
  const { wilcoxon } = await import('../plugins/builtin-nonparametric/index.js');
  const app = fakeApp(rList({
    nNeg: [1], nPos: [2], ties: [0], mrNeg: [1], mrPos: [2.5], srNeg: [1], srPos: [5],
    Z: [-1.07], p: [0.285], r: [0.62],
    rawX1: [1, 2, 3], rawX2: [2, 4, 2.5], rawD: [1, 2, -0.5],
  }), VARS);
  await wilcoxon(app, { x1: 't1', x2: 't2', plots: ['subjects', 'diff'] });
  const [pairs, hist] = app.out.charts;
  assert.equal(pairs.kind, 'paired');
  assert.deepEqual(pairs.subjects[0].values, [1, 2]);
  assert.equal(hist.kind, 'histogram');
  assert.ok(hist.guides.some((g) => g.at === 0));
  assert.ok(draw(hist).includes('No change'));
});

test('a rank test with no plots ticked ships no observations', async () => {
  const { mannWhitney } = await import('../plugins/builtin-nonparametric/index.js');
  const app = fakeApp(rList({
    levels: ['1', '2'], n: [2, 2], meanRank: [1.5, 3.5], sumRank: [3, 7],
    U: [0], W: [3], Z: [-1.5], p: [0.13], r: [0.7], rawY: [], rawG: [],
  }), VARS);
  await mannWhitney(app, { y: 'pay', g: 'deg' });
  assert.equal(app.out.charts.length, 0);
  assert.match(app.out.rCode, /rawY = numeric\(0\)/);
});

// =============================================================================
// Resampling — the distribution IS the argument
// =============================================================================

test('the bootstrap draws its sampling distribution with the interval marked', async () => {
  const { run } = await import('../plugins/builtin-bootstrap/index.js');
  const boot = Array.from({ length: 200 }, (_, i) => 10 + (i % 20) / 10);
  const app = fakeApp(rList({
    boot, observed: [11], se: [0.6], ci_lo: [9.9], ci_hi: [12.1], n: [50], reps: [200],
  }), VARS);
  await run(app, { x: 'pay', reps: 200, plots: ['dist'] });
  const hist = app.out.charts.find((c) => c.kind === 'histogram');
  assert.ok(hist, 'no distribution drawn');
  assert.equal(hist.values.length, 200);
  assert.deepEqual(hist.guides.map((g) => g.label), ['Observed', 'Lower', 'Upper']);
  const svg = draw(hist);
  assert.ok(svg.includes('Observed') && svg.includes('Lower') && svg.includes('Upper'));
});

test('the permutation test draws the null it counts against', async () => {
  const { permutation } = await import('../plugins/builtin-bootstrap/index.js');
  const perm = Array.from({ length: 300 }, (_, i) => ((i % 21) - 10) / 5);
  const app = fakeApp(rList({
    lv: ['1', '2'], n1: [20], n2: [20], m1: [10], m2: [12],
    obs: [2], p: [0.01], reps: [300], perm,
  }), VARS);
  await permutation(app, { y: 'pay', group: 'deg', plots: ['dist'] });
  const hist = app.out.charts.find((c) => c.kind === 'histogram');
  assert.ok(hist);
  assert.equal(hist.values.length, 300);
  // The observed difference, standing in the null distribution: everything beyond it is
  // the tail the p-value counts.
  assert.deepEqual(hist.guides, [{ axis: 'x', at: 2, label: 'Observed' }]);
  assert.ok(draw(hist).includes('Observed'));
});

test('bootstrap replicates are only shipped when a chart was asked for', async () => {
  const { bootStatistic } = await import('../plugins/builtin-bootstrap/index.js');
  const app = fakeApp(rList({ observed: [5], se: [1], lo: [3], hi: [7], n: [40], reps: [1000], boot: [] }), VARS);
  await bootStatistic(app, { x: 'pay', stat: 'median', reps: 1000 });
  assert.equal(app.out.charts.length, 0);
  assert.match(app.out.rCode, /boot = numeric\(0\)/);
});

// =============================================================================
// ROC — drawable only because the reference line became frame-level
// =============================================================================

test('logistic draws a ROC curve with the chance diagonal and its AUC', async () => {
  const { run } = await import('../plugins/builtin-logistic/index.js');
  const fpr = [0, 0, 0.2, 0.4, 0.6, 0.8, 1];
  const tpr = [0, 0.4, 0.7, 0.85, 0.95, 1, 1];
  const app = fakeApp(rList({
    terms: ['(Intercept)', 'age'], termVar: ['', 'age'], termLevel: ['', ''],
    estimate: [-1, 0.05], se: [0.4, 0.01], z: [-2.5, 5], p: [0.012, 0],
    expb: [0.37, 1.05], expbLo: [0.17, 1.03], expbHi: [0.8, 1.07],
    n: [400], nulldev: [500], resdev: [430], positive: ['1'], negative: ['0'],
    catVar: [], catRef: [],
    rocTpr: tpr, rocFpr: fpr, auc: [0.82],
  }), [{ name: 'hired', label: 'Hired', valueLabels: { 0: 'No', 1: 'Yes' } }, { name: 'age', label: 'Age' }]);
  await run(app, { dv: 'hired', ivs: ['age'], opts: ['roc', 'or'] });

  const roc = app.out.charts.find((c) => c.kind === 'steps');
  assert.ok(roc, 'no ROC curve');
  assert.equal(roc.series[0].points.length, fpr.length);
  // The diagonal is a REFERENCE — what the curve is read against — not a finding.
  assert.deepEqual(roc.reference, { slope: 1, intercept: 0, label: 'Chance' });
  assert.ok(roc.title.includes('0.82'));
  const svg = draw(roc);
  assert.match(svg, /stroke-dasharray="5 4"/);
  assert.ok(app.out.texts.some((t) => /AUC/.test(t)));

  // ...and the odds-ratio forest names its rows exactly as the table does.
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.equal(forest.refLine, 1);
  assert.deepEqual(forest.studies.map((s) => s.label), ['Age (age)']);
});

test('no ROC is computed unless it is ticked', async () => {
  const { run } = await import('../plugins/builtin-logistic/index.js');
  const app = fakeApp(rList({
    terms: ['(Intercept)'], termVar: [''], termLevel: [''],
    estimate: [-1], se: [0.4], z: [-2.5], p: [0.012],
    expb: [0.37], expbLo: [0.17], expbHi: [0.8],
    n: [400], nulldev: [500], resdev: [430], positive: ['1'], negative: ['0'],
    catVar: [], catRef: [],
  }), [{ name: 'hired', label: 'Hired' }, { name: 'age', label: 'Age' }]);
  await run(app, { dv: 'hired', ivs: ['age'] });
  assert.equal(app.out.charts.length, 0);
  assert.doesNotMatch(app.out.rCode, /rocTpr/);
});

// =============================================================================
// Epidemiology
// =============================================================================

test('the 2x2 effect measures become a forest on a log axis', async () => {
  const { run } = await import('../plugins/builtin-epi/index.js');
  const app = fakeApp(rList({
    a: [30], b: [70], c: [15], d: [85], n: [200],
    expPos: ['1'], expNeg: ['0'], outPos: ['1'], outNeg: ['0'],
  }), [
    { name: 'smoke', label: 'Smoker', valueLabels: { 0: 'No', 1: 'Yes' } },
    { name: 'ill', label: 'Illness', valueLabels: { 0: 'No', 1: 'Yes' } },
  ]);
  await run(app, { exposure: 'smoke', outcome: 'ill', expPos: '1', outPos: '1', plots: ['forest'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest, 'no forest emitted');
  assert.deepEqual(forest.studies.map((s) => s.label), ['Risk ratio (RR)', 'Odds ratio (OR)']);
  assert.equal(forest.refLine, 1);
  assert.equal(forest.view.logScale, true);
  // RR and OR of the same 2x2: the OR is the more extreme of the two for a common
  // outcome, which is exactly what putting them on one axis shows.
  assert.ok(forest.studies[1].est > forest.studies[0].est);
});
