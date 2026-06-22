/**
 * @file plugins/builtin-sna/index.js
 * Built-in plugin: **social network analysis** — from an edge list (two columns:
 * from, to) it builds a graph and reports the network-level structure (density,
 * components, path length, clustering) and the most central actors (degree,
 * betweenness, closeness, eigenvector), plus a network plot. The core toolkit for
 * relational data in sociology, communication and org studies. Uses `igraph`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-sna',
  name: 'Social network analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['social network', 'sna', 'network', 'graph', 'centrality', 'betweenness', 'degree', 'density', 'igraph', 'edge list'],
  disciplines: ['Sociology', 'Anthropology', 'Communication', 'Political Science'],
  rPackages: ['igraph', 'svglite'],
  menu: [
    {
      label: 'Network analysis (edge list)…',
      run: 'run',
      order: 48,
      inputs: [
        { name: 'from', kind: 'variables', label: 'From (source node)', multiple: false, types: ['string', 'factor', 'numeric'], unique: true },
        { name: 'to', kind: 'variables', label: 'To (target node)', multiple: false, types: ['string', 'factor', 'numeric'], unique: true },
        { name: 'directed', kind: 'choice', label: 'Edges are', default: 'undirected', options: [
          { value: 'undirected', label: 'Undirected' },
          { value: 'directed', label: 'Directed' },
        ] },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

export async function run(app, { from: fromName, to: toName, directed }) {
  if (!fromName || !toName) { await app.results.appendError('Network analysis: choose a "from" and a "to" column (an edge list).'); return; }
  await app.webr.installPackages(['igraph']);
  const meta = metaMap(await app.data.getVariableMeta());
  const dir = directed === 'directed';
  const recodes = [recodeLine('from', meta.get(fromName)), recodeLine('to', meta.get(toName))].filter(Boolean).join('\n');
  const rCode = `
    suppressMessages({library(igraph); library(svglite)})
    ${recodes}
    el <- cbind(as.character(from), as.character(to))
    el <- el[stats::complete.cases(el) & el[,1] != "" & el[,2] != "", , drop = FALSE]
    g <- graph_from_edgelist(el, directed = ${dir ? 'TRUE' : 'FALSE'})
    deg <- degree(g); btw <- betweenness(g); clo <- suppressWarnings(closeness(g))
    eig <- tryCatch(eigen_centrality(g)$vector, error = function(e) rep(NA_real_, vcount(g)))
    ord <- order(deg, decreasing = TRUE); topn <- head(ord, 10)
    .ct_dev <- svgstring(width = 6, height = 5.6, pointsize = 10)
    par(mar = c(0.5, 0.5, 1.5, 0.5))
    set.seed(1)
    plot(g, vertex.size = pmin(25, 6 + 2 * deg), vertex.color = "${ACCENT}", vertex.frame.color = "white",
         vertex.label.cex = 0.7, vertex.label.color = "#222222", edge.arrow.size = 0.4,
         edge.color = "#bbbbbb", main = "Network")
    dev.off(); svg <- .ct_dev()
    list(nodes = vcount(g), edges = ecount(g), density = edge_density(g), ncomp = components(g)$no,
         transitivity = transitivity(g, type = "global"), apl = mean_distance(g),
         diameter = diameter(g), directed = ${dir ? 'TRUE' : 'FALSE'},
         topName = V(g)$name[topn], topDeg = deg[topn], topBtw = btw[topn], topClo = clo[topn], topEig = eig[topn], svg = svg)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Nodes', f(r.num('nodes'), 0)],
        ['Edges', f(r.num('edges'), 0)],
        ['Density', f(r.num('density'), 4)],
        ['Components', f(r.num('ncomp'), 0)],
        ['Transitivity (clustering)', f(r.num('transitivity'), 4)],
        ['Avg. path length', f(r.num('apl'), 3)],
        ['Diameter', f(r.num('diameter'), 0)],
      ],
      rowHeaders: true,
    },
    { caption: `Network Summary (${r.num('directed') === 1 ? 'directed' : 'undirected'})` },
  );

  const nm = r.strs('topName'), deg = r.nums('topDeg'), btw = r.nums('topBtw'), clo = r.nums('topClo'), eig = r.nums('topEig');
  await app.results.appendTable(
    {
      columns: ['Node', 'Degree', 'Betweenness', 'Closeness', 'Eigenvector'],
      rows: nm.map((n, i) => [n, f(deg[i], 0), f(btw[i], 2), f(clo[i], 4), f(eig[i], 3)]),
      rowHeaders: true,
    },
    { caption: 'Most Central Actors (top 10 by degree)' },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    '**Density** is the share of possible ties present; **components** are disconnected sub-networks; **transitivity** is the chance two of a node\'s contacts are themselves tied (clustering). Centrality flavours: **degree** (how many ties), **betweenness** (bridging/broker position), **closeness** (reach), **eigenvector** (tied to well-connected others).',
  );
}

// --- helpers -----------------------------------------------------------------
function cleanSvg(svg) { return String(svg).replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1'); }
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  else Object.assign(byName, rList || {});
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => { const a = arr(byName[k]); return a.length ? Number(a[0]) : NaN; },
    str1: (k) => { const a = arr(byName[k]); return a.length ? String(a[0]) : ''; },
  };
}
