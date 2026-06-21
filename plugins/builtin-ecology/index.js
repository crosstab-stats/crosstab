/**
 * @file plugins/builtin-ecology/index.js
 * Built-in plugin: **ecological diversity & ordination** — community-ecology
 * statistics (also used in microbiome, and as general "diversity of a
 * distribution" measures). From a sites × species count matrix it computes
 * per-site diversity (richness, Shannon, Simpson, Pielou evenness) and an NMDS
 * ordination of sites by community similarity. Uses the `vegan` package.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-ecology',
  name: 'Ecological diversity',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Multivariate',
  keywords: ['ecology', 'diversity', 'shannon', 'simpson', 'richness', 'evenness', 'ordination', 'nmds', 'vegan', 'community'],
  disciplines: ['Ecology', 'Environmental Studies'],
  rPackages: ['vegan', 'svglite'],
  menu: [
    {
      label: 'Diversity & ordination…',
      run: 'run',
      order: 45,
      inputs: [
        { name: 'species', kind: 'variables', label: 'Species/category counts (one column each)', multiple: true, types: ['numeric'], unique: true },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

export async function run(app, { species }) {
  if (!species || species.length < 2) {
    await app.results.appendError('Diversity: choose at least two species/category count columns.');
    return;
  }
  await app.webr.installPackages(['vegan']);
  const meta = metaMap(await app.data.getVariableMeta());
  const recodes = species.map((n) => recodeLine(`species[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    suppressMessages({library(vegan); library(svglite)})
    ${recodes}
    m <- as.matrix(as.data.frame(lapply(species, as.numeric)))
    m[is.na(m)] <- 0; m <- m[rowSums(m) > 0, , drop = FALSE]
    rich <- specnumber(m); shan <- diversity(m, "shannon"); simp <- diversity(m, "simpson")
    invsimp <- diversity(m, "invsimpson"); even <- ifelse(rich > 1, shan / log(rich), NA)
    svg <- ""
    if (nrow(m) >= 4 && ncol(m) >= 3) {
      nmds <- tryCatch(metaMDS(m, distance = "bray", k = 2, trace = 0, trymax = 20), error = function(e) NULL)
      if (!is.null(nmds)) {
        pts <- nmds$points
        .ct_dev <- svgstring(width = 5.6, height = 5, pointsize = 11)
        par(mar = c(4.2, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
        plot(pts[, 1], pts[, 2], pch = 19, col = "${ACCENT}", xlab = "NMDS1", ylab = "NMDS2",
             main = paste0("NMDS ordination (stress = ", round(nmds$stress, 3), ")"))
        text(pts[, 1], pts[, 2], labels = seq_len(nrow(pts)), pos = 3, cex = 0.7, col = "#555555")
        dev.off(); svg <- .ct_dev()
      }
    }
    list(site = seq_len(nrow(m)), rich = as.numeric(rich), shan = as.numeric(shan),
         simp = as.numeric(simp), invsimp = as.numeric(invsimp), even = as.numeric(even),
         nSites = nrow(m), nSpec = ncol(m), svg = svg)`;
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  const r = flat(result);
  const site = r.nums('site'), rich = r.nums('rich'), shan = r.nums('shan'), simp = r.nums('simp'), inv = r.nums('invsimp'), even = r.nums('even');

  await app.results.appendTable(
    {
      columns: ['Site (row)', 'Richness', 'Shannon H', 'Simpson D', 'Inv. Simpson', 'Evenness (J)'],
      rows: site.map((s, i) => [String(s), f(rich[i], 0), f(shan[i], 3), f(simp[i], 3), f(inv[i], 2), f(even[i], 3)]),
      rowHeaders: true,
    },
    { caption: `Diversity Indices — ${r.num('nSpec')} species across ${r.num('nSites')} sites` },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    '**Richness** = number of species present; **Shannon H** and **Simpson D** combine richness and evenness (higher = more diverse); **Pielou evenness J** = H / log(richness) is 1 when all species are equally abundant. The **NMDS** plot places similar communities close together (Bray-Curtis); a stress < 0.2 indicates a usable 2-D representation.',
  );
}

// --- helpers -----------------------------------------------------------------
function cleanSvg(svg) { return String(svg).replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1'); }
function metaMap(meta) { return new Map(meta.map((m) => [m.name, m])); }
function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}
function rStr(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function f(n, d) { return Number.isFinite(n) ? n.toFixed(d) : '—'; }
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
