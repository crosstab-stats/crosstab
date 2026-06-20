/**
 * @file plugins/builtin-descriptives/index.js
 * Built-in plugin: Analyze ▸ Descriptive Statistics ▸ Descriptives.
 *
 * The scale-variable complement to Frequencies: N, missing, mean, SD, min, max,
 * and quartiles for one or more numeric variables, in an SPSS-style table (rows =
 * variables, columns = statistics). Computed in R; rendered in JS.
 *
 * Like every analysis it reaches the engine only through the published `app`
 * object and honours each variable's user-defined `missingValues` — those codes
 * are recoded to NA before stats, so a GSS `-99` never pollutes a mean. (The
 * recode is applied in R, the same convention the Frequencies plugin uses.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-descriptives',
  name: 'Descriptive Statistics',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['mean', 'sd', 'median', 'summary', 'descriptive'],
  rPackages: [], // base R (mean/sd/quantile) is enough
};

/** @param {object} app */
export async function activate(app) {
  await app.menus.register({
    id: 'builtin-descriptives:open',    label: 'Descriptives…',
    order: 20,
    command: () => openDescriptives(app),
  });
}

/** Ask for numeric variables, then run. */
async function openDescriptives(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Descriptive Statistics',
    hint: 'Choose one or more scale (numeric) variables.',
    multiple: true,
    types: ['numeric'],
  });
  if (chosen && chosen.length) await runDescriptives(app, chosen);
}

/**
 * Compute the statistics for all chosen variables in one R call and render the
 * table.
 *
 * @param {object} app
 * @param {string[]} variables
 */
async function runDescriptives(app, variables) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title: 'Descriptive Statistics' });
  await app.results.beginSection('Descriptive Statistics');

  const allMeta = await app.data.getVariableMeta();
  const metaByName = new Map(allMeta.map((m) => [m.name, m]));

  try {
    const { result } = await app.webr.run(buildR(variables, metaByName), {
      injectData: true,
      variables,
    });
    if (!result) throw new Error('R returned no result');
    const stats = normalizeResult(result);
    await app.results.appendTable(renderTable(stats, metaByName));
  } catch (err) {
    await app.results.appendError(`Descriptives failed: ${err.message}`);
    console.error(err);
  }

  await app.events.emit('analysis:finished', { plugin: manifest.id, title: 'Descriptive Statistics' });
}

/**
 * Build R that recodes each variable's user-missing codes to NA, then returns
 * the statistics as parallel vectors (one entry per variable) for clean JS
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

  // `df` is injected. Order columns explicitly so the result matches `variables`.
  const order = `vars <- c(${variables.map(rLiteral).join(', ')})`;
  return `
    ${recodes}
    ${order}
    num <- lapply(vars, function(nm) as.numeric(df[[nm]]))
    finite_min <- function(x) { x <- x[is.finite(x)]; if (length(x)) min(x) else NA_real_ }
    finite_max <- function(x) { x <- x[is.finite(x)]; if (length(x)) max(x) else NA_real_ }
    list(
      vars    = vars,
      n       = sapply(num, function(x) sum(!is.na(x))),
      missing = sapply(num, function(x) sum(is.na(x))),
      mean    = sapply(num, function(x) mean(x, na.rm = TRUE)),
      sd      = sapply(num, function(x) sd(x, na.rm = TRUE)),
      min     = sapply(num, finite_min),
      max     = sapply(num, finite_max),
      p25     = sapply(num, function(x) quantile(x, 0.25, na.rm = TRUE, names = FALSE)),
      median  = sapply(num, function(x) median(x, na.rm = TRUE)),
      p75     = sapply(num, function(x) quantile(x, 0.75, na.rm = TRUE, names = FALSE))
    )
  `;
}

/**
 * Flatten WebR's tagged list result into plain arrays keyed by statistic.
 *
 * @param {any} rList
 * @returns {{vars: string[]} & Record<string, number[]>}
 */
function normalizeResult(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    vars: arr(byName.vars).map(String),
    n: arr(byName.n).map(Number),
    missing: arr(byName.missing).map(Number),
    mean: arr(byName.mean).map(Number),
    sd: arr(byName.sd).map(Number),
    min: arr(byName.min).map(Number),
    max: arr(byName.max).map(Number),
    p25: arr(byName.p25).map(Number),
    median: arr(byName.median).map(Number),
    p75: arr(byName.p75).map(Number),
  };
}

/**
 * Render the SPSS-style descriptives table (rows = variables).
 *
 * @param {ReturnType<typeof normalizeResult>} s
 * @param {Map<string, import('../../core/data-store.js').VariableMeta>} metaByName
 * @returns {string} HTML
 */
function renderTable(s, metaByName) {
  const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '');
  const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '');

  const rows = s.vars
    .map((name, i) => {
      const meta = metaByName.get(name);
      const display = meta?.label ? `${esc(meta.label)} (${esc(name)})` : esc(name);
      return `
        <tr>
          <th scope="row">${display}</th>
          <td>${int(s.n[i])}</td>
          <td>${int(s.missing[i])}</td>
          <td>${num(s.mean[i])}</td>
          <td>${num(s.sd[i])}</td>
          <td>${num(s.min[i])}</td>
          <td>${num(s.p25[i])}</td>
          <td>${num(s.median[i])}</td>
          <td>${num(s.p75[i])}</td>
          <td>${num(s.max[i])}</td>
        </tr>`;
    })
    .join('');

  return `
    <table class="ct-desc">
      <caption>Descriptive Statistics</caption>
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">N</th>
          <th scope="col">Missing</th>
          <th scope="col">Mean</th>
          <th scope="col">Std. Dev.</th>
          <th scope="col">Min</th>
          <th scope="col">25th</th>
          <th scope="col">Median</th>
          <th scope="col">75th</th>
          <th scope="col">Max</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
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
