/**
 * @file sensitivity-charts.test.mjs
 * The two sensitivity figures become chart models, and `scatter` learns to draw a curve.
 *
 * `builtin-decisions` sends a one-way sweep or a tornado diagram to Output. Both were SVG the
 * plugin drew itself — so the published figure had no palette, no re-editable title, and no
 * numbers behind it.
 *
 * **The interesting decision is what was NOT migrated.** The same two figures appear live in
 * the plugin's own panel, redrawing on every slider frame with a marker showing where the
 * parameter currently sits. That stays plugin-drawn. Routing it through the host renderer would
 * put a postMessage round-trip inside a drag handler, and the marker has no business in a
 * published figure anyway: the panel version is an *instrument*, the Output version is a
 * *figure*. Two artefacts with different jobs, not one thing drawn twice — which is why the
 * tests below check that the model carries the figure's content and *not* the instrument's.
 *
 * What the migration needed from the chart layer, and why each is more than cosmetic:
 *
 *  1. **A connected scatter.** A sweep is 61 samples of one continuous function. As a cloud of
 *     dots the shape — which IS the finding — disappears. The line is drawn in x order, because
 *     a polyline follows the order it is handed and an unsorted sweep draws a zigzag.
 *  2. **Axis guides.** The break-even crossing and each point where the recommendation flips
 *     were hard-coded green and amber lines. As `guides` they are named on the chart, can be
 *     switched off, and are skipped when off-scale — a guide drawn on the frame is a lie about
 *     where it falls.
 *  3. **A `tornado` kind.** Reusing `forest` was considered and rejected: the geometry nearly
 *     matches, but the panel would then talk about studies, weights and log scales, and the
 *     rows would be markers with whiskers rather than bars. The widest-swing-first ordering is
 *     enforced in the kind, because that funnel outline is the entire reason the chart is
 *     legible — a model in input order would draw a correct chart of the wrong kind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');

const { defaultView, chartUiSpec, renderChart } = await import('../core/chart-renderer.js');
const { sensLineModel, sensTornado, tornadoModel } = await import('../plugins/builtin-decisions/index.js');

// =============================================================================
// The one-way sweep
// =============================================================================

/** A sweep that crosses zero halfway, the way a break-even sweep does. */
const SWEEP = [...Array(9)].map((_, i) => ({ x: i, y: i - 4 }));
const OPTS = {
  title: 'NPV: discount rate',
  xLabel: 'Discount rate',
  yLabel: 'NPV',
  reference: 0,
  threshold: 4,
  flips: [{ x: 4, to: 'Do nothing' }],
};

test('the sweep is a connected scatter, not a cloud of dots', () => {
  const model = sensLineModel(SWEEP, OPTS);
  assert.equal(model.kind, 'scatter');
  assert.equal(model.line, true);
  const view = defaultView(model);
  assert.equal(view.mark, 'line');
  const svg = renderChart(model, view);
  assert.ok(svg.includes('<polyline'), 'the curve must be drawn');
  assert.equal(svg.includes('<circle'), false, 'lines-only means no markers');
});

test('the curve follows x order, not the order the points arrived in', () => {
  // A polyline joins points in sequence, so an unsorted sweep draws a zigzag across the plot.
  const shuffled = [SWEEP[3], SWEEP[0], SWEEP[8], SWEEP[5]];
  const model = sensLineModel(shuffled, OPTS);
  const svg = renderChart(model, defaultView(model));
  const pts = svg.match(/<polyline points="([^"]+)"/)[1].split(' ').map((p) => Number(p.split(',')[0]));
  assert.deepEqual(pts, [...pts].sort((a, b) => a - b), `zigzag: ${pts.join(' ')}`);
});

test('a user can still ask for the points back', () => {
  const model = sensLineModel(SWEEP, OPTS);
  const ids = chartUiSpec(model).controls.map((c) => c.id);
  assert.ok(ids.includes('mark'), 'the line/points choice is a control, not a fixed decision');
  const both = renderChart(model, { ...defaultView(model), mark: 'both' });
  assert.ok(both.includes('<polyline') && both.includes('<circle'));
});

test('break-even and each flip are named guides, not anonymous lines', () => {
  const model = sensLineModel(SWEEP, OPTS);
  assert.deepEqual(model.guides, [
    { axis: 'y', at: 0, label: 'NPV = 0' },
    { axis: 'x', at: 4, label: 'break-even' },
    { axis: 'x', at: 4, label: '→ Do nothing' },
  ]);
  const svg = renderChart(model, defaultView(model));
  assert.ok(svg.includes('break-even'));
  assert.ok(svg.includes('Do nothing'), 'the reader is told WHICH recommendation takes over');
});

test('the guides can be switched off, and say so in the panel', () => {
  const model = sensLineModel(SWEEP, OPTS);
  const ctl = chartUiSpec(model).controls.find((c) => c.id === 'guides');
  assert.ok(ctl && ctl.default === true);
  assert.equal(renderChart(model, { ...defaultView(model), guides: false }).includes('break-even'), false);
});

test('an off-scale guide is skipped rather than drawn on the frame', () => {
  // A guide pinned to the edge of the plot claims the crossing happens there, which is a
  // stronger and wronger statement than drawing nothing.
  const model = sensLineModel(SWEEP, { ...OPTS, threshold: 999, flips: [] });
  const svg = renderChart(model, defaultView(model));
  assert.equal(svg.includes('break-even'), false);
});

test('a sweep with nothing to say produces no chart', () => {
  // One point is a dot, not a curve; the summary line reports robustness in words.
  assert.equal(sensLineModel([{ x: 1, y: 2 }], OPTS), null);
  assert.equal(sensLineModel([], OPTS), null);
  assert.equal(sensLineModel(null, OPTS), null);
});

test('no threshold and no flips is a plain curve, not an empty guide list rendering', () => {
  const model = sensLineModel(SWEEP, { ...OPTS, reference: null, threshold: null, flips: [] });
  assert.deepEqual(model.guides, []);
  assert.equal(chartUiSpec(model).controls.some((c) => c.id === 'guides'), false);
  assert.ok(renderChart(model, defaultView(model)).includes('<polyline'));
});

test('the published figure carries the figure, not the instrument', () => {
  // The panel's live marker (where the slider currently sits) is deliberately absent: it is a
  // pointer for exploring, and a snapshot of a pointer means nothing to a later reader.
  const model = sensLineModel(SWEEP, OPTS);
  assert.equal('marker' in model, false);
  assert.equal('base' in model, false);
  assert.deepEqual(model.axes, { x: { title: 'Discount rate' }, y: { title: 'NPV' } });
  const svg = renderChart(model, defaultView(model));
  assert.ok(svg.includes('Discount rate') && svg.includes('NPV'), 'both axes titled');
});

// =============================================================================
// The tornado
// =============================================================================

/** Two parameters, one of which barely matters — the point of the chart. */
const MODEL = {
  label: 'NPV',
  outLabel: 'NPV',
  reference: 0,
  evalAt: (state, key, v) => ({ y: key === 'rate' ? 100 - v * 10 : 100 + v * 0.1 }),
};
const PARAMS = [{ key: 'rate', label: 'Discount rate', base: 5 }, { key: 'fee', label: 'Filing fee', base: 20 }];

test('sensTornado still ranks the inputs by how much they move the outcome', () => {
  const bars = sensTornado(MODEL, {}, PARAMS, 0.5);
  assert.deepEqual(bars.map((b) => b.label), ['Discount rate', 'Filing fee']);
  assert.ok(bars[0].swing > bars[1].swing);
});

test('the tornado is its own kind, with the base case and the axis named', () => {
  const model = tornadoModel(sensTornado(MODEL, {}, PARAMS, 0.5), { title: 'T', outLabel: 'NPV', baseline: 50 });
  assert.equal(model.kind, 'tornado');
  assert.equal(model.baseline, 50);
  assert.deepEqual(model.axes, { x: { title: 'NPV' } });
  const svg = renderChart(model, defaultView(model));
  assert.ok(svg.includes('base 50'), 'the datum every bar is read against must be labelled');
  assert.ok(svg.includes('Discount rate') && svg.includes('Filing fee'));
});

test('swing is computed by the kind, so the order can never disagree with the bars', () => {
  // The model deliberately does not carry `swing`: a number travelling separately from the bar
  // it describes is a number that can contradict it.
  const model = tornadoModel(sensTornado(MODEL, {}, PARAMS, 0.5), { title: 'T', outLabel: 'NPV' });
  assert.ok(model.rows.every((r) => !('swing' in r)));
  // And the funnel is enforced even when the rows arrive in the wrong order.
  const unsorted = {
    kind: 'tornado', title: 'T', baseline: 0,
    rows: [{ label: 'Small', lo: -1, hi: 1 }, { label: 'Huge', lo: -100, hi: 100 }],
  };
  const svg = renderChart(unsorted, defaultView(unsorted));
  assert.ok(svg.indexOf('Huge') < svg.indexOf('Small'), 'widest swing must come first');
});

test('the base line is drawn over the bars, never under them', () => {
  // A wide bar would otherwise hide the datum the whole figure is relative to.
  const model = { kind: 'tornado', title: 'T', baseline: 0, rows: [{ label: 'Wide', lo: -50, hi: 50 }] };
  const svg = renderChart(model, defaultView(model));
  assert.ok(svg.lastIndexOf('<rect') < svg.indexOf('base 0'));
});

test('a bar that straddles the base case reads as straddling it', () => {
  // The case where even the DIRECTION of the effect is uncertain — worth seeing.
  const model = { kind: 'tornado', title: 'T', baseline: 100, rows: [{ label: 'Uncertain', lo: 60, hi: 140 }] };
  const svg = renderChart(model, defaultView(model));
  const bar = svg.match(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/);
  const baseX = Number(svg.match(/<line x1="([\d.]+)"[^>]*stroke-dasharray="4 3"/)[1]);
  const [x, w] = [Number(bar[1]), Number(bar[2])];
  assert.ok(x < baseX && x + w > baseX, `bar ${x}..${x + w} should span the base at ${baseX}`);
});

test('nothing varying the outcome yields no chart, not an empty frame', () => {
  const flat = { ...MODEL, evalAt: () => ({ y: 100 }) };
  assert.deepEqual(sensTornado(flat, {}, PARAMS, 0.5), []);
  assert.equal(tornadoModel([], { title: 'T', outLabel: 'NPV' }), null);
  assert.equal(tornadoModel(null, { title: 'T' }), null);
});
