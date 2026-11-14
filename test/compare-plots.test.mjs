/**
 * @file compare-plots.test.mjs
 * The figures the t-tests and the one-way ANOVA now offer.
 *
 * These four analyses are the most-run screens in the app and they printed tables only,
 * which is why they led the chart-coverage hit list. The one-way ANOVA is the sharpest
 * case: it has computed the Tukey pairs AND their intervals since it shipped, and printed
 * them as a table — the figure was already paid for and never drawn.
 *
 * Same harness as the ANOVA plots: the real exported functions against a fake host with a
 * canned R result, then the emitted models rendered through the REAL chart kinds. A model
 * that passes a shape check and draws nothing is the failure worth catching.
 *
 * The one rule with teeth here is the WEIGHT rule. A raw-observation chart hands the host
 * the values and lets it compute the summary; the host has no weights, so under a case
 * weight that chart would describe the sample while the table beside it describes the
 * population. Those charts are skipped, out loud.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { oneSample, independent, paired, oneway } = await import('../plugins/builtin-compare/index.js');

const rList = (obj) => ({ names: Object.keys(obj), values: Object.values(obj) });

function fakeApp(result, variables) {
  const out = { tables: [], texts: [], charts: [], errors: [], rCode: '' };
  return {
    out,
    data: { getVariableMeta: async () => variables },
    webr: { run: async (code) => { out.rCode = code; return { result }; } },
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
  { name: 'deg', label: 'Degree', valueLabels: { 1: 'Bachelor’s', 2: 'Master’s', 3: 'Doctorate' } },
  { name: 'wt', label: 'Survey weight' },
  { name: 't1', label: 'Baseline' },
  { name: 't2', label: 'Follow-up' },
];

await import('./chart-kinds-harness.mjs');
const { defaultView, renderChart } = await import('../core/chart-renderer.js');
const draw = (m) => renderChart(m, { ...defaultView(m), ...(m.view || {}) });

// =============================================================================
// One-sample t
// =============================================================================

const ONE_SAMPLE = (raw = []) => rList({
  n: [10], mean: [52], sd: [6], mu: [50], diff: [2], t: [1.05], df: [9],
  p: [0.32], d: [0.33], lo: [-2.3], hi: [6.3], rawX: raw,
});

test('one-sample: the distribution is drawn with the test value AND the mean marked', async () => {
  const app = fakeApp(ONE_SAMPLE([48, 50, 52, 54, 56]), VARS);
  await oneSample(app, { x: 'pay', mu: 50, plots: ['dist'] });
  const m = app.out.charts[0];
  assert.equal(m.kind, 'histogram');
  assert.deepEqual(m.guides.map((g) => [g.axis, g.at]), [['x', 50], ['x', 52]]);
  // Both guides are vertical on a value axis, and both reach the SVG.
  const svg = draw(m);
  assert.ok(svg.includes('Test value'));
  assert.ok(svg.includes('Mean'));
});

test('no plots asked for means no raw values cross the bridge', async () => {
  const app = fakeApp(ONE_SAMPLE(), VARS);
  await oneSample(app, { x: 'pay', mu: 50 });
  assert.equal(app.out.charts.length, 0);
  assert.match(app.out.rCode, /rawX = numeric\(0\)/);
});

// =============================================================================
// Independent-samples t
// =============================================================================

const INDEP = (raw = [], grp = []) => rList({
  levels: ['1', '2'], n: [5, 5], mean: [50, 60], sd: [5, 6],
  levF: [0.4], levP: [0.54],
  tp: [-2.8], dfp: [8], pp: [0.02], plo: [-18], phi: [-2], sep: [3.5],
  tw: [-2.8], dfw: [7.8], pw: [0.02], wlo: [-18], whi: [-2], sew: [3.5],
  diff: [-10], d: [-1.2], rawY: raw, rawG: grp,
});
const RAW_Y = [48, 49, 50, 51, 52, 57, 58, 60, 62, 63];
const RAW_G = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];

test('independent: means with error bars, and a box plot of the same groups', async () => {
  const app = fakeApp(INDEP(RAW_Y, RAW_G), VARS);
  await independent(app, { y: 'pay', g: 'deg', g1: '1', g2: '2', plots: ['means', 'dist'] });
  assert.equal(app.out.charts.length, 2);
  const [means, box] = app.out.charts;

  assert.equal(means.kind, 'categorical');
  assert.deepEqual(means.categories.map((c) => c.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(means.series[0].values, [50, 60]);
  assert.deepEqual(means.series[0].rawValues, [[48, 49, 50, 51, 52], [57, 58, 60, 62, 63]]);
  assert.equal(means.view.errorBars, 'ci95');

  assert.equal(box.kind, 'box');
  assert.deepEqual(box.groups.map((g) => g.label), ['Bachelor’s', 'Master’s']);
  assert.deepEqual(box.groups[1].values, [57, 58, 60, 62, 63]);

  // Both render through the real kinds.
  assert.ok(draw(means).includes('<rect'));
  assert.match(draw(box), /<svg/);
});

test('independent: the group labels come from the value labels, not the codes', async () => {
  // The key stays the code — it is an identity, and the saved view keys colours by it.
  // The LABEL is what a reader sees, and a chart captioned "1" beside a table saying
  // "Bachelor's" is the drift this shares a helper with the ANOVA to avoid.
  const app = fakeApp(INDEP(RAW_Y, RAW_G), VARS);
  await independent(app, { y: 'pay', g: 'deg', g1: '1', g2: '2', plots: ['means'] });
  const cats = app.out.charts[0].categories;
  assert.deepEqual(cats.map((c) => c.key), ['1', '2']);
  assert.deepEqual(cats.map((c) => c.label), ['Bachelor’s', 'Master’s']);
});

// =============================================================================
// Paired t
// =============================================================================

const PAIRED = ({ a = [], b = [], d = [] } = {}) => rList({
  n: [4], m1: [10], m2: [13], sd1: [2], sd2: [2.4], diff: [-3], sddiff: [1.2],
  t: [-5], df: [3], rPair: [0.8], rP: [0.2], p: [0.015], lo: [-4.9], hi: [-1.1],
  rawX1: a, rawX2: b, rawD: d,
});

test('paired: one line per case, and the differences with zero marked', async () => {
  const app = fakeApp(PAIRED({ a: [9, 10, 11, 10], b: [12, 13, 15, 12], d: [-3, -3, -4, -2] }), VARS);
  await paired(app, { x1: 't1', x2: 't2', plots: ['subjects', 'diff'] });
  const [lines, hist] = app.out.charts;

  assert.equal(lines.kind, 'paired');
  assert.deepEqual(lines.conditions.map((c) => c.label), ['Baseline', 'Follow-up']);
  assert.deepEqual(lines.subjects[0].values, [9, 12]);
  assert.equal(lines.subjects.length, 4);
  assert.equal((draw(lines).match(/<polyline/g) || []).length, 4);

  assert.equal(hist.kind, 'histogram');
  // Zero is what a paired t asks about, so zero is on the chart.
  assert.ok(hist.guides.some((g) => g.at === 0));
  assert.ok(draw(hist).includes('No change'));
});

test('paired: too many pairs says so rather than drawing a thicket', async () => {
  const n = 400;
  const a = Array.from({ length: n }, (_, i) => i);
  const b = a.map((v) => v + 2);
  const app = fakeApp(PAIRED({ a, b }), VARS);
  await paired(app, { x1: 't1', x2: 't2', plots: ['subjects'] });
  assert.equal(app.out.charts.length, 0);
  assert.ok(app.out.texts.some((t) => /Per-case lines skipped/.test(t)));
});

// =============================================================================
// One-way ANOVA — the one where the figure was already paid for
// =============================================================================

const ONEWAY = ({ raw = [], grp = [], tukey = true } = {}) => rList({
  levels: ['1', '2', '3'], gn: [4, 4, 4], gmean: [50, 58, 66], gsd: [4, 5, 6],
  df1: [2], df2: [9], ssb: [512], ssw: [225], msb: [256], msw: [25],
  Fval: [10.2], p: [0.005], eta2: [0.69], eps2: [0.62], om2: [0.6],
  levF: [0.5], levP: [0.62],
  welF: [9.8], welDf2: [5.9], welP: [0.01], bfF: [10.1], bfDf2: [7.7], bfP: [0.008],
  tukI: tukey ? ['2', '3', '3'] : [],
  tukJ: tukey ? ['1', '1', '2'] : [],
  tukSE: tukey ? [3.5, 3.5, 3.5] : [],
  tukDiff: tukey ? [8, 16, 8] : [],
  tukLo: tukey ? [-1.7, 6.3, -1.7] : [],
  tukUp: tukey ? [17.7, 25.7, 17.7] : [],
  tukP: tukey ? [0.11, 0.002, 0.11] : [],
  rawY: raw, rawG: grp,
});
const OW_RAW = [46, 49, 52, 53, 53, 56, 59, 64, 60, 64, 68, 72];
const OW_GRP = [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];

test('one-way: the Tukey table becomes the forest it always described', async () => {
  const app = fakeApp(ONEWAY(), VARS);
  await oneway(app, { y: 'pay', g: 'deg', plots: ['tukey'] });
  const m = app.out.charts[0];
  assert.equal(m.kind, 'forest');
  assert.equal(m.refLine, 0);
  assert.deepEqual(m.studies.map((s) => s.label), [
    'Master’s − Bachelor’s', 'Doctorate − Bachelor’s', 'Doctorate − Master’s',
  ]);
  assert.deepEqual([m.studies[1].est, m.studies[1].lo, m.studies[1].hi], [16, 6.3, 25.7]);
  // The interval that clears zero and the two that do not are all on one axis.
  assert.match(draw(m), /<svg/);
});

test('one-way: the Tukey plot needs no raw values, so it survives a weight', async () => {
  const app = fakeApp(ONEWAY(), VARS);
  await oneway(app, { y: 'pay', g: 'deg', weight: 'wt', plots: ['tukey'] });
  assert.equal(app.out.charts.length, 1);
  assert.equal(app.out.charts[0].kind, 'forest');
});

test('one-way: means and distribution, from the same complete cases as the table', async () => {
  const app = fakeApp(ONEWAY({ raw: OW_RAW, grp: OW_GRP }), VARS);
  await oneway(app, { y: 'pay', g: 'deg', plots: ['means', 'dist'] });
  const [means, box] = app.out.charts;
  assert.deepEqual(means.series[0].values, [50, 58, 66]);
  assert.deepEqual(means.series[0].rawValues[2], [60, 64, 68, 72]);
  assert.deepEqual(box.groups.map((g) => g.label), ['Bachelor’s', 'Master’s', 'Doctorate']);
});

// =============================================================================
// The weight rule
// =============================================================================

test('a weighted run skips the raw charts and says why', async () => {
  for (const [fn, args] of [
    [oneSample, { x: 'pay', mu: 50, weight: 'wt', plots: ['dist'] }],
    [independent, { y: 'pay', g: 'deg', g1: '1', g2: '2', weight: 'wt', plots: ['means', 'dist'] }],
    [paired, { x1: 't1', x2: 't2', weight: 'wt', plots: ['subjects', 'diff'] }],
    [oneway, { y: 'pay', g: 'deg', weight: 'wt', plots: ['means', 'dist'] }],
  ]) {
    const result = fn === oneSample ? ONE_SAMPLE() : fn === independent ? INDEP() : fn === paired ? PAIRED() : ONEWAY();
    const app = fakeApp(result, VARS);
    await fn(app, args);
    assert.equal(app.out.charts.length, 0, `${fn.name}: drew an unweighted chart`);
    assert.ok(app.out.texts.some((t) => /cannot carry the case weight/.test(t)), `${fn.name}: said nothing`);
    // And it did not pay to ship values it was never going to draw.
    assert.ok(!/rawY = y|rawX = x|rawX1 = x1/.test(app.out.rCode), `${fn.name}: shipped raw anyway`);
  }
});
