/**
 * @file categorical-measure.test.mjs
 * Counts shown as counts or as percentages — the `yMeasure` view control.
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
  assert.ok(controlIds(ONE).includes('yMeasure'));
  assert.ok(controlIds(TWO).includes('yMeasure'));
  assert.ok(!controlIds(MEANS).includes('yMeasure'), 'a percentage of a mean is nonsense');
});

test('counts are drawn unchanged by default', () => {
  const svg = draw(ONE, { valueLabels: true });
  for (const n of ['120', '60', '20']) assert.ok(hasText(svg, n), `expected a ${n} label`);
  assert.ok(hasText(svg, 'Count'), 'the y axis should say Count');
});

test('one series: percent is of ALL cases', () => {
  const svg = draw(ONE, { yMeasure: 'percent', valueLabels: true });
  for (const n of ['60', '30', '10']) assert.ok(hasText(svg, n), `120/60/20 of 200 → ${n}%`);
  // And the counts themselves are gone from the picture, so the conversion is
  // real rather than an extra label alongside the old scale.
  assert.ok(!hasText(svg, '120'), 'the count scale should be gone');
  assert.ok(hasText(svg, 'Percent of all cases'), 'the axis should name which percent');
});

test('several series: percent is WITHIN each category', () => {
  // 30 of 40 is 75% within 2020 — NOT 30 of 80 (37.5% of the grand total), which
  // is the plausible wrong answer.
  const svg = draw(TWO, { yMeasure: 'percent', valueLabels: true });
  assert.ok(hasText(svg, '75'), 'expected 75% within 2020');
  assert.ok(hasText(svg, '25'), 'expected 25% within 2020');
  assert.ok(!hasText(svg, '37.5'), 'that would be a share of the grand total');
  assert.ok(hasText(svg, 'Percent within each category'));
});

test('each category of a multi-series percent view sums to 100', () => {
  const svg = draw(TWO, { yMeasure: 'percent', valueLabels: true });
  // 2020 is 75/25 and 2024 is 25/75 — each category's shares add to 100 whatever
  // the counts behind them were.
  assert.equal([...svg.matchAll(/>75</g)].length, 2);
  assert.equal([...svg.matchAll(/>25</g)].length, 2);
});

test('the option says which percent it means', () => {
  const one = chartUiSpec(ONE).controls.find((c) => c.id === 'yMeasure');
  const two = chartUiSpec(TWO).controls.find((c) => c.id === 'yMeasure');
  assert.deepEqual(one.options.map(([, l]) => l), ['Count', 'Percent of all cases']);
  assert.deepEqual(two.options.map(([, l]) => l), ['Count', 'Percent within each category']);
});

test('a means chart keeps its own y-axis title and its values', () => {
  const svg = draw(MEANS, { valueLabels: true, yMeasure: 'percent' }); // control absent; value ignored
  assert.ok(hasText(svg, 'Mean income'));
  assert.ok(hasText(svg, '42,000') || hasText(svg, '42000'), 'the means must not be rescaled');
});

test('a chart saved before the switch existed renders exactly as it did', () => {
  // Its model has no `counts` flag and its values are already percentages.
  const legacy = { ...ONE, counts: undefined, series: [{ key: 'all', label: 'Valid percent', values: [60, 30, 10] }],
    axes: { x: { title: 'Region' }, y: { title: 'Valid percent' } } };
  const svg = draw(legacy, { valueLabels: true });
  assert.ok(hasText(svg, 'Valid percent'), 'its own y title is still used');
  assert.ok(!controlIds(legacy).includes('yMeasure'));
});

test('an empty category contributes no percentage instead of dividing by zero', () => {
  const model = { ...TWO, series: [
    { key: 'a', label: 'A', values: [0, 10] },
    { key: 'b', label: 'B', values: [0, 30] },
  ] };
  const svg = draw(model, { yMeasure: 'percent' });
  assert.ok(!/NaN|Infinity/.test(svg), 'an all-zero category must not produce NaN');
});
