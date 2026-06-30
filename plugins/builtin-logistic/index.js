/**
 * @file plugins/builtin-logistic/index.js
 * Built-in plugin: Regression ▸ Binary Logistic.
 *
 * `glm` binomial logistic regression. The outcome is recoded to 0/1 (modelling
 * the higher category, named in the caption); SPSS-style Model Summary (−2LL,
 * Cox & Snell / Nagelkerke R²) + Variables in the Equation (B, S.E., Wald=z², df,
 * Sig., Exp(B)). Factor predictors are dummy-coded; user-missing recoded to NA.
 *
 * Declarative plugin: the host binds the outcome in R as the vector `dv` and the
 * predictors as the data.frame `ivs`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-logistic',
  name: 'Binary Logistic Regression',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['glm', 'logistic', 'odds', 'binary', 'regression'],
  disciplines: ['Political Science', 'Sociology', 'Psychology', 'Public Health', 'Economics', 'Criminology', 'Social Science'],
  howto:
    'GUI: Regression ▸ Binary Logistic…, then pick a binary outcome and one or more predictors. You get a Model Summary (−2LL, Cox & Snell / Nagelkerke R²) and Variables in the Equation (B, Wald, Sig., Exp(B)).\n' +
    'Syntax: run builtin-logistic.run {"dv": "passed", "ivs": ["studyhrs", "attendance"]}\n' +
    '  • dv — binary outcome (exactly two categories).\n' +
    '  • ivs — one or more predictors.',
  rPackages: [],
  menu: [
    {
      label: 'Binary Logistic…',
      run: 'run',
      order: 20,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome (binary)', hint: 'The yes/no outcome to model; must have exactly two categories.', multiple: false, unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', hint: 'The variables you think predict the outcome.', multiple: true, unique: true },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{dv: string, ivs: string[]}} inputs
 */
export async function run(app, { dv: dvName, ivs: ivNames }) {
  if (!dvName || !ivNames || !ivNames.length) {
    await app.results.appendError('Binary Logistic: choose an outcome and at least one predictor.');
    return;
  }
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const recodes = [
    recodeLine('dv', meta.get(dvName)),
    ...ivNames.map((n) => recodeLine(`ivs[[${rStr(n)}]]`, meta.get(n))),
  ]
    .filter(Boolean)
    .join('\n');

  const term = (name) =>
    meta.get(name)?.type === 'factor' ? `factor(\`${name}\`)` : `\`${name}\``;
  const formula = `.y ~ ${ivNames.map(term).join(' + ')}`;

  const rCode = `
    ${recodes}
    u <- sort(unique(dv[!is.na(dv)]))
    if (length(u) != 2) stop("dependent must have exactly 2 categories (found ", length(u), ")")
    d <- cbind(.y = as.integer(factor(dv, levels = u)) - 1L, ivs)
    fit <- glm(as.formula(${rStr(formula)}), data = d, family = binomial())
    s <- summary(fit); co <- s$coefficients
    list(
      terms = rownames(co), estimate = co[, 1], se = co[, 2], z = co[, 3], p = co[, 4],
      expb = exp(co[, 1]), n = nobs(fit),
      nulldev = fit$null.deviance, resdev = fit$deviance, positive = as.character(u[2])
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const m = normalizeResult(result);
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');

  const coxSnell =
    Number.isFinite(m.nulldev) && m.n ? 1 - Math.exp((m.resdev - m.nulldev) / m.n) : NaN;
  const nagelkerke = Number.isFinite(coxSnell)
    ? coxSnell / (1 - Math.exp(-m.nulldev / m.n))
    : NaN;

  await app.results.appendTable(
    {
      columns: ['−2 Log likelihood', 'Cox & Snell R Square', 'Nagelkerke R Square', 'N'],
      rows: [[f(m.resdev, 3), f(coxSnell, 3), f(nagelkerke, 3), f(m.n, 0)]],
    },
    { caption: `Model Summary — dependent: ${labelOf(meta.get(dvName), dvName)} (modelling ${m.positive})` },
  );

  await app.results.appendTable(
    {
      columns: ['', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)'],
      rows: m.terms.map((t, i) => {
        const wald = Number.isFinite(m.z[i]) ? m.z[i] * m.z[i] : NaN;
        return [
          t === '(Intercept)' ? 'Constant' : prettyTerm(t),
          f(m.estimate[i], 3), f(m.se[i], 3), f(wald, 3), '1', fmtP(m.p[i]), f(m.expb[i], 3),
        ];
      }),
      rowHeaders: true,
    },
    { caption: 'Variables in the Equation' },
  );
}

// --- helpers -----------------------------------------------------------------

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

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const num = (v) => arr(v).map((x) => (x == null ? NaN : Number(x)));
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? a[0] : v;
  };
  return {
    terms: arr(byName.terms).map(String),
    estimate: num(byName.estimate),
    se: num(byName.se),
    z: num(byName.z),
    p: num(byName.p),
    expb: num(byName.expb),
    n: Number(scalar(byName.n)),
    nulldev: Number(scalar(byName.nulldev)),
    resdev: Number(scalar(byName.resdev)),
    positive: String(scalar(byName.positive) ?? ''),
  };
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
