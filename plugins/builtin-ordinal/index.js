/**
 * @file plugins/builtin-ordinal/index.js
 * Built-in plugin: **ordinal & multinomial logistic regression** — the two
 * workhorse models for categorical outcomes with more than two categories, and a
 * conspicuous gap next to the existing binary Logistic tool.
 *
 *  - **Ordinal logistic (proportional odds)** — `MASS::polr`. For ordered
 *    outcomes (Likert agreement, education bands, self-rated health). Reports
 *    coefficients as **odds ratios** under the proportional-odds assumption,
 *    plus the category thresholds.
 *  - **Multinomial logistic** — `nnet::multinom`. For unordered outcomes (party
 *    chosen, mode of transport, diagnosis). Reports one set of coefficients per
 *    non-reference category as **relative-risk ratios** (exp B).
 *
 * Both report a likelihood-ratio χ² against the null model and McFadden's
 * pseudo-R².
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-ordinal',
  name: 'Ordinal & multinomial',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['ordinal', 'multinomial', 'logistic', 'polr', 'proportional odds', 'multinom', 'likert', 'rrr', 'relative risk ratio', 'categorical outcome'],
  disciplines: ['Sociology', 'Psychology', 'Political Science'],
  rPackages: ['MASS', 'nnet'],
  menu: [
    {
      label: 'Ordinal logistic regression…',
      run: 'ordinal',
      order: 30,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Ordered outcome', multiple: false, unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
      ],
    },
    {
      label: 'Multinomial logistic regression…',
      run: 'multinomial',
      order: 35,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Unordered outcome', multiple: false, unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
      ],
    },
  ],
};

// --- Ordinal logistic (proportional odds) ------------------------------------

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 */
export async function ordinal(app, { dv: dvName, ivs: ivNames }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Ordinal regression: choose an ordered outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['MASS']);
  const meta = metaMap(await app.data.getVariableMeta());
  const dvMeta = meta.get(dvName);
  const recodes = [recodeLine('dv', dvMeta), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.y ~ ${ivNames.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages(library(MASS))
    ${recodes}
    .y <- factor(dv, levels = sort(unique(dv[!is.na(dv)])), ordered = TRUE)
    if (nlevels(.y) < 3) stop("ordinal regression needs at least 3 ordered categories (use binary Logistic for 2)")
    d <- ivs; d[[".y"]] <- .y; d <- d[stats::complete.cases(d), , drop = FALSE]; d <- droplevels(d)
    fit <- polr(as.formula(${rStr(formula)}), data = d, Hess = TRUE)
    fit0 <- polr(.y ~ 1, data = d, Hess = TRUE)
    s <- summary(fit); ct_ <- s$coefficients
    isThr <- grepl("\\\\|", rownames(ct_))
    co <- ct_[!isThr, , drop = FALSE]; thr <- ct_[isThr, , drop = FALSE]
    ll1 <- logLik(fit); ll0 <- logLik(fit0)
    lr <- as.numeric(2 * (ll1 - ll0)); lrdf <- attr(ll1, "df") - attr(ll0, "df")
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3],
         thrNames = rownames(thr), thrEst = thr[, 1], thrSe = thr[, 2],
         lr = lr, lrdf = lrdf, lrp = pchisq(lr, lrdf, lower.tail = FALSE),
         mcfadden = as.numeric(1 - ll1 / ll0), aic = AIC(fit), n = nrow(d))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), t = r.nums('t');
  const p = t.map((v) => 2 * normSf(Math.abs(v)));

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['LR χ² (df)', `${f(r.num('lr'), 2)} (${f(r.num('lrdf'), 0)})`],
        ['p (model)', fmtP(r.num('lrp'))],
        ["McFadden's R²", f(r.num('mcfadden'), 3)],
        ['AIC', f(r.num('aic'), 1)],
      ],
      rowHeaders: true,
    },
    { caption: `Ordinal Logistic (Proportional Odds) — outcome: ${labelOf(dvMeta, dvName)} (N = ${r.num('n')})` },
  );

  await app.results.appendTable(
    {
      columns: ['', 'B (log-odds)', 'Std. Error', 'z', 'Sig.', 'OR (exp B)', '95% CI (OR)'],
      rows: terms.map((tm, i) => [
        prettyTerm(tm), f(est[i], 3), f(se[i], 3), f(t[i], 3), fmtP(p[i]),
        f(Math.exp(est[i]), 3), ci(Math.exp(est[i] - 1.96 * se[i]), Math.exp(est[i] + 1.96 * se[i])),
      ]),
      rowHeaders: true,
    },
    { caption: 'Coefficients' },
  );

  const thrNames = r.strs('thrNames'), thrEst = r.nums('thrEst'), thrSe = r.nums('thrSe');
  await app.results.appendTable(
    {
      columns: ['Threshold', 'Estimate', 'Std. Error'],
      rows: thrNames.map((tn, i) => [prettyThreshold(tn, dvMeta), f(thrEst[i], 3), f(thrSe[i], 3)]),
      rowHeaders: true,
    },
    { caption: 'Category Thresholds (cutpoints)' },
  );
  await app.results.appendText(
    'Odds ratios are **proportional**: each predictor has the same effect on the odds of being in a higher category across all cutpoints (the proportional-odds assumption). An OR > 1 means higher values shift the outcome toward higher categories. If the assumption is implausible, consider multinomial logistic instead.',
  );
}

// --- Multinomial logistic ----------------------------------------------------

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 */
export async function multinomial(app, { dv: dvName, ivs: ivNames }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Multinomial regression: choose an outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['nnet']);
  const meta = metaMap(await app.data.getVariableMeta());
  const dvMeta = meta.get(dvName);
  const recodes = [recodeLine('dv', dvMeta), ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.y ~ ${ivNames.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages(library(nnet))
    ${recodes}
    .y <- factor(dv, levels = sort(unique(dv[!is.na(dv)])))
    if (nlevels(.y) < 3) stop("multinomial needs at least 3 outcome categories (use binary Logistic for 2)")
    d <- ivs; d[[".y"]] <- .y; d <- d[stats::complete.cases(d), , drop = FALSE]; d <- droplevels(d)
    fit <- multinom(as.formula(${rStr(formula)}), data = d, trace = FALSE)
    fit0 <- multinom(.y ~ 1, data = d, trace = FALSE)
    s <- summary(fit)
    B <- s$coefficients; SE <- s$standard.errors
    if (is.null(dim(B))) { B <- t(as.matrix(B)); SE <- t(as.matrix(SE)); rownames(B) <- levels(.y)[2]; rownames(SE) <- levels(.y)[2] }
    ll1 <- logLik(fit); ll0 <- logLik(fit0)
    lr <- as.numeric(2 * (ll1 - ll0)); lrdf <- attr(ll1, "df") - attr(ll0, "df")
    list(reference = levels(.y)[1], classes = rownames(B), coefTerms = colnames(B),
         B = as.numeric(t(B)), SE = as.numeric(t(SE)),
         lr = lr, lrdf = lrdf, lrp = pchisq(lr, lrdf, lower.tail = FALSE),
         mcfadden = as.numeric(1 - ll1 / ll0), aic = AIC(fit), n = nrow(d))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const reference = r.strs('reference')[0];
  const classes = r.strs('classes'), coefTerms = r.strs('coefTerms');
  const B = r.nums('B'), SE = r.nums('SE');
  const nT = coefTerms.length;

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['LR χ² (df)', `${f(r.num('lr'), 2)} (${f(r.num('lrdf'), 0)})`],
        ['p (model)', fmtP(r.num('lrp'))],
        ["McFadden's R²", f(r.num('mcfadden'), 3)],
        ['AIC', f(r.num('aic'), 1)],
      ],
      rowHeaders: true,
    },
    { caption: `Multinomial Logistic — outcome: ${labelOf(dvMeta, dvName)}, reference = ${lvl(dvMeta, reference)} (N = ${r.num('n')})` },
  );

  classes.forEach((cls, ci_) => {
    const rows = coefTerms.map((tm, j) => {
      const b = B[ci_ * nT + j], s = SE[ci_ * nT + j], z = b / s, pv = 2 * normSf(Math.abs(z));
      return [
        tm === '(Intercept)' ? '(Constant)' : prettyTerm(tm), f(b, 3), f(s, 3), f(z, 3), fmtP(pv),
        f(Math.exp(b), 3), ci(Math.exp(b - 1.96 * s), Math.exp(b + 1.96 * s)),
      ];
    });
    app.results.appendTable(
      {
        columns: ['', 'B (log-odds)', 'Std. Error', 'z', 'Sig.', 'RRR (exp B)', '95% CI (RRR)'],
        rows,
        rowHeaders: true,
      },
      { caption: `Outcome: ${lvl(dvMeta, cls)} (vs ${lvl(dvMeta, reference)})` },
    );
  });
  await app.results.appendText(
    `Each block contrasts one outcome category against the reference (**${lvl(dvMeta, reference)}**). **RRR** (relative-risk ratio, exp B) > 1 means the predictor raises the chance of that category relative to the reference. Coefficients are not comparable across blocks the way ordinal ORs are.`,
  );
}

// --- helpers -----------------------------------------------------------------

function lvl(meta, code) {
  return meta?.valueLabels?.[code] ?? code;
}

function prettyThreshold(name, dvMeta) {
  const parts = String(name).split('|');
  return parts.length === 2 ? `${lvl(dvMeta, parts[0])} | ${lvl(dvMeta, parts[1])}` : name;
}

function normSf(z) {
  // upper-tail standard normal survival function via erfc approximation
  return 0.5 * erfc(z / Math.SQRT2);
}

function erfc(x) {
  // Numerical Recipes erfc, ~1e-7 accuracy — adequate for p-values.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
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
