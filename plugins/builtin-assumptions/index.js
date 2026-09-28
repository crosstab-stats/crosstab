/**
 * @file plugins/builtin-assumptions/index.js
 * Built-in plugin: Assumptions ▸ the checks you run *before* a t-test / ANOVA /
 * regression — normality and homogeneity of variance.
 *
 * - **Normality (Shapiro–Wilk)** per variable, with skewness, excess kurtosis,
 *   and a Q–Q plot (the thing textbooks show next to the test).
 * - **Homogeneity of variance (Levene's test)**, median-centred (Brown–Forsythe),
 *   the robust default — no `car` dependency, computed as an ANOVA on absolute
 *   deviations from each group's median.
 *
 * User-missing codes are recoded to NA; analysis is on the finite values.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-assumptions',
  name: 'Assumption Checks',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Assumptions',
  keywords: ['normality', 'shapiro', 'levene', 'homogeneity', 'variance', 'q-q', 'qq plot', 'assumptions', 'skewness', 'kurtosis'],
  disciplines: ['Economics', 'Political Science', 'Psychology', 'Social Science'],
  howto:
    'GUI: Assumptions ▸ Normality (Shapiro–Wilk), pick numeric variables; you get Shapiro–Wilk, skewness, kurtosis, and a Q–Q plot per variable. Or Assumptions ▸ Homogeneity of variance (Levene\'s) to compare spread across groups.\n' +
    'Syntax: run builtin-assumptions.normality {"vars": ["income", "age"]}\n' +
    'Syntax: run builtin-assumptions.levene {"outcome": "income", "groups": "region"}\n' +
    '  • vars — the numeric variables to check for normality.\n' +
    '  • outcome / groups — the numeric measure and the variable defining the groups.',
  // Nothing to install: the Q–Q plots are chart models now, drawn by the host. The offline
  // cache pre-fetches the R packages of enabled plugins, so a stale entry here is a
  // download every user pays for.
  rPackages: [],
  menu: [
    {
      label: 'Normality (Shapiro–Wilk)…',
      run: 'normality',
      order: 10,
      inputs: [{ name: 'vars', kind: 'variables', label: 'Variables', hint: 'The numeric variables to check for a normal distribution.', multiple: true, types: ['numeric'] }],
    },
    {
      label: "Homogeneity of variance (Levene's)…",
      run: 'levene',
      order: 20,
      inputs: [
        { name: 'outcome', kind: 'variables', label: 'Outcome', hint: 'The numeric measure whose spread you want to compare across groups.', types: ['numeric'] },
        { name: 'groups', kind: 'variables', label: 'Groups', hint: 'The variable that sorts cases into the groups being compared.', types: ['factor', 'string', 'numeric'] },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function normality(app, { vars }) {
  const names = Array.isArray(vars) ? vars : vars ? [vars] : [];
  if (!names.length) {
    await app.results.appendError('Pick at least one variable.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());

  // Coerce the binding (vector for one var, data.frame for several) to a uniform
  // data.frame.
  const rCode = `
    d <- if (is.data.frame(vars)) vars else data.frame(v = vars)
    # NUMBERS, not a picture (#131). qqnorm(plot.it = FALSE) hands back the very x/y it would
    # have plotted, and qqline's line is the one through the first and third quartiles — so the
    # host can draw this, which buys live controls, the palette and re-editability, and drops
    # this plugin's svglite dependency.
    stat <- function(col) {
      x <- suppressWarnings(as.numeric(col)); x <- x[is.finite(x)]; n <- length(x)
      if (n < 3) return(list(n = n, skew = NA_real_, kurt = NA_real_, W = NA_real_, p = NA_real_,
                             qx = numeric(0), qy = numeric(0), slope = NA_real_, int = NA_real_))
      m <- mean(x); s2 <- sum((x - m)^2) / n
      skew <- (sum((x - m)^3) / n) / s2^1.5
      kurt <- (sum((x - m)^4) / n) / s2^2 - 3
      sw <- if (n <= 5000) shapiro.test(x) else list(statistic = NA_real_, p.value = NA_real_)
      qq <- qqnorm(x, plot.it = FALSE)
      qy <- quantile(x, c(0.25, 0.75), names = FALSE, type = 7)
      qx <- qnorm(c(0.25, 0.75))
      sl <- diff(qy) / diff(qx)
      list(n = n, skew = skew, kurt = kurt, W = unname(sw$statistic), p = sw$p.value,
           qx = unname(qq$x), qy = unname(qq$y), slope = sl, int = qy[1] - sl * qx[1])
    }
    res <- lapply(d, stat)
    # Points come back CONCATENATED with a 1-based variable index: each variable has a different
    # number of them, and a ragged list would not survive the flat marshalling below.
    list(
      n = sapply(res, \`[[\`, "n"), skew = sapply(res, \`[[\`, "skew"), kurt = sapply(res, \`[[\`, "kurt"),
      W = sapply(res, \`[[\`, "W"), p = sapply(res, \`[[\`, "p"),
      qqx = unlist(lapply(res, \`[[\`, "qx")), qqy = unlist(lapply(res, \`[[\`, "qy")),
      qqi = rep(seq_along(res), sapply(res, function(z) length(z$qx))),
      qqSlope = sapply(res, \`[[\`, "slope"), qqInt = sapply(res, \`[[\`, "int")
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['Variable', 'N', 'Skewness', 'Kurtosis (excess)', 'Shapiro–Wilk W', 'Sig.'],
      rows: names.map((nm, i) => [
        label(meta, nm),
        int(r.num('n')[i]),
        f(r.num('skew')[i], 3),
        f(r.num('kurt')[i], 3),
        f(r.num('W')[i], 3),
        fmtP(r.num('p')[i]),
      ]),
      rowHeaders: true,
    },
    { caption: 'Tests of Normality' },
  );
  await app.results.appendText('A significant Shapiro–Wilk (p < .05) means the data depart from normal. Read it with the Q–Q plot and the sample size in mind.');

  // One chart model per variable, split out of the concatenated points by their index.
  const qx = r.num('qqx');
  const qy = r.num('qqy');
  const qi = r.num('qqi');
  const slope = r.num('qqSlope');
  const intercept = r.num('qqInt');
  for (let i = 0; i < names.length; i++) {
    const points = [];
    for (let k = 0; k < qx.length; k++) if (qi[k] === i + 1) points.push({ x: qx[k], y: qy[k] });
    if (!points.length) continue; // fewer than 3 finite values — the table above already says so
    await app.results.appendChart({
      kind: 'scatter',
      title: `Q–Q plot — ${label(meta, names[i])}`,
      axes: { x: { title: 'Theoretical quantiles' }, y: { title: 'Sample quantiles' } },
      points,
      // The normal line is what this plot MEANS, so it is a reference rather than a trend:
      // grey, on by default, and no equation printed (see the scatter kind).
      ...(Number.isFinite(slope[i])
        ? { reference: { slope: slope[i], intercept: intercept[i], label: 'Normal line' } }
        : {}),
    });
  }
}

/**
 * @param {object} app
 * @param {{outcome: string, groups: string}} inputs
 */
export async function levene(app, { outcome, groups }) {
  if (!outcome || !groups) {
    await app.results.appendError("Levene's test needs an outcome and a grouping variable.");
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    y <- suppressWarnings(as.numeric(outcome))
    g <- as.factor(groups)
    ok <- is.finite(y) & !is.na(g)
    y <- y[ok]; g <- droplevels(g[ok])
    if (nlevels(g) < 2) stop("need at least 2 groups")
    med <- tapply(y, g, median)
    z <- abs(y - med[as.character(g)])
    a <- anova(lm(z ~ g))
    list(F = a[["F value"]][1], df1 = a[["Df"]][1], df2 = a[["Df"]][2], p = a[["Pr(>F)"]][1],
         k = nlevels(g), n = length(y))`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['', 'Levene F', 'df1', 'df2', 'Sig.'],
      rows: [
        [
          `${label(meta, outcome)} by ${label(meta, groups)}`,
          f(r.n1('F'), 3),
          int(r.n1('df1')),
          int(r.n1('df2')),
          fmtP(r.n1('p')),
        ],
      ],
      rowHeaders: true,
    },
    { caption: "Test of Homogeneity of Variance (Levene's, based on the median)" },
  );
  await app.results.appendText('A significant result (p < .05) means the groups’ variances differ — prefer the Welch/“equal variances not assumed” option.');
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
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
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
