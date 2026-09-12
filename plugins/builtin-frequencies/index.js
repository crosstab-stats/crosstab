/**
 * @file plugins/builtin-frequencies/index.js
 * Built-in plugin: Descriptive Statistics ▸ Frequencies.
 *
 * One SPSS-style frequency table per chosen variable (value, frequency, percent,
 * valid percent, cumulative), honouring value labels and user-missing codes
 * (recoded to NA so they count as Missing, not a category). Computed in R; the
 * host renders the structured tables.
 *
 * On top of that it carries SPSS's **Statistics** panel (#174b/c/d): a tick-list
 * of central-tendency and dispersion measures reported in one table above the
 * frequency tables. That placement is not cosmetic. An intro methods packet gets
 * central tendency by ticking boxes *inside Frequencies*, and it does so on
 * **nominal and ordinal** variables — where the lesson is precisely that only the
 * mode is legal for a nominal one. Descriptives is numeric-only and could not
 * take a labelled factor at all, so before this the most-repeated action in a
 * whole course was the one action the app could not perform.
 *
 * Declarative plugin: the manifest declares the (multi-variable) input; the host
 * binds the chosen columns in R as the data.frame `vars`.
 */

/**
 * The Statistics panel's options, in the order SPSS lists them — which is also
 * the order they are printed, regardless of the order they were ticked.
 */
const STATS = [
  { value: 'mean', label: 'Mean' },
  { value: 'median', label: 'Median' },
  { value: 'mode', label: 'Mode' },
  { value: 'sum', label: 'Sum' },
  { value: 'sd', label: 'Std. Deviation' },
  { value: 'variance', label: 'Variance' },
  { value: 'se', label: 'Std. Error of Mean' },
  { value: 'range', label: 'Range' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'quartiles', label: 'Quartiles (25th, 50th, 75th)' },
];

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-frequencies',
  name: 'Frequencies',
  version: '0.3.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['frequency', 'counts', 'distribution', 'table', 'mode', 'median', 'variance', 'range'],
  howto:
    'GUI: Descriptive Statistics ▸ Frequencies…, then pick one or more variables. ' +
    'You get a value/frequency/percent table per variable (value labels and user-missing codes honoured).\n' +
    'The second dialog is SPSS\'s "Statistics" panel: tick Mode, Median, Variance, Range… to get a ' +
    'Statistics table above the frequency tables. Tick nothing (or Cancel) for tables only. ' +
    'Unlike Descriptives this works on nominal and ordinal variables, which is where the mode belongs.\n' +
    'Syntax: run builtin-frequencies.run {"vars": ["gender", "region"], "statistics": ["mode", "median"]}\n' +
    '  • vars — one or more variables to tabulate.\n' +
    '  • statistics — optional list from: ' + STATS.map((s) => s.value).join(', ') + '.',
  rPackages: [],
  menu: [
    {
      label: 'Frequencies…',
      run: 'run',
      order: 10,
      // Opt out of the host's central missing-value strip: Frequencies reports the
      // valid/missing breakdown itself, so it needs the raw designated codes (#missing-values).
      keepMissing: true,
      inputs: [
        { name: 'vars', kind: 'variables', hint: 'The variables to tabulate into counts and percentages.', multiple: true },
        {
          name: 'statistics',
          kind: 'choice',
          multiple: true,
          optional: true,
          label: 'Statistics',
          options: STATS,
          default: [],
          hint:
            'Tick the statistics to report in one table above the frequency tables. ' +
            'Leave empty (or Cancel) for the frequency tables alone. ' +
            'For a nominal variable only the mode is meaningful.',
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[], statistics?: string[]}} inputs
 */
export async function run(app, { vars, statistics }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
  const wanted = pickStats(statistics);

  // Compute every variable first, then print: the Statistics table belongs ABOVE
  // the frequency tables (SPSS's order), but it can only be assembled once every
  // column has been measured.
  const done = [];
  for (const name of vars) {
    const m = meta.get(name);
    try {
      const { result } = await app.webr.run(rFor(name, m));
      if (!result) throw new Error('R returned no result');
      done.push({ name, meta: m, data: normalizeResult(result) });
    } catch (err) {
      await app.results.appendError(`Frequencies for "${name}": ${err.message}`);
      console.error(err);
    }
  }
  if (!done.length) return;

  if (wanted.length) {
    const { spec, notes } = buildStatsSpec(done, wanted);
    await app.results.appendTable(spec, { caption: 'Statistics' });
    for (const note of notes) await app.results.appendText(`_${note}_`);
  }

  for (const d of done) {
    await app.results.appendTable(buildSpec(d.meta, d.data), {
      caption: d.meta?.label ? `${d.meta.label} (${d.name})` : d.name,
    });
  }
}

/** Keep only recognised statistic keys, in the canonical print order. */
function pickStats(chosen) {
  const set = new Set((Array.isArray(chosen) ? chosen : chosen ? [chosen] : []).map(String));
  return STATS.filter((s) => set.has(s.value));
}

// --- R ------------------------------------------------------------------------

/**
 * The R for one variable: fold its designated missing codes to NA, tabulate, and
 * measure it.
 *
 * The missing fold is written out here rather than taken from the host because
 * this action sets `keepMissing` — it has to see the raw codes to *count* them.
 * Ranges are folded as well as listed codes, for the reason `DataStore#missingWrap`
 * gives: an unenumerable `(LO THRU 0)` span otherwise contributes only its two
 * endpoints, and every value between them is silently counted as real data.
 */
function rFor(name, meta) {
  const codes = (meta?.missingValues ?? []).map(Number).filter(Number.isFinite);
  const ranges = (meta?.missingRanges ?? [])
    .map((r) => (Array.isArray(r) ? [Number(r[0]), Number(r[1])] : [Number(r?.lo), Number(r?.hi)]))
    .filter(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo);

  // Fold on a numeric VIEW of the column, so a code matches whether the column
  // arrived as a double or as character-coded labels.
  const folds = [];
  if (codes.length || ranges.length) {
    folds.push(`.v <- suppressWarnings(as.numeric(as.character(x)))`);
    if (codes.length) folds.push(`x[!is.na(.v) & .v %in% c(${codes.join(', ')})] <- NA`);
    for (const [lo, hi] of ranges) {
      folds.push(`x[!is.na(.v) & .v >= ${lo} & .v <= ${hi}] <- NA`);
    }
  }

  return `
    x <- vars[[${rStr(name)}]]
    ${folds.join('\n    ')}
    counts <- table(x, useNA = "no")
    n_total <- length(x); n_valid <- sum(!is.na(x))
    valid_pct <- as.numeric(counts) / n_valid * 100

    # Statistics are measured on two views of the same (already folded) column:
    # a numeric one for everything that needs arithmetic, and a raw one for the
    # mode — which is defined for a nominal variable whose codes are strings.
    xn <- suppressWarnings(as.numeric(as.character(x))); xn <- xn[!is.na(xn)]
    xs <- as.character(x); xs <- xs[!is.na(xs)]
    num <- function(f) if (length(xn)) f(xn) else NA_real_
    tb <- if (length(xs)) table(xs) else NULL
    mvals <- if (is.null(tb)) character(0) else names(tb)[tb == max(tb)]
    # Ties: report the SMALLEST, numerically when the codes are numbers (SPSS's rule).
    if (length(mvals) > 1) {
      mo <- suppressWarnings(as.numeric(mvals))
      mvals <- if (any(is.na(mo))) sort(mvals) else mvals[order(mo)]
    }

    list(
      values = names(counts), counts = as.integer(counts),
      percent = as.numeric(counts) / n_total * 100,
      valid_percent = valid_pct, cumulative = cumsum(valid_pct),
      n_total = n_total, n_valid = n_valid, n_missing = n_total - n_valid,
      mean = num(mean), median = num(median), sum = num(sum),
      sd = if (length(xn) > 1) sd(xn) else NA_real_,
      variance = if (length(xn) > 1) var(xn) else NA_real_,
      se = if (length(xn) > 1) sd(xn) / sqrt(length(xn)) else NA_real_,
      min = num(min), max = num(max),
      range = if (length(xn)) max(xn) - min(xn) else NA_real_,
      p25 = num(function(v) quantile(v, .25, names = FALSE)),
      p50 = num(function(v) quantile(v, .50, names = FALSE)),
      p75 = num(function(v) quantile(v, .75, names = FALSE)),
      mode_value = if (length(mvals)) mvals[1] else NA_character_,
      mode_ties = length(mvals),
      n_numeric = length(xn)
    )`;
}

// --- tables -------------------------------------------------------------------

/** Build the structured frequency table from the R result + value labels. */
function buildSpec(meta, data) {
  const labels = meta?.valueLabels ?? {};
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '');
  const rows = [];
  data.values.forEach((value, i) => {
    rows.push([
      labels[value] ?? value,
      data.counts[i],
      fmt(data.percent[i]),
      fmt(data.valid_percent[i]),
      fmt(data.cumulative[i]),
    ]);
  });
  const validTotalPct = (data.n_valid / data.n_total) * 100;
  rows.push(['Total (valid)', data.n_valid, fmt(validTotalPct), '100.0', '']);
  if (data.n_missing) {
    rows.push(['Missing', data.n_missing, fmt((data.n_missing / data.n_total) * 100), '', '']);
  }
  rows.push(['Total', data.n_total, '100.0', '', '']);
  return {
    columns: ['', 'Frequency', 'Percent', 'Valid Percent', 'Cumulative Percent'],
    rows,
    rowHeaders: true,
  };
}

/**
 * Build the Statistics table: statistics down the side, variables across the top
 * — SPSS's layout, which keeps several variables comparable on one screen.
 *
 * Returns the notes as well as the table, because two things genuinely need
 * saying rather than silently rounding away: which variables had tied modes, and
 * which ones had no numeric codes at all (so every arithmetic row is blank for
 * them — the honest answer for a nominal variable, not an error).
 */
function buildStatsSpec(done, wanted) {
  const head = done.map((d) => (d.meta?.label ? `${d.meta.label} (${d.name})` : d.name));
  const rows = [
    ['N — Valid', ...done.map((d) => d.data.n_valid)],
    ['N — Missing', ...done.map((d) => d.data.n_missing)],
  ];
  const numRow = (label, key) => [label, ...done.map((d) => fmtNum(d.data[key]))];

  for (const s of wanted) {
    if (s.value === 'mode') rows.push(['Mode', ...done.map((d) => modeText(d))]);
    else if (s.value === 'quartiles') {
      rows.push(numRow('Percentile 25', 'p25'), numRow('Percentile 50', 'p50'), numRow('Percentile 75', 'p75'));
    } else rows.push(numRow(s.label, s.value));
  }

  const notes = [];
  const tied = done.filter((d) => d.data.mode_ties > 1).map((d) => d.name);
  if (wanted.some((s) => s.value === 'mode') && tied.length) {
    notes.push(
      `Multiple modes exist for ${tied.join(', ')} — the smallest value is shown.`,
    );
  }
  const nonNumeric = done.filter((d) => !d.data.n_numeric).map((d) => d.name);
  const arithmetic = wanted.some((s) => s.value !== 'mode');
  if (arithmetic && nonNumeric.length) {
    notes.push(
      `${nonNumeric.join(', ')} has no numeric codes, so only the mode can be computed for it.`,
    );
  }
  return { spec: { columns: ['', ...head], rows, rowHeaders: true }, notes };
}

/** The mode as text — through the value label when the variable has one. */
function modeText(d) {
  const v = d.data.mode_value;
  if (v == null || v === '') return '';
  const label = d.meta?.valueLabels?.[v];
  return label ? `${label} (${v})` : String(v);
}

/** Print a statistic: whole numbers plainly, everything else to 3 decimals. */
function fmtNum(n) {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

// --- helpers -----------------------------------------------------------------

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
    return a.length ? a[0] : Number(v) || 0;
  };
  const num = (v) => {
    const a = arr(v);
    const x = a.length ? Number(a[0]) : NaN;
    return Number.isFinite(x) ? x : NaN;
  };
  const str = (v) => {
    const a = arr(v);
    return a.length && a[0] != null ? String(a[0]) : '';
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
    mean: num(byName.mean),
    median: num(byName.median),
    sum: num(byName.sum),
    sd: num(byName.sd),
    variance: num(byName.variance),
    se: num(byName.se),
    min: num(byName.min),
    max: num(byName.max),
    range: num(byName.range),
    p25: num(byName.p25),
    p50: num(byName.p50),
    p75: num(byName.p75),
    mode_value: str(byName.mode_value),
    mode_ties: scalar(byName.mode_ties),
    n_numeric: scalar(byName.n_numeric),
  };
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
