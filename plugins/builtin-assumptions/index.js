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
  rPackages: ['svglite'],
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
  // data.frame, then recode each column's user-missing codes by position.
  const recode = names
    .map((nm, i) => {
      const mv = missing(meta, nm);
      return mv.length ? `d[[${i + 1}]][d[[${i + 1}]] %in% c(${mv})] <- NA` : '';
    })
    .filter(Boolean)
    .join('\n');

  const rCode = `
    d <- if (is.data.frame(vars)) vars else data.frame(v = vars)
    ${recode}
    library(svglite)
    stat <- function(col) {
      x <- suppressWarnings(as.numeric(col)); x <- x[is.finite(x)]; n <- length(x)
      if (n < 3) return(list(n = n, skew = NA_real_, kurt = NA_real_, W = NA_real_, p = NA_real_, svg = ""))
      m <- mean(x); s2 <- sum((x - m)^2) / n
      skew <- (sum((x - m)^3) / n) / s2^1.5
      kurt <- (sum((x - m)^4) / n) / s2^2 - 3
      sw <- if (n <= 5000) shapiro.test(x) else list(statistic = NA_real_, p.value = NA_real_)
      .dev <- svgstring(width = 5, height = 3.4, pointsize = 10)
      par(mar = c(4, 4, 1.4, 1))
      qqnorm(x, main = "", pch = 19, col = "#2980b9", cex = 0.7)
      qqline(x, col = "#999999", lty = 2)
      dev.off()
      list(n = n, skew = skew, kurt = kurt, W = unname(sw$statistic), p = sw$p.value, svg = .dev())
    }
    res <- lapply(d, stat)
    list(
      n = sapply(res, \`[[\`, "n"), skew = sapply(res, \`[[\`, "skew"), kurt = sapply(res, \`[[\`, "kurt"),
      W = sapply(res, \`[[\`, "W"), p = sapply(res, \`[[\`, "p"), svg = sapply(res, \`[[\`, "svg")
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

  const svgs = r.str('svg');
  for (let i = 0; i < names.length; i++) {
    if (!/<svg[\s>]/i.test(svgs[i] || '')) continue;
    await app.results.appendText(`**Q–Q plot — ${label(meta, names[i])}**`);
    await app.results.appendPlot(stripSize(svgs[i]));
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
  const recodeY = missing(meta, outcome);
  const rCode = `
    y <- suppressWarnings(as.numeric(outcome))
    ${recodeY.length ? `y[y %in% c(${recodeY})] <- NA` : ''}
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
function missing(meta, name) {
  return (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
}
/** svglite emits a fixed pt width/height; drop them so the plot fills its box. */
function stripSize(svg) {
  return svg.replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
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
