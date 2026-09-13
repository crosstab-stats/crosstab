/**
 * @file categorical-measure.test.mjs
 * Counts shown as counts or as percentages — the `valueMeasure` view control.
 *
 * Counts and percentages are the same numbers shown two ways, so which one is on
 * screen is a view setting, not a question answered in a dialog that has since
 * closed. Two things make that worth pinning. The conversion has TWO
 * denominators — a share within each category when there are several series, a
 * share of all cases when there is one — and picking the wrong one produces a
 * chart that is plausible and wrong. And the control must be absent, not merely
 * ignored, on a model whose values are group MEANS, where a percentage of
 * anything is nonsense.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');

const { defaultView, renderChart, chartUiSpec } = await import('../core/chart-renderer.js');

/** One series: 120 / 60 / 20 of 200 cases — so the percentages (60/30/10) are
 * different numbers from the counts, and a chart that quietly failed to convert
 * cannot pass by looking right. */
const ONE = {
  kind: 'categorical',
  title: 'Region',
  counts: true,
  categories: [{ key: 'n', label: 'North' }, { key: 'c', label: 'Central' }, { key: 's', label: 'South' }],
  series: [{ key: 'all', label: 'Count', values: [120, 60, 20] }],
  axes: { x: { title: 'Region' } },
};

/** Two series, so "percent" means the mix WITHIN each category. */
const TWO = {
  kind: 'categorical',
  title: 'Region by year',
  counts: true,
  categories: [{ key: '2020', label: '2020' }, { key: '2024', label: '2024' }],
  series: [
    { key: 'a', label: 'A', values: [30, 10] }, // 2020: 30/40 = 75%   2024: 10/40 = 25%
    { key: 'b', label: 'B', values: [10, 30] },
  ],
  axes: { x: { title: 'Year' } },
};

/** No `counts` flag: these are group means, not case counts. */
const MEANS = {
  kind: 'categorical',
  title: 'Mean income by region',
  categories: [{ key: 'n', label: 'North' }, { key: 's', label: 'South' }],
  series: [{ key: 'm', label: 'Mean income', values: [42000, 38000] }],
  axes: { x: { title: 'Region' }, y: { title: 'Mean income' } },
};

const draw = (model, view = {}) => renderChart(model, { ...defaultView(model), ...view });
const controlIds = (model) => chartUiSpec(model).controls.map((c) => c.id);
const hasText = (svg, t) => svg.includes(`>${t}<`);

test('a counts model offers the switch; a means model does not', () => {
  assert.ok(controlIds(ONE).includes('valueMeasure'));
  assert.ok(controlIds(TWO).includes('valueMeasure'));
  assert.ok(!controlIds(MEANS).includes('valueMeasure'), 'a percentage of a mean is nonsense');
});

test('counts are drawn unchanged by default', () => {
  const svg = draw(ONE, { valueLabels: true });
  for (const n of ['120', '60', '20']) assert.ok(hasText(svg, n), `expected a ${n} label`);
  assert.ok(hasText(svg, 'Count'), 'the y axis should say Count');
});

test('one series: percent is of ALL cases', () => {
  const svg = draw(ONE, { valueMeasure: 'percent', valueLabels: true });
  for (const n of ['60', '30', '10']) assert.ok(hasText(svg, n), `120/60/20 of 200 → ${n}%`);
  // And the counts themselves are gone from the picture, so the conversion is
  // real rather than an extra label alongside the old scale.
  assert.ok(!hasText(svg, '120'), 'the count scale should be gone');
  assert.ok(hasText(svg, 'Percent of all cases'), 'the axis should name which percent');
});

test('several series: percent is WITHIN each category', () => {
  // 30 of 40 is 75% within 2020 — NOT 30 of 80 (37.5% of the grand total), which
  // is the plausible wrong answer.
  const svg = draw(TWO, { valueMeasure: 'percent', valueLabels: true });
  assert.ok(hasText(svg, '75'), 'expected 75% within 2020');
  assert.ok(hasText(svg, '25'), 'expected 25% within 2020');
  assert.ok(!hasText(svg, '37.5'), 'that would be a share of the grand total');
  assert.ok(hasText(svg, 'Percent within each category'));
});

test('each category of a multi-series percent view sums to 100', () => {
  const svg = draw(TWO, { valueMeasure: 'percent', valueLabels: true });
  // 2020 is 75/25 and 2024 is 25/75 — each category's shares add to 100 whatever
  // the counts behind them were.
  assert.equal([...svg.matchAll(/>75</g)].length, 2);
  assert.equal([...svg.matchAll(/>25</g)].length, 2);
});

test('the option says which percent it means', () => {
  const one = chartUiSpec(ONE).controls.find((c) => c.id === 'valueMeasure');
  const two = chartUiSpec(TWO).controls.find((c) => c.id === 'valueMeasure');
  assert.deepEqual(one.options.map(([, l]) => l), ['Count', 'Percent of all cases']);
  assert.deepEqual(two.options.map(([, l]) => l), ['Count', 'Percent within each category']);
});

test('a means chart keeps its own y-axis title and its values', () => {
  const svg = draw(MEANS, { valueLabels: true, valueMeasure: 'percent' }); // control absent; value ignored
  assert.ok(hasText(svg, 'Mean income'));
  assert.ok(hasText(svg, '42,000') || hasText(svg, '42000'), 'the means must not be rescaled');
});

test('a chart saved before the switch existed renders exactly as it did', () => {
  // Its model has no `counts` flag and its values are already percentages.
  const legacy = { ...ONE, counts: undefined, series: [{ key: 'all', label: 'Valid percent', values: [60, 30, 10] }],
    axes: { x: { title: 'Region' }, y: { title: 'Valid percent' } } };
  const svg = draw(legacy, { valueLabels: true });
  assert.ok(hasText(svg, 'Valid percent'), 'its own y title is still used');
  assert.ok(!controlIds(legacy).includes('valueMeasure'));
});

test('an empty category contributes no percentage instead of dividing by zero', () => {
  const model = { ...TWO, series: [
    { key: 'a', label: 'A', values: [0, 10] },
    { key: 'b', label: 'B', values: [0, 30] },
  ] };
  const svg = draw(model, { valueMeasure: 'percent' });
  assert.ok(!/NaN|Infinity/.test(svg), 'an all-zero category must not produce NaN');
});

/** Every bar's geometry, so "did the picture change" is a measurement. */
const bars = (svg) =>
  [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
    .filter((b) => b.w < 700); // not the frame's white background

/** Each bar's height as a fraction of the tallest — the SHAPE, independent of
 * whatever the axis happens to top out at. */
const shape = (svg) => {
  const hs = bars(svg).map((b) => b.h);
  const max = Math.max(...hs);
  return hs.map((h) => (h / max).toFixed(4)).join(' ');
};

test('with ONE series, percent is a rescale: the picture keeps its shape', () => {
  // Worth stating because it is easy to claim otherwise. 120/60/20 of 200 become
  // 60/30/10, and those are the same bars — the reader is told which quantity
  // they are looking at by the AXIS, not by the drawing.
  const c = draw(ONE, { valueMeasure: 'count' });
  const p = draw(ONE, { valueMeasure: 'percent' });
  assert.equal(shape(p), shape(c));
  assert.equal(shape(c), '1.0000 0.5000 0.1667');
  // Absolute pixel heights may still differ, because a "nice" axis maximum is
  // not proportional between the two scales (120 rounds up to 150; 60 does not
  // round at all). That scales every bar by the SAME factor, which is a zoom,
  // not a change of shape.
});

test('with SEVERAL series, percent genuinely redraws the chart', () => {
  // 2020 is 30 vs 60 in 2024 — half the height. As a share within its own year
  // it is 75% against 50%, so the taller bar becomes the shorter one. This is
  // the case where the two views are different claims about the data, not two
  // labellings of one.
  const model = {
    ...TWO,
    series: [
      { key: 'a', label: 'A', values: [30, 60] },
      { key: 'b', label: 'B', values: [10, 60] },
    ],
  };
  const c = shape(draw(model, { valueMeasure: 'count' }));
  const p = shape(draw(model, { valueMeasure: 'percent' }));
  assert.notEqual(p, c);
  const cH = bars(draw(model, { valueMeasure: 'count' })).map((b) => b.h);
  const pH = bars(draw(model, { valueMeasure: 'percent' })).map((b) => b.h);
  assert.ok(cH[0] < cH[2], 'in counts, 2020 A is shorter than 2024 A');
  assert.ok(pH[0] > pH[2], 'in percentages, 2020 A is TALLER than 2024 A');
});

test('the control and the drawing never disagree about the measure', () => {
  // This control was briefly `yMeasure` (bar/line/histogram) and `pieLabel`
  // (pie) before the two were recognised as one question. A chart saved under
  // either resets to the default rather than being migrated, DELIBERATELY: the
  // widget reads `valueMeasure` through the host's generic descriptor engine,
  // which knows nothing about aliases, so honouring a legacy key would draw
  // percentages under a select reading "Count". What the panel says and what
  // the chart shows have to be the same thing.
  const legacy = renderChart(ONE, { ...defaultView(ONE), yMeasure: 'percent', valueLabels: true });
  assert.ok(legacy.includes('>120<'), 'a stale key is ignored, so the chart shows counts');
  assert.ok(!legacy.includes('Percent of all cases'), 'and says counts on the axis');
  // Which is exactly what the control reports for that same view.
  const ctl = chartUiSpec(ONE).controls.find((c) => c.id === 'valueMeasure');
  assert.equal(ctl.default, 'count');
});

test('the default lives on the control, not baked into every saved view', () => {
  // baseView used to write `valueMeasure: 'count'` into every chart, which made
  // each one carry an explicit setting it never chose — and made any later
  // change of default unable to reach it.
  const v = defaultView(ONE);
  assert.ok(!('valueMeasure' in v), 'a new chart should not pin the default into its view');
  // It still renders as counts, because the control's default says so.
  assert.ok(renderChart(ONE, { ...v, valueLabels: true }).includes('>120<'));
});
