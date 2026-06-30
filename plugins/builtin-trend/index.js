/**
 * @file plugins/builtin-trend/index.js
 * Built-in plugin: **Mann-Kendall trend test + Sen's slope** — the standard
 * non-parametric way to detect and quantify a monotonic trend over time without
 * assuming linearity or normality. Ubiquitous in environmental/climate science
 * (the natural fit for Environmental Studies) and any "is this going up over the
 * years?" question. Uses the `trend` package.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-trend',
  name: 'Mann-Kendall trend',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Time Series',
  keywords: ['mann-kendall', 'mann kendall', 'sen slope', 'trend', 'monotonic', 'non-parametric trend', 'theil-sen'],
  disciplines: ['Environmental Studies', 'Ecology'],
  howto:
    "GUI: Time Series ▸ Mann-Kendall trend + Sen's slope…, then pick a numeric series in time order. You get Kendall's tau, the trend test, and Sen's slope (a robust per-step rate).\n" +
    'Syntax: run builtin-trend.run {"series": "value"}\n' +
    '  • series — the numeric measure to test, rows in time order.',
  rPackages: ['trend'],
  menu: [
    {
      label: "Mann-Kendall trend + Sen's slope…",
      run: 'run',
      order: 90,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series (in time order)', hint: 'The numeric measure to check for a trend, rows in time order.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
  ],
};

export async function run(app, { series: sName }) {
  if (!sName) { await app.results.appendError('Mann-Kendall: choose a numeric series (in time order).'); return; }
  await app.webr.installPackages(['trend']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = recodeLine('series', meta.get(sName));
  const rCode = `
    suppressMessages(library(trend))
    ${recodes}
    x <- as.numeric(series); x <- x[is.finite(x)]
    mk <- mk.test(x); ss <- sens.slope(x)
    list(z = as.numeric(mk$statistic), p = mk$p.value,
         S = as.numeric(mk$estimates["S"]), tau = as.numeric(mk$estimates["tau"]),
         slope = as.numeric(ss$estimates), lo = ss$conf.int[1], hi = ss$conf.int[2], n = length(x))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Kendall’s tau', f(r.num('tau'), 4)],
        ['S statistic', f(r.num('S'), 0)],
        ['z', f(r.num('z'), 3)],
        ['p (two-sided)', fmtP(r.num('p'))],
        ["Sen's slope (per step)", f(r.num('slope'), 4)],
        ['Sen slope 95% CI', ci(r.num('lo'), r.num('hi'))],
      ],
      rowHeaders: true,
    },
    { caption: `Mann-Kendall Trend — ${labelOf(meta.get(sName), sName)} (N = ${r.num('n')})` },
  );
  const tau = r.num('tau'), p = r.num('p');
  await app.results.appendText(
    `${p < 0.05 ? `A **significant ${tau > 0 ? 'upward' : 'downward'} monotonic trend** (p ${p < 0.001 ? '< .001' : '= ' + p.toFixed(3)}).` : 'No significant monotonic trend (p ≥ .05).'} ` +
      "**Kendall's tau** is the rank correlation with time (−1…1); **Sen's slope** is the median of all pairwise slopes — a robust per-step rate of change, far less sensitive to outliers than an OLS trend. Assumes observations are in time order and roughly evenly spaced.",
  );
}

// --- helpers -----------------------------------------------------------------
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function labelOf(meta, name) { return meta?.label ? `${meta.label} (${name})` : name; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function ci(lo, hi) { return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(4)}, ${hi.toFixed(4)}]` : '—'; }
function fmtP(p) { return !Number.isFinite(p) ? '—' : p < 0.001 ? '< .001' : p.toFixed(3); }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return { num: (k) => { const a = arr(byName[k]); return a.length ? Number(a[0]) : NaN; } };
}
