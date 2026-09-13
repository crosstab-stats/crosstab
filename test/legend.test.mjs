/**
 * @file legend.test.mjs
 * The legend: where it sits, and how its text is set.
 *
 * The legend was the last run of text on a chart that could not be adjusted —
 * title, axis titles and value labels all could — so a chart enlarged for a
 * slide kept one bit of 11px text looking like an oversight.
 *
 * The part worth pinning is not that the size applies, but that the LAYOUT
 * follows it. The frames reserve a right-hand margin by measuring the legend's
 * labels, and that measurement used a hard-coded 7px per character, correct only
 * while the size was fixed at 11. Reserving too little clips the text off the
 * canvas — which looks like a rendering bug, not like a setting.
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
/** The legend's own text nodes — the series labels, wherever they were drawn. */
const legendText = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /ern region$/.test(t));
const legendFontSizes = (svg) =>
  [...svg.matchAll(/<text[^>]*font-size="([\d.]+)"[^>]*>[^<]*ern region<\/text>/g)].map((m) => +m[1]);
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
  const bold = [...svg.matchAll(/<text[^>]*font-weight="600"[^>]*font-style="italic"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(bold.includes('Northern region'), 'the legend should be bold and italic');
});

test('a bigger legend gets more room, not a clipped one', () => {
  // The whole point of the size control is undone if the frame keeps reserving
  // space for 11px text: the labels simply run off the canvas.
  const small = draw({ legendSize: 9 });
  const large = draw({ legendSize: 22 });
  assert.ok(plotRight(large) < plotRight(small), 'the plot must give up width to a larger legend');
  // And the text still fits: its start plus its length stays on the canvas.
  const startOf = (svg) => {
    const m = svg.match(/<text x="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>Northern region</);
    return { x: +m[1], size: +m[2] };
  };
  const { x, size } = startOf(large);
  assert.ok(x + 'Northern region'.length * size * 0.62 <= CANVAS, 'the legend must not run off the canvas');
});

test('inside placements sit over the plot and reserve no margin', () => {
  const outside = draw({ legend: 'right' });
  const insides = ['inside-tl', 'inside-tr', 'inside-bl', 'inside-br'];
  for (const legend of insides) {
    const svg = draw({ legend });
    assert.deepEqual(legendText(svg), ['Northern region', 'Southern region'], legend);
    assert.ok(plotRight(svg) > plotRight(outside), `${legend} should give the plot its width back`);
    // Over the data means over a bar, so the text needs a plate behind it.
    assert.match(svg, /fill="#fff" fill-opacity="0\.82"/, `${legend} should draw a backing plate`);
  }
});

test('the four corners are actually four different corners', () => {
  const at = (legend) => {
    const svg = draw({ legend });
    const m = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>Northern region</);
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
