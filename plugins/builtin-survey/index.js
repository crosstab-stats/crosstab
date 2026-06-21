/**
 * @file plugins/builtin-survey/index.js
 * Built-in plugin: the **Survey** menu — complex-survey analysis with
 * design-correct standard errors (the `survey` package).
 *
 * The big public datasets social scientists use — GSS, NHANES, ANES — are
 * weighted, stratified, clustered samples. Analyzing them unweighted gives the
 * wrong population estimates; ignoring the design gives wrong (too-small) SEs.
 * Each action here builds a `svydesign` from a **weight** (required) plus optional
 * **strata** and **cluster/PSU** ids, then runs the survey-aware estimator:
 *  - **Weighted means** — `svymean` (mean + design SE + 95% CI), vs the unweighted
 *    mean for comparison
 *  - **Weighted crosstab** — `svytable` weighted counts + Rao-Scott `svychisq`
 *  - **Survey regression** — `svyglm` (linear or logistic, with odds ratios)
 *
 * Stateless + reproducible by design: each analysis carries its own design inputs
 * (no hidden global "weight by" state), so every result documents the design used
 * and exports faithfully. User-missing codes are recoded to NA first; non-positive
 * /missing weights drop the case.
 */

/** Shared design inputs appended to every action: weight (required) + optional
 * strata and cluster/PSU. `unique` so they don't clash with the analysis vars. */
const DESIGN_INPUTS = [
  { name: 'weight', kind: 'variables', label: 'Weight variable', multiple: false, types: ['numeric'], unique: true },
  { name: 'strata', kind: 'variables', label: 'Strata (optional)', multiple: false, optional: true, unique: true },
  { name: 'cluster', kind: 'variables', label: 'Cluster / PSU id (optional)', multiple: false, optional: true, unique: true },
];

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-survey',
  name: 'Survey',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Survey',
  keywords: ['survey', 'weights', 'complex sample', 'svydesign', 'svyglm', 'strata', 'cluster', 'gss', 'nhanes', 'anes'],
  disciplines: ['Sociology', 'Political Science', 'Public Health'],
  rPackages: ['survey'],
  menu: [
    {
      label: 'Weighted means…',
      run: 'means',
      order: 10,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables (numeric)', multiple: true, types: ['numeric'], unique: true },
        ...DESIGN_INPUTS,
      ],
    },
    {
      label: 'Weighted crosstab…',
      run: 'crosstab',
      order: 20,
      inputs: [
        { name: 'rowvar', kind: 'variables', label: 'Row variable', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'colvar', kind: 'variables', label: 'Column variable', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        ...DESIGN_INPUTS,
      ],
    },
    {
      label: 'Survey regression…',
      run: 'regression',
      order: 30,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
        {
          name: 'family',
          kind: 'choice',
          label: 'Model',
          default: 'linear',
          options: [
            { value: 'linear', label: 'Linear' },
            { value: 'logistic', label: 'Logistic (binary outcome)' },
          ],
        },
        ...DESIGN_INPUTS,
      ],
    },
  ],
};

// --- Weighted means (svymean) ------------------------------------------------

/**
 * @param {object} app
 * @param {{vars: string[], weight: string, strata: ?string, cluster: ?string}} inputs
 */
export async function means(app, { vars, weight, strata, cluster }) {
  if (!vars || !vars.length || !weight) {
    await app.results.appendError('Weighted means: choose at least one numeric variable and a weight.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = vars.map((n) => recodeLine(`vars[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const fml = `~ ${vars.map((n) => `\`${n}\``).join(' + ')}`;
  const rCode = `
    suppressMessages(library(survey))
    ${recodes}
    d <- vars
    d[[".w"]] <- as.numeric(weight)
    ${strata ? 'd[[".st"]] <- strata' : ''}
    ${cluster ? 'd[[".cl"]] <- cluster' : ''}
    d <- d[is.finite(d[[".w"]]) & d[[".w"]] > 0, , drop = FALSE]
    if (nrow(d) < 2) stop("not enough cases with a positive weight")
    des <- ${svydesignCall(strata, cluster)}
    m <- svymean(as.formula(${rStr(fml)}), des, na.rm = TRUE)
    ci <- confint(m)
    nm <- c(${vars.map(rStr).join(', ')})
    list(terms = nm, mean = as.numeric(coef(m)), se = as.numeric(SE(m)),
         lo = as.numeric(ci[, 1]), hi = as.numeric(ci[, 2]),
         uw = sapply(nm, function(v) mean(d[[v]], na.rm = TRUE)), n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), mean = r.nums('mean'), se = r.nums('se'), lo = r.nums('lo'), hi = r.nums('hi'), uw = r.nums('uw');
  await app.results.appendTable(
    {
      columns: ['Variable', 'Weighted mean', 'SE', '95% CI', 'Unweighted mean'],
      rows: terms.map((t, i) => [labelOf(meta.get(t), t), f(mean[i], 3), f(se[i], 3), ci(lo[i], hi[i]), f(uw[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Weighted Means — ${designCaption(meta, weight, strata, cluster)} (N = ${r.num('n')})` },
  );
  await app.results.appendText(
    'Estimates use the survey weights; standard errors and CIs account for the design (weights' +
      (strata ? ' + strata' : '') + (cluster ? ' + clusters' : '') + '). The unweighted mean is shown for comparison.',
  );
}

// --- Weighted crosstab (svytable + svychisq) ---------------------------------

/**
 * @param {object} app
 * @param {{rowvar: string, colvar: string, weight: string, strata: ?string, cluster: ?string}} inputs
 */
export async function crosstab(app, { rowvar, colvar, weight, strata, cluster }) {
  if (!rowvar || !colvar || !weight) {
    await app.results.appendError('Weighted crosstab: choose a row, a column, and a weight.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    suppressMessages(library(survey))
    ${recodeLine('rowvar', meta.get(rowvar))}
    ${recodeLine('colvar', meta.get(colvar))}
    d <- data.frame(.r = as.factor(rowvar), .c = as.factor(colvar), .w = as.numeric(weight)${strata ? ', .st = strata' : ''}${cluster ? ', .cl = cluster' : ''})
    d <- d[is.finite(d$.w) & d$.w > 0 & !is.na(d$.r) & !is.na(d$.c), , drop = FALSE]
    if (nrow(d) < 2) stop("not enough complete, positively-weighted cases")
    des <- ${svydesignCall(strata, cluster)}
    tab <- svytable(~ .r + .c, des)
    ch <- svychisq(~ .r + .c, des)
    list(rowLevels = rownames(tab), colLevels = colnames(tab), counts = as.numeric(t(tab)),
         rowTotals = as.numeric(rowSums(tab)), colTotals = as.numeric(colSums(tab)), total = sum(tab),
         Fstat = unname(ch$statistic), ndf = unname(ch$parameter[1]), ddf = unname(ch$parameter[2]),
         p = ch$p.value, n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const rl = r.strs('rowLevels'), cl = r.strs('colLevels'), counts = r.nums('counts');
  const rt = r.nums('rowTotals'), ct = r.nums('colTotals');
  const lv = (m, code) => m?.valueLabels?.[code] ?? code;
  const nc = cl.length;
  const rows = rl.map((rr, i) => [lv(meta.get(rowvar), rr), ...cl.map((_, j) => Math.round(counts[i * nc + j] ?? 0)), Math.round(rt[i])]);
  rows.push(['Total', ...ct.map((v) => Math.round(v)), Math.round(r.num('total'))]);
  await app.results.appendTable(
    { columns: ['', ...cl.map((c) => lv(meta.get(colvar), c)), 'Total'], rows, rowHeaders: true },
    { caption: `Weighted counts — ${labelOf(meta.get(rowvar), rowvar)} × ${labelOf(meta.get(colvar), colvar)}` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'F', 'num df', 'den df', 'Sig.'],
      rows: [['Rao-Scott Chi-Square', f(r.num('Fstat'), 3), f(r.num('ndf'), 2), f(r.num('ddf'), 1), fmtP(r.num('p'))]],
      rowHeaders: true,
    },
    { caption: `Design-Based Test of Independence (N = ${r.num('n')})` },
  );
  await app.results.appendText('Counts are weighted (sums of survey weights). The Rao-Scott test is the design-corrected analogue of the Pearson chi-square.');
}

// --- Survey regression (svyglm) ----------------------------------------------

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[], family: string, weight: string, strata: ?string, cluster: ?string}} inputs
 */
export async function regression(app, { dv, ivs, family, weight, strata, cluster }) {
  if (!dv || !ivs || !ivs.length || !weight) {
    await app.results.appendError('Survey regression: choose an outcome, predictor(s), and a weight.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const logistic = family === 'logistic';
  const recodes = [recodeLine('dv', meta.get(dv)), ...ivs.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n)))].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.dv ~ ${ivs.map(term).join(' + ')}`;
  const rCode = `
    suppressMessages(library(survey))
    ${recodes}
    dv <- as.numeric(dv)
    ${logistic ? 'dv <- as.numeric(dv == max(dv, na.rm = TRUE))  # model the higher category as 1' : ''}
    d <- cbind(.dv = dv, ivs)
    d[[".w"]] <- as.numeric(weight)
    ${strata ? 'd[[".st"]] <- strata' : ''}
    ${cluster ? 'd[[".cl"]] <- cluster' : ''}
    d <- d[is.finite(d[[".w"]]) & d[[".w"]] > 0, , drop = FALSE]
    des <- ${svydesignCall(strata, cluster)}
    fit <- svyglm(as.formula(${rStr(formula)}), design = des, family = ${logistic ? 'quasibinomial()' : 'gaussian()'})
    s <- summary(fit); co <- s$coefficients
    ci <- tryCatch(confint(fit), error = function(e) matrix(NA_real_, nrow(co), 2))
    list(terms = rownames(co), est = co[, 1], se = co[, 2], tval = co[, 3], p = co[, 4],
         lo = ci[, 1], hi = ci[, 2], n = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('tval'), p = r.nums('p'), lo = r.nums('lo'), hi = r.nums('hi');
  const cols = logistic
    ? ['', 'B', 'Std. Error', 't', 'Sig.', 'Odds ratio', '95% CI (OR)']
    : ['', 'B', 'Std. Error', 't', 'Sig.', '95% CI'];
  await app.results.appendTable(
    {
      columns: cols,
      rows: terms.map((t, i) => {
        const base = [t === '(Intercept)' ? '(Constant)' : prettyTerm(t), f(est[i], 3), f(se[i], 3), f(tv[i], 3), fmtP(p[i])];
        return logistic
          ? [...base, f(Math.exp(est[i]), 3), ci(Math.exp(lo[i]), Math.exp(hi[i]))]
          : [...base, ci(lo[i], hi[i])];
      }),
      rowHeaders: true,
    },
    { caption: `Survey ${logistic ? 'Logistic ' : ''}Regression — outcome: ${labelOf(meta.get(dv), dv)} (N = ${r.num('n')})` },
  );
  await app.results.appendText(
    `Coefficients and standard errors are design-based (${designCaption(meta, weight, strata, cluster)}). ` +
      (logistic ? 'Odds ratios are exp(B); the higher category of the outcome is modelled as 1.' : ''),
  );
}

// --- helpers -----------------------------------------------------------------

/** Build the svydesign() call given which optional design pieces were chosen. */
function svydesignCall(strata, cluster) {
  const ids = cluster ? '~`.cl`' : '~1';
  const st = strata ? 'strata = ~`.st`, ' : '';
  return `svydesign(ids = ${ids}, ${st}weights = ~\`.w\`, data = d, nest = TRUE)`;
}

function designCaption(meta, weight, strata, cluster) {
  const parts = [`weight: ${labelOf(meta.get(weight), weight)}`];
  if (strata) parts.push(`strata: ${strata}`);
  if (cluster) parts.push(`clusters: ${cluster}`);
  return parts.join(', ');
}

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
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

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map(Number),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
