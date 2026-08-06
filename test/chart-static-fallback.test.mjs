/**
 * @file chart-static-fallback.test.mjs
 * Charts degrade to their saved figure when the kind that drew them is missing.
 *
 * The bug this closes: `restoreModel` re-rendered unconditionally, so a chart whose
 * kind was not registered produced "Unsupported chart kind" — while the last-rendered
 * SVG sat unused in the very same save file. Output has to outlive whatever drew it.
 * `appendPlot` figures always did; charts were the exception, and that exception is
 * what made moving chart kinds into a plugin destructive rather than merely costly.
 *
 * Only the DECISIONS are tested here — which items go static, and what the notice
 * says. The DOM assembly is verified in the browser (this repo takes no dependencies,
 * so there is no jsdom to render into).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

const { chartNeedsStaticFallback, staticChartNotice } = await import('../core/results-pane.js');
const { getChartKind } = await import('../core/chart-renderer.js');

const SAVED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>KM</title></svg>';

test('a registered kind always re-renders, even with a saved figure present', () => {
  // A live chart beats a frozen one, and the saved SVG may be from an older renderer.
  const item = { svg: SAVED_SVG, model: { kind: 'steps' } };
  assert.equal(chartNeedsStaticFallback(item, getChartKind), false);
});

test('an unregistered kind WITH a saved figure goes static', () => {
  const item = { svg: SAVED_SVG, model: { kind: 'radar' }, kindProvider: 'SuperCharts' };
  assert.equal(chartNeedsStaticFallback(item, getChartKind), true);
});

test('an unregistered kind with NO saved figure keeps the diagnostic', () => {
  // This is a live append from a buggy plugin, not a reopened project. Falling back
  // silently here would hide the bug; there is nothing to fall back TO anyway.
  const item = { svg: '', model: { kind: 'radar' } };
  assert.equal(chartNeedsStaticFallback(item, getChartKind), false);
});

test('a chart that lost its model but kept its figure still shows the figure', () => {
  // Corrupted or truncated save. Before this, the restore guard required
  // `item.model.kind` and dropped such an item silently — no figure, no message.
  assert.equal(chartNeedsStaticFallback({ svg: SAVED_SVG, model: null }, getChartKind), true);
  assert.equal(chartNeedsStaticFallback({ svg: SAVED_SVG }, getChartKind), true);
});

test('nothing at all is not a static chart', () => {
  assert.equal(chartNeedsStaticFallback(null, getChartKind), false);
  assert.equal(chartNeedsStaticFallback({}, getChartKind), false);
  assert.equal(chartNeedsStaticFallback({ model: { kind: 'steps' } }, getChartKind), false);
});

test('every registered kind round-trips as live, none as static', () => {
  // Guards against a kind being renamed in its module but not in whatever wrote the
  // save — the whole family should be live, so any `true` here is a registry problem.
  for (const kind of ['categorical', 'scatter', 'pie', 'sced', 'violin', 'dots',
    'paired', 'box', 'wordcloud', 'steps', 'forest']) {
    assert.equal(chartNeedsStaticFallback({ svg: SAVED_SVG, model: { kind } }, getChartKind), false, kind);
  }
});

// --- the notice ---------------------------------------------------------------

test('the notice names the plugin when the chart recorded one', () => {
  // "Activate something" is not an instruction. The provider is stamped at append
  // time precisely because the registry cannot answer once the kind is gone.
  const note = staticChartNotice({ svg: SAVED_SVG, model: { kind: 'radar' }, kindProvider: 'SuperCharts' });
  assert.match(note, /Activate SuperCharts to edit this chart/);
  assert.match(note, /saved figure/);
});

test('with no provider the notice names the missing kind instead', () => {
  const note = staticChartNotice({ svg: SAVED_SVG, model: { kind: 'sunburst' } });
  assert.match(note, /sunburst/);
  assert.ok(!/Activate undefined/.test(note), 'must never say "Activate undefined"');
});

test('with neither provider nor kind the notice still says something true', () => {
  const note = staticChartNotice({ svg: SAVED_SVG, model: null });
  assert.match(note, /saved figure/);
  assert.ok(!/undefined|null|“”/.test(note), `notice leaked a placeholder: ${note}`);
});

test('the notice never blames the user or reads as an error', () => {
  // A static chart is a real result. Wording that reads as a failure would make people
  // think the analysis broke, when the figure in front of them is perfectly good.
  for (const item of [
    { svg: SAVED_SVG, model: { kind: 'radar' }, kindProvider: 'SuperCharts' },
    { svg: SAVED_SVG, model: { kind: 'sunburst' } },
    { svg: SAVED_SVG, model: null },
  ]) {
    const note = staticChartNotice(item);
    assert.ok(!/error|failed|invalid|corrupt/i.test(note), `alarming wording: ${note}`);
  }
});
