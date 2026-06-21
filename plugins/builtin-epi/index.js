/**
 * @file plugins/builtin-epi/index.js
 * Built-in plugin: **epidemiological measures** for a 2×2 exposure-by-outcome
 * table — the effect measures clinical/public-health and program-evaluation work
 * report instead of (or alongside) a chi-square: **risk ratio**, **odds ratio**,
 * **risk difference**, **number needed to treat/harm (NNT)**, and the
 * **attributable fraction**, each with a 95% confidence interval.
 *
 * Computed with the standard closed-form (Wald) formulas; verified against
 * epitools::riskratio / oddsratio.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-epi',
  name: 'Epidemiological measures',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Categorical',
  keywords: ['epidemiology', 'risk ratio', 'relative risk', 'odds ratio', 'risk difference', 'nnt', 'number needed to treat', 'attributable', 'rr', 'or'],
  disciplines: ['Public Health', 'Nutrition, Food & Dietetics', 'Gerontology'],
  rPackages: [],
  menu: [
    {
      label: 'Risk / odds ratios (2×2)…',
      run: 'run',
      order: 60,
      inputs: [
        { name: 'exposure', kind: 'variables', label: 'Exposure / treatment (1 = exposed)', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'outcome', kind: 'variables', label: 'Outcome (1 = case/event)', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
  ],
};

export async function run(app, { exposure: expName, outcome: outName }) {
  if (!expName || !outName) {
    await app.results.appendError('Choose an exposure variable and an outcome variable (both binary).');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [recodeLine('exposure', meta.get(expName)), recodeLine('outcome', meta.get(outName))].filter(Boolean).join('\n');
  const rCode = `
    ${BIN01_R}
    ${recodes}
    e <- bin01(exposure); o <- bin01(outcome)
    ok <- !is.na(e) & !is.na(o); e <- e[ok]; o <- o[ok]
    a <- sum(e == 1 & o == 1); b <- sum(e == 1 & o == 0)
    cc <- sum(e == 0 & o == 1); dd <- sum(e == 0 & o == 0)
    list(a = a, b = b, c = cc, d = dd, n = length(e))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const a = r.num('a'), b = r.num('b'), c = r.num('c'), d = r.num('d');
  if ([a, b, c, d].some((x) => !Number.isFinite(x)) || a + b === 0 || c + d === 0) {
    await app.results.appendError('Need a complete 2×2 table — make sure both variables are binary with cases in each group.');
    return;
  }

  const lv = (m, code) => meta.get(m)?.valueLabels?.[code] ?? code;
  const expLab = labelOf(meta.get(expName), expName), outLab = labelOf(meta.get(outName), outName);

  // 2x2 counts table.
  await app.results.appendTable(
    {
      columns: [`${expLab} \\ ${outLab}`, `${lv(outName, '1')} (case)`, `${lv(outName, '0')} (non-case)`, 'Total'],
      rows: [
        [`${lv(expName, '1')} (exposed)`, String(a), String(b), String(a + b)],
        [`${lv(expName, '0')} (unexposed)`, String(c), String(d), String(c + d)],
        ['Total', String(a + c), String(b + d), String(a + b + c + d)],
      ],
      rowHeaders: true,
    },
    { caption: `2×2 Table — ${expLab} × ${outLab} (N = ${r.num('n')})` },
  );

  const re = a / (a + b), ru = c / (c + d);
  const rr = re / ru;
  const seLogRr = Math.sqrt(1 / a - 1 / (a + b) + 1 / c - 1 / (c + d));
  const or = (a * d) / (b * c);
  const seLogOr = Math.sqrt(1 / a + 1 / b + 1 / c + 1 / d);
  const rd = re - ru;
  const seRd = Math.sqrt((re * (1 - re)) / (a + b) + (ru * (1 - ru)) / (c + d));
  const nnt = 1 / Math.abs(rd);
  const af = (rr - 1) / rr; // attributable fraction among exposed

  await app.results.appendTable(
    {
      columns: ['Measure', 'Estimate', '95% CI'],
      rows: [
        ['Risk in exposed', pct(re), ''],
        ['Risk in unexposed', pct(ru), ''],
        ['Risk ratio (RR)', f(rr, 3), ci(Math.exp(Math.log(rr) - 1.96 * seLogRr), Math.exp(Math.log(rr) + 1.96 * seLogRr))],
        ['Odds ratio (OR)', f(or, 3), ci(Math.exp(Math.log(or) - 1.96 * seLogOr), Math.exp(Math.log(or) + 1.96 * seLogOr))],
        ['Risk difference (RD)', f(rd, 4), ci(rd - 1.96 * seRd, rd + 1.96 * seRd)],
        [`${rd < 0 ? 'NNT (benefit)' : 'NNH (harm)'}`, f(nnt, 1), ''],
        ['Attributable fraction (exposed)', pct(af), ''],
      ],
      rowHeaders: true,
    },
    { caption: 'Effect Measures' },
  );
  await app.results.appendText(
    '**RR** and **OR** > 1 mean exposure raises the outcome; **RD** is the absolute risk change; **NNT/NNH** = 1/|RD| is how many exposed for one extra (averted) case. RR and risk difference are interpretable only with cohort/experimental sampling; in case-control designs use the OR. CIs are Wald.',
  );
}

// --- helpers -----------------------------------------------------------------

const BIN01_R = `bin01 <- function(v){ v <- suppressWarnings(as.numeric(v)); u <- sort(unique(v[is.finite(v)]))
  if (all(u %in% c(0,1))) return(v); if (length(u) == 2) return(as.integer(v == u[2])); rep(NA_integer_, length(v)) }`;

function pct(x) { return Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—'; }
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function labelOf(meta, name) { return meta?.label ? `${meta.label} (${name})` : name; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function ci(lo, hi) { return Number.isFinite(lo) && Number.isFinite(hi) ? `[${lo.toFixed(3)}, ${hi.toFixed(3)}]` : '—'; }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return { num: (k) => { const x = arr(byName[k]); return x.length ? Number(x[0]) : NaN; } };
}
