/**
 * @file plugins/builtin-frequencies/index.js
 * Built-in plugin: Descriptive Statistics ▸ Frequencies.
 *
 * One SPSS-style frequency table per chosen variable (value, frequency, percent,
 * valid percent, cumulative), honouring value labels and user-missing codes
 * (recoded to NA so they count as Missing, not a category). Computed in R; the
 * host renders the structured tables.
 *
 * Declarative plugin: the manifest declares the (multi-variable) input; the host
 * binds the chosen columns in R as the data.frame `vars`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-frequencies',
  name: 'Frequencies',
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['frequency', 'counts', 'distribution', 'table'],
  rPackages: [],
  menu: [
    {
      label: 'Frequencies…',
      run: 'run',
      order: 10,
      inputs: [{ name: 'vars', kind: 'variables', multiple: true }],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[]}} inputs
 */
export async function run(app, { vars }) {
  if (!vars || !vars.length) return;
  const meta = new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));

  for (const name of vars) {
    const m = meta.get(name);
    const mv = (m?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
    try {
      // `vars` (the chosen columns) is bound in R; tabulate one at a time.
      const rCode = `
        x <- vars[[${rStr(name)}]]
        ${mv.length ? `x[x %in% c(${mv.map(Number).join(', ')})] <- NA` : ''}
        counts <- table(x, useNA = "no")
        n_total <- length(x); n_valid <- sum(!is.na(x))
        valid_pct <- as.numeric(counts) / n_valid * 100
        list(
          values = names(counts), counts = as.integer(counts),
          percent = as.numeric(counts) / n_total * 100,
          valid_percent = valid_pct, cumulative = cumsum(valid_pct),
          n_total = n_total, n_valid = n_valid, n_missing = n_total - n_valid
        )`;
      const { result } = await app.webr.run(rCode);
      if (!result) throw new Error('R returned no result');
      await app.results.appendTable(buildSpec(m, normalizeResult(result)), {
        caption: m?.label ? `${m.label} (${name})` : name,
      });
    } catch (err) {
      await app.results.appendError(`Frequencies for "${name}": ${err.message}`);
      console.error(err);
    }
  }
}

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

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
