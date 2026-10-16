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
    }));
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
  colorItems: (model) => legendItems(model),
  colorEditable: false,

  baseView: (model) => ({ legend: legendItems(model).length ? 'right' : 'none' }),

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

    const items = legendItems(model);
    if (items.length) body.push(legendBlock(items, view.legend, box, view, designBox()));

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
export function bakedModel({ svg, title = '', caption = '', legend = [] }) {
  return {
    kind: 'baked',
    svg: String(svg || ''),
    title,
    caption,
    legend: Array.isArray(legend) ? legend : [],
  };
}
