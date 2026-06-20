/**
 * @file plugins/builtin-frequencies/index.js
 * Built-in plugin: Analyze ▸ Descriptive Statistics ▸ Frequencies.
 *
 * This is the reference plugin — the smallest thing that proves the whole
 * contract: it registers a menu item, opens a dialog, reads the dataset and the
 * user's variable selection, runs R in WebR, transforms R's output into a
 * structured result, and renders an SPSS-style frequency table. It touches the
 * engine ONLY through the published `app` object passed to {@link activate}; it
 * imports nothing from `core/`.
 *
 * Design choices worth noting for plugin authors:
 *  - The plugin runs in a sandboxed iframe, so EVERY `app` call is async (it is
 *    an RPC to the engine). Note the `await`s throughout.
 *  - It has no access to the host DOM, so it cannot draw its own dialog. It asks
 *    the engine to show the variable picker via `app.ui.selectVariables`.
 *  - We compute frequencies **in R** (the source of statistical truth) but do
 *    the *rendering* in JS, so the output looks like SPSS, not an R console
 *    dump. R returns plain vectors; this file builds the HTML table.
 *  - One R job per selected variable. The engine's job queue serialises them, so
 *    this stays simple; a future optimisation could batch them into one call.
 *  - Value labels and user-missing codes come from variable metadata, exactly as
 *    a .sav import would populate them.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-frequencies',
  name: 'Frequencies',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['frequency', 'counts', 'distribution', 'table'],
  // No external R packages: base R `table()` is enough for frequencies.
  rPackages: [],
};

/**
 * Activate the plugin: register the menu item. The returned menu disposer is
 * tracked by the loader, so no explicit `deactivate` is needed.
 *
 * @param {object} app - The plugin-scoped engine API (every method is async).
 */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-frequencies:open',
    label: 'Frequencies…',
    order: 10,
    command: () => openFrequencies(app),
  });
}

/**
 * Ask the engine to show the variable picker, then run the analysis on the
 * chosen variables. The picker pre-selects whatever the user highlighted in the
 * sidebar, so the common path is "select vars → open → OK".
 *
 * @param {object} app
 */
async function openFrequencies(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Frequencies',
    hint: 'Choose one or more variables to tabulate.',
    multiple: true,
  });
  if (chosen && chosen.length) {
    await runFrequencies(app, chosen);
  }
}

/**
 * Run a frequency analysis for each chosen variable and render the results.
 *
 * @param {object} app
 * @param {string[]} variables - Variable names to tabulate.
 */
async function runFrequencies(app, variables) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Frequencies' });
  await app.results.beginSection('Frequencies');

  const allMeta = await app.data.getVariableMeta();
  const metaByName = new Map(allMeta.map((m) => [m.name, m]));

  for (const name of variables) {
    const meta = metaByName.get(name);
    try {
      const { result } = await app.webr.run(buildRForVariable(name, meta), {
        injectData: true,
        variables: [name],
      });
      if (!result) throw new Error('R returned no result');
      await app.results.appendTable(renderFrequencyTable(meta, normalizeResult(result)));
    } catch (err) {
      await app.results.appendError(`Frequencies for "${name}" failed: ${err.message}`);
      console.error(err);
    }
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Frequencies' });
}

/**
 * Build the R source that tabulates one variable. User-defined missing codes are
 * recoded to `NA` first (so they are counted as Missing, not as a category). The
 * final expression is a named list, which WebR converts cleanly to a JS object.
 *
 * @param {string} name
 * @param {import('../../core/data-store.js').VariableMeta} [meta]
 * @returns {string} R source
 */
function buildRForVariable(name, meta) {
  const missing = (meta?.missingValues ?? []).map(rLiteral).join(', ');
  // `df` is injected by the engine. Index by name to tolerate odd identifiers.
  return `
    x <- df[[${rLiteral(name)}]]
    ${missing ? `x[x %in% c(${missing})] <- NA` : ''}
    counts <- table(x, useNA = "no")
    n_total <- length(x)
    n_valid <- sum(!is.na(x))
    n_missing <- n_total - n_valid
    valid_pct <- as.numeric(counts) / n_valid * 100
    list(
      values        = names(counts),
      counts        = as.integer(counts),
      percent       = as.numeric(counts) / n_total * 100,
      valid_percent = valid_pct,
      cumulative    = cumsum(valid_pct),
      n_total       = n_total,
      n_valid       = n_valid,
      n_missing     = n_missing
    )
  `;
}

/**
 * WebR's `toJs()` returns R lists/vectors in a tagged shape (`{ type, names,
 * values }`). Flatten the parts we use into plain JS arrays/scalars so the
 * renderer does not have to know about WebR's wire format.
 *
 * @param {any} rList - Result of `RObject.toJs()` for the named list above.
 * @returns {{ values: string[], counts: number[], percent: number[],
 *   valid_percent: number[], cumulative: number[], n_total: number,
 *   n_valid: number, n_missing: number }}
 */
function normalizeResult(rList) {
  // A converted R named list looks like { type:'list', names:[...], values:[...] }
  // where each entry is itself a converted vector { values: [...] } (or a scalar
  // wrapped likewise). Be defensive about both shapes.
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  const scalar = (v) => {
    const a = arr(v);
    return a.length ? a[0] : Number(v) || 0;
  };
  return {
    values: arr(byName.values).map(String),
    counts: arr(byName.counts).map(Number),
    percent: arr(byName.percent).map(Number),
    valid_percent: arr(byName.valid_percent).map(Number),
    cumulative: arr(byName.cumulative).map(Number),
    n_total: scalar(byName.n_total),
    n_valid: scalar(byName.n_valid),
    n_missing: scalar(byName.n_missing),
  };
}

/**
 * Render an SPSS-style frequency table as an HTML string.
 *
 * @param {import('../../core/data-store.js').VariableMeta} [meta]
 * @param {ReturnType<typeof normalizeResult>} data
 * @returns {string} HTML
 */
function renderFrequencyTable(meta, data) {
  const labels = meta?.valueLabels ?? {};
  const title = meta?.label ? `${esc(meta.label)} (${esc(meta.name)})` : esc(meta?.name ?? '');
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '');

  const validRows = data.values
    .map((value, i) => {
      const display = labels[value] ?? value;
      return `
        <tr>
          <th scope="row">${esc(display)}</th>
          <td>${data.counts[i]}</td>
          <td>${fmt(data.percent[i])}</td>
          <td>${fmt(data.valid_percent[i])}</td>
          <td>${fmt(data.cumulative[i])}</td>
        </tr>`;
    })
    .join('');

  const validTotalPct = (data.n_valid / data.n_total) * 100;
  const missingRow = data.n_missing
    ? `<tr class="ct-freq__missing">
         <th scope="row">Missing</th>
         <td>${data.n_missing}</td>
         <td>${fmt((data.n_missing / data.n_total) * 100)}</td>
         <td></td><td></td>
       </tr>`
    : '';

  return `
    <table class="ct-freq">
      <caption>${title}</caption>
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">Frequency</th>
          <th scope="col">Percent</th>
          <th scope="col">Valid Percent</th>
          <th scope="col">Cumulative Percent</th>
        </tr>
      </thead>
      <tbody>
        ${validRows}
        <tr class="ct-freq__subtotal">
          <th scope="row">Total (valid)</th>
          <td>${data.n_valid}</td>
          <td>${fmt(validTotalPct)}</td>
          <td>100.0</td>
          <td></td>
        </tr>
        ${missingRow}
        <tr class="ct-freq__grand">
          <th scope="row">Total</th>
          <td>${data.n_total}</td>
          <td>100.0</td>
          <td></td><td></td>
        </tr>
      </tbody>
    </table>`;
}

// --- tiny helpers ------------------------------------------------------------

/** HTML-escape text content. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render a JS value as an R literal for safe interpolation into R source.
 * Numbers pass through; everything else becomes a quoted, escaped string.
 *
 * @param {number|string} v
 * @returns {string}
 */
function rLiteral(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
