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

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, labelOf, metaMap, unpackR: flat, cleanSvg } = globalThis.ctStd;

/** The biplot's two point colours. Shared between the R call and the key the host
 * draws beside it — one definition, so they cannot drift into disagreeing. */
const ROW_COLOR = '#2980b9';
const COL_COLOR = '#c0392b';

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-ordination',
  name: 'Correspondence & MDS',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['correspondence analysis', 'ca', 'biplot', 'mds', 'multidimensional scaling', 'perceptual map', 'cmdscale', 'inertia', 'ordination'],
  disciplines: ['Business', 'Communication', 'Anthropology', 'Ecology', 'Environmental Studies', 'Asian Studies'],
  howto:
    'GUI: Multivariate ▸ Correspondence analysis… or Multidimensional scaling (MDS)…, then pick the variables. ' +
    'Correspondence gives a row/column biplot with the inertia decomposition; MDS maps objects so distances reflect dissimilarity.\n' +
    'Syntax: run builtin-ordination.correspondence {"rowvar": "brand", "colvar": "attribute"}\n' +
    'Syntax: run builtin-ordination.mds {"vars": ["price", "quality", "service"], "label": "brand"}\n' +
    '  • correspondence: rowvar / colvar — the two category variables.\n' +
    '  • mds: vars — numeric attributes; label — optional object label for the map.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'ordination-correspondence',
      title: 'Correspondence analysis',
      category: 'Multivariate',
      keywords: ['correspondence', 'ca', 'biplot', 'inertia', 'contingency', 'map', 'rows', 'columns', 'brands', 'attributes'],
      needs: ['builtin-ordination'],
      seeAlso: ['ordination-mds', 'crosstabs-basics'],
    },
    {
      id: 'ordination-mds',
      title: 'Multidimensional scaling (MDS)',
      category: 'Multivariate',
      keywords: ['mds', 'multidimensional scaling', 'similarity', 'dissimilarity', 'map', 'distance', 'perceptual map', 'ordination'],
      needs: ['builtin-ordination'],
      seeAlso: ['ordination-correspondence', 'cluster-kmeans'],
    },
  ],
  rPackages: ['ca', 'svglite'],
  menu: [
    {
      howto: 'ordination-correspondence',
      label: 'Correspondence analysis…',
      run: 'correspondence',
      order: 46,
      inputs: [
        { name: 'rowvar', kind: 'variables', label: 'Row variable', hint: 'The category that forms the rows of the table.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
        { name: 'colvar', kind: 'variables', label: 'Column variable', hint: 'The category that forms the columns of the table.', multiple: false, types: ['factor', 'string', 'numeric'], unique: true },
      ],
    },
    {
      howto: 'ordination-mds',
      label: 'Multidimensional scaling (MDS)…',
      run: 'mds',
      order: 47,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Attributes (numeric)', hint: 'The measures used to judge how similar objects are.', multiple: true, types: ['numeric'], unique: true },
        { name: 'label', kind: 'variables', label: 'Object label (optional)', hint: 'A name for each object to show on the map.', multiple: false, types: ['string', 'factor', 'numeric'], optional: true, unique: true },
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
  const rCode = `
    suppressMessages({library(ca); library(svglite)})
    tab <- table(rowvar, colvar)
    if (min(dim(tab)) < 2) stop("one of these variables has only a single category, so there is nothing to map")
    cc <- ca(tab)
    iner <- cc$sv^2; tot <- sum(iner); pct <- 100 * iner / tot
    # A table with k categories on one side has min(r, c) - 1 dimensions, so a two-level
    # variable yields ONE — and plot(cc) then indexes a second axis that is not there
    # ("subscript out of bounds", which reached a user). The inertia table below is still
    # valid in that case, so the analysis stands and only the map is skipped.
    svg <- ""
    if (length(cc$sv) >= 2) {
      .ct_dev <- svgstring(width = 6, height = 5.4, pointsize = 11)
      par(mar = c(4.2, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
      # Colours stated rather than left to ca's defaults, because the host draws the key
      # beside this figure and the two have to agree. col[1] is the row categories,
      # col[2] the column categories.
      plot(cc, col = c("${ROW_COLOR}", "${COL_COLOR}"))
      dev.off(); svg <- .ct_dev()
    }
    list(dim = seq_along(iner), sv = cc$sv, inertia = iner, pct = pct, cum = cumsum(pct),
         totalInertia = tot, chisq = tot * sum(tab), n = sum(tab), svg = svg,
         nrows = nrow(tab), ncols = ncol(tab),
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
    { caption: `Correspondence Analysis — ${labelOf(meta.get(rowName), rowName)} × ${labelOf(meta.get(colName), colName)} (total inertia = ${f(r.num1('totalInertia'), 4)})` },
  );
  const svg = r.str1('svg');
  if (!(svg && /<svg[\s>]/i.test(svg)) && dim.length < 2) {
    // Said here rather than left as an absent figure, because "where is my biplot" is
    // the obvious next question and the answer is a property of the table, not a failure.
    const smaller = Math.min(r.num1('nrows'), r.num1('ncols'));
    await app.results.appendText(
      `**No biplot for this table.** A correspondence map needs two dimensions, and a `
      + `table yields one fewer than its smaller side — ${smaller} categories here, so `
      + 'one dimension. The inertia above is still the whole of the association; with one '
      + 'dimension it is a single ordering rather than a map, and a crosstab of the two '
      + 'variables shows it more directly.',
    );
  }
  if (svg && /<svg[\s>]/i.test(svg)) {
    // The key this figure never had. `plot(cc)` draws row and column categories in two
    // colours and says nowhere which is which — the reader had to know that ca puts rows
    // in the first colour. The host draws it as a live layer, so the wording can be
    // shortened: "Highest education level (columns)" is the variable's label, not a
    // choice anyone made.
    await app.results.appendPlot(cleanSvg(svg), {
      title: 'Correspondence biplot',
      legend: [
        // Distinguishing word FIRST: the legend column wraps, and "Rows" on line one
        // reads at a glance where a trailing "(rows)" would be the last thing found.
        { key: 'rows', label: `Rows: ${labelOf(meta.get(rowName), rowName)}`, color: ROW_COLOR },
        { key: 'cols', label: `Columns: ${labelOf(meta.get(colName), colName)}`, color: COL_COLOR },
      ],
    });
  }
  await app.results.appendText(
    'Correspondence analysis decomposes the table\'s **inertia** (total χ²/N association) into dimensions, like PCA for categories. In the **biplot**, row and column categories that lie in the same direction from the origin tend to co-occur; categories near the origin are close to the average profile. Keep the first 1–2 dimensions if they capture most of the inertia.',
  );
}

// --- MDS ---------------------------------------------------------------------

export async function mds(app, { vars, label: labelName }) {
  if (!vars || vars.length < 2) { await app.results.appendError('MDS: choose at least two numeric attributes.'); return; }
  const meta = metaMap(await app.data.getVariableMeta());
  const hasLabel = !!labelName;
  const rCode = `
    suppressMessages(library(svglite))
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
         asp = 1)
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
        ['Objects mapped', f(r.num1('n'), 0)],
        ['Goodness of fit (2-D)', f(r.num1('goodness'), 3)],
        ['Eigenvalue — Dim 1', f(r.num1('ev1'), 3)],
        ['Eigenvalue — Dim 2', f(r.num1('ev2'), 3)],
      ],
      rowHeaders: true,
    },
    { caption: `Multidimensional Scaling — ${vars.length} attributes` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg), { title: 'MDS perceptual map' });
  await app.results.appendText(
    'Classical MDS places objects so that 2-D distances approximate their dissimilarity across the (standardized) attributes — objects close together are similar. **Goodness of fit** near 1 means two dimensions represent the structure well. This is the perceptual-map workhorse for branding/marketing and similarity studies.',
  );
}
