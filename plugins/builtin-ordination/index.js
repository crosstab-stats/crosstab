/**
 * @file plugins/builtin-ordination/index.js
 * Built-in plugin: **correspondence analysis & multidimensional scaling** — two
 * ways to map categorical or distance structure into an interpretable 2-D
 * picture.
 *
 *  - **Correspondence analysis** (`ca`) — turns a two-way contingency table into
 *    a biplot of row and column categories, revealing which categories associate
 *    (the categorical analogue of PCA). Reports the inertia decomposition.
 *  - **Multidimensional scaling** (classical, base `cmdscale`) — a perceptual
 *    map: places objects (rows) so that distances reflect their dissimilarity on
 *    the chosen attributes.
 *
 * (Conjoint analysis is effects-coded OLS — use the Regression tools; the
 * `conjoint` package does not load in WebR.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-ordination',
  name: 'Correspondence & MDS',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['correspondence analysis', 'ca', 'biplot', 'mds', 'multidimensional scaling', 'perceptual map', 'cmdscale', 'inertia', 'ordination'],
  disciplines: ['Business', 'Communication', 'Anthropology', 'Ecology', 'Environmental Studies', 'Asian Studies'],
  rPackages: ['ca', 'svglite'],
  menu: [
    {
      label: 'Correspondence analysis…',
      run: 'correspondence',
      order: 46,
      inputs: [
        { name: 'rowvar', kind: 'variables', label: 'Row variable', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'colvar', kind: 'variables', label: 'Column variable', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
    {
      label: 'Multidimensional scaling (MDS)…',
      run: 'mds',
      order: 47,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Attributes (numeric)', multiple: true, types: ['numeric'], unique: true },
        { name: 'label', kind: 'variables', label: 'Object label (optional)', multiple: false, types: ['string', 'factor', 'numeric'], optional: true, unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';
const ACCENT2 = '#c0392b';

// --- Correspondence analysis -------------------------------------------------

export async function correspondence(app, { rowvar: rowName, colvar: colName }) {
  if (!rowName || !colName) { await app.results.appendError('Correspondence analysis: choose a row and a column variable.'); return; }
  await app.webr.installPackages(['ca']);
  const meta = metaMap(await app.data.getVariableMeta());
  const lv = (name, code) => meta.get(name)?.valueLabels?.[code] ?? code;
  const recodes = [recodeLine('rowvar', meta.get(rowName)), recodeLine('colvar', meta.get(colName))].filter(Boolean).join('\n');
  const rCode = `
    suppressMessages({library(ca); library(svglite)})
    ${recodes}
    tab <- table(rowvar, colvar)
    cc <- ca(tab)
    iner <- cc$sv^2; tot <- sum(iner); pct <- 100 * iner / tot
    .ct_dev <- svgstring(width = 6, height = 5.4, pointsize = 11)
    par(mar = c(4.2, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    plot(cc, main = "Correspondence biplot")
    dev.off(); svg <- .ct_dev()
    list(dim = seq_along(iner), sv = cc$sv, inertia = iner, pct = pct, cum = cumsum(pct),
         totalInertia = tot, chisq = tot * sum(tab), n = sum(tab), svg = svg,
         rowLevels = rownames(tab), colLevels = colnames(tab))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const dim = r.nums('dim'), sv = r.nums('sv'), iner = r.nums('inertia'), pct = r.nums('pct'), cum = r.nums('cum');

  await app.results.appendTable(
    {
      columns: ['Dimension', 'Singular value', 'Inertia', '% of inertia', 'Cumulative %'],
      rows: dim.map((d, i) => [String(d), f(sv[i], 4), f(iner[i], 4), `${f(pct[i], 1)}%`, `${f(cum[i], 1)}%`]),
      rowHeaders: true,
    },
    { caption: `Correspondence Analysis — ${labelOf(meta.get(rowName), rowName)} × ${labelOf(meta.get(colName), colName)} (total inertia = ${f(r.num('totalInertia'), 4)})` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    'Correspondence analysis decomposes the table\'s **inertia** (total χ²/N association) into dimensions, like PCA for categories. In the **biplot**, row and column categories that lie in the same direction from the origin tend to co-occur; categories near the origin are close to the average profile. Keep the first 1–2 dimensions if they capture most of the inertia.',
  );
}

// --- MDS ---------------------------------------------------------------------

export async function mds(app, { vars, label: labelName }) {
  if (!vars || vars.length < 2) { await app.results.appendError('MDS: choose at least two numeric attributes.'); return; }
  const meta = metaMap(await app.data.getVariableMeta());
  const hasLabel = !!labelName;
  const recodes = vars.map((n) => recodeLine(`vars[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    suppressMessages(library(svglite))
    ${recodes}
    m <- as.matrix(as.data.frame(lapply(vars, as.numeric)))
    ${hasLabel ? 'lab <- as.character(label)' : 'lab <- as.character(seq_len(nrow(m)))'}
    ok <- stats::complete.cases(m); m <- m[ok, , drop = FALSE]; lab <- lab[ok]
    D <- dist(scale(m))
    mds <- cmdscale(D, k = 2, eig = TRUE)
    pts <- mds$points
    ev <- mds$eig; goodness <- sum(abs(ev[1:2])) / sum(abs(ev))
    .ct_dev <- svgstring(width = 6, height = 5.4, pointsize = 11)
    par(mar = c(4.2, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    plot(pts[, 1], pts[, 2], pch = 19, col = "${ACCENT}", xlab = "Dimension 1", ylab = "Dimension 2",
         main = "MDS perceptual map", asp = 1)
    text(pts[, 1], pts[, 2], labels = lab, pos = 3, cex = 0.7, col = "#555555")
    dev.off(); svg <- .ct_dev()
    list(n = nrow(m), goodness = goodness, ev1 = ev[1], ev2 = ev[2], svg = svg)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Objects mapped', f(r.num('n'), 0)],
        ['Goodness of fit (2-D)', f(r.num('goodness'), 3)],
        ['Eigenvalue — Dim 1', f(r.num('ev1'), 3)],
        ['Eigenvalue — Dim 2', f(r.num('ev2'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: `Multidimensional Scaling — ${vars.length} attributes` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    'Classical MDS places objects so that 2-D distances approximate their dissimilarity across the (standardized) attributes — objects close together are similar. **Goodness of fit** near 1 means two dimensions represent the structure well. This is the perceptual-map workhorse for branding/marketing and similarity studies.',
  );
}

// --- helpers -----------------------------------------------------------------
function cleanSvg(svg) { return String(svg).replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1'); }
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function labelOf(meta, name) { return meta?.label ? `${meta.label} (${name})` : name; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function rStr(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    num: (k) => { const a = arr(byName[k]); return a.length ? Number(a[0]) : NaN; },
    str1: (k) => { const a = arr(byName[k]); return a.length ? String(a[0]) : ''; },
  };
}
