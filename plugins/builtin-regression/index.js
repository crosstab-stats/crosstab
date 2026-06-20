/**
 * @file plugins/builtin-regression/index.js
 * Built-in plugin: Analyze ▸ Regression ▸ Linear.
 *
 * Ordinary least-squares linear regression: pick a numeric dependent variable
 * and one or more independent variables, fit `lm()` in R, and render an SPSS-
 * style model summary + coefficients table. Factor IVs are wrapped in `factor()`
 * so they're dummy-coded regardless of how their codes are stored.
 *
 * Reaches the engine only through `app`, and honours `missingValues` on every
 * model variable (recoded to NA, so `lm`'s listwise deletion drops them).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-regression',
  name: 'Linear Regression',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  keywords: ['lm', 'linear', 'ols', 'regression'],
  rPackages: [], // base R `lm`
};

/** @param {object} app */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-regression:linear',
    label: 'Linear…',
    order: 10,
    command: () => openRegression(app),
  });
}

/** Pick the dependent variable, then the independents, then run. */
async function openRegression(app) {
  const dv = await app.ui.selectVariables({
    title: 'Linear Regression — dependent',
    hint: 'Choose the dependent (outcome) variable — numeric.',
    multiple: false,
    types: ['numeric'],
  });
  if (!dv || !dv.length) return;

  const ivs = await app.ui.selectVariables({
    title: 'Linear Regression — independents',
    hint: `Outcome: ${dv[0]}. Now choose one or more predictor variables.`,
    multiple: true,
  });
  if (!ivs || !ivs.length) return;

  await runRegression(app, dv[0], ivs.filter((n) => n !== dv[0]));
}

/**
 * @param {object} app
 * @param {string} dvName
 * @param {string[]} ivNames
 */
async function runRegression(app, dvName, ivNames) {
  if (!ivNames.length) {
    await app.results.appendError('Linear Regression: choose at least one predictor distinct from the outcome.');
    return;
  }
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Linear Regression' });
  await app.results.beginSection('Linear Regression');

  const allMeta = await app.data.getVariableMeta();
  const metaByName = new Map(allMeta.map((m) => [m.name, m]));

  try {
    const { result } = await app.webr.run(buildR(dvName, ivNames, metaByName), {
      injectData: true,
      variables: [dvName, ...ivNames],
    });
    if (!result) throw new Error('R returned no result');
    const m = normalizeResult(result);
    await app.results.appendTable(renderModel(m, metaByName.get(dvName)));
    await app.results.appendTable(renderCoefficients(m));
  } catch (err) {
    await app.results.appendError(`Linear Regression failed: ${err.message}`);
    console.error(err);
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Linear Regression' });
}

/**
 * Build R: recode user-missing on all model variables, fit `lm`, and return the
 * coefficients + model fit statistics.
 *
 * @param {string} dvName
 * @param {string[]} ivNames
 * @param {Map<string, import('../../core/data-store.js').VariableMeta>} metaByName
 * @returns {string}
 */
function buildR(dvName, ivNames, metaByName) {
  const recodes = [dvName, ...ivNames]
    .map((name) => {
      const missing = (metaByName.get(name)?.missingValues ?? []).map(rLiteral).join(', ');
      if (!missing) return '';
      const col = `df[[${rLiteral(name)}]]`;
      return `${col}[${col} %in% c(${missing})] <- NA`;
    })
    .filter(Boolean)
    .join('\n');

  const term = (name) =>
    metaByName.get(name)?.type === 'factor' ? `factor(\`${name}\`)` : `\`${name}\``;
  const formula = `\`${dvName}\` ~ ${ivNames.map(term).join(' + ')}`;

  return `
    ${recodes}
    fit <- lm(as.formula(${rLiteral(formula)}), data = df)
    s <- summary(fit)
    co <- s$coefficients
    fst <- s$fstatistic
    list(
      terms    = rownames(co),
      estimate = co[, 1],
      se       = co[, 2],
      t        = co[, 3],
      p        = co[, 4],
      r2       = s$r.squared,
      adjr2    = s$adj.r.squared,
      fstat    = if (is.null(fst)) NA_real_ else unname(fst[1]),
      fdf1     = if (is.null(fst)) NA_real_ else unname(fst[2]),
      fdf2     = if (is.null(fst)) NA_real_ else unname(fst[3]),
      fp       = if (is.null(fst)) NA_real_ else unname(pf(fst[1], fst[2], fst[3], lower.tail = FALSE)),
      n        = length(fit$residuals)
    )
  `;
}

/**
 * @param {any} rList
 * @returns {object}
 */
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

/**
 * @param {ReturnType<typeof normalizeResult>} m
 * @param {import('../../core/data-store.js').VariableMeta} [dvMeta]
 * @returns {string}
 */
function renderModel(m, dvMeta) {
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const sig = fmtP(m.fp);
  const dv = dvMeta?.label ? `${esc(dvMeta.label)} (${esc(dvMeta.name)})` : esc(dvMeta?.name ?? '');
  return `
    <table class="ct-model">
      <caption>Model Summary &mdash; dependent: ${dv}</caption>
      <thead>
        <tr>
          <th scope="col">R</th><th scope="col">R Square</th>
          <th scope="col">Adj. R Square</th><th scope="col">F</th>
          <th scope="col">df1</th><th scope="col">df2</th>
          <th scope="col">Sig.</th><th scope="col">N</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${f(Math.sqrt(Math.max(0, m.r2)), 3)}</td>
          <td>${f(m.r2, 3)}</td>
          <td>${f(m.adjr2, 3)}</td>
          <td>${f(m.fstat, 3)}</td>
          <td>${f(m.fdf1, 0)}</td>
          <td>${f(m.fdf2, 0)}</td>
          <td>${sig}</td>
          <td>${f(m.n, 0)}</td>
        </tr>
      </tbody>
    </table>`;
}

/**
 * @param {ReturnType<typeof normalizeResult>} m
 * @returns {string}
 */
function renderCoefficients(m) {
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const rows = m.terms
    .map((term, i) => {
      const label = term === '(Intercept)' ? '(Constant)' : prettyTerm(term);
      return `
        <tr>
          <th scope="row">${esc(label)}</th>
          <td>${f(m.estimate[i], 3)}</td>
          <td>${f(m.se[i], 3)}</td>
          <td>${f(m.t[i], 3)}</td>
          <td>${fmtP(m.p[i])}</td>
        </tr>`;
    })
    .join('');
  return `
    <table class="ct-coef">
      <caption>Coefficients</caption>
      <thead>
        <tr>
          <th scope="col"></th><th scope="col">B</th><th scope="col">Std. Error</th>
          <th scope="col">t</th><th scope="col">Sig.</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// --- tiny helpers ------------------------------------------------------------

/** Strip R's `factor(\`x\`)level` wrapping to something readable. */
function prettyTerm(term) {
  const m = /^factor\(`?(.+?)`?\)(.*)$/.exec(term);
  return m ? `${m[1]}${m[2] ? ` = ${m[2]}` : ''}` : term.replace(/`/g, '');
}

/** Format a p-value SPSS-style. */
function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

/** HTML-escape text content. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a JS value as an R literal for safe interpolation into R source. */
function rLiteral(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
