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
