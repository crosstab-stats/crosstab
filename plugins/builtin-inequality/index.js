/**
 * @file plugins/builtin-inequality/index.js
 * Built-in plugin: **inequality & segregation measures** — distributional /
 * disparity statistics for stratification, economic-sociology, and urban
 * research.
 *
 *  - **Inequality** (`ineq`) — Gini, Theil, Atkinson and the coefficient of
 *    variation for a quantity (income, wealth, firm size), plus a Lorenz curve.
 *  - **Segregation** — the dissimilarity index D, isolation and interaction
 *    indices across spatial units, from two group-count columns (e.g. minority
 *    and majority population per tract). Standard closed-form indices (verified
 *    against the `seg` package).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-inequality',
  name: 'Inequality & segregation',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Descriptive Statistics',
  keywords: ['inequality', 'gini', 'theil', 'atkinson', 'lorenz', 'segregation', 'dissimilarity', 'isolation', 'disparity', 'concentration'],
  rPackages: ['ineq', 'svglite'],
  menu: [
    {
      label: 'Inequality (Gini / Theil / Lorenz)…',
      run: 'inequality',
      order: 50,
      inputs: [
        { name: 'x', kind: 'variables', label: 'Quantity (e.g. income; non-negative)', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Segregation indices…',
      run: 'segregation',
      order: 55,
      inputs: [
        { name: 'groupA', kind: 'variables', label: 'Group A count per unit', multiple: false, types: ['numeric'], unique: true },
        { name: 'groupB', kind: 'variables', label: 'Group B count per unit', multiple: false, types: ['numeric'], unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

// --- Inequality --------------------------------------------------------------

export async function inequality(app, { x: xName }) {
  if (!xName) { await app.results.appendError('Inequality: choose a numeric quantity.'); return; }
  await app.webr.installPackages(['ineq']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = recodeLine('x', meta.get(xName));
  const rCode = `
    suppressMessages({library(ineq); library(svglite)})
    ${recodes}
    v <- as.numeric(x); v <- v[is.finite(v) & v >= 0]
    g <- Gini(v); th <- Theil(v); at <- Atkinson(v, parameter = 0.5); cv <- sd(v) / mean(v)
    lc <- Lc(v)
    .ct_dev <- svgstring(width = 5.2, height = 5, pointsize = 11)
    par(mar = c(4.2, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    plot(lc$p, lc$L, type = "l", lwd = 2, col = "${ACCENT}", xlab = "Cumulative share of population",
         ylab = "Cumulative share of quantity", main = "Lorenz curve", asp = 1)
    abline(0, 1, col = "#cccccc", lty = 2)
    dev.off(); svg <- .ct_dev()
    list(gini = g, theil = th, atkinson = at, cv = cv, n = length(v), mean = mean(v), svg = svg)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['Measure', 'Value'],
      rows: [
        ['Gini coefficient', f(r.num('gini'), 4)],
        ['Theil index', f(r.num('theil'), 4)],
        ['Atkinson (ε = 0.5)', f(r.num('atkinson'), 4)],
        ['Coefficient of variation', f(r.num('cv'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: `Inequality — ${labelOf(meta.get(xName), xName)} (N = ${r.num('n')}, mean = ${f(r.num('mean'), 2)})` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    'All indices are 0 at perfect equality and rise with inequality (**Gini** 0–1 is the share of the area above the Lorenz curve; **Theil** and **Atkinson** are entropy/welfare-based and decomposable). The **Lorenz curve** plots cumulative quantity against cumulative population — the further it bows below the 45° line, the more unequal.',
  );
}

// --- Segregation -------------------------------------------------------------

export async function segregation(app, { groupA: aName, groupB: bName }) {
  if (!aName || !bName) { await app.results.appendError('Segregation: choose two group-count columns (one row per spatial unit).'); return; }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = [recodeLine('groupA', meta.get(aName)), recodeLine('groupB', meta.get(bName))].filter(Boolean).join('\n');
  const rCode = `
    ${recodes}
    A <- as.numeric(groupA); B <- as.numeric(groupB)
    ok <- is.finite(A) & is.finite(B) & (A + B) > 0; A <- A[ok]; B <- B[ok]
    TA <- sum(A); TB <- sum(B); Tot <- TA + TB
    D <- 0.5 * sum(abs(A / TA - B / TB))
    iso <- sum((A / TA) * (A / (A + B)))        # isolation of A (xPx)
    inter <- sum((A / TA) * (B / (A + B)))       # interaction A with B (xPy)
    # Gini index of segregation
    p <- A / (A + B); tt <- A + B
    Gseg <- sum(outer(tt, tt) * abs(outer(p, p, "-"))) / (2 * Tot^2 * (TA / Tot) * (1 - TA / Tot))
    list(D = D, iso = iso, inter = inter, gseg = Gseg, nUnits = length(A), TA = TA, TB = TB)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['Index', 'Value'],
      rows: [
        ['Dissimilarity (D)', f(r.num('D'), 4)],
        ['Gini segregation', f(r.num('gseg'), 4)],
        [`Isolation (${labelOf(meta.get(aName), aName)})`, f(r.num('iso'), 4)],
        [`Interaction (A with B)`, f(r.num('inter'), 4)],
      ],
      rowHeaders: true,
    },
    { caption: `Segregation — ${labelOf(meta.get(aName), aName)} vs ${labelOf(meta.get(bName), bName)} (${r.num('nUnits')} units; totals ${r.num('TA')} / ${r.num('TB')})` },
  );
  await app.results.appendText(
    '**Dissimilarity (D)** is the share of one group that would have to move to even out the distribution (0 = even, 1 = complete segregation; > .6 is high). **Isolation** is the average own-group share in the typical A-member\'s unit; **interaction** is the average exposure to group B. Indices depend on the spatial unit (the modifiable areal unit problem).',
  );
}

// --- helpers -----------------------------------------------------------------

function cleanSvg(svg) {
  return String(svg).replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function labelOf(meta, name) { return meta?.label ? `${meta.label} (${name})` : name; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    num: (k) => { const a = arr(byName[k]); return a.length ? Number(a[0]) : NaN; },
    str1: (k) => { const a = arr(byName[k]); return a.length ? String(a[0]) : ''; },
  };
}
