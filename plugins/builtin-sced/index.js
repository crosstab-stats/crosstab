/**
 * @file plugins/builtin-sced/index.js
 * Built-in plugin: **Single-case experimental design (SCED)** — the multiple-baseline
 * graph plus the non-overlap indices (NAP, PND, Tau-U, IRD) that What Works
 * Clearinghouse-style reporting expects.
 *
 * ## Why this is hand-rolled, and why that is safe
 *
 * The canonical package is `scan`, and it **cannot run in WebR** — not because any one
 * of its dependencies is broken, but because its dependency tree needs more
 * concurrently-loaded shared objects than the WASM build allows. At the point of
 * failure `getLoadedDLLs()` sits at ~20 and the error lands on whichever `.so` happened
 * to be next; the R library filesystem is read-only, so trimming its Imports is not
 * available either. (Diagnosed 2026-08-05 — see the TODO entry, which also records the
 * two wrong readings that came before it.)
 *
 * That would normally be a reason to leave a gap. Here it isn't: NAP, PND, Tau-U and
 * IRD are **non-overlap counts** — pairwise comparisons and rank arithmetic, no
 * compiled code, no optimiser. So this plugin computes them in plain JavaScript, which
 * as a side effect makes it the rare analysis that needs no R at all: it runs instantly,
 * offline, with no package download.
 *
 * Hand-rolled statistics are held to [[validate-handrolled-vs-official]]: every number
 * below is checked against `scan` on desktop R by `test/sced.test.mjs`, whose expected
 * values come from `scripts/validation/sced-reference.R`. The port is deliberately
 * line-by-line from scan's own sources (`nap`, `pnd`, `ird`, `pand`, `tau_u`,
 * `kendall_tau`) rather than from the papers, because the papers leave several choices
 * open and a researcher checking our output against scan needs the SAME choice, not a
 * defensible one. Two places where that matters:
 *
 *  - **Tau-U's `VAR_S` column does not match its own `Z`.** scan reports `SD_S` from a
 *    closed-form expression but computes `Z` from `kendall_tau`'s tie-corrected `varS`,
 *    which differs whenever there are ties. Reproduced as-is; see {@link tauUTable}.
 *  - **NAP's p-value** is a Wilcoxon rank-sum **normal approximation with continuity
 *    correction** (`exact = FALSE`), not the exact test — so it stays reproducible on
 *    small n where R would otherwise switch methods.
 *
 * ## The graph
 *
 * Emitted as a chart MODEL (`kind: 'sced'`, see core/chart-renderer.js) rather than a
 * baked SVG, so the user gets live host-mediated controls — panel height, condition
 * labels, points/lines, palette — and the chart stays re-editable after save/reload.
 * The two SCED drawing conventions (staggered phase lines; no line drawn across a phase
 * change) are the renderer's defaults, not styling the caller has to remember.
 *
 * No workspace, so no `verbs`: this is an ordinary analysis plugin, and its runs land on
 * the one true log through the normal menu-action path with no state of its own.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-sced',
  name: 'Single-Case Design',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Single-Case Design',
  keywords: ['sced', 'single case', 'multiple baseline', 'tau-u', 'nap', 'pnd', 'ird',
    'aba', 'abab', 'applied behaviour analysis', 'special education', 'n-of-1', 'overlap'],
  howto:
    'GUI: Single-Case Design ▸ Non-overlap indices — pick the Outcome, the Phase variable (e.g. baseline/intervention), '
    + 'and optionally a Case variable (one panel per case) and a Session variable. Produces the multiple-baseline chart '
    + 'plus NAP, PND, Tau-U and IRD. Single-Case Design ▸ Multiple-baseline graph draws the chart alone.\n'
    + 'The FIRST phase to appear in session order is treated as the baseline (A); the output states which is which so you can check it.\n'
    + 'Syntax: run builtin-sced.run {"y": "disruptions", "phase": "condition", "caseVar": "child", "session": "session", "direction": "decrease"}\n'
    + 'Syntax: run builtin-sced.graph {"y": "disruptions", "phase": "condition", "caseVar": "child", "session": "session"}\n'
    + 'Several measures in one panel (e.g. “Saying thank you” + “Eye contact” scored in the same sessions): use '
    + 'Single-Case Design ▸ Multiple-baseline graph, several measures. It needs LONG format — one row per measure per '
    + 'session, with a Measure column — which is what lets each panel carry its own measures with nothing to configure. '
    + 'Each measure gets its own marker (filled circle, open circle, filled triangle, …) so the figure stays readable in print.\n'
    + 'Syntax: run builtin-sced.graphSeries {"y": "value", "measure": "measure", "phase": "condition", "caseVar": "behaviour", "session": "session"}\n'
    + '  • direction — "increase" (default; improvement means higher scores) | "decrease".\n'
    + '  • Needs no R: the indices are computed in JavaScript and match the R package `scan` (validated in test/sced.test.mjs).',
  menu: [
    {
      label: 'Non-overlap indices (NAP, PND, Tau-U, IRD)…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The behaviour being measured each session.', multiple: false, types: ['numeric'], unique: true },
        { name: 'phase', kind: 'variables', label: 'Phase', hint: 'Baseline vs intervention. The first value to appear in session order is treated as the baseline.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'caseVar', kind: 'variables', label: 'Case (optional)', hint: 'Participant or behaviour — one graph panel and one row of statistics per case.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
        { name: 'session', kind: 'variables', label: 'Session (optional)', hint: 'Measurement occasion. Omit to use the order of the rows within each case.', multiple: false, types: ['numeric'], optional: true, unique: true },
        {
          name: 'direction',
          kind: 'choice',
          label: 'Improvement means',
          hint: 'Whether a successful intervention pushes the outcome up (e.g. words read) or down (e.g. outbursts).',
          default: 'increase',
          options: [
            { value: 'increase', label: 'Higher scores (increase)' },
            { value: 'decrease', label: 'Lower scores (decrease)' },
          ],
        },
      ],
    },
    {
      label: 'Multiple-baseline graph…',
      run: 'graph',
      order: 20,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The behaviour being measured each session.', multiple: false, types: ['numeric'], unique: true },
        { name: 'phase', kind: 'variables', label: 'Phase', hint: 'Baseline vs intervention (and any further conditions — an ABAB reversal draws all its phase lines).', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'caseVar', kind: 'variables', label: 'Case (optional)', hint: 'Participant or behaviour — one stacked panel per case, sharing the session axis.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
        { name: 'session', kind: 'variables', label: 'Session (optional)', hint: 'Measurement occasion. Omit to use the order of the rows within each case.', multiple: false, types: ['numeric'], optional: true, unique: true },
        { name: 'context', kind: 'variables', label: 'Context (optional)', hint: 'The antecedent each behaviour is scored against (e.g. “Newcomer’s arrival”). Printed down the left edge of its panel.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
      ],
    },
    {
      // A SEPARATE menu item rather than one more optional input on the graph above.
      // The two forms want different DATA, not just different options: this one needs
      // long format (one row per measure per session), and asking for a Measure column
      // is the whole difference. Both drive the same engine — `graphSeries` is `graph`
      // with one extra input — so the split costs a manifest entry, not a code path.
      label: 'Multiple-baseline graph, several measures…',
      run: 'graphSeries',
      order: 30,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Value', hint: 'The score column. In long format every measure shares one value column.', multiple: false, types: ['numeric'], unique: true },
        { name: 'measure', kind: 'variables', label: 'Measure', hint: 'Which dependent variable each row records (e.g. “Eye contact”). Each becomes its own marker within the panel.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'phase', kind: 'variables', label: 'Phase', hint: 'Baseline vs intervention. The first value to appear in session order is treated as the baseline.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'caseVar', kind: 'variables', label: 'Case (optional)', hint: 'Participant or behaviour — one stacked panel per case, sharing the session axis.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
        { name: 'session', kind: 'variables', label: 'Session (optional)', hint: 'Measurement occasion. Omit to use the order of the rows within each case.', multiple: false, types: ['numeric'], optional: true, unique: true },
        { name: 'context', kind: 'variables', label: 'Context (optional)', hint: 'The antecedent each behaviour is scored against. Printed down the left edge of its panel.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
      ],
    },
  ],
};

// =============================================================================
// Distributions
// =============================================================================

/**
 * Standard normal CDF — Hart's algorithm, accurate to ~1e-15 across the range.
 *
 * Worth the extra lines over the Numerical Recipes `erfc` used elsewhere in the
 * codebase (~1e-7): these p-values are compared against R's to 1e-12 in the test, and a
 * 1e-7 approximation would make a real regression indistinguishable from method noise.
 */
export function normalCdf(x) {
  const a = Math.abs(x);
  let upper; // P(Z > |x|)
  if (a > 37) {
    upper = 0;
  } else {
    const e = Math.exp(-(a * a) / 2);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      upper = (e * n) / d;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      upper = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - upper : upper;
}

/** Upper-tail standard normal quantile: the z with P(Z > p) = p. */
export function normalQuantileUpper(p) {
  return -normalQuantile(p);
}

/** Standard normal quantile (Acklam's rational approximation + one Halley step). */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const rr = q * q;
    x = (((((a[0] * rr + a[1]) * rr + a[2]) * rr + a[3]) * rr + a[4]) * rr + a[5]) * q
      / (((((b[0] * rr + b[1]) * rr + b[2]) * rr + b[3]) * rr + b[4]) * rr + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley refinement — takes the ~1e-9 approximation to full double precision.
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// =============================================================================
// Kendall's tau — the engine under Tau-U
// =============================================================================

/**
 * Port of scan's `kendall_tau`. Returns the pieces Tau-U needs (S, the denominator,
 * the tie-corrected variance, z and p), not just the coefficient.
 *
 * Note the concordance loop only counts pairs where **x strictly increases**, so pairs
 * tied on x contribute to neither C nor D — that is what makes the tie corrections
 * below the whole story rather than a partial one.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @param {{tauMethod?: 'a'|'b', continuityCorrection?: boolean}} [opts]
 */
export function kendallTau(x, y, { tauMethod = 'b', continuityCorrection = false } = {}) {
  const N = x.length;
  const idx = x.map((_, i) => i).sort((i, j) => (x[i] - x[j]) || (i - j)); // stable, ascending x
  const xs = idx.map((i) => x[i]);
  const ys = idx.map((i) => y[i]);

  let C = 0;
  let D = 0;
  for (let i = 0; i < N - 1; i++) {
    for (let j = i + 1; j < N; j++) {
      if (xs[j] > xs[i]) {
        if (ys[j] > ys[i]) C++;
        else if (ys[j] < ys[i]) D++;
      }
    }
  }

  const runLengths = (sorted) => {
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] === sorted[i - 1]) out[out.length - 1]++;
      else out.push(1);
    }
    return out;
  };
  const tieX = runLengths(xs);
  const tieY = runLengths([...ys].sort((p, q) => p - q));
  const ti = tieX.reduce((s, t) => s + (t * (t - 1)) / 2, 0);
  const ui = tieY.reduce((s, t) => s + (t * (t - 1)) / 2, 0);

  const S = C - D;
  const n0 = (N * (N - 1)) / 2;
  let Den;
  let varS;
  let sdS;
  let se;
  let z;

  if (tauMethod === 'a') {
    Den = n0;
    se = Math.sqrt((2 * N + 5) / Den) / 3;
    sdS = Math.sqrt((N * (N - 1) * (2 * N + 5)) / 2) / 3;
    varS = sdS * sdS;
    const denom = Math.sqrt((N * (N - 1) * (2 * N + 5)) / 2);
    z = continuityCorrection
      ? (3 * (Math.sign(S) * (Math.abs(S) - 1))) / denom
      : (3 * S) / denom;
  } else {
    Den = Math.sqrt((n0 - ti) * (n0 - ui));
    const v0 = N * (N - 1) * (2 * N + 5);
    const vt = tieX.reduce((s, t) => s + t * (t - 1) * (2 * t + 5), 0);
    const vu = tieY.reduce((s, t) => s + t * (t - 1) * (2 * t + 5), 0);
    const v1 = tieX.reduce((s, t) => s + t * (t - 1), 0) * tieY.reduce((s, t) => s + t * (t - 1), 0);
    const v2 = tieX.reduce((s, t) => s + t * (t - 1) * (t - 2), 0)
      * tieY.reduce((s, t) => s + t * (t - 1) * (t - 2), 0);
    varS = (v0 - vt - vu) / 18
      + v1 / (2 * N * (N - 1))
      + (N > 2 ? v2 / (9 * N * (N - 1) * (N - 2)) : 0);
    sdS = Math.sqrt(varS);
    se = sdS / Den;
    z = continuityCorrection ? (Math.sign(S) * (Math.abs(S) - 1)) / sdS : S / sdS;
  }

  const p = Number.isFinite(z) ? (1 - normalCdf(Math.abs(z))) * 2 : NaN;
  return { N, n0, ti, ui, nC: C, nD: D, S, D: Den, tau: Number.isFinite(z) ? S / Den : NaN, varS, sdS, se, z, p };
}

// =============================================================================
// Non-overlap indices
// =============================================================================

/** Rank a vector with ties averaged (R's `rank(..., ties.method = "average")`). */
function averageRanks(v) {
  const idx = v.map((_, i) => i).sort((i, j) => (v[i] - v[j]) || (i - j));
  const out = new Array(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++;
    const mean = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) out[idx[k]] = mean;
    i = j + 1;
  }
  return out;
}

/**
 * p-value from R's `wilcox.test(x, y, alternative, exact = FALSE)` — the normal
 * approximation with continuity and tie corrections. This is the test scan's `nap`
 * calls, so NAP's p matches even on the small samples where R's exact path would
 * otherwise take over — `exact = FALSE` pins the method regardless of n.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @param {'less'|'greater'|'two.sided'} alternative
 */
export function wilcoxonP(x, y, alternative) {
  const nx = x.length;
  const ny = y.length;
  if (!nx || !ny) return NaN;
  const all = [...x, ...y];
  const ranks = averageRanks(all);
  const statistic = ranks.slice(0, nx).reduce((s, v) => s + v, 0) - (nx * (nx + 1)) / 2;

  const counts = new Map();
  for (const v of all) counts.set(v, (counts.get(v) || 0) + 1);
  let tieSum = 0;
  for (const t of counts.values()) tieSum += t * t * t - t;

  const n = nx + ny;
  const sigma = Math.sqrt(((nx * ny) / 12) * ((n + 1) - tieSum / (n * (n - 1))));
  let z = statistic - (nx * ny) / 2;
  const correction = alternative === 'less' ? -0.5 : alternative === 'greater' ? 0.5 : Math.sign(z) * 0.5;
  z = (z - correction) / sigma;
  if (alternative === 'less') return normalCdf(z);
  if (alternative === 'greater') return 1 - normalCdf(z);
  return 2 * Math.min(normalCdf(z), 1 - normalCdf(z));
}

/**
 * Nonoverlap of All Pairs — every baseline point against every intervention point.
 * Port of scan's `nap`.
 */
export function napFor(A, B, { decreasing = false } = {}) {
  const pairs = A.length * B.length;
  let pos = 0;
  let ties = 0;
  for (const a of A) {
    for (const b of B) {
      if (b === a) ties++;
      else if (decreasing ? b < a : b > a) pos++;
    }
  }
  const nonOverlaps = pos + 0.5 * ties;
  const nap = pairs ? nonOverlaps / pairs : NaN;
  const p = wilcoxonP(A, B, decreasing ? 'greater' : 'less');
  const d = 3.464 * (1 - Math.sqrt((1 - nap) / 0.5));
  const rr = d / Math.sqrt(d * d + 4);
  return { nap: nap * 100, rescaled: 2 * (nap * 100) - 100, pairs, nonOverlaps, pos, ties, p, d, r2: rr * rr };
}

/** Percentage of Non-overlapping Data: B points beyond the most extreme A point. */
export function pndFor(A, B, { decreasing = false } = {}) {
  if (!B.length) return NaN;
  const bound = decreasing ? Math.min(...A) : Math.max(...A);
  const beaten = B.filter((b) => (decreasing ? b < bound : b > bound)).length;
  return (beaten / B.length) * 100;
}

/**
 * The largest set of points that can be kept while leaving the two phases completely
 * non-overlapping (Pustejovsky's formulation of PAND, scan's `method = "minimum"`).
 * Keep the `i` lowest A values and the top `nB - j` B values, subject to the largest
 * kept A falling below the smallest kept B.
 */
export function pandMinimum(A, B, { decreasing = false } = {}) {
  const a = (decreasing ? A.map((v) => -v) : A).slice().sort((p, q) => p - q);
  const b = (decreasing ? B.map((v) => -v) : B).slice().sort((p, q) => p - q);
  const nA = a.length;
  const nB = b.length;
  const x = [-Infinity, ...a];
  const y = [...b, Infinity];
  let best = 0;
  for (let i = 0; i <= nA; i++) {
    for (let j = 0; j <= nB; j++) {
      if (x[i] < y[j]) best = Math.max(best, i + nB - j);
    }
  }
  return { nonoverlaps: best, nA, nB };
}

/**
 * Improvement Rate Difference, computed across ALL cases at once as scan does — it is a
 * single study-level figure, not one per case.
 *
 * @param {Array<{A: number[], B: number[]}>} cases
 */
export function irdFor(cases, { decreasing = false } = {}) {
  let nonoverlaps = 0;
  let nA = 0;
  let nB = 0;
  for (const c of cases) {
    const pa = pandMinimum(c.A, c.B, { decreasing });
    nonoverlaps += pa.nonoverlaps;
    nA += pa.nA;
    nB += pa.nB;
  }
  const n = nA + nB;
  if (!nA || !nB) return { ird: NaN, pand: NaN, n, nA, nB, nonoverlaps };
  const pand = (nonoverlaps / n) * 100;
  const ird = 1 - ((n * n) / (2 * nA * nB)) * (1 - pand / 100);
  return { ird, pand, n, nA, nB, nonoverlaps };
}

/** Fisher z transform and its inverse, for Tau-U's confidence interval. */
const tauZ = (t) => Math.atanh(t);
const invTauZ = (z) => Math.tanh(z);

/**
 * The six-row Tau-U table for one case, matching scan's `tau_u(method = "complete")`.
 *
 * Each row is Kendall's tau over the phase values paired with a different **index
 * vector**, which is how Tau-U folds baseline trend in or out: pairing A against a
 * DESCENDING index (`nA…1`) makes a rising baseline count against the effect, which is
 * the "− Trend A" correction.
 *
 * Reproduces one inconsistency in scan on purpose: `SD_S`/`VAR_S` come from a
 * closed-form expression while `Z` comes from `kendall_tau`'s tie-corrected variance, so
 * `S / SD_S` does not equal `Z` when there are ties. Matching scan matters more than
 * internal tidiness here — a researcher will diff these tables cell by cell.
 */
export function tauUTable(A, B, { ci = 0.95 } = {}) {
  const nA = A.length;
  const nB = B.length;
  const nAB = nA + nB;
  const AB = [...A, ...B];
  const seq = (from, to) => {
    const out = [];
    if (from <= to) for (let i = from; i <= to; i++) out.push(i);
    else for (let i = from; i >= to; i--) out.push(i);
    return out;
  };

  const pairCount = (v) => kendallTau(AB, v);
  const taus = {
    AvB: pairCount([...new Array(nA).fill(0), ...new Array(nB).fill(1)]),
    AvA: kendallTau(A, seq(1, nA)),
    BvB: kendallTau(B, seq(1, nB)),
    AvB_A: pairCount([...seq(nA, 1), ...new Array(nB).fill(nA + 1)]),
    AvB_B: pairCount([...new Array(nA).fill(0), ...seq(nA + 1, nAB)]),
    AvB_B_A: pairCount([...seq(nA, 1), ...seq(nA + 1, nAB)]),
  };

  // Directional counts, accumulated the same way scan does (it reports these
  // separately from the tau computation above).
  let AvApos = 0; let AvAneg = 0; let AvAtie = 0;
  for (let i = 0; i < nA - 1; i++) {
    for (let j = i + 1; j < nA; j++) {
      if (A[i] < A[j]) AvApos++; else if (A[i] > A[j]) AvAneg++; else AvAtie++;
    }
  }
  let BvBpos = 0; let BvBneg = 0; let BvBtie = 0;
  for (let i = 0; i < nB - 1; i++) {
    for (let j = i + 1; j < nB; j++) {
      if (B[i] < B[j]) BvBpos++; else if (B[i] > B[j]) BvBneg++; else BvBtie++;
    }
  }
  let AvBpos = 0; let AvBneg = 0; let AvBtie = 0;
  for (const a of A) {
    for (const b of B) {
      if (a < b) AvBpos++; else if (a > b) AvBneg++; else AvBtie++;
    }
  }

  const AvB_pair = nA * nB;
  const AvA_pair = (nA * (nA - 1)) / 2;
  const BvB_pair = (nB * (nB - 1)) / 2;

  const rows = [
    { name: 'A vs. B', t: taus.AvB, pairs: AvB_pair, pos: AvBpos, neg: AvBneg, ties: AvBtie },
    { name: 'Trend A', t: taus.AvA, pairs: AvA_pair, pos: AvApos, neg: AvAneg, ties: AvAtie },
    { name: 'Trend B', t: taus.BvB, pairs: BvB_pair, pos: BvBpos, neg: BvBneg, ties: BvBtie },
    { name: 'A vs. B - Trend A', t: taus.AvB_A, pairs: AvB_pair + AvA_pair, pos: AvBpos + AvAneg, neg: AvBneg + AvApos, ties: AvBtie + AvAtie },
    { name: 'A vs. B + Trend B', t: taus.AvB_B, pairs: AvB_pair + BvB_pair, pos: AvBpos + BvBpos, neg: AvBneg + BvBneg, ties: AvBtie + BvBtie },
    { name: 'A vs. B + Trend B - Trend A', t: taus.AvB_B_A, pairs: AvB_pair + AvA_pair + BvB_pair, pos: AvBpos + BvBpos + AvAneg, neg: AvBneg + BvBneg + AvApos, ties: AvBtie + BvBtie + AvAtie },
  ];

  // SD_S: closed form for A-vs-B and the two pure trends, kendall_tau's for the combos.
  const sdRef = [
    Math.sqrt((nA * nB * (nA + nB + 1)) / 12) * 2,
    kendallTau(seq(1, nA), seq(1, nA)).sdS,
    kendallTau(seq(1, nB), seq(1, nB)).sdS,
    taus.AvB_A.sdS,
    taus.AvB_B.sdS,
    taus.AvB_B_A.sdS,
  ];

  const zCrit = normalQuantileUpper((1 - ci) / 2);
  return rows.map((row, i) => {
    // Only A vs. B overrides the denominator; the rest keep kendall_tau's tau-b D.
    const D = i === 0 ? row.pairs - row.ties / 2 : row.t.D;
    const tau = row.t.S / D;
    const sdS = sdRef[i];
    const seZ = 1 / Math.sqrt(row.t.N - 3);
    const z = tauZ(tau);
    return {
      comparison: row.name,
      pairs: row.pairs,
      pos: row.pos,
      neg: row.neg,
      ties: row.ties,
      S: row.t.S,
      D,
      tau,
      ciLower: invTauZ(z - zCrit * seZ),
      ciUpper: invTauZ(z + zCrit * seZ),
      sdS,
      varS: sdS * sdS,
      // scan derives SE from the reported Tau and Z rather than from either variance.
      seTau: tau / row.t.z,
      Z: row.t.z,
      p: row.t.p,
      n: row.t.N,
    };
  });
}

// =============================================================================
// Plugin entry points
// =============================================================================

/** Non-overlap indices + the multiple-baseline chart. */
export async function run(app, inputs) {
  const parsed = await gather(app, inputs);
  if (!parsed) return;
  const { cases, phaseKeys, phaseLabelOf, yLabel, xLabel, decreasing } = parsed;

  const twoPhase = cases.filter((c) => c.runs.length >= 2);
  if (!twoPhase.length) {
    await app.results.appendError(
      'Single-case design: no case has two phases. Each case needs baseline observations followed by intervention observations.');
    return;
  }

  await app.results.appendChart(chartModel(parsed));

  const aName = phaseLabelOf(twoPhase[0].runs[0].phase);
  const bName = phaseLabelOf(twoPhase[0].runs[1].phase);
  const extra = twoPhase.some((c) => c.runs.length > 2);
  await app.results.appendText(
    `**Single-case design — non-overlap indices**\n\n`
    + `Baseline (A) = **${aName}**, intervention (B) = **${bName}** — taken from the order the phases appear in each case. `
    + `Improvement is a **${decreasing ? 'decrease' : 'increase'}** in ${yLabel}.`
    + (extra ? ' Cases with more than two phases contribute only their first two to the statistics; the graph shows every phase.' : ''));

  // --- NAP ---
  const napRows = twoPhase.map((c) => {
    const r = napFor(c.A, c.B, { decreasing });
    return [c.label, fmt(r.nap, 1), r.pairs, fmt(r.nonOverlaps, 1), r.pos, r.ties, fmtP(r.p), fmt(r.r2, 3)];
  });
  await app.results.appendTable({
    caption: 'Nonoverlap of All Pairs (NAP)',
    columns: ['Case', 'NAP', 'Pairs', 'Non-overlaps', 'Positives', 'Ties', 'p', 'R²'],
    rows: napRows,
  });

  // --- PND ---
  await app.results.appendTable({
    caption: 'Percentage of Non-overlapping Data (PND)',
    columns: ['Case', 'PND', 'Intervention points'],
    rows: twoPhase.map((c) => [c.label, fmt(pndFor(c.A, c.B, { decreasing }), 1), c.B.length]),
  });

  // --- Tau-U, one table per case (six comparisons each) ---
  for (const c of twoPhase) {
    const table = tauUTable(c.A, c.B);
    await app.results.appendTable({
      caption: `Tau-U — ${c.label}`,
      columns: ['Comparison', 'Pairs', 'Pos', 'Neg', 'Ties', 'S', 'D', 'Tau', '95% CI', 'SE Tau', 'Z', 'p'],
      rows: table.map((t) => [
        t.comparison, t.pairs, t.pos, t.neg, t.ties, fmt(t.S, 0), fmt(t.D, 2), fmt(t.tau, 3),
        `${fmt(t.ciLower, 2)} to ${fmt(t.ciUpper, 2)}`, fmt(t.seTau, 3), fmt(t.Z, 3), fmtP(t.p),
      ]),
      rowHeaders: true,
    });
  }

  // --- IRD (study-level) ---
  const ird = irdFor(twoPhase.map((c) => ({ A: c.A, B: c.B })), { decreasing });
  await app.results.appendTable({
    caption: 'Improvement Rate Difference (IRD)',
    columns: ['IRD', 'PAND', 'Non-overlapping points', 'Total points'],
    rows: [[fmt(ird.ird, 3), `${fmt(ird.pand, 1)}%`, ird.nonoverlaps, ird.n]],
  });
  await app.results.appendText(
    '_NAP and PND are per case; IRD is a single study-level figure across all cases (as in the R package `scan`). '
    + 'Tau-U’s “A vs. B − Trend A” row is the one usually reported: it discounts an effect that a rising baseline '
    + 'would have produced anyway._');
}

/** The multiple-baseline chart on its own. */
export async function graph(app, inputs) {
  const parsed = await gather(app, inputs);
  if (!parsed) return;
  await app.results.appendChart(chartModel(parsed));
}

/**
 * The same chart with several measures per panel (long format).
 *
 * Identical to {@link graph} apart from the `measure` input, which is what removes the
 * "which measures go in which panel?" question entirely: a panel simply gets whatever
 * measures appear in its own rows. That is why the long shape is required rather than
 * one column per measure — a real figure has some behaviours scored on two measures and
 * some on one, and wide format would need an assignment step to express it.
 */
export async function graphSeries(app, inputs) {
  if (!inputs.measure) {
    await app.results.appendError('Single-case design: pick the Measure column — the variable saying which dependent variable each row records.');
    return;
  }
  const parsed = await gather(app, inputs);
  if (!parsed) return;
  await app.results.appendChart(chartModel(parsed));
}

// --- shared plumbing ---------------------------------------------------------

/**
 * Read the variables, drop missing observations, and split into cases and phase runs.
 * Returns null (after reporting) when there is nothing to analyse.
 */
async function gather(app, { y, phase, caseVar, session, context, measure, direction }) {
  if (!y || !phase) return null;
  const decreasing = direction === 'decrease';
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const wanted = [y, phase, caseVar, session, context, measure].filter(Boolean);
  const cols = await app.data.getColumns({ variables: wanted });

  const yCol = cols[y] || [];
  const pCol = cols[phase] || [];
  const cCol = caseVar ? cols[caseVar] || [] : null;
  const sCol = session ? cols[session] || [] : null;
  const ctxCol = context ? cols[context] || [] : null;
  const ctxName = context ? labelMapper(meta, context) : null;
  const mCol = measure ? cols[measure] || [] : null;
  const mName = measure ? labelMapper(meta, measure) : null;

  const missY = missingSet(meta, y);
  const missP = missingSet(meta, phase);
  const phaseName = labelMapper(meta, phase);
  const caseName = caseVar ? labelMapper(meta, caseVar) : null;

  /** @type {Map<string, {key: string, label: string, rows: Array<{x: number, yv: number, phase: string}>}>} */
  const byCase = new Map();
  for (let i = 0; i < yCol.length; i++) {
    const yv = Number(yCol[i]);
    if (!Number.isFinite(yv) || missY.has(String(yCol[i]))) continue;
    const praw = pCol[i];
    if (isBlank(praw) || missP.has(String(praw))) continue;
    const ckey = cCol ? String(cCol[i] ?? '') : '__all__';
    if (!byCase.has(ckey)) {
      byCase.set(ckey, {
        key: ckey,
        label: cCol ? caseName(ckey) : 'All observations',
        // A case's context is a property of the case, so the first row carries it.
        context: ctxCol && !isBlank(ctxCol[i]) ? ctxName(String(ctxCol[i])) : '',
        rows: [],
      });
    }
    const entry = byCase.get(ckey);
    const sv = sCol ? Number(sCol[i]) : NaN;
    entry.rows.push({
      x: Number.isFinite(sv) ? sv : entry.rows.length + 1,
      yv,
      phase: String(praw ?? ''),
      measure: mCol ? String(mCol[i] ?? '') : null,
    });
  }

  const cases = [];
  for (const c of byCase.values()) {
    // Session order decides everything downstream: the run split, which phase is
    // baseline, and where the chart draws the boundary.
    const rows = [...c.rows].sort((a, b) => a.x - b.x);
    const runs = [];
    for (const row of rows) {
      const last = runs[runs.length - 1];
      if (last && last.phase === row.phase) last.values.push(row.yv);
      else runs.push({ phase: row.phase, values: [row.yv] });
    }
    cases.push({
      key: c.key,
      label: c.label,
      context: c.context,
      rows,
      runs,
      A: runs[0] ? runs[0].values : [],
      B: runs[1] ? runs[1].values : [],
    });
  }

  if (!cases.length) {
    await app.results.appendError('Single-case design: no complete observations after removing missing values.');
    return null;
  }

  // Phase keys in order of first appearance, so colours and the legend agree with the
  // design's own ordering rather than alphabetical accident (Baseline before
  // Intervention, not Baseline before … well, alphabetically it works; "Treatment"
  // before "Baseline" would not).
  const phaseKeys = [];
  for (const c of cases) for (const rn of c.runs) if (!phaseKeys.includes(rn.phase)) phaseKeys.push(rn.phase);

  return {
    cases,
    phaseKeys,
    phaseLabelOf: phaseName,
    measureLabelOf: mName || ((k) => String(k)),
    yLabel: meta.get(y)?.label || y,
    xLabel: session ? (meta.get(session)?.label || session) : 'Session',
    decreasing,
  };
}

/** Build the `sced` chart model from a parsed dataset. */
function chartModel({ cases, phaseKeys, phaseLabelOf, measureLabelOf, yLabel, xLabel }) {
  return {
    kind: 'sced',
    title: cases.length > 1 ? `Multiple baseline — ${yLabel}` : `${yLabel} by session`,
    phases: phaseKeys.map((k) => ({ key: k, label: phaseLabelOf(k) })),
    axes: { x: { title: xLabel }, y: { title: yLabel } },
    panels: cases.map((c) => {
      const pt = (row) => ({ x: row.x, y: row.yv, phase: row.phase });
      if (!c.rows.some((row) => row.measure)) {
        return { key: c.key, label: c.label, context: c.context || undefined, points: c.rows.map(pt) };
      }
      // Long format: one series per measure PRESENT IN THIS PANEL. Panels legitimately
      // differ — some behaviours are scored on two measures and some on one — and
      // deriving the set per panel is what makes that need no configuring.
      const byMeasure = new Map();
      for (const row of c.rows) {
        const k = row.measure || '';
        if (!byMeasure.has(k)) byMeasure.set(k, []);
        byMeasure.get(k).push(pt(row));
      }
      return {
        key: c.key,
        label: c.label,
        context: c.context || undefined,
        series: [...byMeasure].map(([k, points]) => ({ key: k, label: measureLabelOf(k), points })),
      };
    }),
  };
}

/** Designated user-missing codes for a variable. */
function missingSet(meta, name) {
  return new Set((meta.get(name)?.missingValues ?? []).map(String));
}

/** A null / NaN / empty cell from getColumns. */
function isBlank(v) {
  return v == null || (typeof v === 'number' && Number.isNaN(v)) || v === '';
}

/** Map a category code to its value label, identity if none. */
function labelMapper(meta, name) {
  const vl = name ? meta.get(name)?.valueLabels : null;
  if (!vl || !Object.keys(vl).length) return (k) => String(k);
  return (k) => (vl[k] ?? vl[String(k)] ?? String(k));
}

function fmt(v, dp) {
  return Number.isFinite(v) ? v.toFixed(dp) : '—';
}

/** p-values: three decimals, with the usual floor rather than a misleading 0.000. */
function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '<.001' : p.toFixed(3);
}
