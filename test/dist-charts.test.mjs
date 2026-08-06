/**
 * @file dist-charts.test.mjs
 * The distribution + paired chart kinds (#140): violin, dots, paired.
 *
 * These are the Prism-style figures experimental and biomedical work expects. What is
 * pinned here is mostly about HONESTY of the mark — a violin that bulges past the data
 * it was given, or a density drawn from two points, states things the sample cannot
 * support, and those are the failures a reader cannot catch by eye.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { defaultView, renderChart, chartUiSpec } = await import('../core/chart-renderer.js');

const grp = (key, label, values, reps) => ({ key, label, values, reps });
const spread = (n, centre) => Array.from({ length: n }, (_, i) => centre + ((i * 37) % 21) - 10);

const VIOLIN = {
  kind: 'violin', title: 'Response by dose',
  axes: { x: { title: 'Dose' }, y: { title: 'Response' } },
  groups: [grp('lo', 'Low', spread(30, 40)), grp('hi', 'High', spread(30, 70))],
};
const SUPER = {
  kind: 'dots', title: 'SuperPlot',
  axes: { x: { title: 'Condition' }, y: { title: 'Signal' } },
  groups: [
    grp('c', 'Control', spread(18, 30), Array.from({ length: 18 }, (_, i) => `Rep ${(i % 3) + 1}`)),
    grp('t', 'Treated', spread(18, 60), Array.from({ length: 18 }, (_, i) => `Rep ${(i % 3) + 1}`)),
  ],
};
const PAIRED = {
  kind: 'paired', title: 'Before vs after',
  axes: { x: { title: '' }, y: { title: 'Score' } },
  conditions: [{ key: 'pre', label: 'Before' }, { key: 'post', label: 'After' }],
  subjects: Array.from({ length: 10 }, (_, i) => ({
    key: `s${i}`, label: `S${i}`, values: [40 + i, 40 + i + (i % 4 === 0 ? -8 : 12)],
  })),
};

const count = (svg, tag) => (svg.match(new RegExp(`<${tag}`, 'g')) || []).length;
const yOf = (svg) => [...svg.matchAll(/<circle[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));

test('violin draws one body per group, plus every observation', () => {
  const svg = renderChart(VIOLIN, defaultView(VIOLIN));
  assert.equal(count(svg, 'polygon'), 2, 'one violin body per group');
  assert.equal(count(svg, 'circle'), 60, 'points overlaid by default at this sample size');
});

test('THE HONESTY CONSTRAINT: a violin never extends past the data it was given', () => {
  // A kernel density naturally spills a few bandwidths beyond the extremes. Drawn, that
  // is a claim about values nobody observed — indefensible on the small samples these
  // plots are for. The body is clipped to the observed range.
  const one = {
    ...VIOLIN,
    groups: [grp('a', 'A', [10, 12, 14, 16, 18, 50])], // deliberate outlier at the top
  };
  const svg = renderChart(one, { ...defaultView(one), showPoints: false, summary: 'none' });
  const poly = svg.match(/<polygon points="([^"]+)"/)[1];
  const ys = poly.split(' ').map((p) => Number(p.split(',')[1]));
  const pointYs = yOf(renderChart(one, { ...defaultView(one), showPoints: true, summary: 'none' }));
  // SVG y grows downward, so the body's extremes must not exceed the data's.
  assert.ok(Math.min(...ys) >= Math.min(...pointYs) - 0.5, 'no bulge above the maximum');
  assert.ok(Math.max(...ys) <= Math.max(...pointYs) + 0.5, 'no bulge below the minimum');
});

test('a group with one observation gets no density body', () => {
  // A KDE from a single point is a bandwidth-shaped blob that says nothing about data.
  const one = { ...VIOLIN, groups: [grp('a', 'A', [5]), grp('b', 'B', spread(20, 40))] };
  const svg = renderChart(one, defaultView(one));
  assert.equal(count(svg, 'polygon'), 1, 'only the group that can support a density');
});

test('dots draws every observation, jittered but deterministically', () => {
  const svg1 = renderChart(SUPER, { ...defaultView(SUPER), legend: 'none' });
  const svg2 = renderChart(SUPER, { ...defaultView(SUPER), legend: 'none' });
  assert.equal(svg1, svg2, 'no Math.random: the same model must render identically');
  const xs = [...svg1.matchAll(/<circle[^>]*cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(new Set(xs).size > 4, 'points are spread, not stacked on one x');
});

test('SUPERPLOT: replicates take the colour, and each replicate mean is marked', () => {
  // Lord et al. (2020): the point is that the effect reproduces ACROSS experiments,
  // not across pooled cells — so the replicate means are the figure's real content.
  const svg = renderChart(SUPER, defaultView(SUPER));
  const spec = chartUiSpec(SUPER);
  assert.equal(spec.colorLabel, 'Replicates', 'colour follows the replicate, not the group');
  assert.deepEqual(spec.colorItems.map((i) => i.key), ['Rep 1', 'Rep 2', 'Rep 3']);
  const means = (svg.match(/<circle[^>]*stroke="#222222"/g) || []).length;
  assert.equal(means, 6, '2 groups x 3 replicates');
  assert.equal(count(svg, 'circle'), 36 + 6, 'observations plus the mean markers');
});

test('without replicates the SuperPlot machinery stays out of the way', () => {
  const plain = { ...SUPER, groups: SUPER.groups.map((g) => ({ ...g, reps: undefined })) };
  const spec = chartUiSpec(plain);
  assert.equal(spec.colorLabel, 'Groups');
  assert.equal(spec.controls.some((c) => c.id === 'replicateMeans'
    && (!c.visible || c.visible(defaultView(plain), plain))), false,
  'no replicate control on a figure with no replicates');
  // Circles only: the median/quartile summary LINES legitimately share this ink.
  const svg = renderChart(plain, defaultView(plain));
  assert.equal((svg.match(/<circle[^>]*stroke="#222222"/g) || []).length, 0,
    'no replicate-mean markers');
  assert.ok((svg.match(/<line[^>]*stroke="#222222"/g) || []).length > 0,
    'but the median/quartile summary is still drawn');
});

test('paired draws one line per subject and colours by direction of change', () => {
  const svg = renderChart(PAIRED, defaultView(PAIRED));
  assert.equal(count(svg, 'polyline'), 10, 'one line per subject');
  assert.equal(count(svg, 'circle'), 20, 'both endpoints of each');
  // 3 of the 10 subjects go DOWN (i % 4 === 0 → i = 0, 4, 8), so two colours are used.
  const strokes = new Set([...svg.matchAll(/<polyline[^>]*stroke="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(strokes.size, 2, 'increase and decrease are distinguished');
});

test('paired refuses a single condition rather than drawing a meaningless line', () => {
  const one = { ...PAIRED, conditions: [{ key: 'pre', label: 'Before' }] };
  assert.match(renderChart(one, defaultView(one)), /two conditions/i);
});

test('every new kind names itself for a screen reader, with a correct plural', () => {
  for (const [model, want] of [[VIOLIN, /^Violin plot:/], [SUPER, /^Dot plot:/], [PAIRED, /^Before-after plot:/]]) {
    const title = renderChart(model, defaultView(model)).match(/<title>([^<]*)<\/title>/)[1];
    assert.match(title, want);
    assert.ok(!/\b1 (groups|observations|subjects|conditions)\b/.test(title), `bad plural: ${title}`);
  }
  const single = { ...VIOLIN, groups: [grp('a', 'A', [1, 2])] };
  const t = renderChart(single, defaultView(single)).match(/<title>([^<]*)<\/title>/)[1];
  assert.match(t, /1 group,/);
});

test('all three declare grouped controls, so the panel stays navigable', () => {
  for (const model of [VIOLIN, SUPER, PAIRED]) {
    const ungrouped = chartUiSpec(model).controls.filter((c) => !c.group).map((c) => c.id);
    assert.deepEqual(ungrouped, [], `${model.kind} has ungrouped controls: ${ungrouped}`);
  }
});
