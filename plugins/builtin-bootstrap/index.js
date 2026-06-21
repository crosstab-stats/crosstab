/**
 * @file plugins/builtin-bootstrap/index.js
 * Built-in plugin: Resampling ▸ Bootstrap the mean.
 *
 * Resamples a numeric variable with replacement `reps` times, takes each
 * resample's mean, and **emits those means as a new (active) dataset** via
 * `app.data.create` — so you can immediately plot/describe the bootstrap
 * distribution. Also reports the observed mean, bootstrap SE, and a 95%
 * percentile CI. The "analyses are data sources too" pattern.
 *
 * Declarative plugin: the manifest declares the variable + resample-count inputs;
 * the host binds them in R as `x` (a vector) and `reps` (a number).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-bootstrap',
  name: 'Bootstrap',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Resampling',
  keywords: ['resample', 'bootstrap', 'ci', 'confidence'],
  rPackages: ['boot'],
  menu: [
    {
      label: 'Bootstrap the mean…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'x', kind: 'variables', types: ['numeric'], multiple: false },
        { name: 'reps', kind: 'number', label: 'Number of resamples', default: 2000 },
      ],
    },
    {
      label: 'Bootstrap a statistic…',
      run: 'bootStatistic',
      order: 20,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Variable', multiple: false, types: ['numeric'] },
        {
          name: 'stat',
          kind: 'choice',
          label: 'Statistic',
          default: 'mean',
          options: [
            { value: 'mean', label: 'Mean' },
            { value: 'median', label: 'Median' },
            { value: 'sd', label: 'Std. deviation' },
            { value: 'var', label: 'Variance' },
            { value: 'IQR', label: 'IQR' },
            { value: 'trim', label: 'Trimmed mean (10%)' },
          ],
        },
        { name: 'reps', kind: 'number', label: 'Number of resamples', default: 2000 },
      ],
    },
    {
      label: 'Bootstrap a correlation…',
      run: 'bootCorr',
      order: 30,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Variable X', multiple: false, types: ['numeric'], unique: true },
        { name: 'y', kind: 'variables', label: 'Variable Y', multiple: false, types: ['numeric'], unique: true },
        { name: 'reps', kind: 'number', label: 'Number of resamples', default: 2000 },
      ],
    },
    {
      label: 'Permutation test (2 groups)…',
      run: 'permutation',
      order: 40,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome (numeric)', multiple: false, types: ['numeric'], unique: true },
        { name: 'group', kind: 'variables', label: 'Group (2 levels)', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        {
          name: 'stat',
          kind: 'choice',
          label: 'Compare',
          default: 'mean',
          options: [
            { value: 'mean', label: 'Difference in means' },
            { value: 'median', label: 'Difference in medians' },
          ],
        },
        { name: 'reps', kind: 'number', label: 'Number of permutations', default: 5000 },
      ],
    },
    {
      label: 'Power by simulation (t-test)…',
      run: 'power',
      order: 50,
      inputs: [
        { name: 'n', kind: 'number', label: 'N per group', default: 30 },
        { name: 'd', kind: 'number', label: "Effect size (Cohen's d)", default: 0.5 },
        { name: 'alpha', kind: 'number', label: 'Alpha', default: 0.05 },
        { name: 'reps', kind: 'number', label: 'Simulations', default: 2000 },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{x: string, reps: number}} inputs
 */
export async function run(app, { x: name, reps }) {
  if (!name) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const label = meta.get(name)?.label || name;
  const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));

  const rCode = `
    ${mv.length ? `x[x %in% c(${mv.map(Number).join(', ')})] <- NA` : ''}
    x <- as.numeric(x); x <- x[is.finite(x)]
    n <- length(x)
    if (n < 2) stop("need at least 2 non-missing values")
    B <- if (is.finite(reps) && reps >= 100) as.integer(min(round(reps), 100000)) else 2000L
    boot <- replicate(B, mean(sample(x, n, replace = TRUE)))
    list(boot = boot, observed = mean(x), se = sd(boot),
         ci_lo = unname(quantile(boot, .025)), ci_hi = unname(quantile(boot, .975)),
         n = n, reps = B)`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = normalizeResult(result);

  // Emit the bootstrap distribution as a new (active) dataset.
  await app.data.create({
    name: `Bootstrap mean of ${name}`,
    variables: [
      { name: 'boot_mean', type: 'numeric', measurementLevel: 'scale', label: `Bootstrap mean of ${label}` },
    ],
    columns: { boot_mean: r.boot },
  });

  const f = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
  await app.results.appendTable(
    {
      columns: ['N', 'Observed mean', 'Bootstrap SE', '95% CI (percentile)'],
      rows: [[Number.isFinite(r.n) ? Math.round(r.n) : '—', f(r.observed), f(r.se), `[${f(r.ci_lo)}, ${f(r.ci_hi)}]`]],
    },
    { caption: `Bootstrap of the mean — ${label} (${(r.reps || reps).toLocaleString()} resamples)` },
  );
  await app.results.appendText(
    `The ${(r.reps || reps).toLocaleString()} resampled means are now a dataset, **Bootstrap mean of ${name}** ` +
      '(the active dataset). Plot it with **Graphs ▸ Histogram** on `boot_mean`.',
  );
}

// --- helpers -----------------------------------------------------------------

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? Number(a[0]) : Number(v);
  };
  return {
    boot: arr(byName.boot).map(Number),
    observed: scalar(byName.observed),
    se: scalar(byName.se),
    ci_lo: scalar(byName.ci_lo),
    ci_hi: scalar(byName.ci_hi),
    n: scalar(byName.n),
    reps: scalar(byName.reps),
  };
}

// --- Bootstrap any statistic (+ BCa CI via the boot package) ------------------

const STAT_LABEL = {
  mean: 'Mean',
  median: 'Median',
  sd: 'Std. deviation',
  var: 'Variance',
  IQR: 'IQR',
  trim: 'Trimmed mean (10%)',
};

/**
 * @param {object} app
 * @param {{x: string, stat: string, reps: number}} inputs
 */
export async function bootStatistic(app, { x: name, stat, reps }) {
  if (!name) return;
  await app.webr.installPackages(['boot']);
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    suppressMessages(library(boot))
    ${recodeLine('x', meta.get(name))}
    x <- as.numeric(x); x <- x[is.finite(x)]; n <- length(x)
    if (n < 3) stop("need at least 3 non-missing values")
    B <- as.integer(min(max(if (is.finite(reps)) reps else 2000, 200), 100000))
    fn <- switch(${rStr(stat)},
      median = function(d, i) median(d[i]),
      sd     = function(d, i) sd(d[i]),
      var    = function(d, i) var(d[i]),
      IQR    = function(d, i) IQR(d[i]),
      trim   = function(d, i) mean(d[i], trim = 0.1),
      function(d, i) mean(d[i]))
    b <- boot(x, fn, R = B)
    bca <- tryCatch(boot.ci(b, type = "bca")$bca[4:5], error = function(e) c(NA_real_, NA_real_))
    list(observed = b$t0, se = sd(b$t), lo = bca[1], hi = bca[2], n = n, reps = B)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flatList(result);
  await app.results.appendTable(
    {
      columns: [STAT_LABEL[stat] || 'Statistic', 'Bootstrap SE', '95% CI (BCa)', 'N', 'Resamples'],
      rows: [[f(r.num('observed'), 3), f(r.num('se'), 3), ci(r.num('lo'), r.num('hi')), f(r.num('n'), 0), f(r.num('reps'), 0)]],
    },
    { caption: `Bootstrap — ${STAT_LABEL[stat] || stat} of ${labelOf(meta.get(name), name)}` },
  );
  await app.results.appendText(
    'The CI is **bias-corrected and accelerated (BCa)** — generally the most accurate bootstrap interval, and unlike a textbook formula it needs no assumption about the statistic’s sampling distribution.',
  );
}

/**
 * @param {object} app
 * @param {{x: string, y: string, reps: number}} inputs
 */
export async function bootCorr(app, { x: xName, y: yName, reps }) {
  if (!xName || !yName) return;
  await app.webr.installPackages(['boot']);
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    suppressMessages(library(boot))
    ${recodeLine('x', meta.get(xName))}
    ${recodeLine('y', meta.get(yName))}
    ok <- is.finite(x) & is.finite(y); d <- data.frame(x = x[ok], y = y[ok])
    if (nrow(d) < 4) stop("need at least 4 complete pairs")
    B <- as.integer(min(max(if (is.finite(reps)) reps else 2000, 200), 100000))
    b <- boot(d, function(dat, i) cor(dat$x[i], dat$y[i]), R = B)
    bca <- tryCatch(boot.ci(b, type = "bca")$bca[4:5], error = function(e) c(NA_real_, NA_real_))
    list(observed = b$t0, se = sd(b$t), lo = bca[1], hi = bca[2], n = nrow(d), reps = B)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flatList(result);
  await app.results.appendTable(
    {
      columns: ['Pearson r', 'Bootstrap SE', '95% CI (BCa)', 'N pairs', 'Resamples'],
      rows: [[f(r.num('observed'), 3), f(r.num('se'), 3), ci(r.num('lo'), r.num('hi')), f(r.num('n'), 0), f(r.num('reps'), 0)]],
    },
    { caption: `Bootstrap correlation — ${labelOf(meta.get(xName), xName)} & ${labelOf(meta.get(yName), yName)}` },
  );
}

// --- Permutation / randomization test ----------------------------------------

/**
 * @param {object} app
 * @param {{y: string, group: string, stat: string, reps: number}} inputs
 */
export async function permutation(app, { y: yName, group: gName, stat, reps }) {
  if (!yName || !gName) return;
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    ${recodeLine('y', meta.get(yName))}
    g <- as.factor(group); ok <- is.finite(y) & !is.na(g)
    y <- y[ok]; g <- droplevels(g[ok]); lv <- levels(g)
    if (length(lv) != 2) stop("group must have exactly 2 levels (has ", length(lv), ")")
    a <- y[g == lv[1]]; b <- y[g == lv[2]]; na <- length(a)
    pool <- c(a, b); N <- length(pool)
    .fmed <- function(idx) median(pool[idx]) - median(pool[-idx])
    .fmean <- function(idx) mean(pool[idx]) - mean(pool[-idx])
    diff <- if (${rStr(stat)} == "median") .fmed else .fmean
    obs <- diff(seq_len(na))
    B <- as.integer(min(max(if (is.finite(reps)) reps else 5000, 1000), 200000))
    perm <- replicate(B, diff(sample(N, na)))
    p <- (1 + sum(abs(perm) >= abs(obs))) / (B + 1)
    list(lv = as.character(lv), n1 = length(a), n2 = length(b), m1 = mean(a), m2 = mean(b),
         obs = obs, p = p, reps = B)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flatList(result);
  const lv = r.strs('lv');
  const what = stat === 'median' ? 'medians' : 'means';
  await app.results.appendTable(
    {
      columns: ['Group', 'N', stat === 'median' ? 'Median' : 'Mean'],
      rows: [
        [labelLevel(meta.get(gName), gName, lv[0]), f(r.num('n1'), 0), f(r.num('m1'), 3)],
        [labelLevel(meta.get(gName), gName, lv[1]), f(r.num('n2'), 0), f(r.num('m2'), 3)],
      ],
    },
    { caption: `Permutation test — ${labelOf(meta.get(yName), yName)} by ${labelOf(meta.get(gName), gName)}` },
  );
  await app.results.appendTable(
    {
      columns: [`Observed difference in ${what}`, 'Permutation p (two-sided)', 'Permutations'],
      rows: [[f(r.num('obs'), 3), fmtP(r.num('p')), f(r.num('reps'), 0)]],
    },
    { caption: 'Randomization Test' },
  );
  await app.results.appendText(
    'The p-value is the share of random label-shufflings whose group difference is at least as large as the observed one — no normality or equal-variance assumption required.',
  );
}

// --- Power by simulation (two-sample t-test) ----------------------------------

/**
 * @param {object} app
 * @param {{n: number, d: number, alpha: number, reps: number}} inputs
 */
export async function power(app, { n, d, alpha, reps }) {
  const rCode = `
    n0 <- max(2L, as.integer(if (is.finite(n)) n else 30))
    d <- as.numeric(if (is.finite(d)) d else 0.5)
    alpha <- as.numeric(if (is.finite(alpha) && alpha > 0 && alpha < 1) alpha else 0.05)
    B <- as.integer(min(max(if (is.finite(reps)) reps else 2000, 200), 50000))
    simpow <- function(nn, BB) mean(replicate(BB, t.test(rnorm(nn, d), rnorm(nn))$p.value < alpha))
    power0 <- simpow(n0, B)
    nstar <- NA_integer_
    if (d != 0) {                       # binary-search n for ~80% power
      lo <- 2L; hi <- 2000L
      for (it in 1:11) {
        mid <- as.integer((lo + hi) / 2)
        if (simpow(mid, 1200L) >= 0.80) { nstar <- mid; hi <- mid } else lo <- mid + 1L
      }
    }
    list(n = n0, d = d, alpha = alpha, power = power0, reps = B, nstar = nstar)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flatList(result);
  const nstar = r.num('nstar');
  await app.results.appendTable(
    {
      columns: ['N per group', "Effect size (d)", 'Alpha', 'Simulated power', 'Simulations'],
      rows: [[f(r.num('n'), 0), f(r.num('d'), 2), f(r.num('alpha'), 3), f(r.num('power'), 3), f(r.num('reps'), 0)]],
    },
    { caption: 'Power Analysis (simulation) — two-sample t-test' },
  );
  await app.results.appendText(
    `Estimated by simulating ${r.num('reps').toLocaleString()} studies and counting how often p < α. ` +
      (Number.isFinite(nstar)
        ? `To reach **80% power** at this effect size you'd need roughly **${Math.round(nstar)} per group** (≈ ${Math.round(nstar) * 2} total).`
        : 'Increase N (or the effect size) and re-run to reach a higher power.'),
  );
}

// --- shared helpers for the resampling actions -------------------------------

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function labelLevel(meta, name, level) {
  const vl = meta?.valueLabels?.[level];
  return vl ? `${vl}` : `${name} = ${level}`;
}

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—';
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Flatten an R list (`{names, values}` or plain) into typed accessors. */
function flatList(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map(Number),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
