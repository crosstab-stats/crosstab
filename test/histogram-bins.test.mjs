/**
 * @file histogram-bins.test.mjs
 * The `histogram` chart kind's binning (#174o).
 *
 * This kind is the only one handed the raw observations rather than a summary,
 * because a histogram's intervals ARE its argument: the same column reads bimodal
 * at six intervals and smooth at twelve, and where a boundary falls decides which
 * side of "18" a seventeen-year-old lands on. Binning therefore happens at render
 * time, from live controls — which makes the binning itself the thing most worth
 * pinning, and the place where a wrong answer would look exactly like a right one.
 *
 * The invariant every case here checks is **no value silently disappears**. A bar
 * chart that drops the maximum, or the low tail when you move the first boundary
 * up, is not visibly broken; it is just quietly wrong. The kind's alt text states
 * how many values were actually binned, so that claim is checkable rather than
 * taken on trust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Core ships no chart kinds; the builtin-charts plugin does. Register its real
// kinds locally so these tests drive the shipping code, not a stub.
await import('./chart-kinds-harness.mjs');

const { defaultView, renderChart, chartUiSpec, controlVisible } = await import('../core/chart-renderer.js');

/** 30 ages, 25..61 — the quantitative demo's `age`, so the numbers are comparable
 * with what the browser pass showed. */
const AGES = [45, 33, 28, 52, 41, 39, 25, 58, 36, 29, 49, 61, 44, 31, 38, 55, 27, 42,
  50, 35, 30, 57, 40, 43, 26, 60, 37, 32, 53, 34];

const model = (values = AGES) => ({
  kind: 'histogram',
  title: 'Histogram of Age',
  values,
  axes: { x: { title: 'Age' }, y: { title: 'Count' } },
});

const draw = (view = {}, m = model()) => renderChart(m, { ...defaultView(m), ...view });

/** The kind's own account of what it drew: intervals, values binned, and the span. */
function alt(svg) {
  const m = svg.match(/<title>([^<]*)<\/title>/);
  assert.ok(m, 'the chart should carry a <title> describing it');
  const a = m[1];
  const bits = a.match(/(\d+) intervals? over ([\d,]+) values?, from (-?[\d.,]+) to (-?[\d.,]+)/);
  assert.ok(bits, `alt text did not parse: ${a}`);
  const outside = a.match(/([\d,]+) values? outside/);
  return {
    intervals: Number(bits[1]),
    binned: Number(bits[2].replace(/,/g, '')),
    lo: Number(bits[3].replace(/,/g, '')),
    hi: Number(bits[4].replace(/,/g, '')),
    outside: outside ? Number(outside[1].replace(/,/g, '')) : 0,
    text: a,
  };
}

/** The width of every BAR drawn, in px. Bars are the stroked rects; the frame's
 * white background rect is not one. */
const barWidths = (svg) =>
  [...svg.matchAll(/<rect [^>]*width="([\d.]+)"[^>]*stroke="#fff"/g)].map((m) => Number(m[1]));

test('automatic binning is Sturges, and every value lands in an interval', () => {
  const a = alt(draw());
  assert.equal(a.intervals, 6); // ceil(log2(30)) + 1
  assert.equal(a.binned, AGES.length);
  assert.equal(a.outside, 0);
  assert.equal(a.lo, 25);
  assert.equal(a.hi, 61);
});

test('a requested interval count is honoured exactly, and still loses nothing', () => {
  for (const k of [2, 4, 7, 12, 30]) {
    const a = alt(draw({ binMode: 'count', binCount: k }));
    assert.equal(a.intervals, k, `asked for ${k} intervals`);
    assert.equal(a.binned, AGES.length, `all values binned at ${k} intervals`);
  }
});

test('the maximum lands INSIDE the last interval, not past its edge', () => {
  // The classic off-by-one: floor((max - min) / width) indexes one bin too far, so
  // the single largest case vanishes. Checked at several counts because whether it
  // bites depends on how the division rounds.
  for (const k of [3, 5, 6, 9, 11]) {
    const a = alt(draw({ binMode: 'count', binCount: k }));
    assert.equal(a.binned, AGES.length, `the maximum survived ${k} intervals`);
    assert.equal(a.hi, 61);
  }
});

test('interval width: bars are equal, and the anchor does not cut off the low tail', () => {
  const a = alt(draw({ binMode: 'width', binWidth: 10 }));
  assert.equal(a.binned, AGES.length);
  const w = barWidths(draw({ binMode: 'width', binWidth: 10 }));
  assert.ok(w.length >= 2);
  for (const x of w) assert.ok(Math.abs(x - w[0]) < 0.05, `bars should be equal width: ${w}`);

  // A first boundary ABOVE the minimum must widen the picture downward rather than
  // drop the cases below it — the failure mode a reader cannot see.
  const b = alt(draw({ binMode: 'width', binWidth: 10, binStart: 40 }));
  assert.equal(b.binned, AGES.length, 'an anchor above the minimum must not drop the low tail');
  assert.ok(b.lo <= 25, `binning should extend down to cover 25, got ${b.lo}`);
  assert.ok(b.hi > 61, `the maximum must be inside the last interval, got ${b.hi}`);

  // And an anchor below the minimum must not invent empty intervals off to the left.
  const c = alt(draw({ binMode: 'width', binWidth: 10, binStart: 20 }));
  assert.equal(c.lo, 20);
  assert.equal(c.binned, AGES.length);
});

test('custom cut points are used as given, and anything they miss is declared', () => {
  const a = alt(draw({ binMode: 'custom', binCuts: '20, 30, 40, 50, 70' }));
  assert.equal(a.intervals, 4);
  assert.equal(a.lo, 20);
  assert.equal(a.hi, 70);
  assert.equal(a.binned, AGES.length);
  assert.equal(a.outside, 0);

  // Cut points that do not span the data must SAY what they left out rather than
  // drawing a plausible chart of part of it.
  const short = draw({ binMode: 'custom', binCuts: '30, 40, 50' });
  const b = alt(short);
  assert.equal(b.intervals, 2);
  assert.ok(b.outside > 0, 'values outside the cut points should be declared');
  assert.equal(b.binned + b.outside, AGES.length);
  assert.match(short, /outside the cut points/);

  // Separators are whatever a person actually types.
  for (const s of ['20 30 40 50 70', '20;30;40;50;70', '20,30, 40 ,50,70']) {
    assert.equal(alt(draw({ binMode: 'custom', binCuts: s })).intervals, 4, s);
  }
});

test('fewer than two cut points falls back to automatic and says so', () => {
  const svg = draw({ binMode: 'custom', binCuts: '40' });
  assert.equal(alt(svg).intervals, 6);
  assert.match(svg, /at least two cut points/i);
});

test('a normal curve is drawn only where its scaling is defined', () => {
  // Equal intervals: the curve scales by n × width, so it is drawn.
  assert.match(draw({ normalCurve: true }), /<polyline/);
  // Unequal intervals in counts: there is no single width to scale by. Refuse, and
  // say why, rather than drawing a curve that matches nothing on screen.
  const uneven = draw({ normalCurve: true, binMode: 'custom', binCuts: '20, 30, 60, 70' });
  assert.doesNotMatch(uneven, /<polyline/);
  assert.match(uneven, /equal intervals/i);
  // Density is per unit of x, so it is defined whatever the intervals are.
  assert.match(draw({ normalCurve: true, binMode: 'custom', binCuts: '20, 30, 60, 70', yMeasure: 'density' }), /<polyline/);
});

test('a single distinct value degenerates to one interval instead of dividing by zero', () => {
  const a = alt(draw({}, model([7, 7, 7, 7])));
  assert.equal(a.intervals, 1);
  assert.equal(a.binned, 4);
});

test('non-finite values are excluded before binning, not counted as zero', () => {
  const a = alt(draw({}, model([1, 2, 3, NaN, null, undefined, 4, 'x'])));
  assert.equal(a.binned, 4);
  assert.equal(a.lo, 1);
  assert.equal(a.hi, 4);
});

test('an empty column reports instead of drawing an empty frame', () => {
  assert.match(renderChart(model([]), defaultView(model([]))), /no finite values/i);
});

test('the bin controls are offered, and only the ones the mode uses are shown', () => {
  const m = model();
  const controls = chartUiSpec(m).controls;
  const ids = controls.map((c) => c.id);
  for (const id of ['binMode', 'binCount', 'binWidth', 'binStart', 'binCuts', 'edgeTicks', 'yMeasure', 'normalCurve']) {
    assert.ok(ids.includes(id), `missing control: ${id}`);
  }
  const visible = (view) => {
    const v = { ...defaultView(m), ...view };
    return controls.filter((c) => controlVisible(c, v, controls)).map((c) => c.id);
  };

  const onCount = visible({ binMode: 'count' });
  assert.ok(onCount.includes('binCount'));
  assert.ok(!onCount.includes('binWidth'));
  assert.ok(!onCount.includes('binCuts'));

  const onWidth = visible({ binMode: 'width' });
  assert.ok(onWidth.includes('binWidth'));
  assert.ok(onWidth.includes('binStart'));
  assert.ok(!onWidth.includes('binCount'));

  const onCustom = visible({ binMode: 'custom' });
  assert.ok(onCustom.includes('binCuts'));
  assert.ok(!onCustom.includes('binWidth'));
});

test('percent and density are rescalings of the same bars, not different binning', () => {
  const counts = alt(draw({ binMode: 'count', binCount: 6 }));
  for (const yMeasure of ['percent', 'density']) {
    const a = alt(draw({ binMode: 'count', binCount: 6, yMeasure }));
    assert.equal(a.intervals, counts.intervals);
    assert.equal(a.binned, counts.binned);
  }
});
