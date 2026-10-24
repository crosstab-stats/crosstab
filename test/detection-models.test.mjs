/**
 * @file detection-models.test.mjs
 * #142 — the detection-corrected abundance estimators, checked against the authority.
 *
 * The project rule for a WRAPPER is exact equality against the real package on local R,
 * with the generated R extracted at run time rather than retyped — a test that retypes
 * the R proves the retyped copy works. So the plugin is invoked with a fake `app` that
 * captures the code it sends to WebR, that exact string is written to a file with the
 * bindings the host would inject, and local R 4.6.0 runs it.
 *
 * Each R case runs TWO scripts on the same local R — the plugin's generated code, and a
 * canonical hand-written call — and asserts they agree. That equality is the claim worth
 * making about a wrapper. Published constants are kept as anchors so a silently wrong
 * reference cannot make both sides agree on nonsense.
 *
 * Ground truth, `mrds` 3.0.1 / `unmarked` on R 4.6.0, fixed synthetic data (no RNG). Note
 * the width: the plugin's default truncation is the LARGEST OBSERVED distance (5.4 here),
 * not a round number, and the first draft of this file asserted figures from a `width = 6`
 * run — six failures, the plugin correct in all of them.
 *
 *   W = 5.4 (the default)      W = 6 (truncation given)
 *   hn   AIC 65.8286346364       66.7766166930
 *        p   0.644779037111       0.552772732607
 *        ESW 3.481806800398       3.316636395641
 *   hr   AIC 67.3034663038       68.6035558183
 *   u+c  AIC 65.3765716945       66.8492827504
 *   pt   AIC 70.0419463633       70.3300415224   p 0.222842714280 / 0.175799764022
 *   L=50 dens 0.057441441029      0.060302057911
 *
 *   occupancy  psi 0.8000000  p 0.5000000  AIC 43.46003  naive 0.7
 *   N-mixture  lambda 2.760357  p 0.579635  AIC 91.07860
 *
 * The R run is skipped — not failed — when local R or the packages are absent, because
 * CI has neither and a test that cannot run is not a test that fails. What always runs is
 * everything that does not need R: the manifest contract, the guards, and the arithmetic
 * the plugin does itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, distance, occupancy, DSMODEL, MIN_DETECTIONS } from '../plugins/builtin-detection/index.js';

const RSCRIPT = 'C:/Program Files/R/R-4.6.0/bin/Rscript.exe';
const RLIB = 'C:/Users/Ryan/R/win-library/4.6';
const haveR = existsSync(RSCRIPT) && existsSync(join(RLIB, 'mrds'))
  && existsSync(join(RLIB, 'unmarked'));

/** The twenty distances the ground truth above was computed from. */
const D = [0.2, 0.4, 0.5, 0.7, 0.9, 1.0, 1.1, 1.3, 1.4, 1.6,
  1.8, 2.0, 2.2, 2.5, 2.8, 3.1, 3.5, 4.0, 4.6, 5.4];

/** 10 sites x 3 visits, detection/non-detection. Naive occupancy 0.7. */
const Y = [[1, 0, 1], [0, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 0],
  [1, 1, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0], [0, 1, 1]];

/** The same shape as counts, for the N-mixture model. */
const YC = [[2, 1, 3], [0, 0, 0], [4, 3, 2], [1, 2, 1], [0, 1, 0],
  [5, 4, 6], [1, 0, 2], [0, 0, 0], [3, 2, 1], [1, 1, 2]];

/**
 * A fake `app` that records what the plugin would do.
 *
 * `webr.run` captures the code and returns whatever the test supplies, in the flattened
 * shape `unpackR` produces — so the reporting half can be exercised without R at all.
 */
function fakeApp(rResult = null) {
  const log = { code: null, installed: [], tables: [], texts: [], errors: [], plots: [], charts: [] };
  return {
    log,
    webr: {
      installPackages: async (p) => { log.installed.push(...p); },
      run: async (code) => { log.code = code; return { result: rResult }; },
    },
    results: {
      appendTable: async (t, o) => { log.tables.push({ ...t, ...o }); },
      appendText: async (s) => { log.texts.push(s); },
      appendError: async (s) => { log.errors.push(s); },
      appendPlot: async (svg, o) => { log.plots.push({ svg, ...o }); },
      appendChart: async (model) => { log.charts.push(model); },
    },
  };
}

/** Values keyed as `unpackR` delivers them, so `num1`/`str1` read them back. */
function rList(obj) {
  return {
    names: Object.keys(obj),
    values: Object.values(obj).map((v) => ({ values: Array.isArray(v) ? v : [v] })),
  };
}

/** Run an arbitrary R script on local R and parse its `k=v` output. */
function runR(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-detect-'));
  const path = join(dir, 'run.R');
  writeFileSync(path, `.libPaths(c(${JSON.stringify(RLIB)}, .libPaths()))\n${script}`, 'utf8');
  const out = execFileSync(RSCRIPT, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const got = {};
  for (const line of out.trim().split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) got[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return got;
}

/** The bindings the host injects, as R declarations. */
function bindingsToR(bindings) {
  return Object.entries(bindings).map(([k, v]) => {
    if (Array.isArray(v) && Array.isArray(v[0])) {
      const flatv = v.flat();
      // A multi-column `variables` input arrives in R as a data.frame of columns.
      return `${k} <- as.data.frame(matrix(c(${flatv.join(',')}), nrow = ${v.length}, byrow = TRUE))`;
    }
    if (Array.isArray(v)) return `${k} <- c(${v.join(',')})`;
    return `${k} <- ${typeof v === 'string' ? JSON.stringify(v) : v}`;
  }).join('\n');
}

/** Run the plugin's OWN generated R, with the bindings the host injects. */
function runOnLocalR(code, bindings) {
  return runR(`${bindingsToR(bindings)}\nout <- local({\n${code}\n})\n`
    + 'cat(paste(names(out), sapply(out, function(v) '
    + 'if (is.character(v)) paste0("<", nchar(v)[1], " chars>") else format(v[1], digits = 12)), '
    + 'sep = "=", collapse = "\\n"), "\\n")\n');
}

/** The canonical `mrds` call, written by hand the way the documentation does. */
function referenceDistance({ width, dsmodel, point = false, effort = 0, area = 0 }) {
  return runR(`suppressMessages(library(mrds))
    d <- c(${D.join(',')}); W <- ${width}
    kept <- d[d <= W]
    df <- data.frame(object = seq_along(kept), distance = kept)
    meta <- list(width = W)${point ? '; meta$point <- TRUE' : ''}
    fit <- ddf(dsmodel = as.formula(${JSON.stringify(dsmodel)}), data = df, method = "ds", meta.data = meta)
    p <- as.numeric(fit$fitted[1])
    eff <- ${point ? 'sqrt(p) * W' : 'p * W'}
    n <- nrow(df)
    covered <- ${effort > 0 ? (point ? `${effort} * pi * eff^2` : `2 * ${effort} * eff`) : 'NA_real_'}
    dens <- if (is.na(covered)) NA_real_ else n / covered
    abund <- if (is.na(dens) || ${area} <= 0) NA_real_ else dens * ${area}
    cat("aic=", format(fit$criterion, digits = 12), "\\n", sep = "")
    cat("p=", format(p, digits = 12), "\\n", sep = "")
    cat("eff=", format(eff, digits = 12), "\\n", sep = "")
    cat("n=", n, "\\n", sep = "")
    cat("dens=", format(dens, digits = 12), "\\n", sep = "")
    cat("abund=", format(abund, digits = 12), "\\n", sep = "")
    cat("covered=", format(covered, digits = 12), "\\n", sep = "")`);
}

/** The canonical `unmarked` call, likewise. */
function referenceOccupancy(rows, { count = false, K = 0 } = {}) {
  const flatv = rows.flat().join(',');
  return runR(`suppressMessages(library(unmarked))
    Y <- matrix(c(${flatv}), nrow = ${rows.length}, byrow = TRUE)
    ${count
      ? `fit <- pcount(~1 ~1, unmarkedFramePCount(y = Y), K = ${K || 'max(Y) + 50'})`
      : 'fit <- occu(~1 ~1, unmarkedFrameOccu(y = (Y > 0) * 1L))'}
    b <- coef(fit)
    cat("stateEst=", format(${count ? 'exp' : 'plogis'}(b[[1]]), digits = 12), "\\n", sep = "")
    cat("detEst=", format(plogis(b[[2]]), digits = 12), "\\n", sep = "")
    cat("aic=", format(fit@AIC, digits = 12), "\\n", sep = "")
    cat("naive=", format(mean(apply(Y, 1, max) > 0), digits = 12), "\\n", sep = "")`);
}

/**
 * `got` (an R-printed string) equals `want` to `places` decimals.
 *
 * Exists because `toFixed` returns a STRING and `assert/strict` does not coerce, so
 * `assert.equal(Number(x).toFixed(6), 66.776617)` fails with
 * `'66.776617' !== 66.776617` — which reads as a real disagreement about the statistic.
 */
function near(got, want, places, label) {
  assert.equal(Number(got).toFixed(places), want.toFixed(places), label ?? `to ${places} dp`);
}

/** Agree to the precision R printed, field by field. */
function assertAgrees(got, ref, fields, label) {
  for (const k of fields) {
    assert.equal(
      Number(got[k]).toPrecision(10), Number(ref[k]).toPrecision(10),
      `${label}: ${k} — plugin ${got[k]} vs canonical ${ref[k]}`,
    );
  }
}

// =============================================================================
// The manifest contract — no R needed
// =============================================================================

test('the plugin declares both families and the packages they need', () => {
  assert.equal(manifest.id, 'builtin-detection');
  // Category is both the manager section and the top-level menu, and the host owns
  // placement — this is why these are not inside builtin-ecology, which is Multivariate.
  assert.equal(manifest.category, 'Ecology');
  assert.deepEqual(manifest.menu.map((m) => m.run), ['distance', 'occupancy']);
  assert.ok(manifest.rPackages.includes('mrds'), 'mrds');
  // NOT unmarked: it is in the WebR PACKAGES index at 1.5.2 and its wasm binary is a 403,
  // so the occupancy likelihoods are computed in base R instead. Declaring it would make
  // every run of either analysis wait on an install that silently achieves nothing.
  assert.ok(!manifest.rPackages.includes('unmarked'), 'unmarked has no wasm binary');
  // `Distance` costs 17 .so against mrds's 8, nine of them a tidyverse chain that
  // computes nothing here. It must not come back in by accident.
  assert.ok(!manifest.rPackages.includes('Distance'), 'the wrapper package is not used');
});

test('every howto topic is declared in the index and written in the sidecar', async () => {
  const { readFile } = await import('node:fs/promises');
  const md = await readFile(new URL('../plugins/builtin-detection/howto.md', import.meta.url), 'utf8');
  for (const t of manifest.howtoIndex) {
    assert.match(md, new RegExp(`^--- id: ${t.id}$`, 'm'), `${t.id} has no section`);
    assert.ok((t.keywords ?? []).length >= 3, `${t.id} needs search terms`);
  }
  for (const m of manifest.menu) {
    assert.ok(manifest.howtoIndex.some((t) => t.id === m.howto), `${m.run} points at no topic`);
  }
});

test('a bare uniform key is NOT offered, because it fits and means nothing', () => {
  // Verified on mrds 3.0.1: `unif` with no adjustment fits, reports p = 1 and an
  // abundance exactly equal to the raw count. A flat detection function asserts you saw
  // everything, which is the assumption this analysis exists to avoid.
  assert.deepEqual(Object.keys(DSMODEL), ['hn', 'hr', 'unifcos']);
  assert.match(DSMODEL.unifcos, /adj\.series = "cos"/);
  for (const spec of Object.values(DSMODEL)) {
    assert.doesNotMatch(spec, /key = key/, 'the key must be interpolated, not a symbol');
  }
  const offered = manifest.menu[0].inputs.find((i) => i.name === 'key').options.map((o) => o.value);
  assert.deepEqual(offered, Object.keys(DSMODEL));
});

// =============================================================================
// Guards — the floors the packages do not impose
// =============================================================================

test('distance sampling refuses a sample too small to mean anything', async () => {
  // `ddf` fits ONE observation without complaint (verified), so this floor is ours.
  const app = fakeApp(rList({ tooFew: 1, n: 4, W: 6 }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.equal(app.log.tables.length, 0, 'nothing is reported');
  assert.match(app.log.errors[0], new RegExp(`at least ${MIN_DETECTIONS}`));
  assert.match(app.log.errors[0], /found 4/);
});

test('the sample-size check lives in R, because JS never sees the values', async () => {
  // A single-column `variables` input reaches the plugin as a column NAME.
  const app = fakeApp(rList({ tooFew: 0, aic: 1, npar: 1, p: 0.5, eff: 3, n: 20, W: 6, dropped: 0, dens: NaN, abund: NaN, covered: NaN, svg: '' }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.match(app.log.code, new RegExp(`length\\(kept\\) < ${MIN_DETECTIONS}`));
});

test('the figure is a chart MODEL, not a finished SVG', async () => {
  // The #140 rule: ask R for numbers, not pictures. The figure was baked for one day
  // because the `histogram` kind had no overlay series; it has one now.
  const app = fakeApp(rList({
    tooFew: 0, aic: 1, npar: 1, p: 0.5, eff: 3, n: 3, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN,
    gx: [0, 3, 6], fx: [0.3, 0.2, 0.1], curve: [1, 0.6, 0.2], used: [1, 2, 3],
  }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.equal(app.log.plots.length, 0, 'nothing is baked');
  assert.equal(app.log.charts.length, 1);
  const m = app.log.charts[0];
  assert.equal(m.kind, 'histogram');
  assert.deepEqual(m.values, [1, 2, 3], 'the raw distances, so the reader can rebin');
  assert.deepEqual(m.overlay.x, [0, 3, 6]);
  assert.deepEqual(m.overlay.y, [0.3, 0.2, 0.1]);
  // Density, because the bars' measure is a live control and a pre-scaled curve would be
  // wrong the moment the reader switched it.
  // `valueMeasure`, not `measure` — the latter is ignored by the kind, which had this
  // figure rendering as counts while the model asked for a density.
  assert.equal(m.view.valueMeasure, 'density');
  assert.equal(m.view.measure, undefined, 'the key that does nothing is not used');
  assert.match(m.axes.x.title, /Perpendicular/);
});

test('the x axis names what was measured, which differs by survey shape', async () => {
  const mk = () => fakeApp(rList({
    tooFew: 0, aic: 1, npar: 1, p: 0.5, eff: 3, n: 3, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN,
    gx: [0, 3, 6], fx: [0.3, 0.2, 0.1], curve: [1, 0.6, 0.2], used: [1, 2, 3],
  }));
  const pt = mk();
  await distance(pt, { dist: ['d'], shape: 'point', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.match(pt.log.charts[0].axes.x.title, /Radial/);
});

test('a curve that did not evaluate is REPORTED, not silently dropped', async () => {
  // The lesson from the baked version, which outlived it: passing `col` to plot.ddf
  // failed, a tryCatch swallowed it, and the figure was simply absent for a whole live
  // run while two tables appeared as normal. Silence is the worse half of that bug.
  const app = fakeApp(rList({
    tooFew: 0, aic: 1, npar: 1, p: 0.5, eff: 3, n: 3, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN,
    gx: [0, 3, 6], fx: [NaN, NaN, NaN], curve: [NaN, NaN, NaN], used: [1, 2, 3],
  }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.equal(app.log.charts.length, 0);
  assert.ok(app.log.texts.some((t) => /could not be drawn/.test(t)), 'it says so');
  assert.equal(app.log.tables.length, 2, 'and the estimates still stand');
});

test('the curve comes off a GRID, with the design-matrix rows replicated first', async () => {
  // `detfct` evaluates against the design matrices, which carry one row per observation,
  // so a grid call recycles — the right values repeated n times. Replicating those rows
  // to the grid's length is mrds' own technique, from `plot.ds`.
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.match(app.log.code, /dobj\$scale\$dm\[rep\(1, length\(gx\)\)/);
  assert.match(app.log.code, /dobj\$shape\$dm\[rep\(1, length\(gx\)\)/);
  assert.match(app.log.code, /detfct\(gx, dobj, width = W\)/);
  // And no drawing device at all.
  assert.doesNotMatch(app.log.code, /svgstring|dev\.off|plot\(/, 'R draws nothing now');
  assert.deepEqual(app.log.installed, ['mrds'], 'svglite is no longer needed');
});

test('a column that does not exist is NAMED, not reported as an R internals failure', async () => {
  // Hit for real: bad names produced "Can't construct data.frame. Source object is not
  // eligible". Unreachable from the menu (the picker only offers real columns), reachable
  // from a do-file with a typo.
  const app = fakeApp(rList({ badInput: 1 }));
  await occupancy(app, { visits: ['nope', 'alsonope'], model: 'occu', kmax: 0 });
  assert.equal(app.log.tables.length, 0);
  assert.match(app.log.errors[0], /could not read 2 visit column\(s\) — nope, alsonope/);
});

test('occupancy refuses a single visit, which is the whole mechanism', async () => {
  const app = fakeApp();
  await occupancy(app, { visits: ['v1'], model: 'occu', kmax: 0 });
  assert.equal(app.log.code, null, 'R is never called');
  assert.match(app.log.errors[0], /at least two visit columns/);
});

test('webr.run is called with the code ALONE — the host injects the inputs', async () => {
  // Passing bindings as a second argument would be read as WebR options and silently
  // bind nothing.
  let args = null;
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  app.webr.run = async (...a) => { args = a; return { result: rList({ tooFew: 1, n: 0, W: 0 }) }; };
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.equal(args.length, 1, 'code only');
});

// =============================================================================
// The arithmetic the plugin does itself
// =============================================================================

test('the naive figure is reported beside the corrected one', async () => {
  // The gap between them IS the result; a corrected psi with nothing to compare it to
  // reads as just another number.
  const app = fakeApp(rList({
    tooFew: 0, nSites: 10, nVisits: 3, naive: 0.7, maxObs: 2.3, aic: 43.46, K: NaN,
    stateEst: 0.8, stateLo: 0.3, stateHi: 0.97, detEst: 0.5, detLo: 0.2, detHi: 0.8,
  }));
  await occupancy(app, { visits: ['v1', 'v2', 'v3'], model: 'occu', kmax: 0 });
  const cmp = app.log.tables.find((t) => /detection correction changed/.test(t.caption));
  assert.ok(cmp, 'the comparison table is always printed');
  assert.deepEqual(cmp.rows.map((r) => r[0]),
    ['Naive occupancy (ever detected)', 'Corrected ψ', 'Difference']);
  assert.equal(cmp.rows[0][1], '0.7000');
  assert.equal(cmp.rows[2][1], '0.1000', '0.8 - 0.7');
  // And the note quantifies the hole: (1 - 0.5)^3 = 0.125.
  assert.match(app.log.texts[0], /0\.1250/);
});

test('density is omitted rather than invented when effort is not given', async () => {
  const app = fakeApp(rList({
    tooFew: 0, aic: 66.777, npar: 1, p: 0.5528, eff: 3.3166, n: 20, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN, svg: '',
  }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  // /Detection/ also matches "Detection function" — the FIRST table — so this looked up
  // the wrong one and passed for the wrong reason until the assertion got specific.
  const det = app.log.tables.find((t) => /^Detection (and density|—)/.test(t.caption));
  const labels = det.rows.map((r) => r[0]);
  assert.ok(!labels.some((l) => /Density|Abundance/.test(l)), 'no density without effort');
  assert.ok(labels.includes('Uncorrected count'), 'the raw count is always shown');
  assert.match(det.caption, /supply an effort figure/);
});

test('a small-but-usable sample is called provisional', async () => {
  const app = fakeApp(rList({
    tooFew: 0, aic: 66.777, npar: 1, p: 0.5528, eff: 3.3166, n: 20, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN, svg: '',
  }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  // Searched rather than indexed: a run whose figure failed also appends a note about
  // THAT, so the interpretation note is not reliably first.
  const note = app.log.texts.find((t) => /provisional/.test(t));
  assert.ok(note, 'a sub-60 fit is called provisional');
  assert.match(note, /60/);
});

test('the point-transect wording and radius differ from the line', async () => {
  const mk = (shape) => fakeApp(rList({
    tooFew: 0, aic: 70.33, npar: 1, p: 0.1758, eff: 2.5157, n: 20, W: 6, dropped: 0,
    dens: NaN, abund: NaN, covered: NaN, svg: '',
  }));
  const pt = mk('point');
  await distance(pt, { dist: ['d'], shape: 'point', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.ok(pt.log.tables[1].rows.some((r) => r[0] === 'Effective detection radius'));
  assert.match(pt.log.code, /sqrt\(p\) \* W/, 'a point searches area ~ radius squared');
  assert.match(pt.log.code, /effort \* pi \* eff\^2/);

  const ln = mk('line');
  await distance(ln, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  assert.ok(ln.log.tables[1].rows.some((r) => r[0] === 'Effective strip width'));
  assert.match(ln.log.code, /2 \* effort \* eff/, 'a line is searched on both sides');
});

// =============================================================================
// Against the authority — the generated R, on local R
// =============================================================================

test('the generated R agrees with a canonical mrds call — all three keys', { skip: !haveR && 'local R with mrds not available' }, async () => {
  // Anchors at the DEFAULT width (the largest observed distance, 5.4), which is what the
  // plugin uses when truncation is 0.
  const anchor = { hn: 65.8286346364, hr: 67.3034663038, unifcos: 65.3765716945 };
  for (const [key, aic] of Object.entries(anchor)) {
    const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
    await distance(app, { dist: ['d'], shape: 'line', key, truncation: 0, effort: 0, area: 0 });
    const got = runOnLocalR(app.log.code, { dist: D, truncation: 0, effort: 0, area: 0 });
    assert.equal(got.tooFew, 'FALSE', key);
    const ref = referenceDistance({ width: 5.4, dsmodel: DSMODEL[key] });
    assertAgrees(got, ref, ['aic', 'p', 'eff', 'n'], key);
    near(got.aic, aic, 6, `${key} AIC anchor`);
    // The curve is numbers now, so its presence is checked as numbers: a density over
    // the grid that integrates to 1 by construction.
    assert.ok(Number(got.fx) > 0, `${key} curve evaluated`);
  }
});

test('…and at an explicit truncation width', { skip: !haveR && 'local R with mrds not available' }, async () => {
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 6, effort: 0, area: 0 });
  const got = runOnLocalR(app.log.code, { dist: D, truncation: 6, effort: 0, area: 0 });
  const ref = referenceDistance({ width: 6, dsmodel: DSMODEL.hn });
  assertAgrees(got, ref, ['aic', 'p', 'eff'], 'W=6');
  near(got.aic, 66.776617, 6);
  near(got.eff, 3.316636396, 9, 'ESW = p * W');
});

test('the point transect searches a disc, not a strip', { skip: !haveR && 'local R with mrds not available' }, async () => {
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(app, { dist: ['d'], shape: 'point', key: 'hn', truncation: 0, effort: 0, area: 0 });
  const got = runOnLocalR(app.log.code, { dist: D, truncation: 0, effort: 0, area: 0 });
  const ref = referenceDistance({ width: 5.4, dsmodel: DSMODEL.hn, point: true });
  assertAgrees(got, ref, ['aic', 'p', 'eff'], 'point');
  near(got.aic, 70.041946, 6, 'and it differs from the line fit');
  near(got.eff, 2.549135843, 9, 'EDR = sqrt(p) * W');
  // The line fit on the same data is a different number — the flag is doing something.
  const lineApp = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(lineApp, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 0, area: 0 });
  const line = runOnLocalR(lineApp.log.code, { dist: D, truncation: 0, effort: 0, area: 0 });
  assert.notEqual(Number(line.aic).toFixed(4), Number(got.aic).toFixed(4));
});

test('density and abundance follow from effort', { skip: !haveR && 'local R with mrds not available' }, async () => {
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 0, effort: 50, area: 1000 });
  const got = runOnLocalR(app.log.code, { dist: D, truncation: 0, effort: 50, area: 1000 });
  const ref = referenceDistance({ width: 5.4, dsmodel: DSMODEL.hn, effort: 50, area: 1000 });
  assertAgrees(got, ref, ['dens', 'abund', 'covered'], 'density');
  // n / (2 L ESW) = 20 / (2 * 50 * 3.481806800398)
  near(got.covered, 348.180680, 6, '2 * L * ESW');
  near(got.dens, 0.057441441, 9);
  near(got.abund, 57.44144, 5);
});

test('truncation drops the far detections and is reported', { skip: !haveR && 'local R with mrds not available' }, async () => {
  const app = fakeApp(rList({ tooFew: 1, n: 0, W: 0 }));
  await distance(app, { dist: ['d'], shape: 'line', key: 'hn', truncation: 3, effort: 0, area: 0 });
  const got = runOnLocalR(app.log.code, { dist: D, truncation: 3, effort: 0, area: 0 });
  assert.equal(Number(got.W), 3);
  assert.equal(Number(got.n), 15, 'five distances exceed 3');
  assert.equal(Number(got.dropped), 5);
});

test('the occupancy likelihood needs no package at all', async () => {
  // Hand-rolled because `unmarked` has no wasm binary. If a `library()` call ever creeps
  // back in, the analysis starts failing in the browser while passing every test here.
  const app = fakeApp(rList({ tooFew: 1, nSites: 0 }));
  await occupancy(app, { visits: ['v1', 'v2'], model: 'occu', kmax: 0 });
  assert.doesNotMatch(app.log.code, /library\(|require\(/, 'base R only');
  assert.deepEqual(app.log.installed, [], 'nothing is installed');
  // The published likelihoods, identifiable in the source: MacKenzie's second branch is
  // the whole model, and Royle's is a sum over unobserved abundance.
  assert.match(app.log.code, /psi \* \(1 - p\)\^n \+ \(1 - psi\)/, 'MacKenzie et al. 2002');
  assert.match(app.log.code, /dpois\(N, lambda\) \* prod\(dbinom\(row, N, p\)\)/, 'Royle 2004');
});

test('HAND-ROLLED occupancy matches unmarked to ten decimal places', { skip: !haveR && 'local R with unmarked not available' }, async () => {
  // The rule for hand-rolled statistics is a MEASURED distance from the authority, not a
  // loose tolerance. This one has no distance to measure: psi, p, AIC and both standard
  // errors agree to every digit R prints.
  const app = fakeApp(rList({ tooFew: 1, nSites: 0 }));
  await occupancy(app, { visits: ['v1', 'v2', 'v3'], model: 'occu', kmax: 0 });
  const got = runOnLocalR(app.log.code, { visits: Y, kmax: 0 });
  assert.equal(got.tooFew, 'FALSE');
  assert.equal(got.converged, 'TRUE');
  assertAgrees(got, referenceOccupancy(Y), ['stateEst', 'detEst', 'aic', 'naive'], 'occu');
  near(got.stateEst, 0.8000000, 7, 'psi');
  near(got.detEst, 0.5000000, 7, 'p');
  near(got.aic, 43.46003, 5);
  near(got.naive, 0.7000, 4, 'and the naive figure it is compared to');
  // The CI bounds are back-transformed from the link scale, so they stay inside [0, 1].
  assert.ok(Number(got.stateLo) > 0 && Number(got.stateHi) < 1, 'psi CI inside [0,1]');
});

test('HAND-ROLLED N-mixture matches unmarked to within optimiser tolerance', { skip: !haveR && 'local R with unmarked not available' }, async () => {
  // Here there IS a distance, so it is stated: the AIC agrees to seven decimals while
  // lambda differs by about 1.9e-4. That is two optimisers stopping at slightly different
  // points on the same surface — an identical AIC on a DIFFERENT likelihood is not a
  // thing that happens, which is why the AIC is asserted tightly and lambda loosely.
  const app = fakeApp(rList({ tooFew: 1, nSites: 0 }));
  await occupancy(app, { visits: ['v1', 'v2', 'v3'], model: 'pcount', kmax: 0 });
  const got = runOnLocalR(app.log.code, { visits: YC, kmax: 50 });
  const ref = referenceOccupancy(YC, { count: true, K: 50 });
  assert.equal(got.converged, 'TRUE');
  near(got.aic, Number(ref.aic), 6, 'AIC — the same surface');
  assert.ok(Math.abs(Number(got.stateEst) - Number(ref.stateEst)) < 1e-3,
    `lambda ${got.stateEst} vs unmarked ${ref.stateEst}`);
  assert.ok(Math.abs(Number(got.detEst) - Number(ref.detEst)) < 1e-3,
    `p ${got.detEst} vs unmarked ${ref.detEst}`);
  near(got.stateEst, 2.76017, 4, 'lambda anchor');
  assert.ok(Number(got.stateLo) > 0, 'a lambda CI cannot go negative');
});

test('NEGATIVE CONTROL — perfect detection recovers the naive figure', { skip: !haveR && 'local R not available' }, async () => {
  // Every occupied site detected on every visit: there is nothing to correct, so the
  // model must agree with the count. Without this, a merely plausible-looking psi would
  // pass every test above.
  const perfect = [[1, 1, 1], [0, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 1],
    [1, 1, 1], [0, 0, 0], [0, 0, 0], [1, 1, 1], [0, 0, 0]];
  const app = fakeApp(rList({ tooFew: 1, nSites: 0 }));
  await occupancy(app, { visits: ['v1', 'v2', 'v3'], model: 'occu', kmax: 0 });
  const got = runOnLocalR(app.log.code, { visits: perfect, kmax: 0 });
  near(got.naive, 0.5000, 4);
  assert.ok(Math.abs(Number(got.stateEst) - 0.5) < 1e-4, `psi should be 0.5, got ${got.stateEst}`);
  assert.ok(Number(got.detEst) > 0.99, `p should be ~1, got ${got.detEst}`);
});
