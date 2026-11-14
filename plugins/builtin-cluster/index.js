/**
 * @file plugins/builtin-cluster/index.js
 * Built-in plugin: **Cluster analysis** (k-means) — the case-grouping counterpart
 * to the variable-reducing Factor analysis, and a surprising gap in the
 * Multivariate menu. Partitions cases into k groups by similarity on the chosen
 * numeric variables. Base R (`kmeans`/`scale`) — no extra packages.
 *
 * Reports cluster sizes, cluster centres (means per cluster, on the original
 * scale), and the between/total sum-of-squares ratio (variance explained).
 * Standardising (z-scores) is on by default so variables on different scales
 * contribute equally.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, labelOf, metaMap, unpackR: flat, rStr } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-cluster',
  name: 'Cluster analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['cluster', 'k-means', 'kmeans', 'segmentation', 'classification', 'unsupervised'],
  disciplines: ['Business', 'Sociology'],
  howto:
    'GUI: Multivariate ▸ k-means cluster analysis, then pick numeric variables and the number of clusters. You get cluster sizes, cluster centres, and the variance explained.\n' +
    'Syntax: run builtin-cluster.kmeans {"vars": ["x", "y"], "k": 3, "standardize": "z"}\n' +
    '  • vars — the numeric variables used to judge similarity between cases.\n' +
    '  • k — number of clusters to split cases into (default 3).\n' +
    '  • standardize — "z" (z-scores, default) or "raw".' +
    '\n' +
    '  • plots — optional, and nothing is drawn unless you ask. The dialog lists\n'
    + '    what this analysis offers; every chart arrives live, with its error bars,\n'
    + '    marks and palette as controls on the chart itself.',

  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'cluster-kmeans',
      title: 'k-means cluster analysis',
      category: 'Multivariate',
      keywords: ['cluster', 'kmeans', 'k-means', 'segment', 'grouping', 'centres', 'centers', 'standardize', 'typology', 'unsupervised'],
      needs: ['builtin-cluster'],
      seeAlso: ['factor-analysis', 'ordination-mds', 'cluster-hierarchical'],
    },
    {
      id: 'cluster-hierarchical',
      title: 'Hierarchical cluster analysis',
      category: 'Multivariate',
      keywords: ['hierarchical', 'dendrogram', 'tree', 'agglomerative', 'ward', 'linkage', 'cut', 'cluster', 'taxonomy'],
      needs: ['builtin-cluster'],
      seeAlso: ['cluster-kmeans', 'factor-analysis'],
    },
  ],
  rPackages: [],
  menu: [
    {
      howto: 'cluster-kmeans',
      label: 'k-means cluster analysis…',
      run: 'kmeans',
      order: 40,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables (numeric)', hint: 'The numeric traits used to judge how similar cases are.', multiple: true, types: ['numeric'] },
        { name: 'k', kind: 'number', label: 'Number of clusters (k)', hint: 'How many groups to split the cases into.', default: 3 },
        {
          name: 'standardize',
          kind: 'choice',
          label: 'Standardize',
          hint: 'Put variables on a common scale so none dominates by size.',
          default: 'z',
          options: [
            { value: 'z', label: 'Yes — z-scores (recommended)' },
            { value: 'raw', label: 'No — raw values' },
          ],
        },
        {
          name: 'plots',
          kind: 'choice',
          label: 'Plots',
          hint: 'Tick the charts you want beside the tables.',
          multiple: true,
          optional: true,
          options: [
            { value: 'profile', label: 'Cluster profiles (centres per variable)' },
            { value: 'sizes', label: 'Cluster sizes' },
          ],
          default: [],
        },
      ],
    },
    {
      howto: 'cluster-hierarchical',
      label: 'Hierarchical cluster analysis…',
      run: 'hierarchical',
      order: 41,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables (numeric)', hint: 'The numeric traits used to judge how similar cases are.', multiple: true, types: ['numeric'] },
        { name: 'k', kind: 'number', label: 'Clusters to cut at', hint: 'Where to cut the tree. You can move the cut on the chart afterwards.', default: 3 },
        {
          name: 'linkage',
          kind: 'choice',
          label: 'Linkage',
          hint: 'How the distance between two CLUSTERS is measured once they hold more than one case.',
          default: 'ward.D2',
          options: [
            { value: 'ward.D2', label: 'Ward (compact, similar-sized)' },
            { value: 'complete', label: 'Complete (furthest pair)' },
            { value: 'average', label: 'Average' },
            { value: 'single', label: 'Single (nearest pair; can chain)' },
            { value: 'centroid', label: 'Centroid' },
          ],
        },
        {
          name: 'distance',
          kind: 'choice',
          label: 'Distance',
          hint: 'How far apart two cases are.',
          default: 'euclidean',
          options: [
            { value: 'euclidean', label: 'Euclidean' },
            { value: 'manhattan', label: 'Manhattan (city block)' },
          ],
        },
        {
          name: 'standardize',
          kind: 'choice',
          label: 'Standardize',
          hint: 'Put variables on a common scale so none dominates by size.',
          default: 'z',
          options: [
            { value: 'z', label: 'Yes — z-scores (recommended)' },
            { value: 'raw', label: 'No — raw values' },
          ],
        },
        {
          name: 'plots',
          kind: 'choice',
          label: 'Plots',
          hint: 'The dendrogram is the output of this method, not an extra.',
          multiple: true,
          optional: true,
          options: [
            { value: 'tree', label: 'Dendrogram' },
            { value: 'profile', label: 'Cluster profiles' },
          ],
          default: ['tree'],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[], k: number, standardize: string}} inputs
 */
export async function kmeans(app, { vars, k, standardize, plots }) {
  if (!vars || vars.length < 1) {
    await app.results.appendError('Cluster analysis: choose at least one numeric variable.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    d <- vars[stats::complete.cases(vars), , drop = FALSE]
    if (nrow(d) < 3) stop("need at least 3 complete cases")
    k <- max(2L, as.integer(if (is.finite(k)) k else 3))
    if (k >= nrow(d)) stop("k must be smaller than the number of cases")
    X <- if (identical(standardize, "raw")) as.matrix(d) else scale(as.matrix(d))
    set.seed(1)
    km <- kmeans(X, centers = k, nstart = 10, iter.max = 50)
    ctr <- aggregate(d, by = list(.cluster = km$cluster), FUN = mean)  # k x (1+p), original scale
    list(k = k, sizes = as.integer(km$size), vars = names(d),
         centers = as.numeric(as.matrix(ctr[, -1, drop = FALSE])),  # column-major: var-major
         totss = km$totss, betweenss = km$betweenss, n = nrow(d))`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const kk = r.num1('k'), sizes = r.nums('sizes'), vnames = r.strs('vars'), centers = r.nums('centers');
  const explained = r.num1('totss') > 0 ? (100 * r.num1('betweenss')) / r.num1('totss') : NaN;

  await app.results.appendTable(
    {
      columns: ['Cluster', 'N', '% of cases'],
      rows: sizes.map((s, i) => [`${i + 1}`, f(s, 0), `${f((100 * s) / r.num1('n'), 1)}%`]),
      rowHeaders: true,
    },
    { caption: `k-means — ${kk} clusters on ${vnames.length} variable${vnames.length === 1 ? '' : 's'} (N = ${r.num1('n')})` },
  );

  // centers flattened column-major: value for variable v, cluster c = v*k + c
  await app.results.appendTable(
    {
      columns: ['Variable', ...Array.from({ length: kk }, (_, c) => `Cluster ${c + 1}`)],
      rows: vnames.map((v, vi) => [labelOf(meta.get(v), v), ...Array.from({ length: kk }, (_, c) => f(centers[vi * kk + c], 3))]),
      rowHeaders: true,
    },
    { caption: `Cluster Centres (means${identicalRaw(standardize) ? '' : ', original scale'})` },
  );

  const wantC = new Set([].concat(plots ?? []));
  if (wantC.has('profile')) {
    // "Compare the centres to characterise each cluster" — the sentence under the table
    // describes a figure, so here it is. One line per cluster across the variables is how
    // a k-means solution is actually interpreted.
    await app.results.appendChart({
      kind: 'categorical',
      title: 'Cluster profiles',
      categories: vnames.map((v) => ({ key: v, label: labelOf(meta.get(v), v) })),
      series: Array.from({ length: kk }, (_, c) => ({
        key: `c${c + 1}`,
        label: `Cluster ${c + 1} (n = ${sizes[c]})`,
        values: vnames.map((_v, vi) => centers[vi * kk + c]),
      })),
      axes: { x: { title: 'Variable' }, y: { title: identicalRaw(standardize) ? 'Mean' : 'Mean (z-scored input, original units)' } },
      view: { mark: 'line', legend: 'right' },
    });
  }
  if (wantC.has('sizes')) {
    // Cluster sizes are a diagnostic, not decoration: one cluster holding 2% of the cases
    // is usually a solution that found outliers rather than structure.
    await app.results.appendChart({
      kind: 'categorical',
      title: 'Cluster sizes',
      categories: Array.from({ length: kk }, (_, c) => ({ key: `c${c + 1}`, label: `Cluster ${c + 1}` })),
      series: [{ key: 'n', label: 'Cases', values: sizes }],
      counts: true,
      axes: { x: { title: 'Cluster' }, y: { title: 'Cases' } },
      view: { mark: 'bar', legend: 'none' },
    });
  }
  await app.results.appendText(
    `Clusters explain **${f(explained, 1)}%** of total variance (between-cluster SS / total SS). ` +
      'Compare the centres to characterise each cluster. k-means is sensitive to k and to scaling — ' +
      (identicalRaw(standardize) ? 'consider standardizing if variables are on different scales.' : 'variables were z-scored so each contributes equally.'),
  );
}

// --- helpers -----------------------------------------------------------------

function identicalRaw(s) {
  return s === 'raw';
}

/**
 * Hierarchical cluster analysis — the other half of the Multivariate menu's clustering.
 *
 * k-means asks you for k before it starts and gives you a partition. Hierarchical
 * clustering asks for nothing and gives you a NESTING: every case starts alone, the two
 * closest join, and so on until one cluster holds everything. You then decide where to
 * cut, with the tree in front of you. That is the appeal for the fields that use it —
 * ecology (which communities resemble which), scale development (which items hang
 * together), segmentation — and it is also why the dendrogram is not decoration here:
 * the tree IS the output, and a table of merge heights is an unreadable form of it.
 *
 * Base R: `dist` + `hclust` + `cutree`, no packages.
 *
 * @param {object} app
 * @param {{vars: string[], k: number, linkage: string, distance: string,
 *          standardize: string, plots: string[]}} inputs
 */
export async function hierarchical(app, {
  vars, k, linkage, distance, standardize, plots,
}) {
  if (!vars || vars.length < 1) {
    await app.results.appendError('Hierarchical clustering: choose at least one numeric variable.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const want = new Set([].concat(plots ?? []));
  const method = ['ward.D2', 'complete', 'average', 'single', 'centroid'].includes(linkage)
    ? linkage : 'ward.D2';
  const metric = ['euclidean', 'manhattan'].includes(distance) ? distance : 'euclidean';
  const rCode = `
    d <- vars[stats::complete.cases(vars), , drop = FALSE]
    if (nrow(d) < 3) stop("need at least 3 complete cases")
    X <- if (identical(standardize, "raw")) as.matrix(d) else scale(as.matrix(d))
    hc <- stats::hclust(stats::dist(X, method = ${rStr(metric)}), method = ${rStr(method)})
    kk <- max(2L, min(as.integer(if (is.finite(k)) k else 3), nrow(d) - 1L))
    grp <- stats::cutree(hc, k = kk)
    ctr <- aggregate(d, by = list(.cluster = grp), FUN = mean)
    list(
      n = nrow(d), k = kk, vars = names(d),
      sizes = as.integer(table(grp)),
      centers = as.numeric(as.matrix(ctr[, -1, drop = FALSE])),  # column-major: var-major
      # The tree itself. hclust's merge convention travels as-is: negative is a leaf,
      # positive an earlier step, both 1-based — the kind reads exactly that, so nothing
      # is re-indexed on either side of the bridge.
      merge = as.numeric(t(hc$merge)), height = hc$height, order = as.integer(hc$order),
      # The last few heights are what a scree-of-merges is read from: a big jump means
      # the step joined two groups that were not alike.
      labels = if (is.null(rownames(d))) as.character(seq_len(nrow(d))) else rownames(d)
    )`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const kk = r.num1('k');
  const sizes = r.nums('sizes');
  const vnames = r.strs('vars');
  const centers = r.nums('centers');

  await app.results.appendTable(
    {
      columns: ['Cluster', 'N', '% of cases'],
      rows: sizes.map((s, i) => [`${i + 1}`, f(s, 0), `${f((100 * s) / r.num1('n'), 1)}%`]),
      rowHeaders: true,
    },
    {
      caption: `Hierarchical clustering — ${LINKAGE_LABEL[method]} linkage, ${metric} distance, `
        + `cut at ${kk} clusters (N = ${r.num1('n')})`,
    },
  );

  await app.results.appendTable(
    {
      columns: ['Variable', ...Array.from({ length: kk }, (_, c) => `Cluster ${c + 1}`)],
      rows: vnames.map((v, vi) => [
        labelOf(meta.get(v), v),
        ...Array.from({ length: kk }, (_, c) => f(centers[vi * kk + c], 3)),
      ]),
      rowHeaders: true,
    },
    { caption: 'Cluster Centres (means)' },
  );

  if (want.has('tree')) {
    const order = r.nums('order');
    const labels = r.strs('labels');
    const height = r.nums('height');
    // The cut is pre-filled at the height that produces the k the user asked for:
    // midway between the last merge kept and the first rejected, which is where anyone
    // would draw it by hand.
    const sorted = [...height].sort((a, b) => a - b);
    const above = sorted[sorted.length - (kk - 1)];
    const below = sorted[sorted.length - kk];
    await app.results.appendChart({
      kind: 'dendrogram',
      title: `Cluster dendrogram (${LINKAGE_LABEL[method]} linkage)`,
      // hclust's `order` is the leaf sequence that draws without crossings.
      leaves: order.map((idx) => ({ key: `c${idx}`, label: labels[idx - 1] ?? String(idx) })),
      merge: remapMerge(r.nums('merge'), order),
      height,
      axes: { y: { title: `Distance (${metric})` } },
      view: {
        cut: Number.isFinite(above) && Number.isFinite(below) ? (above + below) / 2 : null,
        leafLabels: order.length <= 60,
      },
    });
  }
  if (want.has('profile')) {
    await app.results.appendChart({
      kind: 'categorical',
      title: 'Cluster profiles',
      categories: vnames.map((v) => ({ key: v, label: labelOf(meta.get(v), v) })),
      series: Array.from({ length: kk }, (_, c) => ({
        key: `c${c + 1}`,
        label: `Cluster ${c + 1} (n = ${sizes[c]})`,
        values: vnames.map((_v, vi) => centers[vi * kk + c]),
      })),
      axes: { x: { title: 'Variable' }, y: { title: 'Mean' } },
      view: { mark: 'line', legend: 'right' },
    });
  }

  await app.results.appendText(
    `**${LINKAGE_LABEL[method]} linkage** decides how far apart two CLUSTERS are once they `
    + 'hold more than one case — Ward joins the pair that adds least within-cluster variance '
    + '(compact, similar-sized clusters), complete uses the furthest pair (compact, '
    + 'outlier-sensitive), average the mean distance, single the nearest pair (which can '
    + 'chain long straggly clusters). The choice changes the tree, so it is reported.\n\n'
    + 'Cut the tree where the branches below are short and the join above is long: a tall '
    + 'join means the two groups it merged were not alike. The cut line on the dendrogram '
    + `is set to give the ${kk} clusters asked for, and moving it is a control on the chart.`,
  );
}

/** Linkage names as they are written in a methods section. */
const LINKAGE_LABEL = {
  'ward.D2': 'Ward',
  complete: 'Complete',
  average: 'Average',
  single: 'Single',
  centroid: 'Centroid',
};

/**
 * hclust indexes its leaves by ROW; the chart draws them in `order`. Rather than make
 * the kind know about hclust's ordering, the leaf references are remapped once here, so
 * the model that crosses the bridge is already in drawing order.
 *
 * @param {number[]} merge flat pairs, hclust's convention
 * @param {number[]} order hclust's leaf order, 1-based row numbers
 * @returns {number[]} the same pairs with leaf references renumbered to positions
 */
export function remapMerge(merge, order) {
  const position = new Map(order.map((row, i) => [row, i + 1]));
  return merge.map((code) => (code < 0 ? -(position.get(-code) ?? -code) : code));
}
