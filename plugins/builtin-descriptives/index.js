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

/**
 * Weighted-statistics helpers, as R source, prepended to this plugin's R (#174f).
 *
 * The weight is a **frequency weight**: a case with w = 2.5 counts as two and a
 * half cases. Every N below is therefore `sum(w)` and every variance divides by
 * `sum(w) - 1`. That is what SPSS's WEIGHT BY means, and what a survey weight
 * like WTSSNR carries in a methods course — labs 9 onward are all run weighted.
 *
 * Two rules keep this honest. A case whose weight is missing, zero or negative
 * cannot be counted as a fraction of a case, so it is dropped outright. And when
 * every weight is 1 each helper falls through to R's own unweighted function, so
 * turning weighting off reproduces the previous output exactly rather than
 * something that merely rounds to it.
 */
export const WEIGHTED_R = `
  wclean <- function(w, n) {
    if (is.null(w)) return(rep(1, n))
    w <- suppressWarnings(as.numeric(w))
    w[!is.finite(w) | w <= 0] <- NA
    w
  }
  wmean <- function(x, w) if (all(w == 1)) mean(x) else sum(w * x) / sum(w)
  wvar  <- function(x, w) {
    if (all(w == 1)) return(if (length(x) > 1) var(x) else NA_real_)
    n <- sum(w); if (n <= 1) return(NA_real_)
    m <- sum(w * x) / n
    sum(w * (x - m)^2) / (n - 1)
  }
  wsd <- function(x, w) sqrt(wvar(x, w))
  # Quantiles: R's default (type 7, interpolating) while unweighted, so nothing
  # changes; the inverse empirical CDF (type 1) once weights are in play, because
  # interpolating between two values that stand for 3.7 and 1.2 cases has no
  # defensible meaning.
  wquant <- function(x, w, p) {
    if (!length(x)) return(NA_real_)
    if (all(w == 1)) return(unname(quantile(x, p, names = FALSE)))
    o <- order(x); xs <- x[o]; cw <- cumsum(w[o]); n <- cw[length(cw)]
    xs[which(cw >= p * n)[1]]
  }
`;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-descriptives',
  name: 'Descriptive Statistics',
  version: '0.4.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['mean', 'sd', 'median', 'mode', 'variance', 'range', 'summary', 'descriptive', 'explore', 'confidence interval', 'weight', 'weighted'],
  howto:
    'GUI: Descriptive Statistics ▸ Descriptives…, then pick one or more variables. You get an SPSS-style table of N, missing, mean, SD, variance, min/max, range, quartiles and mode.\n' +
    'Labelled categorical variables (factors) can be chosen too — the mode is the statistic that means anything for a nominal one.\n' +
    'Syntax: run builtin-descriptives.run {"vars": ["age", "income"]}\n' +
    '  • vars — one or more measures to summarize.\n' +
    'GUI: Descriptive Statistics ▸ Explore (confidence interval for the mean)… — SPSS\'s Explore. ' +
    'Point estimate, lower bound and upper bound at a confidence level you choose, optionally split by a grouping variable.\n' +
    'Syntax: run builtin-descriptives.explore {"vars": ["tvhours"], "level": 99, "by": "sex"}\n' +
    '  • vars — the measures; level — confidence level in percent (default 95); by — optional grouping variable.\n' +
    '  • Both actions take an optional weight — a survey weight read as a frequency weight, so N becomes its sum.',
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
        {
          name: 'weight',
          kind: 'variables',
          label: 'Weight cases by (optional)',
          optional: true,
          multiple: false,
          types: ['numeric'],
          hint:
            'A survey weight (e.g. WTSSNR), so the estimates describe the population rather than ' +
            'the sample. Cancel this to count each case once. The caption names the weight used.',
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
        {
          name: 'weight',
          kind: 'variables',
          label: 'Weight cases by (optional)',
          optional: true,
          multiple: false,
          types: ['numeric'],
          hint:
            'A survey weight (e.g. WTSSNR), so the estimates describe the population rather than ' +
            'the sample. Cancel this to count each case once. The caption names the weight used.',
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
export async function run(app, { vars, weight }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  const rCode = `
    ${WEIGHTED_R}
    nm  <- names(vars)
    W0  <- wclean(${weight ? 'weight' : 'NULL'}, nrow(vars))
    # A case the weight cannot score has no size at all, so it leaves every column
    # rather than landing in Missing and inflating the totals.
    each <- function(n) {
      x <- suppressWarnings(as.numeric(as.character(vars[[n]])))
      w <- W0
      ok <- !is.na(w)
      list(x = x[ok], w = w[ok])
    }
    cols <- lapply(nm, each)
    fin  <- function(d) { k <- is.finite(d$x); list(x = d$x[k], w = d$w[k]) }
    valid <- lapply(cols, fin)
    stat <- function(f, default = NA_real_) {
      sapply(valid, function(d) if (length(d$x)) f(d$x, d$w) else default)
    }
    # The mode is read off the RAW column, not the numeric view: it is the one
    # statistic here that is defined for a nominal variable whose codes are
    # strings. Ties report the smallest, numerically where the codes are numbers.
    modeOf <- function(n) {
      v <- as.character(vars[[n]]); w <- W0
      ok <- !is.na(v) & !is.na(w); v <- v[ok]; w <- w[ok]
      if (!length(v)) return(NA_character_)
      tb <- tapply(w, v, sum); m <- names(tb)[tb == max(tb)]
      if (length(m) > 1) {
        o <- suppressWarnings(as.numeric(m))
        m <- if (any(is.na(o))) sort(m) else m[order(o)]
      }
      m[1]
    }
    data.frame(
      Variable = nm,
      N        = round(sapply(valid, function(d) sum(d$w)), 3),
      Missing  = round(mapply(function(a, b) sum(a$w) - sum(b$w), cols, valid), 3),
      Mean     = round(stat(wmean), 3),
      "Std. Dev." = round(stat(wsd), 3),
      Variance = round(stat(wvar), 3),
      Min      = stat(function(x, w) min(x)),
      P25      = round(stat(function(x, w) wquant(x, w, .25)), 3),
      Median   = round(stat(function(x, w) wquant(x, w, .50)), 3),
      P75      = round(stat(function(x, w) wquant(x, w, .75)), 3),
      Max      = stat(function(x, w) max(x)),
      Range    = stat(function(x, w) max(x) - min(x)),
      Mode     = sapply(nm, modeOf, USE.NAMES = FALSE),
      check.names = FALSE, stringsAsFactors = FALSE
    )`;

  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');

  // Show the variable's label (falling back to its name) in the first column.
  const labelled = withLabels(result, vars, meta);
  await app.results.appendTable(labelled, {
    caption:
      'Descriptive Statistics' +
      (weight ? ` — weighted by ${meta.get(weight)?.label ?? weight}` : ''),
  });
  if (weight) {
    await app.results.appendText(
      `_N is the sum of ${weight}, not a head count: the weight says how many people in the ` +
        'population each respondent stands for. Variances divide by that N − 1._',
    );
  }
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
 * @param {{vars: string[], by?: string|null, level?: number, weight?: string|null}} inputs
 */
export async function explore(app, { vars, by, level, weight }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  // A level is a percent strictly between the two useless extremes. Out-of-range
  // input is corrected to 95 and said out loud, rather than handed to R to fail on.
  const asked = Number(level);
  const valid = Number.isFinite(asked) && asked > 0 && asked < 100;
  const pct = valid ? asked : 95;
  const corrected = !valid && level != null && level !== '';

  const rCode = `
    ${WEIGHTED_R}
    lv <- ${pct / 100}
    W0 <- wclean(${weight ? 'weight' : 'NULL'}, nrow(vars))
    KEYS <- c("n","mean","se","lo","hi","trimmed","median","variance","sd","min","max","range","iqr")
    one <- function(x, w) {
      xn <- suppressWarnings(as.numeric(as.character(x)))
      k <- is.finite(xn) & !is.na(w); x <- xn[k]; w <- w[k]
      out <- setNames(rep(NA_real_, length(KEYS)), KEYS)
      n <- sum(w)
      out["n"] <- n
      if (length(x) >= 2 && n > 1) {
        m <- wmean(x, w); s <- wsd(x, w); se <- s / sqrt(n)
        # The interval is built from the t quantile rather than handed to t.test,
        # which takes no weights. Unweighted this is t.test's own arithmetic, and
        # the two agree to the last printed digit; weighted, the degrees of
        # freedom are sum(w) - 1, the frequency-weight reading of "how many cases".
        tq <- qt(1 - (1 - lv) / 2, n - 1)
        out["mean"] <- m; out["se"] <- se
        out["lo"] <- m - tq * se; out["hi"] <- m + tq * se
        out["median"] <- wquant(x, w, .50)
        out["variance"] <- wvar(x, w); out["sd"] <- s
        out["min"] <- min(x); out["max"] <- max(x)
        out["range"] <- max(x) - min(x)
        out["iqr"] <- wquant(x, w, .75) - wquant(x, w, .25)
        # A trimmed mean needs a rule for trimming fractional cases, and inventing
        # one would put a number in the table that answers to nothing. Left blank
        # when weighted; the footnote says so.
        if (all(w == 1)) out["trimmed"] <- mean(x, trim = .05)
      }
      out
    }
    grp <- ${by ? 'as.character(by)' : 'NULL'}
    out <- list()
    for (.n in names(vars)) {
      col <- vars[[.n]]
      if (is.null(grp)) {
        out[[.n]] <- list(groups = "", stats = list(one(col, W0)))
      } else {
        keep <- !is.na(grp) & grp != ""
        g <- grp[keep]; v <- col[keep]; vw <- W0[keep]
        lvs <- sort(unique(g))
        out[[.n]] <- list(groups = lvs, stats = lapply(lvs, function(k) one(v[g == k], vw[g == k])))
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
        caption:
          (grouped
            ? `Descriptives — ${varLabel} by ${meta.get(by)?.label ?? by}`
            : `Descriptives — ${varLabel}`) +
          (weight ? ` — weighted by ${meta.get(weight)?.label ?? weight}` : ''),
      },
    );
  }

  await app.results.appendText(
    (corrected ? `_Confidence level must be between 0 and 100 — ${pct}% was used._ ` : '') +
      `_Bounds are ${pct}% confidence intervals for the mean (t distribution, df = N − 1)._` +
      (weight
        ? ` _N is the sum of ${weight}, so the interval reflects the weighted sample size. ` +
          'The 5% trimmed mean is left blank: trimming a fraction of a case has no agreed rule._'
        : ''),
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
      // R's NA arrives as null, and `Number(null)` is 0 — which printed a trimmed
      // mean of 0 for a weighted column that deliberately declines to compute one,
      // and would print 0 for every statistic of a group too small to measure.
      // A missing number has to stay missing all the way to the cell.
      keys.forEach((k, j) => (o[k] = nums[j] == null ? NaN : Number(nums[j])));
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
