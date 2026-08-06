/**
 * @file step-forest-charts.test.mjs
 * The `steps` and `forest` chart kinds — the last two figures that were baked in R.
 *
 * What is pinned here is mostly about the mark making a TRUE claim. A survival curve
 * drawn as a straight line between events asserts a gradual decline the estimator
 * explicitly does not claim; a forest plot whose boxes scale linearly with weight
 * makes a 4×-weighted study look 16× as important. Neither error is visible to a
 * reader who did not already know the right answer, which is exactly why they belong
 * in tests rather than in a visual check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { defaultView, renderChart, chartUiSpec } = await import('../core/chart-renderer.js');

/** A two-arm Kaplan–Meier model shaped exactly as builtin-survival emits it. */
const KM = {
  kind: 'steps',
  title: 'Kaplan–Meier survival',
  markLabel: 'Censoring marks',
  axes: { x: { title: 'Months' }, y: { title: 'Survival probability' } },
  series: [
    {
      key: 'k0',
      label: 'Treated',
      points: [
        { x: 0, y: 1, lo: 1, hi: 1 },
        { x: 4, y: 0.9, lo: 0.72, hi: 1 },
        { x: 11, y: 0.75, lo: 0.55, hi: 0.95 },
        { x: 20, y: 0.5, lo: 0.28, hi: 0.79 },
      ],
      marks: [{ x: 14, y: 0.75 }],
    },
    {
      key: 'k1',
      label: 'Control',
      points: [
        { x: 0, y: 1 },
        { x: 2, y: 0.8 },
        { x: 9, y: 0.45 },
        { x: 18, y: 0.2 },
      ],
      marks: [],
    },
  ],
  view: { yAxisMin: 0, yAxisMax: 1 },
};

const FOREST = {
  kind: 'forest',
  title: 'Forest plot',
  refLine: 0,
  valueHeading: 'Effect [95% CI]',
  axes: { x: { title: "Hedges' g" } },
  studies: [
    { key: 's0', label: 'Alvarez 1998', est: 0.42, lo: 0.18, hi: 0.66, weight: 64 },
    { key: 's1', label: 'Bhatt 2004', est: 0.11, lo: -0.30, hi: 0.52, weight: 16 },
    { key: 's2', label: 'Okafor 2011', est: 0.55, lo: 0.02, hi: 1.08, weight: 4 },
  ],
  summary: { label: 'Pooled (random effects)', est: 0.36, lo: 0.17, hi: 0.55 },
};

const render = (model, over = {}) => renderChart(model, { ...defaultView(model), ...over });

/** The study boxes, skipping the white full-canvas background every chart opens with. */
const studyBoxes = (svg) => [...svg.matchAll(/<rect x="([\d.-]+)" y="[\d.-]+" width="([\d.]+)"[^>]*fill="([^"]+)"/g)]
  .filter((m) => m[3] !== '#ffffff')
  // `cx` matters: a box is drawn from its left edge, but it MEANS its centre. Comparing
  // left edges to the reference line silently offsets every measurement by half a box.
  .map((m) => ({ x: Number(m[1]), w: Number(m[2]), cx: Number(m[1]) + Number(m[2]) / 2 }));

// --- steps -------------------------------------------------------------------

test('steps draws a staircase, not a line between events', () => {
  const svg = render(KM);
  // A staircase is horizontal-then-vertical pairs. A polyline through the same points
  // would claim the estimate slid downwards between events; Kaplan–Meier claims the
  // opposite — flat until an event, then a drop.
  const path = /<path d="(M [^"]*?)" fill="none"/.exec(svg);
  assert.ok(path, 'expected a stroked step path');
  assert.match(path[1], /^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+/, 'path must hold then step');
  assert.ok(!/ L /.test(path[1]), 'a step path must never use a diagonal lineto');
});

test('steps honours elapsed time on x — gaps are not drawn equal', () => {
  const svg = render(KM);
  // Treated: events at 0, 4, 11, 20. The 4→11 gap (7) must be wider on the page than
  // the 0→4 gap (4). Category-style even spacing would make them identical and the
  // curve would silently misreport when the drops happened.
  const [d] = /<path d="(M[^"]*)" fill="none"/.exec(svg).slice(1);
  const xs = [...d.matchAll(/[MH] ([\d.]+)/g)].map((m) => Number(m[1]));
  const g1 = xs[1] - xs[0];
  const g2 = xs[2] - xs[1];
  assert.ok(g2 > g1 * 1.5, `expected 7 units wider than 4 units, got ${g1} then ${g2}`);
});

test('steps shows a confidence band only where the data carries one', () => {
  const withBand = render(KM);
  assert.match(withBand, /fill-opacity="0\.15"/, 'CI band should be on by default');

  const noCi = { ...KM, series: [{ ...KM.series[1] }] }; // the arm with no lo/hi
  const svg = render(noCi);
  assert.ok(!/fill-opacity="0\.15"/.test(svg), 'no band when no interval was supplied');
  const ids = chartUiSpec(noCi).controls.filter((c) => !c.visible || c.visible({}, noCi)).map((c) => c.id);
  assert.ok(!ids.includes('confidenceBand'), 'band control must hide when nothing has an interval');
});

test('steps censoring marks are togglable and named by the model', () => {
  const on = render(KM);
  const off = render(KM, { censorMarks: false });
  assert.ok(on.length > off.length, 'turning marks off must change the drawing');

  const ctl = chartUiSpec(KM).controls.find((c) => c.id === 'censorMarks');
  // The mark means "censored" for survival and something else for other step data,
  // so the label comes from the model rather than being hardcoded in the kind.
  assert.equal(ctl.label, 'Censoring marks');
  assert.equal(chartUiSpec({ ...KM, markLabel: undefined }).controls.find((c) => c.id === 'censorMarks').label, 'Event marks');
});

test('steps announces itself to a screen reader with counts', () => {
  const alt = /<title>([^<]*)<\/title>/.exec(render(KM))[1];
  assert.match(alt, /Step chart|Kaplan/, 'alt text names the chart');
  assert.match(alt, /2 curves/, 'alt text says how much data there is');
});

test('steps survives an empty / all-NaN model without throwing', () => {
  assert.match(render({ kind: 'steps', series: [] }), /no points to plot/);
  assert.match(render({ kind: 'steps', series: [{ key: 'a', points: [{ x: NaN, y: NaN }] }] }), /no points to plot/);
});

// --- forest ------------------------------------------------------------------

test('forest box side scales with the SQUARE ROOT of weight', () => {
  const svg = render(FOREST);
  const sides = studyBoxes(svg).map((b) => b.w);
  assert.equal(sides.length, 3, 'one box per study');
  // Weights 64 : 16 : 4 → sides must go 1 : 1/2 : 1/4, because the reader judges the
  // mark by AREA. Linear sizing would make Alvarez look 16× Bhatt instead of 4×.
  assert.ok(Math.abs(sides[1] / sides[0] - 0.5) < 0.02, `16/64 should halve the side, got ${sides[1] / sides[0]}`);
  assert.ok(Math.abs(sides[2] / sides[0] - 0.25) < 0.02, `4/64 should quarter the side, got ${sides[2] / sides[0]}`);
});

test('forest diamond spans the pooled interval', () => {
  const svg = render(FOREST);
  const poly = /<polygon points="([^"]+)"/.exec(svg);
  assert.ok(poly, 'expected a summary diamond');
  const xs = poly[1].split(' ').map((p) => Number(p.split(',')[0]));
  const [left, , right] = [Math.min(...xs), 0, Math.max(...xs)];
  // The diamond's width IS the CI. A study box at the same estimate must sit inside it,
  // since the pooled interval (0.17–0.55) is narrower than Okafor's (0.02–1.08) but the
  // diamond still has real width — a zero-width diamond would mean we drew a scaled box.
  assert.ok(right - left > 10, 'diamond must span the pooled CI, not be a point');
});

test('forest reference line lands at the null and moves with the scale', () => {
  const linear = render(FOREST);
  assert.match(linear, /stroke-dasharray="4 3"/, 'null-effect line is drawn dashed');

  const ratio = {
    ...FOREST,
    refLine: 1,
    studies: [
      { key: 'a', label: 'A', est: 0.5, lo: 0.25, hi: 1.0, weight: 50 },
      { key: 'b', label: 'B', est: 2.0, lo: 1.0, hi: 4.0, weight: 50 },
    ],
    summary: { label: 'Pooled', est: 1.0, lo: 0.7, hi: 1.4 },
  };
  const svg = render(ratio, { logScale: true });
  const ref = Number(/<line x1="([\d.]+)" y1="[\d.-]+" x2="[\d.]+" y2="[\d.-]+" stroke="#888"/.exec(svg)[1]);
  const boxes = studyBoxes(svg).map((b) => b.cx);
  // On a log axis a halving and a doubling are equidistant from 1.0, so the null line
  // sits between the two boxes. On a linear axis it would be pushed hard left.
  const [loBox, hiBox] = boxes;
  assert.ok(ref > loBox && ref < hiBox, 'null line must fall between 0.5 and 2.0 on a log axis');
  const gapL = ref - loBox;
  const gapR = hiBox - ref;
  assert.ok(Math.abs(gapL - gapR) / gapL < 0.05, `0.5 and 2.0 should be equidistant from 1.0, got ${gapL} vs ${gapR}`);
});

test('forest colours studies as ONE population, not one hue each', () => {
  // Colouring each study differently would imply a grouping that a forest plot does
  // not have. One colour item keeps the palette/legend controls correctly hidden.
  const spec = chartUiSpec(FOREST);
  assert.equal(spec.colorItems.length, 1);
  assert.equal(spec.colorItems[0].label, 'Studies');
});

test('forest grows its canvas with the study count', () => {
  const vb = (n) => {
    const studies = Array.from({ length: n }, (_, i) => ({ key: `s${i}`, label: `Study ${i}`, est: 0.2, lo: 0, hi: 0.4, weight: 1 }));
    const svg = render({ ...FOREST, studies });
    return Number(/viewBox="0 0 \d+ ([\d.]+)"/.exec(svg)[1]);
  };
  // 40 studies cannot be squeezed into the shared 460px canvas without colliding rows.
  assert.ok(vb(40) > vb(3) * 2, 'canvas height must track the number of rows');
});

test('forest weight column hides when no weights were supplied', () => {
  const noW = { ...FOREST, studies: FOREST.studies.map(({ weight, ...s }) => s) };
  // Absent, not hidden: no study carries a weight, so the column can never apply here.
  assert.equal(chartUiSpec(noW).controls.find((c) => c.id === 'showWeights'), undefined);
  assert.ok(chartUiSpec(FOREST).controls.find((c) => c.id === 'showWeights'), 'present when weights exist');
  assert.ok(!render(noW).includes('Weight'), 'no weight heading without weights');
});

test('forest survives missing intervals and an absent summary', () => {
  const bare = { kind: 'forest', studies: [{ key: 'a', label: 'A', est: 0.5 }] };
  const svg = render(bare);
  assert.match(svg, /<rect/, 'still draws the estimate box');
  assert.ok(!svg.includes('<polygon'), 'no diamond without a summary');
  assert.match(render({ kind: 'forest', studies: [] }), /no study estimates/);
});

test('both kinds name themselves for alt text without a table in core', () => {
  assert.match(/<title>([^<]*)<\/title>/.exec(render(FOREST))[1], /Forest plot/);
  // An untitled model still gets the kind noun, which is the case the old lookup
  // table silently answered "Chart" for whenever a kind forgot to register itself.
  const alt = /<title>([^<]*)<\/title>/.exec(render({ ...FOREST, title: undefined }))[1];
  assert.match(alt, /^Forest plot\./);
});
