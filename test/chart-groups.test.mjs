/**
 * @file chart-groups.test.mjs
 * Every chart control belongs to a collapsible section (chart-controls.js).
 *
 * The panel had grown to 29 visible controls on the SIMPLEST possible SCED chart, 16 of
 * them the generic title/axis block that every kind carries. That is unusable however
 * few of them you need — and it is why splitting a chart kind in two would not have
 * helped: the duplicated sixteen would have gone to both halves.
 *
 * The guard here is against silent regrowth: a new control with no `group` falls into a
 * default bucket and quietly makes one section long again, which is invisible until
 * someone opens the panel. So the rule is that grouping is declared, not defaulted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { defaultView, chartUiSpec } = await import('../core/chart-renderer.js');

const pts = (xs, ys, phase) => xs.map((x, i) => ({ x, y: ys[i], phase }));
const MODELS = {
  sced: {
    kind: 'sced',
    title: 't',
    phases: [{ key: 'A', label: 'A' }, { key: 'B', label: 'B' }],
    axes: { x: { title: 's' }, y: { title: 'y' } },
    panels: [1, 2, 3].map((i) => ({
      key: `p${i}`, label: `P${i}`,
      points: [...pts([1, 2, 3], [1, 2, 1], 'A'), ...pts([4, 5, 6], [5, 6, 7], 'B')],
    })),
  },
  categorical: {
    kind: 'categorical', title: 't',
    categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    series: [{ key: 's', label: 'S', values: [1, 2] }, { key: 't', label: 'T', values: [2, 1] }],
    axes: { x: { title: 'x' }, y: { title: 'y' } },
  },
  scatter: {
    kind: 'scatter', title: 't',
    points: [{ x: 1, y: 2 }, { x: 2, y: 3 }],
    trend: { slope: 1, intercept: 0, r2: 0.9 },
    axes: { x: { title: 'x' }, y: { title: 'y' } },
  },
  pie: {
    kind: 'pie', title: 't',
    slices: [{ key: 'a', label: 'A', value: 1 }, { key: 'b', label: 'B', value: 2 }],
  },
};

/** The controls actually shown for a model at its default view. */
function visible(model) {
  const view = defaultView(model);
  return chartUiSpec(model).controls.filter((c) => !c.visible || c.visible(view, model));
}

for (const [name, model] of Object.entries(MODELS)) {
  test(`${name}: every visible control declares a group`, () => {
    const missing = visible(model).filter((c) => !c.group).map((c) => c.id);
    assert.deepEqual(missing, [], `ungrouped controls would land in a default bucket: ${missing}`);
  });

  test(`${name}: no single section is longer than the old flat panel was tolerable`, () => {
    // 16 title/axis rows is already the outlier and is collapsed; nothing else may
    // approach it. If a section grows past this, it wants splitting.
    const counts = new Map();
    for (const c of visible(model)) counts.set(c.group, (counts.get(c.group) || 0) + 1);
    for (const [group, n] of counts) {
      const cap = group === 'Titles & axes' ? 16 : 8;
      assert.ok(n <= cap, `section "${group}" has ${n} controls (cap ${cap})`);
    }
  });
}

test('the first section is small — it is the one that opens by default', () => {
  // chart-controls.js seeds the open set with the first group in declaration order, so
  // whatever a kind declares first is what the user is greeted with.
  for (const [name, model] of Object.entries(MODELS)) {
    const vis = visible(model);
    const first = vis[0].group;
    const n = vis.filter((c) => c.group === first).length;
    assert.ok(n <= 4, `${name} opens on "${first}" with ${n} controls — too much for a first impression`);
  }
});

test('the generic title/axis block is shared, not per-kind — so splitting a kind would duplicate it', () => {
  // This is the measurement that decided against a separate multi-series chart kind.
  const titleRows = (m) => visible(m).filter((c) => c.group === 'Titles & axes').length;
  assert.equal(titleRows(MODELS.sced), 16);
  assert.equal(titleRows(MODELS.categorical), 16);
  assert.equal(titleRows(MODELS.scatter), 16);
  assert.equal(titleRows(MODELS.sced), titleRows(MODELS.scatter), 'identical across kinds');
});

test('SCED stays navigable as the data gets harder', () => {
  // One panel hides the panel-ordering and shared-scale controls; eight shows them.
  const one = { ...MODELS.sced, panels: MODELS.sced.panels.slice(0, 1) };
  const many = { ...MODELS.sced, panels: Array.from({ length: 8 }, (_, i) => ({ ...MODELS.sced.panels[0], key: `k${i}`, label: `K${i}` })) };
  assert.ok(visible(one).length < visible(many).length, 'controls scale with the data');
  const groupsOf = (m) => [...new Set(visible(m).map((c) => c.group))];
  assert.deepEqual(groupsOf(many), ['Chart', 'Phases', 'Panels', 'Style', 'Titles & axes'],
    'and the section list stays the same five either way');
  assert.deepEqual(groupsOf(one), groupsOf(many));
});

// --- visual affordance -------------------------------------------------------
// A control whose effect nobody can see is indistinguishable from a broken one.

const { renderChart } = await import('../core/chart-renderer.js');

/** Relative luminance / contrast ratio, per WCAG 2.x. */
const luminance = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

test('gridlines are dark enough to be seen — the toggle must have a visible effect', () => {
  // Regression on a real report: at #e6eaee (1.21:1 on white) turning gridlines off
  // removed them from the SVG but looked identical, so the checkbox read as dead.
  const model = MODELS.scatter;
  const on = renderChart(model, { ...defaultView(model), gridlines: true });
  const strokes = [...on.matchAll(/<line[^>]*stroke="(#[0-9a-f]{6})"[^>]*\/>/gi)].map((m) => m[1]);
  const gridStroke = strokes.find((s) => contrast(s, '#ffffff') < 3); // the faintest ink
  assert.ok(gridStroke, 'a gridline stroke exists');
  const ratio = contrast(gridStroke, '#ffffff');
  assert.ok(ratio >= 1.5, `gridlines at ${gridStroke} are ${ratio.toFixed(2)}:1 on white — invisible`);
  assert.ok(ratio <= 2.5, `gridlines at ${gridStroke} are ${ratio.toFixed(2)}:1 — competing with the data`);
});

test('and toggling them off actually removes them, in every kind', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    const v = defaultView(model);
    const count = (view) => {
      const svg = renderChart(model, view);
      return [...svg.matchAll(/<line[^>]*stroke="(#[0-9a-f]{6})"/gi)]
        .filter((m) => contrast(m[1], '#ffffff') < 2.6).length;
    };
    if (name === 'pie') continue; // no axes, so no gridlines to draw
    assert.ok(count({ ...v, gridlines: true }) > 0, `${name}: gridlines on draws some`);
    assert.equal(count({ ...v, gridlines: false }), 0, `${name}: gridlines off draws none`);
  }
});
