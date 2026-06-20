/**
 * @file plugins/builtin-regression/index.js
 * Built-in plugin: Regression ▸ Linear.
 *
 * Ordinary least squares (`lm`) with an SPSS-style Model Summary + Coefficients.
 * Factor predictors are dummy-coded; user-missing codes are recoded to NA first.
 * Computed in R; the host renders the structured tables.
 *
 * Declarative plugin: the manifest declares the outcome + predictor inputs (both
 * `unique`, so a predictor can't be the outcome). The host binds the outcome in R
 * as the vector `dv` and the predictors as the data.frame `ivs`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-regression',
  name: 'Linear Regression',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['lm', 'linear', 'ols', 'regression'],
  rPackages: [],
  menu: [
    {
      label: 'Linear…',
      run: 'run',
      order: 10,
      inputs: [
        { name: 'dv', kind: 'variables', label: 'Outcome', multiple: false, types: ['numeric'], unique: true },
        { name: 'ivs', kind: 'variables', label: 'Predictors', multiple: true, unique: true },
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
    await app.results.appendError('Linear Regression: choose an outcome and at least one predictor.');
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
  const formula = `.dv ~ ${ivNames.map(term).join(' + ')}`;

  const rCode = `
    ${recodes}
    d <- cbind(.dv = dv, ivs)
    fit <- lm(as.formula(${rStr(formula)}), data = d)
    s <- summary(fit); co <- s$coefficients; fst <- s$fstatistic
    list(
      terms = rownames(co), estimate = co[, 1], se = co[, 2], t = co[, 3], p = co[, 4],
      r2 = s$r.squared, adjr2 = s$adj.r.squared,
      fstat = if (is.null(fst)) NA_real_ else unname(fst[1]),
      fdf1  = if (is.null(fst)) NA_real_ else unname(fst[2]),
      fdf2  = if (is.null(fst)) NA_real_ else unname(fst[3]),
      fp    = if (is.null(fst)) NA_real_ else unname(pf(fst[1], fst[2], fst[3], lower.tail = FALSE)),
      n     = length(fit$residuals)
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const m = normalizeResult(result);
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');

  await app.results.appendTable(
    {
      columns: ['R', 'R Square', 'Adj. R Square', 'F', 'df1', 'df2', 'Sig.', 'N'],
      rows: [
        [
          f(Math.sqrt(Math.max(0, m.r2)), 3), f(m.r2, 3), f(m.adjr2, 3),
          f(m.fstat, 3), f(m.fdf1, 0), f(m.fdf2, 0), fmtP(m.fp), f(m.n, 0),
        ],
      ],
    },
    { caption: `Model Summary — dependent: ${labelOf(meta.get(dvName), dvName)}` },
  );

  await app.results.appendTable(
    {
      columns: ['', 'B', 'Std. Error', 't', 'Sig.'],
      rows: m.terms.map((t, i) => [
        t === '(Intercept)' ? '(Constant)' : prettyTerm(t),
        f(m.estimate[i], 3), f(m.se[i], 3), f(m.t[i], 3), fmtP(m.p[i]),
      ]),
      rowHeaders: true,
    },
    { caption: 'Coefficients' },
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
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? Number(a[0]) : Number(v);
  };
  return {
    terms: arr(byName.terms).map(String),
    estimate: arr(byName.estimate).map(Number),
    se: arr(byName.se).map(Number),
    t: arr(byName.t).map(Number),
    p: arr(byName.p).map(Number),
    r2: scalar(byName.r2),
    adjr2: scalar(byName.adjr2),
    fstat: scalar(byName.fstat),
    fdf1: scalar(byName.fdf1),
    fdf2: scalar(byName.fdf2),
    fp: scalar(byName.fp),
    n: scalar(byName.n),
  };
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
