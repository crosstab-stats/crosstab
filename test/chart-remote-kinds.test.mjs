/**
 * @file chart-remote-kinds.test.mjs
 * The registry holds LOCAL kinds (functions in this realm) and REMOTE ones (a plugin
 * answering over postMessage), and the host treats them the same.
 *
 * The contract is deliberately two verbs. `describe(model)` returns everything the host
 * needs as pure data; `render(model, view)` returns the SVG. There is no third verb
 * because control *visibility* is resolved host-side from the descriptors, which makes a
 * kind's controls a pure function of the model — so however much the user fiddles with
 * the panel, the plugin is asked to describe itself exactly once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

const {
  registerRemoteChartKind, unregisterChartKind, getChartKind, chartKindNames,
  describeChart, renderChartAsync, viewFromSpec, uiSpecFromSpec,
  renderChart, defaultView, chartUiSpec,
} = await import('../core/chart-renderer.js');

/** A stand-in for a plugin: counts calls, so we can prove how often it is asked. */
function fakePlugin(name, { provider = 'SuperCharts' } = {}) {
  const calls = { describe: 0, render: 0 };
  registerRemoteChartKind(name, {
    provider,
    async describe(model) {
      calls.describe++;
      return {
        altNoun: 'Radar chart',
        colorLabel: 'Axes',
        reorderCategories: false,
        colorItems: (model.axes2 || []).map((a) => ({ key: a, label: a.toUpperCase() })),
        controls: [
          { id: 'spokes', label: 'Spokes', type: 'check', default: true },
          { id: 'fillOpacity', label: 'Fill', type: 'number', min: 0, max: 1, step: 0.1, default: 0.3 },
        ],
        baseView: { legend: 'right', spokes: true },
      };
    },
    async render(model, view) {
      calls.render++;
      return `<svg data-kind="${name}" data-spokes="${view.spokes}"></svg>`;
    },
  });
  return calls;
}

const MODEL = { kind: 'radar', title: 'R', axes2: ['a', 'b', 'c'] };

test('a remote kind registers, describes and renders like any other', async (t) => {
  const calls = fakePlugin('radar');
  t.after(() => unregisterChartKind('radar'));

  assert.ok(chartKindNames().includes('radar'));
  assert.equal(getChartKind('radar').local, false);
  assert.equal(getChartKind('radar').provider, 'SuperCharts');

  const spec = await describeChart(MODEL);
  assert.equal(spec.colorLabel, 'Axes');
  assert.equal(spec.colorItems.length, 3);
  assert.equal(calls.describe, 1);

  const view = viewFromSpec(spec, MODEL);
  assert.equal(view.spokes, true, 'baseView flows into the view');
  assert.deepEqual(view.seriesOrder, ['a', 'b', 'c'], 'colour order seeded from the spec');

  const svg = await renderChartAsync(MODEL, view);
  assert.match(svg, /data-kind="radar"/);
  assert.equal(calls.render, 1);
});

test('a remote spec is everything the controls panel needs — no second call', async (t) => {
  const calls = fakePlugin('radar');
  t.after(() => unregisterChartKind('radar'));

  const spec = await describeChart(MODEL);
  const ui = uiSpecFromSpec(spec, MODEL);
  assert.equal(ui.controls.length, 2);
  assert.equal(ui.colorLabel, 'Axes');
  assert.deepEqual(ui.categories, []);
  // Twenty control changes, still one describe: the panel repaints from the spec it
  // already holds. This is the property that keeps a plugin kind usable over a wire.
  for (let i = 0; i < 20; i++) uiSpecFromSpec(spec, MODEL);
  assert.equal(calls.describe, 1);
});

test('the sync helpers refuse remote kinds rather than pretending', async (t) => {
  fakePlugin('radar');
  t.after(() => unregisterChartKind('radar'));
  // A sync caller cannot get an answer from behind postMessage. Saying so beats
  // returning an empty chart that looks like a rendering bug.
  assert.match(renderChart(MODEL, {}), /Unsupported chart kind/);
  assert.deepEqual(chartUiSpec(MODEL).controls, []);
  // defaultView still yields a usable shell so callers do not crash on it.
  assert.deepEqual(defaultView(MODEL).seriesOrder, []);
});

test('unregistering makes the kind unknown, and the host asks nobody', async (t) => {
  fakePlugin('radar');
  assert.equal(unregisterChartKind('radar'), true);
  assert.equal(getChartKind('radar'), undefined);
  // Null, not a throw and not an error SVG: the caller shows the saved figure instead.
  assert.equal(await describeChart(MODEL), null);
  assert.equal(await renderChartAsync(MODEL, {}), null);
});

test('core kinds are local, and a plugin cannot silently shadow one', async (t) => {
  // Registering over an existing name replaces it — that is how a deactivate/activate
  // cycle works — but the local flag must follow the new owner, or the host would keep
  // calling a function that is no longer there.
  const original = getChartKind('violin');
  assert.equal(original.local, true);
  fakePlugin('violin');
  t.after(() => { unregisterChartKind('violin'); });
  assert.equal(getChartKind('violin').local, false);
  assert.equal(getChartKind('violin').provider, 'SuperCharts');
});

test('a remote describe returning nothing degrades to "no such kind"', async (t) => {
  registerRemoteChartKind('broken', {
    provider: 'Flaky',
    async describe() { return null; },
    async render() { return null; },
  });
  t.after(() => unregisterChartKind('broken'));
  assert.equal(await describeChart({ kind: 'broken' }), null);
  // viewFromSpec must survive a null spec — a plugin that answers badly should not
  // take the pane down with it.
  assert.doesNotThrow(() => viewFromSpec(null, { kind: 'broken' }));
  assert.deepEqual(uiSpecFromSpec(null, { kind: 'broken' }).controls, []);
});
