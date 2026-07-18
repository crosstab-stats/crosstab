/**
 * @file plugins/builtin-nonparametric/index.js
 * Built-in plugin: the **Nonparametric** menu — rank-based tests, the
 * ordinal/non-normal partners to the t-tests and ANOVA in Comparison.
 *
 *  - Mann-Whitney U (two independent groups)
 *  - Wilcoxon signed-rank (two paired variables)
 *  - Kruskal-Wallis (three or more independent groups)
 *
 * Base R (wilcox.test / kruskal.test) plus a manual rank/Z computation so the
 * output matches SPSS: a ranks table, the test statistic, the normal-approx Z,
 * the asymptotic p, and an effect size (r = |Z|/√N, or ε² for Kruskal-Wallis).
 * User-missing codes are recoded to NA first.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-nonparametric',
  name: 'Nonparametric Tests',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Nonparametric',
  keywords: ['mann-whitney', 'wilcoxon', 'kruskal-wallis', 'rank', 'ordinal', 'nonparametric'],
  disciplines: ['Psychology', 'Public Health', 'Nutrition, Food & Dietetics', 'Gerontology', 'Sociology'],
  howto:
    'GUI: Nonparametric ▸ Mann-Whitney U / Wilcoxon signed-rank / Kruskal-Wallis…, then pick the variables. ' +
    'You get a ranks table, the test statistic, normal-approx Z, asymptotic p, and an effect size.\n' +
    'Syntax: run builtin-nonparametric.mannWhitney {"y": "score", "g": "group"}\n' +
    'Syntax: run builtin-nonparametric.wilcoxon {"x1": "before", "x2": "after"}\n' +
    'Syntax: run builtin-nonparametric.kruskal {"y": "score", "g": "group"}\n' +
    '  • mannWhitney / kruskal: y — test variable; g — grouping variable (2 groups vs 3+).\n' +
    '  • wilcoxon: x1 / x2 — two paired measures on the same cases.',
  rPackages: [],
  menu: [
    {
      label: 'Mann-Whitney U (2 groups)…',
      run: 'mannWhitney',
      order: 10,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Test variable', hint: 'The numeric or ordinal measure whose ranks you compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups (2)', hint: 'The variable that splits cases into the two groups to compare.', multiple: false, types: ['factor', 'string'], unique: true },
      ],
    },
    {
      label: 'Wilcoxon signed-rank (paired)…',
      run: 'wilcoxon',
      order: 20,
      inputs: [
        { name: 'x1', kind: 'variables', label: 'Variable 1', hint: 'The first of two repeated measures on the same cases.', multiple: false, types: ['numeric'], unique: true },
        { name: 'x2', kind: 'variables', label: 'Variable 2', hint: 'The second measure, compared against the first.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Kruskal-Wallis (k groups)…',
      run: 'kruskal',
      order: 30,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Test variable', hint: 'The numeric or ordinal measure whose ranks you compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups', hint: 'The variable that splits cases into three or more groups.', multiple: false, types: ['factor', 'string'], unique: true },
      ],
    },
  ],
};

// --- Mann-Whitney U ----------------------------------------------------------

export async function mannWhitney(app, { y: yName, g: gName }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('y', yName, meta)}
    ${recode('g', gName, meta)}
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g); y <- y[ok]; g <- droplevels(g[ok])
    lv <- levels(g)
    if (length(lv) != 2) stop(sprintf("the grouping variable must have exactly 2 groups (found %d)", length(lv)))
    rk <- rank(y)
    n1 <- sum(g == lv[1]); n2 <- sum(g == lv[2]); N <- n1 + n2
    R1 <- sum(rk[g == lv[1]]); R2 <- sum(rk[g == lv[2]])
    U1 <- R1 - n1 * (n1 + 1) / 2; U <- min(U1, n1 * n2 - U1)
    mU <- n1 * n2 / 2
    tt <- table(rk); tieTerm <- sum(tt^3 - tt)
    sU <- sqrt((n1 * n2 / 12) * ((N + 1) - tieTerm / (N * (N - 1))))
    Z <- (U1 - mU) / sU
    p <- 2 * pnorm(-abs(Z))
    list(levels = lv, n = c(n1, n2), meanRank = c(R1 / n1, R2 / n2), sumRank = c(R1, R2),
         U = U, W = min(R1, R2), Z = Z, p = p, r = abs(Z) / sqrt(N))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean Rank', 'Sum of Ranks'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('n')[i]), f(r.num('meanRank')[i], 2), f(r.num('sumRank')[i], 2)]),
      rowHeaders: true,
    },
    { caption: `Ranks — ${label(meta, yName)} by ${label(meta, gName)}` },
  );
  await app.results.appendTable(
    {
      columns: ['Mann-Whitney U', 'Wilcoxon W', 'Z', 'Asymp. Sig. (2-tailed)', 'Effect size r'],
      rows: [[f(r.n1('U'), 1), f(r.n1('W'), 1), f(r.n1('Z'), 3), fmtP(r.n1('p')), f(r.n1('r'), 3)]],
    },
    { caption: 'Mann-Whitney U Test' },
  );
}

// --- Wilcoxon signed-rank ----------------------------------------------------

export async function wilcoxon(app, { x1: n1, x2: n2 }) {
  if (!n1 || !n2) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('x1', n1, meta)}
    ${recode('x2', n2, meta)}
    x1 <- as.numeric(x1); x2 <- as.numeric(x2)
    ok <- is.finite(x1) & is.finite(x2); x1 <- x1[ok]; x2 <- x2[ok]
    d <- x2 - x1; nz <- d[d != 0]; ties <- sum(d == 0)
    n <- length(nz)
    if (n < 1) stop("no non-tied pairs to test")
    rk <- rank(abs(nz))
    neg <- d < 0 & d != 0; pos <- d > 0
    nNeg <- sum(neg); nPos <- sum(pos)
    sumNeg <- sum(rank(abs(nz))[nz < 0]); sumPos <- sum(rank(abs(nz))[nz > 0])
    Tstat <- min(sumNeg, sumPos)
    mT <- n * (n + 1) / 4
    tg <- table(rk); tieTerm <- sum(tg^3 - tg)
    sT <- sqrt(n * (n + 1) * (2 * n + 1) / 24 - tieTerm / 48)
    Z <- (sumPos - mT) / sT
    p <- 2 * pnorm(-abs(Z))
    list(nNeg = nNeg, nPos = nPos, ties = ties,
         mrNeg = if (nNeg) sum(rank(abs(nz))[nz < 0]) / nNeg else 0,
         mrPos = if (nPos) sum(rank(abs(nz))[nz > 0]) / nPos else 0,
         srNeg = sumNeg, srPos = sumPos, Z = Z, p = p, r = abs(Z) / sqrt(n))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  await app.results.appendTable(
    {
      columns: ['', 'N', 'Mean Rank', 'Sum of Ranks'],
      rows: [
        ['Negative ranks', int(r.n1('nNeg')), f(r.n1('mrNeg'), 2), f(r.n1('srNeg'), 2)],
        ['Positive ranks', int(r.n1('nPos')), f(r.n1('mrPos'), 2), f(r.n1('srPos'), 2)],
        ['Ties', int(r.n1('ties')), '', ''],
      ],
      rowHeaders: true,
    },
    { caption: `Ranks — ${label(meta, n2)} − ${label(meta, n1)}` },
  );
  await app.results.appendTable(
    {
      columns: ['Z', 'Asymp. Sig. (2-tailed)', 'Effect size r'],
      rows: [[f(r.n1('Z'), 3), fmtP(r.n1('p')), f(r.n1('r'), 3)]],
    },
    { caption: `Wilcoxon Signed-Rank Test — ${label(meta, n1)} vs ${label(meta, n2)}` },
  );
}

// --- Kruskal-Wallis ----------------------------------------------------------

export async function kruskal(app, { y: yName, g: gName }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('y', yName, meta)}
    ${recode('g', gName, meta)}
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g); y <- y[ok]; g <- droplevels(g[ok])
    k <- nlevels(g); N <- length(y)
    if (k < 2) stop("need at least 2 groups")
    kt <- kruskal.test(y ~ g)
    rk <- rank(y)
    list(levels = levels(g), n = as.integer(tapply(y, g, length)),
         meanRank = as.numeric(tapply(rk, g, mean)),
         H = unname(kt$statistic), df = unname(kt$parameter), p = kt$p.value,
         eps2 = max(0, (unname(kt$statistic) - k + 1) / (N - k)))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean Rank'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('n')[i]), f(r.num('meanRank')[i], 2)]),
      rowHeaders: true,
    },
    { caption: `Ranks — ${label(meta, yName)} by ${label(meta, gName)}` },
  );
  await app.results.appendTable(
    {
      columns: ['Kruskal-Wallis H', 'df', 'Asymp. Sig.', 'Effect size ε²'],
      rows: [[f(r.n1('H'), 3), int(r.n1('df')), fmtP(r.n1('p')), f(r.n1('eps2'), 3)]],
    },
    { caption: 'Kruskal-Wallis Test' },
  );
}

// --- helpers -----------------------------------------------------------------

async function metaMap(app) {
  return new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
}
function recode(boundName, varName, meta) {
  const mv = (meta.get(varName)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${boundName}[${boundName} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function valueLabel(meta, name, code) {
  return meta.get(name)?.valueLabels?.[code] ?? code;
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
    num: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    str: (k) => arr(byName[k]).map(String),
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
