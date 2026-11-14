/**
 * @file heatmap-kind.test.mjs
 * The matrix kind, and the three matrices that wanted it.
 *
 * The most-wanted missing kind in the chart-coverage survey, by client count: a
 * correlation matrix, a loadings matrix, topic by term. All three were already printed
 * as tables, and a table of forty numbers is a shape nobody can see.
 *
 * Two decisions carry the weight here, and both are tested rather than described:
 *
 *  - **the cells and the key are classed together.** `scaleBlock`'s own argument for the
 *    choropleth is that a key must not promise precision the picture lacks; the same
 *    holds in reverse, so the cells are binned to the same steps the key shows, and the
 *    exact number goes IN the cell when there is room;
 *  - **the scale is pinned where the measure has natural bounds.** A correlation matrix
 *    whose strongest pair is .3 must not be shaded as though .3 were the maximum
 *    possible — that is the "axis starting at 47" mistake in colour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');
const { renderChart, defaultView, chartUiSpec } = await import('../core/chart-renderer.js');
const draw = (m, over = {}) => renderChart(m, { ...defaultView(m), ...(m.view || {}), ...over });

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

const MATRIX = {
  kind: 'heatmap',
  title: 'Correlations',
  rows: ['Income', 'Education', 'Age'].map((l) => ({ key: l, label: l })),
  columns: ['Income', 'Education', 'Age'].map((l) => ({ key: l, label: l })),
  values: [1, 0.42, -0.18, 0.42, 1, 0.05, -0.18, 0.05, 1],
  scale: { min: -1, max: 1, diverging: true, label: 'r' },
};

// =============================================================================
// The kind
// =============================================================================

test('it draws a cell per value, labelled on both axes', () => {
  const svg = draw(MATRIX);
  // Nine cells, plus the key's blocks.
  assert.ok((svg.match(/<rect/g) || []).length >= 9);
  assert.ok(svg.includes('Education'));
  assert.ok(svg.includes('0.42'), 'the number is in the cell');
});

test('a diverging scale is chosen when the values straddle zero, and centred there', () => {
  assert.equal(defaultView(MATRIX).ramp, 'diverging');
  // All-positive data gets the sequential ramp instead: there is no "opposite
  // direction" for a probability to be in.
  const loadings = { ...MATRIX, values: [0.8, 0.1, 0.2, 0.7, 0.3, 0.9, 0.1, 0.2, 0.4], scale: { min: 0 } };
  assert.equal(defaultView(loadings).ramp, 'sequential');
});

test('the pinned scale is honoured: a weak matrix is not shaded as a strong one', () => {
  // Two matrices identical but for their strength. With the scale pinned to [-1, 1] the
  // weak one must come out paler — if the ramp were fitted to the data they would be
  // shaded identically, which is the colour version of an axis that starts at 47.
  const strong = { ...MATRIX, values: [1, 0.95, 0.9, 0.95, 1, 0.92, 0.9, 0.92, 1] };
  const weak = { ...MATRIX, values: [1, 0.12, 0.08, 0.12, 1, 0.05, 0.08, 0.05, 1] };
  const fillsOf = (svg) => [...svg.matchAll(/<rect[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.notDeepEqual(fillsOf(draw(strong)), fillsOf(draw(weak)));
});

test('the values can be switched off, and are left out when the cells are small', () => {
  assert.ok(!draw(MATRIX, { cellValues: false }).includes('0.42'));
  // 400 cells: the default is off, because a number in a 9px cell is not a number.
  const big = {
    kind: 'heatmap',
    title: 'T',
    rows: Array.from({ length: 20 }, (_, i) => ({ key: `r${i}`, label: `R${i}` })),
    columns: Array.from({ length: 20 }, (_, i) => ({ key: `c${i}`, label: `C${i}` })),
    values: Array.from({ length: 400 }, (_, i) => (i % 7) / 7),
  };
  assert.equal(defaultView(big).cellValues, false);
  assert.match(draw(big), /<svg/);
});

test('it says so rather than drawing an empty frame', () => {
  assert.match(draw({ kind: 'heatmap', title: 'T', rows: [], columns: [], values: [] }), /needs rows and columns/);
  assert.match(
    draw({ ...MATRIX, values: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN] }),
    /no values to shade/,
  );
});

test('its controls are the ones a matrix needs, and no palette it cannot use', () => {
  const ids = chartUiSpec(MATRIX).controls.map((c) => c.id);
  assert.ok(ids.includes('ramp'));
  assert.ok(ids.includes('cellValues'));
  // There is nothing here to assign a categorical colour to, so no palette picker.
  assert.ok(!ids.includes('palette'));
});

// =============================================================================
// The clients
// =============================================================================

test('the correlation matrix draws itself, pinned to the full range', async () => {
  const { run } = await import('../plugins/builtin-correlation/index.js');
  const app = fakeApp(rList({
    k: [3],
    r: [1, 0.42, -0.18, 0.42, 1, 0.05, -0.18, 0.05, 1],
    p: [0, 0.001, 0.2, 0.001, 0, 0.6, 0.2, 0.6, 0],
    n: [300, 300, 300, 300, 300, 300, 300, 300, 300],
    sx: [], sy: [],
  }), [
    { name: 'inc', label: 'Income' }, { name: 'edu', label: 'Education' }, { name: 'age', label: 'Age' },
  ]);
  await run(app, { vars: ['inc', 'edu', 'age'], plots: ['matrix'] });
  const h = app.out.charts.find((c) => c.kind === 'heatmap');
  assert.ok(h, 'no heatmap');
  assert.deepEqual(h.rows.map((x) => x.label), ['Income', 'Education', 'Age']);
  assert.deepEqual(h.scale, { min: -1, max: 1, diverging: true, label: 'Pearson' });
  assert.ok(draw(h).includes('<rect'));
});

test('the loadings matrix survives the column-major hop from R', async () => {
  const { run } = await import('../plugins/builtin-factor/index.js');
  const app = fakeApp(rList({
    ev: [2.4, 1.1, 0.4], varPct: [48, 22, 8], cumPct: [48, 70, 78], nf: [2],
    nItems: [3], nFac: [2],
    // R is column-major: factor 1 down, then factor 2.
    loadings: [0.8, 0.7, 0.1, 0.1, 0.2, 0.9],
    items: ['i1', 'i2', 'i3'], comm: [0.6, 0.5, 0.8],
    kmo: [0.8], bartX: [100], bartDf: [3], bartP: [0], n: [300],
  }), [
    { name: 'i1', label: 'Item 1' }, { name: 'i2', label: 'Item 2' }, { name: 'i3', label: 'Item 3' },
  ]);
  await run(app, { vars: ['i1', 'i2', 'i3'], factors: 2, rotation: 'varimax', plots: ['loadings'] });
  const h = app.out.charts.find((c) => c.kind === 'heatmap');
  assert.ok(h, 'no loadings heatmap');
  // Row-major in the kind: item 1 on both factors, then item 2, then item 3.
  assert.deepEqual(h.values, [0.8, 0.1, 0.7, 0.2, 0.1, 0.9]);
  assert.deepEqual(h.columns.map((c) => c.label), ['Factor 1', 'Factor 2']);
});

test('the scree plot is still drawn beside it', async () => {
  const { run } = await import('../plugins/builtin-factor/index.js');
  const app = fakeApp(rList({
    ev: [2.4, 1.1], varPct: [60, 25], cumPct: [60, 85], nf: [1], nItems: [2], nFac: [1],
    loadings: [0.8, 0.7], items: ['i1', 'i2'], comm: [0.6, 0.5],
    kmo: [0.8], bartX: [100], bartDf: [1], bartP: [0], n: [300],
  }), [{ name: 'i1', label: 'Item 1' }, { name: 'i2', label: 'Item 2' }]);
  await run(app, { vars: ['i1', 'i2'], factors: 1, rotation: 'none' });
  const scree = app.out.charts.find((c) => c.kind === 'categorical');
  assert.ok(scree);
  assert.ok(scree.guides.some((g) => g.at === 1), 'and keeps its Kaiser line');
  // ...and the heatmap stays away until it is asked for.
  assert.equal(app.out.charts.filter((c) => c.kind === 'heatmap').length, 0);
});
