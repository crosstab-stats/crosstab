/**
 * @file plugins/builtin-causal/index.js
 * Built-in plugin: **causal inference designs** — the quasi-experimental toolkit
 * that program evaluation, public policy and applied micro lean on to estimate
 * effects from observational data:
 *
 *  - **Difference-in-differences (DiD)** — the treat×post interaction in an OLS
 *    model (ATT under the parallel-trends assumption), with heteroskedasticity-
 *    robust (HC1) standard errors.
 *  - **Regression discontinuity (RDD)** — local-polynomial estimation at a cutoff
 *    via `rdrobust` (the reference implementation: data-driven bandwidth,
 *    triangular kernel, bias-corrected robust inference).
 *  - **Matching** — nearest-neighbour / propensity-score matching via `MatchIt`,
 *    with the ATT estimated on the matched sample (HC1 SE) and a covariate-balance
 *    table (standardized mean differences before vs after).
 *
 * All three use the canonical R packages directly — no hand-rolled estimators.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-causal',
  name: 'Causal inference',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['causal', 'difference-in-differences', 'did', 'regression discontinuity', 'rdd', 'matching', 'propensity score', 'matchit', 'rdrobust', 'att', 'treatment effect', 'quasi-experimental'],
  rPackages: ['sandwich', 'lmtest', 'MatchIt', 'rdrobust'],
  menu: [
    {
      label: 'Difference-in-differences…',
      run: 'did',
      order: 70,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'treat', kind: 'variables', label: 'Treatment group (1 = treated)', multiple: false, unique: true },
        { name: 'post', kind: 'variables', label: 'Post period (1 = after)', multiple: false, unique: true },
        { name: 'covs', kind: 'variables', label: 'Covariates (optional)', multiple: true, optional: true, unique: true },
      ],
    },
    {
      label: 'Regression discontinuity…',
      run: 'rdd',
      order: 80,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'run', kind: 'variables', label: 'Running / forcing variable', multiple: false, types: ['numeric'], unique: true },
        { name: 'cutoff', kind: 'number', label: 'Cutoff', default: 0 },
        { name: 'bw', kind: 'number', label: 'Bandwidth (blank/0 = automatic)', default: 0, optional: true },
      ],
    },
    {
      label: 'Matching (propensity / nearest neighbour)…',
      run: 'matching',
      order: 90,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'treat', kind: 'variables', label: 'Treatment (1 = treated)', multiple: false, unique: true },
        { name: 'covs', kind: 'variables', label: 'Covariates to balance on', multiple: true, unique: true },
        { name: 'distance', kind: 'choice', label: 'Distance', default: 'glm', options: [
          { value: 'glm', label: 'Propensity score (logistic)' },
          { value: 'mahalanobis', label: 'Mahalanobis distance' },
        ] },
      ],
    },
  ],
};

// --- Difference-in-differences ----------------------------------------------

export async function did(app, { y: yName, treat: treatName, post: postName, covs: covNames }) {
  if (!yName || !treatName || !postName) {
    await app.results.appendError('DiD: choose an outcome, a treatment-group indicator, and a post-period indicator.');
    return;
  }
  await app.webr.installPackages(['sandwich', 'lmtest']);
  const meta = metaMap(await app.data.getVariableMeta());
  const covs = covNames || [];
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('treat', meta.get(treatName)), recodeLine('post', meta.get(postName)),
    ...covs.map((n) => recodeLine(`covs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const covPart = covs.length ? ' + ' + covs.map(term).join(' + ') : '';
  const rCode = `
    suppressMessages({library(sandwich); library(lmtest)})
    ${recodes}
    .t <- bin01(treat); .p <- bin01(post)
    d <- data.frame(.y = as.numeric(y), .t = .t, .p = .p)
    ${covs.length ? 'd <- cbind(d, covs)' : ''}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- lm(as.formula(paste0(".y ~ .t*.p", ${rStr(covPart)})), data = d)
    ctab <- coeftest(fit, vcov = vcovHC(fit, type = "HC1"))
    rn <- rownames(ctab)
    list(terms = rn, est = ctab[, 1], se = ctab[, 2], t = ctab[, 3], p = ctab[, 4],
         n = nrow(d), iIdx = which(rn == ".t:.p"))`;
  const r = flat(await runR(app, rCode, [bin01R(), ].join('\n')));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('t'), p = r.nums('p');
  const iIdx = r.num('iIdx') - 1;

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Robust SE', 't', 'Sig.', '95% CI'],
      rows: terms.map((t, i) => [didLabel(t, treatName, postName, meta), f(est[i], 3), f(se[i], 3), f(tv[i], 2), fmtP(p[i]), ci(est[i] - 1.96 * se[i], est[i] + 1.96 * se[i])]),
      rowHeaders: true,
    },
    { caption: `Difference-in-Differences — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')})` },
  );
  if (Number.isFinite(iIdx) && iIdx >= 0) {
    await app.results.appendText(
      `**DiD estimate (ATT) = ${f(est[iIdx], 3)}** (robust SE ${f(se[iIdx], 3)}, ${fmtPInline(p[iIdx])}) — the treatment×post interaction. ` +
        'Valid under **parallel trends**: absent treatment, the two groups would have moved in parallel. Standard errors are heteroskedasticity-robust (HC1).',
    );
  }
}

// --- Regression discontinuity (rdrobust) ------------------------------------

export async function rdd(app, { y: yName, run: runName, cutoff, bw }) {
  if (!yName || !runName) {
    await app.results.appendError('RDD: choose an outcome and a running variable.');
    return;
  }
  await app.webr.installPackages(['rdrobust']);
  const meta = metaMap(await app.data.getVariableMeta());
  const c0 = Number.isFinite(cutoff) ? cutoff : 0;
  const hArg = Number.isFinite(bw) && bw > 0 ? `, h = ${bw}` : '';
  const recodes = [recodeLine('y', meta.get(yName)), recodeLine('run', meta.get(runName))].filter(Boolean).join('\n');
  const rCode = `
    suppressMessages(library(rdrobust))
    ${recodes}
    yy <- as.numeric(y); xx <- as.numeric(run)
    ok <- is.finite(yy) & is.finite(xx); yy <- yy[ok]; xx <- xx[ok]
    rd <- rdrobust(yy, xx, c = ${c0}${hArg})
    list(labels = rownames(rd$coef), coef = rd$coef[, 1], se = rd$se[, 1], z = rd$z[, 1], p = rd$pv[, 1],
         ciL = rd$ci[, 1], ciU = rd$ci[, 2], h = rd$bws[1, 1], nLeft = rd$N_h[1], nRight = rd$N_h[2],
         order = rd$p, kernel = rd$kernel)`;
  const r = flat(await runR(app, rCode));
  const labels = r.strs('labels'), coef = r.nums('coef'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p'), ciL = r.nums('ciL'), ciU = r.nums('ciU');

  await app.results.appendTable(
    {
      columns: ['Estimator', 'RD effect', 'Std. Error', 'z', 'Sig.', '95% CI'],
      rows: labels.map((lab, i) => [lab, f(coef[i], 4), f(se[i], 4), f(z[i], 2), fmtP(p[i]), ci(ciL[i], ciU[i])]),
      rowHeaders: true,
    },
    { caption: `Regression Discontinuity — outcome: ${labelOf(meta.get(yName), yName)} at cutoff ${c0}` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Bandwidth (h)', f(r.num('h'), 4)],
        ['Effective N (left / right of cutoff)', `${r.num('nLeft')} / ${r.num('nRight')}`],
        ['Polynomial order', f(r.num('order'), 0)],
        ['Kernel', r.str1('kernel')],
      ],
      rowHeaders: true,
    },
    { caption: 'Specification' },
  );
  await app.results.appendText(
    'The RD effect is the jump in the outcome at the cutoff — a **local** effect for cases near the threshold. Prefer the **Robust** row for inference (bias-corrected, `rdrobust`). It assumes units cannot precisely manipulate the running variable around the cutoff.',
  );
}

// --- Matching (MatchIt) ------------------------------------------------------

export async function matching(app, { y: yName, treat: treatName, covs: covNames, distance }) {
  if (!yName || !treatName || !covNames || !covNames.length) {
    await app.results.appendError('Matching: choose an outcome, a treatment indicator, and at least one covariate.');
    return;
  }
  await app.webr.installPackages(['MatchIt', 'sandwich', 'lmtest']);
  const meta = metaMap(await app.data.getVariableMeta());
  const dist = distance === 'mahalanobis' ? 'mahalanobis' : 'glm';
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('treat', meta.get(treatName)),
    ...covNames.map((n) => recodeLine(`covs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.t ~ ${covNames.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages({library(MatchIt); library(sandwich); library(lmtest)})
    ${recodes}
    .t <- bin01(treat)
    d <- data.frame(.y = as.numeric(y), .t = .t)
    d <- cbind(d, covs)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    mo <- matchit(as.formula(${rStr(formula)}), data = d, method = "nearest", distance = ${rStr(dist)})
    md <- match.data(mo)
    fit <- lm(.y ~ .t, data = md, weights = md$weights)
    ctab <- coeftest(fit, vcov = vcovHC(fit, type = "HC1"))
    s <- summary(mo)
    ball <- s$sum.all; bmat <- s$sum.matched
    smdCol <- "Std. Mean Diff."
    list(att = ctab[".t", 1], se = ctab[".t", 2], t = ctab[".t", 3], p = ctab[".t", 4],
         nTreatAll = sum(d$.t == 1), nCtrlAll = sum(d$.t == 0), nMatched = nrow(md),
         covNames = rownames(ball), smdBefore = ball[, smdCol], smdAfter = bmat[, smdCol])`;
  const r = flat(await runR(app, rCode, bin01R()));

  await app.results.appendTable(
    {
      columns: ['', 'Estimate', 'Robust SE', 't', 'Sig.', '95% CI'],
      rows: [['ATT (treated − matched control)', f(r.num('att'), 3), f(r.num('se'), 3), f(r.num('t'), 2), fmtP(r.num('p')), ci(r.num('att') - 1.96 * r.num('se'), r.num('att') + 1.96 * r.num('se'))]],
      rowHeaders: true,
    },
    { caption: `Matching — ATT on ${labelOf(meta.get(yName), yName)} (${r.num('nTreatAll')} treated, ${r.num('nMatched')} in matched sample)` },
  );

  const cn = r.strs('covNames'), sb = r.nums('smdBefore'), sa = r.nums('smdAfter');
  await app.results.appendTable(
    {
      columns: ['Covariate', 'Std. mean diff. (before)', 'Std. mean diff. (after)'],
      rows: cn.map((c, i) => [c === 'distance' ? 'Propensity score' : prettyTerm(c), f(Math.abs(sb[i]), 3), f(Math.abs(sa[i]), 3)]),
      rowHeaders: true,
    },
    { caption: 'Covariate Balance (|standardized mean difference|)' },
  );
  await app.results.appendText(
    'Matching estimates the **ATT** by pairing each treated case with a similar control. Good balance = standardized mean differences **after** matching well below 0.1; if some remain large, the estimate may still be confounded. Matching only adjusts for the covariates you supply (no hidden confounders).',
  );
}

// --- helpers -----------------------------------------------------------------

/** R helper: coerce a vector to 0/1 (two distinct values → low=0, high=1). */
function bin01R() {
  return `bin01 <- function(v){ v <- suppressWarnings(as.numeric(v)); u <- sort(unique(v[is.finite(v)]))
    if (length(u) != 2) stop("indicator must have exactly two values (e.g. 0/1)"); as.integer(v == u[2]) }`;
}

async function runR(app, rCode, prelude) {
  const code = prelude ? `${prelude}\n${rCode}` : rCode;
  const { result } = await app.webr.run(code);
  if (!result) throw new Error('R returned no result');
  return result;
}

function didLabel(term, treatName, postName, meta) {
  const tl = labelOf(meta.get(treatName), treatName), pl = labelOf(meta.get(postName), postName);
  const map = { '(Intercept)': '(Constant)', '.t': tl, '.p': pl, '.t:.p': `${tl} × ${pl} (DiD)` };
  return map[term] || prettyTerm(term);
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

function fmtPInline(p) {
  if (!Number.isFinite(p)) return 'p = —';
  return p < 0.001 ? 'p < .001' : `p = ${p.toFixed(3)}`;
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
