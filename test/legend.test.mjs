/**
 * @file legend.test.mjs
 * The legend: where it sits, and how its text is set.
 *
 * The legend was the last run of text on a chart that could not be adjusted —
 * title, axis titles and value labels all could — so a chart enlarged for a
 * slide kept one bit of 11px text looking like an oversight.
 *
 * It is now a floating LAYER, and that is what most of this file pins. The plot used
 * to hand the legend a right-hand margin measured from the longest label, capped at
 * 260 — so the data decided the composition, and past the cap the text was clipped
 * instead (at the DEFAULT size, with 45-character labels, it was already there).
 * Nothing is reserved any more: the legend has its own width, wraps to it, and
 * overlaps the plot if the user makes it big enough. Room is bought back with
 * `plotSize`, not taken automatically.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');

const { defaultView, renderChart, chartUiSpec, controlVisible } = await import('../core/chart-renderer.js');

const MODEL = {
  kind: 'categorical',
  title: 'Region by year',
  categories: [{ key: '2020', label: '2020' }, { key: '2024', label: '2024' }],
  series: [
    { key: 'a', label: 'Northern region', values: [30, 10] },
    { key: 'b', label: 'Southern region', values: [10, 30] },
  ],
  axes: { x: { title: 'Year' }, y: { title: 'Count' } },
};

const draw = (view = {}) => renderChart(MODEL, { ...defaultView(MODEL), ...view });
/**
 * The legend's entries, one string each, with any wrapped lines rejoined.
 *
 * A wrapped entry is a single `<text>` holding one `<tspan>` per line, so an entry is
 * still one node however it was broken — which is the reason it is built that way.
 */
const legendEntries = (svg) =>
  [...svg.matchAll(/<text class="ct-legend-text"[^>]*>(.*?)<\/text>/g)]
    .map((m) => m[1].replace(/<tspan[^>]*>/g, ' ').replace(/<\/tspan>/g, '').trim().replace(/\s+/g, ' '));
/** Alias kept for the assertions that only care about which entries were drawn. */
const legendText = legendEntries;
const legendFontSizes = (svg) =>
  [...svg.matchAll(/<text class="ct-legend-text"[^>]*font-size="([\d.]+)"/g)].map((m) => +m[1]);
/** The x where the plot area ends — everything right of it is legend margin. */
const plotRight = (svg) => {
  // The x-axis rule runs the width of the plot box.
  const m = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="\2"/g)];
  return Math.max(...m.map((x) => +x[3]));
};
const CANVAS = 720;

test('the legend draws its series, and defaults to 11px', () => {
  const svg = draw();
  assert.deepEqual(legendText(svg), ['Northern region', 'Southern region']);
  assert.deepEqual(legendFontSizes(svg), [11, 11]);
});

test('size, bold and italic reach the legend text', () => {
  const svg = draw({ legendSize: 18, legendBold: true, legendItalic: true });
  assert.deepEqual(legendFontSizes(svg), [18, 18]);
  // At 18px the label no longer fits the default 150-wide legend, so it WRAPS — which
  // is the new behaviour in one line: it used to be cut to "Northern regio…" and now
  // the entry grows downwards instead. Rejoined, the words are all still there.
  assert.deepEqual(legendEntries(svg), ['Northern region', 'Southern region']);
  const styled = [...svg.matchAll(/<text class="ct-legend-text"[^>]*font-weight="600"[^>]*font-style="italic"/g)];
  assert.equal(styled.length, 2, 'both entries should be bold and italic');
});

test('a long label WRAPS rather than losing its tail', () => {
  // The thing the old hard `clip(label, 26)` could not do at any size or any width.
  const long = {
    ...MODEL,
    series: [
      { key: 'a', label: 'Strongly agree with the proposition as stated', values: [30, 10] },
      { key: 'b', label: 'Somewhat disagree with the proposition', values: [10, 30] },
    ],
  };
  const svg = renderChart(long, { ...defaultView(long), legend: 'right' });
  assert.deepEqual(legendEntries(svg), [
    'Strongly agree with the proposition as stated',
    'Somewhat disagree with the proposition',
  ], 'every word survives');
  assert.ok(!svg.includes('…'), 'and nothing was ellipsised');
  // Several lines means several tspans, inside ONE text node per entry.
  assert.ok((svg.match(/<tspan/g) || []).length >= 4, 'the entries were broken into lines');
});

test('a wider legend fits more per line — and does NOT shrink the plot', () => {
  // Both halves matter. The first is that the control does something; the second is
  // that it is a layer, so buying the legend more room is not paid for by the data.
  const narrow = draw({ legendWidth: 80 });
  const wide = draw({ legendWidth: 400 });
  const lines = (svg) => (svg.match(/<tspan/g) || []).length;
  assert.ok(lines(narrow) > lines(wide), 'a narrow legend wraps more');
  assert.equal(plotRight(narrow), plotRight(wide), 'the plot keeps its width either way');
});

test('THE LAYER CONTRACT: legend text size does not move the plot', () => {
  // The inversion. The plot used to give up width as the legend's text grew, so the
  // data's own area depended on a font setting — and because the reservation was
  // capped at 260, past that point it stopped giving and started clipping anyway.
  const small = draw({ legendSize: 9 });
  const large = draw({ legendSize: 22 });
  assert.equal(plotRight(large), plotRight(small), 'the plot is the same size either way');
  // The text stays on the canvas because it wraps to the legend's width, not because
  // something measured it and took the room from somewhere else.
  const starts = [...large.matchAll(/<text class="ct-legend-text" x="([\d.]+)"/g)].map((m) => +m[1]);
  assert.ok(starts.length, 'the legend drew something');
  for (const x of starts) assert.ok(x < CANVAS, `a legend entry started off-canvas at ${x}`);
});

test('plotSize is how the user buys the room back', () => {
  // With nothing reserved automatically, this is the lever that resolves an overlap —
  // so it has to actually move the plot's edge.
  const full = draw({ plotSize: 100 });
  const small = draw({ plotSize: 70 });
  assert.ok(plotRight(small) < plotRight(full), 'a smaller plot really is smaller');
});

test('inside placements sit over the plot and reserve no margin', () => {
  const outside = draw({ legend: 'right' });
  const insides = ['inside-tl', 'inside-tr', 'inside-bl', 'inside-br'];
  for (const legend of insides) {
    const svg = draw({ legend });
    assert.deepEqual(legendText(svg), ['Northern region', 'Southern region'], legend);
    assert.ok(plotRight(svg) > plotRight(outside), `${legend} should give the plot its width back`);
    // Over the data means over a bar, so the text needs a plate behind it. Every
    // placement carries one now — floating is the default, so what used to be the
    // trap for one opt-in placement would otherwise be the trap for all of them —
    // and at 0.92 rather than 0.82, which keeps #333 past WCAG 1.4.3's 4.5:1 over a
    // saturated bar instead of landing around 3.5:1.
    assert.match(svg, /class="ct-legend-plate"[^>]*fill-opacity="0\.92"/, `${legend} should draw a backing plate`);
  }
});

test('the backing panel can be switched off', () => {
  assert.ok(draw({ legend: 'right' }).includes('ct-legend-plate'), 'on by default');
  assert.ok(!draw({ legend: 'right', legendPlate: false }).includes('ct-legend-plate'), 'and off on request');
});

test('the four corners are actually four different corners', () => {
  const at = (legend) => {
    const svg = draw({ legend });
    const m = svg.match(/<text class="ct-legend-text" x="([\d.]+)" y="([\d.]+)"/);
    return { x: +m[1], y: +m[2] };
  };
  const tl = at('inside-tl');
  const tr = at('inside-tr');
  const bl = at('inside-bl');
  const br = at('inside-br');
  assert.ok(tl.x < tr.x, 'left corners are left of right ones');
  assert.ok(bl.x < br.x);
  assert.ok(tl.y < bl.y, 'top corners are above bottom ones');
  assert.ok(tr.y < br.y);
});

test('hidden means hidden, whatever the formatting says', () => {
  assert.deepEqual(legendText(draw({ legend: 'none', legendSize: 20 })), []);
});

test('the formatting controls appear only when there is a legend to format', () => {
  const controls = chartUiSpec(MODEL).controls;
  const view = defaultView(MODEL);
  for (const id of ['legendSize', 'legendBold', 'legendItalic']) {
    const c = controls.find((x) => x.id === id);
    assert.ok(c, `missing ${id}`);
    assert.equal(c.group, 'Legend', `${id} should sit with the legend`);
    assert.ok(controlVisible(c, { ...view, legend: 'right' }, controls), `${id} hidden with a legend shown`);
    assert.ok(controlVisible(c, { ...view, legend: 'inside-br' }, controls), `${id} hidden for an inside legend`);
    assert.ok(!controlVisible(c, { ...view, legend: 'none' }, controls), `${id} shown with no legend`);
  }
});

test('every placement the control offers actually renders', () => {
  const placement = chartUiSpec(MODEL).controls.find((c) => c.id === 'legend');
  assert.ok(placement, 'the legend needs a placement control');
  for (const [value] of placement.options) {
    const svg = draw({ legend: value });
    const shown = legendText(svg).length;
    assert.equal(shown, value === 'none' ? 0 : 2, `placement "${value}" drew ${shown} entries`);
  }
});
