/**
 * @file plugins/builtin-compare/index.js
 * Built-in plugin: the **Comparison** menu — compare means.
 *
 * Four classic tests, each a declarative menu item with its own inputs:
 *  - One-sample t-test (a variable's mean vs. a value)
 *  - Independent-samples t-test (a numeric outcome across two groups; Welch)
 *  - Paired-samples t-test (two variables on the same cases)
 *  - One-way ANOVA (a numeric outcome across 3+ groups)
 *
 * Computed in base R (t.test / aov); the host renders SPSS-style tables. The host
 * binds each declared input into R by name (single variable → vector, grouping
 * variable → vector, the test value → a scalar); user-missing codes are recoded
 * to NA first.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-compare',
  name: 'Compare Means',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Comparison',
  keywords: ['t-test', 't test', 'anova', 'means', 'compare', 'group', 'welch'],
  disciplines: ['Psychology', 'Public Health', 'Nutrition Food & Dietetics', 'Education', 'Gerontology'],
  rPackages: [],
  menu: [
    {
      label: 'One-sample t-test…',
      run: 'oneSample',
      order: 10,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Test variable', hint: 'The numeric measure whose mean you want to test.', multiple: false, types: ['numeric'] },
        { name: 'mu', kind: 'number', label: 'Test value', hint: 'The reference value to compare the mean against.', default: 0 },
      ],
    },
    {
      label: 'Independent-samples t-test…',
      run: 'independent',
      order: 20,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose mean you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups (2)', hint: 'The variable that splits cases into the two groups to compare.', multiple: false, types: ['factor', 'string'], unique: true },
      ],
    },
    {
      label: 'Paired-samples t-test…',
      run: 'paired',
      order: 30,
      inputs: [
        { name: 'x1', kind: 'variables', label: 'Variable 1', hint: 'The first of two measures on the same cases.', multiple: false, types: ['numeric'], unique: true },
        { name: 'x2', kind: 'variables', label: 'Variable 2', hint: 'The second measure, compared against the first.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'One-way ANOVA…',
      run: 'oneway',
      order: 40,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose mean you want to compare.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Factor', hint: 'The variable that splits cases into three or more groups.', multiple: false, types: ['factor', 'string'], unique: true },
      ],
    },
  ],
};

// --- One-sample t-test -------------------------------------------------------

export async function oneSample(app, { x: name, mu }) {
  if (!name) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('x', name, meta)}
    x <- as.numeric(x); x <- x[is.finite(x)]
    if (length(x) < 2) stop("need at least 2 non-missing values")
    if (!is.finite(mu)) mu <- 0
    tt <- t.test(x, mu = mu)
    list(n = length(x), mean = mean(x), sd = sd(x), mu = mu,
         diff = mean(x) - mu, t = unname(tt$statistic), df = unname(tt$parameter),
         p = tt$p.value, d = (mean(x) - mu) / sd(x), lo = tt$conf.int[1], hi = tt$conf.int[2])`;
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
    { caption: `One-Sample t-Test — ${label(meta, name)}` },
  );
}

// --- Independent-samples t-test (Welch) --------------------------------------

export async function independent(app, { y: yName, g: gName }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('y', yName, meta)}
    ${recode('g', gName, meta)}
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g); y <- y[ok]; g <- droplevels(g[ok])
    lv <- levels(g)
    if (length(lv) != 2) stop(sprintf("the grouping variable must have exactly 2 groups (found %d)", length(lv)))
    tt <- t.test(y ~ g)
    .n <- as.integer(tapply(y, g, length)); .s <- as.numeric(tapply(y, g, sd))
    .sp <- sqrt(((.n[1] - 1) * .s[1]^2 + (.n[2] - 1) * .s[2]^2) / (sum(.n) - 2))
    list(levels = lv, n = .n, mean = as.numeric(tapply(y, g, mean)), sd = .s,
         t = unname(tt$statistic), df = unname(tt$parameter), p = tt$p.value,
         diff = unname(tt$estimate[1] - tt$estimate[2]),
         d = unname((tt$estimate[1] - tt$estimate[2]) / .sp),
         lo = tt$conf.int[1], hi = tt$conf.int[2])`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean', 'SD'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('n')[i]), f(r.num('mean')[i], 3), f(r.num('sd')[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Group Statistics — ${label(meta, yName)} by ${label(meta, gName)}` },
  );
  await app.results.appendTable(
    {
      columns: ['t', 'df', 'Sig. (2-tailed)', 'Mean diff.', "Cohen's d", '95% CI of diff.'],
      rows: [[f(r.n1('t'), 3), fmtDf(r.n1('df')), fmtP(r.n1('p')), f(r.n1('diff'), 3), f(r.n1('d'), 3), ci(r.n1('lo'), r.n1('hi'))]],
    },
    { caption: 'Independent-Samples t-Test (Welch)' },
  );
}

// --- Paired-samples t-test ---------------------------------------------------

export async function paired(app, { x1: n1, x2: n2 }) {
  if (!n1 || !n2) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('x1', n1, meta)}
    ${recode('x2', n2, meta)}
    x1 <- as.numeric(x1); x2 <- as.numeric(x2)
    ok <- is.finite(x1) & is.finite(x2); x1 <- x1[ok]; x2 <- x2[ok]
    if (length(x1) < 2) stop("need at least 2 complete pairs")
    tt <- t.test(x1, x2, paired = TRUE)
    list(n = length(x1), m1 = mean(x1), m2 = mean(x2), sd1 = sd(x1), sd2 = sd(x2),
         diff = mean(x1 - x2), sddiff = sd(x1 - x2), t = unname(tt$statistic),
         df = unname(tt$parameter), p = tt$p.value, lo = tt$conf.int[1], hi = tt$conf.int[2])`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  await app.results.appendTable(
    {
      columns: ['', 'N', 'Mean', 'SD'],
      rows: [
        [label(meta, n1), int(r.n1('n')), f(r.n1('m1'), 3), f(r.n1('sd1'), 3)],
        [label(meta, n2), int(r.n1('n')), f(r.n1('m2'), 3), f(r.n1('sd2'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: 'Paired Statistics' },
  );
  await app.results.appendTable(
    {
      columns: ['Mean diff.', 'SD diff.', 't', 'df', 'Sig. (2-tailed)', "Cohen's d", '95% CI of diff.'],
      rows: [[
        f(r.n1('diff'), 3), f(r.n1('sddiff'), 3), f(r.n1('t'), 3), fmtDf(r.n1('df')), fmtP(r.n1('p')),
        f(r.n1('diff') / r.n1('sddiff'), 3), ci(r.n1('lo'), r.n1('hi')),
      ]],
    },
    { caption: `Paired-Samples t-Test — ${label(meta, n1)} vs ${label(meta, n2)}` },
  );
}

// --- One-way ANOVA -----------------------------------------------------------

export async function oneway(app, { y: yName, g: gName }) {
  if (!yName || !gName) return;
  const meta = await metaMap(app);
  const rCode = `
    ${recode('y', yName, meta)}
    ${recode('g', gName, meta)}
    y <- as.numeric(y); g <- as.factor(g)
    ok <- is.finite(y) & !is.na(g); y <- y[ok]; g <- droplevels(g[ok])
    if (nlevels(g) < 2) stop("need at least 2 groups")
    fit <- aov(y ~ g); a <- summary(fit)[[1]]
    tuk <- TukeyHSD(fit)$g
    list(levels = levels(g), gn = as.integer(tapply(y, g, length)),
         gmean = as.numeric(tapply(y, g, mean)), gsd = as.numeric(tapply(y, g, sd)),
         df1 = a[["Df"]][1], df2 = a[["Df"]][2], ssb = a[["Sum Sq"]][1], ssw = a[["Sum Sq"]][2],
         msb = a[["Mean Sq"]][1], msw = a[["Mean Sq"]][2], Fval = a[["F value"]][1], p = a[["Pr(>F)"]][1],
         eta2 = a[["Sum Sq"]][1] / sum(a[["Sum Sq"]]),
         tukComp = rownames(tuk), tukDiff = tuk[, "diff"], tukLo = tuk[, "lwr"], tukUp = tuk[, "upr"], tukP = tuk[, "p adj"])`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const lv = r.str('levels');
  await app.results.appendTable(
    {
      columns: ['Group', 'N', 'Mean', 'SD'],
      rows: lv.map((l, i) => [valueLabel(meta, gName, l), int(r.num('gn')[i]), f(r.num('gmean')[i], 3), f(r.num('gsd')[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Descriptives — ${label(meta, yName)} by ${label(meta, gName)}` },
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
    { caption: 'ANOVA' },
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
      { caption: 'Post-hoc (Tukey HSD)' },
    );
  }
}

// --- helpers -----------------------------------------------------------------

async function metaMap(app) {
  return new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
}

/** R line recoding a bound vector's user-missing codes to NA (numeric codes). */
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
