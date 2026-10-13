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

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

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
  tornado: {
    kind: 'tornado', title: 't', baseline: 100,
    rows: [{ label: 'Rate', lo: 40, hi: 180 }, { label: 'Uptake', lo: 90, hi: 120 }],
    axes: { x: { title: 'NPV' } },
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
    // ONE cap now, for every section. "Titles & axes" used to be exempt at 16 — it was
    // the outlier the cap was written around, and it sat exactly ON its exemption, so the
    // next control anywhere in it had nowhere to go. Splitting it (2026-10-13) into
    // Chart title / X axis / Y axis removed the exemption rather than raising it.
    const counts = new Map();
    for (const c of visible(model)) counts.set(c.group, (counts.get(c.group) || 0) + 1);
    for (const [group, n] of counts) {
      assert.ok(n <= 8, `section "${group}" has ${n} controls (cap 8) — it wants splitting`);
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
  // This is the measurement that decided against a separate multi-series chart kind. The
  // block is still 16 rows and still identical across kinds; it is now THREE sections
  // rather than one, which is the only thing that changed.
  const rows = (m, g) => visible(m).filter((c) => c.group === g).length;
  const block = (m) => rows(m, 'Chart title') + rows(m, 'X axis') + rows(m, 'Y axis');
  for (const kind of ['sced', 'categorical', 'scatter']) {
    assert.equal(block(MODELS[kind]), 16, `${kind}: the shared block is still 16 rows`);
  }
  assert.equal(block(MODELS.sced), block(MODELS.scatter), 'identical across kinds');
});

test('the split is 4 / 6 / 6 — the shape the generator already had', () => {
  // The section was never 16 flat rows: it was titleControls() once and axisControls()
  // twice. The grouping follows that rather than being imposed on it, which is why the
  // change was one line per generator and needed no migration — `group` is presentation,
  // and a saved view is keyed by control id.
  for (const [name, model] of Object.entries(MODELS)) {
    const n = (g) => visible(model).filter((c) => c.group === g).length;
    // Every kind that draws a title has the same four. Axes are per-kind: a pie has
    // neither, and a tornado has an X axis and no Y — so each is checked only where the
    // kind declares it, and when it does it is the whole 6-row block or nothing.
    if (n('Chart title')) assert.equal(n('Chart title'), 4, `${name}: chart title`);
    for (const axis of ['X axis', 'Y axis']) {
      if (n(axis)) assert.equal(n(axis), 6, `${name}: ${axis}`);
    }
  }
  // …and the kinds that do have both are the ones the 16-row measurement came from.
  for (const kind of ['sced', 'categorical', 'scatter']) {
    const n = (g) => visible(MODELS[kind]).filter((c) => c.group === g).length;
    assert.deepEqual([n('Chart title'), n('X axis'), n('Y axis')], [4, 6, 6], kind);
  }
});

test('no section is called "Titles & axes" any more', () => {
  for (const [name, model] of Object.entries(MODELS)) {
    const groups = new Set(visible(model).map((c) => c.group));
    assert.ok(!groups.has('Titles & axes'), `${name} still has the old combined section`);
  }
});

test('SCED stays navigable as the data gets harder', () => {
  // One panel hides the panel-ordering and shared-scale controls; eight shows them.
  const one = { ...MODELS.sced, panels: MODELS.sced.panels.slice(0, 1) };
  const many = { ...MODELS.sced, panels: Array.from({ length: 8 }, (_, i) => ({ ...MODELS.sced.panels[0], key: `k${i}`, label: `K${i}` })) };
  assert.ok(visible(one).length < visible(many).length, 'controls scale with the data');
  const groupsOf = (m) => [...new Set(visible(m).map((c) => c.group))];
  // Eight sections since "Titles & axes" split into three (2026-10-13). Order comes from
  // GROUP_ORDER in builtin-charts, NOT from where a kind happens to declare a control —
  // which is the whole reason that map exists. The split briefly broke this: an unlisted
  // group falls to rank 4 by design, so the three new sections landed mid-panel until
  // they were added to the map.
  assert.deepEqual(groupsOf(many),
    ['Chart', 'Phases', 'Panels', 'Style', 'Legend', 'Chart title', 'X axis', 'Y axis'],
    'the section list stays the same eight either way, with titles last');
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
