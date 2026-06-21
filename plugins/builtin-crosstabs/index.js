/**
 * @file plugins/builtin-crosstabs/index.js
 * Built-in plugin: Descriptive Statistics ▸ Crosstabs.
 *
 * A two-way contingency table plus a Pearson chi-square test. User-missing codes
 * on either variable are recoded to NA first. Computed in R; the host renders the
 * structured tables (counts + value labels).
 *
 * Declarative plugin: the manifest declares two categorical inputs marked
 * `unique` (so the column picker excludes the already-chosen row variable); the
 * host binds them in R as the vectors `rowvar` and `colvar`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-crosstabs',
  name: 'Crosstabs',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['chi-square', 'contingency', 'crosstab', 'association'],
  rPackages: [],
  menu: [
    {
      label: 'Crosstabs…',
      run: 'run',
      order: 30,
      inputs: [
        { name: 'rowvar', kind: 'variables', label: 'Row variable', multiple: false, types: ['factor', 'string'], unique: true },
        { name: 'colvar', kind: 'variables', label: 'Column variable', multiple: false, types: ['factor', 'string'], unique: true },
        {
          name: 'pmethod',
          kind: 'choice',
          label: 'P-value',
          default: 'asymptotic',
          options: [
            { value: 'asymptotic', label: 'Asymptotic (default)' },
            { value: 'montecarlo', label: 'Monte Carlo (for sparse tables)' },
          ],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{rowvar: string, colvar: string}} inputs
 */
export async function run(app, { rowvar: rowName, colvar: colName, pmethod }) {
  if (!rowName || !colName) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const rCode = `
    ${recode('rowvar', meta.get(rowName))}
    ${recode('colvar', meta.get(colName))}
    tab <- table(rowvar, colvar)
    chi <- tryCatch(suppressWarnings(chisq.test(tab)), error = function(e) NULL)
    minExp <- if (is.null(chi)) NA_real_ else min(chi$expected, na.rm = TRUE)
    mc <- identical(pmethod, "montecarlo")
    simB <- 10000L
    pMC <- if (mc) tryCatch(suppressWarnings(chisq.test(tab, simulate.p.value = TRUE, B = simB))$p.value, error = function(e) NA_real_) else NA_real_
    pFisher <- if (mc) tryCatch(fisher.test(tab, simulate.p.value = TRUE, B = simB)$p.value, error = function(e) NA_real_) else NA_real_
    list(
      rowLevels = rownames(tab), colLevels = colnames(tab),
      counts = as.integer(t(tab)),
      rowTotals = as.integer(rowSums(tab)), colTotals = as.integer(colSums(tab)),
      total = sum(tab),
      chisq = if (is.null(chi)) NA_real_ else unname(chi$statistic),
      dfree = if (is.null(chi)) NA_real_ else unname(chi$parameter),
      p     = if (is.null(chi)) NA_real_ else chi$p.value,
      minExp = minExp, pMC = pMC, pFisher = pFisher, simB = simB,
      cramerV = if (is.null(chi)) NA_real_ else sqrt(unname(chi$statistic) / (sum(tab) * (min(nrow(tab), ncol(tab)) - 1))),
      phi = if (!is.null(chi) && nrow(tab) == 2 && ncol(tab) == 2) sqrt(unname(chi$statistic) / sum(tab)) else NA_real_
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const x = normalizeResult(result);

  const rowMeta = meta.get(rowName);
  const colMeta = meta.get(colName);
  const lv = (m, code) => m?.valueLabels?.[code] ?? code;
  const ncol = x.colLevels.length;

  // Contingency table.
  const rows = x.rowLevels.map((r, i) => [
    lv(rowMeta, r),
    ...x.colLevels.map((_, j) => x.counts[i * ncol + j] ?? 0),
    x.rowTotals[i],
  ]);
  rows.push(['Total', ...x.colTotals, x.total]);
  await app.results.appendTable(
    {
      columns: ['', ...x.colLevels.map((c) => lv(colMeta, c)), 'Total'],
      rows,
      rowHeaders: true,
    },
    { caption: `${labelOf(rowMeta, rowName)} × ${labelOf(colMeta, colName)}` },
  );

  // Chi-square test.
  const fmt = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const fp = (v) => (Number.isFinite(v) ? (v < 0.001 ? '< .001' : v.toFixed(3)) : '—');
  const p = fp(x.p);
  const chiRows = [['Pearson Chi-Square', fmt(x.chisq, 3), fmt(x.dfree, 0), p]];
  if (Number.isFinite(x.pMC)) {
    chiRows.push(['Pearson Chi-Square — Monte Carlo', fmt(x.chisq, 3), '', fp(x.pMC)]);
  }
  if (Number.isFinite(x.pFisher)) {
    chiRows.push(["Fisher's Exact — Monte Carlo", '', '', fp(x.pFisher)]);
  }
  chiRows.push(['N of Valid Cases', x.total, '', '']);
  await app.results.appendTable(
    {
      columns: ['', 'Value', 'df', Number.isFinite(x.pMC) ? 'Sig. (2-sided)' : 'Asymp. Sig. (2-sided)'],
      rows: chiRows,
      rowHeaders: true,
    },
    { caption: 'Chi-Square Tests' },
  );
  // Sparse-table guidance: the asymptotic χ² is unreliable when expected counts
  // are small; nudge toward the Monte Carlo option (or note it's already in use).
  if (Number.isFinite(x.minExp) && x.minExp < 5) {
    await app.results.appendText(
      Number.isFinite(x.pMC)
        ? `Smallest expected count is ${fmt(x.minExp, 2)} (< 5), so the Monte Carlo p-values above (${(x.simB || 10000).toLocaleString()} simulations) are more trustworthy than the asymptotic one here.`
        : `⚠️ Smallest expected count is ${fmt(x.minExp, 2)} (< 5) — the asymptotic χ² may be inaccurate. Re-run with **P-value: Monte Carlo** for a simulation-based p-value.`,
    );
  }

  // Symmetric Measures: association strength (phi for 2×2, Cramér's V always).
  const sym = [];
  if (Number.isFinite(x.phi)) sym.push(['Phi', fmt(x.phi, 3), p]);
  if (Number.isFinite(x.cramerV)) sym.push(["Cramér's V", fmt(x.cramerV, 3), p]);
  if (sym.length) {
    await app.results.appendTable(
      { columns: ['', 'Value', 'Approx. Sig.'], rows: sym, rowHeaders: true },
      { caption: 'Symmetric Measures' },
    );
  }
}

// --- helpers -----------------------------------------------------------------

/** R line recoding a bound vector's user-missing codes to NA. */
function recode(varName, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${varName}[${varName} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
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
    const first = a.length ? a[0] : v;
    return first == null ? NaN : Number(first); // R NA (a null element) → NaN, so it renders "—"/hides
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
    minExp: scalar(byName.minExp),
    pMC: scalar(byName.pMC),
    pFisher: scalar(byName.pFisher),
    simB: scalar(byName.simB),
    cramerV: scalar(byName.cramerV),
    phi: scalar(byName.phi),
  };
}
