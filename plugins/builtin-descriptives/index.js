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
    '  • vars — one or more measures to summarize.\n' +
    'GUI: Descriptive Statistics ▸ Explore (confidence interval for the mean)… — SPSS\'s Explore. ' +
    'Point estimate, lower bound and upper bound at a confidence level you choose, optionally split by a grouping variable.\n' +
    'Syntax: run builtin-descriptives.explore {"vars": ["tvhours"], "level": 99, "by": "sex"}\n' +
    '  • vars — the measures; level — confidence level in percent (default 95); by — optional grouping variable.',
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
    {
      label: 'Explore (confidence interval for the mean)…',
      run: 'explore',
      order: 30,
      inputs: [
        {
          name: 'vars',
          kind: 'variables',
          label: 'Dependent list',
          hint: 'The measures to estimate a mean and a confidence interval for.',
          types: ['numeric', 'factor'],
          multiple: true,
        },
        {
          name: 'by',
          kind: 'variables',
          label: 'Factor list',
          optional: true,
          hint:
            'Optional: a grouping variable to estimate each group separately. ' +
            'Cancel this to estimate the sample as a whole.',
          types: ['factor', 'string'],
          multiple: false,
        },
        {
          name: 'level',
          kind: 'number',
          label: 'Confidence level (%)',
          default: 95,
          hint: 'Usually 95. Ask for 99 and the interval gets wider, not more accurate.',
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
 * SPSS's **Explore** (#174e): the mean, its standard error, and a confidence
 * interval at a level the user picks — optionally one estimate per group.
 *
 * A whole lab is this one table and nothing else: point estimate, lower bound,
 * upper bound, at 95% *and* at 99%. The only interval in the app before this was
 * the fixed 95% by-product of the one-sample t-test — which a student has to run
 * against an arbitrary test value to see at all, and which cannot be moved to 99%.
 *
 * The interval comes from `t.test(conf.level=)` rather than a hand-written
 * mean ± t·SE, so the bounds are R's own and the level is honoured exactly.
 *
 * @param {object} app
 * @param {{vars: string[], by?: string|null, level?: number}} inputs
 */
export async function explore(app, { vars, by, level }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  // A level is a percent strictly between the two useless extremes. Out-of-range
  // input is corrected to 95 and said out loud, rather than handed to R to fail on.
  const asked = Number(level);
  const valid = Number.isFinite(asked) && asked > 0 && asked < 100;
  const pct = valid ? asked : 95;
  const corrected = !valid && level != null && level !== '';

  const rCode = `
    lv <- ${pct / 100}
    KEYS <- c("n","mean","se","lo","hi","trimmed","median","variance","sd","min","max","range","iqr")
    one <- function(x) {
      x <- suppressWarnings(as.numeric(as.character(x))); x <- x[is.finite(x)]
      n <- length(x)
      out <- setNames(rep(NA_real_, length(KEYS)), KEYS)
      out["n"] <- n
      if (n >= 2) {
        tt <- t.test(x, conf.level = lv)
        q <- quantile(x, c(.25, .75), names = FALSE)
        out["mean"] <- mean(x); out["se"] <- sd(x) / sqrt(n)
        out["lo"] <- tt$conf.int[1]; out["hi"] <- tt$conf.int[2]
        out["trimmed"] <- mean(x, trim = .05); out["median"] <- median(x)
        out["variance"] <- var(x); out["sd"] <- sd(x)
        out["min"] <- min(x); out["max"] <- max(x)
        out["range"] <- max(x) - min(x); out["iqr"] <- q[2] - q[1]
      }
      out
    }
    grp <- ${by ? 'as.character(by)' : 'NULL'}
    out <- list()
    for (.n in names(vars)) {
      col <- vars[[.n]]
      if (is.null(grp)) {
        out[[.n]] <- list(groups = "", stats = list(one(col)))
      } else {
        keep <- !is.na(grp) & grp != ""
        g <- grp[keep]; v <- col[keep]
        lvs <- sort(unique(g))
        out[[.n]] <- list(groups = lvs, stats = lapply(lvs, function(k) one(v[g == k])))
      }
    }
    out`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const perVar = tagged(result);

  const ROWS = [
    ['n', 'N'],
    ['mean', 'Mean'],
    ['se', 'Std. Error of Mean'],
    ['lo', `${pct}% CI — Lower Bound`],
    ['hi', `${pct}% CI — Upper Bound`],
    ['trimmed', '5% Trimmed Mean'],
    ['median', 'Median'],
    ['variance', 'Variance'],
    ['sd', 'Std. Deviation'],
    ['min', 'Minimum'],
    ['max', 'Maximum'],
    ['range', 'Range'],
    ['iqr', 'Interquartile Range'],
  ];

  for (const name of vars) {
    const entry = perVar[name];
    if (!entry) continue;
    const { groups, stats } = entry;
    const varLabel = meta.get(name)?.label ? `${meta.get(name).label} (${name})` : name;
    const grouped = !!by && groups.length > 0 && groups[0] !== '';
    const head = grouped ? groups.map((g) => valueLabel(meta, by, g)) : [varLabel];
    const rows = ROWS.map(([key, label]) => [
      label,
      ...stats.map((s) => (key === 'n' ? intOf(s[key]) : num(s[key]))),
    ]);
    await app.results.appendTable(
      { columns: ['', ...head], rows, rowHeaders: true },
      {
        caption: grouped
          ? `Descriptives — ${varLabel} by ${meta.get(by)?.label ?? by}`
          : `Descriptives — ${varLabel}`,
      },
    );
  }

  await app.results.appendText(
    corrected
      ? `_Confidence level must be between 0 and 100 — ${pct}% was used._`
      : `_Bounds are ${pct}% confidence intervals for the mean (t distribution, df = N − 1)._`,
  );
}

/** Pull `{groups, stats}` per variable out of the nested WebR tagged list. */
function tagged(rList) {
  const names = rList?.names ?? [];
  const values = rList?.values ?? [];
  const out = {};
  names.forEach((n, i) => {
    const inner = values[i];
    const iNames = inner?.names ?? [];
    const iVals = inner?.values ?? [];
    const at = (k) => iVals[iNames.indexOf(k)];
    const groups = plain(at('groups')).map(String);
    // `stats` is a list of NAMED numeric vectors — one per group. The names are
    // what the row order is read back through, so `one()` always returns the full
    // key set even for a group too small to measure.
    const stats = (at('stats')?.values ?? []).map((vec) => {
      const keys = vec?.names ?? [];
      const nums = plain(vec);
      const o = {};
      keys.forEach((k, j) => (o[k] = Number(nums[j])));
      return o;
    });
    out[n] = { groups, stats };
  });
  return out;
}

/** A WebR vector (or scalar) as a plain JS array. */
function plain(v) {
  if (v == null) return [];
  return Array.isArray(v?.values) ? v.values : [].concat(v);
}

function valueLabel(meta, name, code) {
  return meta.get(name)?.valueLabels?.[code] ?? code;
}

const num = (x) => (Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(3)) : '');
const intOf = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '');

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
