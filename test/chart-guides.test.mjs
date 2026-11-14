/**
 * @file chart-guides.test.mjs
 * Guide lines and reference lines, now that they belong to the frame rather than to one kind.
 *
 * ## What moved, and why it matters
 *
 * Both were written inside the scatter kind. Everything else that wanted one went without,
 * and the codebase said so out loud — the scree plot carried the note *"The Kaiser
 * eigenvalue>1 cutoff isn't drawn as a reference line — the categorical kind has none."* A
 * scree plot's entire question is "where does it cross one?", and the chart made the reader
 * answer it by eye.
 *
 * They are frame geometry, so they live beside the frames in the chart stdlib and are drawn
 * by `bandFrame` and `xyFrame` themselves. That puts them after the axes and before the
 * kind draws a mark, which is what "behind the data" means in paint order, and it is the
 * order scatter already had — so this is a move, not a redesign.
 *
 * These tests drive the real registered kinds and read the emitted SVG: a toggle that
 * exists but draws nothing, or a line drawn where the data is not, both pass a shape check
 * and fail a reader.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('./chart-kinds-harness.mjs');
const { chartUiSpec, renderChart, defaultView } = await import('../core/chart-renderer.js');
const { drawGuides, drawReferenceLine, GUIDE } = await import('../core/charts/stdlib.js');

const DASH = 'stroke-dasharray="4 3"';

/** One model per kind that can carry a guide, with a horizontal guide inside its y range. */
const MODELS = {
  categorical: { categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], series: [{ key: 's', label: 'S', values: [1, 3] }] },
  violin: { groups: [{ key: 'g', label: 'G', values: [1, 2, 3, 4] }] },
  dots: { groups: [{ key: 'g', label: 'G', values: [1, 2, 3, 4] }] },
  paired: { conditions: [{ key: 'c1', label: 'C1' }, { key: 'c2', label: 'C2' }], subjects: [{ key: 's', label: 'S', values: [1, 3] }] },
  box: { groups: [{ key: 'g', label: 'G', values: [1, 2, 3, 4, 5] }] },
  steps: { series: [{ key: 'k', label: 'K', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }] },
  histogram: { values: [1, 2, 2, 3, 3, 3, 4] },
  scatter: { points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] },
};
const withGuide = (kind) => ({ kind, title: 't', guides: [{ axis: 'y', at: 2, label: 'cutoff' }], ...MODELS[kind] });
const draw = (m, over = {}) => renderChart(m, { ...defaultView(m), ...(m.view || {}), ...over });

test('every x/y kind draws a guide, offers its toggle, and obeys it', () => {
  for (const kind of Object.keys(MODELS)) {
    const m = withGuide(kind);
    assert.ok(draw(m).includes(DASH), `${kind}: no guide drawn`);
    assert.ok(draw(m).includes('cutoff'), `${kind}: guide label missing`);
    assert.ok(chartUiSpec(m).controls.some((c) => c.id === 'guides'), `${kind}: no toggle`);
    assert.ok(!draw(m, { guides: false }).includes(DASH), `${kind}: toggle does not turn it off`);
  }
});

test('a kind with no guides in its model offers no toggle', () => {
  // The control is evidence that the chart has something to toggle. An always-present
  // checkbox that governs nothing is worse than no checkbox.
  for (const kind of Object.keys(MODELS)) {
    const bare = { kind, title: 't', ...MODELS[kind] };
    assert.ok(!chartUiSpec(bare).controls.some((c) => c.id === 'guides'), `${kind}`);
  }
});

test('an off-scale guide is dropped, not clamped to the frame', () => {
  // A line pinned to the edge of the plot says "the threshold is here", and it is not.
  const m = { ...withGuide('categorical'), guides: [{ axis: 'y', at: 9999, label: 'way up there' }] };
  assert.ok(!draw(m).includes(DASH));
  assert.ok(!draw(m).includes('way up there'));
});

test('on a categorical x axis every guide is horizontal', () => {
  // There is no x VALUE for a vertical line to sit at, so the only reading that means
  // anything is a horizontal one — rather than silently dropping the guide.
  const m = { ...withGuide('categorical'), guides: [{ at: 2, label: 'no axis given' }] };
  const svg = draw(m);
  assert.ok(svg.includes(DASH));
  assert.ok(svg.includes('no axis given'));
});

test('on a value-scaled x axis the old default still means vertical', () => {
  // scatter's contract since it owned this code: `axis: 'y'` is horizontal, anything else
  // is vertical. Its one caller in the tree (builtin-decisions) depends on it.
  const f = { out: [], box: { x0: 0, x1: 100, y0: 100, y1: 0 }, xScale: (v) => v * 10, yScale: (v) => 100 - v * 10, xLo: 0, xHi: 10, yLo: 0, yHi: 10 };
  drawGuides(f, { guides: [{ at: 5, label: 'break-even' }] }, {});
  const line = f.out[0];
  // A vertical line spans the plot's height at one x: y1 and y2 differ, x1 and x2 match.
  assert.match(line, /x1="50"[^>]*x2="50"/);
});

test('the sloped reference spans the plot and is drawn in the guide grey', () => {
  const f = { out: [], xScale: (v) => v * 10, yScale: (v) => 100 - v * 10, xLo: 0, xHi: 10 };
  drawReferenceLine(f, { reference: { slope: 1, intercept: 0 } }, {});
  assert.equal(f.out.length, 1);
  assert.match(f.out[0], /x1="0"[^>]*x2="100"/);
  assert.ok(f.out[0].includes(GUIDE), 'the reference is a guide, not a finding');
  // ...and a half-specified reference draws nothing rather than NaN coordinates.
  const g = { out: [], xScale: (v) => v, yScale: (v) => v, xLo: 0, xHi: 1 };
  drawReferenceLine(g, { reference: { slope: 1 } }, {});
  drawReferenceLine(g, {}, {});
  assert.equal(g.out.length, 0);
});

test('Q–Q plots are unchanged by the move', () => {
  // The normal line of a Q–Q plot is the oldest caller of this code; it has to come
  // through the move byte-for-byte in its shape: one dashed grey line across the plot.
  const m = {
    kind: 'scatter',
    title: 'Q–Q plot',
    points: [{ x: -1, y: -1.2 }, { x: 0, y: 0.1 }, { x: 1, y: 1.1 }],
    reference: { slope: 1, intercept: 0, label: 'Normal line' },
  };
  const svg = draw(m);
  assert.match(svg, /stroke-dasharray="5 4"/);
  assert.ok(chartUiSpec(m).controls.some((c) => c.id === 'referenceLine'), 'and keeps its own switch');
});

test('the scree plot draws the Kaiser line its comment used to apologise for', async () => {
  const factor = await import('../plugins/builtin-factor/index.js');
  const src = (await import('node:fs')).readFileSync('plugins/builtin-factor/index.js', 'utf8');
  assert.ok(factor.manifest, 'the plugin still loads');
  assert.match(src, /guides: \[\{ axis: 'y', at: 1, label: 'Kaiser/);
  // And the chart it describes really renders the line.
  const m = {
    kind: 'categorical',
    title: 'Scree Plot',
    categories: [1, 2, 3, 4].map((i) => ({ key: String(i), label: String(i) })),
    series: [{ key: 'ev', label: 'Eigenvalue', values: [3.2, 1.6, 0.8, 0.4] }],
    guides: [{ axis: 'y', at: 1, label: 'Kaiser (eigenvalue = 1)' }],
    view: { mark: 'line', legend: 'none' },
  };
  const svg = draw(m);
  assert.ok(svg.includes(DASH));
  assert.ok(svg.includes('Kaiser'));
});

test('an axis reaches its guide: zero stays on a chart of all-negative differences', () => {
  // The flaw this closes, found the moment the paired t-test drew one: every difference
  // was negative, so the histogram's domain stopped short of zero and the guide was
  // correctly dropped as off-scale — leaving a chart about "is it different from zero?"
  // with no zero on it. A guide is part of what the figure is ABOUT, so the axis has to
  // reach it; this is the "axis that starts at 47" mistake in a different costume.
  const m = {
    kind: 'histogram',
    title: 'Differences',
    values: [-3, -3, -4, -2],
    guides: [{ axis: 'x', at: 0, label: 'No change' }],
  };
  const svg = draw(m);
  assert.ok(svg.includes(DASH), 'the zero line is drawn');
  assert.ok(svg.includes('No change'));
});

test('switching guides off hands the axis back to the data', () => {
  const m = {
    kind: 'histogram', title: 'Differences', values: [-3, -3, -4, -2],
    guides: [{ axis: 'x', at: 0, label: 'No change' }],
  };
  // With the guide off, nothing is drawn at zero AND nothing reserves room for it: the
  // axis describes what is on the chart, which is the honest pairing of the two.
  const off = draw(m, { guides: false });
  assert.ok(!off.includes(DASH));
  assert.ok(!off.includes('No change'));
});

test('a banded frame reaches a horizontal guide too', () => {
  const m = {
    kind: 'categorical',
    title: 'Scree',
    categories: [1, 2, 3].map((i) => ({ key: String(i), label: String(i) })),
    series: [{ key: 'ev', label: 'Eigenvalue', values: [4.2, 3.1, 2.6] }],
    guides: [{ axis: 'y', at: 1, label: 'Kaiser' }],
    view: { mark: 'line' },
  };
  // Every eigenvalue is above 1, so without this the cutoff would fall off the bottom.
  assert.ok(draw(m).includes('Kaiser'));
});
