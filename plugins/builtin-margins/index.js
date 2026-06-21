/**
 * @file plugins/builtin-margins/index.js
 * Built-in plugin: **Marginal effects** (AME / MEM) for GLMs.
 *
 * Regression coefficients for logistic, probit and Poisson models live on a
 * transformed scale (log-odds, z, log-counts) that few readers can interpret
 * directly. Marginal effects translate them back to the natural metric — the
 * change in the predicted **probability** (or expected count / value) for a
 * one-unit change in a predictor — which is what social scientists actually
 * report and compare across models.
 *
 *  - **Average marginal effect (AME)** — the per-case marginal effect averaged
 *    over the whole sample (the modern default).
 *  - **Marginal effect at the mean (MEM)** — the marginal effect for one
 *    "typical" case (numeric predictors at their mean, categorical at the modal
 *    category).
 *
 * Implementation is **base R only** (no `marginaleffects`/`margins` dependency,
 * which rely on hard-to-compile C/C++ in WebR): predicted responses are
 * numerically differentiated (continuous predictors) or differenced from the
 * reference category (factors), and standard errors come from the **delta
 * method** using the model's variance–covariance matrix. Verified against the
 * closed-form logistic AME (β·mean[p(1−p)]) to 8 decimals.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-margins',
  name: 'Marginal effects',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['marginal effects', 'ame', 'mem', 'average marginal effect', 'dydx', 'probability', 'logit', 'probit', 'poisson', 'glm'],
  rPackages: [],
  menu: [
    {
      label: 'Marginal effects (AME / MEM)…',
      run: 'margins',
      order: 60,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
        {
          name: 'family',
          kind: 'choice',
          label: 'Model',
          default: 'logistic',
          options: [
            { value: 'logistic', label: 'Logistic — binary outcome (probability)' },
            { value: 'probit', label: 'Probit — binary outcome (probability)' },
            { value: 'poisson', label: 'Poisson — count outcome (expected count)' },
            { value: 'linear', label: 'Linear (OLS) — continuous outcome' },
          ],
        },
        {
          name: 'kind',
          kind: 'choice',
          label: 'Effect type',
          default: 'ame',
          options: [
            { value: 'ame', label: 'Average marginal effect (AME) — recommended' },
            { value: 'mem', label: 'Marginal effect at the mean (MEM)' },
          ],
        },
      ],
    },
  ],
};

const FAMILIES = {
  logistic: { call: 'binomial(link = "logit")', label: 'Logistic', metric: 'probability' },
  probit: { call: 'binomial(link = "probit")', label: 'Probit', metric: 'probability' },
  poisson: { call: 'poisson(link = "log")', label: 'Poisson', metric: 'expected count' },
  linear: { call: 'gaussian()', label: 'Linear (OLS)', metric: 'predicted value' },
};

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[], family: string, kind: string}} inputs
 */
export async function margins(app, { dv: dvName, ivs: ivNames, family, kind }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Marginal effects: choose an outcome and at least one predictor.');
    return;
  }
  const fam = FAMILIES[family] || FAMILIES.logistic;
  const atmeans = kind === 'mem';
  const meta = metaMap(await app.data.getVariableMeta());

  const recodes = [
    recodeLine('dv', meta.get(dvName)),
    ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const factorConv = ivNames
    .filter((n) => meta.get(n)?.type === 'factor')
    .map((n) => factorLine(n, meta.get(n)))
    .join('\n');
  const formula = `.dv ~ ${ivNames.map((n) => '`' + n + '`').join(' + ')}`;
  const dvCode =
    family === 'poisson'
      ? 'dv <- as.numeric(dv); if (any(dv[is.finite(dv)] < 0, na.rm = TRUE)) stop("Poisson outcome must be non-negative")'
      : family === 'linear'
        ? 'dv <- as.numeric(dv)'
        : 'dv <- as.numeric(dv); .u <- sort(unique(dv[is.finite(dv)])); if (length(.u) != 2) stop("Logistic/probit need a binary (two-value) outcome"); dv <- as.integer(dv == .u[2])';

  const rCode = `
    ame_glm <- function(fit, atmeans = FALSE) {
      tt <- delete.response(terms(fit)); b <- coef(fit); V <- vcov(fit); linkinv <- fit$family$linkinv
      mf <- model.frame(fit); resp <- names(mf)[attr(terms(mf), "response")]
      vars <- setdiff(names(mf), resp)
      base <- mf
      if (isTRUE(atmeans)) {
        one <- mf[1, , drop = FALSE]
        for (nm in vars) { x <- mf[[nm]]
          if (is.numeric(x)) one[[nm]] <- mean(x, na.rm = TRUE)
          else { tb <- table(x); one[[nm]] <- factor(names(tb)[which.max(tb)], levels = levels(x)) } }
        base <- one
      }
      pred <- function(beta, dd) { X <- model.matrix(tt, dd); as.numeric(linkinv(X %*% beta)) }
      grad <- function(fun) { g <- numeric(length(b)); eps <- 1e-6
        for (j in seq_along(b)) { bp <- b; bm <- b; bp[j] <- bp[j] + eps; bm[j] <- bm[j] - eps; g[j] <- (fun(bp) - fun(bm)) / (2 * eps) }; g }
      labs <- c(); est <- c(); se <- c()
      for (v in vars) { x <- mf[[v]]
        if (is.numeric(x)) {
          h <- diff(range(x, na.rm = TRUE)) * 1e-4; if (!is.finite(h) || h == 0) h <- 1e-4
          dp <- base; dp[[v]] <- base[[v]] + h; dm <- base; dm[[v]] <- base[[v]] - h
          fun <- function(beta) mean((pred(beta, dp) - pred(beta, dm)) / (2 * h))
          gg <- grad(fun); labs <- c(labs, v); est <- c(est, fun(b)); se <- c(se, sqrt(as.numeric(t(gg) %*% V %*% gg)))
        } else {
          lv <- levels(x); ref <- lv[1]
          for (L in lv[-1]) {
            dr <- base; dr[[v]] <- factor(ref, levels = lv); dl <- base; dl[[v]] <- factor(L, levels = lv)
            fun <- function(beta) mean(pred(beta, dl) - pred(beta, dr))
            gg <- grad(fun); labs <- c(labs, paste(v, L, ref, sep = "@@")); est <- c(est, fun(b)); se <- c(se, sqrt(as.numeric(t(gg) %*% V %*% gg)))
          }
        }
      }
      z <- est / se; p <- 2 * pnorm(-abs(z))
      list(term = labs, est = est, se = se, z = z, p = p, lo = est - 1.96 * se, hi = est + 1.96 * se, n = nrow(mf))
    }

    ${recodes}
    ${dvCode}
    d <- cbind(.dv = dv, ivs)
    ${factorConv}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    d <- droplevels(d)
    if (nrow(d) < 3) stop("need at least 3 complete cases")
    fit <- glm(as.formula(${rStr(formula)}), data = d, family = ${fam.call})
    res <- ame_glm(fit, atmeans = ${atmeans ? 'TRUE' : 'FALSE'})
    res`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('term'), est = r.nums('est'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi');

  await app.results.appendTable(
    {
      columns: ['Predictor', 'dy/dx', 'Std. Error', 'z', 'Sig.', '95% CI'],
      rows: terms.map((t, i) => [prettyMargin(t, meta), f(est[i], 4), f(se[i], 4), f(z[i], 2), fmtP(p[i]), ci(lo[i], hi[i])]),
      rowHeaders: true,
    },
    {
      caption: `${atmeans ? 'Marginal Effects at the Mean' : 'Average Marginal Effects'} — ${fam.label}, outcome: ${labelOf(meta.get(dvName), dvName)} (N = ${r.num('n')})`,
    },
  );

  const dxWord = fam.metric === 'probability' ? 'probability' : fam.metric === 'expected count' ? 'expected count' : 'predicted value';
  await app.results.appendText(
    `**dy/dx** is the change in the predicted ${dxWord} for a one-unit increase in a continuous predictor; for categorical predictors it is the **discrete change** from the reference category (shown as "level vs reference"). ` +
      (atmeans
        ? 'MEM evaluates the effect for one typical case — numeric predictors held at their means, categorical at the modal category.'
        : 'AME averages each case\'s marginal effect over the whole sample (the recommended default).') +
      ' Standard errors are delta-method (model variance–covariance).',
  );
}

// --- helpers -----------------------------------------------------------------

function factorLine(name, m) {
  const vl = m?.valueLabels || {};
  const codes = Object.keys(vl);
  if (codes.length) {
    const lv = codes.map((c) => (Number.isFinite(Number(c)) ? Number(c) : rStr(c))).join(', ');
    const labs = codes.map((c) => rStr(vl[c])).join(', ');
    return `d[[${rStr(name)}]] <- factor(d[[${rStr(name)}]], levels = c(${lv}), labels = c(${labs}))`;
  }
  return `d[[${rStr(name)}]] <- factor(d[[${rStr(name)}]])`;
}

function prettyMargin(term, meta) {
  const m = /^(.*)@@(.*)@@(.*)$/.exec(term);
  if (m) return `${labelOf(meta.get(m[1]), m[1])}: ${m[2]} vs ${m[3]}`;
  return labelOf(meta.get(term), term);
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

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function ci(lo, hi) {
  return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(4)}, ${hi.toFixed(4)}]` : '—';
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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
