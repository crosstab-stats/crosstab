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

const { chartBlockMode, staticChartNotice, pendingChartNotice } = await import('../core/results-pane.js');
const { getChartKind } = await import('../core/chart-renderer.js');

const SAVED_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>KM</title></svg>';

test('a registered kind always re-renders, even with a saved figure present', () => {
  // A live chart beats a frozen one, and the saved SVG may be from an older renderer.
  assert.equal(chartBlockMode({ svg: SAVED_SVG, model: { kind: 'steps' } }, getChartKind), 'live');
});

test('an unregistered kind WITH a saved figure goes frozen', () => {
  const item = { svg: SAVED_SVG, model: { kind: 'radar' }, kindProvider: 'SuperCharts' };
  assert.equal(chartBlockMode(item, getChartKind), 'frozen');
});

test('THE BUG: an unregistered kind with NO saved figure is PENDING, not empty', () => {
  // Running Plots > Pie with the chart plugin switched off. This used to fall through
  // to the live path, which returns null and paints nothing — an empty box with two
  // save buttons that saved nothing. It is not a plugin bug, it is a normal user state.
  // 'radar' stands in for pie-with-the-plugin-off: the harness registers the real
  // kinds, so an unregistered name is how we model "that plugin is switched off".
  assert.equal(chartBlockMode({ svg: '', model: { kind: 'radar' } }, getChartKind), 'pending');
  assert.equal(chartBlockMode({ model: { kind: 'radar' } }, getChartKind), 'pending');
});

test('a chart that lost its model but kept its figure still shows the figure', () => {
  // Corrupted or truncated save. Before this, the restore guard required
  // `item.model.kind` and dropped such an item silently — no figure, no message.
  assert.equal(chartBlockMode({ svg: SAVED_SVG, model: null }, getChartKind), 'frozen');
  assert.equal(chartBlockMode({ svg: SAVED_SVG }, getChartKind), 'frozen');
});

test('an empty item is pending, and a live kind with no svg is still live', () => {
  assert.equal(chartBlockMode(null, getChartKind), 'pending');
  assert.equal(chartBlockMode({}, getChartKind), 'pending');
  // No saved svg yet is the NORMAL case for a freshly appended chart — it must be live,
  // or every new chart would render as a notice.
  assert.equal(chartBlockMode({ model: { kind: 'steps' } }, getChartKind), 'live');
});

test('every registered kind round-trips as live, none as static', () => {
  // Guards against a kind being renamed in its module but not in whatever wrote the
  // save — the whole family should be live, so any `true` here is a registry problem.
  for (const kind of ['categorical', 'scatter', 'pie', 'sced', 'violin', 'dots',
    'paired', 'box', 'wordcloud', 'steps', 'forest']) {
    assert.equal(chartBlockMode({ svg: SAVED_SVG, model: { kind } }, getChartKind), 'live', kind);
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

// --- the pending notice ---------------------------------------------------------

test('a pending chart says what is missing and where to fix it', () => {
  const note = pendingChartNotice({ model: { kind: 'pie' } });
  assert.match(note, /pie/, 'names the chart type — the one thing we do know');
  assert.match(note, /Plugins/, 'points at the plugin manager');
  assert.ok(!/undefined|null/.test(note), `leaked a placeholder: ${note}`);
});

test('a pending chart names the provider when one was recorded', () => {
  const note = pendingChartNotice({ model: { kind: 'radar' }, kindProvider: 'SuperCharts' });
  assert.match(note, /SuperCharts/);
});

test('pending wording never reads as a failed analysis', () => {
  // The analysis ran fine. Only the drawing is missing, and the user can switch it on.
  for (const item of [{ model: { kind: 'pie' } }, { model: null }, { model: { kind: 'x' }, kindProvider: 'P' }]) {
    const note = pendingChartNotice(item);
    assert.ok(!/error|failed|invalid|crash/i.test(note), `alarming wording: ${note}`);
  }
});

test('core never hardcodes a plugin name it cannot know', () => {
  // The provider is stamped by reading the registry — but in the pending state the kind
  // is exactly what is missing from it, so there is nobody to ask. Guessing "Charts"
  // would also be core naming a plugin that may not be ours.
  const note = pendingChartNotice({ model: { kind: 'pie' } });
  assert.ok(!/Chart engine|builtin-charts|Charts/.test(note), `guessed a provider: ${note}`);
});
