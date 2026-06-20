/**
 * @file plugins/builtin-descriptives/index.js
 * Built-in plugin: Descriptive Statistics ▸ Descriptives.
 *
 * The scale-variable complement to Frequencies: N, missing, mean, SD, min, max,
 * and quartiles for one or more numeric variables, in an SPSS-style table.
 *
 * Declarative plugin (the new API): the manifest declares the menu item and its
 * input (one or more numeric variables); the host gathers that input, **binds it
 * into R as the data.frame `vars`**, and calls `run`. `run` computes in R and
 * hands the resulting data.frame to `app.results.appendTable` — which the host
 * renders. No menu wiring, no picker code, no HTML.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-descriptives',
  name: 'Descriptive Statistics',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['mean', 'sd', 'median', 'summary', 'descriptive'],
  rPackages: [],
  menu: [
    {
      label: 'Descriptives…',
      run: 'run',
      order: 20,
      inputs: [{ name: 'vars', kind: 'variables', types: ['numeric'], multiple: true }],
    },
  ],
};

/**
 * Compute descriptives for the chosen variables. `vars` (the chosen columns) is
 * already bound in R as a data.frame; `inputs.vars` is the list of names, used
 * here only to apply each variable's user-missing codes before the stats.
 *
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  // Recode each column's user-missing codes to NA (SPSS convention), in R, on the
  // bound `vars` data.frame. Codes come from variable metadata.
  const recode = vars
    .map((name) => {
      const mv = (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
      if (!mv.length) return '';
      const col = `vars[[${rStr(name)}]]`;
      return `${col}[${col} %in% c(${mv.map(Number).join(', ')})] <- NA`;
    })
    .filter(Boolean)
    .join('\n');

  const rCode = `
    ${recode}
    nm  <- names(vars)
    num <- lapply(nm, function(n) suppressWarnings(as.numeric(vars[[n]])))
    fin <- function(x) x[is.finite(x)]
    data.frame(
      Variable = nm,
      N        = sapply(num, function(x) sum(!is.na(x))),
      Missing  = sapply(num, function(x) sum(is.na(x))),
      Mean     = round(sapply(num, function(x) mean(x, na.rm = TRUE)), 3),
      "Std. Dev." = round(sapply(num, function(x) sd(x, na.rm = TRUE)), 3),
      Min      = sapply(num, function(x) { v <- fin(x); if (length(v)) min(v) else NA }),
      P25      = round(sapply(num, function(x) quantile(x, .25, na.rm = TRUE, names = FALSE)), 3),
      Median   = round(sapply(num, function(x) median(x, na.rm = TRUE)), 3),
      P75      = round(sapply(num, function(x) quantile(x, .75, na.rm = TRUE, names = FALSE)), 3),
      Max      = sapply(num, function(x) { v <- fin(x); if (length(v)) max(v) else NA }),
      check.names = FALSE, stringsAsFactors = FALSE
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');

  // Show the variable's label (falling back to its name) in the first column.
  const labelled = withLabels(result, vars, meta);
  await app.results.appendTable(labelled, { caption: 'Descriptive Statistics' });
}

/** Replace the result's first column (variable names) with "Label (name)". */
function withLabels(result, vars, meta) {
  const cols = result.values.map((c) => (Array.isArray(c?.values) ? c.values : [].concat(c)));
  const display = (n) => {
    const lbl = meta.get(n)?.label;
    return lbl ? `${lbl} (${n})` : n;
  };
  const n = cols.length ? cols[0].length : 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(result.names.map((_, ci) => (ci === 0 ? display(String(cols[0][i])) : cols[ci][i])));
  }
  return { columns: result.names, rows, rowHeaders: true };
}

/** R string literal (escapes backslash and quote). */
function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
