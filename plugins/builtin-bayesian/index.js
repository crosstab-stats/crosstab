/**
 * @file plugins/builtin-bayesian/index.js
 * Built-in plugin: the **Bayesian** menu.
 *
 * Bayesian counterparts to the frequentist staples, all running on precompiled
 * WASM samplers (no Stan/compiler needed in the browser):
 *  - **Linear regression** — `MCMCpack::MCMCregress`: posterior mean/SD and 95%
 *    *credible* intervals per coefficient.
 *  - **Bayes factor: t-test / correlation** — `BayesFactor`: how much the data
 *    favour the effect vs the null, with a plain-language reading.
 *  - **Vector autoregression (BVAR)** — `BVAR::bvar`: a Bayesian VAR with a
 *    posterior-median forecast and a 68% credible band (the macro workhorse).
 *
 * Packages are installed lazily on first use (they're sizable) rather than at
 * load, so opening the app stays fast for users who never touch Bayesian.
 *
 * Declarative plugin: the manifest declares the inputs; the host binds single
 * variables as R vectors and multi-selections as R data.frames.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-bayesian',
  name: 'Bayesian',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Bayesian',
  keywords: ['bayesian', 'bayes factor', 'posterior', 'credible interval', 'mcmc', 'bvar', 'prior'],
  disciplines: ['Psychology', 'Political Science', 'Public Health', 'Social Science'],
  rPackages: [],
  menu: [
    {
      label: 'Linear regression…',
      run: 'regression',
      order: 10,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', hint: 'The numeric outcome you want to model and explain.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
      ],
    },
    {
      label: 'Bayes factor: t-test…',
      run: 'bfTTest',
      order: 20,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome (numeric)', hint: 'The numeric measure whose means you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'group', kind: 'variables', label: 'Group (2 levels)', hint: 'The variable that splits cases into the two groups to compare.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
    {
      label: 'Bayes factor: correlation…',
      run: 'bfCorr',
      order: 30,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Variable X', hint: 'One of the two numeric variables to test for a relationship.', multiple: false, types: ['numeric'], unique: true },
        { name: 'y', kind: 'variables', label: 'Variable Y', hint: 'The other numeric variable to test against the first.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Vector autoregression (BVAR)…',
      run: 'bvar',
      order: 40,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Time series (2+ numeric, in order)', hint: 'Two or more numeric columns that move together over time.', multiple: true, types: ['numeric'] },
        { name: 'lags', kind: 'number', label: 'Lags', hint: 'How many past time steps feed into each prediction.', default: 2 },
        { name: 'horizon', kind: 'number', label: 'Forecast horizon', hint: 'How many future time steps to predict.', default: 8 },
      ],
    },
  ],
};

// --- Bayesian linear regression (MCMCpack) -----------------------------------

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 */
export async function regression(app, { dv: dvName, ivs: ivNames }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Bayesian regression: choose an outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['MCMCpack']);
  const meta = metaMap(await app.data.getVariableMeta());

  const recodes = [recodeLine('dv', meta.get(dvName)), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))]
    .filter(Boolean)
    .join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.dv ~ ${ivNames.map(term).join(' + ')}`;

  const rCode = `
    suppressMessages(library(MCMCpack))
    ${recodes}
    d <- cbind(.dv = dv, ivs)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    if (nrow(d) < ncol(d) + 2) stop("not enough complete cases for this model")
    fit <- MCMCregress(as.formula(${rStr(formula)}), data = d, mcmc = 5000, burnin = 1000, verbose = 0)
    s <- summary(fit); st <- s$statistics; q <- s$quantiles
    keep <- rownames(st) != "sigma2"
    list(terms = rownames(st)[keep], mean = unname(st[keep, "Mean"]), sd = unname(st[keep, "SD"]),
         lo = unname(q[keep, "2.5%"]), hi = unname(q[keep, "97.5%"]),
         sigma2 = unname(st["sigma2", "Mean"]), n = nrow(d), draws = nrow(fit))`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms');
  const mean = r.nums('mean');
  const sd = r.nums('sd');
  const lo = r.nums('lo');
  const hi = r.nums('hi');

  await app.results.appendTable(
    {
      columns: ['', 'Posterior mean', 'SD', '95% Credible Interval'],
      rows: terms.map((t, i) => [
        t === '(Intercept)' ? '(Constant)' : prettyTerm(t),
        f(mean[i], 3),
        f(sd[i], 3),
        ci(lo[i], hi[i]),
      ]),
      rowHeaders: true,
    },
    { caption: `Bayesian Regression — outcome: ${labelOf(meta.get(dvName), dvName)} (N = ${r.num('n')}, ${r.num('draws')} draws)` },
  );
  await app.results.appendText(
    `Coefficients are **posterior means**; the interval is a **95% credible interval** — given the data and the (weakly informative) default priors, there's a 95% probability the coefficient lies inside it. ` +
      `A coefficient whose interval excludes 0 is "credibly" non-zero. Residual variance σ² ≈ ${f(r.num('sigma2'), 3)}.`,
  );
}

// --- Bayes factor: independent-samples t-test (BayesFactor) -------------------

/**
 * @param {object} app
 * @param {{y: string, group: string}} inputs
 */
export async function bfTTest(app, { y: yName, group: gName }) {
  if (!yName || !gName) {
    await app.results.appendError('Bayes factor t-test: choose an outcome and a 2-level grouping variable.');
    return;
  }
  await app.webr.installPackages(['BayesFactor']);
  const meta = metaMap(await app.data.getVariableMeta());

  const rCode = `
    suppressMessages(library(BayesFactor))
    ${recodeLine('y', meta.get(yName))}
    g <- as.factor(group); ok <- is.finite(y) & !is.na(g)
    y <- y[ok]; g <- droplevels(g[ok]); lv <- levels(g)
    if (length(lv) != 2) stop("group must have exactly 2 levels (has ", length(lv), ")")
    a <- y[g == lv[1]]; b <- y[g == lv[2]]
    bf <- extractBF(ttestBF(x = a, y = b))$bf
    list(lv = as.character(lv), n1 = length(a), n2 = length(b),
         m1 = mean(a), m2 = mean(b), bf = bf)`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.strs('lv');
  const bf = r.num('bf');

  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean'],
      rows: [
        [labelLevel(meta.get(gName), gName, lv[0]), f(r.num('n1'), 0), f(r.num('m1'), 3)],
        [labelLevel(meta.get(gName), gName, lv[1]), f(r.num('n2'), 0), f(r.num('m2'), 3)],
      ],
    },
    { caption: `Bayes Factor t-test — ${labelOf(meta.get(yName), yName)} by ${labelOf(meta.get(gName), gName)}` },
  );
  await appendBF(app, bf, 'a difference in means');
}

// --- Bayes factor: correlation (BayesFactor) ---------------------------------

/**
 * @param {object} app
 * @param {{x: string, y: string}} inputs
 */
export async function bfCorr(app, { x: xName, y: yName }) {
  if (!xName || !yName) {
    await app.results.appendError('Bayes factor correlation: choose two numeric variables.');
    return;
  }
  await app.webr.installPackages(['BayesFactor']);
  const meta = metaMap(await app.data.getVariableMeta());

  const rCode = `
    suppressMessages(library(BayesFactor))
    ${recodeLine('x', meta.get(xName))}
    ${recodeLine('y', meta.get(yName))}
    ok <- is.finite(x) & is.finite(y); x <- x[ok]; y <- y[ok]
    if (length(x) < 4) stop("need at least 4 complete pairs")
    bf <- extractBF(correlationBF(x, y))$bf
    list(r = cor(x, y), n = length(x), bf = bf)`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['N', 'Pearson r'],
      rows: [[f(r.num('n'), 0), f(r.num('r'), 3)]],
    },
    { caption: `Bayes Factor correlation — ${labelOf(meta.get(xName), xName)} & ${labelOf(meta.get(yName), yName)}` },
  );
  await appendBF(app, r.num('bf'), 'a non-zero correlation');
}

// --- Bayesian VAR (BVAR) -----------------------------------------------------

/**
 * @param {object} app
 * @param {{series: string[], lags: number, horizon: number}} inputs
 */
export async function bvar(app, { series: seriesNames, lags, horizon }) {
  if (!seriesNames || seriesNames.length < 2) {
    await app.results.appendError('BVAR: choose at least two numeric time series (in time order).');
    return;
  }
  await app.webr.installPackages(['BVAR']);
  const meta = metaMap(await app.data.getVariableMeta());

  const recodes = seriesNames.map((n) => recodeLine(`series[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    suppressMessages(library(BVAR))
    ${recodes}
    Y <- as.matrix(series); Y <- Y[stats::complete.cases(Y), , drop = FALSE]
    if (ncol(Y) < 2) stop("need at least 2 series")
    if (nrow(Y) < 20) stop("need at least ~20 complete time points")
    lags <- if (is.finite(lags)) max(1L, as.integer(lags)) else 2L
    h <- if (is.finite(horizon)) max(1L, as.integer(horizon)) else 8L
    f <- bvar(Y, lags = lags, n_draw = 2000L, n_burn = 1000L, verbose = FALSE)
    pr <- predict(f, horizon = h)
    q <- pr$quants            # dims: [quantile (16/50/84), horizon, variable]
    list(vars = colnames(Y), horizon = h, lags = lags, n = nrow(Y),
         med = as.numeric(q[2, , ]), lo = as.numeric(q[1, , ]), hi = as.numeric(q[3, , ]))`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const vars = r.strs('vars');
  const h = r.num('horizon');
  const med = r.nums('med');
  const lo = r.nums('lo');
  const hi = r.nums('hi');

  // q[2,,] flattens column-major: variable v, horizon t → index v*h + t.
  vars.forEach((v, vi) => {
    const rows = [];
    for (let t = 0; t < h; t++) {
      const idx = vi * h + t;
      rows.push([String(t + 1), f(med[idx], 3), ci(lo[idx], hi[idx])]);
    }
    return app.results.appendTable(
      { columns: ['Horizon', 'Forecast (median)', '68% band'], rows },
      { caption: `BVAR forecast — ${labelOf(meta.get(v), v)}` },
    );
  });
  // appendTable calls above are fire-and-forget within forEach; await a final note
  // (ordering is preserved because the host queues appends serially).
  await app.results.appendText(
    `Bayesian VAR with ${r.num('lags')} lag(s) on ${vars.length} series (${r.num('n')} time points, 2,000 posterior draws). ` +
      'Forecasts are posterior medians; the band is a 68% credible interval (≈ ±1 SD). Series are treated in the order selected.',
  );
}

// --- helpers -----------------------------------------------------------------

/** Append a Bayes-factor result row + a plain-language reading (Jeffreys scale). */
async function appendBF(app, bf, effectPhrase) {
  const f10 = Number.isFinite(bf) ? (bf >= 1 ? bf.toFixed(2) : bf.toExponential(2)) : '—';
  const f01 = Number.isFinite(bf) && bf > 0 ? (1 / bf).toFixed(2) : '—';
  await app.results.appendTable(
    {
      columns: ['BF₁₀ (effect vs null)', 'BF₀₁ (null vs effect)', 'Evidence'],
      rows: [[f10, f01, bfWords(bf, effectPhrase)]],
    },
    { caption: 'Bayes Factor' },
  );
  await app.results.appendText(
    'BF₁₀ is how many times more likely the data are under the effect than under the null. ' +
      'Rough reading: 1–3 anecdotal, 3–10 moderate, 10–30 strong, 30–100 very strong, >100 extreme (and the reciprocal favours the null).',
  );
}

/** Jeffreys-scale wording for a Bayes factor. */
function bfWords(bf, effectPhrase) {
  if (!Number.isFinite(bf) || bf <= 0) return '—';
  const favorsEffect = bf >= 1;
  const b = favorsEffect ? bf : 1 / bf;
  const dir = favorsEffect ? `for ${effectPhrase}` : 'for the null';
  let strength;
  if (b > 100) strength = 'Extreme';
  else if (b > 30) strength = 'Very strong';
  else if (b > 10) strength = 'Strong';
  else if (b > 3) strength = 'Moderate';
  else if (b > 1) strength = 'Anecdotal';
  else strength = 'No';
  return `${strength} evidence ${dir}`;
}

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

/** Show a group level via its value label when there is one. */
function labelLevel(meta, name, level) {
  const vl = meta?.valueLabels?.[level];
  return vl ? `${vl}` : `${name} = ${level}`;
}

function prettyTerm(term) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(term);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : term.replace(/`/g, '');
}

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—';
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Flatten an R list (`{names, values}` or plain) into typed accessors. */
function flat(rList) {
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
