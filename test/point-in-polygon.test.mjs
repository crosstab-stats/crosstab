/**
 * @file point-in-polygon.test.mjs
 * Geocoding: which region does each case fall in?
 *
 * The gap it closes is mundane and constant — survey and admin data arrives with latitude and
 * longitude and no area code, while every areal tool in the spatial plugin (choropleth, Moran's
 * I by region, "Analyse selection") needs a region column nobody has. Today that column comes
 * from ArcGIS or a QGIS spatial join before CrossTab is opened at all.
 *
 * **Hand-rolled rather than Turf.js**, which the TODO had assumed. Even-odd ray casting with
 * holes and multipolygons is about forty lines; the dependency is not forty lines, because a
 * plugin runs in a sandboxed opaque-origin iframe — an external import means a CSP allowance, an
 * entry in core/assets.js, a runtime host for the offline cache and a line in the air-gap vendor
 * script, carried forever. That trade is only defensible if the arithmetic is tested properly,
 * which is what this file is for.
 *
 * The four properties that decide whether a geocode can be trusted:
 *
 *  1. **A point on a shared border belongs to exactly ONE region.** The half-open comparison
 *     `(yi > y) !== (yj > y)` gives that; the intuitive `>=` form counts the point in both, so
 *     a respondent on a county line would inflate two counties at once.
 *  2. **A hole is outside.** GeoJWON rings after the first are interior. Get it wrong and every
 *     case in an enclave — Lesotho, a lake, a city carved out of its county — lands in the
 *     surrounding region.
 *  3. **Nothing is invented.** No coordinates, outside every region, and inside several are
 *     three different outcomes with three different meanings, counted separately and reported.
 *  4. **A swapped column pair is named as the likely cause**, because it is by far the most
 *     common way this goes wrong and it presents as "my boundary file doesn't cover my data".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assignRegions, buildRegionIndex, geocodeMessage, geometryBbox, manifest, pointInGeometry,
  pointInPolygonRings, pointInRing, regionsAt, uniqueName,
} from '../plugins/builtin-spatial/index.js';

/** A closed square ring, counter-clockwise. */
const ring = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const square = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [ring(x0, y0, x1, y1)] });
const feature = (id, geometry) => ({ type: 'Feature', properties: { GEOID: id }, geometry });

/** Two counties sharing the line x = 10. */
const TWO = [feature('A', square(0, 0, 10, 10)), feature('B', square(10, 0, 20, 10))];
const idxOf = (features) => buildRegionIndex(features, 'GEOID');
const at = (index, x, y) => regionsAt(index, x, y).map((i) => index.keys[i]);

// =============================================================================
// The ring test
// =============================================================================

test('a point inside a square is inside, and one outside is not', () => {
  const r = ring(0, 0, 10, 10);
  assert.equal(pointInRing(5, 5, r), true);
  assert.equal(pointInRing(15, 5, r), false);
  assert.equal(pointInRing(5, 15, r), false);
  assert.equal(pointInRing(-5, 5, r), false);
});

test('a concave shape is handled — the reason it is ray casting and not a bbox', () => {
  // An L. The notch is inside the bounding box and outside the polygon; a bbox test would
  // place a case in the notch in the wrong region every time.
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
  assert.equal(pointInRing(2, 2, L), true, 'the corner of the L');
  assert.equal(pointInRing(8, 2, L), true, 'the foot of the L');
  assert.equal(pointInRing(8, 8, L), false, 'the notch is NOT inside');
});

test('a degenerate ring is outside everything rather than throwing', () => {
  // Real GeoJSON contains these: an empty geometry, a two-point "ring" from a bad export.
  for (const bad of [[], [[0, 0]], [[0, 0], [1, 1]], null, undefined]) {
    assert.equal(pointInRing(0.5, 0.5, bad), false);
  }
});

// =============================================================================
// Property 1 — a shared border belongs to exactly one region
// =============================================================================

test('a case on a shared border lands in exactly one region', () => {
  const index = idxOf(TWO);
  const hits = at(index, 10, 5);
  assert.equal(hits.length, 1, `a border case must not be counted twice (got ${hits.join(', ')})`);
});

test('every point along a shared border lands in exactly one region', () => {
  // Swept, not spot-checked: the property has to hold along the whole edge, including at the
  // vertices, which is where an off-by-one in the ray cast shows up.
  const index = idxOf(TWO);
  for (let y = 0; y <= 10; y += 0.5) {
    assert.equal(at(index, 10, y).length <= 1, true, `y=${y} matched more than one region`);
  }
  // And the interiors are still each in exactly one.
  assert.deepEqual(at(index, 5, 5), ['A']);
  assert.deepEqual(at(index, 15, 5), ['B']);
});

test('the OUTER edge of the coverage is the documented cost of that rule', () => {
  // The same half-open rule that stops double-counting also means a point exactly on the
  // excluded outer edge falls in no region. It is reported as `outside`, not silently dropped,
  // and it is the right trade: double-counting a border is a wrong number, while a case exactly
  // on the coverage edge is a rounding coincidence the count surfaces. Pinned so that nobody
  // "fixes" it into the double-counting version.
  const index = idxOf(TWO);
  assert.equal(at(index, 5, 10).length, 0, 'the top edge is the excluded side');
  assert.equal(at(index, 5, 0).length, 1, '...and the bottom edge is the included one');
});

// =============================================================================
// Property 2 — holes, multipolygons
// =============================================================================

test('a hole is outside the region that surrounds it', () => {
  const holed = [feature('H', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10), ring(4, 4, 6, 6)] })];
  const index = idxOf(holed);
  assert.deepEqual(at(index, 1, 1), ['H'], 'the body of the region');
  assert.equal(at(index, 5, 5).length, 0, 'the enclave is not part of it');
  assert.equal(pointInPolygonRings(5, 5, [ring(0, 0, 10, 10), ring(4, 4, 6, 6)]), false);
});

test('every part of a multipolygon counts, and the gaps between them do not', () => {
  // An island county, a split district: one region, several pieces.
  const mp = [feature('M', { type: 'MultiPolygon', coordinates: [[ring(0, 0, 2, 2)], [ring(8, 8, 10, 10)]] })];
  const index = idxOf(mp);
  assert.deepEqual(at(index, 1, 1), ['M']);
  assert.deepEqual(at(index, 9, 9), ['M']);
  assert.equal(at(index, 5, 5).length, 0, 'the water between the islands');
});

test('a geometry with no interior is simply never matched', () => {
  for (const geom of [{ type: 'Point', coordinates: [1, 1] }, { type: 'LineString', coordinates: [[0, 0], [2, 2]] }, null]) {
    assert.equal(pointInGeometry(1, 1, geom), false);
  }
});

test('a bounding box covers every ring of every part', () => {
  assert.deepEqual(geometryBbox(square(1, 2, 3, 4)), [1, 2, 3, 4]);
  assert.deepEqual(
    geometryBbox({ type: 'MultiPolygon', coordinates: [[ring(0, 0, 2, 2)], [ring(8, 8, 10, 10)]] }),
    [0, 0, 10, 10],
  );
  assert.equal(geometryBbox({ type: 'Point', coordinates: [1, 1] }), null);
});

// =============================================================================
// The index — a correctness concern, not only a speed one
// =============================================================================

test('the index finds regions whose bbox spans many cells', () => {
  // One huge region plus many small ones: the big one's bbox covers most of the grid, so it has
  // to be registered in every cell it touches or cases inside it would be reported as outside.
  const features = [feature('BIG', square(0, 0, 100, 100))];
  for (let i = 0; i < 40; i += 1) features.push(feature(`S${i}`, square(i * 2, 0, i * 2 + 1, 1)));
  const index = idxOf(features);
  assert.ok(index.size > 1, 'a grid, not one cell');
  for (const [x, y] of [[50, 50], [5, 95], [95, 5], [0.5, 0.5]]) {
    assert.ok(at(index, x, y).includes('BIG'), `missed BIG at ${x},${y}`);
  }
});

test('a large run is fast enough to be interactive', () => {
  // The reason an index exists at all: 5,000 cases against 400 regions is 2,000,000 polygon
  // tests unindexed. This is a smoke test on the order of magnitude, not a benchmark.
  const features = [];
  for (let c = 0; c < 20; c += 1) for (let r = 0; r < 20; r += 1) features.push(feature(`${c}-${r}`, square(c, r, c + 1, r + 1)));
  const index = idxOf(features);
  const xs = [];
  const ys = [];
  for (let i = 0; i < 5000; i += 1) { xs.push((i % 200) / 10 + 0.05); ys.push(((i * 7) % 200) / 10 + 0.05); }
  const t0 = process.hrtime.bigint();
  const res = assignRegions(index, xs, ys);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(res.assigned, 5000, 'every case is inside the grid of regions');
  assert.ok(ms < 1000, `5,000 cases against 400 regions took ${ms.toFixed(0)}ms`);
});

// =============================================================================
// Property 3 — three different outcomes, counted separately
// =============================================================================

test('no coordinates, outside, and inside several are three different things', () => {
  const index = idxOf(TWO);
  const res = assignRegions(index, [5, 15, NaN, 500, 5], [5, 5, 5, 500, null]);
  assert.deepEqual(res.regions, ['A', 'B', null, null, null]);
  assert.equal(res.assigned, 2);
  assert.equal(res.missing, 2, 'a NaN coordinate and a null one');
  assert.equal(res.outside, 1, 'and one real coordinate that no region covers');
});

test('an empty coordinate is missing, NOT the point (0, 0)', () => {
  // The bug this test found. `Number(null)` is 0, `Number('')` is 0, `Number(true)` is 1 — so a
  // case with no coordinate was being placed in whatever region contains the origin, silently
  // and with full confidence. A region file covering the origin would have swallowed every
  // missing case.
  const index = idxOf([feature('ORIGIN', square(-1, -1, 1, 1))]);
  for (const bad of [null, undefined, '', '   ', true, false, 'abc']) {
    const res = assignRegions(index, [bad], [bad]);
    assert.deepEqual(res.regions, [null], `${JSON.stringify(bad)} was treated as a coordinate`);
    assert.equal(res.missing, 1);
    assert.equal(res.assigned, 0);
  }
  // A numeric zero IS a coordinate, and must still be placed.
  assert.deepEqual(assignRegions(index, [0], [0]).regions, ['ORIGIN']);
  assert.deepEqual(assignRegions(index, ['0'], ['0']).regions, ['ORIGIN'], 'and so is "0" from a text column');
});

test('an overlap picks the first in file order, and says it did', () => {
  // Boundary files overlap more often than they should. Something has to be chosen; what must
  // not happen is choosing silently.
  const overlapping = [feature('X', square(0, 0, 10, 10)), feature('Y', square(5, 5, 15, 15))];
  const index = idxOf(overlapping);
  assert.deepEqual(at(index, 7, 7), ['X', 'Y'], 'both genuinely contain it');
  const res = assignRegions(index, [7], [7]);
  assert.deepEqual(res.regions, ['X']);
  assert.equal(res.ambiguous, 1);
});

test('an empty boundary set assigns nothing and does not throw', () => {
  const res = assignRegions(idxOf([]), [1, 2], [1, 2]);
  assert.deepEqual(res.regions, [null, null]);
  assert.equal(res.outside, 2);
  assert.equal(res.assigned, 0);
});

test('mismatched column lengths stop at the shorter one', () => {
  // Rather than reading undefined off the end and calling it missing.
  const res = assignRegions(idxOf(TWO), [5, 5, 5], [5]);
  assert.equal(res.regions.length, 1);
  assert.equal(res.assigned, 1);
});

test('a region id is read from the named property, and a missing one is empty not undefined', () => {
  const index = buildRegionIndex([
    { properties: { NAME: 'Kent' }, geometry: square(0, 0, 1, 1) },
    { properties: {}, geometry: square(1, 0, 2, 1) },
  ], 'NAME');
  assert.deepEqual(at(index, 0.5, 0.5), ['Kent']);
  assert.deepEqual(at(index, 1.5, 0.5), [''], 'a feature with no id is still a region, with none');
});

// =============================================================================
// Property 4 — the swapped-columns hint
// =============================================================================

test('swapped longitude and latitude are named as the likely cause', () => {
  // The classic: a US boundary file at longitude −85, latitude 35, and the user picks the
  // columns the other way round. Every case falls outside, which reads as "my file is wrong".
  const index = idxOf([feature('TN', square(-90, 30, -80, 40))]);
  const res = assignRegions(index, [35, 36, 37], [-85, -84, -83]);
  assert.equal(res.assigned, 0);
  assert.equal(res.suspectSwapped, true);
});

test('a file that genuinely does not cover every case is NOT called a swap', () => {
  // Half in, half out, and the out half landing somewhere when flipped is not evidence — a
  // hint that fires on ordinary data is worse than no hint.
  const index = idxOf(TWO);
  const res = assignRegions(index, [5, 5, 5, 5], [5, 5, 15, 15]);
  assert.equal(res.assigned, 2);
  assert.equal(res.outside, 2);
  assert.equal(res.suspectSwapped, false);
});

test('everything placed means the question is never asked', () => {
  const res = assignRegions(idxOf(TWO), [5, 15], [5, 5]);
  assert.equal(res.outside, 0);
  assert.equal(res.suspectSwapped, false);
});

// =============================================================================
// The verb's contract
// =============================================================================

test('the verb is on the workspace toolbar, beside the tools that need its column', () => {
  const verbs = manifest.workspaces[0].verbs;
  const v = verbs.find((x) => x.run === 'geocodePoints');
  assert.ok(v, 'no geocode verb declared');
  assert.equal(v.category, 'toolbar');
  assert.equal(v.label, 'Assign regions…');
  // Before "Analyse selection…", which is what a user does once they HAVE the column.
  assert.ok(verbs.indexOf(v) < verbs.findIndex((x) => x.run === 'filterToSelection'));
});

test('it is findable by the words a user would search for', () => {
  // #183: the plugin picker searches keywords and howto, so a feature absent from both is a
  // feature nobody switched the plugin on for.
  for (const term of ['geocode', 'point in polygon', 'spatial join', 'latitude']) {
    assert.ok(manifest.keywords.includes(term), `not searchable: ${term}`);
  }
  assert.match(manifest.howto, /Assign regions/);
  assert.match(manifest.howto, /no service and no API key/, 'the on-device promise is the selling point');
});

test('no R package was added for this', () => {
  // It is pure JS on purpose: a WebR package would make a geocode wait on the R runtime, and
  // the offline cache pre-fetches every enabled plugin's packages.
  assert.deepEqual(manifest.rPackages, ['sf', 'spdep', 'spatialreg', 'svglite'], 'unchanged');
});

// =============================================================================
// What the user is told
// =============================================================================

test('the report names every non-zero count, and only those', () => {
  const say = (over) => geocodeMessage({
    regions: new Array(100), assigned: 90, missing: 0, outside: 0, ambiguous: 0, suspectSwapped: false, ...over,
  });
  const clean = say({});
  assert.match(clean, /Assigned 90 of 100 cases/);
  assert.equal(/no coordinates|outside every|more than one/.test(clean), false,
    'a clean run must not list three zeroes');

  assert.match(say({ missing: 4 }), /4 had no coordinates/);
  assert.match(say({ outside: 7 }), /7 fell outside every region\./);
  assert.match(say({ ambiguous: 2 }), /2 fell inside more than one region \(the first in the file was used\)/);
});

test('the swap hint rides on the outside count, where the user is looking', () => {
  // Not a separate sentence they might not reach: the number that looks wrong is the one that
  // carries the explanation.
  const msg = geocodeMessage({
    regions: new Array(10), assigned: 0, missing: 0, outside: 10, ambiguous: 0, suspectSwapped: true,
  });
  assert.match(msg, /10 fell outside every region — they would fall inside if the longitude and latitude columns were swapped/);
});

test('the report always says the original data was not touched', () => {
  // A plugin cannot add a column to a live dataset (its data surface is read-only bar `create`),
  // and that is deliberate — the op-log is the host's. So the result is a sibling dataset, and a
  // user looking for a new column in the grid they were on needs telling where it went.
  assert.match(geocodeMessage({ regions: [], assigned: 0, missing: 0, outside: 0, ambiguous: 0 }),
    /Rows are unchanged; the region column is in a new dataset\./);
});

test('a name collision never overwrites a column', () => {
  assert.equal(uniqueName('GEOID', []), 'GEOID');
  assert.equal(uniqueName('GEOID', ['GEOID']), 'GEOID_2');
  assert.equal(uniqueName('GEOID', ['GEOID', 'GEOID_2']), 'GEOID_3');
});
