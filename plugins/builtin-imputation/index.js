/**
 * @file plugins/builtin-imputation/index.js
 * Built-in plugin: **multiple imputation** (mice) — the principled way to handle
 * missing data / attrition instead of dropping incomplete cases. Imputes the
 * missing values m times, fits the regression on each completed dataset, and
 * pools the results with Rubin's rules — reporting the fraction of missing
 * information (FMI) so you can see how much the missingness cost you.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fixed: f, ci, labelOf, metaMap, rStr, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-imputation',
  name: 'Multiple imputation',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['multiple imputation', 'mice', 'missing data', 'attrition', 'rubin', 'fmi', 'pooled', 'pmm'],
  disciplines: ['Public Health', 'Sociology', 'Psychology', 'Gerontology'],
  howto:
    'GUI: Regression ▸ Multiple imputation regression…, then pick the outcome and predictors and set the number of imputations. You get pooled (Rubin) coefficients with FMI plus a missingness table.\n' +
    'Syntax: run builtin-imputation.run {"y": "income", "ivs": ["educ", "age"], "m": 5, "model": "linear"}\n' +
    '  • y — numeric outcome.\n' +
    '  • ivs — one or more predictors.\n' +
    '  • m — number of imputations (default 5).\n' +
    '  • model — "linear" (default) | "logistic".',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'imputation-mi',
      title: 'Multiple imputation regression',
      category: 'Regression',
      keywords: ['imputation', 'missing data', 'multiple imputation', 'rubin', 'pooled', 'fmi', 'listwise', 'incomplete'],
      needs: ['builtin-imputation'],
      seeAlso: ['regression-linear', 'variable-types'],
    },
  ],
  rPackages: ['mice'],
  menu: [
    {
      howto: 'imputation-mi',
      label: 'Multiple imputation regression…',
      run: 'run',
      order: 180,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', hint: 'The outcome to model, even where it has missing values.', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
        { name: 'm', kind: 'number', label: 'Number of imputations (m)', hint: 'How many filled-in datasets to make; 5 is a common start.', default: 5 },
        { name: 'model', kind: 'choice', label: 'Model', hint: 'Pick linear for a numeric outcome, logistic for yes/no.', default: 'linear', options: [
          { value: 'linear', label: 'Linear (OLS)' },
          { value: 'logistic', label: 'Logistic (binary outcome)' },
        ] },
      ],
    },
  ],
};

export async function run(app, { y: yName, ivs: ivNames, m, model }) {
  if (!yName || !ivNames || !ivNames.length) {
    await app.results.appendError('Multiple imputation: choose an outcome and at least one predictor.');
    return;
  }
  await app.webr.installPackages(['mice']);
  const meta = metaMap(await app.data.getVariableMeta());
  const M = Number.isFinite(m) && m >= 2 ? Math.floor(m) : 5;
  const logistic = model === 'logistic';
  const tok = ivNames.map((_, i) => `V${i + 1}`);
  const mk = ivNames.map((n, i) => {
    const fac = meta.get(n)?.categorical;
    return `d$${tok[i]} <- ${fac ? `as.factor(ivs[[${rStr(n)}]])` : `as.numeric(ivs[[${rStr(n)}]])`}`;
  }).join('\n');
  const rhs = tok.join(' + ');
  const fitCall = logistic ? `glm(.y ~ ${rhs}, family = binomial())` : `lm(.y ~ ${rhs})`;
  const rCode = `
    suppressMessages(library(mice))
    d <- data.frame(.y = ${logistic ? 'as.integer(as.numeric(y))' : 'as.numeric(y)'})
    ${mk}
    miss <- colSums(is.na(d)); nrow_all <- nrow(d); ncc <- sum(stats::complete.cases(d))
    imp <- mice(d, m = ${M}, printFlag = FALSE, seed = 1)
    fit <- with(imp, ${fitCall})
    po <- pool(fit); ps <- summary(po, conf.int = TRUE)
    pooled <- po$pooled
    list(terms = as.character(ps$term), est = ps$estimate, se = ps$std.error, t = ps$statistic,
         df = ps$df, p = ps$p.value, lo = ps[["2.5 %"]], hi = ps[["97.5 %"]],
         fmi = pooled$fmi, lambda = pooled$lambda,
         missVars = names(miss), missN = as.integer(miss), nrowAll = nrow_all, ncc = ncc,
         logistic = ${logistic ? 'TRUE' : 'FALSE'})`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('t'), df = r.nums('df'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi'), fmi = r.nums('fmi');

  const cols = logistic
    ? ['', 'B', 'Std. Error', 'df', 'Sig.', 'OR', '95% CI (OR)', 'FMI']
    : ['', 'B', 'Std. Error', 'df', 'Sig.', '95% CI', 'FMI'];
  await app.results.appendTable(
    {
      columns: cols,
      rows: terms.map((t, i) => {
        const base = [t === '(Intercept)' ? '(Constant)' : prettyTermTok(t, ivNames, meta), f(est[i], 4), f(se[i], 4), f(df[i], 1), fmtP(p[i])];
        if (logistic) base.push(f(Math.exp(est[i]), 3), ci(Math.exp(lo[i]), Math.exp(hi[i])));
        else base.push(ci(lo[i], hi[i]));
        base.push(f(fmi[i], 3));
        return base;
      }),
      rowHeaders: true,
    },
    { caption: `Multiple Imputation (${logistic ? 'logistic' : 'linear'}, m = ${M}) — outcome: ${labelOf(meta.get(yName), yName)}` },
  );

  const mv = r.strs('missVars'), mn = r.nums('missN');
  const nAll = r.num1('nrowAll');
  await app.results.appendTable(
    {
      columns: ['Variable', 'Missing', '% missing'],
      rows: mv.map((v, i) => [v === '.y' ? labelOf(meta.get(yName), yName) : varName(v, ivNames, meta), String(mn[i]), `${((100 * mn[i]) / nAll).toFixed(1)}%`]),
      rowHeaders: true,
    },
    { caption: `Missingness (N = ${nAll}; ${r.num1('ncc')} complete cases)` },
  );
  await app.results.appendText(
    'Estimates are pooled across the imputations by **Rubin\'s rules** (so the SEs include the extra uncertainty from imputing). **FMI** is the fraction of missing information for each coefficient — high FMI means that estimate leans heavily on imputed values. MI assumes data are **missing at random** (MAR) given the variables in the model.',
  );
}

// --- helpers -----------------------------------------------------------------

function varName(tok, ivNames, meta) {
  const m = /^V(\d+)$/.exec(tok);
  return m && ivNames[+m[1] - 1] != null ? labelOf(meta.get(ivNames[+m[1] - 1]), ivNames[+m[1] - 1]) : tok;
}
function prettyTermTok(term, ivNames, meta) {
  const m = /^V(\d+)(.*)$/.exec(term);
  if (m && ivNames[+m[1] - 1] != null) return `${labelOf(meta.get(ivNames[+m[1] - 1]), ivNames[+m[1] - 1])}${m[2] ? ` = ${m[2]}` : ''}`;
  return term;
}
