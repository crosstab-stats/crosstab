/**
 * @file spike/compare-geo-sf.mjs
 * **Does CrossTab's hand-rolled point-in-polygon agree with `sf`?**
 *
 *     node spike/compare-geo-sf.mjs
 *
 * Needs local R with `sf`. Exits non-zero on any disagreement.
 *
 * ## Why this exists
 *
 * The geocoder in `builtin-spatial` is hand-rolled JS rather than Turf.js, for a dependency
 * reason that is sound (a sandboxed opaque-origin iframe makes an external import expensive
 * forever) but that only holds if the arithmetic is right. The owner's rule, after the mixture
 * models: *"it's good to check ourselves any time we need to hand-roll or modify a standard R
 * library."* `sf` is the authority — it is what the spatial plugin already declares for its R
 * analyses, and it is GEOS underneath, which is the same engine QGIS and PostGIS use.
 *
 * Unit tests prove the geocoder is self-consistent. This proves it agrees with the thing the
 * user's colleague would run.
 *
 * ## The one place they differ, deliberately
 *
 * Boundary points. `sf` follows DE-9IM, where a point ON the edge is:
 *   - **not** `st_within` the polygon (within requires the interior), so a border case belongs
 *     to NEITHER neighbour;
 *   - `st_intersects` BOTH neighbours.
 *
 * Neither is usable for geocoding: the first drops cases on a county line, the second
 * double-counts them. The half-open ray-casting rule assigns such a case to exactly ONE
 * neighbour, which is the only answer that keeps a total correct.
 *
 * So the comparison is split. **Interior points must agree with `st_within` exactly** — any
 * difference there is a bug in the geocoder. **Boundary points** are reported separately, and
 * the assertion is the geocoding one: exactly one region, never zero, never two.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assignRegions, buildRegionIndex, regionsAt } from '../plugins/builtin-spatial/index.js';

const RSCRIPT = process.env.RSCRIPT || 'C:/Program Files/R/R-4.6.0/bin/Rscript.exe';
const RLIB = process.env.R_LIBS_USER || 'C:/Users/Ryan/R-libs';

// --- the geometry: the awkward cases, not a grid of squares --------------------------------
const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const poly = (id, coords) => ({
  type: 'Feature', properties: { GEOID: id }, geometry: { type: 'Polygon', coordinates: coords },
});

const FEATURES = [
  // Two squares sharing the line x = 10 — the shared-border case.
  poly('A', [ring(0, 0, 10, 10)]),
  poly('B', [ring(10, 0, 20, 10)]),
  // A concave L, whose notch is inside the bounding box and outside the shape.
  poly('L', [[[0, 10], [10, 10], [10, 14], [4, 14], [4, 20], [0, 20], [0, 10]]]),
  // A donut: an enclave that must NOT be part of the ring around it.
  poly('D', [ring(20, 0, 30, 10), ring(23, 3, 27, 7)]),
  // The enclave itself, as its own region — the Lesotho case.
  poly('E', [ring(23, 3, 27, 7)]),
  // An island county: one region, two disjoint pieces.
  {
    type: 'Feature',
    properties: { GEOID: 'M' },
    geometry: { type: 'MultiPolygon', coordinates: [[ring(20, 12, 24, 16)], [ring(26, 12, 30, 16)]] },
  },
];

// --- the points: a deterministic scatter plus deliberate edge cases -------------------------
function makePoints() {
  const xs = [];
  const ys = [];
  const kind = [];
  // A reproducible pseudo-random scatter over the whole extent (no Math.random: the comparison
  // has to be re-runnable and identical).
  let seed = 20260929;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 4000; i += 1) {
    xs.push(rnd() * 32 - 1);
    ys.push(rnd() * 22 - 1);
    kind.push('scatter');
  }
  // On the shared border, on the outer edges, and on vertices — where the rules diverge.
  for (let y = 0; y <= 10; y += 1) { xs.push(10); ys.push(y); kind.push('border'); }
  for (const [x, y] of [[0, 0], [10, 10], [20, 0], [5, 0], [0, 5], [23, 3], [27, 7]]) {
    xs.push(x); ys.push(y); kind.push('border');
  }
  return { xs, ys, kind };
}

const { xs, ys, kind } = makePoints();
const index = buildRegionIndex(FEATURES, 'GEOID');
const mine = assignRegions(index, xs, ys);
const mineCount = xs.map((x, i) => regionsAt(index, x, ys[i]).length);

// --- hand the same geometry and the same points to sf ---------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'ct-geo-'));
writeFileSync(join(dir, 'regions.geojson'), JSON.stringify({ type: 'FeatureCollection', features: FEATURES }));
writeFileSync(
  join(dir, 'points.csv'),
  `x,y,kind,mine,mineCount\n${xs.map((x, i) => `${x},${ys[i]},${kind[i]},${mine.regions[i] ?? ''},${mineCount[i]}`).join('\n')}\n`,
);

const rScript = `
.libPaths(c(${JSON.stringify(RLIB)}, .libPaths()))
suppressMessages(library(sf))
options(warn = 1)
# PLANAR geometry on both sides, or the comparison is measuring the wrong thing. sf 1.x uses s2
# for a geographic CRS, where an edge between two lon/lat points is a great-circle arc: a
# 10-degree-long "horizontal" edge bows measurably north of the parallel it looks like. The
# geocoder is planar by design. Whether that design is right is a separate question, quantified
# in the last section rather than smuggled into this one.
sf_use_s2(FALSE)
fails <- 0
say <- function(ok, what, detail = "") {
  if (isTRUE(ok)) cat(sprintf("  AGREE      %-34s %s\\n", what, detail))
  else { cat(sprintf("  DISAGREE   %-34s %s\\n", what, detail)); fails <<- fails + 1 }
}

rg <- st_read(${JSON.stringify(join(dir, 'regions.geojson').replace(/\\/g, '/'))}, quiet = TRUE)
pt <- read.csv(${JSON.stringify(join(dir, 'points.csv').replace(/\\/g, '/'))}, stringsAsFactors = FALSE)
sp <- st_as_sf(pt, coords = c("x", "y"), crs = st_crs(rg))

# st_within: strictly the interior. st_intersects: interior or boundary.
wi <- st_within(sp, rg)
ix <- st_intersects(sp, rg)
nWithin <- lengths(wi)
nInter  <- lengths(ix)
# The region sf puts each point in, by the plugin's own rule (first match in file order).
sfFirst <- vapply(seq_along(wi), function(i) {
  if (length(wi[[i]])) as.character(rg$GEOID[wi[[i]][1]]) else ""
}, character(1))
ours <- ifelse(is.na(pt$mine), "", pt$mine)

cat("\\n=== interior points: must match sf::st_within exactly ===\\n")
# "Interior" as sf defines it: the point is strictly inside exactly one polygon, and not on any
# boundary. That is the overwhelming majority of real cases.
interior <- nWithin == nInter          # no polygon has it merely touching
n_int <- sum(interior)
mismatch <- which(interior & ours != sfFirst)
say(length(mismatch) == 0, "every interior point, same region",
    sprintf("%d points checked, %d differ", n_int, length(mismatch)))
if (length(mismatch)) {
  for (i in head(mismatch, 10)) {
    cat(sprintf("      (%.4f, %.4f)  ours=%-4s sf=%-4s\\n",
        st_coordinates(sp)[i,1], st_coordinates(sp)[i,2], ours[i], sfFirst[i]))
  }
}
# And the counts agree too: our hit-count equals how many polygons sf says contain it.
say(all(pt$mineCount[interior] == nWithin[interior]), "every interior point, same NUMBER of regions",
    sprintf("incl. %d in the donut's hole and %d outside everything",
            sum(interior & nWithin == 0 & pt$x > 20 & pt$x < 30 & pt$y > 0 & pt$y < 10),
            sum(interior & nWithin == 0)))

cat("\\n=== overlapping regions: the enclave really is in two ===\\n")
# 'D' is a donut and 'E' fills its hole, so a point in the hole is inside E only; a point in the
# donut ring is inside D only. Nothing should be inside both, and sf must agree.
say(all(pt$mineCount[interior] <= 1), "no interior point lands in two regions",
    sprintf("max = %d", max(pt$mineCount[interior])))
inE <- interior & ours == "E"
say(sum(inE) > 0 && all(sfFirst[inE] == "E"), "the enclave is its own region, not the donut's",
    sprintf("%d points in E", sum(inE)))

cat("\\n=== boundary points: where the rules differ, on purpose ===\\n")
bnd <- which(pt$kind == "border")
# sf, DE-9IM: a point on an edge is within NEITHER neighbour and intersects BOTH.
say(all(nWithin[bnd] == 0), "sf::st_within puts a border point in NO region",
    sprintf("%d border points, max within = %d", length(bnd), max(nWithin[bnd])))
shared <- bnd[nInter[bnd] > 1]
say(length(shared) > 0, "...and st_intersects puts them in TWO or more",
    sprintf("%d such points", length(shared)))

# The geocoder's rule, stated as the three things actually true of it. The first is the
# load-bearing one: a case counted twice inflates two totals, which is a wrong NUMBER, while a
# case counted zero times is a visible one in the outside count.
say(all(pt$mineCount[bnd] <= 1), "the geocoder NEVER puts a case in two",
    sprintf("max = %d over %d border points", max(pt$mineCount[bnd]), length(bnd)))

onEdge <- bnd[pt$x[bnd] == 10 & pt$y[bnd] > 0 & pt$y[bnd] < 10]
say(all(pt$mineCount[onEdge] == 1), "on a shared EDGE it picks exactly one",
    sprintf("%d points along x = 10", length(onEdge)))
picked_ok <- all(vapply(onEdge, function(i) {
  ours[i] != "" && ours[i] %in% as.character(rg$GEOID[ix[[i]]])
}, logical(1)))
say(picked_ok, "and the one it picks is one sf says it touches")

# At a VERTEX the half-open rule can exclude every neighbour at once. That is the cost of never
# double-counting, and it is reported rather than hidden: the case lands in outside.
vert <- bnd[!(bnd %in% onEdge)]
nz <- vert[pt$mineCount[vert] == 0]
cat(sprintf("  NOTE       %-34s %d of %d vertices land in no region, counted as outside\\n",
    "vertices are the cost of that rule", length(nz), length(vert)))
say(all(nWithin[nz] == 0), "...and st_within agrees they are in none",
    "so it is a tie-breaking difference, not a containment one")

cat("\\n=== planar vs spherical: the geocoder's real limit ===\\n")
# The geocoder treats lon/lat as planar; sf with s2 ON treats an edge as a great-circle arc,
# which bows away from the parallel it looks like. "We are planar" is only an acceptable answer
# if that gap is small at the scale people actually work at, so it is measured rather than
# asserted: binary-search the offset at which s2 flips a point from inside to outside.
sf_use_s2(TRUE)
bulge <- function(span, lat = 45) {
  sq <- st_sfc(st_polygon(list(rbind(c(0, lat), c(span, lat), c(span, lat + span),
                                     c(0, lat + span), c(0, lat)))), crs = 4326)
  # Probe ABOVE the top edge. In the northern hemisphere a great-circle arc between two points
  # at the same latitude bows poleward, so the top edge bulges north and the polygon reaches
  # FURTHER than the parallel suggests. (Probing below the bottom edge measures nothing: that
  # edge bulges away from the interior, so the flip sits at zero and the search returns its own
  # floor -- which is exactly what the first version of this reported, for every span.)
  lo <- 0; hi <- span
  for (i in 1:40) {
    mid <- (lo + hi) / 2
    p <- st_sfc(st_point(c(span / 2, lat + span + mid)), crs = 4326)
    if (length(st_within(p, sq)[[1]])) lo <- mid else hi <- mid
  }
  (lo + hi) / 2
}
for (span in c(10, 1, 0.1, 0.01)) {
  b <- bulge(span)
  cat(sprintf("  %-6g deg edge -> the arc bows %.3e deg from the parallel (~%.2f m)\\n",
      span, b, b * 111320))
}
cat("  The effect is QUADRATIC in edge length, so it collapses fast: a boundary file whose\\n")
cat("  vertices sit a few hundred metres apart (any census tract or county) puts the two\\n")
cat("  models millimetres apart, and a case would have to fall within that of a border to\\n")
cat("  be assigned differently. A continent-sized polygon with 10-degree edges is the one\\n")
cat("  place it would matter, and that is not what anyone geocodes against.\\n")

cat("\\n================================================\\n")
if (fails == 0) cat("GEOCODER AGREES WITH sf\\n") else cat(sprintf("%d DISAGREEMENT(S)\\n", fails))
quit(status = if (fails == 0) 0 else 1)
`;

const rPath = join(dir, 'compare.R');
writeFileSync(rPath, rScript);
console.log(`geometry + ${xs.length} points -> ${dir}`);
console.log(`geocoder: ${mine.assigned} assigned, ${mine.outside} outside, ${mine.ambiguous} in more than one`);
const run = spawnSync(RSCRIPT, [rPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${run.stdout || ''}${run.stderr || ''}`;
process.stdout.write(out.split('\n').filter((l) => !/built under R version|^Warning message|GDAL|PROJ/.test(l)).join('\n'));
if (run.status !== 0) console.error(`\nRscript exited ${run.status}. Files kept in ${dir}`);
void readFileSync;
process.exit(run.status ?? 1);
