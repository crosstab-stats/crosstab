/**
 * @file colour-scale-layer.test.mjs
 * A continuous colour scale as a host-drawn layer — the choropleth's key (#204).
 *
 * ## The gap this closes
 *
 * Every baked figure's furniture became editable in 2026-10-16: title, caption, legend
 * text and position all became live layers over a foreign SVG. One did not. `sf` draws
 * the choropleth's colour bar INSIDE the panel (`key.pos = 1`), so by the time the host
 * saw the figure the key was path data — unmovable, unrewordable, and the only frozen
 * furniture left in the app. The 2026-10-24 closure of Layer 3b named this specifically
 * as what remained: "migration, one figure at a time, when a blocker is specific enough
 * to name", and the blocker was that `legendBlock` has no shape for a ramp.
 *
 * ## Why a scale is not a legend with different data
 *
 * A legend is a row per category and the reader matches one to one. A scale is a ramp
 * with a value axis — the reader INTERPOLATES, and the meaning is carried by the order of
 * the colours and the numbers at the ends.
 *
 * It is drawn CLASSED rather than smooth, which is the honest choice: `sf` bins the
 * variable before shading, so the map really is a handful of discrete colours. A smooth
 * gradient would promise a precision the map does not have, and a reader taking a colour
 * halfway between two swatches to mean a value halfway between two breaks would be
 * reading something that was never drawn.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { scaleBlock } = await import('../core/charts/stdlib.js');
const { bakedModel } = await import('../core/charts/baked.js');
const { getChartKind } = await import('../core/charts/runtime.js');

const baked = getChartKind('baked');
const SPATIAL = readFileSync('plugins/builtin-spatial/index.js', 'utf8');
const SVG = '<svg viewBox="0 0 10 10"></svg>';
const BOX = { x0: 20, y0: 40, x1: 320, y1: 240 };
const SCALE = {
  min: 0, max: 100, breaks: [0, 25, 50, 75, 100],
  colors: ['#f7fcf0', '#ccebc5', '#7bccc4', '#2b8cbe', '#084081'], label: 'Median income',
};

// ---------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------

test('a scale draws one block per class, with the breaks labelled', () => {
  const svg = scaleBlock(SCALE, 'bottom', BOX, {});
  // Five colours plus the outline.
  assert.equal((svg.match(/<rect/g) || []).length, SCALE.colors.length + 1);
  for (const b of SCALE.breaks) assert.ok(svg.includes(`>${b}<`), `tick ${b}`);
  assert.ok(svg.includes('Median income'), 'and the label');
});

test('it is CLASSED, not a gradient', () => {
  // A smooth ramp would claim a precision the map does not have: sf bins before shading.
  const svg = scaleBlock(SCALE, 'bottom', BOX, {});
  assert.ok(!/linearGradient|stop-color/.test(svg), 'no gradient');
});

test('it occupies the legend LAYER, so it inherits placement and dragging', () => {
  // Not a fourth layer: the figure has a scale or a legend, never both, and reusing the
  // slot means position, size, drag and persistence all work with no new controls.
  const svg = scaleBlock(SCALE, 'bottom', BOX, {});
  assert.match(svg, /ct-layer--legend/);
  assert.equal(scaleBlock(SCALE, 'none', BOX, {}), '', 'and "none" hides it');
});

test('a vertical scale puts the HIGHEST value at the top', () => {
  // A vertical bar reads like an axis. Inverting it is a misreading waiting to happen.
  const svg = scaleBlock(SCALE, 'right', BOX, {});
  const texts = [...svg.matchAll(/<text[^>]*y="([\d.]+)"[^>]*>([\d.]+)</g)]
    .map((m) => ({ y: Number(m[1]), v: Number(m[2]) }))
    .filter((t) => Number.isFinite(t.v));
  assert.ok(texts.length >= 2, 'ticks are labelled');
  const top = texts.reduce((a, b) => (a.y < b.y ? a : b));
  const bottom = texts.reduce((a, b) => (a.y > b.y ? a : b));
  assert.ok(top.v > bottom.v, `expected the larger value above: ${top.v} at y=${top.y} vs ${bottom.v} at y=${bottom.y}`);
});

test('ticks are not invented when the plugin sends no breaks', () => {
  // A tick the data did not justify is a number a reader will quote back.
  const svg = scaleBlock({ min: 2, max: 8, colors: ['#111', '#999'] }, 'bottom', BOX, {});
  const nums = [...svg.matchAll(/>([\d.]+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(nums.sort((a, b) => a - b), [2, 8], 'the two ends only');
});

// ---------------------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------------------

test('a scale that cannot be drawn honestly is dropped whole', () => {
  // One colour is not a scale; a non-finite range cannot be labelled.
  assert.equal(bakedModel({ svg: SVG, scale: { min: 0, max: 1, colors: ['#111'] } }).scale, null);
  assert.equal(bakedModel({ svg: SVG, scale: { min: NaN, max: 1, colors: ['#1', '#2'] } }).scale, null);
  assert.equal(bakedModel({ svg: SVG, scale: 'nonsense' }).scale, null);
  assert.equal(bakedModel({ svg: SVG }).scale, null, 'and absent stays absent');
});

test('a figure draws its scale OR its legend, never both', () => {
  const m = bakedModel({
    svg: SVG, scale: SCALE,
    legend: [{ key: 'a', label: 'A', color: '#111' }, { key: 'b', label: 'B', color: '#222' }],
  });
  const svg = baked.render(m, { legend: 'bottom' });
  assert.ok(svg.includes('Median income'), 'the scale won');
  assert.ok(!svg.includes('>A<'), 'and the category legend is not also drawn');
  // Colour items are empty for a scale: its colours are not per-row and are never
  // editable, because the host cannot repaint R's picture to match.
  assert.deepEqual(baked.colorItems(m), []);
  assert.equal(baked.colorEditable, false);
});

test('a scale defaults to the bottom, a legend to the right', () => {
  // Where sf drew it, and where a horizontal bar fits a map's aspect.
  assert.equal(baked.baseView(bakedModel({ svg: SVG, scale: SCALE })).legend, 'bottom');
  assert.equal(baked.baseView(bakedModel({
    svg: SVG, legend: [{ key: 'a', label: 'A', color: '#111' }],
  })).legend, 'right');
  assert.equal(baked.baseView(bakedModel({ svg: SVG })).legend, 'none');
});

// ---------------------------------------------------------------------------------------
// The plugin: one definition of the colours, or the key lies
// ---------------------------------------------------------------------------------------

test('appendPlot FORWARDS the scale, which is where the first attempt died', () => {
  // `appendPlot` builds its own options object for `bakedModel`, so a field added to the
  // model and not added there arrives as undefined -- the feature tests green and does
  // nothing in the app. That happened twice in one day: `redraw.args` in #203 and `scale`
  // here. Pinned for every field the model takes from a plugin, not just this one.
  const pane = readFileSync('core/results-pane.js', 'utf8');
  const at = pane.indexOf('return this.appendChart(bakedModel({');
  assert.ok(at > 0, 'appendPlot builds a baked model');
  const body = pane.slice(at, pane.indexOf('}));', at));
  for (const field of ['svg', 'title', 'caption', 'legend', 'scale', 'params', 'redraw']) {
    assert.ok(body.includes(`${field}:`), `appendPlot forwards ${field}`);
  }
});

test('R stops drawing its own key', () => {
  assert.match(SPATIAL, /key\.pos = NULL/);
  assert.ok(!/key\.pos = 1/.test(SPATIAL), 'the baked key is gone');
});

test('the breaks and palette are defined ONCE and used for both the map and the key', () => {
  // The rule this figure exists to demonstrate: "state the colours once so the R call and
  // the key cannot drift". A second `hcl.colors` call for the key would diverge the moment
  // either side changed.
  assert.equal((SPATIAL.match(/hcl\.colors\(/g) || []).length, 1, 'one palette call');
  assert.match(SPATIAL, /breaks = brks, pal = cols/, 'the plot uses both');
  assert.match(SPATIAL, /scaleBreaks = brks, scaleColors = cols/, 'and so does the key');
  // Equal intervals, chosen because the host has to LABEL the bar and cannot label a
  // classing rule it cannot see.
  assert.match(SPATIAL, /seq\(lo, hi, length\.out = nCls \+ 1\)/);
});

test('a single distinct value still draws rather than dividing by zero', () => {
  // One region, or every region equal: there is no range to divide into classes.
  assert.match(SPATIAL, /hi <= lo/, 'the degenerate range is widened');
  assert.match(SPATIAL, /length\(vals\) == 0/, 'and no matches is reported, not plotted');
});
