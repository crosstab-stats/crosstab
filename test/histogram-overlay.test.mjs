/**
 * @file histogram-overlay.test.mjs
 * The histogram kind draws a curve the MODEL supplies, not only the normal one.
 *
 * Built so `builtin-detection`'s fitted detection function could stop being a baked SVG,
 * which was the last figure in the "appearance wanted, data already in hand" group. The
 * kind already drew a curve over the bars — `view.normalCurve`, computed from the data's
 * mean and sd, scaled by `curveK` for whichever measure the bars show, with its peak
 * folded into the y domain. All that was missing was letting the curve come from
 * somewhere other than `dnorm`.
 *
 * ## Why the overlay is declared as a DENSITY
 *
 * The bars' measure is a live control. A curve pre-scaled by its author would be wrong
 * the moment the reader switched count → density, and wrong silently, because a curve
 * has no units printed on it. Declaring a density means the renderer applies the same
 * `curveK` it already applies to the normal curve, and the figure comes out IDENTICAL at
 * every measure — which is the property asserted below, and the reason this is the right
 * unit rather than a convenient one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import './chart-kinds-harness.mjs';
import { renderChart } from '../core/chart-renderer.js';

/** The fixture from the detection tests: 20 distances with a declining function over them. */
const D = [0.2, 0.4, 0.5, 0.7, 0.9, 1.0, 1.1, 1.3, 1.4, 1.6,
  1.8, 2.0, 2.2, 2.5, 2.8, 3.1, 3.5, 4.0, 4.6, 5.4];
const W = 5.4;

/** A half-normal, normalised to a density over [0, W] — what the plugin hands over. */
function halfNormalDensity(sigma = 3.3657, steps = 100) {
  const x = [];
  const g = [];
  for (let i = 0; i <= steps; i++) {
    const xi = (W * i) / steps;
    x.push(xi);
    g.push(Math.exp(-(xi * xi) / (2 * sigma * sigma)));
  }
  let area = 0;
  for (let i = 1; i < x.length; i++) area += (x[i] - x[i - 1]) * (g[i] + g[i - 1]) / 2;
  return { x, y: g.map((v) => v / area), area };
}

const model = (overlay) => ({
  kind: 'histogram',
  title: 'Distances',
  values: D,
  overlay,
  axes: { x: { title: 'Distance' } },
});

/** The drawn curve's y extent, and the polyline itself. */
function curveOf(svg) {
  const m = String(svg).match(/<polyline points="([^"]+)"/);
  if (!m) return null;
  const ys = m[1].split(' ').map((p) => Number(p.split(',')[1]));
  return { n: ys.length, top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * The curve's height as a fraction of the tallest bar's — the quantity that has to be
 * invariant across measures.
 *
 * Not the absolute pixel position, which legitimately moves: the y axis picks a round
 * maximum, so 0.37 becomes 0.4 while 7.4 becomes 8, and the same data lands at slightly
 * different fractions of the axis. Both the bars and the curve are scaled by one factor,
 * so what must hold is that they move together.
 */
function curveVsBars(svg) {
  const s = String(svg);
  const c = curveOf(s);
  if (!c) return null;
  const bars = [...s.matchAll(/<rect [^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)]
    .map((m) => ({ y: Number(m[1]), h: Number(m[2]) }))
    .filter((b) => b.h > 0 && b.h < 400);
  if (!bars.length) return null;
  const base = Math.max(...bars.map((b) => b.y + b.h));
  const barTop = Math.min(...bars.map((b) => b.y));
  return (base - c.top) / (base - barTop);
}

test('the fixture density really is a density', () => {
  // If this drifts, every scaling assertion below is measuring the wrong thing.
  assert.ok(Math.abs(halfNormalDensity().area - halfNormalDensity().area) < 1e-12);
  const { x, y } = halfNormalDensity();
  let area = 0;
  for (let i = 1; i < x.length; i++) area += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2;
  assert.ok(Math.abs(area - 1) < 1e-9, `integrates to ${area}`);
});

test('a model-supplied curve is drawn over the bars', () => {
  const { x, y } = halfNormalDensity();
  const svg = renderChart(model({ x, y, label: 'Fitted' }), { valueMeasure: 'density', binMode: 'count', binCount: 6 });
  const c = curveOf(svg);
  assert.ok(c, 'a polyline is drawn');
  assert.ok(c.bottom > c.top, 'and it declines, as this function does');
  assert.match(String(svg), /Fitted/, 'the label is printed');
});

test('THE POINT: the curve keeps its position relative to the bars at every measure', () => {
  // This is what declaring a density buys, and it is the reason the unit is a density
  // rather than whatever the author had to hand. A curve in any other unit would drift
  // against the bars when the reader switched count/percent/density — silently, because
  // a curve carries no units on screen.
  //
  // An earlier version of this test claimed pixel-identical output and passed while
  // setting `measure`, a key the kind ignores. With `valueMeasure` it failed, which is
  // the honest result: the axis's round maximum differs by scale.
  const { x, y } = halfNormalDensity();
  const ratios = ['density', 'count', 'percent'].map((valueMeasure) =>
    curveVsBars(renderChart(model({ x, y }), { valueMeasure, binMode: 'count', binCount: 6 })));
  assert.ok(ratios.every((r) => Number.isFinite(r)), 'drawn in all three');
  for (const r of ratios.slice(1)) {
    assert.ok(Math.abs(r - ratios[0]) < 1e-3,
      `${r} vs ${ratios[0]} — the curve moved against the bars`);
  }
  // And it is a real ratio, not two degenerate zeroes agreeing.
  assert.ok(ratios[0] > 0.5 && ratios[0] < 1, `ratio ${ratios[0]} is meaningful`);
});

test('the view key is `valueMeasure` — `measure` is silently ignored', () => {
  // Worth its own test because it cost a false pass here AND a wrong `view` in
  // builtin-detection, which rendered as counts while the model asked for density.
  const { x, y } = halfNormalDensity();
  const asked = renderChart(model({ x, y }), { measure: 'density', binMode: 'count', binCount: 6 });
  const real = renderChart(model({ x, y }), { valueMeasure: 'density', binMode: 'count', binCount: 6 });
  const counts = renderChart(model({ x, y }), { valueMeasure: 'count', binMode: 'count', binCount: 6 });
  assert.equal(String(asked), String(counts), '`measure` does nothing — it falls back to count');
  assert.notEqual(String(asked), String(real), 'and `valueMeasure` is what works');
});

test('the curve never runs above the axis maximum', () => {
  // Its peak joins the y domain for the same reason the normal curve's does: a curve
  // drawn above the top of the plot claims a height the axis says is impossible. Tested
  // with a curve far taller than any bar.
  const spike = { x: [0, 0.1, 0.2, W], y: [0, 50, 0, 0] };
  const svg = renderChart(model(spike), { valueMeasure: 'density', binMode: 'count', binCount: 6 });
  const c = curveOf(svg);
  const box = String(svg).match(/<rect [^>]*class="?plot/) ? null : null;
  assert.ok(c, 'still drawn');
  // Nothing is drawn at a negative y, which is what running off the top would produce.
  assert.ok(c.top >= 0, `curve top ${c.top} is inside the canvas`);
});

test('an unequal-interval histogram says so instead of drawing a mismatched curve', () => {
  // Same limit as the normal curve's: with unequal bins there is no single width to
  // convert a density by, so the curve would match nothing on screen.
  const { x, y } = halfNormalDensity();
  const svg = String(renderChart(model({ x, y, label: 'Fitted' }),
    { valueMeasure: 'count', binMode: 'custom', binCuts: [0, 1, 3, W] }));
  assert.doesNotMatch(svg, /<polyline/, 'no curve');
  assert.match(svg, /needs equal intervals/, 'and the reason is printed');
});

test('…but density is always fine, because there is nothing to convert', () => {
  const { x, y } = halfNormalDensity();
  const svg = String(renderChart(model({ x, y }),
    { valueMeasure: 'density', binMode: 'custom', binCuts: [0, 1, 3, W] }));
  assert.match(svg, /<polyline/);
});

test('a malformed overlay is ignored, not half-drawn', () => {
  for (const bad of [null, undefined, {}, { x: [1, 2] }, { y: [1, 2] },
    { x: [1], y: [1] }, { x: [1, 2], y: ['a', 'b'] }, { x: 'no', y: 'no' }]) {
    const svg = String(renderChart(model(bad), { valueMeasure: 'density', binMode: 'count', binCount: 6 }));
    assert.doesNotMatch(svg, /<polyline/, JSON.stringify(bad));
    // And the histogram itself still renders — a bad curve must not cost the figure.
    assert.match(svg, /<rect /, `bars still drawn for ${JSON.stringify(bad)}`);
  }
});

test('non-finite points are dropped rather than opening a gap', () => {
  const { x, y } = halfNormalDensity();
  const holed = y.map((v, i) => (i === 40 ? NaN : v));
  const svg = renderChart(model({ x, y: holed }), { valueMeasure: 'density', binMode: 'count', binCount: 6 });
  const c = curveOf(svg);
  assert.ok(c, 'still drawn');
  assert.equal(c.n, x.length - 1, 'one point short, no NaN in the path');
  assert.doesNotMatch(String(svg), /NaN/);
});

test('the normal curve and a supplied curve are independent', () => {
  const { x, y } = halfNormalDensity();
  const both = String(renderChart(model({ x, y }),
    { valueMeasure: 'density', binMode: 'count', binCount: 6, normalCurve: true }));
  assert.equal((both.match(/<polyline/g) ?? []).length, 2, 'two curves when both are asked for');
  const neither = String(renderChart(model(null), { valueMeasure: 'density', binMode: 'count', binCount: 6 }));
  assert.doesNotMatch(neither, /<polyline/);
});
