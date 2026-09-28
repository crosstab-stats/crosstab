/**
 * @file ce-plane.test.mjs
 * The cost-effectiveness plane becomes a chart model, and `scatter` learns point labels.
 *
 * This was the clearest case left in the baked-chart review: `builtin-decisions` had just
 * finished computing every cost, effect and ICER, and then hand-rolled axes, scales, colours
 * and text anchors into an SVG string — so the figure arrived in the output as a picture with
 * no palette, no re-editable title, and no way back to the numbers.
 *
 * What the migration had to add, and why each matters more than it looks:
 *
 *  1. **Point labels.** A CE plane with anonymous dots is useless: the reader needs to know
 *     which dot is *Usual care*. No chart kind could label a point, so `scatter` gained it —
 *     and because the labels are identities rather than decoration, they default to ON when
 *     the model supplies them, and a scatter that supplies none is untouched.
 *  2. **Status as a GROUP, not a colour.** The old drawing hard-coded green for
 *     cost-effective and red for dominated: a legend the reader had to infer, in the two
 *     colours a colourblind reader cannot separate. As groups they get a real legend, the
 *     safe palette, and the user can recolour or reorder them.
 *  3. **`axes.x.title`, not `xTitle`.** The shape the kind actually reads. The first pass of
 *     the sibling diagnostics used `xTitle` and rendered no axis titles at all, with every
 *     field present and correct — so the axis assertions here draw the chart rather than
 *     reading the model back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');

const { defaultView, chartUiSpec, renderChart } = await import('../core/chart-renderer.js');
const { cePlaneModel, computeICER } = await import('../plugins/builtin-decisions/index.js');

// =============================================================================
// Point labels on the scatter kind
// =============================================================================

const named = (extra = {}) => ({
  kind: 'scatter',
  title: 'plane',
  points: [{ x: 1, y: 10, label: 'Usual care' }, { x: 2, y: 40, label: 'New drug' }],
  ...extra,
});

test('a point that names itself is labelled by default', () => {
  const model = named();
  assert.equal(defaultView(model).valueLabels, true);
  const svg = renderChart(model, defaultView(model));
  assert.ok(svg.includes('Usual care') && svg.includes('New drug'));
});

test('a scatter of ordinary observations is untouched', () => {
  // The existing correlation/regression scatters must not grow a labels section they have no
  // use for — 30,000 points cannot be labelled and should not offer to be.
  const plain = { kind: 'scatter', title: 't', points: [{ x: 1, y: 2 }, { x: 2, y: 3 }] };
  assert.equal(defaultView(plain).valueLabels, false);
  assert.equal(chartUiSpec(plain).controls.some((c) => c.id === 'valueLabels'), false);
});

test('the labels can be switched off, sized, and emboldened', () => {
  const model = named();
  const ids = chartUiSpec(model).controls.map((c) => c.id);
  for (const id of ['valueLabels', 'valueLabelSize', 'valueLabelBold', 'valueLabelItalic']) {
    assert.ok(ids.includes(id), `no ${id} control`);
  }
  const off = renderChart(model, { ...defaultView(model), valueLabels: false });
  assert.equal(off.includes('Usual care'), false);
  const big = renderChart(model, { ...defaultView(model), valueLabelSize: 16 });
  assert.ok(big.includes('font-size="16"'));
});

test('a label is drawn after its point, so the marker never covers the name', () => {
  const svg = renderChart(named(), defaultView(named()));
  assert.ok(svg.lastIndexOf('<circle') < svg.indexOf('Usual care'));
});

test('a label near the right edge flips inside rather than being clipped', () => {
  // A name is an identity; half of one is worse than one on the other side of the dot.
  const model = {
    kind: 'scatter',
    title: 't',
    points: [{ x: 100, y: 1, label: 'A very long option name indeed' }],
    axes: { x: { title: 'x' } },
  };
  const svg = renderChart(model, { ...defaultView(model), xAxisMin: 0, xAxisMax: 100 });
  assert.ok(svg.includes('A very long option name indeed'));
  assert.ok(/text-anchor="end"[^>]*>A very long/.test(svg) || /anchor="end"/.test(svg),
    'the right-edge label should be anchored at its end');
});

test('a label is escaped, not injected', () => {
  const model = { kind: 'scatter', title: 't', points: [{ x: 1, y: 1, label: '<script>x</script>' }] };
  const svg = renderChart(model, defaultView(model));
  assert.equal(svg.includes('<script>'), false);
  assert.ok(svg.includes('&lt;script&gt;'));
});

// =============================================================================
// The plane itself
// =============================================================================

const ROWS = [
  { name: 'Usual care', cost: 1000, effect: 0.5 },
  { name: 'New drug', cost: 4000, effect: 0.9 },
  { name: 'Worse and dearer', cost: 5000, effect: 0.4 },
];

test('computeICER still classifies the frontier — the numbers the plane draws', () => {
  // Rows are walked cheapest-first, so: usual care (1000) is the baseline; the new drug (4000,
  // 0.9) is compared to it — ICER 3000/0.4 = 7500, under the 10,000 WTP, so cost-effective;
  // and the 5000/0.4 option buys LESS effect than the 0.9 already on the frontier, so it is
  // dominated. The statuses are in cost order, not input order.
  const res = computeICER(ROWS, 10000);
  assert.deepEqual(res.map((r) => [r.name, r.status]), [
    ['Usual care', 'baseline'],
    ['New drug', 'cost-effective'],
    ['Worse and dearer', 'dominated'],
  ]);
  assert.equal(Math.round(res.find((r) => r.name === 'New drug').icer), 7500);
});

test('the plane is a scatter of named points grouped by status', () => {
  const model = cePlaneModel(computeICER(ROWS, 10000));
  assert.equal(model.kind, 'scatter');
  assert.deepEqual(model.axes, { x: { title: 'Effect' }, y: { title: 'Cost' } });
  // Cost on y, effect on x — the convention every CE plane in the literature uses, and the
  // one thing here a reader would misread silently if it were flipped.
  assert.deepEqual(model.points.find((p) => p.label === 'New drug'), { x: 0.9, y: 4000, label: 'New drug', g: 'cost-effective' });
  assert.deepEqual(model.groups.map((g) => g.key), ['baseline', 'cost-effective', 'dominated']);
  assert.ok(model.groups.every((g) => g.label && g.label !== g.key), 'a legend needs words, not slugs');
});

test('the legend order runs from the comparator outwards, not order-of-appearance', () => {
  // Input order is deliberately reversed here; the legend must not follow it.
  const res = computeICER([...ROWS].reverse(), 10000);
  assert.deepEqual(cePlaneModel(res).groups.map((g) => g.key), ['baseline', 'cost-effective', 'dominated']);
});

test('with no willingness-to-pay there is no verdict, so there are no verdict groups', () => {
  // computeICER leaves `status` empty when WTP is absent. Grouping on that would have produced
  // a legend entry with no name.
  const model = cePlaneModel(computeICER(ROWS, null));
  assert.deepEqual(model.groups.map((g) => g.label), ['Baseline (cheapest)', 'Dominated', 'Options']);
  assert.ok(model.groups.every((g) => g.key && g.label), 'no empty key or label may reach the legend');
});

test('nothing plottable returns null rather than an empty chart', () => {
  // An empty frame with axes and no points looks like a bug; the tool reports the error.
  assert.equal(cePlaneModel([]), null);
  assert.equal(cePlaneModel(null), null);
});

test('the plane renders with every option named and both axes titled', () => {
  const model = cePlaneModel(computeICER(ROWS, 10000));
  const svg = renderChart(model, defaultView(model));
  for (const name of ROWS.map((r) => r.name)) assert.ok(svg.includes(name), `${name} unlabelled`);
  assert.ok(svg.includes('Effect') && svg.includes('Cost'), 'axes must be titled');
  assert.ok(svg.includes('Dominated'), 'the legend names the statuses');
});
