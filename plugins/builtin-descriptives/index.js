/**
 * @file plugins/builtin-descriptives/index.js
 * Built-in plugin: Descriptive Statistics ▸ Descriptives.
 *
 * The scale-variable complement to Frequencies: N, missing, centre, spread and
 * quartiles for one or more variables, in an SPSS-style table.
 *
 * Declarative plugin (the new API): the manifest declares the menu item and its
 * input (one or more variables); the host gathers that input, **binds it into R
 * as the data.frame `vars`**, and calls `run`. `run` computes in R and hands the
 * resulting data.frame to `app.results.appendTable` — which the host renders. No
 * menu wiring, no picker code, no HTML.
 *
 * Two changes this table used to be missing (#174b/c/d):
 *  - **Variance and Range** sit beside SD and Max. A methods course names both in
 *    the same breath as the standard deviation, and reporting SD without variance
 *    forces a student to square a rounded number by hand.
 *  - **Mode**, and a picker that admits **factors**. A labelled numeric from a
 *    `.sav` arrives as a factor, so the numeric-only picker hid exactly the
 *    variables an intro course measures. The codes are still numbers underneath,
 *    so the arithmetic is unchanged; the mode is shown through the value label.
 *    What is *legal* for a nominal variable stays the reader's judgement — this
 *    reports what was asked for, as SPSS does.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-descriptives',
  name: 'Descriptive Statistics',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['mean', 'sd', 'median', 'mode', 'variance', 'range', 'summary', 'descriptive'],
  howto:
    'GUI: Descriptive Statistics ▸ Descriptives…, then pick one or more variables. You get an SPSS-style table of N, missing, mean, SD, variance, min/max, range, quartiles and mode.\n' +
    'Labelled categorical variables (factors) can be chosen too — the mode is the statistic that means anything for a nominal one.\n' +
    'Syntax: run builtin-descriptives.run {"vars": ["age", "income"]}\n' +
    '  • vars — one or more measures to summarize.',
  rPackages: [],
  menu: [
    {
      label: 'Descriptives…',
      run: 'run',
      order: 20,
      inputs: [
        {
          name: 'vars',
          kind: 'variables',
          hint: 'The measures to summarize with mean, SD, variance, range and quartiles.',
          types: ['numeric', 'factor'],
          multiple: true,
        },
      ],
    },
  ],
};

/**
 * Compute descriptives for the chosen variables. `vars` (the chosen columns) is
 * already bound in R as a data.frame; `inputs.vars` is the list of names, used
 * here only to label each row with the variable's label.
 *
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const rCode = `
    nm  <- names(vars)
    num <- lapply(nm, function(n) suppressWarnings(as.numeric(as.character(vars[[n]]))))
    fin <- function(x) x[is.finite(x)]
    # The mode is read off the RAW column, not the numeric view: it is the one
    # statistic here that is defined for a nominal variable whose codes are
    # strings. Ties report the smallest, numerically where the codes are numbers.
    modeOf <- function(n) {
      v <- as.character(vars[[n]]); v <- v[!is.na(v)]
      if (!length(v)) return(NA_character_)
      tb <- table(v); m <- names(tb)[tb == max(tb)]
      if (length(m) > 1) {
        o <- suppressWarnings(as.numeric(m))
        m <- if (any(is.na(o))) sort(m) else m[order(o)]
      }
      m[1]
    }
    data.frame(
      Variable = nm,
      N        = sapply(num, function(x) sum(!is.na(x))),
      Missing  = sapply(num, function(x) sum(is.na(x))),
      Mean     = round(sapply(num, function(x) mean(x, na.rm = TRUE)), 3),
      "Std. Dev." = round(sapply(num, function(x) sd(x, na.rm = TRUE)), 3),
      Variance = round(sapply(num, function(x) var(x, na.rm = TRUE)), 3),
      Min      = sapply(num, function(x) { v <- fin(x); if (length(v)) min(v) else NA }),
      P25      = round(sapply(num, function(x) quantile(x, .25, na.rm = TRUE, names = FALSE)), 3),
      Median   = round(sapply(num, function(x) median(x, na.rm = TRUE)), 3),
      P75      = round(sapply(num, function(x) quantile(x, .75, na.rm = TRUE, names = FALSE)), 3),
      Max      = sapply(num, function(x) { v <- fin(x); if (length(v)) max(v) else NA }),
      Range    = sapply(num, function(x) { v <- fin(x); if (length(v)) max(v) - min(v) else NA }),
      Mode     = sapply(nm, modeOf, USE.NAMES = FALSE),
      check.names = FALSE, stringsAsFactors = FALSE
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');

  // Show the variable's label (falling back to its name) in the first column.
  const labelled = withLabels(result, vars, meta);
  await app.results.appendTable(labelled, { caption: 'Descriptive Statistics' });
}

/**
 * Replace the result's first column (variable names) with "Label (name)", and
 * render the Mode through the variable's value label where it has one — a bare
 * `2` in a Mode column is not an answer a student can write down.
 */
function withLabels(result, vars, meta) {
  const cols = result.values.map((c) => (Array.isArray(c?.values) ? c.values : [].concat(c)));
  const display = (n) => {
    const lbl = meta.get(n)?.label;
    return lbl ? `${lbl} (${n})` : n;
  };
  const modeCol = result.names.indexOf('Mode');
  const n = cols.length ? cols[0].length : 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const varName = String(cols[0][i]);
    rows.push(
      result.names.map((_, ci) => {
        if (ci === 0) return display(varName);
        if (ci === modeCol) {
          const code = cols[ci][i];
          if (code == null || code === '') return '';
          const label = meta.get(varName)?.valueLabels?.[String(code)];
          return label ? `${label} (${code})` : String(code);
        }
        return cols[ci][i];
      }),
    );
  }
  return { columns: result.names, rows, rowHeaders: true };
}
