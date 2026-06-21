/**
 * @file plugins/builtin-multilevel/index.js
 * Built-in plugin: **multilevel / mixed-effects models** — for clustered or
 * nested data where ordinary regression's independence assumption fails:
 * students in schools, patients in clinics, repeated measures within people,
 * respondents within countries. Random effects partition the variance across
 * levels and give correct standard errors.
 *
 *  - **Linear mixed model** — `lmerTest::lmer`, with Satterthwaite degrees of
 *    freedom and p-values for the fixed effects, random-effect variances, and
 *    the intraclass correlation (ICC).
 *  - **Logistic mixed model** — `lme4::glmer` for a binary outcome, reported as
 *    odds ratios with a latent-scale ICC.
 *
 * A random intercept is always included for the grouping variable; one fixed
 * predictor can additionally get a random slope.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-multilevel',
  name: 'Multilevel models',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['multilevel', 'mixed effects', 'hierarchical', 'lmer', 'glmer', 'random effects', 'random intercept', 'random slope', 'icc', 'nested', 'clustered', 'hlm'],
  rPackages: ['lme4', 'lmerTest'],
  menu: [
    {
      label: 'Linear mixed model…',
      run: 'linear',
      order: 100,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'fixed', kind: 'variables', label: 'Fixed-effect predictors', multiple: true, unique: true },
        { name: 'group', kind: 'variables', label: 'Grouping variable (random intercept)', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'slope', kind: 'variables', label: 'Random slope for (optional)', multiple: false, types: ['numeric'], optional: true, unique: true },
      ],
    },
    {
      label: 'Logistic mixed model…',
      run: 'logistic',
      order: 110,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Binary outcome', multiple: false, unique: true },
        { name: 'fixed', kind: 'variables', label: 'Fixed-effect predictors', multiple: true, unique: true },
        { name: 'group', kind: 'variables', label: 'Grouping variable (random intercept)', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
  ],
};

// --- Linear mixed model ------------------------------------------------------

export async function linear(app, { y: yName, fixed: fixedNames, group: groupName, slope: slopeName }) {
  if (!yName || !fixedNames || !fixedNames.length || !groupName) {
    await app.results.appendError('Linear mixed model: choose an outcome, at least one predictor, and a grouping variable.');
    return;
  }
  await app.webr.installPackages(['lme4', 'lmerTest']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('group', meta.get(groupName)),
    ...fixedNames.map((n) => recodeLine(`fixed[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const ranPart = slopeName ? `(1 + \`${slopeName}\` | .g)` : `(1 | .g)`;
  const formula = `.y ~ ${fixedNames.map(term).join(' + ')} + ${ranPart}`;
  const rCode = `
    suppressMessages(library(lmerTest))
    ${recodes}
    d <- data.frame(.y = as.numeric(y)); d <- cbind(d, fixed); d$.g <- factor(group)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- lmer(as.formula(${rStr(formula)}), data = d)
    s <- summary(fit); co <- s$coefficients
    vc <- as.data.frame(VarCorr(fit))
    gvar <- vc$vcov[vc$grp != "Residual" & (is.na(vc$var2)) & vc$var1 == "(Intercept)"][1]
    rvar <- vc$vcov[vc$grp == "Residual"][1]
    list(terms = rownames(co), est = co[, "Estimate"], se = co[, "Std. Error"],
         df = co[, "df"], t = co[, "t value"], p = co[, "Pr(>|t|)"],
         reGrp = vc$grp, reTerm = vc$var1, reVar = vc$vcov, reSd = vc$sdcor,
         icc = gvar / (gvar + rvar), nobs = nobs(fit), ngrp = as.numeric(ngrps(fit)),
         aic = AIC(fit), bic = BIC(fit))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), df = r.nums('df'), tv = r.nums('t'), p = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 'df', 't', 'Sig.', '95% CI'],
      rows: terms.map((t, i) => [prettyTerm(t), f(est[i], 3), f(se[i], 3), f(df[i], 1), f(tv[i], 2), fmtP(p[i]), ci(est[i] - 1.96 * se[i], est[i] + 1.96 * se[i])]),
      rowHeaders: true,
    },
    { caption: `Linear Mixed Model — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('nobs')}, groups = ${r.num('ngrp')})` },
  );

  const rg = r.strs('reGrp'), rt = r.strs('reTerm'), rv = r.nums('reVar'), rsd = r.nums('reSd');
  await app.results.appendTable(
    {
      columns: ['Group', 'Term', 'Variance', 'Std. Dev.'],
      rows: rg.map((g, i) => [g === '.g' ? labelOf(meta.get(groupName), groupName) : g, rt[i] == null || rt[i] === 'NA' ? '' : prettyTerm(rt[i]), f(rv[i], 4), f(rsd[i], 4)]),
      rowHeaders: true,
    },
    { caption: 'Random Effects' },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [['ICC (intercept)', f(r.num('icc'), 3)], ['AIC', f(r.num('aic'), 1)], ['BIC', f(r.num('bic'), 1)]],
      rowHeaders: true,
    },
    { caption: 'Model Summary' },
  );
  await app.results.appendText(
    `The **ICC** (${f(r.num('icc'), 3)}) is the share of outcome variance between groups — i.e. how much clustering there is; values well above 0 justify the multilevel model. Fixed-effect p-values use Satterthwaite degrees of freedom (lmerTest).` +
      (slopeName ? ` A random slope for ${labelOf(meta.get(slopeName), slopeName)} lets that effect vary across groups.` : ''),
  );
}

// --- Logistic mixed model ----------------------------------------------------

export async function logistic(app, { y: yName, fixed: fixedNames, group: groupName }) {
  if (!yName || !fixedNames || !fixedNames.length || !groupName) {
    await app.results.appendError('Logistic mixed model: choose a binary outcome, at least one predictor, and a grouping variable.');
    return;
  }
  await app.webr.installPackages(['lme4']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [
    recodeLine('y', meta.get(yName)), recodeLine('group', meta.get(groupName)),
    ...fixedNames.map((n) => recodeLine(`fixed[[${rStr(n)}]]`, meta.get(n))),
  ].filter(Boolean).join('\n');
  const term = (n) => (meta.get(n)?.type === 'factor' ? `factor(\`${n}\`)` : `\`${n}\``);
  const formula = `.y ~ ${fixedNames.map(term).join(' + ')} + (1 | .g)`;
  const rCode = `
    suppressMessages(library(lme4))
    ${BIN01_R}
    ${recodes}
    d <- data.frame(.y = bin01(y)); d <- cbind(d, fixed); d$.g <- factor(group)
    d <- d[stats::complete.cases(d), , drop = FALSE]
    fit <- glmer(as.formula(${rStr(formula)}), data = d, family = binomial())
    s <- summary(fit); co <- s$coefficients
    vc <- as.data.frame(VarCorr(fit)); gvar <- vc$vcov[vc$grp != "Residual"][1]
    list(terms = rownames(co), est = co[, "Estimate"], se = co[, "Std. Error"],
         z = co[, "z value"], p = co[, "Pr(>|z|)"],
         gvar = gvar, icc = gvar / (gvar + (pi^2) / 3), nobs = nobs(fit), ngrp = as.numeric(ngrps(fit)))`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), z = r.nums('z'), p = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['', 'B (log-odds)', 'Std. Error', 'z', 'Sig.', 'OR (exp B)', '95% CI (OR)'],
      rows: terms.map((t, i) => [
        t === '(Intercept)' ? '(Constant)' : prettyTerm(t), f(est[i], 3), f(se[i], 3), f(z[i], 2), fmtP(p[i]),
        f(Math.exp(est[i]), 3), ci(Math.exp(est[i] - 1.96 * se[i]), Math.exp(est[i] + 1.96 * se[i])),
      ]),
      rowHeaders: true,
    },
    { caption: `Logistic Mixed Model — outcome: ${labelOf(meta.get(yName), yName)} (N = ${r.num('nobs')}, groups = ${r.num('ngrp')})` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        [`Random intercept variance (${labelOf(meta.get(groupName), groupName)})`, f(r.num('gvar'), 4)],
        ['Latent-scale ICC', f(r.num('icc'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: 'Random Effects' },
  );
  await app.results.appendText(
    'Odds ratios are **conditional** (within-group) effects: the odds multiplier for a one-unit change, holding the group random effect fixed. The latent-scale ICC uses the standard logistic residual variance (π²/3 ≈ 3.29).',
  );
}

// --- helpers -----------------------------------------------------------------

const BIN01_R = `bin01 <- function(v){ v <- suppressWarnings(as.numeric(v)); u <- sort(unique(v[is.finite(v)]))
  if (all(u %in% c(0,1))) return(as.integer(v)); if (length(u) == 2) return(as.integer(v == u[2]))
  stop("binary outcome must have exactly two values") }`;

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
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
