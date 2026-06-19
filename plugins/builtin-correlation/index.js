/**
 * @file plugins/builtin-correlation/index.js
 * Built-in plugin: Analyze ▸ Correlate ▸ Bivariate.
 *
 * Pearson correlation matrix over two or more scale variables, in the SPSS
 * layout: for each pair, the correlation coefficient, its 2-tailed significance,
 * and the (pairwise) N. Computed in R (`cor.test`); rendered in JS.
 *
 * Like every analysis it reaches the engine only through the published `app`
 * object and honours each variable's user-defined `missingValues` — those codes
 * are recoded to NA before correlating, so a GSS `-99` never inflates a
 * coefficient. Missing data is handled pairwise (each pair uses the cases
 * complete for that pair), matching SPSS's default.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-correlation',
  name: 'Correlation',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Analysis',
  keywords: ['pearson', 'correlation', 'bivariate', 'r'],
  rPackages: [], // base R (cor.test) is enough
};

/** @param {object} app */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-correlation:open',
    path: ['Analyze', 'Correlate'],
    label: 'Bivariate…',
    order: 10,
    command: () => openCorrelation(app),
  });
}

/** Ask for numeric variables (need at least two), then run. */
async function openCorrelation(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Bivariate Correlations',
    hint: 'Choose two or more scale (numeric) variables.',
    multiple: true,
    types: ['numeric'],
  });
  if (!chosen || chosen.length < 2) {
    if (chosen && chosen.length === 1) {
      await app.results.appendError('Correlation needs at least two variables.');
    }
    return;
  }
  await runCorrelation(app, chosen);
}

/**
 * Compute the correlation matrix for all chosen variables in one R call and
 * render the SPSS-style table.
 *
 * @param {object} app
 * @param {string[]} variables
 */
async function runCorrelation(app, variables) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Correlations' });
  await app.results.beginSection('Correlations');

  const allMeta = await app.data.getVariableMeta();
  const metaByName = new Map(allMeta.map((m) => [m.name, m]));

  try {
    const { result } = await app.webr.run(buildR(variables, metaByName), {
      injectData: true,
      variables,
    });
    if (!result) throw new Error('R returned no result');
    const c = normalizeResult(result);
    await app.results.appendTable(renderTable(c, variables, metaByName));
  } catch (err) {
    await app.results.appendError(`Correlation failed: ${err.message}`);
    console.error(err);
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Correlations' });
}

/**
 * Build R that recodes user-missing codes to NA, then fills r / p / N matrices
 * pairwise via `cor.test`, returned as flat row-major vectors for clean JS
 * conversion.
 *
 * @param {string[]} variables
 * @param {Map<string, import('../../core/data-store.js').VariableMeta>} metaByName
 * @returns {string}
 */
function buildR(variables, metaByName) {
  const recodes = variables
    .map((name) => {
      const missing = (metaByName.get(name)?.missingValues ?? []).map(rLiteral).join(', ');
      if (!missing) return '';
      const col = `df[[${rLiteral(name)}]]`;
      return `${col}[${col} %in% c(${missing})] <- NA`;
    })
    .filter(Boolean)
    .join('\n');

  const order = `vars <- c(${variables.map(rLiteral).join(', ')})`;
  return `
    ${recodes}
    ${order}
    d <- data.frame(lapply(vars, function(nm) as.numeric(df[[nm]])))
    k <- length(vars)
    r <- matrix(NA_real_, k, k); p <- matrix(NA_real_, k, k); n <- matrix(0, k, k)
    for (i in 1:k) for (j in 1:k) {
      x <- d[[i]]; y <- d[[j]]
      ok <- is.finite(x) & is.finite(y)
      nn <- sum(ok); n[i, j] <- nn
      if (i == j) { r[i, j] <- 1 }
      else if (nn >= 3) {
        ct <- tryCatch(suppressWarnings(cor.test(x[ok], y[ok])), error = function(e) NULL)
        if (!is.null(ct)) { r[i, j] <- unname(ct$estimate); p[i, j] <- ct$p.value }
      }
    }
    list(vars = vars, k = k, r = as.vector(t(r)), p = as.vector(t(p)), n = as.vector(t(n)))
  `;
}

/**
 * Flatten WebR's tagged list result into plain arrays.
 *
 * @param {any} rList
 * @returns {{vars: string[], k: number, r: number[], p: number[], n: number[]}}
 */
function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((nm, i) => (byName[nm] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  // R `NA` arrives as `null`; map it to NaN (not `Number(null)===0`, which would
  // render a missing coefficient/p-value as a spurious 0.000 / <.001).
  const num = (v) => arr(v).map((x) => (x == null ? NaN : Number(x)));
  const kArr = num(byName.k);
  return {
    vars: arr(byName.vars).map(String),
    k: kArr.length ? kArr[0] : 0,
    r: num(byName.r),
    p: num(byName.p),
    n: num(byName.n),
  };
}

/**
 * Render the SPSS-style correlation matrix: each row variable spans three rows
 * (Pearson Correlation / Sig. (2-tailed) / N); coefficients carry significance
 * stars (* p<.05, ** p<.01).
 *
 * @param {ReturnType<typeof normalizeResult>} c
 * @param {string[]} variables
 * @param {Map<string, import('../../core/data-store.js').VariableMeta>} metaByName
 * @returns {string} HTML
 */
function renderTable(c, variables, metaByName) {
  const k = c.k || variables.length;
  const at = (m, i, j) => m[i * k + j];
  const label = (name) => {
    const meta = metaByName.get(name);
    return meta?.label ? `${esc(meta.label)}` : esc(name);
  };
  const rFmt = (val, p) => {
    if (!Number.isFinite(val)) return '';
    const stars = !Number.isFinite(p) ? '' : p < 0.01 ? '**' : p < 0.05 ? '*' : '';
    return `${val.toFixed(3)}${stars}`;
  };
  const pFmt = (val) => (Number.isFinite(val) ? (val < 0.001 ? '<.001' : val.toFixed(3)) : '');
  const nFmt = (val) => (Number.isFinite(val) ? String(Math.round(val)) : '');

  const colHeads = variables.map((name) => `<th scope="col">${label(name)}</th>`).join('');

  const body = variables
    .map((rowName, i) => {
      const rCells = variables
        .map((_, j) => `<td>${i === j ? '1' : rFmt(at(c.r, i, j), at(c.p, i, j))}</td>`)
        .join('');
      const pCells = variables
        .map((_, j) => `<td>${i === j ? '' : pFmt(at(c.p, i, j))}</td>`)
        .join('');
      const nCells = variables.map((_, j) => `<td>${nFmt(at(c.n, i, j))}</td>`).join('');
      return `
        <tr>
          <th scope="row" rowspan="3">${label(rowName)}</th>
          <td class="ct-corr__stat">Pearson Correlation</td>${rCells}
        </tr>
        <tr><td class="ct-corr__stat">Sig. (2-tailed)</td>${pCells}</tr>
        <tr><td class="ct-corr__stat">N</td>${nCells}</tr>`;
    })
    .join('');

  return `
    <table class="ct-corr">
      <caption>Correlations</caption>
      <thead>
        <tr><th scope="col"></th><th scope="col"></th>${colHeads}</tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <p class="ct-note">* p&lt;.05&nbsp;&nbsp;** p&lt;.01 (2-tailed). Pairwise N.</p>`;
}

// --- tiny helpers ------------------------------------------------------------

/** HTML-escape text content. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a JS value as an R literal for safe interpolation into R source. */
function rLiteral(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
