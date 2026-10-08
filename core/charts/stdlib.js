/**
 * @file charts/stdlib.js
 * The chart-drawing STANDARD LIBRARY — the code a chart kind needs to draw itself.
 *
 * Palettes, control-descriptor builders, SVG primitives, scales, ticks, legends and the
 * two axis frames. No registry, no view state, no dispatch: this module knows how to
 * draw, not what is registered.
 *
 * ## Why it is a separate file
 *
 * Chart kinds live in the `builtin-charts` PLUGIN, which runs in a sandboxed
 * opaque-origin iframe and therefore cannot import anything from core — as
 * plugin-host.html puts it, such a document "cannot fetch other same-origin files".
 * So this module's SOURCE is read by the host and handed to the sandbox over
 * postMessage, where it is blob-imported and passed to the plugin's chart factory. The
 * exact road the plugin's own source already travels.
 *
 * That indirection buys the thing that matters: **there is one copy of this code.**
 * The alternative — bundling a copy into every chart plugin — means a fix to
 * `niceTicks` has to be chased through every chart plugin that ever shipped, and the
 * ones nobody updates drift into drawing subtly wrong axes. Duplication here is not a
 * size problem, it is a correctness problem with a long tail.
 *
 * Consequently this module must stay **dependency-free and side-effect-free**: it is
 * imported into a bare realm with nothing else in it.
 */

/**
 * Named colour palettes. Default is **Okabe-Ito**, the de-facto colourblind-safe
 * qualitative palette — the fix for the "colours are hard to see / hard to tell
 * apart" complaint. Series i takes `palette[i % palette.length]`.
 * @type {Object<string,{label:string,colors:string[]}>}
 */
export const PALETTES = {
  'okabe-ito': {
    label: 'Okabe-Ito (colourblind-safe)',
    colors: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', '#000000'],
  },
  vivid: {
    label: 'Vivid',
    colors: ['#2980b9', '#e74c3c', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#2c3e50'],
  },
  grayscale: {
    label: 'Grayscale',
    colors: ['#111111', '#555555', '#888888', '#aaaaaa', '#cccccc', '#333333', '#777777', '#bbbbbb'],
  },
};

export const DEFAULT_PALETTE = 'okabe-ito';

/** Resolve the colour for item `key` at draw-index `i`: explicit override wins,
 * else the active palette cycled by position. */
export function colorFor(view, key, i) {
  if (view.colors && view.colors[key]) return view.colors[key];
  const pal = (PALETTES[view.palette] || PALETTES[DEFAULT_PALETTE]).colors;
  return pal[i % pal.length];
}

// --- shared control-descriptor builders (any kind can reuse) -----------------
//
// Each returns plain data, or `null` when the control does not apply to this model.
// chartUiSpec filters the nulls, so a kind can list them unconditionally.

/**
 * ## When a size control gets a `max`
 *
 * It does not, unless exceeding it would break something rather than look bad.
 * `setControlValue` clamps to the declared range, so a `max` is not a hint — it
 * silently rewrites what the user typed, and the panel then shows the rewritten
 * number as though they had asked for it. Reported from the other end: *"I type 25
 * and it auto resets to 18"* (owner, 2026-10-07).
 *
 * Every text size on a chart is handed straight to {@link text}, so there is nothing
 * downstream to protect: a 1234567px title renders in under a millisecond, emits no
 * NaN, and is simply clipped by the viewBox. That is the user's own work looking
 * wrong in a way they can see and undo, which is not ours to prevent.
 *
 * So a cap survives here only when passing it changes **the canvas's dimensions, a
 * loop count, or a proportion that is bounded by its own definition** — `rowHeight`
 * and `panelHeight` multiply into the SVG's height, `maxWords` and `yTickCount` are
 * iteration counts, `violinWidth` is a fraction of a band. Those are resource and
 * arithmetic limits, not taste.
 *
 * A `min` stays on every size, because below it the output is invalid rather than
 * ugly: a negative emits `font-size="-5"`, which is not a legal SVG attribute, and
 * the renderers resolve sizes with `?? default` / `|| default`, so a stored 0 would
 * come back as the default with no indication it had been ignored. `min: 1` keeps
 * both states unreachable.
 */

/**
 * Palette chooser.
 * @param {boolean} multi - more than one item takes a colour. Passed in rather than
 *   looked up: the builders used to call `colorItemCount(model)`, which reached back
 *   into the registry, and a kind living in a plugin has no registry to reach into.
 *   The kind already knows its own colour items, so it is the right one to answer.
 */
export function paletteControl(multi = true) {
  return multi ? {
    id: 'palette', label: 'Palette', type: 'select', structural: true, group: 'Style',
    default: DEFAULT_PALETTE,
    options: Object.entries(PALETTES).map(([k, p]) => [k, p.label]),
  } : null;
}

/** Legend placement — only when more than one item is shown. */
export function legendControl(multi = true, fallback = 'right') {
  return multi ? {
    id: 'legend', label: 'Placement', type: 'select', group: 'Legend', structural: true,
    default: fallback,
    // Every placement floats now \u2014 the legend is its own layer and no longer takes
    // room out of the plot (see plotRightInset). The first three sit where the plot's
    // default insets leave a gap, so they look the same as they always did; the
    // `inside-*` four aim at a corner of the plot on purpose. The difference between
    // the two groups is now only WHERE, not whether anything is reserved.
    options: [
      ['right', 'Right of the chart'],
      ['top', 'Above the chart'],
      ['bottom', 'Below the chart'],
      ['inside-tl', 'Inside \u2014 top left'],
      ['inside-tr', 'Inside \u2014 top right'],
      ['inside-bl', 'Inside \u2014 bottom left'],
      ['inside-br', 'Inside \u2014 bottom right'],
      ['none', 'Hidden'],
    ],
  } : null;
}

/**
 * Size, weight and slant for the legend's text.
 *
 * Every other run of text on a chart \u2014 title, axis titles, value labels \u2014 could
 * be set and the legend could not, so enlarging a chart for a slide left one bit
 * of 11px text behind looking like an oversight. Shown only when there is a
 * legend to format.
 *
 * @param {boolean} multi - false when the kind has nothing to put in a legend
 */
export function legendFormatControls(multi = true) {
  if (!multi) return [];
  const dep = { control: 'legend', notEquals: 'none' };
  return [
    { id: 'legendSize', label: 'Text size', type: 'number', min: 1, step: 0.5, group: 'Legend', default: 11, visibleWhen: dep },
    // The legend's own width, and the measure its text wraps to. Steps of 10 so the
    // spinner is the +/- the owner asked for, while typing still works for a big jump.
    // No ceiling: past the plot's inset it simply overlaps, which is the point.
    { id: 'legendWidth', label: 'Legend width', type: 'number', min: 30, step: 10, group: 'Legend', default: DEFAULT_LEGEND_W, visibleWhen: dep },
    { id: 'legendPlate', label: 'Backing panel', type: 'check', group: 'Legend', default: true, visibleWhen: dep },
    { id: 'legendBold', label: 'Bold', type: 'check', group: 'Legend', default: false, visibleWhen: dep },
    { id: 'legendItalic', label: 'Italic', type: 'check', group: 'Legend', default: false, visibleWhen: dep },
  ];
}

/**
 * How much of the canvas the plot layer takes.
 *
 * Every kind shows it, because every kind now has layers that can overlap and this is
 * the lever that resolves it: nothing reserves space from the plot any more, so when
 * the title or legend needs more room, the user takes it from here rather than from a
 * cap we chose for them.
 */
export function plotSizeControl() {
  return {
    id: 'plotSize', label: 'Plot size (%)', type: 'number', group: 'Chart',
    min: 10, step: 5, default: 100,
  };
}

/**
 * ## Insets, not reservations
 *
 * Charts are drawn in three LAYERS — plot at the bottom, legend over it, title over
 * both — and the two functions below are the plot layer's own margins. They are
 * deliberately constants: what they are *not* any more is a measurement of the
 * legend's text.
 *
 * The old `legendMargin` measured the longest label, multiplied by the font size, and
 * took that out of the plot's width. Three things came of it. The plot got narrower
 * every time a label got longer, which is the data deciding the composition. The sum
 * had a `Math.min(260, …)` ceiling, so past a point it stopped reserving and started
 * clipping instead — and at the DEFAULT text size, with 45-character labels, it was
 * already at that ceiling. And the whole thing was a cap the user could neither see
 * nor reach: the only control over it was the legend's text size, which they had
 * independent reasons to set.
 *
 * So the plot keeps an inset that leaves room for a *default-sized* legend and
 * nothing more. Grow the legend past it and the layers overlap, which is a thing the
 * user can see and decide about — "to the extent possible, let people make mistakes"
 * (owner, 2026-10-08). Want the room back? Shrink the plot (`plotSize`).
 */

/** The plot layer's right-hand inset: room for a default-width legend, or `none`. */
export function plotRightInset(view, { none = 20 } = {}) {
  if (!view || view.legend !== 'right') return none;
  return DEFAULT_LEGEND_W + LEGEND_GUTTER + 6;
}

/** The plot layer's extra top/bottom inset when a legend is placed there. */
export function plotVerticalInset(view, place, multi = true) {
  if (!multi || !view || view.legend !== place) return 0;
  // Sized for the DEFAULT legend text, not the current size — see the note above.
  return place === 'top' ? 20 : 26;
}

/**
 * @deprecated Use {@link plotRightInset}. Kept because the stdlib's source is shipped
 * into the plugin sandbox and a chart plugin that was written against the old name
 * must keep rendering; it forwards, so there is one implementation and the two cannot
 * drift. The `labels` argument is ignored — that is the point of the change.
 */
export function legendMargin(labels, view, opts) {
  return plotRightInset(view, opts);
}

/** @deprecated Use {@link plotVerticalInset}. Forwards, for the reason above. */
export function legendGap(view, place, multi = true) {
  return plotVerticalInset(view, place, multi);
}

/**
 * The DESIGN box — the `W` x `designH` rectangle a kind composes itself in, in the same
 * shape as its plot `box`. Charts whose height grows with the data (see
 * {@link svgOpenH}) pass their own height.
 *
 * Not the canvas. Layout and anchoring happen here — the title centres on it, the
 * legend hangs off its right edge — and {@link svgOpenH} then places the whole
 * composition on the canvas. Keeping the two apart is what lets the user resize the
 * canvas to any shape without the chart inside it changing size.
 */
export function designBox(h = H) {
  return { x0: 0, x1: W, y0: h, y1: 0 };
}

/**
 * ## The layers are addressable
 *
 * Each layer is emitted as a `<g class="ct-layer ct-layer--plot|legend|title">`, which
 * is what lets the host put a dotted outline round it and let the user drag it
 * (core/chart-drag.js). The class carries the identity rather than a `data-layer`
 * attribute for a specific reason: every chart SVG goes through
 * {@link module:core/sanitize-html} on its way into the results pane, and that
 * allowlist passes `class`, `role` and `aria-*` and strips everything else — a
 * `data-` attribute would simply not arrive.
 *
 * Being a real group also means the host does not have to do any geometry: once the
 * markup is in the document, `getBoundingClientRect()` gives a layer's on-screen box
 * and `getScreenCTM()` gives the scale, both already accounting for the letterboxing
 * that `preserveAspectRatio` applies inside the user's resizable frame.
 *
 * The position itself is one `translate` on the group, so a dragged plot takes its
 * axes, gridlines and marks with it and no renderer has to thread an offset through
 * its coordinates.
 */
export const LAYERS = ['plot', 'legend', 'title'];

/** One layer's user-set offset, in viewBox units. Absent or junk means unmoved. */
export function layerOffsetOf(view, name) {
  const o = view && view.layerOffsets && view.layerOffsets[name];
  const x = Number(o && o.x);
  const y = Number(o && o.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/** Open a layer group. The transform is omitted when there is no offset, so an
 * untouched chart's markup is exactly what it was before layers were addressable. */
export function layerOpen(name, view) {
  const { x, y } = layerOffsetOf(view, name);
  const t = x || y ? ` transform="translate(${r(x)} ${r(y)})"` : '';
  return `<g class="ct-layer ct-layer--${name}"${t}>`;
}

/** Close a layer group. A constant, so the open/close pair cannot drift. */
export const LAYER_CLOSE = '</g>';

/** The chart title's text size. */
export function titleSizeOf(view) {
  const n = Number(view && view.titleSize);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** The plot layer's default top inset — room for a default-sized title. A constant,
 * for the same reason the legend's inset is one. */
export const TITLE_BAND = 34;

/**
 * The title layer: drawn LAST, so it is over both the legend and the plot.
 *
 * The baseline was a hard-coded `y=21` inside a 34-unit band, which is why the title
 * had a ceiling of 28 that looked arbitrary and was not: at 28 the tops of the letters
 * sit at about y=1.4, and one point more took them off the canvas. So the cap was
 * really the fixed baseline wearing a disguise. Deriving the baseline from the size
 * fixes the cause, and the title then grows downwards — over the plot, if it is big
 * enough, which is allowed.
 *
 * The plate is AUTOMATIC, and deliberately not a control. These figures are exported
 * into papers and slides, where a translucent panel behind a title sitting on white
 * reads as leftover UI chrome rather than as part of the chart — so at the default
 * size, where the title is nowhere near the data, there is no plate at all. It appears
 * only once the title has actually grown down into the plot layer, which is the one
 * case where it is legibility rather than decoration.
 *
 * Not a control for a concrete reason: "Titles & axes" is already a 16-row section and
 * chart-groups.test.mjs holds that as a cap ("if a section grows past this, it wants
 * splitting"). A toggle for this belongs in the same pass that splits the section.
 *
 * @param {object} [plot] - the plot layer's rect, to detect the overlap. Omitted means
 *   "assume no overlap", so a kind that has not been layered yet keeps a bare title.
 */
export function titleBlock(title, view = {}, canvas = designBox(), plot = null) {
  if (!title) return '';
  const size = titleSizeOf(view);
  const x = (canvas.x0 + canvas.x1) / 2;
  // Derived from the size, where it used to be the constant y=21 — which is exactly why
  // the title had a ceiling of 28: at 28 the tops of the letters sat at y≈1.4, and one
  // point more put them off the canvas. 0.82em keeps the cap height inside the top edge
  // at any size.
  //
  // The 8.7 is chosen so that `8.7 + 15 * 0.82` is 21.0 — the baseline the shared frames
  // and four of the five hand-laid-out kinds already used. So a chart at the DEFAULT
  // title size renders byte-identically to before, and only a title the user has
  // actually resized moves. (The hand-rolled kinds had drifted to 20, 21 and 22; they
  // agree now, which is a 1-unit shift on three of them.)
  const y = 8.7 + size * 0.82;
  const out = [];
  if (plot && y + size * 0.25 > plot.y1) {
    const w = Math.min(canvas.x1 - canvas.x0, String(title).length * size * 0.56 + 16);
    out.push(`<rect class="ct-title-plate" x="${r(x - w / 2)}" y="${r(y - size * 0.95)}" width="${r(w)}" height="${r(size * 1.3)}" rx="4" `
      + `fill="#fff" fill-opacity="0.92" stroke="${GRID}" stroke-width="1"/>`);
  }
  out.push(text(x, y, esc(title), {
    size, weight: view.titleBold !== false ? 600 : 400,
    italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
  }));
  return layerOpen('title', view) + out.join('') + LAYER_CLOSE;
}

/**
 * Resize the plot layer about its own centre. `plotSize` is a percentage; 100 is the
 * layout the insets describe.
 *
 * This is the control that makes overlapping layers a choice rather than a trap: the
 * legend and title no longer take width out of the plot, so when the user wants room
 * for a big one, THIS is how they get it. Scaling the rect rather than applying an SVG
 * `transform` is deliberate — a transform would shrink the axis tick labels along with
 * everything else, so "make the plot a bit smaller" would quietly cost legibility.
 * Handing the kind a smaller rect keeps every run of text at the size it was set to.
 */
export function scalePlot(box, view) {
  const pct = Number(view && view.plotSize);
  if (!Number.isFinite(pct) || pct === 100 || pct <= 0) return box;
  const f = pct / 100;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return {
    x0: cx + (box.x0 - cx) * f,
    x1: cx + (box.x1 - cx) * f,
    y0: cy + (box.y0 - cy) * f,
    y1: cy + (box.y1 - cy) * f,
  };
}

/**
 * The legend's text size, in one place so every layer agrees on it.
 *
 * This used to re-validate to `[7, 24]` and return the default outside that range —
 * which was not a clamp but a LIE: the control happily accepted 40 and stored it,
 * the panel displayed 40, and the SVG came out with `font-size="11"`. A second
 * validator behind a control is always that, because the two can only ever agree by
 * coincidence. Now the control owns the range and this owns the default.
 */
export function legendSizeOf(view) {
  const n = Number(view && view.legendSize);
  return Number.isFinite(n) && n > 0 ? n : 11;
}

/**
 * The legend box's width — the measure the entry text WRAPS to.
 *
 * The legend is its own layer, so this is not a reservation taken out of the plot:
 * growing it does not shrink the chart, it just makes the legend bigger (and, past
 * the plot's own inset, overlapping — see {@link legendBlock}). Wrapping to it is
 * what replaced a hard 26-character ellipsis that truncated at the DEFAULT text
 * size, so a long value label lost its tail no matter how much room was going spare.
 */
export function legendWidthOf(view) {
  const n = Number(view && view.legendWidth);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEGEND_W;
}

/** The legend layer's default width, and the plot's default right-hand inset when a
 * legend sits there. One constant, so the default chart has them flush. */
export const DEFAULT_LEGEND_W = 150;

/** Value-labels toggle. */
export function valueLabelsControl(label = 'Value labels') {
  return { id: 'valueLabels', label, type: 'check', group: 'Labels', default: false };
}

/** Gridlines toggle. */
export function gridlinesControl() {
  return { id: 'gridlines', label: 'Gridlines', type: 'check', group: 'Style', default: true };
}

/** Whether any series carries raw observations (gates the point/error-bar controls). */
export function hasRawValues(model) {
  return (model.series || []).some((s) => s.rawValues && s.rawValues.some((a) => a && a.length));
}

/** Point overlay toggle (only when raw values are available). */
export function pointOverlayControl(model) {
  return hasRawValues(model)
    ? { id: 'pointOverlay', label: 'Show data points', type: 'check', group: 'Style', default: false }
    : null;
}

/** Error bars selector (only when raw values are available). */
export function errorBarsControl(model) {
  return hasRawValues(model) ? {
    id: 'errorBars', label: 'Error bars', type: 'select', group: 'Style', default: 'none',
    options: [['none', 'None'], ['sem', 'SEM'], ['sd', 'SD'], ['ci95', '95% CI']],
  } : null;
}

// --- title / axis / value-label controls -------------------------------------

/**
 * Chart title text + formatting controls.
 *
 * The size/weight/slant controls are always shown, so the title, x-axis and y-axis
 * offer an identical set (a chart whose x-axis exposed formatting while its y-axis
 * did not was the reported inconsistency). Formatting an as-yet-empty title is simply
 * a no-op, and it takes effect on any default title the renderer draws (e.g. "Count").
 * The text box's placeholder shows the effective default, and its value overrides it —
 * an *explicitly emptied* box (see the `??` resolution in the renderers) means "no
 * title", distinct from an untouched box, which keeps the default.
 */
export function titleControls(model) {
  return [
    {
      // The box is PRE-FILLED with the effective default title (`default`), so it shows
      // as real, editable text — backspacing it to empty stores '' ("no title"), which
      // the renderers honour via `?? default`. (An empty box with the default shown only
      // as a placeholder can't be cleared: there's nothing to backspace, so no change
      // fires.) The placeholder is what an emptied box shows.
      id: 'titleText', label: 'Title', type: 'text', group: 'Titles & axes',
      placeholder: '(no title)', default: model.title || '',
    },
    { id: 'titleSize', label: 'Title size', type: 'number', min: 1, step: 1, group: 'Titles & axes', default: 15 },
    { id: 'titleBold', label: 'Title bold', type: 'check', group: 'Titles & axes', default: true },
    { id: 'titleItalic', label: 'Title italic', type: 'check', group: 'Titles & axes', default: false },
  ];
}

/**
 * Axis title + formatting + min/max controls for one axis.
 *
 * @param {'x'|'y'} axis
 * @param {object} model
 * @param {{defaultTitle?: string, defaultFrom?: {control: string, map: Object<string,string>, fallback?: string}}} [opts]
 *   - `defaultTitle` is the title the renderer draws by default when this axis has none
 *   in the model (e.g. the counts chart's "Count" on y); it pre-fills the box so the
 *   user can edit or clear it (see {@link titleControls}). `defaultFrom` is for a
 *   default that TRACKS another control — e.g. the counts y-title is "Count" or
 *   "Percent…" depending on the `valueMeasure` control — so the pre-filled box follows
 *   that control instead of showing a stale static default (resolved in controlValue).
 */
export function axisControls(axis, model, { defaultTitle, defaultFrom } = {}) {
  const upper = axis.toUpperCase();
  const modelTitle = model.axes?.[axis]?.title || '';
  const p = `${axis}Axis`;
  return [
    {
      // Pre-filled with the effective default so it's editable/clearable (see titleControls).
      id: `${p}Title`, label: `${upper} axis title`, type: 'text', group: 'Titles & axes',
      placeholder: '(no title)', default: modelTitle || defaultTitle || '',
      ...(defaultFrom ? { defaultFrom } : {}),
    },
    { id: `${p}TitleSize`, label: `${upper} title size`, type: 'number', min: 1, step: 1, group: 'Titles & axes', default: 12 },
    { id: `${p}TitleBold`, label: `${upper} title bold`, type: 'check', group: 'Titles & axes', default: false },
    { id: `${p}TitleItalic`, label: `${upper} title italic`, type: 'check', group: 'Titles & axes', default: false },
    // No default: blank means "auto", and a number here is an explicit override.
    { id: `${p}Min`, label: `${upper} axis min`, type: 'number', placeholder: 'auto', group: 'Titles & axes' },
    { id: `${p}Max`, label: `${upper} axis max`, type: 'number', placeholder: 'auto', group: 'Titles & axes' },
  ];
}

/** Value label formatting controls (size, bold, italic). */
/**
 * Whether a distribution chart draws its individual observations.
 *
 * Paired with {@link pointSizeControl}, which several kinds show only when this
 * is on — naming the CONTROL rather than the view key is what lets one builder
 * serve kinds that default it on and kinds that default it off.
 *
 * @param {{default?: boolean}} [opts]
 */
export function showPointsControl({ default: dflt = true } = {}) {
  return { id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart', default: dflt };
}

/**
 * Point size, wherever a chart draws points.
 *
 * Four kinds hand-wrote this and they had already drifted apart in a way a
 * group-and-label check does not see: the scatter's was a three-option SELECT
 * (Small/Medium/Large) while the violin, boxplot and SCED charts used a number
 * spinner. Same control, same name, two different widgets.
 *
 * `default` stays the caller's, deliberately. A control's default is what every
 * chart that never touched it is currently drawn with, so unifying defaults here
 * would silently restyle saved charts — the numbers differ because a dense
 * scatter and a five-point SCED panel want different dots, which is a judgement
 * each kind is entitled to.
 *
 * @param {{default?: number, visibleWhen?: object}} [opts]
 */
export function pointSizeControl({ default: dflt = 3, visibleWhen } = {}) {
  return {
    id: 'pointSize', label: 'Point size', type: 'number', group: 'Style',
    min: 0.5, step: 0.5, default: dflt, ...(visibleWhen ? { visibleWhen } : {}),
  };
}

/**
 * What mark the chart draws. The OPTIONS are the kind's own — bars or lines for
 * a categorical chart, points and/or lines for a single-case design — but the
 * id, name and section are everyone's.
 *
 * @param {[string,string][]} options
 * @param {string} dflt
 */
/**
 * Row height, for the kinds that draw one row per item (forest, tornado). Shared because two
 * kinds declaring the same control independently is how "Row height" ends up in two sections
 * under two names — the thing chart-options-consistency exists to prevent.
 *
 * @param {{default?: number}} [opts]
 */
export function rowHeightControl({ default: dflt = 22 } = {}) {
  return {
    id: 'rowHeight', label: 'Row height', type: 'number', group: 'Style',
    // One of the few caps that survives the size-control note above: this one
    // multiplies into the SVG's own height (`height = mTop + rows * rowHeight + mBottom`),
    // so it is a canvas dimension rather than a matter of taste — a forest plot of 300
    // studies at an unbounded row height asks the browser for a document tens of
    // thousands of units tall. 48 was still taste, though, so it is 200 now.
    min: 2, max: 200, step: 2, default: dflt,
  };
}

export function markControl(options, dflt) {
  return { id: 'mark', label: 'Type', type: 'select', structural: true, group: 'Chart', default: dflt, options };
}

/**
 * The summary a distribution chart overlays on its points (median + quartiles,
 * mean + SD, none). Options are the kind's; the wording is not.
 *
 * @param {[string,string][]} options
 * @param {string} dflt
 */
export function summaryControl(options, dflt) {
  return { id: 'summary', label: 'Summary', type: 'select', group: 'Chart', default: dflt, options };
}

/**
 * Counts or percentages — the same question wherever a chart reports a number.
 *
 * One control, one name, one section, on every kind that can answer it. That is
 * not cosmetic tidying: to a reader the question is identical on a bar chart, a
 * histogram and a pie ("do I want counts or percentages?"), and it was living
 * under Chart on three kinds and under Labels on the pie because of what it
 * happens to DO rather than what it asks.
 *
 * What it does varies, and only on one kind does it redraw anything. On a
 * single-series bar or line chart, and on a histogram with equal intervals, the
 * marks are pixel-identical either way and only the axis and the printed numbers
 * change. On a pie it can only ever change the label text, a slice's size being
 * its share by definition. The drawing genuinely changes in exactly two places:
 * a grouped Trends chart, where the share is within each category, and a
 * histogram with unequal cut points shown as Density.
 *
 * Filing it by that side effect would put one control in two sections and, worse,
 * move it between them with the shape of the data — a Trends chart would keep it
 * in a different place depending on whether a group variable was chosen. So it
 * is filed by the QUESTION, under Chart, and the side effect is left to be a side
 * effect. `Chart` rather than `Labels` because on four of the five it changes the
 * axis, which no Labels control should.
 *
 * The OPTIONS stay the kind's own — a pie can offer "both", a histogram can offer
 * density — and this owns the id, the name and the section, which is the part
 * that was drifting.
 *
 * @param {[string,string][]} options
 * @param {string} [dflt]
 */
export function valueMeasureControl(options, dflt = 'count') {
  return {
    id: 'valueMeasure', label: 'Show values as', type: 'select', structural: true,
    group: 'Chart', default: dflt, options,
  };
}

export function valueLabelFormatControls() {
  const dep = { control: 'valueLabels', truthy: true };
  return [
    // No ceiling — see the size-control note above. This was the cap that got noticed
    // (18, the lowest of any text control, with no reason on record), but raising it to
    // match its siblings would only have moved the surprise further out.
    { id: 'valueLabelSize', label: 'Label size', type: 'number', min: 1, step: 0.5, group: 'Labels', default: 9.5, visibleWhen: dep },
    { id: 'valueLabelBold', label: 'Labels bold', type: 'check', group: 'Labels', default: false, visibleWhen: dep },
    { id: 'valueLabelItalic', label: 'Labels italic', type: 'check', group: 'Labels', default: false, visibleWhen: dep },
  ];
}


// --- shared drawing helpers --------------------------------------------------

export const W = 720;
export const H = 460;
export const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
export const AXIS = '#555';
// Gridlines must be VISIBLE or the toggle that controls them reads as broken. The
// previous #e6eaee measured 1.21:1 against white — about a fifth of WCAG 1.4.11's 3:1
// for graphical objects — so switching gridlines off changed the SVG (verifiably: 11
// stroke references to 0) while changing nothing a reader could see. Reported as
// "gridlines doesn't appear to do anything, in any chart", and that was a fair reading.
// 3:1 itself would make a reference line compete with the data, so this sits at 1.56:1:
// unmistakably present, still clearly behind the series.
export const GRID = '#c8d0d9';

export function errorSvg(msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 80" font-family="${FONT}" role="img">`
    + `<title>${esc(msg)}</title>`
    + `<text x="12" y="44" font-size="13" fill="#b00">${esc(msg)}</text></svg>`;
}

export function text(x, y, content, { size = 12, anchor = 'start', fill = '#000', weight, italic, cls } = {}) {
  return `<text${cls ? ` class="${cls}"` : ''} x="${r(x)}" y="${r(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}${italic ? ' font-style="italic"' : ''}>${content}</text>`;
}

/**
 * One run of text that may need more than one line.
 *
 * A wrapped entry is ONE `<text>` carrying a `<tspan>` per line, which is how SVG
 * says it: the lines stay a single addressable node, a screen reader reads them as
 * one phrase rather than as three unrelated fragments, and anything walking the
 * markup still sees one entry per entry.
 *
 * A single line emits a plain `<text>`, byte-identical to what {@link text} produced
 * before wrapping existed — so the default rendering of every chart is unchanged.
 *
 * @param {string[]} lines - already wrapped (see {@link wrapToWidth}); NOT escaped here
 * @param {number} lineH - baseline-to-baseline pitch
 */
export function textLines(x, y, lines, lineH, opts = {}) {
  const ls = (lines || []).map((l) => esc(l));
  if (ls.length <= 1) return text(x, y, ls[0] ?? '', opts);
  const spans = ls.map((l, i) => `<tspan x="${r(x)}" dy="${i === 0 ? 0 : r(lineH)}">${l}</tspan>`).join('');
  return text(x, y, spans, opts);
}

export function r(n) { return Math.round(n * 100) / 100; }

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Format an axis/value number compactly (no trailing zeros, thousands grouped). */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(1);
  const rounded = Math.round(v * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Descriptive stats from raw values (for error bars). */
export function computeStats(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, n, sd: 0, sem: 0 };
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const sem = sd / Math.sqrt(n);
  return { mean, n, sd, sem };
}

/** Error bar bounds for a given type. Returns {lo, hi} or null. */
export function errorBounds(stats, type) {
  if (!stats) return null;
  const { mean, sd, sem } = stats;
  if (type === 'sem') return { lo: mean - sem, hi: mean + sem };
  if (type === 'sd') return { lo: mean - sd, hi: mean + sd };
  if (type === 'ci95') return { lo: mean - 1.96 * sem, hi: mean + 1.96 * sem };
  return null;
}

/** Deterministic horizontal offsets for n points within a given width. */
export function jitterOffsets(n, width) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const span = width * (n <= 5 ? 0.5 : 0.7);
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => -span / 2 + step * i);
}

/** Draw minor tick marks between major ticks on a numeric axis.
 *  `axis` = 'y' (horizontal ticks on left edge) or 'x' (vertical ticks on bottom edge). */
export function minorTicks(out, ticks, scale, axis, anchor) {
  for (let i = 0; i < ticks.length - 1; i++) {
    const step = (ticks[i + 1] - ticks[i]) / 5;
    for (let j = 1; j < 5; j++) {
      const pos = scale(ticks[i] + step * j);
      if (axis === 'y') {
        out.push(`<line x1="${r(anchor - 3)}" y1="${r(pos)}" x2="${r(anchor)}" y2="${r(pos)}" stroke="${AXIS}" stroke-width="0.7"/>`);
      } else {
        out.push(`<line x1="${r(pos)}" y1="${r(anchor)}" x2="${r(pos)}" y2="${r(anchor + 3)}" stroke="${AXIS}" stroke-width="0.7"/>`);
      }
    }
  }
}

/** "Nice" axis ticks spanning [min,max] — rounded step (1/2/2.5/5 × 10^k). */
export function niceTicks(min, max, count) {
  if (min === max) max = min + 1;
  const span = niceNum(max - min, false);
  const step = niceNum(span / Math.max(1, count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const out = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = (range || 1) / Math.pow(10, exp);
  let nf;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

/** A legend (right column, or a centred top/bottom row). `items` = [{label,color}].
 * `box` = {x0,x1,y0,y1} plot rect. */
export function legendBlock(items, place, box, view = {}, canvas = designBox(), { swatch } = {}) {
  if (!items.length || place === 'none') return '';
  const size = legendSizeOf(view);
  const opts = { size, fill: '#333', weight: view.legendBold ? 600 : undefined, italic: !!view.legendItalic, cls: 'ct-legend-text' };
  // Everything scales off the text, so a 20px legend does not draw 12px swatches
  // on 19px rows.
  const sw = Math.round(size * 1.1); // swatch
  const lineH = Math.round(size * 1.45); // pitch WITHIN one wrapped entry
  const rowGap = Math.round(size * 0.3); // extra pitch BETWEEN entries
  const chW = size * 0.62;
  const out = [];

  const width = legendWidthOf(view);
  // Characters that fit one line: the box, less the swatch column and both pads.
  const perLine = Math.max(4, Math.floor((width - sw - 5 - 8) / chW));
  const entries = items.map((it) => ({ ...it, lines: wrapToWidth(legendLabelOf(view, it), perLine) }));

  const inside = place.indexOf('inside-') === 0;
  if (place === 'right' || inside) {
    const boxH = entries.reduce((a, e) => a + e.lines.length * lineH + rowGap, 0) + 8;
    let lx;
    let ly;
    if (inside) {
      const pad = 8;
      lx = place.charAt(place.length - 1) === 'l' ? box.x0 + pad + 4 : box.x1 - width - pad + 4;
      ly = place.indexOf('inside-t') === 0 ? box.y1 + pad : box.y0 - boxH - pad + 3;
    } else {
      // Anchored to the CANVAS, not to `box.x1 + 14`. That is the whole difference
      // between a layer and a reservation: the legend sits where the legend sits,
      // and the plot's own right-hand inset (plotRightInset) is a separate default
      // that happens to clear it. Widen one and they overlap; that is allowed.
      lx = canvas.x1 - width - LEGEND_GUTTER;
      // Vertically it still lines up with the top of the plot — a layout
      // relationship, not a budget, so it tracks the plot if that is resized.
      ly = box.y1 + 4;
    }
    out.push(legendPlate(lx, ly, width, boxH, view, inside));
    for (const e of entries) {
      out.push(swatchAt(swatch, lx, ly, sw, e));
      out.push(textLines(lx + sw + 5, ly + sw - 1, e.lines, lineH, opts));
      ly += e.lines.length * lineH + rowGap;
    }
  } else {
    const gap = 16;
    const widths = entries.map((e) => sw + 4 + Math.max(...e.lines.map((l) => l.length)) * chW + gap);
    const totalW = widths.reduce((a, b) => a + b, 0) - gap;
    const tallest = Math.max(...entries.map((e) => e.lines.length));
    let lx = (box.x0 + box.x1) / 2 - totalW / 2;
    const ly = place === 'top' ? box.y1 - tallest * lineH + 3 : box.y0 + lineH + 22;
    out.push(legendPlate(lx - 4, ly - sw + 1, totalW + 8, tallest * lineH + 8, view, false));
    entries.forEach((e, i) => {
      out.push(swatchAt(swatch, lx, ly - sw + 1, sw, e));
      out.push(textLines(lx + sw + 4, ly + 1, e.lines, lineH, opts));
      lx += widths[i];
    });
  }
  return layerOpen('legend', view) + out.join('') + LAYER_CLOSE;
}

/**
 * One legend entry's key: a colour chip by default, or whatever the kind draws.
 *
 * The `swatch` hook exists because the SCED chart had a whole second legend —
 * `markerLegend` — cloned to draw a marker glyph instead of a square. It had drifted
 * into ignoring every legend control there is: size, bold, italic, the width and the
 * label overrides were all hard-coded in the copy, so on a multi-measure chart those
 * controls were on screen and did nothing. One legend, one set of behaviour, and the
 * glyph is the only thing a kind gets to vary.
 */
function swatchAt(swatch, x, y, size, item) {
  if (typeof swatch === 'function') return swatch(x, y, size, item);
  return `<rect x="${r(x)}" y="${r(y)}" width="${size}" height="${size}" rx="2" fill="${item.color}"/>`;
}

/** Gap between the legend layer and the canvas edge. */
export const LEGEND_GUTTER = 10;

/**
 * The legend's backing plate.
 *
 * This used to be drawn only for the `inside-*` placements, with the reason on
 * record: *"without it a legend on a dark bar is unreadable, which would make the
 * option a trap."* Floating is now the DEFAULT rather than an opt-in, so that trap
 * would be the default too — hence the plate everywhere, and at 0.92 rather than the
 * 0.82 that was tuned for a placement the user had deliberately chosen. 0.82 over a
 * saturated bar leaves #333 text at roughly 3.5:1; 0.92 keeps it past WCAG 1.4.3's
 * 4.5:1 whatever happens to be behind it.
 *
 * Off via `legendPlate: false`, for a legend that sits on white anyway and where the
 * outline is one more line in an exported figure.
 */
function legendPlate(x, y, w, h, view, _inside) {
  if (view.legendPlate === false) return '';
  // Classed so that a reader of the markup — an export filter, a test counting the
  // chart's own marks — can tell the chrome from the data.
  return `<rect class="ct-legend-plate" x="${r(x - 4)}" y="${r(y - 3)}" width="${r(w)}" height="${r(h)}" rx="4" `
    + `fill="#fff" fill-opacity="0.92" stroke="${GRID}" stroke-width="1"/>`;
}

/**
 * The text for one legend entry: the user's override if they typed one, else the
 * model's own label.
 *
 * The escape hatch for the thing no sizing control can fix — a 60-character legend
 * entry is not a choice the user made, it is the value label the DATA handed them.
 * Wrapping stops it being clipped; this lets them say "Strongly agree" instead.
 */
export function legendLabelOf(view, item) {
  const over = view && view.legendLabels && view.legendLabels[item.key];
  // An EMPTY override means "no override", not "an entry with no text". The box in the
  // controls panel is empty-with-a-placeholder, so clearing it is how the user reverts
  // to the data's own label — if '' were a state of its own, reverting would instead
  // leave a swatch with nothing beside it, and there would be no way back at all.
  // (The title boxes read '' as explicit emptiness, because for a title that IS a
  // thing someone wants.)
  return over ? String(over) : (item.label ?? item.key ?? '');
}

/**
 * Break `s` into lines of at most `perLine` characters, on word boundaries.
 *
 * Replaces `clip(label, 26)`, a hard ellipsis that fired at the DEFAULT text size —
 * a 45-character value label lost its tail with 200px of canvas going spare, and no
 * amount of resizing brought it back. A wrapped legend grows downwards, which costs
 * nothing: it is a floating layer with no neighbour to push.
 *
 * A single word longer than the line is split rather than left to overflow, because
 * a chemical name or a URL has no spaces to break on.
 *
 * NOT the same function as `wrapLabel` inside builtin-charts, which wraps the SCED
 * chart's rotated case captions: that one takes a `maxLines` and ellipsises what will
 * not fit, because a caption has to stay inside a panel's height. This one has no
 * ceiling, because a legend is a floating layer with nothing below it to push. The
 * two are one function with an optional bound and should be consolidated — filed in
 * TODO.md rather than done here, because that rewrite lands on the SCED captions and
 * this change had already touched every kind.
 */
export function wrapToWidth(s, perLine) {
  const str = String(s ?? '');
  const n = Math.max(1, Math.floor(perLine) || 1);
  if (!str) return [''];
  const lines = [];
  let line = '';
  for (const word of str.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= n) line += ` ${word}`;
    else { lines.push(line); line = word; }
    while (line.length > n) { lines.push(line.slice(0, n)); line = line.slice(n); }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Map an ordered list of keys back to model items, skipping any missing, then
 * appending any the order didn't name (defensive). */
export function ordered(items, order) {
  const by = new Map((items || []).map((it) => [it.key, it]));
  const out = [];
  for (const k of order || []) if (by.has(k)) out.push(by.get(k));
  for (const it of items || []) if (!order || !order.includes(it.key)) out.push(it);
  return out;
}

export function svgOpen(label, view) {
  return svgOpenH(H, label, view);
}

/**
 * ## The canvas is not the chart
 *
 * `W` x `H` is the chart's DESIGN size — the space its own layout is composed in, and
 * the thing every renderer below still measures against. The CANVAS is separate: it is
 * how much room the figure is given, and the user sets it by dragging the frame.
 *
 * Resizing the canvas therefore does not resize anything in the chart. A bigger canvas
 * is the same chart with more space around it, which is the room the layers get dragged
 * out into; a smaller one clips. In the owner's words (2026-10-08): *"resizing the
 * bounding box… should resize only the canvas on which the layered elements can be
 * positioned/sized… If they want overlapping elements in a small canvas, with parts
 * being clipped due to oversized elements, that is their choice."*
 *
 * This is also why the frame can be dragged to any shape again. Before, the viewBox was
 * fixed at 720x460 and `preserveAspectRatio` centred it in whatever box it was given —
 * so a freeform resize changed nothing but the width of the blank margin, and that
 * margin was the unreachable "buffer" at the top of the figure. Now the viewBox IS the
 * frame, so there is no margin to be stranded in.
 */

/** The canvas the figure is drawn on: the user's size if they set one, else the
 * design size. `designH` is the kind's own height (see {@link svgOpenH}). */
export function canvasSizeOf(view, designH = H) {
  const w = Number(view && view.canvasW);
  const h = Number(view && view.canvasH);
  return {
    w: Number.isFinite(w) && w > 0 ? w : W,
    h: Number.isFinite(h) && h > 0 ? h : designH,
  };
}

/**
 * Where the design box sits on the canvas: centred.
 *
 * Centred rather than pinned to a corner because enlarging the canvas should add room
 * on every side of the composition the user already has, not strand it in the top left.
 * Negative when the canvas is smaller than the design — the chart then overhangs and
 * clips, which is the stated intent.
 */
export function designOrigin(view, designH = H) {
  const c = canvasSizeOf(view, designH);
  return { x: (c.w - W) / 2, y: (c.h - designH) / 2 };
}

/** Close what {@link svgOpenH} opened: the design group, then the SVG. */
export function svgClose() {
  return '</g></svg>';
}

/**
 * Open an SVG of a caller-chosen height — for kinds whose height depends on the data
 * (a SCED chart grows a panel per case) rather than the shared {@link H}.
 *
 * `label` becomes `role="img"` plus a `<title>`. Without it a screen reader skips inline
 * SVG entirely, so every chart in the app — often the primary output of an analysis —
 * was simply silent. `<title>` is the element to use rather than `aria-label` because it
 * survives {@link module:core/sanitize-html} on the way into the results pane and is
 * what SVG's own accessibility mapping expects.
 */
export function svgOpenH(h, label, view) {
  const role = label ? ' role="img"' : '';
  const title = label ? `<title>${esc(label)}</title>` : '';
  const c = canvasSizeOf(view, h);
  const o = designOrigin(view, h);
  // Everything the kind draws goes inside ONE design group, offset to centre the
  // composition on the canvas. Doing it here rather than in each renderer means no kind
  // has to know the canvas exists: they lay out in design coordinates exactly as before,
  // and the group puts the result in the right place. Paired with {@link svgClose}.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(c.w)} ${r(c.h)}" font-family="${FONT}"${role}>`
    + title
    + `<rect x="0" y="0" width="${r(c.w)}" height="${r(c.h)}" fill="#ffffff"/>`
    + `<g class="ct-design" transform="translate(${r(o.x)} ${r(o.y)})">`;
}

/**
 * The sentence a screen reader hears in place of the chart. The chart's own title is
 * the headline; the rest says what KIND of thing it is and how much of it there is,
 * because "Age vs Income" alone does not tell a non-sighted reader whether they are
 * missing 3 points or 300.
 *
 * The noun is PASSED IN, not looked up. It was once a literal
 * `{scatter: 'Scatter plot', …}` map in this function — so every new kind had to
 * remember to edit a switch three hundred lines away, and a kind that forgot was
 * silently announced as "Chart". Then it was read from the registry, which this module
 * can no longer see: the stdlib ships into a plugin sandbox that has no registry in it.
 * Both routes were the same mistake in different clothes. A kind knows its own noun.
 */
export function chartAltText(model, view, extra, noun) {
  const title = (view.titleText ?? model.title) || '';
  const kind = noun || 'Chart';
  // Don't say "Word cloud: Word cloud." when the title already names the chart type.
  const named = title && !title.toLowerCase().startsWith(kind.toLowerCase())
    ? `${kind}: ${title}.`
    : `${title || kind}.`;
  return [named, extra].filter(Boolean).join(' ');
}


/**
 * The scaffolding every "categories along x, numbers up y" chart needs: margins,
 * a nice y domain, gridlines, axes, titles. Extracted because violin, dots and
 * paired are the same picture with a different mark in each band — writing it three
 * times would have been three chances to drift.
 *
 * Returns the open SVG buffer plus the geometry a kind needs to draw into it.
 */
export function bandFrame(model, view, { allValues, bands, legendItems = [], alt = plural(bands, 'group') + '.' , noun }) {
  const title = view.titleText ?? model.title;
  const xTitle = view.xAxisTitle ?? model.axes?.x?.title;
  const yTitle = view.yAxisTitle ?? model.axes?.y?.title;

  const yMinUser = Number.isFinite(view.yAxisMin);
  const yMaxUser = Number.isFinite(view.yAxisMax);
  const lo = yMinUser ? view.yAxisMin : Math.min(...allValues);
  const hi = yMaxUser ? view.yAxisMax : Math.max(...allValues);
  const yticks = niceTicks(lo, hi, view.yTickCount || 6);
  const yLo = yMinUser ? view.yAxisMin : yticks[0];
  const yHi = yMaxUser ? view.yAxisMax : yticks[yticks.length - 1];

  const showLegend = view.legend !== 'none' && legendItems.length > 1;
  const mRight = plotRightInset(showLegend ? view : {});
  const mTop = (title ? TITLE_BAND : 16) + plotVerticalInset(view, 'top', showLegend);
  const mBottom = 46 + (xTitle ? 16 : 0) + plotVerticalInset(view, 'bottom', showLegend);
  const mLeft = 56 + (yTitle ? 16 : 0);
  const canvas = designBox();
  const box = scalePlot({ x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop }, view);
  const yScale = (v) => box.y0 - ((v - yLo) / (yHi - yLo || 1)) * (box.y0 - box.y1);
  const band = (box.x1 - box.x0) / Math.max(1, bands);
  const centre = (i) => box.x0 + band * (i + 0.5);

  // The plot layer opens here and closes in close(). The title is NOT pushed here — it
  // is the top layer and goes on last, so a title large enough to reach the data sits
  // over it rather than under it. The background rect stays outside the group,
  // deliberately: it is the canvas, not part of anything that can be dragged.
  const out = [svgOpen(chartAltText(model, view, alt, noun), view), layerOpen('plot', view)];
  for (const t of yticks) {
    if (t < yLo - 1e-9 || t > yHi + 1e-9) continue;
    const y = yScale(t);
    if (view.gridlines !== false) {
      out.push(`<line x1="${r(box.x0)}" y1="${r(y)}" x2="${r(box.x1)}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
    }
    out.push(`<line x1="${r(box.x0 - 5)}" y1="${r(y)}" x2="${r(box.x0)}" y2="${r(y)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(text(box.x0 - 8, y + 4, fmtNum(t), { size: 11, anchor: 'end', fill: AXIS }));
  }
  // Open L-shaped axes: the frame stops at the data, it does not box the plot in.
  out.push(`<line x1="${r(box.x0)}" y1="${r(box.y1)}" x2="${r(box.x0)}" y2="${r(box.y0)}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${r(box.x0)}" y1="${r(box.y0)}" x2="${r(box.x1)}" y2="${r(box.y0)}" stroke="${AXIS}" stroke-width="1"/>`);

  const close = (labels) => {
    labels.forEach((lab, i) => {
      out.push(text(centre(i), box.y0 + 18, esc(clip(lab, Math.max(6, Math.floor(band / 7)))),
        { size: 11, anchor: 'middle', fill: '#333' }));
    });
    if (xTitle) {
      out.push(text((box.x0 + box.x1) / 2, H - 6, esc(xTitle),
        { size: view.xAxisTitleSize || 12, anchor: 'middle', fill: '#333' }));
    }
    if (yTitle) {
      const my = (box.y0 + box.y1) / 2;
      out.push(`<text x="14" y="${r(my)}" font-size="${view.yAxisTitleSize || 12}" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})">${esc(yTitle)}</text>`);
    }
    // Layer order, bottom to top: plot, legend, title. The plot group closes first —
    // everything after it is a layer that sits OVER it.
    out.push(LAYER_CLOSE);
    if (showLegend) out.push(legendBlock(legendItems, view.legend, box, view, canvas));
    out.push(titleBlock(title, view, canvas, box));
    out.push(svgClose());
    return out.join('');
  };

  return { out, box, yScale, band, centre, close, yLo, yHi };
}

/**
 * "1 group" / "2 groups" — alt text is read aloud, so the plural has to be right.
 * Irregular nouns pass their own plural ("study" → "studies", not "studys").
 */
export function plural(n, word, plural2) {
  return `${n} ${n === 1 ? word : (plural2 || `${word}s`)}`;
}

/** Summary statistics a distribution mark draws: median, quartiles, whiskers, mean. */
export function fiveNumber(values) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { min: v[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: v[v.length - 1], mean, n: v.length };
}

/**
 * Gaussian kernel density on a grid, with Silverman's rule-of-thumb bandwidth.
 *
 * Clipped to the observed range rather than extended by a few bandwidths: a violin
 * that bulges past the largest value it was given is drawing data that does not
 * exist, which for a plot whose whole job is to show the shape of a small sample is
 * the wrong kind of lie.
 */
export function kde(values, steps = 48) {
  const n = values.length;
  const { q1, q3, min, max } = fiveNumber(values);
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const spread = Math.min(sd || Infinity, (q3 - q1) / 1.34 || Infinity);
  const h = (Number.isFinite(spread) && spread > 0 ? spread : Math.max(1e-9, (max - min) || 1) / 4)
    * 0.9 * Math.pow(n, -0.2);
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const x = min + ((max - min) * i) / (steps - 1 || 1);
    let d = 0;
    for (const xi of values) {
      const u = (x - xi) / h;
      d += Math.exp(-0.5 * u * u);
    }
    pts.push({ x, d: d / (n * h * Math.sqrt(2 * Math.PI)) });
  }
  const peak = Math.max(...pts.map((p) => p.d)) || 1;
  return pts.map((p) => ({ v: p.x, w: p.d / peak })); // w in 0..1
}

/** Deterministic jitter in [-1, 1], stable across renders (no Math.random). */
export function jitterFor(i, n) {
  if (n <= 1) return 0;
  // Golden-ratio low-discrepancy sequence: even spread, no clumping, no RNG.
  return ((i * 0.6180339887) % 1) * 2 - 1;
}



/**
 * {@link bandFrame}'s sibling for charts whose x axis is a NUMBER LINE rather than a
 * row of categories: same margins, gridlines, titles and legend, but x is scaled and
 * tick-marked instead of divided into bands.
 *
 * `bandFrame` could not be stretched to cover this. A band chart's x geometry is
 * "n slots, give me the middle of slot i"; a step chart's is "given t = 37.4, where
 * is that". Those are different questions, and faking one with the other is how you
 * get survival curves whose spacing lies about elapsed time — every gap drawn equal
 * regardless of how long it actually was.
 */
export function xyFrame(model, view, { xValues, yValues, legendItems = [], alt, xTickCount = 7, yTickCount = 6 , noun }) {
  const title = view.titleText ?? model.title;
  const xTitle = view.xAxisTitle ?? model.axes?.x?.title;
  const yTitle = view.yAxisTitle ?? model.axes?.y?.title;

  const span = (vals, minKey, maxKey, count) => {
    const userMin = Number.isFinite(view[minKey]);
    const userMax = Number.isFinite(view[maxKey]);
    const lo = userMin ? view[minKey] : Math.min(...vals);
    const hi = userMax ? view[maxKey] : Math.max(...vals);
    const ticks = niceTicks(lo, hi, count);
    return {
      lo: userMin ? view[minKey] : ticks[0],
      hi: userMax ? view[maxKey] : ticks[ticks.length - 1],
      ticks,
    };
  };
  const xs = span(xValues, 'xAxisMin', 'xAxisMax', xTickCount);
  const ys = span(yValues, 'yAxisMin', 'yAxisMax', yTickCount);

  const showLegend = view.legend !== 'none' && legendItems.length > 1;
  const mRight = plotRightInset(showLegend ? view : {});
  const mTop = (title ? TITLE_BAND : 16) + plotVerticalInset(view, 'top', showLegend);
  const mBottom = 44 + (xTitle ? 16 : 0) + plotVerticalInset(view, 'bottom', showLegend);
  const mLeft = 56 + (yTitle ? 16 : 0);
  const canvas = designBox();
  const box = scalePlot({ x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop }, view);

  const xScale = (v) => box.x0 + ((v - xs.lo) / (xs.hi - xs.lo || 1)) * (box.x1 - box.x0);
  const yScale = (v) => box.y0 - ((v - ys.lo) / (ys.hi - ys.lo || 1)) * (box.y0 - box.y1);

  // The title is the top layer; it goes on last, in close(). The plot layer opens here.
  const out = [svgOpen(chartAltText(model, view, alt, noun), view), layerOpen('plot', view)];
  for (const t of ys.ticks) {
    if (t < ys.lo - 1e-9 || t > ys.hi + 1e-9) continue;
    const y = yScale(t);
    if (view.gridlines !== false) {
      out.push(`<line x1="${r(box.x0)}" y1="${r(y)}" x2="${r(box.x1)}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
    }
    out.push(`<line x1="${r(box.x0 - 5)}" y1="${r(y)}" x2="${r(box.x0)}" y2="${r(y)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(text(box.x0 - 8, y + 4, fmtNum(t), { size: 11, anchor: 'end', fill: AXIS }));
  }
  // Open L-shaped axes, matching bandFrame and the Prism convention (#140).
  out.push(`<line x1="${r(box.x0)}" y1="${r(box.y1)}" x2="${r(box.x0)}" y2="${r(box.y0)}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${r(box.x0)}" y1="${r(box.y0)}" x2="${r(box.x1)}" y2="${r(box.y0)}" stroke="${AXIS}" stroke-width="1"/>`);

  const close = () => {
    for (const t of xs.ticks) {
      if (t < xs.lo - 1e-9 || t > xs.hi + 1e-9) continue;
      const x = xScale(t);
      out.push(`<line x1="${r(x)}" y1="${r(box.y0)}" x2="${r(x)}" y2="${r(box.y0 + 5)}" stroke="${AXIS}" stroke-width="1"/>`);
      out.push(text(x, box.y0 + 18, fmtNum(t), { size: 11, anchor: 'middle', fill: AXIS }));
    }
    if (xTitle) {
      out.push(text((box.x0 + box.x1) / 2, H - 6, esc(xTitle), {
        size: view.xAxisTitleSize || 12, anchor: 'middle', fill: '#333',
        weight: view.xAxisTitleBold ? 600 : undefined, italic: !!view.xAxisTitleItalic,
      }));
    }
    if (yTitle) {
      const my = (box.y0 + box.y1) / 2;
      out.push(`<text x="14" y="${r(my)}" font-size="${view.yAxisTitleSize || 12}" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})">${esc(yTitle)}</text>`);
    }
    // Layer order, bottom to top: plot, legend, title. The plot group closes first —
    // everything after it is a layer that sits OVER it.
    out.push(LAYER_CLOSE);
    if (showLegend) out.push(legendBlock(legendItems, view.legend, box, view, canvas));
    out.push(titleBlock(title, view, canvas, box));
    out.push(svgClose());
    return out.join('');
  };

  return { out, box, xScale, yScale, close, xLo: xs.lo, xHi: xs.hi, yLo: ys.lo, yHi: ys.hi };
}
