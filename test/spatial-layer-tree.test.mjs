/**
 * @file spatial-layer-tree.test.mjs
 * The region sidebar as a tree of boundary layers.
 *
 * It used to be a flat list of the ACTIVE set's regions, with the other sets in a
 * separate "Switch boundaries" link strip under the map — two controls for one idea, and
 * neither able to say how many layers there are or which regions are picked in the one
 * you are not looking at.
 *
 * The rules worth pinning are not about drawing. They are about what a layer is allowed
 * to claim when it is NOT the one on screen: the map draws one set at a time, a region's
 * swatch is the colour of its drawn path, and so only the active layer lists regions
 * while every layer still reports its counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../plugins/builtin-spatial/index.js', import.meta.url), 'utf8');
const { layerTree, layerSummary } = await import('../plugins/builtin-spatial/index.js');

const SETS = [
  { id: 's1', fields: { fileName: 'counties.geojson', featureCount: 58 } },
  { id: 's2', fields: { fileName: 'regions.geojson', featureCount: 9 } },
  { id: 's3', fields: { fileName: 'countries.geojson', featureCount: 195 } },
];
const KEYS = ['Avon', 'Bedfordshire', 'Cheshire'];

const tree = (over = {}) => layerTree({
  sets: SETS, activeId: 's1', regionKeys: KEYS, selected: new Set(['Avon']), ...over,
});

// =============================================================================
// Every layer is visible; only one is open
// =============================================================================

test('every loaded layer gets a row', () => {
  // The flat list could not show this at all: with three boundary files loaded, two of
  // them existed only as links under the map.
  assert.deepEqual(tree().map((n) => n.name),
    ['counties.geojson', 'regions.geojson', 'countries.geojson']);
});

test('only the active layer lists its regions', () => {
  // The map draws one set at a time and a region's swatch is its drawn path's colour, so
  // listing an undrawn layer's regions would show meaningless swatches and invite ticking
  // regions that are not on screen.
  const t = tree();
  assert.equal(t[0].regions.length, 3);
  assert.deepEqual(t.slice(1).map((n) => n.regions.length), [0, 0]);
  assert.deepEqual(t.map((n) => n.active), [true, false, false]);
  assert.deepEqual(t.map((n) => n.expanded), [true, false, false]);
});

test('collapsing the active layer hides its regions but keeps it active', () => {
  // Folding the list away must not cost you the map.
  const t = tree({ collapsed: new Set(['s1']) });
  assert.equal(t[0].active, true);
  assert.equal(t[0].expanded, false);
  assert.deepEqual(t[0].regions, []);
});

test('collapsing a layer that is not active changes nothing', () => {
  // An inactive layer is already closed; a stale collapse flag for one must not make the
  // active layer look shut.
  const t = tree({ collapsed: new Set(['s2', 's3']) });
  assert.equal(t[0].expanded, true);
});

// =============================================================================
// What a layer says about itself
// =============================================================================

test('an inactive layer reports its size from the registry record', () => {
  // Which is why it can be shown for a layer whose geometry has never been read in this
  // session — the count was stored when the set was loaded.
  assert.deepEqual(tree().map((n) => n.count), [3, 9, 195]);
});

test('the ACTIVE layer counts the regions actually loaded, not the stored number', () => {
  // The record says 58 and three are on screen. The live number is the true one: a
  // boundary file can contain features with no key, which are dropped on load, and the
  // sidebar must agree with the map rather than with the file.
  assert.equal(tree()[0].count, 3);
  assert.equal(SETS[0].fields.featureCount, 58, 'the stored figure is deliberately different');
});

test('a layer that is not on screen still says how many regions are picked in it', () => {
  // The whole reason selected counts are read from each set's own linkage: a selection is
  // per-layer and persisted per-layer, so switching away and back must not feel like
  // losing it.
  const t = tree({ selectedCounts: new Map([['s2', 4]]) });
  assert.equal(t[0].selectedCount, 1, 'the active layer counts its live selection');
  assert.equal(t[1].selectedCount, 4);
  assert.equal(t[2].selectedCount, 0);
});

test('the active layer ignores a stale stored count for itself', () => {
  // Its selection is in memory and is the truth; the blob is what it was last saved as.
  const t = tree({ selectedCounts: new Map([['s1', 99]]) });
  assert.equal(t[0].selectedCount, 1);
});

test('the summary line says regions, and selection only when there is some', () => {
  assert.equal(layerSummary({ count: 9, selectedCount: 0 }), '9 regions');
  assert.equal(layerSummary({ count: 1, selectedCount: 0 }), '1 region');
  assert.equal(layerSummary({ count: 58, selectedCount: 3 }), '58 regions · 3 selected');
  assert.equal(layerSummary({}), '0 regions');
  assert.equal(layerSummary(null), '0 regions');
});

// =============================================================================
// Regions
// =============================================================================

test('a region keeps the index of its drawn path', () => {
  // The swatch is read from `pathEls[idx]`, so the index must survive the sort — sorting
  // the keys and then numbering them would colour every region after the first wrongly.
  const t = layerTree({
    sets: [SETS[0]], activeId: 's1',
    regionKeys: ['Cheshire', 'Avon', 'Bedfordshire'], selected: new Set(),
  });
  assert.deepEqual(t[0].regions.map((r) => [r.key, r.idx]),
    [['Avon', 1], ['Bedfordshire', 2], ['Cheshire', 0]]);
});

test('regions sort the way administrative names need', () => {
  // Half of them end in a number, and "Ward 10" must not come before "Ward 2".
  const t = layerTree({
    sets: [SETS[0]], activeId: 's1',
    regionKeys: ['Ward 10', 'Ward 2', 'Ward 1'], selected: new Set(),
  });
  assert.deepEqual(t[0].regions.map((r) => r.key), ['Ward 1', 'Ward 2', 'Ward 10']);
});

test('a selected region is marked', () => {
  const t = tree({ selected: new Set(['Cheshire', 'Avon']) });
  assert.deepEqual(t[0].regions.map((r) => [r.key, r.checked]),
    [['Avon', true], ['Bedfordshire', false], ['Cheshire', true]]);
});

// =============================================================================
// Degenerate input
// =============================================================================

test('no layers is a tree with no nodes, not a crash', () => {
  assert.deepEqual(layerTree({}), []);
  assert.deepEqual(layerTree({ sets: null }), []);
});

test('a layer with no name falls back to its id rather than showing blank', () => {
  const t = layerTree({ sets: [{ id: 'abc123' }], activeId: null });
  assert.equal(t[0].name, 'abc123');
  assert.equal(t[0].count, 0);
});

test('an active id naming no layer leaves every layer closed', () => {
  // Reachable: a set can be removed while its id is still the active one.
  const t = tree({ activeId: 'gone' });
  assert.deepEqual(t.map((n) => n.expanded), [false, false, false]);
  assert.deepEqual(t.map((n) => n.regions.length), [0, 0, 0]);
});

// =============================================================================
// The wiring, which is DOM and CSS and so is read from the source
// =============================================================================

test('the old link strip is gone, not left beside the tree', () => {
  // Two controls for switching layers is the thing this replaced; leaving both would
  // have been the worst of the three options.
  assert.doesNotMatch(SRC, /wsRebuildSetLinks/);
  assert.doesNotMatch(SRC, /set-links/);
  assert.doesNotMatch(SRC, /Switch boundaries/);
});

test('switching layers happens in ONE place', () => {
  // The link strip had its own copy that re-read the geometry and called
  // `wsApplyBoundaries` directly, leaving out the `_ws.selected` restore — so arriving at
  // a set by clicking its link silently dropped the regions you had picked there, while
  // arriving any other way kept them.
  const bodies = [...SRC.matchAll(/_ws\.selected = new Set\(link\?\.selected \|\| \[\]\)/g)];
  assert.equal(bodies.length, 2, 'the initial load and the switch, and nothing else');
  const sw = SRC.slice(SRC.indexOf('async function wsSwitchSet'), SRC.indexOf('async function wsRefreshLayers'));
  assert.match(sw, /_ws\.selected = new Set/, 'the switch restores the layer’s selection');
  assert.match(sw, /app\.state\.read\('spatial-link', setId\)/);
});

test('a layer row is a button, so the keyboard reaches it', () => {
  const render = SRC.slice(SRC.indexOf('function wsRenderList'), SRC.indexOf('async function wsToggleLayer'));
  assert.match(render, /el\('button', \{ class: 'layer-row' \}\)/);
  assert.match(render, /aria-expanded/);
});

test('the region indent cannot be reset by the small-screen rule', () => {
  // `padding` is a shorthand: a later, more specific rule setting it wipes `padding-left`
  // without mentioning it. The indent is what says a region sits under its layer, so it
  // lives in the base rule and the small-screen rule states all four sides.
  const base = /\.region-row \{[^}]*padding: 2px 10px 2px 26px/.test(SRC);
  assert.ok(base, 'the indent belongs to the region row itself');
  const small = /\[data-screen="small"\] \.region-row \{[^}]*padding: 6px 12px 6px 30px/.test(SRC);
  assert.ok(small, 'and the small-screen rule keeps it rather than resetting it');
  assert.doesNotMatch(SRC, /\.region-row \{ padding-left/, 'no second rule to drift from the first');
});
