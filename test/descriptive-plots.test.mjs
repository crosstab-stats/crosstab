/**
 * @file descriptive-plots.test.mjs
 * Frequencies, Crosstabs and Explore — the three screens where SPSS has had a Charts
 * button for thirty years and this app had nothing.
 *
 * These are the most-used descriptive screens in the product, which is why they sat at
 * the top of the coverage survey beside the t-tests. Nothing here is clever: the counts
 * the table already printed, as bars, a pie, or a box. What IS worth testing is that the
 * figure says the same thing as the table beside it — same categories, same labels, same
 * complete cases — and that the weighted case is refused rather than quietly drawn
 * unweighted.
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
    data: { getVariableMeta: async () => variables },
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

const DEG = {
  name: 'deg', label: 'Degree',
  valueLabels: { 1: 'Bachelor’s', 2: 'Master’s', 3: 'Doctorate' },
};

// =============================================================================
// Frequencies — SPSS's Charts button
// =============================================================================

test('frequencies draws the bar chart and the pie from the counts it tabled', async () => {
  const { run } = await import('../plugins/builtin-frequencies/index.js');
  // The batch shape this plugin reads: one slot per variable.
  const one = rList({
    values: ['1', '2', '3'], counts: [40, 35, 25], percent: [40, 35, 25],
    valid_percent: [40, 35, 25], cumulative: [40, 75, 100],
    n_valid: [100], n_missing: [0], n_total: [100], dropped: [0],
  });
  const app = fakeApp(rList({ v1: one }), [DEG]);
  await run(app, { vars: ['deg'], plots: ['bar', 'pie'] });
  const bar = app.out.charts.find((c) => c.kind === 'categorical');
  const pie = app.out.charts.find((c) => c.kind === 'pie');
  assert.ok(bar, 'no bar chart');
  assert.ok(pie, 'no pie chart');
  assert.deepEqual(bar.categories.map((c) => c.label), ['Bachelor’s', 'Master’s', 'Doctorate']);
  assert.deepEqual(bar.series[0].values, [40, 35, 25]);
  // `counts: true` is what lets the reader switch the chart to percentages itself.
  assert.equal(bar.counts, true);
  assert.deepEqual(pie.slices.map((s) => s.value), [40, 35, 25]);
  assert.ok(draw(bar).includes('<rect'));
  assert.match(draw(pie), /<svg/);
});

test('frequencies draws nothing unless asked', async () => {
  const { run } = await import('../plugins/builtin-frequencies/index.js');
  const one = rList({
    values: ['1'], counts: [10], percent: [100], valid_percent: [100], cumulative: [100],
    n_valid: [10], n_missing: [0], n_total: [10], dropped: [0],
  });
  const app = fakeApp(rList({ v1: one }), [DEG]);
  await run(app, { vars: ['deg'] });
  assert.equal(app.out.charts.length, 0);
});

// =============================================================================
// Crosstabs — "Display clustered bar charts"
// =============================================================================

const CROSS = rList({
  rowLevels: ['1', '2'], colLevels: ['1', '2', '3'],
  counts: [10, 20, 30, 40, 30, 20],
  rowTotals: [60, 90], colTotals: [50, 50, 50], total: [150],
  chisq: [8.5], dfree: [2], p: [0.014], minExp: [20],
  pMC: [NaN], pFisher: [NaN],
});

test('crosstabs clusters the cells, and stacks them to 100% for composition', async () => {
  const { run } = await import('../plugins/builtin-crosstabs/index.js');
  const app = fakeApp(CROSS, [DEG, { name: 'sex', label: 'Sex', valueLabels: { 1: 'Women', 2: 'Men', 3: 'Other' } }]);
  await run(app, { rowvar: 'deg', colvar: 'sex', plots: ['clustered', 'stacked'] });
  const charts = app.out.charts.filter((c) => c.kind === 'categorical');
  assert.equal(charts.length, 2);
  const [clustered, stacked] = charts;
  // Rows become categories, columns become series — the orientation of the table.
  assert.deepEqual(clustered.categories.map((c) => c.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(clustered.series.map((s) => s.label), ['Women', 'Men', 'Other']);
  // Series values read DOWN the table's column: cell (row i, col j).
  assert.deepEqual(clustered.series[0].values, [10, 40]);
  assert.deepEqual(clustered.series[2].values, [30, 20]);
  assert.equal(clustered.view.stack, 'none');
  assert.equal(stacked.view.stack, 'percent');
  assert.ok(draw(clustered).includes('<rect'));
});

// =============================================================================
// Explore — the box plot it is named for
// =============================================================================

const EXPLORE_STATS = rList({
  n: [4], mean: [12.5], se: [1], lo: [10], hi: [15], trimmed: [12.5], median: [12.5],
  variance: [4], sd: [2], min: [10], max: [15], range: [5], iqr: [2],
});

/** The nested shape `tagged()` reads: per variable, `{ groups, stats, raws }`. */
const exploreResult = (raws) => rList({
  pay: rList({
    groups: ['1', '2'],
    stats: { values: [EXPLORE_STATS, EXPLORE_STATS] },
    raws: { values: raws },
  }),
});

test('explore draws a box per group, labelled like the table', async () => {
  const { explore } = await import('../plugins/builtin-descriptives/index.js');
  const app = fakeApp(exploreResult([[10, 11, 12, 15], [20, 22, 24, 25]]),
    [{ name: 'pay', label: 'Annual pay' }, DEG]);
  await explore(app, { vars: ['pay'], by: 'deg', plots: ['box'] });
  const box = app.out.charts.find((c) => c.kind === 'box');
  assert.ok(box, 'no box plot');
  assert.deepEqual(box.groups.map((g) => g.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(box.groups[1].values, [20, 22, 24, 25]);
  assert.match(draw(box), /<svg/);
});

test('explore draws a histogram per group when asked', async () => {
  const { explore } = await import('../plugins/builtin-descriptives/index.js');
  const app = fakeApp(exploreResult([[10, 11, 12, 15], [20, 22, 24, 25]]),
    [{ name: 'pay', label: 'Annual pay' }, DEG]);
  await explore(app, { vars: ['pay'], by: 'deg', plots: ['hist'] });
  const hists = app.out.charts.filter((c) => c.kind === 'histogram');
  assert.equal(hists.length, 2);
  assert.ok(hists[0].title.includes('Bachelor'));
});

test('a weighted explore says why there is no chart', async () => {
  const { explore } = await import('../plugins/builtin-descriptives/index.js');
  const app = fakeApp(exploreResult([]), [{ name: 'pay', label: 'Annual pay' }, { name: 'wt', label: 'Weight' }]);
  await explore(app, { vars: ['pay'], weight: 'wt', plots: ['box'] });
  assert.equal(app.out.charts.length, 0);
  assert.ok(app.out.texts.some((t) => /cannot\s+carry the case weight/.test(t)));
  // ...and the observations were never shipped in the first place.
  assert.match(app.out.rCode, /RAW <- FALSE/);
});

test('an unweighted explore ships the observations, a plotless one does not', async () => {
  const { explore } = await import('../plugins/builtin-descriptives/index.js');
  const on = fakeApp(exploreResult([[1, 2, 3]]), [{ name: 'pay', label: 'Pay' }]);
  await explore(on, { vars: ['pay'], plots: ['box'] });
  assert.match(on.out.rCode, /RAW <- TRUE/);

  const off = fakeApp(exploreResult([]), [{ name: 'pay', label: 'Pay' }]);
  await explore(off, { vars: ['pay'] });
  assert.match(off.out.rCode, /RAW <- FALSE/);
  assert.equal(off.out.charts.length, 0);
});
