/**
 * @file matrix-and-density-kinds.test.mjs
 * Two kinds the survey said were missing and are regularly used: the matrix, and the
 * distribution-as-a-curve.
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

// =============================================================================
// The density kind — the other figure a distribution is read as
// =============================================================================

test('a density draws its curve, and shades the interval under it', () => {
  const m = {
    kind: 'density',
    title: 'Posterior',
    series: [{ key: 'b', label: 'beta', values: [1, 1.2, 1.4, 1.1, 1.6, 1.3, 1.5, 1.35, 1.25], lo: 1.05, hi: 1.55 }],
    guides: [{ axis: 'x', at: 0, label: 'No effect' }],
  };
  const svg = draw(m);
  // Two paths: the shaded interval, then the curve over it.
  assert.equal((svg.match(/<path/g) || []).length, 2);
  assert.ok(svg.includes('fill-opacity="0.22"'), 'the interval is shaded, not just lined');
  assert.ok(svg.includes('No effect'), 'and the guide layer still works here');
  assert.ok(!draw(m, { showInterval: false }).includes('fill-opacity="0.22"'));
});

test('several distributions overlay as curves rather than occluding bars', () => {
  const m = {
    kind: 'density',
    title: 'Two',
    series: [
      { key: 'a', label: 'A', values: [1, 2, 3, 2, 2.5, 1.5] },
      { key: 'b', label: 'B', values: [3, 4, 5, 4, 4.5, 3.5] },
    ],
  };
  // Fill defaults OFF with more than one, because overlapping fills make a third colour
  // that means nothing; the legend comes on instead.
  assert.equal(defaultView(m).fill, false);
  assert.equal(defaultView(m).legend, 'right');
  assert.equal((draw(m).match(/<path/g) || []).length, 2);
});

test('a plugin may send a curve it computed, or the observations', () => {
  // R's own density() for a posterior, raw values for everything else — the kind takes
  // either, which is what lets the Bayesian plugin send 256 points instead of 5000 draws.
  const sent = {
    kind: 'density', title: 'T',
    series: [{ key: 's', label: 'S', points: [{ x: 0, y: 0.1 }, { x: 1, y: 0.8 }, { x: 2, y: 0.2 }] }],
  };
  assert.match(draw(sent), /<path/);
  assert.match(draw({ kind: 'density', title: 'T', series: [{ key: 's', label: 'S', values: [1] }] }), /needs at least two values/);
});

test('the Bayesian regression draws a posterior per parameter', async () => {
  const { regression } = await import('../plugins/builtin-bayesian/index.js');
  const curve = (n) => Array.from({ length: n }, (_, i) => i / 10);
  const app = fakeApp(rList({
    dnX: [...curve(5), ...curve(5)],
    dnY: [0.1, 0.4, 0.9, 0.4, 0.1, 0.2, 0.5, 0.8, 0.5, 0.2],
    dnTerm: ['(Intercept)', '(Intercept)', '(Intercept)', '(Intercept)', '(Intercept)',
      'age', 'age', 'age', 'age', 'age'],
    terms: ['(Intercept)', 'age'], mean: [0.2, 0.2], sd: [0.1, 0.1],
    lo: [0.05, 0.05], hi: [0.35, 0.35], sigma2: [1], n: [300], draws: [5000],
  }), [{ name: 'y', label: 'Y' }, { name: 'age', label: 'Age' }]);
  await regression(app, { dv: 'y', ivs: ['age'], plots: ['post'] });
  const densities = app.out.charts.filter((c) => c.kind === 'density');
  assert.equal(densities.length, 2, 'one per parameter, intercept included');
  assert.equal(densities[1].series[0].points.length, 5);
  assert.ok(densities[1].guides.some((g) => g.at === 0));
  assert.match(draw(densities[1]), /<path/);
});

test('the posterior curves are only computed when asked for', async () => {
  const { regression } = await import('../plugins/builtin-bayesian/index.js');
  const app = fakeApp(rList({
    dnX: [], dnY: [], dnTerm: [],
    terms: ['age'], mean: [0.2], sd: [0.1], lo: [0.05], hi: [0.35],
    sigma2: [1], n: [300], draws: [5000],
  }), [{ name: 'y', label: 'Y' }, { name: 'age', label: 'Age' }]);
  await regression(app, { dv: 'y', ivs: ['age'] });
  assert.equal(app.out.charts.length, 0);
  assert.match(app.out.rCode, /if \(FALSE\)/);
});

// =============================================================================
// The dendrogram — a kind whose method had to be built with it
// =============================================================================

const { remapMerge } = await import('../plugins/builtin-cluster/index.js');

/** Three cases: A and B join at 0.4, then C joins them at 1.2. */
const TREE = {
  kind: 'dendrogram',
  title: 'Cluster dendrogram',
  leaves: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
  merge: [-1, -2, -3, 1],
  height: [0.4, 1.2],
  axes: { y: { title: 'Distance' } },
};

test('it draws a connector per merge, and labels the leaves', () => {
  const svg = draw(TREE);
  assert.equal((svg.match(/<path/g) || []).length, 2, 'one per merge step');
  assert.ok(svg.includes('>A<') && svg.includes('>C<'));
  assert.ok(!draw(TREE, { leafLabels: false }).includes('>A<'));
});

test('the cut line reports the number of clusters it implies', () => {
  // Cutting above 0.4 and below 1.2 leaves two clusters: {A,B} and {C}.
  const svg = draw(TREE, { cut: 0.8 });
  assert.ok(svg.includes('stroke-dasharray="4 3"'), 'the cut is drawn');
  assert.ok(svg.includes('2 clusters'), 'and says what it means');
  // Below every join, every case is its own cluster.
  assert.ok(draw(TREE, { cut: 0.2 }).includes('3 clusters'));
});

test('a cut greys the joins it rejects', () => {
  // The join above the cut is the one the cut is refusing; it goes grey rather than
  // taking a second hue, because the cut is the reader's line and not a finding.
  const greys = (svg) => (svg.match(/stroke="#9aa6b2"/g) || []).length;
  assert.equal(greys(draw(TREE)), 0, 'no cut, no greying');
  assert.equal(greys(draw(TREE, { cut: 0.8 })), 1);
});

test('a malformed tree says so rather than drawing nonsense', () => {
  assert.match(draw({ ...TREE, height: [0.4] }), /needs a merge structure/);
  assert.match(draw({ ...TREE, leaves: [{ key: 'a', label: 'A' }] }), /needs a merge structure/);
});

test('leaf references are remapped into drawing order once, on the plugin side', () => {
  // hclust indexes leaves by ROW and draws them in `order`. Remapping here rather than
  // in the kind means the model that crosses the bridge is already in drawing order —
  // and getting it wrong would draw a tree whose branches cross for no reason.
  // order = [3, 1, 2]: row 3 is drawn first, so -3 becomes -1.
  assert.deepEqual(remapMerge([-1, -2, -3, 1], [3, 1, 2]), [-2, -3, -1, 1]);
  // Positive references are step numbers, not leaves, and must pass through untouched.
  assert.deepEqual(remapMerge([1, 2, -1, 3], [1, 2, 3]), [1, 2, -1, 3]);
});

test('hierarchical clustering emits the tree, the sizes and the centres', async () => {
  const { hierarchical } = await import('../plugins/builtin-cluster/index.js');
  const app = fakeApp(rList({
    n: [6], k: [2], vars: ['x', 'y'], sizes: [4, 2],
    centers: [10, 20, 30, 45],
    merge: [-1, -2, -3, -4, 1, 2, -5, -6, 3, 4],
    height: [0.2, 0.3, 0.9, 1.1, 2.4],
    order: [1, 2, 3, 4, 5, 6],
    labels: ['1', '2', '3', '4', '5', '6'],
  }), [{ name: 'x', label: 'X' }, { name: 'y', label: 'Y' }]);
  await hierarchical(app, { vars: ['x', 'y'], k: 2, linkage: 'ward.D2', plots: ['tree', 'profile'] });
  assert.equal(app.out.errors.length, 0);
  assert.equal(app.out.tables.length, 2, 'sizes and centres');
  const tree = app.out.charts.find((c) => c.kind === 'dendrogram');
  assert.ok(tree, 'no dendrogram');
  assert.equal(tree.leaves.length, 6);
  // The cut is pre-filled between the last merge kept and the first rejected, which is
  // where anyone asking for 2 clusters would draw it by hand.
  assert.ok(tree.view.cut > 1.1 && tree.view.cut < 2.4);
  assert.match(draw(tree), /<path/);
  assert.ok(app.out.charts.some((c) => c.kind === 'categorical'), 'and the profiles');
});

test('the linkage is named in the caption, because it changes the tree', async () => {
  const { hierarchical } = await import('../plugins/builtin-cluster/index.js');
  const app = fakeApp(rList({
    n: [4], k: [2], vars: ['x'], sizes: [2, 2], centers: [1, 9],
    merge: [-1, -2, -3, -4, 1, 2], height: [0.1, 0.2, 1.5],
    order: [1, 2, 3, 4], labels: ['1', '2', '3', '4'],
  }), [{ name: 'x', label: 'X' }]);
  await hierarchical(app, { vars: ['x'], k: 2, linkage: 'single', distance: 'manhattan', plots: [] });
  assert.match(app.out.tables[0].caption, /Single linkage, manhattan distance/);
  assert.equal(app.out.charts.length, 0, 'and nothing is drawn when nothing is ticked');
});
