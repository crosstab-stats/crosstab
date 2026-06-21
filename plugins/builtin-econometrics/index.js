/**
 * @file plugins/builtin-econometrics/index.js
 * Built-in plugin: Econometrics ▸ the staples a one-way ANOVA / OLS plugin
 * doesn't cover —
 *  - **Robust (HC) regression**: OLS with heteroskedasticity-consistent (HC1)
 *    standard errors (sandwich) + a Breusch–Pagan test (lmtest).
 *  - **Instrumental variables (2SLS)**: ivreg (AER) with the endogenous regressor,
 *    its instruments, and optional exogenous controls; plus the weak-instruments /
 *    Wu–Hausman / Sargan diagnostics.
 *  - **Panel regression**: fixed effects (within), random effects, or pooled, via
 *    plm, given a unit id and a time index.
 *
 * Each input is coerced to a named data.frame in R so single- vs multi-select
 * binding doesn't matter. User-missing recoded to NA; listwise.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-econometrics',
  name: 'Econometrics',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Econometrics',
  keywords: ['econometrics', 'robust', 'heteroskedasticity', 'hc', 'instrumental variables', '2sls', 'ivreg', 'panel', 'fixed effects', 'random effects', 'plm', 'breusch-pagan'],
  disciplines: ['Economics', 'Political Science'],
  rPackages: ['sandwich', 'lmtest', 'AER', 'plm'],
  menu: [
    {
      label: 'Robust (HC) regression…',
      run: 'robust',
      order: 10,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
      ],
    },
    {
      label: 'Instrumental variables (2SLS)…',
      run: 'iv',
      order: 20,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', types: ['numeric'], unique: true },
        { name: 'endog', kind: 'variables', label: 'Endogenous regressor(s)', multiple: true, unique: true },
        { name: 'instruments', kind: 'variables', label: 'Instrument(s)', multiple: true, unique: true },
        { name: 'controls', kind: 'variables', label: 'Exogenous controls (optional)', multiple: true, optional: true, unique: true },
      ],
    },
    {
      label: 'Panel regression (FE / RE)…',
      run: 'panel',
      order: 30,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
        { name: 'id', kind: 'variables', label: 'Unit id', unique: true },
        { name: 'time', kind: 'variables', label: 'Time index', unique: true },
        {
          name: 'model',
          kind: 'choice',
          label: 'Model',
          options: [
            { value: 'within', label: 'Fixed effects (within)' },
            { value: 'random', label: 'Random effects' },
            { value: 'pooling', label: 'Pooled OLS' },
          ],
          default: 'within',
        },
      ],
    },
  ],
};

export async function robust(app, { dv, ivs }) {
  const ivNames = asArr(ivs);
  if (!dv || !ivNames.length) return void app.results.appendError('Pick an outcome and at least one predictor.');
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    .ivs <- as.data.frame(ivs, check.names = FALSE); names(.ivs) <- ${rNames(ivNames)}
    d <- data.frame(.y = dv, .ivs, check.names = FALSE)
    ${recodeCol('d[[".y"]]', missing(meta, dv))}
    ${ivNames.map((n) => recodeCol(`d[[${rStr(n)}]]`, missing(meta, n))).filter(Boolean).join('\n')}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- lm(as.formula(${rStr(`.y ~ ${ivNames.map((n) => term(meta, n)).join(' + ')}`)}), data = d)
    library(sandwich); library(lmtest)
    rob <- coeftest(fit, vcov = vcovHC(fit, type = "HC1"))
    bp <- bptest(fit)
    list(terms = rownames(rob), est = rob[, 1], se = rob[, 2], t = rob[, 3], p = rob[, 4],
         bpStat = unname(bp$statistic), bpDf = unname(bp$parameter), bpP = bp$p.value,
         r2 = summary(fit)$r.squared, n = nrow(d))`;
  const r = flat((await app.webr.run(rCode)).result);
  await coeffTable(app, meta, r, `Robust (HC1) Coefficients — dependent: ${label(meta, dv)} (N = ${int(r.n1('n'))})`);
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['R Square', f(r.n1('r2'), 3)],
        ['Breusch–Pagan χ²', f(r.n1('bpStat'), 3)],
        ['BP df', int(r.n1('bpDf'))],
        ['BP Sig.', fmtP(r.n1('bpP'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Model / heteroskedasticity (Breusch–Pagan H₀: homoskedastic)' },
  );
  await app.results.appendText('Standard errors are heteroskedasticity-consistent (HC1). A significant Breusch–Pagan (p < .05) confirms heteroskedasticity — which is exactly what robust SEs guard against.');
}

export async function iv(app, { dv, endog, instruments, controls }) {
  const endogN = asArr(endog);
  const instrN = asArr(instruments);
  const ctrlN = asArr(controls);
  if (!dv || !endogN.length || !instrN.length) {
    return void app.results.appendError('IV needs an outcome, endogenous regressor(s), and instrument(s).');
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const allNames = [...endogN, ...instrN, ...ctrlN];
  const rhs1 = [...endogN, ...ctrlN].map((n) => term(meta, n)).join(' + ');
  const rhs2 = [...instrN, ...ctrlN].map((n) => term(meta, n)).join(' + ');
  const rCode = `
    .endog <- as.data.frame(endog, check.names = FALSE); names(.endog) <- ${rNames(endogN)}
    .instr <- as.data.frame(instruments, check.names = FALSE); names(.instr) <- ${rNames(instrN)}
    ${ctrlN.length ? `.ctrl <- as.data.frame(controls, check.names = FALSE); names(.ctrl) <- ${rNames(ctrlN)}` : ''}
    d <- data.frame(.y = dv, .endog, .instr${ctrlN.length ? ', .ctrl' : ''}, check.names = FALSE)
    ${recodeCol('d[[".y"]]', missing(meta, dv))}
    ${allNames.map((n) => recodeCol(`d[[${rStr(n)}]]`, missing(meta, n))).filter(Boolean).join('\n')}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    library(AER)
    fit <- ivreg(as.formula(${rStr(`.y ~ ${rhs1} | ${rhs2}`)}), data = d)
    s <- summary(fit, diagnostics = TRUE); co <- s$coefficients; dg <- s$diagnostics
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
         diagNames = rownames(dg), diagStat = dg[, "statistic"], diagP = dg[, "p-value"], n = nobs(fit))`;
  const r = flat((await app.webr.run(rCode)).result);
  await coeffTable(app, meta, r, `2SLS Coefficients — dependent: ${label(meta, dv)} (N = ${int(r.n1('n'))})`);
  const dn = r.str('diagNames');
  const ds = r.num('diagStat');
  const dp = r.num('diagP');
  await app.results.appendTable(
    {
      columns: ['Diagnostic', 'Statistic', 'Sig.'],
      rows: dn.map((nm, i) => [nm, f(ds[i], 3), fmtP(dp[i])]),
      rowHeaders: true,
    },
    { caption: 'IV Diagnostics' },
  );
  await app.results.appendText('Want: weak instruments **significant** (instruments are strong), Wu–Hausman **significant** (endogeneity present, so IV is needed), and Sargan **non-significant** (overidentifying restrictions hold; only with more instruments than endogenous regressors).');
}

export async function panel(app, { dv, ivs, id, time, model }) {
  const ivNames = asArr(ivs);
  if (!dv || !ivNames.length || !id || !time) {
    return void app.results.appendError('Panel regression needs an outcome, predictor(s), a unit id, and a time index.');
  }
  const mdl = ['within', 'random', 'pooling'].includes(model) ? model : 'within';
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    .ivs <- as.data.frame(ivs, check.names = FALSE); names(.ivs) <- ${rNames(ivNames)}
    d <- data.frame(.y = dv, .ivs, .id = id, .time = time, check.names = FALSE)
    ${recodeCol('d[[".y"]]', missing(meta, dv))}
    ${ivNames.map((n) => recodeCol(`d[[${rStr(n)}]]`, missing(meta, n))).filter(Boolean).join('\n')}
    d <- d[stats::complete.cases(d), , drop = FALSE]
    library(plm)
    pd <- pdata.frame(d, index = c(".id", ".time"))
    fit <- plm(as.formula(${rStr(`.y ~ ${ivNames.map((n) => term(meta, n)).join(' + ')}`)}), data = pd, model = ${rStr(mdl)})
    s <- summary(fit); co <- s$coefficients
    list(terms = rownames(co), est = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
         r2 = unname(s$r.squared["rsq"]), n = length(residuals(fit)))`;
  const r = flat((await app.webr.run(rCode)).result);
  const mdlLabel = { within: 'Fixed effects (within)', random: 'Random effects', pooling: 'Pooled OLS' }[mdl];
  await coeffTable(app, meta, r, `Panel — ${mdlLabel} — dependent: ${label(meta, dv)} (N = ${int(r.n1('n'))})`);
  await app.results.appendTable(
    { columns: ['', 'Value'], rows: [['R Square', f(r.n1('r2'), 3)]], rowHeaders: true },
    { caption: 'Model Fit' },
  );
}

// --- shared rendering --------------------------------------------------------

async function coeffTable(app, meta, r, caption) {
  const terms = r.str('terms');
  const est = r.num('est');
  const se = r.num('se');
  const t = r.num('t');
  const p = r.num('p');
  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't / z', 'Sig.'],
      rows: terms.map((tm, i) => [
        tm === '(Intercept)' ? '(Constant)' : prettyTerm(tm),
        f(est[i], 3),
        f(se[i], 3),
        f(t[i], 3),
        fmtP(p[i]),
      ]),
      rowHeaders: true,
    },
    { caption },
  );
}

// --- helpers -----------------------------------------------------------------

function asArr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}
function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function missing(meta, name) {
  return (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
}
function recodeCol(expr, mv) {
  return mv.length ? `${expr}[${expr} %in% c(${mv.join(', ')})] <- NA` : '';
}
function term(meta, name) {
  return meta.get(name)?.type === 'factor' ? `factor(\`${name}\`)` : `\`${name}\``;
}
function prettyTerm(t) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(t);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : t.replace(/`/g, '');
}
function rNames(names) {
  return `c(${names.map((n) => rStr(n)).join(', ')})`;
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
