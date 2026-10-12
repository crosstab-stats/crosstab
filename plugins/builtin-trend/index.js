/**
 * @file plugins/builtin-trend/index.js
 * Built-in plugin: **Mann-Kendall trend test + Sen's slope** — the standard
 * non-parametric way to detect and quantify a monotonic trend over time without
 * assuming linearity or normality. Ubiquitous in environmental/climate science
 * (the natural fit for Environmental Studies) and any "is this going up over the
 * years?" question. Uses the `trend` package.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fixed: f, labelOf, metaMap, ci: ciAt, fmtPInline, unpackR: flat } = globalThis.ctStd;

/** This plugin reports four decimals: a marginal effect or a trend slope can be small
 * enough that three prints `[0.000, 0.001]`. The precision is the caller's; the
 * formatting is the stdlib's. */
const ci = (lo, hi) => ciAt(lo, hi, 4);

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
  const rCode = `
    suppressMessages(library(trend))
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
        ['Kendall’s tau', f(r.num1('tau'), 4)],
        ['S statistic', f(r.num1('S'), 0)],
        ['z', f(r.num1('z'), 3)],
        ['p (two-sided)', fmtP(r.num1('p'))],
        ["Sen's slope (per step)", f(r.num1('slope'), 4)],
        ['Sen slope 95% CI', ci(r.num1('lo'), r.num1('hi'))],
      ],
      rowHeaders: true,
    },
    { caption: `Mann-Kendall Trend — ${labelOf(meta.get(sName), sName)} (N = ${r.num1('n')})` },
  );
  const tau = r.num1('tau'), p = r.num1('p');
  await app.results.appendText(
    `${p < 0.05 ? `A **significant ${tau > 0 ? 'upward' : 'downward'} monotonic trend** (${fmtPInline(p)}).` : 'No significant monotonic trend (p ≥ .05).'} ` +
      "**Kendall's tau** is the rank correlation with time (−1…1); **Sen's slope** is the median of all pairwise slopes — a robust per-step rate of change, far less sensitive to outliers than an OLS trend. Assumes observations are in time order and roughly evenly spaced.",
  );
}
