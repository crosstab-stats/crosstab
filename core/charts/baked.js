/**
 * @file charts/baked.js
 * The `baked` chart kind — a figure R drew, composed into the host's layer model.
 *
 * ## Why this exists
 *
 * Nine figures are still produced as finished SVG by R, because their geometry is the
 * hard part and is not ours: force-directed network layouts, map projections, biplot
 * arrow fields, ordination configurations. Those are not going to become chart models,
 * and that is the right outcome.
 *
 * What was wrong was that they lived on a *second path*. `results.appendPlot` built its
 * own block with a click-to-edit title and caption above and below the figure, while
 * every model chart carried its title inside the SVG and edited it in the ⚙ panel. Two
 * ways to do the same thing, decided by an implementation detail the reader has no way
 * to see. The owner's call (2026-10-16): *"the goal is to standardize as much as
 * possible how a user interacts with charts/plots/graphs. Drop the current baked
 * mechanism and migrate them to the options panel like all the others."*
 *
 * So a baked figure is now a chart like any other, whose **plot layer happens to hold a
 * foreign SVG**. Everything else — the options panel, layer dragging, `plotSize`,
 * persistence, SVG/PNG export, restore — is the same code path as a scatter plot, not a
 * parallel one.
 *
 * ## Registered in CORE, deliberately
 *
 * Every other kind comes from the builtin-charts plugin. This one does not, because a
 * baked figure does not depend on the chart engine and never has: switch builtin-charts
 * off and a network diagram still renders. Filing `baked` with the others would have
 * made that figure lose its title the moment the chart engine was disabled — a
 * regression for exactly the minimal and air-gapped installs least able to debug it.
 *
 * ## What composition buys, and what it does not
 *
 * The title and caption become part of the figure, so they export with the SVG and the
 * PNG — which the old DOM-rendered title never did. The plot can be resized and the
 * layers dragged. What still needs R is anything that changes the PANEL: a different k,
 * another distance metric, a new projection. That boundary is the point rather than a
 * shortfall (see TODO, chart Layer 3b).
 */

import { registerChartKind } from './runtime.js';
import {
  scaleBlock,
  designBox, layerOpen, LAYER_CLOSE, titleBlock, scalePlot, titleControls,
  plotSizeControl, TITLE_BAND, W, H, FONT,
  legendBlock, legendControl, legendFormatControls, plotRightInset, plotVerticalInset,
} from './stdlib.js';

/** Round to a tidy number of SVG units. */
const r = (n) => Math.round(n * 10) / 10;

/** XML-escape text going into the SVG. */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Room kept under the plot for a caption, when there is one. */
const CAPTION_BAND = 26;

/**
 * The figure's legend entries, as the host will draw them.
 *
 * A plugin supplies `legend: [{key, label, color, marker?}]` alongside the SVG. None of
 * the nine baked figures drew a legend in R — this is not a relocation of one, it is a
 * key those figures never had: `ca`'s biplot, for one, plots row and column categories
 * in different colours and says nowhere which is which.
 *
 * The colours come from the plugin because the plugin told R what to draw with. That is
 * why `colorEditable` is false: the host can reword an entry but must not repaint a
 * swatch, or the key would stop describing the picture next to it.
 */
function legendItems(model) {
  return (model.legend || [])
    .filter((e) => e && (e.label || e.key))
    .map((e, i) => ({
      key: String(e.key ?? e.label ?? i),
      label: String(e.label ?? e.key ?? ''),
      color: e.color || '#888888',
      // The SHAPE, where a figure uses one. `marker` was in this function's documented
      // shape and then dropped on the next line, so every entry drew a square — which is
      // fine for a biplot's two colours and wrong for a decision tree, where square,
      // circle and triangle are the convention and the colour is secondary. A key that
      // shows three squares beside a picture of three different shapes is not a key.
      marker: MARKERS[e.marker] ? e.marker : 'square',
    }));
}

/**
 * How a legend entry's glyph is drawn, by name.
 *
 * Deliberately a small closed set rather than arbitrary SVG from a plugin: these are
 * drawn into the host's own figure, and a path a plugin supplied would be unescapable
 * markup in a document the host signs its name to.
 */
const MARKERS = {
  square: (x, y, size, item) =>
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${item.color}"/>`,
  circle: (x, y, size, item) =>
    `<circle cx="${x + size / 2}" cy="${y + size / 2}" r="${size / 2}" fill="${item.color}"/>`,
  triangle: (x, y, size, item) =>
    `<path d="M${x} ${y} L${x} ${y + size} L${x + size} ${y + size / 2} Z" fill="${item.color}"/>`,
  line: (x, y, size, item) =>
    `<rect x="${x}" y="${y + size / 2 - 1}" width="${size}" height="2.5" fill="${item.color}"/>`,
};

/** Draw one entry's glyph. Shared by every baked figure, so a kind cannot drift. */
function bakedSwatch(x, y, size, item) {
  return (MARKERS[item.marker] || MARKERS.square)(x, y, size, item);
}

/**
 * Place R's `<svg>` inside the plot layer's rect.
 *
 * The element is kept whole rather than unwrapped: svglite emits a `viewBox`, and
 * `cleanSvg`/`stripSize` have already removed the fixed `width`/`height` that would
 * otherwise pin it to the size R imagined. Adding `x`/`y`/`width`/`height` to that same
 * element makes the browser scale its contents into the rect for us — a nested `<svg>`
 * establishes its own viewport, so no coordinate arithmetic happens here and none of
 * R's own markup is touched.
 *
 * Returns null when there is no `viewBox` to scale against, because then the nesting
 * would crop rather than fit, and showing the figure unscaled is the better failure.
 */
function placed(svg, box) {
  const s = String(svg || '');
  const open = s.match(/<svg\b[^>]*>/i);
  if (!open || !/viewBox\s*=/i.test(open[0])) return null;
  const attrs = ` x="${r(box.x0)}" y="${r(box.y1)}" width="${r(box.x1 - box.x0)}" height="${r(box.y0 - box.y1)}"`
    + (/preserveAspectRatio\s*=/i.test(open[0]) ? '' : ' preserveAspectRatio="xMidYMid meet"');
  return s.replace(/<svg\b/i, `<svg${attrs}`);
}

/** The plot layer's rect: the canvas, less the title band, any caption band, and the
 * inset that leaves room for a default-sized legend. */
function plotRect(model, view) {
  const canvas = designBox();
  const hasCaption = !!(view.captionText ?? model.caption);
  const multi = legendItems(model).length > 1;
  return scalePlot({
    x0: canvas.x0,
    x1: canvas.x1 - plotRightInset(view, { none: 0 }),
    y0: canvas.y0 - (hasCaption ? CAPTION_BAND : 0) - plotVerticalInset(view, 'bottom', multi),
    y1: canvas.y1 + TITLE_BAND + plotVerticalInset(view, 'top', multi),
  }, view);
}

registerChartKind('baked', {
  altNoun: 'Figure',
  // Not 'Series': these entries are whatever the figure distinguishes — rows and
  // columns of a biplot, groups on an ordination — and 'Series' would name a thing a
  // baked figure does not have.
  colorLabel: 'Entries',
  reorderCategories: false,
  // The legend entries, when the plugin supplied any. They appear in the panel as a
  // relabel-and-reorder list — the wording is the host's to change, the colours are not.
  // A scale's colours are not per-item and are never editable; a legend's are listed but
  // also locked on a baked figure (the host cannot repaint R's picture).
  colorItems: (model) => (model.scale ? [] : legendItems(model)),
  colorEditable: false,

  // A scale defaults to the BOTTOM, where `sf` drew it and where a horizontal bar fits a
  // map's aspect; a category legend defaults to the right, as it always has.
  baseView: (model) => ({
    legend: model.scale ? 'bottom' : (legendItems(model).length ? 'right' : 'none'),
  }),

  controls: (model) => [
    ...titleControls(model),
    ...(legendItems(model).length
      ? [legendControl(true), ...legendFormatControls(true)]
      : []),
    plotSizeControl(),
    {
      id: 'captionText',
      label: 'Caption',
      type: 'text',
      group: 'Chart title',
      // Pre-filled with whatever the figure already carries so it is editable AND
      // clearable — an emptied box stores '' (an explicit "no caption"), which is
      // distinct from never having touched it.
      default: model.caption || '',
      placeholder: 'Add a caption…',
    },
    // LAST, after the furniture: see `paramControls`. These re-invoke the plugin and cost
    // seconds of R; everything above them is instant and in-process, and a reader scanning
    // the panel for the title box should not pass an expensive control on the way.
    ...paramControls(model),
  ],

  render(model, view = {}) {
    const box = plotRect(model, view);
    const svg = placed(model.svg, box);
    const title = view.titleText ?? model.title;
    const caption = view.captionText ?? model.caption;
    const body = [];

    body.push(layerOpen('plot', view));
    // No viewBox to scale against: drop the figure in at its natural size rather than
    // nesting it into a rect that would crop it.
    body.push(svg ?? String(model.svg || ''));
    body.push(LAYER_CLOSE);

    // One or the other: a continuous scale OR a row-per-category legend (#204). Both
     // occupy the `legend` layer, so drawing both would stack two different claims about
     // the same colours in the same corner.
    if (model.scale) {
      body.push(scaleBlock(model.scale, view.legend, box, view, designBox()));
    } else {
      const items = legendItems(model);
      if (items.length) {
        body.push(legendBlock(items, view.legend, box, view, designBox(), { swatch: bakedSwatch }));
      }
    }

    if (caption) {
      body.push(`<text x="${r((box.x0 + box.x1) / 2)}" y="${r(H - 8)}" text-anchor="middle" `
        + `font-family="${FONT}" font-size="12" fill="#5a6470">${esc(caption)}</text>`);
    }
    // Last, so it is over the figure — and handed the plot rect so it grows a plate if
    // the user sizes it down into the picture.
    body.push(titleBlock(title, view, designBox(), box));

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img"`
      + ` aria-label="${esc(title || 'Figure')}">${body.join('')}</svg>`;
  },
});

/** The model a baked figure is stored as. Exported for the results pane and its tests. */
export function bakedModel({ svg, title = '', caption = '', legend = [], scale = null, params = [], redraw = null }) {
  return {
    kind: 'baked',
    svg: String(svg || ''),
    title,
    caption,
    legend: Array.isArray(legend) ? legend : [],
    // A continuous COLOUR SCALE instead of a row-per-category legend (#204) — the
    // choropleth's colour bar, which `sf` used to draw inside the panel where nobody
    // could reword or move it.
    //
    // Mutually exclusive with `legend` by construction below rather than by politeness: a
    // figure keys its colours one way or the other, and offering both would put two
    // different claims about the same colours in the same corner.
    scale: normaliseScale(scale),
    // PARAMETERS of the figure, not of its furniture (#203) — a layout algorithm, a k, a
    // distance metric. Changing one re-invokes the plugin, which is acceptable precisely
    // because the user expects a recompute when they change a parameter. The furniture
    // (title, caption, legend, size) stays instant and R-free, which is the half most
    // editing actually is.
    params: normaliseParams(params),
    // Who to ask for a new figure, and WITH WHAT: `{plugin, fn, args}`.
    //
    // `args` is the plugin's own context for the run — which columns it used, which
    // options were chosen — and it is the part that is easy to leave out and impossible
    // to do without. Each `app.webr.run` is a fresh environment and a bare invoke binds
    // no analysis inputs, so a redraw that referenced the variables the host injected for
    // the original run would fail with "object 'from' not found". (It did, in the first
    // version of this, which is the same mistake #200 had just been fixed for.)
    //
    // Held on the MODEL rather than in a closure because the model is what PERSISTS: a
    // reopened chart has to be able to redraw or honestly say it cannot, so the context
    // has to survive a save. Plain data only, for the same reason.
    redraw: redraw && redraw.plugin && redraw.fn
      ? { plugin: String(redraw.plugin), fn: String(redraw.fn), args: plainArgs(redraw.args) }
      : null,
  };
}

/**
 * Validate a declared colour scale, dropping it whole if it cannot be drawn honestly.
 *
 * Needs at least two colours (one is not a scale) and a finite range. `breaks` are
 * optional and are NOT invented when absent — the bar then labels only its ends, because
 * a tick the data did not justify is a number a reader will quote back.
 *
 * The colours must be the ones the figure was actually drawn with. Nothing here can check
 * that, which is why the plugin is asked to pass the same vector it gave R rather than a
 * palette name the host would re-evaluate — see `builtin-spatial`, where one `cols`
 * definition feeds both.
 */
function normaliseScale(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const colors = Array.isArray(raw.colors) ? raw.colors.filter((c) => typeof c === 'string' && c) : [];
  const min = Number(raw.min);
  const max = Number(raw.max);
  if (colors.length < 2 || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  const breaks = Array.isArray(raw.breaks)
    ? raw.breaks.map(Number).filter(Number.isFinite)
    : [];
  return {
    min,
    max,
    colors,
    breaks: breaks.length >= 2 ? breaks : [],
    label: typeof raw.label === 'string' ? raw.label : '',
  };
}

/**
 * A plugin's redraw context, reduced to values that survive a structured clone and a
 * save: strings, finite numbers, booleans, and flat arrays of those. Anything else is
 * dropped rather than carried, because a redraw context that cannot be persisted is a
 * chart that redraws until it is reopened and then stops.
 */
function plainArgs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) out[k] = [...v];
  }
  return out;
}

/**
 * Validate declared parameters, dropping anything half-written.
 *
 * Same rule as every other declaration the host accepts from a plugin: a malformed entry
 * costs that entry, never the figure. A parameter with no options could only render an
 * empty select, and one with no id could not be read back.
 */
function normaliseParams(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      const id = typeof p?.id === 'string' ? p.id.trim() : '';
      const options = Array.isArray(p?.options)
        ? p.options
          .map((o) => (Array.isArray(o) ? o : [o, o]))
          .filter(([v]) => v != null && String(v) !== '')
          .map(([v, l]) => [String(v), String(l ?? v)])
        : [];
      if (!id || !options.length) return null;
      return {
        id,
        label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : id,
        options,
        default: String(p.default ?? options[0][0]),
        hint: typeof p.hint === 'string' ? p.hint : '',
      };
    })
    .filter(Boolean);
}

/**
 * The parameter controls, which the host renders alongside the furniture ones.
 *
 * Grouped under their own heading and placed LAST, because they are the expensive ones:
 * a reader scanning the panel for the title box should not pass a control that spins up R
 * on the way. The group name says what they cost.
 *
 * ## A parameter must not change what the TABLES say
 *
 * Presentation only — a layout, an arrangement, a projection. The reason is structural: a
 * redraw returns an SVG and the host writes it to `model.svg` and nothing else, so a
 * parameter that genuinely altered the analysis would leave the figure disagreeing with
 * the tables printed beside it, which still look authoritative. Not an unlogged result —
 * an inconsistent one.
 *
 * Anything that moves a number belongs in the menu, where re-running appends a new
 * analysis carrying its own inputs into History and the exported script. An earlier
 * decision (2026-10-24) closed this whole feature on a near-miss of that argument; see the
 * Layer 3b entry in TODO for how the two were reconciled.
 */
function paramControls(model) {
  if (!model.params?.length || !model.redraw) return [];
  return model.params.map((p) => ({
    id: `param:${p.id}`,
    label: p.label,
    type: 'select',
    group: 'Recompute the figure',
    options: p.options,
    default: p.default,
    hint: p.hint,
  }));
}
