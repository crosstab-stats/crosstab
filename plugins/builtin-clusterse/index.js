/**
 * @file plugins/builtin-clusterse/index.js
 * Built-in plugin: **cluster-robust regression** — OLS with standard errors that
 * allow for arbitrary correlation *within* clusters (students in schools,
 * repeated obs on the same person/firm/country, villages in an RCT). Ignoring
 * clustering badly understates SEs; this is the standard fix in applied micro and
 * field experiments. Uses `sandwich::vcovCL` (CR / HC1 small-sample correction)
 * with `lmtest::coeftest`.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fixed: f, labelOf, metaMap, rStr, unpackR: flat, prettyTerm } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-clusterse',
  name: 'Cluster-robust regression',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['cluster', 'cluster-robust', 'clustered standard errors', 'crve', 'sandwich', 'vcovcl', 'panel', 'robust'],
  disciplines: ['Economics', 'Political Science', 'Public Policy & Administration'],
  howto:
    'GUI: Regression ▸ Cluster-robust regression, then pick an outcome, predictors, and a cluster variable. You get OLS coefficients with cluster-robust (CR/HC1) standard errors alongside classical SEs.\n' +
    'Syntax: run builtin-clusterse.run {"y": "score", "ivs": ["x", "z"], "cluster": "school"}\n' +
    '  • y — the numeric outcome to explain.\n' +
    '  • ivs — one or more predictors.\n' +
    '  • cluster — the grouping variable (e.g. school or person) SEs allow correlation within.',
  rPackages: ['sandwich', 'lmtest'],
  menu: [
    {
      label: 'Cluster-robust regression…',
      run: 'run',
      order: 65,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The numeric outcome you want to explain.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
        { name: 'cluster', kind: 'variables', label: 'Cluster variable', hint: 'The group cases fall into, like school or person.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
  ],
};

export async function run(app, { y: yName, ivs: ivNames, cluster: clName }) {
  if (!yName || !ivNames || !ivNames.length || !clName) {
    await app.results.appendError('Cluster-robust regression: choose an outcome, predictor(s), and a cluster variable.');
    return;
  }
  await app.webr.installPackages(['sandwich', 'lmtest']);
  const meta = metaMap(await app.data.getVariableMeta());
  const term = (n) => (meta.get(n)?.categorical ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.y ~ ${ivNames.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages({library(sandwich); library(lmtest)})
    d <- data.frame(.y = as.numeric(y), .cl = as.factor(cluster)); d <- cbind(d, ivs)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- lm(as.formula(${rStr(formula)}), data = d)
    cl <- coeftest(fit, vcov = vcovCL(fit, cluster = d$.cl, type = "HC1"))
    classic <- summary(fit)$coefficients
    list(terms = rownames(cl), est = cl[, 1], se = cl[, 2], t = cl[, 3], p = cl[, 4],
         seClassic = classic[, 2], n = nrow(d), nclust = nlevels(d$.cl))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('t'), p = r.nums('p'), seC = r.nums('seClassic');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Cluster-robust SE', 't', 'Sig.', '(Classical SE)'],
      rows: terms.map((t, i) => [t === '(Intercept)' ? '(Constant)' : prettyTerm(t), f(est[i], 4), f(se[i], 4), f(tv[i], 2), fmtP(p[i]), f(seC[i], 4)]),
      rowHeaders: true,
    },
    { caption: `Cluster-Robust OLS — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num1('n')}, clusters = ${r.num1('nclust')})` },
  );
  await app.results.appendText(
    `Standard errors allow for arbitrary correlation within the **${r.num1('nclust')}** clusters of ${labelOf(meta.get(clName), clName)} (CR/HC1). Compare them to the classical SEs in the last column — cluster-robust SEs are usually larger, and the difference is the cost of ignoring clustering. With few clusters (< ~40) the asymptotics get shaky; treat p-values cautiously.`,
  );
}

// --- helpers -----------------------------------------------------------------
