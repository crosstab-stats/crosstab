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
    'You get an SPSS-style Model Summary + Coefficients (with VIF) and residual diagnostic plots.\n' +
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
      r2 = s$r.squared, adjr2 = s$adj.r.squared,
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
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');

  await app.results.appendTable(
    {
      columns: ['R', 'R Square', 'Adj. R Square', 'F', 'df1', 'df2', 'Sig.', 'N'],
      rows: [
        [
          f(Math.sqrt(Math.max(0, m.r2)), 3), f(m.r2, 3), f(m.adjr2, 3),
          f(m.fstat, 3), f(m.fdf1, 0), f(m.fdf2, 0), fmtP(m.fp), f(m.n, 0),
        ],
      ],
    },
    { caption: `Model Summary — dependent: ${labelOf(meta.get(dvName), dvName)}` },
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
      xTitle: 'Fitted values',
      yTitle: 'Residuals',
      points: m.fitted.map((x, i) => ({ x, y: m.resid[i] })),
      reference: { slope: 0, intercept: 0, label: 'Zero line' },
    });
  }
  if (m.qqx.length && m.qqx.length === m.qqy.length) {
    await app.results.appendChart({
      kind: 'scatter',
      title: 'Normal Q–Q (residuals)',
      xTitle: 'Theoretical quantiles',
      yTitle: 'Sample quantiles',
      points: m.qqx.map((x, i) => ({ x, y: m.qqy[i] })),
      ...(Number.isFinite(m.qqSlope)
        ? { reference: { slope: m.qqSlope, intercept: m.qqInt, label: 'Normal line' } }
        : {}),
    });
  }
}

// --- helpers -----------------------------------------------------------------

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function prettyTerm(term) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(term);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : term.replace(/`/g, '');
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

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
    const first = a.length ? a[0] : v;
    return first == null ? NaN : Number(first);
  };
  return {
    terms: arr(byName.terms).map(String),
    estimate: arr(byName.estimate).map(Number),
    se: arr(byName.se).map(Number),
    t: arr(byName.t).map(Number),
    p: arr(byName.p).map(Number),
    ciLo: arr(byName.ciLo).map(Number),
    ciHi: arr(byName.ciHi).map(Number),
    vifNames: arr(byName.vifNames).map(String),
    vif: arr(byName.vif).map(Number),
    r2: scalar(byName.r2),
    adjr2: scalar(byName.adjr2),
    fstat: scalar(byName.fstat),
    fdf1: scalar(byName.fdf1),
    fdf2: scalar(byName.fdf2),
    fp: scalar(byName.fp),
    n: scalar(byName.n),
    swW: scalar(byName.swW),
    swP: scalar(byName.swP),
    dw: scalar(byName.dw),
    nInf: scalar(byName.nInf),
    maxCook: scalar(byName.maxCook),
    fitted: arr(byName.fitted).map(Number),
    resid: arr(byName.resid).map(Number),
    qqx: arr(byName.qqx).map(Number),
    qqy: arr(byName.qqy).map(Number),
    qqSlope: scalar(byName.qqSlope),
    qqInt: scalar(byName.qqInt),
  };
}

/** Format a 95% CI like "[lo, hi]". */
function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—';
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
