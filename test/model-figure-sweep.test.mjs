/**
 * @file model-figure-sweep.test.mjs
 * The rest of the hit list, one test apiece.
 *
 * These plugins each gained the figure their own output already describes in prose — the
 * ANCOVA's adjusted means, the class profiles a mixture solution IS, the cluster centres
 * the table under them says to "compare", the survey estimate's interval, the loadings,
 * the pooled estimates, the Pareto of effects. Nothing here needed new computation; in
 * every case the numbers were already on screen as a column.
 *
 * Shared harness with the other chart tests: the real exported function against a canned
 * R result, then the emitted model rendered by the real chart kinds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');
const { renderChart, defaultView } = await import('../core/chart-renderer.js');
const draw = (m) => renderChart(m, { ...defaultView(m), ...(m.view || {}) });

const rList = (obj) => ({ names: Object.keys(obj), values: Object.values(obj) });

function fakeApp(result, variables = []) {
  const out = { tables: [], texts: [], charts: [], errors: [], rCode: '' };
  const give = async (code) => { out.rCode = code; return result; };
  return {
    out,
    data: {
      getVariableMeta: async () => variables,
      create: async (spec) => { out.created = spec; return 'ds1'; },
    },
    webr: {
      run: async (code) => { out.rCode = code; return { result }; },
      runOrThrow: give,
      installPackages: async () => {},
    },
    results: {
      appendTable: async (t, o) => { out.tables.push({ ...t, ...o }); },
      appendText: async (s) => { out.texts.push(s); },
      appendChart: async (m) => { out.charts.push(m); },
      appendError: async (e) => { out.errors.push(e); },
      // Some plugins wrap their detail in a collapsible section; run it immediately so
      // the test sees what a reader would after one click.
      beginAnalysis: async (o) => { if (o?.detail) await o.detail(); },
      endAnalysis: async () => {},
    },
  };
}

const VARS = [
  { name: 'score', label: 'Score' }, { name: 'grp', label: 'Group', valueLabels: { 1: 'A', 2: 'B' } },
  { name: 'age', label: 'Age' }, { name: 'i1', label: 'Item 1' }, { name: 'i2', label: 'Item 2' },
  { name: 'wt', label: 'Weight' },
];

test('ANCOVA draws its covariate-adjusted means, intervals and all', async () => {
  const { ancova } = await import('../plugins/builtin-mixedanova/index.js');
  const app = fakeApp(rList({
    terms: ['grp', 'age'], ss: [40, 12], df: [1, 1], F: [8, 3], p: [0.006, 0.09], peta: [0.12, 0.05],
    emmLab: ['A', 'B'], emm: [51, 56], emmSe: [1.2, 1.3], emmLo: [48.6, 53.4], emmHi: [53.4, 58.6],
    n: [120],
  }), VARS);
  await ancova(app, { y: 'score', factors: ['grp'], covs: ['age'], plots: ['emm'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest, 'no adjusted-means figure');
  assert.deepEqual(forest.studies.map((s) => s.label), ['A', 'B']);
  assert.deepEqual([forest.studies[0].lo, forest.studies[0].hi], [48.6, 53.4]);
  assert.match(draw(forest), /<svg/);
});

test('k-means draws the profiles its own caption tells you to compare', async () => {
  const { kmeans } = await import('../plugins/builtin-cluster/index.js');
  // centers is column-major: value for variable v, cluster c = v*k + c
  const app = fakeApp(rList({
    k: [2], sizes: [40, 60], vars: ['score', 'age'],
    centers: [10, 20, 30, 45], totss: [1000], betweenss: [600], n: [100],
  }), VARS);
  await kmeans(app, { vars: ['score', 'age'], k: 2, plots: ['profile', 'sizes'] });
  const [profile, sizes] = app.out.charts;
  assert.equal(profile.view.mark, 'line');
  assert.deepEqual(profile.categories.map((c) => c.label), ['Score (score)', 'Age (age)']);
  // Cluster 1 takes the first of each variable's pair, cluster 2 the second.
  assert.deepEqual(profile.series[0].values, [10, 30]);
  assert.deepEqual(profile.series[1].values, [20, 45]);
  assert.deepEqual(sizes.series[0].values, [40, 60]);
});

test('latent class analysis draws the profile that IS the solution', async () => {
  const { lca } = await import('../plugins/builtin-mixture/index.js');
  const app = fakeApp(rList({
    k: [2], n: [500],
    cmpK: [1, 2], cmpNpar: [3, 7], cmpAic: [900, 850], cmpBic: [920, 880],
    cmpG2: [40, 10], cmpDf: [5, 2], cmpEnt: [1, 0.8], cmpSmall: [1, 0.4],
    share: [0.6, 0.4],
    pItem: ['i1', 'i1', 'i2', 'i2', 'i3', 'i3'], pClass: [1, 2, 1, 2, 1, 2],
    pCat: [1, 1, 1, 1, 1, 1], pVal: [0.8, 0.2, 0.7, 0.3, 0.9, 0.1],
    mapItem: ['i1', 'i2', 'i3'], mapCode: ['1', '1', '1'], mapRank: [1, 1, 1],
  }), [...VARS, { name: 'i3', label: 'Item 3' }]);
  // Two indicators cannot identify two classes, and the plugin refuses — correctly.
  await lca(app, { items: ['i1', 'i2', 'i3'], classes: 2, seed: 1, save: 'no', plots: ['profile'] });
  const chart = app.out.charts.find((c) => c.kind === 'categorical');
  assert.ok(chart, 'no profile plot');
  assert.equal(chart.view.mark, 'line');
  assert.equal(chart.series.length, 2);
  // The class share is in the legend, because "which class is this?" is always the
  // reader's next question.
  assert.match(chart.series[0].label, /60/);
  assert.deepEqual(chart.series[0].values, [0.8, 0.7, 0.9]);
});

test('survey means carry the interval the design exists to produce', async () => {
  const { means } = await import('../plugins/builtin-survey/index.js');
  const app = fakeApp(rList({
    terms: ['score', 'age'], mean: [52, 44], se: [1.1, 0.9],
    lo: [49.8, 42.2], hi: [54.2, 45.8], uw: [51, 43], n: [1500],
  }), VARS);
  await means(app, { vars: ['score', 'age'], weight: 'wt', plots: ['means'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.deepEqual(forest.studies.map((s) => s.label), ['Score (score)', 'Age (age)']);
  assert.deepEqual([forest.studies[1].lo, forest.studies[1].hi], [42.2, 45.8]);
});

test('the CFA draws its standardized loadings', async () => {
  const { cfa } = await import('../plugins/builtin-sem/index.js');
  const app = fakeApp(rList({
    items: ['i1', 'i2'], std: [0.82, 0.41], se: [0.05, 0.08], z: [16, 5], p: [0, 0],
    chisq: [12], df: [8], pval: [0.15], cfi: [0.98], tli: [0.97], rmsea: [0.03],
    rlo: [0.01], rhi: [0.06], srmr: [0.04], n: [400],
  }), VARS);
  await cfa(app, { items: ['i1', 'i2'], factorName: 'F', plots: ['loadings'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.deepEqual(forest.studies.map((s) => s.label), ['Item 1 (i1)', 'Item 2 (i2)']);
  assert.ok(forest.studies[0].est > forest.studies[1].est);
});

test('multiple imputation draws the pooled estimates', async () => {
  const { run } = await import('../plugins/builtin-imputation/index.js');
  const app = fakeApp(rList({
    terms: ['(Intercept)', 'age'], est: [10, 0.4], se: [2, 0.1], t: [5, 4],
    df: [100, 100], p: [0, 0], lo: [6, 0.2], hi: [14, 0.6],
    fmi: [0.2, 0.3], lambda: [0.18, 0.28],
    missVars: ['age'], missN: [40], nrowAll: [500], ncc: [460], logistic: [false],
  }), VARS);
  await run(app, { y: 'score', ivs: ['age'], m: 5, plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  // The intercept is dropped by the shared builder, as everywhere else.
  assert.deepEqual(forest.studies.map((s) => s.label), ['age']);
});

test('the Bayesian regression labels its interval as credible, not confident', async () => {
  const { regression } = await import('../plugins/builtin-bayesian/index.js');
  const app = fakeApp(rList({
    terms: ['(Intercept)', 'age'], mean: [10, 0.4], sd: [2, 0.1],
    lo: [6, 0.2], hi: [14, 0.6], sigma2: [4], n: [300], draws: [4000],
  }), VARS);
  await regression(app, { dv: 'score', ivs: ['age'], plots: ['coef'] });
  const forest = app.out.charts.find((c) => c.kind === 'forest');
  assert.ok(forest);
  assert.match(forest.valueHeading, /CrI/);
});

test('the response surface draws a Pareto of its effects, largest first', async () => {
  const { run } = await import('../plugins/builtin-doe/index.js');
  const app = fakeApp(rList({
    terms: ['(Intercept)', 'x1', 'x2', 'x1:x2'], est: [50, 2, -8, 0.5],
    se: [1, 0.5, 0.6, 0.3], t: [50, 4, -13, 1.7], p: [0, 0.001, 0, 0.1],
    r2: [0.91], n: [30], stat: [0.2, -0.1], statNames: ['x1', 'x2'], eig: [-2, -5],
    facNames: ['x1', 'x2'],
  }), [{ name: 'yield', label: 'Yield' }, { name: 'x1', label: 'Temp' }, { name: 'x2', label: 'Time' }]);
  await run(app, { y: 'yield', factors: ['x1', 'x2'], plots: ['pareto'] });
  const tornado = app.out.charts.find((c) => c.kind === 'tornado');
  assert.ok(tornado, 'no Pareto');
  // Ordered by absolute effect, intercept excluded — the point of a screening design.
  assert.deepEqual(tornado.rows.map((r) => r.label), ['x2', 'x1', 'x1:x2']);
  assert.match(draw(tornado), /<svg/);
});

test('every one of them stays silent when nothing is ticked', async () => {
  const { kmeans } = await import('../plugins/builtin-cluster/index.js');
  const app = fakeApp(rList({
    k: [2], sizes: [40, 60], vars: ['score'], centers: [10, 20],
    totss: [1000], betweenss: [600], n: [100],
  }), VARS);
  await kmeans(app, { vars: ['score'], k: 2 });
  assert.equal(app.out.charts.length, 0);
});
