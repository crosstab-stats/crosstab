/**
 * @file plugins/builtin-crosstabs/index.js
 * Built-in plugin: Analyze ▸ Descriptive Statistics ▸ Crosstabs.
 *
 * The namesake analysis: a two-way contingency table (row variable × column
 * variable) with row/column/grand totals, plus a Pearson chi-square test of
 * independence. Counts and the test are computed in R (`table` + `chisq.test`);
 * the SPSS-style tables are rendered in JS.
 *
 * Reaches the engine only through `app`, and honours each variable's
 * `missingValues` (recoded to NA before tabulating), like the other analyses.
 * Cell values display via value labels where present.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-crosstabs',
  name: 'Crosstabs',
  version: '0.1.0',
  apiVersion: '0.1.0',
  rPackages: [], // base R `table` + `chisq.test`
};

/** @param {object} app */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-crosstabs:open',
    path: ['Analyze', 'Descriptive Statistics'],
    label: 'Crosstabs…',
    order: 30,
    command: () => openCrosstabs(app),
  });
}

/** Pick a row variable, then a column variable, then run. */
async function openCrosstabs(app) {
  const types = ['factor', 'string'];
  const row = await app.ui.selectVariables({
    title: 'Crosstabs — row variable',
    hint: 'Choose the row variable.',
    multiple: false,
    types,
  });
  if (!row || !row.length) return;

  const col = await app.ui.selectVariables({
    title: 'Crosstabs — column variable',
    hint: `Row: ${row[0]}. Now choose the column variable.`,
    multiple: false,
    types,
  });
  if (!col || !col.length) return;

  await runCrosstabs(app, row[0], col[0]);
}

/**
 * @param {object} app
 * @param {string} rowName
 * @param {string} colName
 */
async function runCrosstabs(app, rowName, colName) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Crosstabs' });
  await app.results.beginSection('Crosstabs');

  const allMeta = await app.data.getVariableMeta();
  const metaByName = new Map(allMeta.map((m) => [m.name, m]));

  try {
    const { result } = await app.webr.run(buildR(rowName, colName, metaByName), {
      injectData: true,
      variables: [rowName, colName],
    });
    if (!result) throw new Error('R returned no result');
    const x = normalizeResult(result);
    await app.results.appendTable(renderCrosstab(x, metaByName.get(rowName), metaByName.get(colName)));
    await app.results.appendTable(renderChiSquare(x));
  } catch (err) {
    await app.results.appendError(`Crosstabs failed: ${err.message}`);
    console.error(err);
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Crosstabs' });
}

/**
 * Build R: recode user-missing on both variables, cross-tabulate, run the
 * chi-square test, and return counts (row-major) + totals + the test stats.
 *
 * @param {string} rowName
 * @param {string} colName
 * @param {Map<string, import('../../core/data-store.js').VariableMeta>} metaByName
 * @returns {string}
 */
function buildR(rowName, colName, metaByName) {
  const recode = (varExpr, name) => {
    const missing = (metaByName.get(name)?.missingValues ?? []).map(rLiteral).join(', ');
    return missing ? `${varExpr}[${varExpr} %in% c(${missing})] <- NA` : '';
  };
  return `
    rv <- df[[${rLiteral(rowName)}]]
    cv <- df[[${rLiteral(colName)}]]
    ${recode('rv', rowName)}
    ${recode('cv', colName)}
    tab <- table(rv, cv)
    chi <- tryCatch(suppressWarnings(chisq.test(tab)), error = function(e) NULL)
    list(
      rowLevels = rownames(tab),
      colLevels = colnames(tab),
      counts    = as.integer(t(tab)),
      rowTotals = as.integer(rowSums(tab)),
      colTotals = as.integer(colSums(tab)),
      total     = sum(tab),
      chisq     = if (is.null(chi)) NA_real_ else unname(chi$statistic),
      dfree     = if (is.null(chi)) NA_real_ else unname(chi$parameter),
      p         = if (is.null(chi)) NA_real_ else chi$p.value
    )
  `;
}

/**
 * @param {any} rList
 * @returns {{rowLevels: string[], colLevels: string[], counts: number[],
 *   rowTotals: number[], colTotals: number[], total: number,
 *   chisq: number, dfree: number, p: number}}
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
    rowLevels: arr(byName.rowLevels).map(String),
    colLevels: arr(byName.colLevels).map(String),
    counts: arr(byName.counts).map(Number),
    rowTotals: arr(byName.rowTotals).map(Number),
    colTotals: arr(byName.colTotals).map(Number),
    total: scalar(byName.total),
    chisq: scalar(byName.chisq),
    dfree: scalar(byName.dfree),
    p: scalar(byName.p),
  };
}

/**
 * Render the contingency table. Counts are row-major: `counts[i*ncol + j]`.
 *
 * @param {ReturnType<typeof normalizeResult>} x
 * @param {import('../../core/data-store.js').VariableMeta} [rowMeta]
 * @param {import('../../core/data-store.js').VariableMeta} [colMeta]
 * @returns {string}
 */
function renderCrosstab(x, rowMeta, colMeta) {
  const ncol = x.colLevels.length;
  const rowLabel = labelOf(rowMeta);
  const colLabel = labelOf(colMeta);
  const lv = (meta, code) => esc(meta?.valueLabels?.[code] ?? code);

  const headCells = x.colLevels.map((c) => `<th scope="col">${lv(colMeta, c)}</th>`).join('');
  const bodyRows = x.rowLevels
    .map((r, i) => {
      const cells = x.colLevels.map((_, j) => `<td>${x.counts[i * ncol + j] ?? 0}</td>`).join('');
      return `<tr><th scope="row">${lv(rowMeta, r)}</th>${cells}<td>${x.rowTotals[i]}</td></tr>`;
    })
    .join('');
  const totalCells = x.colLevels.map((_, j) => `<td>${x.colTotals[j]}</td>`).join('');

  return `
    <table class="ct-crosstab">
      <caption>${rowLabel} &times; ${colLabel}</caption>
      <thead>
        <tr><th scope="col"></th>${headCells}<th scope="col">Total</th></tr>
      </thead>
      <tbody>
        ${bodyRows}
        <tr class="ct-crosstab__total"><th scope="row">Total</th>${totalCells}<td>${x.total}</td></tr>
      </tbody>
    </table>`;
}

/**
 * @param {ReturnType<typeof normalizeResult>} x
 * @returns {string}
 */
function renderChiSquare(x) {
  const fmt = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const p = Number.isFinite(x.p) ? (x.p < 0.001 ? '< .001' : x.p.toFixed(3)) : '—';
  return `
    <table class="ct-chisq">
      <caption>Chi-Square Tests</caption>
      <thead>
        <tr>
          <th scope="col"></th><th scope="col">Value</th>
          <th scope="col">df</th><th scope="col">Asymp. Sig. (2-sided)</th>
        </tr>
      </thead>
      <tbody>
        <tr><th scope="row">Pearson Chi-Square</th><td>${fmt(x.chisq, 3)}</td><td>${fmt(x.dfree, 0)}</td><td>${p}</td></tr>
        <tr><th scope="row">N of Valid Cases</th><td>${x.total}</td><td></td><td></td></tr>
      </tbody>
    </table>`;
}

// --- tiny helpers ------------------------------------------------------------

function labelOf(meta) {
  if (!meta) return '';
  return meta.label ? `${esc(meta.label)} (${esc(meta.name)})` : esc(meta.name);
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
