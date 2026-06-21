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

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-cluster',
  name: 'Cluster analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['cluster', 'k-means', 'kmeans', 'segmentation', 'classification', 'unsupervised'],
  disciplines: ['Business', 'Sociology'],
  rPackages: [],
  menu: [
    {
      label: 'k-means cluster analysis…',
      run: 'kmeans',
      order: 40,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Variables (numeric)', multiple: true, types: ['numeric'] },
        { name: 'k', kind: 'number', label: 'Number of clusters (k)', default: 3 },
        {
          name: 'standardize',
          kind: 'choice',
          label: 'Standardize',
          default: 'z',
          options: [
            { value: 'z', label: 'Yes — z-scores (recommended)' },
            { value: 'raw', label: 'No — raw values' },
          ],
        },
      ],
    },
  ],
};

/**
 * @param {object} app
 * @param {{vars: string[], k: number, standardize: string}} inputs
 */
export async function kmeans(app, { vars, k, standardize }) {
  if (!vars || vars.length < 1) {
    await app.results.appendError('Cluster analysis: choose at least one numeric variable.');
    return;
  }
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = vars.map((n) => recodeLine(`vars[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    ${recodes}
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
  const kk = r.num('k'), sizes = r.nums('sizes'), vnames = r.strs('vars'), centers = r.nums('centers');
  const explained = r.num('totss') > 0 ? (100 * r.num('betweenss')) / r.num('totss') : NaN;

  await app.results.appendTable(
    {
      columns: ['Cluster', 'N', '% of cases'],
      rows: sizes.map((s, i) => [`${i + 1}`, f(s, 0), `${f((100 * s) / r.num('n'), 1)}%`]),
      rowHeaders: true,
    },
    { caption: `k-means — ${kk} clusters on ${vnames.length} variable${vnames.length === 1 ? '' : 's'} (N = ${r.num('n')})` },
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

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
}

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList);
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map(Number),
    strs: (k) => arr(byName[k]).map(String),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
  };
}
