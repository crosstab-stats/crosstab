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
// Pure string rendering, so it tests in Node. What's pinned here are the two SCED
// DRAWING CONVENTIONS, which are requirements rather than styling: a reader of a
// multiple-baseline figure infers causation from the staggered boundaries, and a line
// drawn across a phase change asserts a continuity the design is trying to interrupt.

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

/** x positions of the dashed phase-change lines, in document order. */
const boundaryXs = (svg) => [...svg.matchAll(/<line x1="([\d.]+)"[^>]*stroke-dasharray/g)].map((m) => Number(m[1]));

test('THE CONVENTION: no line is drawn across a phase change', () => {
  const svg = renderChart(CHART, defaultView(CHART));
  // Two cases x two phases = four separate segments, not two continuous ones.
  assert.equal((svg.match(/<polyline/g) || []).length, 4);
  assert.equal((svg.match(/<circle/g) || []).length, 18, 'every observation is drawn');
});

test('THE CONVENTION: phase boundaries stagger with each case, and sit between sessions', () => {
  const svg = renderChart(CHART, defaultView(CHART));
  const xs = boundaryXs(svg);
  assert.equal(xs.length, 2, 'one boundary per case');
  assert.notEqual(xs[0], xs[1], 'Ann changes phase after session 4, Ben after 5 — the staircase');
  assert.ok(xs[0] < xs[1], 'and in the right direction');
});

test('connectAcross is available but off, and joins the phases when asked', () => {
  const v = defaultView(CHART);
  assert.equal(v.connectAcross, false, 'must default off');
  assert.equal((renderChart(CHART, { ...v, connectAcross: true }).match(/<polyline/g) || []).length, 2);
});

test('an ABAB reversal draws all three boundaries with no extra plumbing', () => {
  // Phases are derived as runs of the point sequence, so a withdrawal design needs no
  // special casing and phase A's second run re-uses its colour.
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
  assert.equal(boundaryXs(svg).length, 3);
  assert.equal((svg.match(/<polyline/g) || []).length, 4, 'one segment per run');
});

test('the chart grows a panel per case rather than squeezing a fixed frame', () => {
  const h = (n) => {
    const m = { ...CHART, panels: CHART.panels.slice(0, 1) };
    m.panels = Array.from({ length: n }, (_, i) => ({ ...CHART.panels[0], key: `c${i}`, label: `Case ${i}` }));
    return Number(renderChart(m, defaultView(m)).match(/viewBox="0 0 720 ([\d.]+)"/)[1]);
  };
  assert.ok(h(4) > h(1), 'four cases must be taller than one');
  assert.ok(h(4) > 3 * h(1) - 400, 'and grow roughly per panel, not by a fixed pad');
});

test('the host offers the SCED-specific controls, not just the shared ones', () => {
  const ids = chartUiSpec(CHART).controls.map((c) => c.id);
  for (const id of ['mark', 'connectAcross', 'phaseLines', 'phaseLabels', 'sharedY', 'panelHeight']) {
    assert.ok(ids.includes(id), `missing host-mediated control: ${id}`);
  }
  assert.deepEqual(chartUiSpec(CHART).colorItems.map((i) => i.key), ['A', 'B'], 'colour is per phase');
});

test('an empty chart reports rather than throwing', () => {
  const empty = { ...CHART, panels: [] };
  assert.match(renderChart(empty, defaultView(empty)), /no cases/i);
});
