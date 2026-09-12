/**
 * @file plugins/builtin-compare/index.js
 * Built-in plugin: the **Comparison** menu — compare means.
 *
 * Four classic tests, each a declarative menu item with its own inputs:
 *  - One-sample t-test (a variable's mean vs. a value)
 *  - Independent-samples t-test (a numeric outcome across two groups; Levene's
 *    test, then the equal-variances and Welch rows — SPSS's two-row table)
 *  - Paired-samples t-test (two variables on the same cases)
 *  - One-way ANOVA (a numeric outcome across 3+ groups)
 *
 * Computed in base R (t.test / aov); the host renders SPSS-style tables. The host
 * binds each declared input into R by name (single variable → vector, grouping
 * variable → vector, the test value → a scalar).
 */

/**
 * Weighted-statistics helpers as R source (#174f).
 *
 * The weight is a **frequency weight**: a case with w = 2.5 counts as two and a
 * half cases. Every N below is `sum(w)` and every variance divides by
 * `sum(w) - 1` — SPSS's WEIGHT BY, and what a survey weight means in a methods
 * course, where labs 9 onward are all run weighted.
 *
 * The t and F statistics are then the ordinary textbook formulas over those
 * weighted means, variances and Ns. They are written out rather than handed to
 * `t.test`/`aov`, which take no frequency weights (`lm(weights=)` are ANALYTIC
 * weights — same point estimates, wrong residual degrees of freedom). With every
 * weight at 1 each helper falls through to R's own function, so switching
 * weighting off reproduces the previous output exactly.
 *
 * Verified against case expansion: with integer weights every figure below
 * equals the unweighted figure computed on the physically replicated data.
 */
const WEIGHTED_R = `
  wclean <- function(w, n) {
    if (is.null(w)) return(rep(1, n))
    w <- suppressWarnings(as.numeric(w))
    w[!is.finite(w) | w <= 0] <- NA
    w
  }
  wmean <- function(x, w) if (all(w == 1)) mean(x) else sum(w * x) / sum(w)
  wvar  <- function(x, w) {
    if (all(w == 1)) return(if (length(x) > 1) var(x) else NA_real_)
    n <- sum(w); if (n <= 1) return(NA_real_)
    m <- sum(w * x) / n
    sum(w * (x - m)^2) / (n - 1)
  }
  wsd <- function(x, w) sqrt(wvar(x, w))
  # Two-sample t from group Ns, means and variances — the pooled and Welch forms
  # side by side, so both rows of SPSS's table come from one place.
  wt2 <- function(n1, m1, v1, n2, m2, v2, conf = 0.95, pooled) {
    d <- m1 - m2
    if (pooled) {
      sp2 <- ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)
      se <- sqrt(sp2 * (1 / n1 + 1 / n2)); df <- n1 + n2 - 2
    } else {
      se <- sqrt(v1 / n1 + v2 / n2)
      df <- (v1 / n1 + v2 / n2)^2 / ((v1 / n1)^2 / (n1 - 1) + (v2 / n2)^2 / (n2 - 1))
    }
    t <- d / se; tq <- qt(1 - (1 - conf) / 2, df)
    list(t = t, df = df, p = 2 * pt(-abs(t), df), se = se,
         lo = d - tq * se, hi = d + tq * se, diff = d)
  }
`;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-compare',
  name: 'Compare Means',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Comparison',
  keywords: ['t-test', 't test', 'anova', 'means', 'compare', 'group', 'welch', 'levene', 'equal variances'],
  disciplines: ['Psychology', 'Public Health', 'Nutrition, Food & Dietetics', 'Education', 'Gerontology'],
  howto:
    'GUI: Comparison ▸ pick a test (One-sample / Independent-samples / Paired-samples t-test, or One-way ANOVA), then choose the variables. You get SPSS-style group/test tables with effect sizes.\n' +
    'Syntax: run builtin-compare.oneSample {"x": "score", "mu": 0}\n' +
    '  • x — numeric test variable; mu — reference value (default 0).\n' +
    'Syntax: run builtin-compare.independent {"y": "score", "g": "group"}\n' +
    '  • y — numeric outcome; g — grouping variable (exactly 2 groups).\n' +
    'Syntax: run builtin-compare.paired {"x1": "pre", "x2": "post"}\n' +
    '  • x1 / x2 — two numeric measures on the same cases.\n' +
    'Syntax: run builtin-compare.oneway {"y": "score", "g": "group"}\n' +
    '  • y — numeric outcome; g — factor (3+ groups; Tukey post-hoc).\n' +
    '  • Every test takes an optional weight — a survey weight read as a frequency weight, so N and df follow its sum.',
  rPackages: [],
  menu: [
    {
      label: 'One-sample t-test…',
      run: 'oneSample',
      order: 10,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Test variable', hint: 'The numeric measure whose mean you want to test.', multiple: false, types: ['numeric'] },
        { name: 'mu', kind: 'number', label: 'Test value', hint: 'The reference value to compare the mean against.', default: 0 },
        { name: 'weight', kind: 'variables', label: 'Weight cases by (optional)', optional: true, multiple: false, types: ['numeric'], hint: 'A survey weight (e.g. WTSSNR), so the test describes the population rather than the sample. Cancel this to count each case once; the caption names the weight used.' },
      ],
    },
    {
      label: 'Independent-samples t-test…',
      run: 'independent',
      order: 20,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose mean you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups (2)', hint: 'The variable that splits cases into the two groups to compare.', multiple: false, types: ['factor', 'string'], unique: true },
        { name: 'weight', kind: 'variables', label: 'Weight cases by (optional)', optional: true, multiple: false, types: ['numeric'], hint: 'A survey weight (e.g. WTSSNR), so the test describes the population rather than the sample. Cancel this to count each case once; the caption names the weight used.' },
      ],
    },
    {
      label: 'Paired-samples t-test…',
      run: 'paired',
      order: 30,
      inputs: [
        { name: 'x1', kind: 'variables', label: 'Variable 1', hint: 'The first of two measures on the same cases.', multiple: false, types: ['numeric'], unique: true },
        { name: 'x2', kind: 'variables', label: 'Variable 2', hint: 'The second measure, compared against the first.', multiple: false, types: ['numeric'], unique: true },
        { name: 'weight', kind: 'variables', label: 'Weight cases by (optional)', optional: true, multiple: false, types: ['numeric'], hint: 'A survey weight (e.g. WTSSNR), so the test describes the population rather than the sample. Cancel this to count each case once; the caption names the weight used.' },
      ],
    },
    {
      label: 'One-way ANOVA…',
      run: 'oneway',
      order: 40,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose mean you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Factor', hint: 'The variable that splits cases into three or more groups.', multiple: false, types: ['factor', 'string'], unique: true },
        { name: 'weight', kind: 'variables', label: 'Weight cases by (optional)', optional: true, multiple: false, types: ['numeric'], hint: 'A survey weight (e.g. WTSSNR), so the test describes the population rather than the sample. Cancel this to count each case once; the caption names the weight used.' },
      ],
    },
  ],
};

// --- One-sample t-test -------------------------------------------------------

export async function oneSample(app, { x: name, mu, weight }) {
  if (!name) return;
  const meta = await metaMap(app);
  const rCode = `
    ${WEIGHTED_R}
    w <- wclean(${weight ? 'weight' : 'NULL'}, length(x))
    x <- as.numeric(x)
    ok <- is.finite(x) & !is.na(w); x <- x[ok]; w <- w[ok]
    if (length(x) < 2) stop("need at least 2 non-missing values")
    if (!is.finite(mu)) mu <- 0
    n <- sum(w); m <- wmean(x, w); s <- wsd(x, w)
    se <- s / sqrt(n); df <- n - 1
    t <- (m - mu) / se; tq <- qt(.975, df)
    list(n = n, mean = m, sd = s, mu = mu,
         diff = m - mu, t = t, df = df,
         p = 2 * pt(-abs(t), df), d = (m - mu) / s,
         lo = (m - mu) - tq * se, hi = (m - mu) + tq * se)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  await app.results.appendTable(
    {
      columns: ['Test value', 'N', 'Mean', 'SD', 'Mean diff.', 't', 'df', 'Sig. (2-tailed)', "Cohen's d", '95% CI of diff.'],
      rows: [[
        f(r.n1('mu'), 3), int(r.n1('n')), f(r.n1('mean'), 3), f(r.n1('sd'), 3), f(r.n1('diff'), 3),
        f(r.n1('t'), 3), fmtDf(r.n1('df')), fmtP(r.n1('p')), f(r.n1('d'), 3), ci(r.n1('lo'), r.n1('hi')),
      ]],
    },
    { caption: `One-Sample t-Test — ${label(meta, name)}${wSuffix(meta, weight)}` },
  );
  await weightNote(app, weight);
}

// --- Independent-samples t-test (Levene + pooled + Welch) --------------------

/**
 * Independent-samples t-test — SPSS's two-row **Independent Samples Test** table
 * (#174l).
 *
 * This printed Welch only. That is the safer default, but it teaches the wrong
 * lesson: a methods lab walks students through reading F and Sig from "Levene's
 * Test for Equality of Variances" and *then* choosing which t row to read, and
 * the whole point of there being two rows is the choice. Levene's did exist, in
 * a separate Assumptions plugin — which is precisely the arrangement that hides
 * why the rows differ.
 *
 * The Levene here is **mean-centred**, because that is what SPSS's T-TEST
 * procedure reports and what the answer key will say. The standalone Assumptions
 * plugin runs the median-centred (Brown–Forsythe) variant, which is more robust
 * and gives a slightly different F — so the footnote says which is which rather
 * than leaving two numbers in one app unexplained.
 *
 * @param {object} app
 * @param {{y: string, g: string, weight?: string|null}} inputs
 */
export async function independent(app, { y: yName, g: gName, weight }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${WEIGHTED_R}
    w <- wclean(${weight ? 'weight' : 'NULL'}, length(y))
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g) & !is.na(w); y <- y[ok]; g <- droplevels(g[ok]); w <- w[ok]
    lv <- levels(g)
    if (length(lv) != 2) stop(sprintf("the grouping variable must have exactly 2 groups (found %d)", length(lv)))
    i1 <- g == lv[1]; i2 <- g == lv[2]
    n1 <- sum(w[i1]); n2 <- sum(w[i2])
    if (n1 < 2 || n2 < 2) stop("each group needs at least 2 cases")
    m1 <- wmean(y[i1], w[i1]); m2 <- wmean(y[i2], w[i2])
    v1 <- wvar(y[i1], w[i1]);  v2 <- wvar(y[i2], w[i2])
    tp <- wt2(n1, m1, v1, n2, m2, v2, 0.95, TRUE)
    tw <- wt2(n1, m1, v1, n2, m2, v2, 0.95, FALSE)

    # Levene's test IS a one-way ANOVA on each case's absolute deviation from its
    # own group's centre; centring on the MEAN is SPSS's t-test variant. The
    # ANOVA is written out so the weighted degrees of freedom are sum(w) - k,
    # which is what a frequency weight means — lm(weights=) would give n - k.
    z <- abs(y - ifelse(i1, m1, m2))
    zm1 <- wmean(z[i1], w[i1]); zm2 <- wmean(z[i2], w[i2])
    zgm <- wmean(z, w)
    ssb <- n1 * (zm1 - zgm)^2 + n2 * (zm2 - zgm)^2
    ssw <- (n1 - 1) * wvar(z[i1], w[i1]) + (n2 - 1) * wvar(z[i2], w[i2])
    ldf1 <- 1; ldf2 <- n1 + n2 - 2
    levF <- (ssb / ldf1) / (ssw / ldf2)
    levP <- pf(levF, ldf1, ldf2, lower.tail = FALSE)

    .sp <- sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    list(levels = lv, n = c(n1, n2), mean = c(m1, m2), sd = c(sqrt(v1), sqrt(v2)),
         levF = levF, levP = levP,
         tp = tp$t, dfp = tp$df, pp = tp$p, plo = tp$lo, phi = tp$hi, sep = tp$se,
         tw = tw$t, dfw = tw$df, pw = tw$p, wlo = tw$lo, whi = tw$hi, sew = tw$se,
         diff = tp$diff, d = tp$diff / .sp)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  const ws = wSuffix(meta, weight);
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean', 'SD'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('n')[i]), f(r.num('mean')[i], 3), f(r.num('sd')[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Group Statistics — ${label(meta, yName)} by ${label(meta, gName)}${ws}` },
  );

  const diff = f(r.n1('diff'), 3);
  await app.results.appendTable(
    {
      columns: [
        '',
        "Levene's F",
        'Levene Sig.',
        't',
        'df',
        'Sig. (2-tailed)',
        'Mean diff.',
        'Std. Error diff.',
        '95% CI of diff.',
      ],
      rows: [
        [
          'Equal variances assumed',
          f(r.n1('levF'), 3),
          fmtP(r.n1('levP')),
          f(r.n1('tp'), 3),
          fmtDf(r.n1('dfp')),
          fmtP(r.n1('pp')),
          diff,
          f(r.n1('sep'), 3),
          ci(r.n1('plo'), r.n1('phi')),
        ],
        [
          'Equal variances not assumed',
          '',
          '',
          f(r.n1('tw'), 3),
          fmtDf(r.n1('dfw')),
          fmtP(r.n1('pw')),
          diff,
          f(r.n1('sew'), 3),
          ci(r.n1('wlo'), r.n1('whi')),
        ],
      ],
      rowHeaders: true,
    },
    { caption: `Independent-Samples Test${ws}` },
  );
  const sig = r.n1('levP') < 0.05;
  await app.results.appendText(
    `Read Levene's test first. Here Sig. = ${fmtP(r.n1('levP'))}, so the variances ` +
      `${sig ? 'differ' : 'can be treated as equal'} — report the **equal variances ` +
      `${sig ? 'not ' : ''}assumed** row. Cohen's d = ${f(r.n1('d'), 3)} (pooled SD).\n\n` +
      "_Levene's is centred on the group means here, matching SPSS's t-test output. " +
      'Assumptions ▸ Homogeneity of variance runs the median-centred (Brown–Forsythe) ' +
      'variant, which is more robust and will give a slightly different F._',
  );
  await weightNote(app, weight);
}

// --- Paired-samples t-test ---------------------------------------------------

export async function paired(app, { x1: n1, x2: n2, weight }) {
  if (!n1 || !n2) return;
  const meta = await metaMap(app);
  const rCode = `
    ${WEIGHTED_R}
    w <- wclean(${weight ? 'weight' : 'NULL'}, length(x1))
    x1 <- as.numeric(x1); x2 <- as.numeric(x2)
    ok <- is.finite(x1) & is.finite(x2) & !is.na(w); x1 <- x1[ok]; x2 <- x2[ok]; w <- w[ok]
    if (length(x1) < 2) stop("need at least 2 complete pairs")
    d <- x1 - x2
    n <- sum(w); md <- wmean(d, w); sdd <- wsd(d, w)
    se <- sdd / sqrt(n); df <- n - 1
    t <- md / se; tq <- qt(.975, df)
    list(n = n, m1 = wmean(x1, w), m2 = wmean(x2, w), sd1 = wsd(x1, w), sd2 = wsd(x2, w),
         diff = md, sddiff = sdd, t = t, df = df,
         p = 2 * pt(-abs(t), df), lo = md - tq * se, hi = md + tq * se)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const ws = wSuffix(meta, weight);
  await app.results.appendTable(
    {
      columns: ['', 'N', 'Mean', 'SD'],
      rows: [
        [label(meta, n1), int(r.n1('n')), f(r.n1('m1'), 3), f(r.n1('sd1'), 3)],
        [label(meta, n2), int(r.n1('n')), f(r.n1('m2'), 3), f(r.n1('sd2'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: `Paired Statistics${ws}` },
  );
  await app.results.appendTable(
    {
      columns: ['Mean diff.', 'SD diff.', 't', 'df', 'Sig. (2-tailed)', "Cohen's d", '95% CI of diff.'],
      rows: [[
        f(r.n1('diff'), 3), f(r.n1('sddiff'), 3), f(r.n1('t'), 3), fmtDf(r.n1('df')), fmtP(r.n1('p')),
        f(r.n1('diff') / r.n1('sddiff'), 3), ci(r.n1('lo'), r.n1('hi')),
      ]],
    },
    { caption: `Paired-Samples t-Test — ${label(meta, n1)} vs ${label(meta, n2)}${ws}` },
  );
  await weightNote(app, weight);
}

// --- One-way ANOVA -----------------------------------------------------------

export async function oneway(app, { y: yName, g: gName, weight }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${WEIGHTED_R}
    w <- wclean(${weight ? 'weight' : 'NULL'}, length(y))
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g) & !is.na(w); y <- y[ok]; g <- droplevels(g[ok]); w <- w[ok]
    if (nlevels(g) < 2) stop("need at least 2 groups")
    lvs <- levels(g)
    gn  <- sapply(lvs, function(k) sum(w[g == k]))
    gm  <- sapply(lvs, function(k) wmean(y[g == k], w[g == k]))
    gv  <- sapply(lvs, function(k) wvar(y[g == k], w[g == k]))
    gsd <- sqrt(gv)
    # The one-way ANOVA written from group Ns, means and variances, so a frequency
    # weight lands in the degrees of freedom (sum(w) - k) where it belongs. At
    # w = 1 these are aov()'s own sums of squares.
    gmean <- wmean(y, w)
    ssb <- sum(gn * (gm - gmean)^2)
    ssw <- sum((gn - 1) * gv)
    df1 <- nlevels(g) - 1; df2 <- sum(gn) - nlevels(g)
    msb <- ssb / df1; msw <- ssw / df2
    Fval <- msb / msw
    p <- pf(Fval, df1, df2, lower.tail = FALSE)

    # Tukey HSD, from the same weighted quantities: the studentised-range interval
    # around each pairwise difference. ptukey/qtukey are base R, so the p-values
    # and the critical value are not hand-rolled — only the inputs are weighted.
    k <- nlevels(g); comps <- character(0)
    tdiff <- numeric(0); tlo <- numeric(0); tup <- numeric(0); tp <- numeric(0)
    if (k >= 2) for (a in 1:(k - 1)) for (b in (a + 1):k) {
      d <- gm[b] - gm[a]
      se <- sqrt(msw / 2 * (1 / gn[a] + 1 / gn[b]))
      q <- abs(d) / se
      comps <- c(comps, paste0(lvs[b], "-", lvs[a]))
      tdiff <- c(tdiff, d)
      tlo <- c(tlo, d - qtukey(.95, k, df2) * se)
      tup <- c(tup, d + qtukey(.95, k, df2) * se)
      tp  <- c(tp, ptukey(q, k, df2, lower.tail = FALSE))
    }
    list(levels = lvs, gn = gn, gmean = gm, gsd = gsd,
         df1 = df1, df2 = df2, ssb = ssb, ssw = ssw, msb = msb, msw = msw,
         Fval = Fval, p = p, eta2 = ssb / (ssb + ssw),
         tukComp = comps, tukDiff = tdiff, tukLo = tlo, tukUp = tup, tukP = tp)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  const ws = wSuffix(meta, weight);
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean', 'SD'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('gn')[i]), f(r.num('gmean')[i], 3), f(r.num('gsd')[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Descriptives — ${label(meta, yName)} by ${label(meta, gName)}${ws}` },
  );
  const ssb = r.n1('ssb');
  const ssw = r.n1('ssw');
  const df1 = r.n1('df1');
  const df2 = r.n1('df2');
  await app.results.appendTable(
    {
      columns: ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
      rows: [
        ['Between Groups', f(ssb, 3), int(df1), f(r.n1('msb'), 3), f(r.n1('Fval'), 3), fmtP(r.n1('p'))],
        ['Within Groups', f(ssw, 3), int(df2), f(r.n1('msw'), 3), '', ''],
        ['Total', f(ssb + ssw, 3), int(df1 + df2), '', '', ''],
      ],
      rowHeaders: true,
    },
    { caption: `ANOVA${ws}` },
  );
  await app.results.appendText(`Effect size: η² = ${f(r.n1('eta2'), 3)}.`);

  const comp = r.str('tukComp');
  if (comp.length) {
    await app.results.appendTable(
      {
        columns: ['Comparison', 'Mean diff.', '95% CI', 'Sig. (adj.)'],
        rows: comp.map((c, i) => [
          c, f(r.num('tukDiff')[i], 3), ci(r.num('tukLo')[i], r.num('tukUp')[i]), fmtP(r.num('tukP')[i]),
        ]),
        rowHeaders: true,
      },
      { caption: `Post-hoc (Tukey HSD)${ws}` },
    );
  }
  await weightNote(app, weight);
}

// --- helpers -----------------------------------------------------------------

/** The " — weighted by X" a caption carries so no result is ambiguous about which
 * population it describes. There is no global weight mode to forget you left on. */
function wSuffix(meta, weight) {
  return weight ? ` — weighted by ${meta.get(weight)?.label ?? weight}` : '';
}

/** Say what the weight did to N, once, under the tables it changed. */
async function weightNote(app, weight) {
  if (!weight) return;
  await app.results.appendText(
    `_N is the sum of ${weight}, not a head count, and the degrees of freedom follow it: ` +
      'the weight is read as a frequency weight, so a case weighted 2.5 counts as two and a half cases._',
  );
}

async function metaMap(app) {
  return new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
}

function label(meta, name) {
  return meta.get(name)?.label || name;
}

function valueLabel(meta, name, code) {
  return meta.get(name)?.valueLabels?.[code] ?? code;
}

/** Flatten a WebR tagged-list result into typed accessors. */
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
const fmtDf = (d) => (Number.isFinite(d) ? (Number.isInteger(d) ? String(d) : d.toFixed(2)) : '—');
const ci = (lo, hi) => (Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—');
