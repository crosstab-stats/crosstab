/**
 * @file pie-labels.test.mjs
 * What a pie writes on its slices.
 *
 * The pie could only ever write a percent. It now writes a percent, a count, or
 * both — and the case worth pinning hardest is the one nobody would think to
 * check: a pie SAVED before the option existed must come back showing exactly
 * the labels it was saved with. Its view carries `valueLabels` and no
 * `valueMeasure`, so the new control's default is doing load-bearing work for every
 * chart already in someone's project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

const { defaultView, renderChart, chartUiSpec, controlVisible } = await import('../core/chart-renderer.js');

/** Counts, as builtin-plots.pie emits them: 60 / 30 / 10 of 100. */
const PIE = {
  kind: 'pie',
  title: 'Region of residence',
  slices: [
    { key: '1', label: 'North', value: 60 },
    { key: '2', label: 'Central', value: 30 },
    { key: '3', label: 'South', value: 10 },
  ],
};

const draw = (view = {}, model = PIE) => renderChart(model, { ...defaultView(model), ...view });
/** The text drawn ON the slices — the legend's labels are <text> too, so match
 * only the white bold ones the wedges carry. */
const sliceLabels = (svg) =>
  [...svg.matchAll(/<text[^>]*fill="#fff"[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

test('percent is the default, and is what the pie always drew', () => {
  assert.deepEqual(sliceLabels(draw()), ['60%', '30%', '10%']);
});

test('a pie saved before the option existed still shows its percents', () => {
  // The exact shape a restored chart has: the old boolean, no `valueMeasure`.
  assert.deepEqual(sliceLabels(renderChart(PIE, { ...defaultView(PIE), valueLabels: true })), ['60%', '30%', '10%']);
  // And one whose labels the user had switched OFF stays off — the migration
  // must not resurrect them by defaulting the new control on.
  assert.deepEqual(sliceLabels(renderChart(PIE, { ...defaultView(PIE), valueLabels: false })), []);
});

test('count writes N, and both writes the percent with N beside it', () => {
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'count' })), ['60', '30', '10']);
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'both' })), ['60% (60)', '30% (30)', '10% (10)']);
});

test('turning labels off silences every mode', () => {
  for (const valueMeasure of ['percent', 'count', 'both']) {
    assert.deepEqual(sliceLabels(draw({ valueLabels: false, valueMeasure })), [], valueMeasure);
  }
});

test('the count is the slice value, not the percent restated', () => {
  // 3 of 12 is 25%: if the two were the same number by accident above, this
  // separates them.
  const model = { ...PIE, slices: [{ key: 'a', label: 'A', value: 9 }, { key: 'b', label: 'B', value: 3 }] };
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'count' }, model)), ['9', '3']);
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'percent' }, model)), ['75%', '25%']);
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'both' }, model)), ['75% (9)', '25% (3)']);
});

test('a sliver gets no label rather than an unreadable one, and "both" needs more room', () => {
  // 2% is too thin for any label; 4% fits "4%" but not "4% (4)".
  const model = {
    ...PIE,
    slices: [
      { key: 'big', label: 'Big', value: 94 },
      { key: 'mid', label: 'Mid', value: 4 },
      { key: 'tiny', label: 'Tiny', value: 2 },
    ],
  };
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'percent' }, model)), ['94%', '4%']);
  assert.deepEqual(sliceLabels(draw({ valueMeasure: 'both' }, model)), ['94% (94)']);
});

test('the label-content control is offered, and hides when labels are off', () => {
  const controls = chartUiSpec(PIE).controls;
  const ctl = controls.find((c) => c.id === 'valueMeasure');
  assert.ok(ctl, 'the pie should offer a label-content control');
  assert.deepEqual(ctl.options.map(([v]) => v), ['percent', 'count', 'both']);
  const view = defaultView(PIE);
  assert.ok(controlVisible(ctl, { ...view, valueLabels: true }, controls));
  assert.ok(!controlVisible(ctl, { ...view, valueLabels: false }, controls));
});
