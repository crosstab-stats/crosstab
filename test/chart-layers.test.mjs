/**
 * @file chart-layers.test.mjs
 * Charts are drawn in three LAYERS, and nothing reserves space from anything else.
 *
 * The old model had one flat canvas with the plot's margins measured off the other
 * elements: the legend's longest label was multiplied by its font size and taken out of
 * the plot's width, and the title sat in a fixed 34-unit band on a hard-coded baseline.
 * Three things followed, none of them visible to the user.
 *
 *   - The reservation was capped (`Math.min(260, …)`), so past a point it stopped
 *     reserving and started clipping instead — and with 45-character labels it was
 *     already at the cap at the DEFAULT text size.
 *   - The title's size cap of 28 was that fixed baseline in disguise: at 28 the tops of
 *     the letters sat at y≈1.4, and one point more put them off the canvas.
 *   - `legendSizeOf` re-validated to [7, 24] behind the control, so a legend set to 40
 *     was stored as 40, displayed as 40, and rendered at 11.
 *
 * So the caps came off and the layers came apart. The deal, in the owner's words
 * (2026-10-08): *"If the user wants to set values that overlap and are ugly it's their
 * work and they can do as they please… to the extent possible, let people make
 * mistakes."* What is pinned here is that no layer silently overrules another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('./chart-kinds-harness.mjs');

const { defaultView, renderChart } = await import('../core/chart-renderer.js');

// Read up front: node:test starts a top-level test the moment it is registered, so a
// const declared further down is still in its temporal dead zone when the first one runs.
const DRAG_SRC = await readFile(new URL('../core/chart-drag.js', import.meta.url), 'utf8');
const PANE_SRC = await readFile(new URL('../core/results-pane.js', import.meta.url), 'utf8');
const CONTROLS_SRC = await readFile(new URL('../core/chart-controls.js', import.meta.url), 'utf8');
const {
  wrapToWidth, legendLabelOf, legendSizeOf, legendWidthOf, titleSizeOf, titleBlock,
  scalePlot, plotRightInset, plotVerticalInset, legendMargin, legendGap, designBox,
  canvasSizeOf, designOrigin,
  textLines, H, DEFAULT_LEGEND_W,
} = await import('../core/charts/stdlib.js');

const MODEL = {
  kind: 'categorical',
  title: 'Region by year',
  categories: [{ key: '2020', label: '2020' }, { key: '2024', label: '2024' }],
  series: [
    { key: 'a', label: 'Northern region', values: [30, 10] },
    { key: 'b', label: 'Southern region', values: [10, 30] },
  ],
};
const draw = (view = {}) => renderChart(MODEL, { ...defaultView(MODEL), ...view });
const entries = (svg) => [...svg.matchAll(/<text class="ct-legend-text"[^>]*>(.*?)<\/text>/g)]
  .map((m) => m[1].replace(/<\/?tspan[^>]*>/g, ' ').trim().replace(/\s+/g, ' '));

// --- no silent clamps --------------------------------------------------------

test('a size the control accepts is the size that renders', () => {
  // The exact failure that started this: the panel kept a number the renderer ignored.
  for (const size of [1, 7, 11, 24, 40, 500]) {
    const svg = draw({ legendSize: size });
    const used = [...svg.matchAll(/<text class="ct-legend-text"[^>]*font-size="([\d.]+)"/g)].map((m) => +m[1]);
    assert.deepEqual(used, [size, size], `legendSize ${size} rendered as ${used}`);
  }
});

test('legendSizeOf and titleSizeOf default only for values that cannot draw', () => {
  // Positive numbers pass through at any magnitude; 0, negatives and junk fall back,
  // because `font-size="0"` is invisible and `font-size="-5"` is not legal SVG.
  for (const n of [0.5, 11, 24, 9999]) {
    assert.equal(legendSizeOf({ legendSize: n }), n);
    assert.equal(titleSizeOf({ titleSize: n }), n);
  }
  for (const bad of [0, -5, NaN, null, undefined, 'big', {}]) {
    assert.equal(legendSizeOf({ legendSize: bad }), 11, `legend ${String(bad)}`);
    assert.equal(titleSizeOf({ titleSize: bad }), 15, `title ${String(bad)}`);
  }
  assert.equal(legendSizeOf(undefined), 11, 'and no view at all is the default too');
});

test('an enormous title renders, and lands over the plot rather than off the top', () => {
  // It used to grow UPWARDS off a fixed y=21 baseline, which is what the cap of 28 was
  // really protecting. Now the baseline follows the size, so the title stays on the
  // canvas and grows down into the data — visible, and the user's call.
  const svg = draw({ titleSize: 120 });
  const m = svg.match(/<text x="360" y="([\d.]+)" font-size="120"/);
  assert.ok(m, 'the title should render at the size it was given');
  const baseline = +m[1];
  assert.ok(baseline > 120 * 0.8, `baseline ${baseline} must clear the letter tops`);
  assert.ok(baseline < H, 'and stay on the canvas');
  assert.ok(!/NaN|Infinity/.test(svg), 'no arithmetic fell over on the way');
});

// --- the layers do not take room from each other -----------------------------

test('the plot inset is a constant, not a measurement of the legend', () => {
  // Same inset however long the labels are and however big the text is. The old
  // version multiplied the longest label by the font size, so the DATA decided how
  // much canvas the data got.
  const base = plotRightInset({ legend: 'right' });
  assert.equal(base, plotRightInset({ legend: 'right', legendSize: 40 }));
  assert.equal(base, plotRightInset({ legend: 'right', legendWidth: 600 }));
  assert.ok(base > DEFAULT_LEGEND_W, 'but it does clear a default-width legend');
  // Any other placement reserves nothing to the right.
  assert.equal(plotRightInset({ legend: 'inside-tr' }, { none: 18 }), 18);
  assert.equal(plotRightInset({ legend: 'none' }, { none: 18 }), 18);
});

test('the deprecated names forward, so a third-party chart kind keeps working', () => {
  // The stdlib's SOURCE ships into the plugin sandbox, so a chart plugin written
  // against legendMargin/legendGap is out there. They forward rather than being
  // reimplemented, which is why they cannot drift from the real thing.
  const view = { legend: 'right', legendSize: 30 };
  assert.equal(legendMargin(['ignored', 'labels'], view), plotRightInset(view));
  assert.equal(legendGap(view, 'top', true), plotVerticalInset(view, 'top', true));
  assert.equal(legendGap({ legend: 'top' }, 'top', false), 0, 'and nothing when there is no legend');
});

test('scalePlot moves the plot about its centre and nothing else', () => {
  const box = { x0: 100, x1: 500, y0: 400, y1: 100 };
  assert.deepEqual(scalePlot(box, {}), box, 'no plotSize is identity');
  assert.deepEqual(scalePlot(box, { plotSize: 100 }), box, 'and so is 100%');
  const half = scalePlot(box, { plotSize: 50 });
  assert.equal((half.x0 + half.x1) / 2, (box.x0 + box.x1) / 2, 'same centre, x');
  assert.equal((half.y0 + half.y1) / 2, (box.y0 + box.y1) / 2, 'same centre, y');
  assert.equal(half.x1 - half.x0, (box.x1 - box.x0) / 2);
  const big = scalePlot(box, { plotSize: 200 });
  assert.ok(big.x0 < box.x0 && big.x1 > box.x1, 'over 100% is allowed — it may overlap');
  // Nonsense leaves the layout alone rather than producing a degenerate rect.
  for (const bad of [0, -20, NaN, 'wide']) {
    assert.deepEqual(scalePlot(box, { plotSize: bad }), box, `plotSize ${String(bad)}`);
  }
});

// --- wrapping replaces truncation --------------------------------------------

test('wrapToWidth breaks on words and keeps every one of them', () => {
  assert.deepEqual(wrapToWidth('Strongly agree with it', 12), ['Strongly', 'agree with', 'it']);
  assert.deepEqual(wrapToWidth('short', 20), ['short'], 'no break when none is needed');
  assert.equal(wrapToWidth('a bb ccc dddd', 40).join(' '), 'a bb ccc dddd');
});

test('wrapToWidth splits a word with no spaces to break on', () => {
  // A chemical name, a URL, a variable name — these have to go somewhere.
  assert.deepEqual(wrapToWidth('dimethylaminoethanol', 8), ['dimethyl', 'aminoeth', 'anol']);
});

test('wrapToWidth survives the degenerate inputs', () => {
  assert.deepEqual(wrapToWidth('', 10), ['']);
  assert.deepEqual(wrapToWidth(null, 10), ['']);
  assert.deepEqual(wrapToWidth(undefined, 10), ['']);
  // A width of 0 or junk must not become an infinite loop — it clamps to one char.
  assert.deepEqual(wrapToWidth('ab', 0), ['a', 'b']);
  assert.deepEqual(wrapToWidth('ab', NaN), ['a', 'b']);
});

test('a wrapped entry is ONE text node carrying a tspan per line', () => {
  // So an entry stays one addressable thing, and a screen reader reads a phrase
  // rather than three unrelated fragments.
  const one = textLines(10, 20, ['solo'], 14, { size: 11 });
  assert.ok(!one.includes('tspan'), 'a single line needs no tspan at all');
  assert.ok(one.includes('>solo</text>'));
  const two = textLines(10, 20, ['first', 'second'], 14, { size: 11 });
  assert.equal((two.match(/<text/g) || []).length, 1, 'one text node');
  assert.equal((two.match(/<tspan/g) || []).length, 2, 'two lines');
  assert.ok(two.includes('dy="0"') && two.includes('dy="14"'), 'the second line is offset');
});

test('wrapped lines are escaped — a label is data, not markup', () => {
  const svg = textLines(0, 0, ['<script>', 'a & b'], 10, {});
  assert.ok(!svg.includes('<script>'), 'the tag must not survive');
  assert.ok(svg.includes('&lt;script&gt;') && svg.includes('a &amp; b'));
});

// --- the user's own wording --------------------------------------------------

test('a legend entry can be renamed, which is the escape hatch for long labels', () => {
  const svg = draw({ legendLabels: { a: 'North', b: 'South' } });
  assert.deepEqual(entries(svg), ['North', 'South']);
});

test('renaming one entry leaves the others on the data', () => {
  assert.deepEqual(entries(draw({ legendLabels: { a: 'North' } })), ['North', 'Southern region']);
});

test('an EMPTY override means "no override", so clearing the box reverts', () => {
  // If '' were a state of its own, clearing the box would leave a swatch with nothing
  // beside it and no way back to the label the data supplied.
  for (const blank of ['', null, undefined]) {
    assert.equal(legendLabelOf({ legendLabels: { a: blank } }, { key: 'a', label: 'Fallback' }), 'Fallback');
  }
  assert.equal(legendLabelOf({}, { key: 'a', label: 'Fallback' }), 'Fallback');
  assert.equal(legendLabelOf(undefined, { key: 'a', label: 'Fallback' }), 'Fallback');
  // An item with no label at all falls back to its key, not to "undefined".
  assert.equal(legendLabelOf({}, { key: 'onlykey' }), 'onlykey');
});

test('a renamed entry is escaped and wraps like any other', () => {
  const svg = draw({ legendLabels: { a: 'A <b>bold</b> claim & then some more words' } });
  assert.ok(!svg.includes('<b>bold</b>'), 'markup in a rename must not reach the SVG');
  assert.ok(svg.includes('&amp;'), 'and the ampersand is escaped');
});

// --- defaults are unchanged --------------------------------------------------

test('THE DEFAULT CHART IS UNCHANGED: no plate-free legend, no wrapping, no reflow', () => {
  // The layers are a change of mechanism, not of appearance. At default settings the
  // legend's labels still fit one line each and the plot still ends where it did.
  const svg = draw();
  assert.deepEqual(entries(svg), ['Northern region', 'Southern region']);
  assert.ok(!svg.includes('<tspan'), 'nothing wrapped at the default width');
  assert.equal(legendWidthOf({}), DEFAULT_LEGEND_W);
  // The title at its default size is nowhere near the data, so it gets no plate.
  assert.ok(!svg.includes('ct-title-plate'), 'a default title needs no backing panel');
});

test('the title gets a backing panel only once it reaches the plot', () => {
  // Automatic, and deliberately not a control: at the default size a plate behind a
  // title on empty white reads as leftover UI in an exported figure.
  const canvas = designBox();
  const plot = { x0: 56, x1: 554, y0: 414, y1: 34 };
  assert.ok(!titleBlock('T', { titleSize: 15 }, canvas, plot).includes('ct-title-plate'));
  assert.ok(titleBlock('T', { titleSize: 90 }, canvas, plot).includes('ct-title-plate'),
    'a title big enough to sit over the data needs something behind it');
  // No plot rect means "assume no overlap" — a kind that has not been layered yet
  // keeps a bare title rather than growing a panel out of nowhere.
  assert.ok(!titleBlock('T', { titleSize: 90 }, canvas).includes('ct-title-plate'));
  assert.equal(titleBlock('', { titleSize: 90 }, canvas, plot), '', 'and no title draws nothing');
});

test('the title is the TOP layer — it is emitted after the legend', () => {
  // Order in the markup IS z-order in SVG. If the title went on first, a large one
  // would be painted under the bars it overlaps, which looks like a clipping bug.
  const svg = draw({ titleSize: 60 });
  assert.ok(svg.indexOf('ct-legend-text') < svg.lastIndexOf('font-size="60"'),
    'the title must come after the legend');
});

/**
 * The north star as a test: making a mess is allowed, breaking is not.
 *
 * One model per layered drawing path — the three kinds that lay themselves out
 * (categorical, scatter, pie) and the two shared frames (bandFrame via violin, xyFrame
 * via steps) — pushed to the settings the caps used to forbid.
 */
const ABSURD = [
  { kind: 'categorical', title: 'T', categories: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
    series: [{ key: 's', label: 'S', values: [1, 2] }, { key: 't', label: 'T', values: [2, 1] }] },
  { kind: 'scatter', title: 'T', points: [{ x: 1, y: 2 }, { x: 2, y: 3 }] },
  { kind: 'pie', title: 'T', slices: [{ key: 'a', label: 'A', value: 1 }, { key: 'b', label: 'B', value: 2 }] },
  { kind: 'violin', title: 'T', groups: [{ key: 'a', label: 'A', values: [1, 2, 3, 4] }, { key: 'b', label: 'B', values: [2, 3, 4, 5] }] },
  { kind: 'steps', title: 'T', series: [{ key: 's', label: 'S', points: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }] },
];

const SETTINGS = [
  { titleSize: 1234567 },
  { legendSize: 900, legendWidth: 5000 },
  { valueLabels: true, valueLabelSize: 400 },
  { plotSize: 1000 },
  { plotSize: 10, legendSize: 300, titleSize: 300, legendWidth: 1 },
  { legendPlate: false, legendLabels: { s: 'x'.repeat(400) } },
];

for (const model of ABSURD) {
  test(`${model.kind}: absurd settings make a mess, not a crash`, () => {
    for (const settings of SETTINGS) {
      const view = { ...defaultView(model), ...settings };
      let svg = '';
      assert.doesNotThrow(() => { svg = renderChart(model, view); }, `${model.kind} ${JSON.stringify(settings)}`);
      assert.ok(svg.startsWith('<svg'), `${model.kind} produced no SVG for ${JSON.stringify(settings)}`);
      assert.ok(!/NaN|Infinity/.test(svg), `${model.kind} emitted NaN for ${JSON.stringify(settings)}`);
      // A negative length or radius is invalid SVG, and is the one thing a floor exists
      // to prevent — so no amount of scaling may produce one.
      const negative = [...svg.matchAll(/(?:width|height|r)="(-[\d.]+)"/g)].map((m) => m[1]);
      assert.deepEqual(negative, [], `${model.kind} emitted a negative dimension: ${negative}`);
    }
  });
}

// --- the layers are addressable, and movable ---------------------------------

const { LAYERS, layerOpen, layerOffsetOf, LAYER_CLOSE } = await import('../core/charts/stdlib.js');
const { hasMovedLayers, movedLayers, resetLayerPositions, resetLayerPosition, layerName } = await import('../core/chart-drag.js');

test('every kind emits all three layers as addressable groups', async () => {
  // This is what the drag overlay attaches to. A kind that forgets a group does not
  // break — it just silently cannot be adjusted, which is the kind of gap nobody
  // notices until they reach for the thing that is missing.
  const { KIND_NAMES } = await import('./chart-kinds-harness.mjs');
  const svg = renderChart(MODEL, { ...defaultView(MODEL), legend: 'right' });
  for (const name of LAYERS) {
    assert.ok(svg.includes(`ct-layer--${name}`), `no ${name} layer in the markup`);
  }
  assert.equal((svg.match(/<g /g) || []).length, (svg.match(/<\/g>/g) || []).length,
    'the groups must balance or the SVG is malformed');
  assert.ok(KIND_NAMES.length >= 12, 'and there are kinds to check');
});

test('the layer identity rides on CLASS, because the sanitiser strips data attributes', () => {
  // sanitize-html.js allows class/role/aria-* and drops everything else, and every
  // chart passes through it on the way into the results pane — so a `data-layer`
  // attribute would simply not arrive. Pinning this because the mistake is invisible:
  // the chart still renders, and only the dragging quietly stops working.
  const open = layerOpen('legend', { layerOffsets: { legend: { x: 5, y: -3 } } });
  assert.ok(!open.includes('data-'), 'no data attribute may be load-bearing here');
  assert.match(open, /class="ct-layer ct-layer--legend"/);
  assert.match(open, /transform="translate\(5 -3\)"/);
});

test('an unmoved layer emits no transform at all', () => {
  // So an untouched chart's markup is exactly what it was before layers could move.
  assert.equal(layerOpen('plot', {}), '<g class="ct-layer ct-layer--plot">');
  assert.equal(layerOpen('plot', { layerOffsets: { plot: { x: 0, y: 0 } } }), '<g class="ct-layer ct-layer--plot">');
  assert.equal(LAYER_CLOSE, '</g>');
});

test('a junk offset is read as unmoved rather than written into the markup', () => {
  for (const bad of [undefined, null, {}, { x: NaN, y: 'left' }, { x: Infinity, y: 2 }]) {
    const got = layerOffsetOf({ layerOffsets: { title: bad } }, 'title');
    assert.ok(Number.isFinite(got.x) && Number.isFinite(got.y), `offset ${JSON.stringify(bad)} → ${JSON.stringify(got)}`);
  }
  assert.deepEqual(layerOffsetOf({ layerOffsets: { title: { x: Infinity, y: 2 } } }, 'title'), { x: 0, y: 2 },
    'one bad axis does not discard the other');
});

test('dragging a layer moves it, and moves nothing else', () => {
  const moved = renderChart(MODEL, { ...defaultView(MODEL), legend: 'right', layerOffsets: { title: { x: -40, y: 120 } } });
  assert.match(moved, /class="ct-layer ct-layer--title" transform="translate\(-40 120\)"/);
  assert.match(moved, /class="ct-layer ct-layer--plot">/, 'the plot was not asked to move');
  assert.match(moved, /class="ct-layer ct-layer--legend">/, 'nor the legend');
});

test('NOTHING constrains where a layer may be put', () => {
  // There was a clamp that kept 24 units of every layer on the canvas. It went on the
  // owner's instruction — "remove all guards on drag location. Put a 'reset to default'
  // button in the relevant chart option control to recover if an element is dragged off
  // the canvas" (2026-10-08) — and because it was causing the thing it was meant to
  // prevent: dead zones on an iPhone that a layer refused to be dragged into.
  //
  // The clamp needed a layer's position in canvas coordinates, which it got by mixing
  // getScreenCTM()'s TRANSLATION with getBoundingClientRect(). On iOS those disagree
  // whenever the visual viewport is offset from the layout viewport — pinch-zoom, the
  // collapsing URL bar, the keyboard. The drag itself only uses the matrix's SCALE,
  // which no offset changes, so the layer tracked the finger and then refused to be put
  // down in places that looked perfectly fine.
  const src = DRAG_SRC;
  for (const gone of ['clampOffset', 'MIN_ON_CANVAS', 'baseRectOf']) {
    assert.ok(!src.includes(gone), `${gone} should be gone, not left dormant`);
  }
  assert.ok(!src.includes('getScreenCTM().e') && !src.includes('m.e'),
    'and nothing should depend on the matrix TRANSLATION, only its scale');
  // Absurd offsets render: off the canvas is a place a layer is allowed to be.
  for (const off of [{ x: -5000, y: -5000 }, { x: 9000, y: 9000 }]) {
    const svg = renderChart(MODEL, { ...defaultView(MODEL), layerOffsets: { title: off } });
    assert.ok(svg.includes(`transform="translate(${off.x} ${off.y})"`), JSON.stringify(off));
    assert.ok(!/NaN/.test(svg));
  }
});

test('RECOVERY IS PER LAYER, since one careless drag must not cost the others', () => {
  const view = { layerOffsets: { title: { x: 9000, y: 9000 }, legend: { x: -20, y: 5 } } };
  assert.deepEqual(movedLayers(view), ['legend', 'title'], 'in layer order, whatever order they moved in');
  resetLayerPosition(view, 'title');
  assert.deepEqual(view.layerOffsets, { legend: { x: -20, y: 5 } }, 'the legend keeps its placement');
  assert.deepEqual(movedLayers(view), ['legend']);
  resetLayerPositions(view);
  assert.deepEqual(movedLayers(view), []);
  // Safe on a view that has never been touched.
  assert.doesNotThrow(() => resetLayerPosition({}, 'title'));
  assert.deepEqual(movedLayers({}), []);
});

test('a layer is named the same by its outline and by the button that resets it', () => {
  // The tag on the dotted outline says "chart"; a button offering to reset "plot"
  // position would read as a different thing.
  assert.equal(layerName('plot'), 'chart');
  assert.equal(layerName('legend'), 'legend');
  assert.equal(layerName('title'), 'title');
  assert.equal(layerName('unknown'), 'unknown', 'and an unknown layer is not called undefined');
  assert.match(CONTROLS_SRC, /Reset \$\{layerName\(name\)\} position/);
});

test('reset puts everything back, and the button knows when to appear', () => {
  const view = { layerOffsets: { title: { x: 4, y: 0 } } };
  assert.equal(hasMovedLayers(view), true);
  resetLayerPositions(view);
  assert.equal(hasMovedLayers(view), false);
  assert.equal(hasMovedLayers({}), false, 'an untouched chart offers no reset');
  assert.equal(hasMovedLayers({ layerOffsets: { plot: { x: 0, y: 0 } } }), false,
    'and neither does one dragged exactly back to where it started');
});

test('a dragged chart still renders without NaN at absurd offsets', () => {
  const svg = renderChart(MODEL, { ...defaultView(MODEL), layerOffsets: { plot: { x: 1e6, y: -1e6 } } });
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(svg.startsWith('<svg'));
});

// --- the two bugs the browser found ------------------------------------------
//
// Both were reported together ("a rather large buffer at the top preventing me from
// dragging the title", owner, 2026-10-08) and turned out to be unrelated. Neither is
// reachable from Node — one is pointer-event routing, the other is CSS layout — so
// these guard the source, which is this repo's idiom for DOM code it cannot run
// (see output-edit-autosave.test.mjs).


test('a drag survives the pointer leaving the handle', () => {
  // THE BUG: move/up were bound to the handle itself and setPointerCapture was wrapped
  // in a silent try/catch. Measured in Chrome, pointermove stops arriving at the handle
  // once the pointer is outside it — so a title whose outline is 14px tall broke after
  // 14px of travel and sprang back. Binding to the document makes the drag independent
  // of whether capture took.
  const down = DRAG_SRC.slice(DRAG_SRC.indexOf("addEventListener('pointerdown'"), DRAG_SRC.indexOf('const onMove'));
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(down.includes(`doc.addEventListener('${type}'`),
      `${type} must be bound to the document for the drag to outlive the handle`);
  }
  assert.ok(DRAG_SRC.includes("doc.removeEventListener('pointermove'"), 'and unbound when the drag ends');
  assert.ok(DRAG_SRC.includes('life.abort()'), 'and torn down if the panel closes mid-drag');
});

test('the frame resizes the CANVAS, and is freeform in both axes', () => {
  // THE OTHER BUG, and its sequel. The frame was a fixed 420px tall whatever its width,
  // so a 720x460 chart in a 488px pane was letterboxed with 55px of white above and
  // below — inside the figure's border, outside the viewBox, impossible to drag into.
  // The first fix locked the frame to the drawing's ratio, which took away freeform
  // resizing ("it used to be xy freeform, now it's locked-ratio drag"). The real answer
  // was that resizing should size the CANVAS rather than the chart: "If they want
  // overlapping elements in a small canvas, with parts being clipped due to oversized
  // elements, that is their choice" (owner, 2026-10-08).
  assert.match(PANE_SRC, /#watchCanvasSize\(/, 'the frame has to feed its size to the view');
  assert.match(PANE_SRC, /item\.view\.canvasW = w/, 'as a canvas size the renderer can use');
  assert.match(PANE_SRC, /ResizeObserver/);
  const css = PANE_SRC.slice(PANE_SRC.indexOf('.results-chart .results-plot__svg {'));
  const rule = css.slice(0, css.indexOf('}'));
  assert.ok(!/height:\s*\d+px/.test(rule), `a fixed height reintroduces the band: ${rule.trim()}`);
  assert.match(rule, /resize:\s*both/, 'freeform in both axes');
  assert.match(rule, /aspect-ratio:/, 'which only supplies the first height, before the user picks one');
});

test('the canvas is separate from the chart: resizing one does not resize the other', () => {
  const small = { canvasW: 400, canvasH: 300 };
  const big = { canvasW: 1400, canvasH: 1000 };
  assert.deepEqual(canvasSizeOf({}), { w: 720, h: 460 }, 'the design size is the default');
  assert.deepEqual(canvasSizeOf(small), { w: 400, h: 300 });
  // The viewBox follows the canvas...
  const wide = renderChart(MODEL, { ...defaultView(MODEL), ...big });
  assert.match(wide, /viewBox="0 0 1400 1000"/);
  // ...while the chart inside it is laid out at exactly the same size as ever. The plot
  // area of a chart on a huge canvas is the plot area of one on a small canvas; what
  // changed is how much empty room surrounds it.
  const plotWidth = (svg) => {
    const xs = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2=""/g)].map((m) => +m[3] - +m[1]);
    return Math.round(Math.max(...xs));
  };
  const normal = renderChart(MODEL, defaultView(MODEL));
  assert.equal(plotWidth(wide), plotWidth(normal), 'a bigger canvas must not stretch the chart');
});

test('the composition is CENTRED on the canvas, not stranded in a corner', () => {
  // Growing the canvas should add room on every side of what the user already has.
  const o = designOrigin({ canvasW: 1120, canvasH: 760 });
  assert.deepEqual(o, { x: 200, y: 150 });
  assert.deepEqual(designOrigin({}), { x: 0, y: 0 }, 'and no offset at the design size');
  // Negative when the canvas is smaller: the chart overhangs and clips, as intended.
  assert.ok(designOrigin({ canvasW: 400, canvasH: 300 }).x < 0);
  const svg = renderChart(MODEL, { ...defaultView(MODEL), canvasW: 1120, canvasH: 760 });
  assert.match(svg, /<g class="ct-design" transform="translate\(200 150\)">/);
  assert.equal((svg.match(/<\/g>/g) || []).length, (svg.match(/<g[ >]/g) || []).length, 'groups balance');
});

test('a junk canvas size falls back to the design size rather than drawing nothing', () => {
  for (const bad of [{ canvasW: 0 }, { canvasW: -5 }, { canvasW: NaN }, { canvasW: 'wide' }]) {
    assert.equal(canvasSizeOf(bad).w, 720, JSON.stringify(bad));
  }
  const svg = renderChart(MODEL, { ...defaultView(MODEL), canvasW: -10, canvasH: 0 });
  assert.match(svg, /viewBox="0 0 720 460"/);
  assert.ok(!/NaN/.test(svg));
});

test('every chart holder that receives markup is fitted to it', () => {
  // The live render, the first paint from a saved project, and the FROZEN block a
  // chart falls back to when its plugin is gone. Miss one and a reopened figure comes
  // back letterboxed while a fresh one does not — the kind of difference nobody
  // attributes to the right cause.
  const fits = (PANE_SRC.match(/#fitHolderToViewBox\(holder\)/g) || []).length;
  assert.ok(fits >= 4, `expected the helper plus every call site, saw ${fits}`);
});

test('the frame observers are stopped when the pane is cleared', () => {
  // A ResizeObserver holds a strong reference to what it watches, so one per chart with
  // no teardown means a cleared pane keeps every frame it ever showed.
  assert.match(PANE_SRC, /#frameWatchers = new Set\(\)/);
  assert.match(PANE_SRC, /for \(const stop of this\.#frameWatchers\) stop\(\)/);
});

test('a saved canvas size is restored, not recomputed', () => {
  // The size is the user's choice, so it survives a reopen — and the frame has to be
  // put back to it, or the figure would redraw at the right shape inside a frame of the
  // wrong one, which is the letterbox bug again from the other direction.
  assert.match(PANE_SRC, /item\.view\.canvasW > 0 && item\.view\.canvasH > 0/);
  assert.match(PANE_SRC, /holder\.style\.aspectRatio = ''/,
    'and the first-height hint must get out of the way once there is a real size');
});
