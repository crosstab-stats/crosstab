/**
 * @file plugins/builtin-sna/index.js
 * Built-in plugin: **social network analysis** — from an edge list (two columns:
 * from, to) it builds a graph and reports the network-level structure (density,
 * components, path length, clustering) and the most central actors (degree,
 * betweenness, closeness, eigenvector), plus a network plot. The core toolkit for
 * relational data in sociology, communication and org studies. Uses `igraph`.
 */

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fixed: f, unpackR: flat, cleanSvg } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-sna',
  name: 'Social network analysis',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['social network', 'sna', 'network', 'graph', 'centrality', 'betweenness', 'degree', 'density', 'igraph', 'edge list'],
  howto:
    'GUI: Multivariate ▸ Network analysis (edge list), then pick a From and To column (an edge list) and whether edges are directed. ' +
    'You get network structure (density, components, path length, clustering), top central actors, and a network plot.\n' +
    'Syntax: run builtin-sna.run {"from": "source", "to": "target", "directed": "undirected"}\n' +
    '  • from / to — the two columns naming each tie\'s endpoints.\n' +
    '  • directed — "undirected" (default) or "directed".',
  disciplines: ['Sociology', 'Anthropology', 'Communication', 'Political Science'],
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'sna-network',
      title: 'Network analysis (edge list)',
      category: 'Multivariate',
      keywords: ['network', 'sna', 'social network', 'edge list', 'centrality', 'density', 'components', 'clustering', 'graph', 'ties', 'directed'],
      needs: ['builtin-sna'],
      seeAlso: ['cluster-kmeans'],
    },
  ],
  rPackages: ['igraph', 'svglite'],
  menu: [
    {
      howto: 'sna-network',
      label: 'Network analysis (edge list)…',
      run: 'run',
      order: 48,
      inputs: [
        { name: 'from', kind: 'variables', label: 'From (source node)', hint: 'The actor at one end of each tie.', multiple: false, types: ['string', 'factor', 'numeric'], unique: true },
        { name: 'to', kind: 'variables', label: 'To (target node)', hint: 'The actor at the other end of each tie.', multiple: false, types: ['string', 'factor', 'numeric'], unique: true },
        { name: 'directed', kind: 'choice', label: 'Edges are', hint: 'Choose directed if ties have a sender and receiver.', default: 'undirected', options: [
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
  const dir = directed === 'directed';
  const rCode = `
    suppressMessages({library(igraph); library(svglite)})
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
         edge.color = "#bbbbbb")
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
        ['Nodes', f(r.num1('nodes'), 0)],
        ['Edges', f(r.num1('edges'), 0)],
        ['Density', f(r.num1('density'), 4)],
        ['Components', f(r.num1('ncomp'), 0)],
        ['Transitivity (clustering)', f(r.num1('transitivity'), 4)],
        ['Avg. path length', f(r.num1('apl'), 3)],
        ['Diameter', f(r.num1('diameter'), 0)],
      ],
      rowHeaders: true,
    },
    { caption: `Network Summary (${r.num1('directed') === 1 ? 'directed' : 'undirected'})` },
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
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg), { title: 'Network' });
  await app.results.appendText(
    '**Density** is the share of possible ties present; **components** are disconnected sub-networks; **transitivity** is the chance two of a node\'s contacts are themselves tied (clustering). Centrality flavours: **degree** (how many ties), **betweenness** (bridging/broker position), **closeness** (reach), **eigenvector** (tied to well-connected others).',
  );
}
