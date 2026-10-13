/**
 * @file plugins/builtin-regression/index.js
 * Built-in plugin: Regression ▸ Linear.
 *
 * Ordinary least squares (`lm`) with an SPSS-style Model Summary + Coefficients.
 * Factor predictors are dummy-coded.
 * Computed in R; the host renders the structured tables.
 *
 * Declarative plugin: the manifest declares the outcome + predictor inputs (both
 * `unique`, so a predictor can't be the outcome). The host binds the outcome in R
 * as the vector `dv` and the predictors as the data.frame `ivs`.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, labelOf, fmtP, ci, rStr, unpackR, prettyTerm } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-regression',
  name: 'Linear Regression',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['lm', 'linear', 'ols', 'regression', 'vif', 'residuals', 'diagnostics', 'cook'],
  howto:
    'GUI: Regression ▸ Linear, then pick one outcome and one or more predictors. ' +
    "You get SPSS's blocks in its order — Model Summary (R, R², adjusted R², Std. Error of the " +
    'Estimate), the ANOVA table testing the model, and Coefficients (with VIF) — plus residual ' +
    'diagnostic plots SPSS does not print.\n' +
    'Syntax: run builtin-regression.run {"dv": "income", "ivs": ["age", "education"]}\n' +
    '  • dv — the numeric outcome to explain.\n' +
    '  • ivs — one or more predictor variables.',
  // No svglite: the diagnostics are chart MODELS now, drawn by the host. Dropping the
  // declaration matters beyond tidiness — the offline cache pre-fetches the R packages of
  // ENABLED plugins, so a stale entry costs every user a download they never use.
  rPackages: [],
  menu: [
    {
      label: 'Linear…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', hint: 'The numeric measure you want to explain or predict.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 */
export async function run(app, { dv: dvName, ivs: ivNames }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Linear Regression: choose an outcome and at least one predictor.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const term = (name) =>
    meta.get(name)?.categorical ? `factor(\`${name}\`)` : `\`${name}\``;
  const formula = `.dv ~ ${ivNames.map(term).join(' + ')}`;

  const rCode = `
    d <- cbind(.dv = dv, ivs)
    fit <- lm(as.formula(${rStr(formula)}), data = d)
    s <- summary(fit); co <- s$coefficients; fst <- s$fstatistic
    ci <- tryCatch(confint(fit), error = function(e) matrix(NA_real_, nrow(co), 2))
    res <- residuals(fit); fitv <- fitted(fit); n <- length(res)
    X <- model.matrix(fit)[, -1, drop = FALSE]
    vifv <- tryCatch(if (ncol(X) >= 2) diag(solve(cor(X))) else rep(NA_real_, ncol(X)),
                     error = function(e) rep(NA_real_, ncol(X)))
    sw <- if (n >= 3 && n <= 5000) shapiro.test(res) else list(statistic = NA_real_, p.value = NA_real_)
    dw <- sum(diff(res)^2) / sum(res^2)
    cook <- cooks.distance(fit); thr <- 4 / n
    # The two diagnostic plots are returned as NUMBERS, not pictures (#131 / baked-chart
    # review): the host draws them, so they get live controls, the colourblind-safe palette
    # and re-editability, and this plugin needs no svglite. qqnorm(plot.it = FALSE) returns
    # the very x/y it would have drawn; qqline's line is the one through the quartiles.
    qq <- qqnorm(res, plot.it = FALSE)
    qy <- quantile(res, c(0.25, 0.75), names = FALSE, type = 7)
    qx <- qnorm(c(0.25, 0.75))
    qqSlope <- diff(qy) / diff(qx)
    qqInt <- qy[1] - qqSlope * qx[1]
    list(
      terms = rownames(co), estimate = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
      ciLo = ci[, 1], ciHi = ci[, 2], vifNames = colnames(X), vif = unname(vifv),
      r2 = s$r.squared, adjr2 = s$adj.r.squared, sigma = s$sigma,
      # The regression / residual / total partition behind the F. SPSS prints this as
      # its own ANOVA table; the F itself was already here, folded into Model Summary,
      # but with no sums of squares to show where it came from.
      ssReg = sum((fitv - mean(fitv))^2), ssRes = sum(res^2),
      dfReg = if (is.null(fst)) NA_real_ else unname(fst[2]),
      dfResid = if (is.null(fst)) NA_real_ else unname(fst[3]),
      fstat = if (is.null(fst)) NA_real_ else unname(fst[1]),
      fdf1  = if (is.null(fst)) NA_real_ else unname(fst[2]),
      fdf2  = if (is.null(fst)) NA_real_ else unname(fst[3]),
      fp    = if (is.null(fst)) NA_real_ else unname(pf(fst[1], fst[2], fst[3], lower.tail = FALSE)),
      n     = n,
      swW = unname(sw$statistic), swP = sw$p.value, dw = dw,
      nInf = sum(cook > thr, na.rm = TRUE), maxCook = max(cook, na.rm = TRUE), thr = thr,
      fitted = unname(fitv), resid = unname(res),
      qqx = unname(qq$x), qqy = unname(qq$y), qqSlope = qqSlope, qqInt = qqInt
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const m = normalizeResult(result);

  await app.results.appendTable(
    {
      columns: ['R', 'R Square', 'Adj. R Square', 'Std. Error of the Estimate', 'N'],
      rows: [
        [
          f(Math.sqrt(Math.max(0, m.r2)), 3), f(m.r2, 3), f(m.adjr2, 3),
          f(m.sigma, 3), f(m.n, 0),
        ],
      ],
    },
    { caption: `Model Summary — dependent: ${labelOf(meta.get(dvName), dvName)}` },
  );

  // SPSS splits what used to be one row in two: Model Summary describes the fit, and a
  // separate ANOVA table tests it and shows the partition the F comes from. The F was
  // always here — it was in the summary row with no sums of squares beside it, which is
  // the one part of a regression a methods course reads aloud.
  const ssTotal = m.ssReg + m.ssRes;
  await app.results.appendTable(
    {
      columns: ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
      rows: [
        ['Regression', f(m.ssReg, 3), f(m.dfReg, 0), f(m.ssReg / m.dfReg, 3), f(m.fstat, 3), fmtP(m.fp)],
        ['Residual', f(m.ssRes, 3), f(m.dfResid, 0), f(m.ssRes / m.dfResid, 3), '', ''],
        ['Total', f(ssTotal, 3), f(m.dfReg + m.dfResid, 0), '', '', ''],
      ],
      rowHeaders: true,
    },
    { caption: `ANOVA — dependent: ${labelOf(meta.get(dvName), dvName)}` },
  );

  const vifByTerm = {};
  m.vifNames.forEach((nm, i) => (vifByTerm[nm] = m.vif[i]));
  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't', 'Sig.', '95% CI', 'VIF'],
      rows: m.terms.map((t, i) => [
        t === '(Intercept)' ? '(Constant)' : prettyTerm(t),
        f(m.estimate[i], 3), f(m.se[i], 3), f(m.t[i], 3), fmtP(m.p[i]),
        ci(m.ciLo[i], m.ciHi[i]),
        t === '(Intercept)' ? '' : Number.isFinite(vifByTerm[t]) ? f(vifByTerm[t], 2) : '—',
      ]),
      rowHeaders: true,
    },
    { caption: 'Coefficients' },
  );

  // Diagnostics: do the model's assumptions hold?
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Residual normality — Shapiro–Wilk W', f(m.swW, 3)],
        ['Residual normality — Sig.', fmtP(m.swP)],
        ['Independence — Durbin–Watson', f(m.dw, 3)],
        ['Influential cases (Cook’s D > 4/n)', f(m.nInf, 0)],
        ['Max Cook’s distance', f(m.maxCook, 3)],
      ],
      rowHeaders: true,
    },
    { caption: 'Residual Diagnostics' },
  );
  await app.results.appendText(
    'Residuals should scatter randomly around 0 (constant variance, linearity) and track the diagonal on the Q–Q plot (normality). Durbin–Watson near 2 suggests independent residuals (1.5–2.5 is fine); VIF above ~5–10 flags multicollinearity.',
  );
  // Both diagnostics are scatter plots with a straight guide line, so they are chart MODELS
  // the host renders — not SVG this plugin bakes. The guide is a `reference`, not a `trend`:
  // it states what the plot means (zero residual; the normal line) rather than reporting a
  // finding, so it is on by default and carries no equation.
  if (m.fitted.length && m.fitted.length === m.resid.length) {
    await app.results.appendChart({
      kind: 'scatter',
      title: 'Residuals vs Fitted',
      axes: { x: { title: 'Fitted values' }, y: { title: 'Residuals' } },
      points: m.fitted.map((x, i) => ({ x, y: m.resid[i] })),
      reference: { slope: 0, intercept: 0, label: 'Zero line' },
    });
  }
  if (m.qqx.length && m.qqx.length === m.qqy.length) {
    await app.results.appendChart({
      kind: 'scatter',
      title: 'Normal Q–Q (residuals)',
      axes: { x: { title: 'Theoretical quantiles' }, y: { title: 'Sample quantiles' } },
      points: m.qqx.map((x, i) => ({ x, y: m.qqy[i] })),
      ...(Number.isFinite(m.qqSlope)
        ? { reference: { slope: m.qqSlope, intercept: m.qqInt, label: 'Normal line' } }
        : {}),
    });
  }
}

// --- helpers -----------------------------------------------------------------

function normalizeResult(rList) {
  const r = unpackR(rList);
  return {
    terms: r.strs('terms'),
    estimate: r.nums('estimate'),
    se: r.nums('se'),
    t: r.nums('t'),
    p: r.nums('p'),
    ciLo: r.nums('ciLo'),
    ciHi: r.nums('ciHi'),
    vifNames: r.strs('vifNames'),
    vif: r.nums('vif'),
    r2: r.num1('r2'),
    adjr2: r.num1('adjr2'),
    fstat: r.num1('fstat'),
    fdf1: r.num1('fdf1'),
    fdf2: r.num1('fdf2'),
    fp: r.num1('fp'),
    // The ANOVA partition and the residual SE. The R has computed these since the
    // ANOVA table shipped (fe4c4f1), but they were never added to this map, so every
    // Sum of Squares / df / Mean Square cell and the Std. Error of the Estimate have
    // rendered as the em dash the whole time. The structure was tested; no test read
    // a VALUE out of those cells, which is how a table of dashes passed.
    ssReg: r.num1('ssReg'),
    ssRes: r.num1('ssRes'),
    dfReg: r.num1('dfReg'),
    dfResid: r.num1('dfResid'),
    sigma: r.num1('sigma'),
    n: r.num1('n'),
    swW: r.num1('swW'),
    swP: r.num1('swP'),
    dw: r.num1('dw'),
    nInf: r.num1('nInf'),
    maxCook: r.num1('maxCook'),
    fitted: r.nums('fitted'),
    resid: r.nums('resid'),
    qqx: r.nums('qqx'),
    qqy: r.nums('qqy'),
    qqSlope: r.num1('qqSlope'),
    qqInt: r.num1('qqInt'),
  };
}
