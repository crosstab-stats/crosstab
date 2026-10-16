/**
 * @file baked-chart-kind.test.mjs
 * A figure R drew is a chart like any other, whose plot layer holds a foreign SVG.
 *
 * Nine figures are still baked in R because their geometry is the hard part and is not
 * ours — force-directed layouts, map projections, biplot arrow fields. What was wrong was
 * not that they were baked, it was that they lived on a SECOND path: `appendPlot` built
 * its own block with a click-to-edit title and caption outside the figure, while every
 * model chart carried its title inside the SVG and edited it in the ⚙ panel. Two ways to
 * do one thing, chosen by an implementation detail the reader cannot see.
 *
 * The owner's call (2026-10-16): *"the goal is to standardize as much as possible how a
 * user interacts with charts/plots/graphs. Drop the current baked mechanism and migrate
 * them to the options panel like all the others."*
 *
 * `renderChart` is pure and the kind is local to core, so all of this is testable without
 * a DOM. The parts that are not — the panel, the legacy conversion on restore, and PNG
 * export of a nested SVG — were driven in the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bakedModel } from '../core/charts/baked.js';
import { renderChart, defaultView, chartUiSpec, getChartKind } from '../core/charts/runtime.js';

/** An svglite-shaped figure: a viewBox and no width/height (cleanSvg strips those). */
const R_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 504 360'>"
  + "<circle cx='100' cy='100' r='60' fill='#c0392b'/></svg>";

const render = (model, extra = {}) => renderChart(model, { ...defaultView(model), ...extra });
const layersOf = (svg) => [...new Set([...svg.matchAll(/ct-layer--(\w+)/g)].map((m) => m[1]))];

// =============================================================================
// It is a core kind
// =============================================================================

test('the kind is registered in CORE, not by the charts plugin', () => {
  // Every other kind comes from builtin-charts. This one must not: a baked figure does
  // not depend on the chart engine and never has, so filing it with the others would
  // make a network diagram lose its title the moment the engine was switched off.
  const kd = getChartKind('baked');
  assert.ok(kd, 'the baked kind is not registered');
  assert.equal(kd.local, true, 'a remote kind would vanish with its plugin');
  assert.equal(kd.provider, undefined, 'core kinds name no provider — there is nothing to switch on');

  const manifest = readFileSync('plugins/builtin-charts/index.js', 'utf8');
  assert.doesNotMatch(manifest, /'baked'/, 'baked must not be declared by the charts plugin');
});

// =============================================================================
// Composition
// =============================================================================

test('the figure is composed into plot and title layers', () => {
  const svg = render(bakedModel({ svg: R_SVG, title: 'Network' }));
  assert.deepEqual(layersOf(svg), ['plot', 'title']);
  assert.ok(svg.includes('Network'), 'the title belongs INSIDE the figure, so it exports with it');
  assert.ok(svg.includes('#c0392b'), "R's own drawing must survive untouched");
});

test("R's svg is nested whole, not unwrapped", () => {
  // A nested <svg> establishes its own viewport, so the browser scales R's contents into
  // the rect for us and none of R's markup has to be rewritten.
  const svg = render(bakedModel({ svg: R_SVG, title: 'T' }));
  assert.equal((svg.match(/<svg\b/g) || []).length, 2, 'outer canvas + R’s own element');
  assert.ok(svg.includes("viewBox='0 0 504 360'"), "R's viewBox must be left alone");
  assert.match(svg, /<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"/);
  assert.match(svg, /preserveAspectRatio="xMidYMid meet"/);
});

test('a figure with no viewBox is shown as-is rather than cropped', () => {
  // Nesting something with no viewBox would clip it instead of fitting it, and a cropped
  // figure is a worse answer than an unscaled one.
  const bare = "<svg xmlns='http://www.w3.org/2000/svg'><circle cx='5' cy='5' r='4'/></svg>";
  const svg = render(bakedModel({ svg: bare, title: 'T' }));
  assert.ok(svg.includes("<circle cx='5'"), 'the figure must still be there');
  assert.doesNotMatch(svg, /<svg x="[\d.]+" y="[\d.]+" width=/, 'it must not be nested into a rect');
});

test('a caption renders into the figure and takes room from the plot', () => {
  const withNone = render(bakedModel({ svg: R_SVG, title: 'T' }));
  const withCap = render(bakedModel({ svg: R_SVG, title: 'T', caption: 'Source: the demo data' }));
  assert.ok(withCap.includes('Source: the demo data'));
  assert.ok(!withNone.includes('Source:'));
  // The plot rect shrinks to make room, rather than the caption overlapping the figure.
  const h = (s) => Number(s.match(/<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)"/)[1]);
  assert.ok(h(withCap) < h(withNone), 'a caption must reserve its band');
});

test('text in a title or caption is escaped, never injected', () => {
  const svg = render(bakedModel({ svg: R_SVG, title: '<script>x</script>', caption: 'a & b' }));
  assert.ok(!svg.includes('<script>'), 'a title is text, not markup');
  assert.ok(svg.includes('a &amp; b'));
});

// =============================================================================
// The options panel sees the right controls
// =============================================================================

test('the panel offers the title, caption and plot size — and no palette', () => {
  const spec = chartUiSpec(bakedModel({ svg: R_SVG, title: 'T' }));
  const ids = spec.controls.map((c) => c.id);
  for (const want of ['titleText', 'titleSize', 'captionText', 'plotSize']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  // No colour items: the host did not choose these colours and cannot change them
  // without re-running R. A palette that silently did nothing would be worse than none.
  assert.deepEqual(spec.colorItems, []);
});

test('the panel edits the title, and an emptied box means no title', () => {
  const model = bakedModel({ svg: R_SVG, title: 'Network' });
  assert.ok(render(model, { titleText: 'Renamed' }).includes('Renamed'));
  assert.ok(!render(model, { titleText: 'Renamed' }).includes('Network'));
  // '' is an explicit "no title", distinct from undefined (use the model's).
  assert.ok(!render(model, { titleText: '' }).includes('Network'));
  assert.ok(render(model, {}).includes('Network'));
});

test('the caption the plugin supplied is pre-filled so it can be cleared', () => {
  const spec = chartUiSpec(bakedModel({ svg: R_SVG, caption: 'From R' }));
  const cap = spec.controls.find((c) => c.id === 'captionText');
  assert.equal(cap.default, 'From R', 'an un-prefilled box would look like "no caption"');
});

// =============================================================================
// The old mechanism is gone
// =============================================================================

test('nothing renders a click-to-edit title any more', () => {
  // The point of the exercise: one way to edit a figure's title, not two.
  const pane = readFileSync('core/results-pane.js', 'utf8');
  assert.doesNotMatch(pane, /makeEditable/, 'the inline editor should be gone entirely');
  assert.doesNotMatch(pane, /results-plot__title/, 'and its styling with it');
  assert.doesNotMatch(pane, /#buildPlotBlock/, 'the second block builder should be gone');
});

test('a project saved before the change is converted, not kept on the old path', () => {
  // Browser-verified too (title and caption carried over, figure intact, panel present).
  // Pinned here because losing a user-typed caption on upgrade would be silent.
  const pane = readFileSync('core/results-pane.js', 'utf8');
  const branch = pane.slice(pane.indexOf("} else if (item.kind === 'plot') {"));
  assert.match(branch.slice(0, 1400), /bakedModel\(\{[\s\S]*?title:[\s\S]*?caption:/,
    'the legacy title and caption must be carried into the model');
});

// =============================================================================
// The legend layer — entries a plugin supplies, wording the reader owns
// =============================================================================

const LEGEND = [
  { key: 'rows', label: 'Rows: Region of residence (region)', color: '#2980b9' },
  { key: 'cols', label: 'Columns: Highest education level (education)', color: '#c0392b' },
];

test('a figure with no legend entries draws no legend', () => {
  // None of the nine baked figures had one, so the absence has to stay the default —
  // an empty legend box floating beside a map would be worse than no legend at all.
  const svg = render(bakedModel({ svg: R_SVG, title: 'T' }));
  assert.deepEqual(layersOf(svg), ['plot', 'title']);
  assert.equal(defaultView(bakedModel({ svg: R_SVG })).legend, 'none');
});

test('supplied entries become a legend layer in the figure', () => {
  const model = bakedModel({ svg: R_SVG, title: 'Biplot', legend: LEGEND });
  assert.equal(defaultView(model).legend, 'right');
  const svg = render(model);
  assert.deepEqual(layersOf(svg), ['plot', 'legend', 'title']);
  assert.ok(svg.includes('#2980b9') && svg.includes('#c0392b'), 'the swatches use the plugin’s colours');
});

test("a long entry wraps rather than being clipped — which is why relabelling matters", () => {
  const svg = render(bakedModel({ svg: R_SVG, legend: LEGEND }));
  // Both words survive even though they cannot share a line in a 150px column.
  assert.ok(svg.includes('Columns:') && svg.includes('education'));
});

test('the reader can reword an entry, and clearing reverts to the data’s label', () => {
  // The owner's case: *"shortening a variable label in particular will be common."*
  const model = bakedModel({ svg: R_SVG, legend: LEGEND });
  const base = defaultView(model);
  const short = render(model, { legendLabels: { cols: 'Education' } });
  assert.ok(short.includes('>Education<'));
  assert.ok(!short.includes('Highest'), 'the long label must be replaced, not appended to');
  // An empty override is "no override", not "an entry with no text" — otherwise
  // clearing the box would leave a swatch with nothing beside it and no way back.
  assert.ok(render(model, { legendLabels: { cols: '' } }).includes('Highest'));
  assert.ok(render(model, base).includes('Highest'));
});

test('the colours are NOT the reader’s to change', () => {
  // They have to keep agreeing with a picture the host cannot repaint. The panel reads
  // this flag to drop the swatch pickers while keeping the rename boxes.
  const spec = chartUiSpec(bakedModel({ svg: R_SVG, legend: LEGEND }));
  assert.equal(spec.colorEditable, false);
  assert.deepEqual(spec.colorItems.map((i) => i.key), ['rows', 'cols']);
  assert.notEqual(spec.colorLabel, 'Series', 'a baked figure has no series');
});

test('every other kind keeps its palette', () => {
  // `colorEditable` defaults true, so this change is invisible to the ten plugin kinds.
  const controls = readFileSync('core/charts/runtime.js', 'utf8');
  assert.match(controls, /colorEditable: kd\.colorEditable !== false/);
  const panel = readFileSync('core/chart-controls.js', 'utf8');
  assert.match(panel, /const swatches = spec\.colorEditable !== false;/);
});

test('the legend placement and format controls appear only with entries', () => {
  const without = chartUiSpec(bakedModel({ svg: R_SVG })).controls.map((c) => c.id);
  const withEntries = chartUiSpec(bakedModel({ svg: R_SVG, legend: LEGEND })).controls.map((c) => c.id);
  assert.ok(!without.includes('legend'), 'no entries ⇒ nothing to place');
  assert.ok(withEntries.includes('legend') && withEntries.includes('legendSize'));
});

test('the biplot states its colours once, for R and for the key', () => {
  // The figure and the key beside it must agree, so neither gets its own copy of the
  // colour. `plot(cc)` used to take ca's defaults and the reader had to know that ca
  // draws rows first — the key is what replaces that knowledge.
  const src = readFileSync('plugins/builtin-ordination/index.js', 'utf8');
  assert.match(src, /const ROW_COLOR = '#[0-9a-f]{6}';/);
  assert.match(src, /plot\(cc, col = c\("\$\{ROW_COLOR\}", "\$\{COL_COLOR\}"\)\)/);
  assert.match(src, /color: ROW_COLOR/);
  assert.match(src, /color: COL_COLOR/);
});
