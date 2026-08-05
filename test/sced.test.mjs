/**
 * @file sced.test.mjs
 * The hand-rolled SCED statistics, checked against the R package `scan`.
 *
 * These indices are hand-rolled because `scan` cannot run in WebR (its dependency tree
 * exceeds the WASM build's limit on concurrently-loaded shared objects — see the plugin
 * header). That makes this file the safety net required by the project rule on
 * hand-rolled statistics: every expected value below was produced by
 * `scripts/validation/sced-reference.R` on desktop R, and re-running that script
 * regenerates them.
 *
 * The fixture OVERLAPS the phases deliberately. Cleanly separated phases drive every
 * non-overlap index to its ceiling (NAP 100, PND 100, Tau 1.0), which a wrong
 * implementation passes just as easily as a right one.
 *
 *   Ann  A = 5, 7, 6, 8      B = 7, 9, 8, 11, 10
 *   Ben  A = 4, 6, 5, 7, 5   B = 6, 5, 9, 8
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  napFor, pndFor, irdFor, pandMinimum, tauUTable, kendallTau, wilcoxonP,
  normalCdf, normalQuantile,
} from '../plugins/builtin-sced/index.js';

const ANN = { A: [5, 7, 6, 8], B: [7, 9, 8, 11, 10] };
const BEN = { A: [4, 6, 5, 7, 5], B: [6, 5, 9, 8] };

/** Agreement to `dp` decimal places — the precision the reference was printed at. */
function near(actual, expected, tol, what) {
  assert.ok(Number.isFinite(actual), `${what}: expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} (Δ ${Math.abs(actual - expected)} > ${tol})`);
}

// --- the distributions the indices lean on -----------------------------------

test('normalCdf matches R pnorm to 1e-12', () => {
  // R, options(digits = 17): pnorm(c(-3,-1.959963984540054,-1,0,0.5,1.976129,3))
  const cases = [
    [-3, 0.0013498980316300946],
    [-1.959963984540054, 0.0250000000000000118],
    [-1, 0.1586552539314570465],
    [0, 0.5],
    [0.5, 0.6914624612740130072],
    [1.976129, 0.9759299156636245254],
    [3, 0.9986501019683698965],
  ];
  for (const [x, want] of cases) near(normalCdf(x), want, 1e-12, `pnorm(${x})`);
});

test('normalQuantile inverts it to 1e-12', () => {
  near(normalQuantile(0.975), 1.959963984540054, 1e-12, 'qnorm(.975)');
  near(normalQuantile(0.025), -1.959963984540054, 1e-12, 'qnorm(.025)');
  near(normalQuantile(0.5), 0, 1e-12, 'qnorm(.5)');
});

test('wilcoxonP matches R wilcox.test(exact = FALSE) with ties present', () => {
  // R: wilcox.test(c(5,7,6,8), c(7,9,8,11,10), alternative="less", exact=FALSE)$p.value
  near(wilcoxonP(ANN.A, ANN.B, 'less'), 0.031968373, 1e-9, 'Ann NAP p');
  near(wilcoxonP(BEN.A, BEN.B, 'less'), 0.105451463, 1e-9, 'Ben NAP p');
});

// --- NAP ---------------------------------------------------------------------

test('NAP matches scan::nap, counts and all', () => {
  const ann = napFor(ANN.A, ANN.B);
  assert.equal(ann.pairs, 20);
  assert.equal(ann.pos, 17);
  assert.equal(ann.ties, 2);
  near(ann.nonOverlaps, 18.0, 1e-12, 'Ann non-overlaps');
  near(ann.nap, 90.0, 1e-12, 'Ann NAP');
  near(ann.p, 0.031968373, 1e-9, 'Ann p');

  const ben = napFor(BEN.A, BEN.B);
  assert.equal(ben.pairs, 20);
  assert.equal(ben.pos, 14);
  assert.equal(ben.ties, 3);
  near(ben.nonOverlaps, 15.5, 1e-12, 'Ben non-overlaps');
  near(ben.nap, 77.5, 1e-12, 'Ben NAP');
  near(ben.p, 0.105451463, 1e-9, 'Ben p');
});

test('NAP direction reverses when improvement means a decrease', () => {
  // Mirroring the data must mirror the index: NAP(down on -x) == NAP(up on x).
  const up = napFor(ANN.A, ANN.B, { decreasing: false });
  const down = napFor(ANN.A.map((v) => -v), ANN.B.map((v) => -v), { decreasing: true });
  near(down.nap, up.nap, 1e-12, 'mirrored NAP');
  near(down.p, up.p, 1e-12, 'mirrored p');
});

// --- PND ---------------------------------------------------------------------

test('PND matches scan::pnd', () => {
  near(pndFor(ANN.A, ANN.B), 60, 1e-12, 'Ann PND');
  near(pndFor(BEN.A, BEN.B), 50, 1e-12, 'Ben PND');
});

// --- IRD / PAND --------------------------------------------------------------

test('PAND (minimum method) finds the largest non-overlapping subset', () => {
  // Ann: keep all 4 baseline points and the 3 highest intervention points → 7 of 9.
  assert.equal(pandMinimum(ANN.A, ANN.B).nonoverlaps, 7);
  assert.equal(pandMinimum(BEN.A, BEN.B).nonoverlaps, 7);
});

test('IRD matches scan::ird — one study-level figure across both cases', () => {
  const r = irdFor([ANN, BEN]);
  assert.equal(r.n, 18);
  assert.equal(r.nonoverlaps, 14);
  near(r.ird, 0.556, 5e-4, 'IRD');
});

// --- Tau-U -------------------------------------------------------------------

/** The reference table for Ann, from scan::tau_u(method = "complete"). */
const ANN_TAU = {
  'A vs. B': { pairs: 20, pos: 17, neg: 1, ties: 2, S: 16, D: 19.0, tau: 0.842105, ciLower: 0.403829, ciUpper: 0.965988, sdS: 8.164966, varS: 66.666667, seTau: 0.426139, Z: 1.976129, p: 0.048140 },
  'Trend A': { pairs: 6, pos: 5, neg: 1, ties: 0, S: 4, D: 6.0, tau: 0.666667, sdS: 2.943920, varS: 8.666667, seTau: 0.490653, Z: 1.358732, p: 0.174231 },
  'Trend B': { pairs: 10, pos: 8, neg: 2, ties: 0, S: 6, D: 10.0, tau: 0.600000, sdS: 4.082483, varS: 16.666667, seTau: 0.408248, Z: 1.469694, p: 0.141645 },
  'A vs. B - Trend A': { pairs: 26, pos: 18, neg: 6, ties: 2, S: 12, D: 29.73214, tau: 0.403604, sdS: 8.595865, varS: 73.888889, seTau: 0.289110, Z: 1.396020, p: 0.162708 },
  'A vs. B + Trend B': { pairs: 30, pos: 25, neg: 3, ties: 2, S: 22, D: 31.93744, tau: 0.688847, sdS: 9.036961, varS: 81.666667, seTau: 0.282958, Z: 2.434447, p: 0.014915 },
  'A vs. B + Trend B - Trend A': { pairs: 36, pos: 26, neg: 8, ties: 2, S: 18, D: 34.98571, tau: 0.514496, sdS: 9.486833, varS: 90.000000, seTau: 0.271163, Z: 1.897367, p: 0.057780 },
};

/** …and for Ben, whose A vs. B differs in every tie-sensitive quantity. */
const BEN_TAU = {
  'A vs. B': { pairs: 20, pos: 14, neg: 3, ties: 3, S: 11, D: 18.5, tau: 0.594595, ciLower: -0.114899, ciUpper: 0.902381, sdS: 8.164966, seTau: 0.432057, Z: 1.376195, p: 0.168761 },
  'Trend A': { pairs: 10, pos: 6, neg: 3, ties: 1, S: 3, D: 9.486833, tau: 0.316228, Z: 0.757937, p: 0.448489 },
  'Trend B': { pairs: 6, pos: 4, neg: 2, ties: 0, S: 2, D: 6.0, tau: 0.333333, Z: 0.679366, p: 0.496906 },
  'A vs. B - Trend A': { pairs: 30, pos: 17, neg: 9, ties: 4, S: 8, D: 30.983867, tau: 0.258199, Z: 0.897998, p: 0.369187 },
  'A vs. B + Trend B': { pairs: 26, pos: 18, neg: 5, ties: 3, S: 13, D: 28.844410, tau: 0.450694, Z: 1.533587, p: 0.125131 },
  'A vs. B + Trend B - Trend A': { pairs: 36, pos: 21, neg: 11, ties: 4, S: 10, D: 33.941125, tau: 0.294628, Z: 1.070065, p: 0.284590 },
};

for (const [name, { A, B }, expected] of [['Ann', ANN, ANN_TAU], ['Ben', BEN, BEN_TAU]]) {
  test(`Tau-U matches scan::tau_u for ${name} — all six comparisons`, () => {
    const rows = new Map(tauUTable(A, B).map((r) => [r.comparison, r]));
    assert.deepEqual([...rows.keys()], Object.keys(expected), 'row set and order');
    for (const [comparison, want] of Object.entries(expected)) {
      const got = rows.get(comparison);
      for (const field of ['pairs', 'pos', 'neg', 'ties', 'S']) {
        assert.equal(got[field], want[field], `${name} / ${comparison} / ${field}`);
      }
      // The reference is printed to six decimals, so that is the achievable tolerance.
      for (const field of ['D', 'tau', 'ciLower', 'ciUpper', 'sdS', 'varS', 'seTau', 'Z', 'p']) {
        if (want[field] === undefined) continue;
        near(got[field], want[field], 5e-6, `${name} / ${comparison} / ${field}`);
      }
    }
  });
}

test('THE QUIRK: Tau-U reports a VAR_S that disagrees with its own Z, exactly as scan does', () => {
  // scan takes SD_S from a closed form but Z from kendall_tau's tie-corrected variance.
  // With ties present the two differ, so S / SD_S !== Z. This is not our bug to fix —
  // a researcher diffing our table against scan's needs the same numbers in the same
  // cells — but it must be a deliberate, pinned choice rather than an accident.
  const avb = tauUTable(ANN.A, ANN.B)[0];
  near(avb.sdS, 8.164966, 5e-6, 'reported SD_S');
  near(avb.Z, 1.976129, 5e-6, 'reported Z');
  const impliedZ = avb.S / avb.sdS;
  assert.ok(Math.abs(impliedZ - avb.Z) > 1e-3,
    `expected the documented disagreement; S/SD_S = ${impliedZ}, Z = ${avb.Z}`);
});

test('kendall_tau reduces to the textbook no-ties case', () => {
  // Perfectly concordant, no ties: S = n0, tau = 1, and tau-a and tau-b agree.
  const x = [1, 2, 3, 4, 5];
  const b = kendallTau(x, x);
  const a = kendallTau(x, x, { tauMethod: 'a' });
  assert.equal(b.S, 10);
  near(b.tau, 1, 1e-12, 'tau-b');
  near(a.tau, 1, 1e-12, 'tau-a');
  near(b.sdS, Math.sqrt((5 * 4 * 15) / 18), 1e-12, 'sdS with no ties');
  // Perfectly discordant mirrors it.
  near(kendallTau(x, [...x].reverse()).tau, -1, 1e-12, 'reversed');
});

// --- degenerate inputs -------------------------------------------------------

test('an empty intervention phase yields no numbers rather than a crash', () => {
  assert.ok(Number.isNaN(pndFor([1, 2, 3], [])));
  const r = napFor([1, 2, 3], []);
  assert.equal(r.pairs, 0);
  assert.ok(Number.isNaN(r.nap));
  const ird = irdFor([{ A: [1, 2, 3], B: [] }]);
  assert.ok(Number.isNaN(ird.ird));
});

test('a single baseline and single intervention point still computes', () => {
  const r = napFor([1], [2]);
  assert.equal(r.pairs, 1);
  near(r.nap, 100, 1e-12, 'NAP of one improving pair');
  near(pndFor([1], [2]), 100, 1e-12, 'PND');
});


// --- the chart kind ----------------------------------------------------------
// Pure string rendering, so it tests in Node. What's pinned here are the SCED DRAWING
// CONVENTIONS, which are requirements rather than styling: a reader of a multiple-
// baseline figure infers causation from the staggered boundaries, and a line drawn
// across a phase change asserts a continuity the design is trying to interrupt.

const { defaultView, renderChart, chartUiSpec } = await import('../core/chart-renderer.js');

const pts = (xs, ys, phase) => xs.map((x, i) => ({ x, y: ys[i], phase }));
const CHART = {
  kind: 'sced',
  title: 'Multiple baseline',
  phases: [{ key: 'A', label: 'Baseline' }, { key: 'B', label: 'Intervention' }],
  axes: { x: { title: 'Session' }, y: { title: 'Score' } },
  panels: [
    { key: 'ann', label: 'Ann', points: [...pts([1, 2, 3, 4], ANN.A, 'A'), ...pts([5, 6, 7, 8, 9], ANN.B, 'B')] },
    { key: 'ben', label: 'Ben', points: [...pts([1, 2, 3, 4, 5], BEN.A, 'A'), ...pts([6, 7, 8, 9], BEN.B, 'B')] },
  ],
};

// Phase ink is what identifies a boundary, in either style — asserting on the dash
// pattern is what made these tests fail the day solid became the default.
const PHASE_INK = '#222222';
const polylines = (svg) => [...svg.matchAll(/<polyline points="([^"]+)" fill="none" stroke="([^"]+)"/g)]
  .map((m) => ({ points: m[1].split(' ').map((p) => p.split(',').map(Number)), stroke: m[2] }));
const seriesLines = (svg) => polylines(svg).filter((p) => p.stroke !== PHASE_INK);
const staircase = (svg) => polylines(svg).find((p) => p.stroke === PHASE_INK) || null;
const phaseVerticals = (svg) => [...svg.matchAll(new RegExp(`<line x1="([\\d.]+)"[^>]*stroke="${PHASE_INK}"`, 'g'))]
  .map((m) => Number(m[1]));
/** Distinct x positions of the staircase's vertical risers. */
const risers = (svg) => {
  const s = staircase(svg);
  return s ? [...new Set(s.points.map(([x]) => x))] : [];
};

test('THE CONVENTION: no line is drawn across a phase change', () => {
  const svg = renderChart(CHART, defaultView(CHART));
  // Two cases x two phases = four separate segments, not two continuous ones.
  assert.equal(seriesLines(svg).length, 4);
  assert.equal((svg.match(/<circle/g) || []).length, 18, 'every observation is drawn');
});

test('THE CONVENTION: phase boundaries stagger with each case', () => {
  const svg = renderChart(CHART, defaultView(CHART));
  const xs = risers(svg);
  assert.equal(xs.length, 2, 'one riser per case');
  assert.ok(xs[0] < xs[1], 'Ann changes after session 4, Ben after 5 — the staircase');
});

test('the staircase is ONE connected path, not a line per panel', () => {
  // This is the point of it: the rollout has to read as a single sequence, which is
  // the experimental argument. Independent verticals say nothing about order.
  const svg = renderChart(CHART, defaultView(CHART));
  const s = staircase(svg);
  assert.ok(s, 'a connected phase path exists');
  assert.equal(phaseVerticals(svg).length, 0, 'and no loose vertical duplicates it');
  // down, across the gap, down again → at least 4 vertices, monotone in y.
  assert.ok(s.points.length >= 4, `expected a stepped path, got ${s.points.length} points`);
  const ys = s.points.map(([, y]) => y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'the path only ever descends');
});

test('staircase off falls back to an independent vertical per panel', () => {
  const svg = renderChart(CHART, { ...defaultView(CHART), staircase: false });
  assert.equal(staircase(svg), null);
  const xs = phaseVerticals(svg);
  assert.equal(xs.length, 2);
  assert.ok(xs[0] < xs[1], 'still staggered, just not joined');
});

test('phase lines are SOLID by default; dashed is the option', () => {
  const v = defaultView(CHART);
  assert.equal(v.phaseLineStyle, 'solid', 'JABA convention is a solid boundary');
  assert.equal((renderChart(CHART, v).match(/stroke-dasharray/g) || []).length, 0);
  assert.ok((renderChart(CHART, { ...v, phaseLineStyle: 'dashed' }).match(/stroke-dasharray/g) || []).length > 0);
});

test('connectAcross is available but off, and joins the phases when asked', () => {
  const v = defaultView(CHART);
  assert.equal(v.connectAcross, false, 'must default off');
  assert.equal(seriesLines(renderChart(CHART, { ...v, connectAcross: true })).length, 2);
});

test('an ABAB reversal draws all three boundaries with no extra plumbing', () => {
  // Phases are derived as runs of the point sequence, so a withdrawal design needs no
  // special casing. One panel means no staircase to connect, so they stay verticals.
  const abab = {
    ...CHART,
    panels: [{
      key: 'c',
      label: 'Cass',
      points: [...pts([1, 2, 3], [2, 3, 2], 'A'), ...pts([4, 5, 6], [7, 8, 7], 'B'),
        ...pts([7, 8], [3, 2], 'A'), ...pts([9, 10], [8, 9], 'B')],
    }],
  };
  const svg = renderChart(abab, defaultView(abab));
  assert.equal(phaseVerticals(svg).length, 3);
  assert.equal(seriesLines(svg).length, 4, 'one segment per run');
});

test('a reversal INSIDE a staircase keeps its extra boundaries local', () => {
  // The staircase claims the first boundary of each panel; later ones are still that
  // panel's own business, so an ABAB case in a multi-case figure draws both kinds.
  const mixed = {
    ...CHART,
    panels: [
      CHART.panels[0],
      { key: 'c', label: 'Cass', points: [...pts([1, 2, 3], [2, 3, 2], 'A'), ...pts([4, 5], [7, 8], 'B'), ...pts([6, 7], [3, 2], 'A')] },
    ],
  };
  const svg = renderChart(mixed, defaultView(mixed));
  assert.ok(staircase(svg), 'first boundaries are connected');
  assert.equal(phaseVerticals(svg).length, 1, "Cass's second boundary stays a plain vertical");
});

test('black & white mode drops colour AND the legend that would explain it', () => {
  // In mono the phases are the same ink, so a colour legend would claim to carry
  // information it does not. Phase is read off the staircase and condition labels.
  const svg = renderChart(CHART, { ...defaultView(CHART), mono: true, legend: 'bottom' });
  const strokes = new Set(seriesLines(svg).map((p) => p.stroke));
  assert.deepEqual([...strokes], ['#000000'], 'every series line is black');
  // Every ink in the figure must be achromatic — the real definition of monochrome,
  // and it catches a palette colour leaking in however it is spelled.
  for (const hex of new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6})"/g)].map((m) => m[1]))) {
    const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    const [r0, g0, b0] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
    assert.ok(r0 === g0 && g0 === b0, `${hex} is not greyscale — a palette colour survived mono`);
  }
  const ids = chartUiSpec(CHART).controls;
  const legend = ids.find((c) => c.id === 'legend');
  assert.equal(legend.visible({ mono: true }, CHART), false, 'legend control hides in mono');
  assert.equal(legend.visible({ mono: false }, CHART), true, 'and returns in colour');
});

test('a panel context label is drawn rotated in the left gutter', () => {
  const withCtx = {
    ...CHART,
    panels: CHART.panels.map((p, i) => ({ ...p, context: i ? "Newcomer's arrival" : 'Given an item' })),
  };
  const svg = renderChart(withCtx, defaultView(withCtx));
  assert.ok(svg.includes('Given an item'), 'context text present');
  assert.ok(svg.includes("Newcomer's arrival"), 'apostrophe passes through � esc() only handles &<>"');
  // Y axis title + 2 contexts + 2 case names — the published double-gutter setup.
  assert.equal((svg.match(/transform="rotate\(-90/g) || []).length, 5);
  assert.ok(!/text-anchor="end" font-weight="600">Ann</.test(svg), 'case name left the panel');

  // The gutters must actually be reserved, or the captions collide with the ticks.
  const xOf = (s) => Number(s.match(/<line x1="([\d.]+)" y1="[\d.]+" x2="\1"/)[1]);
  const noCtx = renderChart(CHART, defaultView(CHART));
  assert.ok(xOf(svg) > xOf(noCtx), 'the context gutter pushes the plot right');
  const inPanel = renderChart(withCtx, { ...defaultView(withCtx), caseLabel: 'panel' });
  assert.ok(xOf(svg) > xOf(inPanel), 'and the case gutter adds a second column');
});

test('long captions wrap into stacked columns instead of being truncated', () => {
  // "Acknowledging and Complimenting Others" is 38 chars against a ~130px panel. The
  // first cut clipped to the panel height and lost most of every real label.
  const long = {
    ...CHART,
    panels: CHART.panels.map((p) => ({
      ...p, label: 'Acknowledging and Complimenting Others', context: "Newcomer's Arrival",
    })),
  };
  const svg = renderChart(long, defaultView(long));
  const spans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
  const caption = spans.filter((x) => x.includes('Acknowledging') || x.includes('Complimenting'));
  assert.ok(caption.length >= 2, `expected the caption to wrap, got ${JSON.stringify(spans)}`);
  assert.equal(caption.slice(0, 2).join(' '), 'Acknowledging and Complimenting Others', 'nothing lost in the wrap');
  assert.ok(!spans.some((x) => x.length > 30), 'no single line runs the full caption');
  // Wrapping widens the gutter, so a taller panel (more room per line) needs fewer.
  const tall = renderChart(long, { ...defaultView(long), panelHeight: 300 });
  const lines = (s) => (s.match(/<tspan/g) || []).length;
  assert.ok(lines(tall) < lines(svg), 'taller panels fit more per line');
});

test('Y tick density is adjustable, and defaults to the 0/20/…/100 convention', () => {
  const pct = {
    ...CHART,
    panels: [{ key: 'a', label: 'A', points: [...pts([1, 2, 3], [0, 50, 20], 'A'), ...pts([4, 5, 6], [80, 100, 90], 'B')] }],
  };
  const v = defaultView(pct);
  assert.equal(v.yTickCount, 5);
  const labels = (svg) => (svg.match(/text-anchor="end">[\d.]+<\/text>/g) || []).length;
  assert.equal(labels(renderChart(pct, v)), 6, '0,20,40,60,80,100');
  assert.ok(labels(renderChart(pct, { ...v, yTickCount: 2 })) < 6, 'fewer when asked');
});

test('the chart grows a panel per case rather than squeezing a fixed frame', () => {
  const h = (n) => {
    const m = { ...CHART };
    m.panels = Array.from({ length: n }, (_, i) => ({ ...CHART.panels[0], key: `c${i}`, label: `Case ${i}` }));
    return Number(renderChart(m, defaultView(m)).match(/viewBox="0 0 720 ([\d.]+)"/)[1]);
  };
  assert.ok(h(4) > h(1), 'four cases must be taller than one');
  assert.ok(h(4) > 3 * h(1) - 400, 'and grow roughly per panel, not by a fixed pad');
});

test('the host offers the SCED-specific controls, not just the shared ones', () => {
  const ids = chartUiSpec(CHART).controls.map((c) => c.id);
  for (const id of ['mark', 'connectAcross', 'phaseLines', 'staircase', 'phaseLineStyle',
    'phaseLabels', 'sharedY', 'mono', 'panelHeight', 'yTickCount']) {
    assert.ok(ids.includes(id), `missing host-mediated control: ${id}`);
  }
  assert.deepEqual(chartUiSpec(CHART).colorItems.map((i) => i.key), ['A', 'B'], 'colour is per phase');
});

test('an empty chart reports rather than throwing', () => {
  const empty = { ...CHART, panels: [] };
  assert.match(renderChart(empty, defaultView(empty)), /no cases/i);
});

test('THE CONVENTION: tiers are ordered by when the intervention arrives', () => {
  // Real data arrives in whatever order the file had — often alphabetical. Alber-Morgan
  // sorted by name is Andrew(18), Brian(16), Kelly(11), Theo(5), which draws the
  // staircase BACKWARDS: correct data, broken convention, and it reads as a bug.
  const late = (start, n) => [
    ...pts(Array.from({ length: start - 1 }, (_, i) => i + 1), Array.from({ length: start - 1 }, () => 5), 'A'),
    ...pts(Array.from({ length: n }, (_, i) => start + i), Array.from({ length: n }, () => 80), 'B'),
  ];
  const scrambled = {
    ...CHART,
    panels: [
      { key: 'andrew', label: 'Andrew', points: late(18, 6) },
      { key: 'brian', label: 'Brian', points: late(16, 6) },
      { key: 'kelly', label: 'Kelly', points: late(11, 6) },
      { key: 'theo', label: 'Theo', points: late(5, 6) },
    ],
  };
  const inPanel = { ...defaultView(scrambled), caseLabel: 'panel' };
  const xs = risers(renderChart(scrambled, inPanel));
  assert.equal(xs.length, 4);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'the staircase must descend left to right');

  // …and the panels themselves are reordered, not just the line.
  const svg = renderChart(scrambled, inPanel);
  const order = [...svg.matchAll(/text-anchor="end" font-weight="600">([A-Za-z]+)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Theo', 'Kelly', 'Brian', 'Andrew'], 'earliest intervention on top');

  // Opting out restores the file's own order.
  const asIs = renderChart(scrambled, { ...inPanel, panelOrder: 'model' });
  const xs2 = risers(asIs);
  assert.deepEqual(xs2, [...xs2].sort((a, b) => b - a), 'data order here happens to be reversed');
});

test('panels that never change phase keep their place at the end', () => {
  const flat = {
    ...CHART,
    panels: [
      { key: 'never', label: 'Never', points: pts([1, 2, 3, 4], [1, 2, 1, 2], 'A') },
      CHART.panels[1], // Ben, boundary after session 5
      CHART.panels[0], // Ann, boundary after session 4
    ],
  };
  const svg = renderChart(flat, { ...defaultView(flat), caseLabel: 'panel' });
  const order = [...svg.matchAll(/text-anchor="end" font-weight="600">([A-Za-z]+)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Ann', 'Ben', 'Never'], 'no-boundary tiers sort last, stably');
});
