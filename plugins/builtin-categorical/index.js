/**
 * @file plugins/builtin-categorical/index.js
 * Built-in plugin: Categorical ▸ tests for counts and proportions that the
 * crosstab (χ² of independence) doesn't cover:
 *  - **χ² goodness-of-fit** — does one variable's distribution match expected
 *    proportions (equal by default, or a comma-separated list)?
 *  - **One-proportion test** — is a category's proportion equal to a value
 *    (exact binomial)?
 *  - **Two-proportion test** — do two groups differ in a proportion (with a CI
 *    for the difference)?
 *  - **McNemar's test** — paired nominal (e.g. before/after on the same people).
 *
 * Categorical variables are bound as their numeric codes; value labels are used
 * for display. User-missing codes are recoded to NA.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-categorical',
  name: 'Categorical Tests',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Categorical',
  keywords: ['chi-square', 'goodness of fit', 'proportion', 'prop.test', 'binomial', 'mcnemar', 'categorical'],
  disciplines: ['Sociology', 'Political Science', 'Public Health', 'Criminology', 'Social Science'],
  howto:
    'GUI: Categorical ▸ pick a test (Chi-square goodness-of-fit, One-/Two-proportion, McNemar\'s, or Log-linear model). You get the test statistic, p-value, and (where applicable) a CI.\n' +
    'Syntax: run builtin-categorical.gof {"variable": "region", "expected": ""}\n' +
    'Syntax: run builtin-categorical.oneProp {"variable": "passed", "category": "yes", "p0": 0.5, "weight": "wtssnr"}\n' +
    'Syntax: run builtin-categorical.twoProp {"outcome": "passed", "groups": "cohort"}\n' +
    '  • variable / outcome / groups — the categorical variable(s); expected — comma-separated proportions (blank = equal); p0 — the test proportion.\n' +
    '  • category (oneProp) — which of the two categories is tested against p0; omit to test the second category.\n' +
    '  • weight (oneProp) — optional frequency weight; with it N is the sum of weights and the test uses a normal approximation instead of the exact binomial.\n' +
    '  • other actions: McNemar\'s test (paired) — run builtin-categorical.mcnemar {"v1": "before", "v2": "after"}; Log-linear model — run builtin-categorical.loglinear {"vars": ["a", "b"], "model": "homogeneous"}.',
  rPackages: [],
  menu: [
    {
      label: 'Chi-square goodness-of-fit…',
      run: 'gof',
      order: 10,
      inputs: [
        { name: 'variable', kind: 'variables', label: 'Variable', hint: 'The categorical variable whose distribution you want to test.', types: ['factor', 'string', 'numeric'] },
        { name: 'expected', kind: 'text', label: 'Expected proportions (comma-separated; blank = equal)', hint: 'The proportions you expect per category; blank assumes equal.', optional: true },
      ],
    },
    {
      label: 'One-proportion test…',
      run: 'oneProp',
      order: 20,
      inputs: [
        { name: 'variable', kind: 'variables', label: 'Binary variable', hint: 'The yes/no variable whose proportion you want to test.', types: ['factor', 'string', 'numeric'] },
        { name: 'category', kind: 'level', of: 'variable', label: 'Category to test', hint: 'Which category’s proportion is compared against the test proportion — the other category is 1 minus this one.' },
        { name: 'p0', kind: 'number', label: 'Test proportion', hint: 'The proportion to compare against, such as 0.5.', default: 0.5, min: 0, max: 1 },
        { name: 'weight', kind: 'variables', label: 'Weight cases by (optional)', optional: true, multiple: false, types: ['numeric'], hint: 'A survey weight (e.g. WTSSNR), so the test describes the population rather than the sample. With a weight the exact binomial gives way to a normal approximation (SPSS’s large-sample method); cancel this to count each case once.' },
      ],
    },
    {
      label: 'Two-proportion test…',
      run: 'twoProp',
      order: 30,
      inputs: [
        { name: 'outcome', kind: 'variables', label: 'Binary outcome', hint: 'The yes/no outcome whose rate you compare across groups.', types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'groups', kind: 'variables', label: 'Groups (2)', hint: 'The variable that splits cases into the two groups to compare.', types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
    {
      label: "McNemar's test (paired)…",
      run: 'mcnemar',
      order: 40,
      inputs: [
        { name: 'v1', kind: 'variables', label: 'Variable 1', hint: 'The first paired measure, such as the before response.', types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'v2', kind: 'variables', label: 'Variable 2', hint: 'The second paired measure on the same people, such as after.', types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
    {
      label: 'Log-linear model…',
      run: 'loglinear',
      order: 50,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Categorical variables (2–4)', hint: 'The categorical variables whose associations you want to test.', types: ['factor', 'string', 'numeric'], multiple: true, unique: true },
        { name: 'model', kind: 'choice', label: 'Model', hint: 'How many associations the model is allowed to include.', default: 'homogeneous', options: [
          { value: 'independence', label: 'Mutual independence (main effects only)' },
          { value: 'homogeneous', label: 'Homogeneous association (all two-way)' },
          { value: 'saturated', label: 'Saturated (all interactions)' },
        ] },
      ],
    },
  ],
};

/**
 * Log-linear analysis of a multiway contingency table via a Poisson GLM on the
 * cell counts. Reports the model goodness-of-fit (likelihood-ratio G² and
 * Pearson χ²) and a `drop1` likelihood-ratio test of each term, which tells you
 * which associations the data actually require.
 * @param {object} app
 * @param {{vars: string[], model: string}} inputs
 */
export async function loglinear(app, { vars, model }) {
  if (!vars || vars.length < 2) {
    await app.results.appendError('Log-linear model: choose at least two categorical variables.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const X = vars.map((_, i) => `X${i + 1}`);
  const terms = model === 'independence' ? X.join(' + ') : model === 'saturated' ? X.join(' * ') : `(${X.join(' + ')})^2`;
  const modelLabel = { independence: 'Mutual independence', homogeneous: 'Homogeneous association (all two-way)', saturated: 'Saturated' }[model] || model;
  const rCode = `
    vv <- as.data.frame(lapply(vars, function(c) factor(c)), check.names = FALSE)
    names(vv) <- paste0("X", seq_len(ncol(vv)))
    tabdf <- as.data.frame(table(vv))
    fit <- glm(as.formula(paste("Freq ~", ${rStr(terms)})), data = tabdf, family = poisson())
    g2 <- fit$deviance; dfres <- fit$df.residual
    pearson <- sum(residuals(fit, type = "pearson")^2)
    dr <- tryCatch(drop1(fit, test = "Chisq"), error = function(e) NULL)
    drOut <- if (is.null(dr)) NULL else { keep <- rownames(dr) != "<none>"; list(
      t = rownames(dr)[keep], df = dr[keep, "Df"], lrt = dr[keep, "LRT"], p = dr[keep, ncol(dr)]) }
    list(g2 = g2, df = dfres, pg = pchisq(g2, dfres, lower.tail = FALSE),
         pearson = pearson, pp = pchisq(pearson, dfres, lower.tail = FALSE),
         nCells = nrow(tabdf), N = sum(tabdf$Freq),
         drTerms = if (is.null(drOut)) character(0) else drOut$t,
         drDf = if (is.null(drOut)) numeric(0) else drOut$df,
         drLrt = if (is.null(drOut)) numeric(0) else drOut$lrt,
         drP = if (is.null(drOut)) numeric(0) else drOut$p)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['', 'Value', 'df', 'Sig.'],
      rows: [
        ['Likelihood Ratio (G²)', f(r.n1('g2'), 3), int(r.n1('df')), fmtP(r.n1('pg'))],
        ['Pearson χ²', f(r.n1('pearson'), 3), int(r.n1('df')), fmtP(r.n1('pp'))],
      ],
      rowHeaders: true,
    },
    { caption: `Log-Linear Goodness-of-Fit — ${modelLabel} model (N = ${int(r.n1('N'))}, ${int(r.n1('nCells'))} cells)` },
  );

  const dt = r.str('drTerms'), ddf = r.num('drDf'), dl = r.num('drLrt'), dp = r.num('drP');
  if (dt.length) {
    await app.results.appendTable(
      {
        columns: ['Term', 'LR χ²', 'df', 'Sig.'],
        rows: dt.map((t, i) => [prettyLLTerm(t, vars, meta), f(dl[i], 3), int(ddf[i]), fmtP(dp[i])]),
        rowHeaders: true,
      },
      { caption: 'Tests of Each Term (likelihood-ratio drop tests)' },
    );
  }

  const indep = model === 'independence';
  await app.results.appendText(
    (indep
      ? `The G² above tests **mutual independence**: a *small* p means the variables are **associated** (the independence model fits poorly). `
      : `The G² above is the model's lack-of-fit vs the saturated table: a *large* p means this model **fits well** (no important associations were omitted). `) +
      'In the term table, a significant interaction (e.g. *A × B*) means that association is needed to explain the counts; respecting marginality, only the highest-order removable terms are tested.',
  );
}

/** Map glm term like "X1:X2" → "Region × Income" using the chosen variables. */
function prettyLLTerm(term, vars, meta) {
  return String(term)
    .split(':')
    .map((part) => {
      const m = /^X(\d+)$/.exec(part.trim());
      return m && vars[+m[1] - 1] != null ? label(meta, vars[+m[1] - 1]) : part;
    })
    .join(' × ');
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function gof(app, { variable, expected }) {
  if (!variable) return void app.results.appendError('Pick a variable.');
  const meta = metaMap(await app.data.getVariableMeta());
  const exp = parseProps(expected);
  const rCode = `
    x <- variable[!is.na(variable)]
    tab <- table(x)
    .pin <- c(${exp.join(', ')})
    p <- if (length(.pin) == length(tab) && all(is.finite(.pin)) && all(.pin > 0)) .pin / sum(.pin) else rep(1 / length(tab), length(tab))
    ch <- suppressWarnings(chisq.test(tab, p = p))
    list(levels = names(tab), observed = as.integer(tab), expected = unname(ch$expected),
         chisq = unname(ch$statistic), df = unname(ch$parameter), p = ch$p.value)`;
  const r = flat((await app.webr.run(rCode)).result);
  const levels = r.str('levels');
  const obs = r.num('observed');
  const expd = r.num('expected');
  const total = obs.reduce((a, b) => a + b, 0);
  await app.results.appendTable(
    {
      columns: ['Category', 'Observed', 'Expected'],
      rows: [
        ...levels.map((lv, i) => [vlab(meta, variable, lv), int(obs[i]), f(expd[i], 2)]),
        ['Total', int(total), f(total, 2)],
      ],
      rowHeaders: true,
    },
    { caption: `Goodness-of-Fit — ${label(meta, variable)}` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Chi-Square', f(r.n1('chisq'), 3)],
        ['df', int(r.n1('df'))],
        ['Asymp. Sig.', fmtP(r.n1('p'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Test Statistics' },
  );
}

export async function oneProp(app, { variable, p0, category, weight }) {
  if (!variable) return void app.results.appendError('Pick a variable.');
  const meta = metaMap(await app.data.getVariableMeta());
  const test = Number.isFinite(p0) ? p0 : 0.5;
  // The category to test is chosen in the dialog (a `level` input). Inlined as an R
  // string literal; when absent (e.g. an older script) fall back to the second level,
  // which is what this test tested before the picker existed — so old logs replay the
  // same. The test then compares THIS category's share against the test proportion.
  const want = category != null ? JSON.stringify(String(category)) : 'NULL';
  // Unweighted (or all-1 weights) → the exact binomial (Clopper–Pearson CI). With a
  // frequency weight the counts are fractional, so an exact binomial isn't defined:
  // fall back to the continuity-corrected normal approximation and a Wilson-score CI —
  // SPSS's large-sample WEIGHT BY behaviour. N becomes the sum of the weights.
  const rCode = `
    v <- variable
    w <- ${weight ? 'suppressWarnings(as.numeric(weight))' : 'rep(1, length(v))'}
    ok <- !is.na(v) & is.finite(w) & w > 0; v <- v[ok]; w <- w[ok]
    xf <- as.factor(v)
    if (nlevels(xf) != 2) stop("need a variable with exactly 2 categories")
    levs <- levels(xf)
    want <- ${want}
    lv <- if (!is.null(want) && nzchar(want) && want %in% levs) want else levs[2]
    inCat <- as.character(xf) == lv
    wN <- sum(w); wsucc <- sum(w[inCat]); phat <- wsucc / wN
    p0 <- ${test}
    counts <- sapply(levs, function(k) sum(w[as.character(xf) == k]))
    exact <- isTRUE(all.equal(w, rep(1, length(w))))
    if (exact) {
      bt <- binom.test(round(wsucc), round(wN), p = p0)
      ciLo <- bt$conf.int[1]; ciHi <- bt$conf.int[2]; pval <- bt$p.value
    } else {
      # continuity-corrected normal approximation of the binomial (2-tailed)
      mu0 <- wN * p0; sigma <- sqrt(wN * p0 * (1 - p0))
      cc <- max(0, abs(wsucc - mu0) - 0.5)
      z <- if (sigma > 0) cc / sigma else 0
      pval <- 2 * pnorm(-z)
      # Wilson score interval — better than Wald near 0/1, uses the weighted N
      zc <- qnorm(0.975); den <- 1 + zc^2 / wN
      ctr <- (phat + zc^2 / (2 * wN)) / den
      hlf <- zc * sqrt(phat * (1 - phat) / wN + zc^2 / (4 * wN^2)) / den
      ciLo <- ctr - hlf; ciHi <- ctr + hlf
    }
    list(level = lv, succ = wsucc, n = wN, phat = phat,
         ciLo = ciLo, ciHi = ciHi, p = pval, exact = exact,
         levels = levs, counts = as.numeric(counts))`;
  const r = flat((await app.webr.run(rCode)).result);
  const levels = r.str('levels');
  const counts = r.num('counts');
  const exact = r.n1('exact') === 1;
  const ws = wSuffix(meta, weight);
  await app.results.appendTable(
    {
      columns: ['Category', 'Count'],
      rows: levels.map((lv, i) => [vlab(meta, variable, lv), int(counts[i])]),
      rowHeaders: true,
    },
    { caption: `${label(meta, variable)}${ws}` },
  );
  const lvl = vlab(meta, variable, r.s1('level'));
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        [`Proportion "${lvl}"`, f(r.n1('phat'), 3)],
        ['N', int(r.n1('n'))],
        ['Test proportion', f(test, 3)],
        ['95% CI', ci(r.n1('ciLo'), r.n1('ciHi'))],
        [exact ? 'Exact Sig. (binomial)' : 'Asymp. Sig. (2-tailed)', fmtP(r.n1('p'))],
      ],
      rowHeaders: true,
    },
    { caption: `One-Proportion Test${ws}` },
  );
  if (!exact) {
    await app.results.appendText(
      `_Weighted by ${weightLabel(meta, weight)}: N is the sum of the weights, not a head count. ` +
        'With a frequency weight the exact binomial is undefined (fractional counts), so this uses the ' +
        'continuity-corrected normal approximation and a Wilson-score CI — SPSS’s large-sample method._',
    );
  }
}

export async function twoProp(app, { outcome, groups }) {
  if (!outcome || !groups) return void app.results.appendError('Pick a binary outcome and a 2-group variable.');
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    y <- as.factor(outcome); g <- as.factor(groups)
    ok <- !is.na(y) & !is.na(g); y <- droplevels(y[ok]); g <- droplevels(g[ok])
    if (nlevels(g) != 2 || nlevels(y) != 2) stop("need a 2-category outcome and exactly 2 groups")
    tab <- table(g, y); succ <- tab[, 2]; nn <- rowSums(tab)
    pt <- suppressWarnings(prop.test(as.integer(succ), as.integer(nn)))
    list(groups = rownames(tab), succLevel = colnames(tab)[2], succ = as.integer(succ), n = as.integer(nn),
         p1 = unname(pt$estimate[1]), p2 = unname(pt$estimate[2]),
         chisq = unname(pt$statistic), df = unname(pt$parameter), p = pt$p.value,
         ciLo = pt$conf.int[1], ciHi = pt$conf.int[2])`;
  const r = flat((await app.webr.run(rCode)).result);
  const grps = r.str('groups');
  const succ = r.num('succ');
  const nn = r.num('n');
  const props = [r.n1('p1'), r.n1('p2')];
  const succLevel = vlab(meta, outcome, r.s1('succLevel'));
  await app.results.appendTable(
    {
      columns: ['Group', 'N', `"${succLevel}"`, 'Proportion'],
      rows: grps.map((gl, i) => [vlab(meta, groups, gl), int(nn[i]), int(succ[i]), f(props[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Proportion of "${succLevel}" by ${label(meta, groups)}` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Difference in proportions', f(props[0] - props[1], 3)],
        ['Chi-Square (1 df, corrected)', f(r.n1('chisq'), 3)],
        ['Asymp. Sig.', fmtP(r.n1('p'))],
        ['95% CI of difference', ci(r.n1('ciLo'), r.n1('ciHi'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Two-Proportion Test' },
  );
}

export async function mcnemar(app, { v1, v2 }) {
  if (!v1 || !v2) return void app.results.appendError("McNemar's test needs two variables.");
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    a <- as.factor(v1); b <- as.factor(v2)
    ok <- !is.na(a) & !is.na(b); a <- droplevels(a[ok]); b <- droplevels(b[ok])
    tab <- table(a, b)
    if (nrow(tab) != 2 || ncol(tab) != 2) stop("McNemar needs two 2-category variables")
    mc <- mcnemar.test(tab, correct = TRUE)
    list(rl = rownames(tab), cl = colnames(tab), counts = as.integer(t(tab)),
         chisq = unname(mc$statistic), df = unname(mc$parameter), p = mc$p.value)`;
  const r = flat((await app.webr.run(rCode)).result);
  const rl = r.str('rl');
  const cl = r.str('cl');
  const counts = r.num('counts'); // row-major: counts[i*2 + j]
  await app.results.appendTable(
    {
      columns: ['', ...cl.map((c) => vlab(meta, v2, c))],
      rows: rl.map((rv, i) => [vlab(meta, v1, rv), ...cl.map((_, j) => int(counts[i * cl.length + j]))]),
      rowHeaders: true,
    },
    { caption: `${label(meta, v1)} × ${label(meta, v2)}` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ["McNemar's Chi-Square (corrected)", f(r.n1('chisq'), 3)],
        ['df', int(r.n1('df'))],
        ['Asymp. Sig.', fmtP(r.n1('p'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Test Statistics' },
  );
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function vlab(meta, name, code) {
  return meta.get(name)?.valueLabels?.[code] ?? code;
}
/** The variable's label (or bare name) for the weight, and the " — weighted by X"
 * caption suffix so no result is ambiguous about which population it describes. */
function weightLabel(meta, weight) {
  return weight ? meta.get(weight)?.label ?? weight : '';
}
function wSuffix(meta, weight) {
  return weight ? ` — weighted by ${weightLabel(meta, weight)}` : '';
}
function parseProps(s) {
  return String(s || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
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
    str: (k) => arr(byName[k]).map((x) => (x == null ? '' : String(x))),
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? (a[0] == null ? NaN : Number(a[0])) : NaN;
    },
    s1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0] ?? '') : '';
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
const ci = (lo, hi) => (Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—');
