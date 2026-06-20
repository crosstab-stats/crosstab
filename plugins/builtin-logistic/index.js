/**
 * @file plugins/builtin-logistic/index.js
 * Built-in plugin: Analyze ▸ Regression ▸ Binary Logistic.
 *
 * Binary logistic regression: pick a two-category dependent variable and one or
 * more predictors, fit `glm(..., family = binomial)` in R, and render an SPSS-
 * style Model Summary (-2 Log likelihood, Cox & Snell / Nagelkerke R²) plus a
 * "Variables in the Equation" table (B, S.E., Wald, df, Sig., Exp(B)). Factor
 * predictors are dummy-coded via `factor()`.
 *
 * The outcome is recoded to 0/1 by its sorted categories, so the model predicts
 * the *higher* category (named in the caption) regardless of how the codes are
 * stored. Honours `missingValues` on every model variable (recoded to NA, so
 * glm's listwise deletion drops them).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-logistic',
  name: 'Binary Logistic Regression',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Regression',
  menu: 'Binary Logistic…',
  menuOrder: 20,
  keywords: ['glm', 'logistic', 'odds', 'binary', 'regression'],
  rPackages: [], // base R `glm`
};

/** Entry point: the host adds the menu item (manifest.menu) and calls this. */
export const run = openLogistic;

/** Pick the dependent (binary), then the predictors, then run. */
async function openLogistic(app) {
  const dv = await app.ui.selectVariables({
    title: 'Binary Logistic — dependent',
    hint: 'Choose the dependent (outcome) variable — must have two categories.',
    multiple: false,
  });
  if (!dv || !dv.length) return;

  const ivs = await app.ui.selectVariables({
    title: 'Binary Logistic — covariates',
    hint: `Outcome: ${dv[0]}. Now choose one or more predictor variables.`,
    multiple: true,
  });
  if (!ivs || !ivs.length) return;

  await runLogistic(app, dv[0], ivs.filter((n) => n !== dv[0]));
}

/**
 * @param {object} app
 * @param {string} dvName
 * @param {string[]} ivNames
 */
async function runLogistic(app, dvName, ivNames) {
  if (!ivNames.length) {
    await app.results.appendError('Binary Logistic: choose at least one predictor distinct from the outcome.');
    return;
  }
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Binary Logistic Regression' });
  await app.results.beginSection('Binary Logistic Regression');

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
    await app.results.appendError(`Binary Logistic failed: ${err.message}`);
    console.error(err);
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Binary Logistic Regression' });
}

/**
 * Build R: recode user-missing, coerce the outcome to 0/1 (predicting the higher
 * category), fit `glm` binomial, and return coefficients + fit statistics.
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
  const formula = `\`__y__\` ~ ${ivNames.map(term).join(' + ')}`;

  return `
    ${recodes}
    y <- df[[${rLiteral(dvName)}]]
    u <- sort(unique(y[!is.na(y)]))
    if (length(u) != 2) stop("dependent must have exactly 2 categories (found ", length(u), ")")
    df[["__y__"]] <- as.integer(factor(y, levels = u)) - 1L
    fit <- glm(as.formula(${rLiteral(formula)}), data = df, family = binomial())
    s <- summary(fit)
    co <- s$coefficients
    list(
      terms    = rownames(co),
      estimate = co[, 1],
      se       = co[, 2],
      z        = co[, 3],
      p        = co[, 4],
      expb     = exp(co[, 1]),
      n        = nobs(fit),
      nulldev  = fit$null.deviance,
      resdev   = fit$deviance,
      positive = as.character(u[2])
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

/**
 * Model Summary: -2 Log likelihood and the Cox & Snell / Nagelkerke pseudo-R²,
 * derived from the null and residual deviances.
 *
 * @param {ReturnType<typeof normalizeResult>} m
 * @param {import('../../core/data-store.js').VariableMeta} [dvMeta]
 * @returns {string}
 */
function renderModel(m, dvMeta) {
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  // -2LL = residual deviance for ungrouped binary data; pseudo-R² from deviances.
  const m2ll = m.resdev;
  const coxSnell = Number.isFinite(m.nulldev) && m.n
    ? 1 - Math.exp((m.resdev - m.nulldev) / m.n)
    : NaN;
  const nagelkerke = Number.isFinite(coxSnell)
    ? coxSnell / (1 - Math.exp(-m.nulldev / m.n))
    : NaN;
  const dv = dvMeta?.label ? `${esc(dvMeta.label)} (${esc(dvMeta.name)})` : esc(dvMeta?.name ?? '');
  return `
    <table class="ct-model">
      <caption>Model Summary &mdash; dependent: ${dv} (modelling ${esc(m.positive)})</caption>
      <thead>
        <tr>
          <th scope="col">&minus;2 Log likelihood</th>
          <th scope="col">Cox &amp; Snell R Square</th>
          <th scope="col">Nagelkerke R Square</th>
          <th scope="col">N</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${f(m2ll, 3)}</td>
          <td>${f(coxSnell, 3)}</td>
          <td>${f(nagelkerke, 3)}</td>
          <td>${f(m.n, 0)}</td>
        </tr>
      </tbody>
    </table>`;
}

/**
 * Variables in the Equation: B, S.E., Wald (= z²), df, Sig., Exp(B).
 *
 * @param {ReturnType<typeof normalizeResult>} m
 * @returns {string}
 */
function renderCoefficients(m) {
  const f = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const rows = m.terms
    .map((term, i) => {
      const label = term === '(Intercept)' ? 'Constant' : prettyTerm(term);
      const wald = Number.isFinite(m.z[i]) ? m.z[i] * m.z[i] : NaN;
      return `
        <tr>
          <th scope="row">${esc(label)}</th>
          <td>${f(m.estimate[i], 3)}</td>
          <td>${f(m.se[i], 3)}</td>
          <td>${f(wald, 3)}</td>
          <td>1</td>
          <td>${fmtP(m.p[i])}</td>
          <td>${f(m.expb[i], 3)}</td>
        </tr>`;
    })
    .join('');
  return `
    <table class="ct-coef">
      <caption>Variables in the Equation</caption>
      <thead>
        <tr>
          <th scope="col"></th><th scope="col">B</th><th scope="col">S.E.</th>
          <th scope="col">Wald</th><th scope="col">df</th>
          <th scope="col">Sig.</th><th scope="col">Exp(B)</th>
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
