/**
 * @file plugins/builtin-mixedanova/index.js
 * Built-in plugin: **ANCOVA and repeated-measures / mixed ANOVA** — the
 * experimental-design ANOVA variants the existing one-way/factorial ANOVA tool
 * doesn't cover.
 *
 *  - **ANCOVA** — factorial ANOVA adjusting for one or more continuous
 *    covariates. Type III sums of squares (car::Anova with sum-to-zero
 *    contrasts), partial η², and covariate-adjusted (estimated marginal) means
 *    via emmeans.
 *  - **Repeated-measures / mixed ANOVA** — a within-subjects factor (entered as
 *    several measurement columns, wide format) optionally crossed with a
 *    between-subjects factor (afex::aov_ez). Greenhouse–Geisser sphericity
 *    correction and generalized η² are applied automatically.
 *
 * Uses car / emmeans / afex directly.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-mixedanova',
  name: 'ANCOVA & repeated measures',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Compare Means',
  keywords: ['ancova', 'ancova', 'repeated measures', 'mixed anova', 'within subjects', 'sphericity', 'covariate', 'aov', 'afex', 'emmeans', 'type iii'],
  disciplines: ['Psychology', 'Education', 'Gerontology'],
  howto:
    'GUI: Compare Means ▸ ANCOVA… or Repeated-measures / mixed ANOVA…, then pick the roles. ' +
    'ANCOVA gives Type III effects, partial η², and adjusted means; repeated-measures gives the within-subjects ANOVA with sphericity correction.\n' +
    'Syntax: run builtin-mixedanova.ancova {"y": "score", "factors": ["group"], "covs": ["pretest"]}\n' +
    'Syntax: run builtin-mixedanova.mixedAnova {"within": ["time1", "time2", "time3"], "between": "group"}\n' +
    '  • ancova: y — outcome; factors — one or more grouping factors; covs — one or more covariates to adjust for.\n' +
    '  • mixedAnova: within — one column per condition/time (wide format); between — optional between-subjects factor.',
  rPackages: ['car', 'emmeans', 'afex'],
  menu: [
    {
      label: 'ANCOVA…',
      run: 'ancova',
      order: 60,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose group means you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'factors', kind: 'variables', label: 'Factor(s)', hint: 'The grouping variables whose effect on the outcome you test.', multiple: true, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'covs', kind: 'variables', label: 'Covariate(s)', hint: 'Continuous variables to adjust for before testing the factors.', multiple: true, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Repeated-measures / mixed ANOVA…',
      run: 'mixedAnova',
      order: 65,
      inputs: [
        { name: 'within', kind: 'variables', label: 'Repeated measures (one column per condition/time)', hint: 'One column per condition or time point, measured on the same people.', multiple: true, types: ['numeric'], unique: true },
        { name: 'between', kind: 'variables', label: 'Between-subjects factor (optional)', hint: 'A grouping variable to compare across, such as treatment group.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
      ],
    },
  ],
};

// --- ANCOVA ------------------------------------------------------------------

export async function ancova(app, { y: yName, factors: factorNames, covs: covNames }) {
  if (!yName || !factorNames || !factorNames.length || !covNames || !covNames.length) {
    await app.results.appendError('ANCOVA: choose an outcome, at least one factor, and at least one covariate.');
    return;
  }
  await app.webr.installPackages(['car', 'emmeans']);
  const meta = metaMap(await app.data.getVariableMeta());
  const fTok = factorNames.map((_, i) => `F${i + 1}`);
  const cTok = covNames.map((_, i) => `C${i + 1}`);
  const recodes = [
    recodeLine('y', meta.get(yName)),
    ...factorNames.map((n) => recodeLine(`factors[[${rStr(n)}]]`, meta.get(n))),
    ...covNames.map((n) => recodeLine(`covs[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const mk = [
    ...factorNames.map((n, i) => `d$${fTok[i]} <- factor(factors[[${rStr(n)}]])`),
    ...covNames.map((n, i) => `d$${cTok[i]} <- as.numeric(covs[[${rStr(n)}]])`),
  ].join('\n');
  const rhs = `${fTok.join(' * ')} + ${cTok.join(' + ')}`;
  const emmRhs = fTok.join(' * ');
  const rCode = `
    suppressMessages({library(car); library(emmeans)})
    ${recodes}
    d <- data.frame(.y = as.numeric(y))
    ${mk}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    oc <- options(contrasts = c("contr.sum", "contr.poly"))
    fit <- lm(as.formula(paste(".y ~", ${rStr(rhs)})), data = d)
    a3 <- car::Anova(fit, type = 3)
    ssr <- a3["Residuals", "Sum Sq"]
    emm <- as.data.frame(emmeans(fit, as.formula(paste("~", ${rStr(emmRhs)}))))
    options(oc)
    fl <- setdiff(rownames(a3), "(Intercept)")
    petasq <- sapply(fl, function(rn) if (rn == "Residuals") NA_real_ else { ss <- a3[rn, "Sum Sq"]; ss / (ss + ssr) })
    emmCols <- setdiff(names(emm), c("emmean", "SE", "df", "lower.CL", "upper.CL"))
    emmLab <- apply(emm[, emmCols, drop = FALSE], 1, paste, collapse = " , ")
    list(terms = fl, ss = a3[fl, "Sum Sq"], df = a3[fl, "Df"], F = a3[fl, "F value"], p = a3[fl, "Pr(>F)"],
         peta = as.numeric(petasq), emmLab = emmLab, emm = emm$emmean, emmSe = emm$SE,
         emmLo = emm$lower.CL, emmHi = emm$upper.CL, n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), ss = r.nums('ss'), df = r.nums('df'), F = r.nums('F'), p = r.nums('p'), peta = r.nums('peta');

  await app.results.appendTable(
    {
      columns: ['Source', 'Sum Sq', 'df', 'F', 'Sig.', 'Partial η²'],
      rows: terms.map((t, i) => [ancTerm(t, factorNames, covNames, meta), f(ss[i], 3), f(df[i], 0), f(F[i], 3), fmtP(p[i]), Number.isFinite(peta[i]) ? f(peta[i], 3) : '']),
      rowHeaders: true,
    },
    { caption: `ANCOVA (Type III) — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('n')})` },
  );

  const el = r.strs('emmLab'), em = r.nums('emm'), ese = r.nums('emmSe'), elo = r.nums('emmLo'), ehi = r.nums('emmHi');
  await app.results.appendTable(
    {
      columns: [factorNames.map((n) => labelOf(meta.get(n), n)).join(' , '), 'Adjusted mean', 'Std. Error', '95% CI'],
      rows: el.map((lab, i) => [lab, f(em[i], 3), f(ese[i], 3), ci(elo[i], ehi[i])]),
      rowHeaders: true,
    },
    { caption: 'Estimated Marginal Means (covariate-adjusted)' },
  );
  await app.results.appendText(
    'ANCOVA tests factor effects **after** removing the linear influence of the covariate(s); the adjusted means are the group means evaluated at the average covariate value. Type III SS (sum-to-zero contrasts) make the factor tests order-independent. Partial η² is each effect\'s share of its own + residual variance.',
  );
}

// --- Repeated-measures / mixed ANOVA -----------------------------------------

export async function mixedAnova(app, { within: withinNames, between: betweenName }) {
  if (!withinNames || withinNames.length < 2) {
    await app.results.appendError('Repeated-measures ANOVA: choose at least two measurement columns (the within-subject conditions).');
    return;
  }
  await app.webr.installPackages(['afex']);
  const meta = metaMap(await app.data.getVariableMeta());
  const hasBetween = !!betweenName;
  const recodes = [
    ...withinNames.map((n) => recodeLine(`within[[${rStr(n)}]]`, meta.get(n))),
    hasBetween ? recodeLine('between', meta.get(betweenName)) : '',
  ].filter(Boolean).join('\n');
  const levelNames = withinNames.map((n) => labelOf(meta.get(n), n));
  const rCode = `
    suppressMessages(library(afex))
    ${recodes}
    W <- as.data.frame(lapply(within, as.numeric)); names(W) <- paste0("L", seq_len(ncol(W)))
    ok <- stats::complete.cases(W)${hasBetween ? ' & !is.na(between)' : ''}
    W <- W[ok, , drop = FALSE]
    nb <- nrow(W); k <- ncol(W)
    long <- data.frame(sid = factor(rep(seq_len(nb), times = k)),
                       cond = factor(rep(names(W), each = nb), levels = names(W)),
                       yl = as.vector(as.matrix(W)))
    ${hasBetween ? 'long$grp <- factor(rep(as.character(between)[ok], times = k))' : ''}
    aw <- suppressMessages(aov_ez("sid", "yl", long, within = "cond"${hasBetween ? ', between = "grp"' : ''}))
    at <- aw$anova_table
    list(terms = rownames(at), numdf = at[, "num Df"], dendf = at[, "den Df"], F = at[, "F"],
         ges = at[, "ges"], p = at[, "Pr(>F)"], nsub = nb, k = k)`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), ndf = r.nums('numdf'), ddf = r.nums('dendf'), F = r.nums('F'), ges = r.nums('ges'), p = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['Effect', 'F', 'num df', 'den df', 'Sig.', 'Generalized η²'],
      rows: terms.map((t, i) => [rmTerm(t, betweenName, meta), f(F[i], 3), f(ndf[i], 2), f(ddf[i], 2), fmtP(p[i]), f(ges[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Repeated-Measures ANOVA — ${levelNames.length} conditions${hasBetween ? `, between: ${labelOf(meta.get(betweenName), betweenName)}` : ''} (N = ${r.num('nsub')} subjects)` },
  );
  await app.results.appendText(
    `Within-subject conditions: ${levelNames.join(', ')}. The **within** (cond) effect tests change across conditions; **between** (grp) tests group differences; their **interaction** tests whether the within pattern differs by group. p-values use the **Greenhouse–Geisser** sphericity correction; **generalized η²** is the recommended effect size for these designs. Subjects with any missing condition were dropped (listwise).`,
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function ancTerm(term, factorNames, covNames, meta) {
  if (term === 'Residuals') return 'Residuals';
  const parts = term.split(':').map((tk) => {
    let m = /^F(\d+)$/.exec(tk);
    if (m && factorNames[+m[1] - 1] != null) return labelOf(meta.get(factorNames[+m[1] - 1]), factorNames[+m[1] - 1]);
    m = /^C(\d+)$/.exec(tk);
    if (m && covNames[+m[1] - 1] != null) return labelOf(meta.get(covNames[+m[1] - 1]), covNames[+m[1] - 1]);
    return tk;
  });
  return parts.join(' × ');
}

function rmTerm(term, betweenName, meta) {
  const map = { cond: 'Within (conditions)', grp: betweenName ? labelOf(meta.get(betweenName), betweenName) : 'Between', 'grp:cond': 'Interaction', 'cond:grp': 'Interaction' };
  return map[term] || term;
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
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
