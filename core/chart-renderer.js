/**
 * @file chart-renderer.js
 * Host-side, data-driven chart renderer — the other half of the plotting model.
 *
 * The legacy path (`results.appendPlot`) takes a finished SVG baked in R: by the
 * time the host sees it, it's a picture, so colours, ordering, stacking and the
 * legend can't be changed without re-running R. This module instead renders a
 * **structured chart model** to SVG in plain JS, so a chart can be re-ordered,
 * recoloured and re-stacked *instantly* with no WebR round-trip. (The word cloud
 * already proved this R-computes-data / JS-renders-SVG split works here.)
 *
 * ## Extensibility — the chart-kind registry
 * Chart *kinds* (categorical, scatter, pie, …) are entries in a registry, not a
 * hardcoded switch. Each kind is one object declaring how to draw itself, its view
 * defaults, the items that take palette colours, and which controls it offers:
 *
 *   registerChartKind('whatever', {
 *     render(model, view) -> svgString,
 *     baseView(model)     -> Partial<ViewState>,   // kind-specific view defaults
 *     colorItems(model)   -> [{key,label}],         // legend/colour/reorder entries
 *     colorLabel,                                    // 'Series' | 'Slices' | …
 *     reorderCategories,                             // expose an x-axis order list?
 *     controls(model)     -> [ControlDescriptor],   // kind-specific control widgets
 *   })
 *
 * Adding a new chart type tomorrow is "register one object" — the renderer, the
 * controls panel (chart-controls.js, descriptor-driven), persistence and export all
 * pick it up with no further changes. The shared controls (palette, legend, value
 * labels, the colour/reorder lists) are built from helpers any kind can reuse.
 *
 * Pure module: no DOM, no app deps. `renderChart` returns a string. Model text is
 * escaped for SVG; callers still sanitise the result before insertion.
 *
 * @typedef {Object} ChartModel
 * @property {string} kind - a registered chart kind ('categorical' | 'scatter' | 'pie').
 * @property {string} [title]
 * @property {{key:string,label:string}[]} [categories] - x items (categorical), natural order.
 * @property {{key:string,label:string,values:(number|null)[],rawValues?:number[][]}[]} [series] - categorical series; values align to categories. Optional rawValues: per-category arrays of raw observations (enables point overlay + error bars).
 * @property {{x:number,y:number,g?:string}[]} [points] - scatter points (optional group key `g`).
 * @property {{key:string,label:string}[]} [groups] - scatter group legend entries (when points carry `g`).
 * @property {{slope:number,intercept:number,r2:number}} [trend] - scatter regression line.
 * @property {{key:string,label:string,value:number}[]} [slices] - pie slices.
 * @property {{x?:{title?:string},y?:{title?:string}}} [axes]
 * @property {Partial<ViewState>} [view] - plugin-suggested display defaults.
 *
 * @typedef {Object} ViewState
 * @property {'bar'|'line'} [mark] - categorical: bars or lines.
 * @property {'none'|'stacked'|'percent'} [stack] - grouped / stacked / 100%-stacked (bars).
 * @property {string[]} seriesOrder - colour-item keys, in draw/legend order.
 * @property {string[]} categoryOrder - category keys, in axis order.
 * @property {Object<string,string>} colors - per-item colour overrides (key → #hex).
 * @property {string} palette - palette id (see {@link PALETTES}).
 * @property {'right'|'top'|'bottom'|'none'} legend
 * @property {boolean} valueLabels - draw the numeric value / percentage on marks.
 * @property {boolean} [trendLine] - scatter: draw the regression line.
 * @property {number} [pointSize] - scatter: point radius.
 * @property {number} [pieRotation] - pie: start-angle offset in degrees.
 * @property {boolean} [gridlines] - show gridlines (default true).
 * @property {boolean} [pointOverlay] - categorical: overlay raw data points on bars.
 * @property {'none'|'sem'|'sd'|'ci95'} [errorBars] - categorical: error bar type.
 * @property {string} [titleText] - override model.title.
 * @property {number} [titleSize] - title font size (default 15).
 * @property {boolean} [titleBold] - title bold (default true).
 * @property {boolean} [titleItalic] - title italic.
 * @property {string} [xAxisTitle] - override model.axes.x.title.
 * @property {number} [xAxisTitleSize] - x-axis title font size (default 12).
 * @property {boolean} [xAxisTitleBold] - x-axis title bold.
 * @property {boolean} [xAxisTitleItalic] - x-axis title italic.
 * @property {string} [yAxisTitle] - override model.axes.y.title.
 * @property {number} [yAxisTitleSize] - y-axis title font size (default 12).
 * @property {boolean} [yAxisTitleBold] - y-axis title bold.
 * @property {boolean} [yAxisTitleItalic] - y-axis title italic.
 * @property {number} [yAxisMin] - user override for y-axis minimum.
 * @property {number} [yAxisMax] - user override for y-axis maximum.
 * @property {number} [xAxisMin] - scatter: user override for x-axis minimum.
 * @property {number} [xAxisMax] - scatter: user override for x-axis maximum.
 * @property {number} [valueLabelSize] - value label font size.
 * @property {boolean} [valueLabelBold] - value labels bold.
 * @property {boolean} [valueLabelItalic] - value labels italic.
 *
 * @typedef {Object} ControlDescriptor
 * @property {string} id
 * @property {string} label
 * @property {'select'|'check'|'number'|'text'} type
 * @property {[string,string][]|((model:ChartModel)=>[string,string][])} [options] - for select.
 * @property {number} [min] @property {number} [max] @property {number} [step] - for number.
 * @property {(view:ViewState)=>*} get
 * @property {(view:ViewState, value:*)=>void} set
 * @property {(view:ViewState, model:ChartModel)=>boolean} [visible]
 * @property {boolean} [structural] - changing it re-lays-out the controls panel.
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

// --- chart-kind registry -----------------------------------------------------

/** name → kind definition. @type {Map<string, object>} */
const KINDS = new Map();

/** Register a chart kind (see file header for the shape). */
export function registerChartKind(name, def) {
  KINDS.set(name, def);
}

/** The definition for a kind, or undefined if unknown. */
export function getChartKind(name) {
  return KINDS.get(name);
}

/** Shared view defaults every kind inherits (kinds override via `baseView`). */
const SHARED_DEFAULTS = {
  palette: DEFAULT_PALETTE,
  legend: 'right',
  valueLabels: false,
  gridlines: true,
  colors: {},
};

/**
 * Build the initial {@link ViewState} for a model: shared defaults, the kind's
 * `baseView`, then the plugin's `model.view`, with colour-item/category order seeded
 * from the model. Pure — returns a fresh object.
 * @param {ChartModel} model
 * @returns {ViewState}
 */
export function defaultView(model) {
  const kd = getChartKind(model.kind);
  const itemKeys = (kd ? kd.colorItems(model) : []).map((it) => it.key);
  const catKeys = (model.categories || []).map((c) => c.key);
  const v = {
    ...SHARED_DEFAULTS,
    seriesOrder: itemKeys,
    categoryOrder: catKeys,
    ...(kd && kd.baseView ? kd.baseView(model) : {}),
    ...(model.view || {}),
  };
  v.seriesOrder = reconcileOrder(v.seriesOrder, itemKeys);
  v.categoryOrder = reconcileOrder(v.categoryOrder, catKeys);
  v.colors = { ...(model.view && model.view.colors ? model.view.colors : {}) };
  return v;
}

/** Render a chart model + view to an `<svg>` string (responsive via viewBox). */
export function renderChart(model, view) {
  const kd = getChartKind(model && model.kind);
  if (!kd) return errorSvg(`Unsupported chart kind: ${esc(model && model.kind)}`);
  return kd.render(model, view);
}

/**
 * The UI spec a controls panel needs to render itself for this model: the kind's
 * control descriptors plus its colour-item list and category-reorder flag. Keeps
 * chart-controls.js free of any per-kind knowledge.
 * @param {ChartModel} model
 */
export function chartUiSpec(model) {
  const kd = getChartKind(model.kind);
  if (!kd) return { controls: [], colorItems: [], colorLabel: 'Series', reorderCategories: false, categories: [] };
  return {
    controls: kd.controls ? kd.controls(model) : [],
    colorItems: kd.colorItems(model),
    // A kind may make this depend on the model — SCED calls it "Phases" or "Measures"
    // depending on which channel is carrying the distinction.
    colorLabel: (typeof kd.colorLabel === 'function' ? kd.colorLabel(model) : kd.colorLabel) || 'Series',
    reorderCategories: !!kd.reorderCategories,
    categories: model.categories || [],
  };
}

/** Keep `wanted`'s order for keys that exist, append model keys it missed, drop
 * unknown keys. Guarantees a permutation of `all`. */
function reconcileOrder(wanted, all) {
  const set = new Set(all);
  const seen = new Set();
  const out = [];
  for (const k of wanted || []) if (set.has(k) && !seen.has(k)) { out.push(k); seen.add(k); }
  for (const k of all) if (!seen.has(k)) out.push(k);
  return out;
}

// --- shared control-descriptor builders (any kind can reuse) -----------------

/** Count of colour items for a model (drives palette/legend visibility). */
function colorItemCount(model) {
  const kd = getChartKind(model.kind);
  return kd ? kd.colorItems(model).length : 0;
}

/** Palette chooser — only meaningful when more than one item takes a colour. */
export function paletteControl() {
  return {
    id: 'palette', label: 'Palette', type: 'select', structural: true, group: 'Style',
    options: () => Object.entries(PALETTES).map(([k, p]) => [k, p.label]),
    get: (v) => v.palette || DEFAULT_PALETTE,
    set: (v, x) => { v.palette = x; },
    visible: (v, m) => colorItemCount(m) > 1,
  };
}

/** Legend placement — only when more than one item is shown. */
export function legendControl() {
  return {
    id: 'legend', label: 'Legend', type: 'select', group: 'Style',
    options: [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['none', 'Hidden']],
    get: (v) => v.legend,
    set: (v, x) => { v.legend = x; },
    visible: (v, m) => colorItemCount(m) > 1,
  };
}

/** Value-labels toggle. */
export function valueLabelsControl(label = 'Value labels') {
  return {
    id: 'valueLabels', label, type: 'check', group: 'Labels',
    get: (v) => !!v.valueLabels,
    set: (v, x) => { v.valueLabels = x; },
  };
}

/** Gridlines toggle. */
export function gridlinesControl() {
  return {
    id: 'gridlines', label: 'Gridlines', type: 'check', group: 'Style',
    get: (v) => v.gridlines !== false,
    set: (v, x) => { v.gridlines = x; },
  };
}

/** Whether any series carries raw observations (gates point/error controls). */
function hasRawValues(model) {
  return (model.series || []).some((s) => s.rawValues && s.rawValues.some((a) => a && a.length));
}

/** Point overlay toggle (only when raw values are available). */
function pointOverlayControl(model) {
  return {
    id: 'pointOverlay', label: 'Show data points', type: 'check', group: 'Style',
    get: (v) => !!v.pointOverlay,
    set: (v, x) => { v.pointOverlay = x; },
    visible: () => hasRawValues(model),
  };
}

/** Error bars selector (only when raw values are available). */
function errorBarsControl(model) {
  return {
    id: 'errorBars', label: 'Error bars', type: 'select', group: 'Style',
    options: [['none', 'None'], ['sem', 'SEM'], ['sd', 'SD'], ['ci95', '95% CI']],
    get: (v) => v.errorBars || 'none',
    set: (v, x) => { v.errorBars = x; },
    visible: () => hasRawValues(model),
  };
}

// --- title / axis / value-label controls -------------------------------------

/** Chart title text + formatting controls. */
function titleControls(model) {
  return [
    {
      id: 'titleText', label: 'Title', type: 'text', group: 'Titles & axes',
      placeholder: model.title || '(none)',
      get: (v) => v.titleText ?? '',
      set: (v, x) => { v.titleText = x || undefined; },
    },
    {
      id: 'titleSize', label: 'Title size', type: 'number', min: 8, max: 28, step: 1, group: 'Titles & axes',
      get: (v) => v.titleSize || 15,
      set: (v, x) => { v.titleSize = Number(x) || undefined; },
      visible: (v) => !!(v.titleText || model.title),
    },
    {
      id: 'titleBold', label: 'Title bold', type: 'check', group: 'Titles & axes',
      get: (v) => v.titleBold !== false,
      set: (v, x) => { v.titleBold = x; },
      visible: (v) => !!(v.titleText || model.title),
    },
    {
      id: 'titleItalic', label: 'Title italic', type: 'check', group: 'Titles & axes',
      get: (v) => !!v.titleItalic,
      set: (v, x) => { v.titleItalic = x; },
      visible: (v) => !!(v.titleText || model.title),
    },
  ];
}

/** Axis title + formatting + min/max controls for one axis. */
function axisControls(axis, model) {
  const upper = axis.toUpperCase();
  const modelTitle = model.axes?.[axis]?.title || '';
  const prefix = `${axis}Axis`;
  return [
    {
      id: `${prefix}Title`, label: `${upper} axis title`, type: 'text', group: 'Titles & axes',
      placeholder: modelTitle || '(none)',
      get: (v) => v[`${prefix}Title`] ?? '',
      set: (v, x) => { v[`${prefix}Title`] = x || undefined; },
    },
    {
      id: `${prefix}TitleSize`, label: `${upper} title size`, type: 'number', min: 8, max: 22, step: 1, group: 'Titles & axes',
      get: (v) => v[`${prefix}TitleSize`] || 12,
      set: (v, x) => { v[`${prefix}TitleSize`] = Number(x) || undefined; },
      visible: (v) => !!(v[`${prefix}Title`] || modelTitle),
    },
    {
      id: `${prefix}TitleBold`, label: `${upper} title bold`, type: 'check', group: 'Titles & axes',
      get: (v) => !!v[`${prefix}TitleBold`],
      set: (v, x) => { v[`${prefix}TitleBold`] = x; },
      visible: (v) => !!(v[`${prefix}Title`] || modelTitle),
    },
    {
      id: `${prefix}TitleItalic`, label: `${upper} title italic`, type: 'check', group: 'Titles & axes',
      get: (v) => !!v[`${prefix}TitleItalic`],
      set: (v, x) => { v[`${prefix}TitleItalic`] = x; },
      visible: (v) => !!(v[`${prefix}Title`] || modelTitle),
    },
    {
      id: `${prefix}Min`, label: `${upper} axis min`, type: 'number', placeholder: 'auto', group: 'Titles & axes',
      get: (v) => v[`${prefix}Min`] ?? '',
      set: (v, x) => { v[`${prefix}Min`] = x === '' ? undefined : Number(x); },
    },
    {
      id: `${prefix}Max`, label: `${upper} axis max`, type: 'number', placeholder: 'auto', group: 'Titles & axes',
      get: (v) => v[`${prefix}Max`] ?? '',
      set: (v, x) => { v[`${prefix}Max`] = x === '' ? undefined : Number(x); },
    },
  ];
}

/** Value label formatting controls (size, bold, italic). */
function valueLabelFormatControls() {
  return [
    {
      id: 'valueLabelSize', label: 'Label size', type: 'number', min: 6, max: 18, step: 0.5, group: 'Labels',
      get: (v) => v.valueLabelSize || 9.5,
      set: (v, x) => { v.valueLabelSize = Number(x) || undefined; },
      visible: (v) => !!v.valueLabels,
    },
    {
      id: 'valueLabelBold', label: 'Labels bold', type: 'check', group: 'Labels',
      get: (v) => !!v.valueLabelBold,
      set: (v, x) => { v.valueLabelBold = x; },
      visible: (v) => !!v.valueLabels,
    },
    {
      id: 'valueLabelItalic', label: 'Labels italic', type: 'check', group: 'Labels',
      get: (v) => !!v.valueLabelItalic,
      set: (v, x) => { v.valueLabelItalic = x; },
      visible: (v) => !!v.valueLabels,
    },
  ];
}

// --- shared drawing helpers --------------------------------------------------

const W = 720;
const H = 460;
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const AXIS = '#555';
// Gridlines must be VISIBLE or the toggle that controls them reads as broken. The
// previous #e6eaee measured 1.21:1 against white — about a fifth of WCAG 1.4.11's 3:1
// for graphical objects — so switching gridlines off changed the SVG (verifiably: 11
// stroke references to 0) while changing nothing a reader could see. Reported as
// "gridlines doesn't appear to do anything, in any chart", and that was a fair reading.
// 3:1 itself would make a reference line compete with the data, so this sits at 1.56:1:
// unmistakably present, still clearly behind the series.
const GRID = '#c8d0d9';

function errorSvg(msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 80" font-family="${FONT}" role="img">`
    + `<title>${esc(msg)}</title>`
    + `<text x="12" y="44" font-size="13" fill="#b00">${esc(msg)}</text></svg>`;
}

function text(x, y, content, { size = 12, anchor = 'start', fill = '#000', weight, italic } = {}) {
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}${italic ? ' font-style="italic"' : ''}>${content}</text>`;
}

function r(n) { return Math.round(n * 100) / 100; }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Format an axis/value number compactly (no trailing zeros, thousands grouped). */
function fmtNum(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(1);
  const rounded = Math.round(v * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Descriptive stats from raw values (for error bars). */
function computeStats(values) {
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
function errorBounds(stats, type) {
  if (!stats) return null;
  const { mean, sd, sem } = stats;
  if (type === 'sem') return { lo: mean - sem, hi: mean + sem };
  if (type === 'sd') return { lo: mean - sd, hi: mean + sd };
  if (type === 'ci95') return { lo: mean - 1.96 * sem, hi: mean + 1.96 * sem };
  return null;
}

/** Deterministic horizontal offsets for n points within a given width. */
function jitterOffsets(n, width) {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const span = width * (n <= 5 ? 0.5 : 0.7);
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => -span / 2 + step * i);
}

/** Draw minor tick marks between major ticks on a numeric axis.
 *  `axis` = 'y' (horizontal ticks on left edge) or 'x' (vertical ticks on bottom edge). */
function minorTicks(out, ticks, scale, axis, anchor) {
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
function niceTicks(min, max, count) {
  if (min === max) max = min + 1;
  const span = niceNum(max - min, false);
  const step = niceNum(span / Math.max(1, count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const out = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = (range || 1) / Math.pow(10, exp);
  let nf;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

/** A legend (right column, or a centred top/bottom row). `items` = [{label,color}].
 * `box` = {x0,x1,y0,y1} plot rect. */
function legendBlock(items, place, box) {
  if (!items.length || place === 'none') return '';
  const out = [];
  if (place === 'right') {
    let ly = box.y1 + 4;
    const lx = box.x1 + 14;
    for (const it of items) {
      out.push(`<rect x="${r(lx)}" y="${r(ly)}" width="12" height="12" rx="2" fill="${it.color}"/>`);
      out.push(text(lx + 17, ly + 10, esc(clip(it.label, 26)), { size: 11, fill: '#333' }));
      ly += 19;
    }
  } else {
    const gap = 16;
    const widths = items.map((it) => 16 + clip(it.label, 22).length * 6.2 + gap);
    const totalW = widths.reduce((a, b) => a + b, 0) - gap;
    let lx = (box.x0 + box.x1) / 2 - totalW / 2;
    const ly = place === 'top' ? box.y1 - 16 : box.y0 + 38;
    for (let i = 0; i < items.length; i++) {
      out.push(`<rect x="${r(lx)}" y="${r(ly - 9)}" width="12" height="12" rx="2" fill="${items[i].color}"/>`);
      out.push(text(lx + 16, ly + 1, esc(clip(items[i].label, 22)), { size: 11, fill: '#333' }));
      lx += widths[i];
    }
  }
  return out.join('');
}

/** Map an ordered list of keys back to model items, skipping any missing, then
 * appending any the order didn't name (defensive). */
function ordered(items, order) {
  const by = new Map((items || []).map((it) => [it.key, it]));
  const out = [];
  for (const k of order || []) if (by.has(k)) out.push(by.get(k));
  for (const it of items || []) if (!order || !order.includes(it.key)) out.push(it);
  return out;
}

function svgOpen(label) {
  return svgOpenH(H, label);
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
function svgOpenH(h, label) {
  const role = label ? ' role="img"' : '';
  const title = label ? `<title>${esc(label)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${r(h)}" font-family="${FONT}"${role}>`
    + title
    + `<rect x="0" y="0" width="${W}" height="${r(h)}" fill="#ffffff"/>`;
}

/**
 * The sentence a screen reader hears in place of the chart. The chart's own title is
 * the headline; the rest says what KIND of thing it is and how much of it there is,
 * because "Age vs Income" alone does not tell a non-sighted reader whether they are
 * missing 3 points or 300.
 */
function chartAltText(model, view, extra) {
  const title = view.titleText || model.title || '';
  const kind = {
    scatter: 'Scatter plot', categorical: 'Chart', pie: 'Pie chart',
    sced: 'Single-case design chart', violin: 'Violin plot',
    dots: 'Dot plot', paired: 'Before-after plot', box: 'Boxplot',
    wordcloud: 'Word cloud',
  }[model.kind] || 'Chart';
  // Don't say "Word cloud: Word cloud." when the title already names the chart type.
  const named = title && !title.toLowerCase().startsWith(kind.toLowerCase())
    ? `${kind}: ${title}.`
    : `${title || kind}.`;
  return [named, extra].filter(Boolean).join(' ');
}

// =============================================================================
// KIND: categorical (grouped / stacked / 100%-stacked bars + lines)
// =============================================================================

registerChartKind('categorical', {
  colorLabel: 'Series',
  reorderCategories: true,
  colorItems: (model) => (model.series || []).map((s) => ({ key: s.key, label: s.label || s.key })),
  baseView: (model) => ({
    mark: 'bar',
    stack: 'none',
    legend: (model.series || []).length > 1 ? 'right' : 'none',
  }),
  controls: (model) => [
    {
      id: 'mark', label: 'Type', type: 'select', structural: true, group: 'Chart',
      options: [['bar', 'Bars'], ['line', 'Lines']],
      get: (v) => v.mark || 'bar', set: (v, x) => { v.mark = x; },
    },
    {
      id: 'stack', label: 'Stacking', type: 'select', group: 'Chart',
      options: [['none', 'Grouped'], ['stacked', 'Stacked'], ['percent', '100% stacked']],
      get: (v) => v.stack || 'none', set: (v, x) => { v.stack = x; },
      visible: (v) => v.mark !== 'line' && (model.series || []).length > 1,
    },
    pointOverlayControl(model),
    errorBarsControl(model),
    gridlinesControl(),
    paletteControl(),
    legendControl(),
    valueLabelsControl(),
    ...valueLabelFormatControls(),
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => renderCategorical(model, view),
});

function renderCategorical(model, view) {
  const cats = ordered(model.categories, view.categoryOrder);
  const series = ordered(model.series, view.seriesOrder);
  const isLine = view.mark === 'line';
  const stack = isLine ? 'none' : (view.stack || 'none');
  const catIndex = new Map((model.categories || []).map((c, i) => [c.key, i]));
  const valueAt = (s, ci) => {
    const v = s.values ? s.values[catIndex.get(cats[ci].key)] : 0;
    return Number.isFinite(v) ? v : 0;
  };

  const rawAt = (s, ci) => {
    if (!s.rawValues) return null;
    const idx = catIndex.get(cats[ci].key);
    return idx != null ? s.rawValues[idx] : null;
  };

  let yMin = 0;
  let yMax = 1;
  if (stack === 'percent') {
    yMax = 100;
  } else if (stack === 'stacked') {
    yMax = Math.max(1, ...cats.map((_, ci) => series.reduce((acc, s) => acc + Math.max(0, valueAt(s, ci)), 0)));
  } else {
    const all = [];
    for (const s of series) {
      for (let ci = 0; ci < cats.length; ci++) all.push(valueAt(s, ci));
      if (s.rawValues) for (const rv of s.rawValues) if (rv) for (const v of rv) if (Number.isFinite(v)) all.push(v);
    }
    yMax = Math.max(1, ...all);
    yMin = Math.min(0, ...all);
  }
  if (Number.isFinite(view.yAxisMin)) yMin = view.yAxisMin;
  if (Number.isFinite(view.yAxisMax)) yMax = view.yAxisMax;
  const ticks = niceTicks(yMin, yMax, 5);
  yMin = ticks[0];
  yMax = ticks[ticks.length - 1];

  const chartTitle = view.titleText || model.title;
  const xTitle = view.xAxisTitle || model.axes?.x?.title;
  const yTitle = view.yAxisTitle || model.axes?.y?.title;

  const legendRight = view.legend === 'right' && series.length > 1;
  const longest = Math.max(0, ...series.map((s) => (s.label || s.key).length));
  const mRight = legendRight ? Math.min(220, Math.max(70, longest * 7 + 28)) : 18;
  const mTop = (chartTitle ? 34 : 14) + (view.legend === 'top' && series.length > 1 ? 22 : 0);
  const rotate = cats.length > 6 || Math.max(0, ...cats.map((c) => (c.label || c.key).length)) > 6;
  const longestX = Math.max(0, ...cats.map((c) => (c.label || c.key).length));
  const mBottom = (rotate ? Math.min(120, 28 + longestX * 6) : 40) + (xTitle ? 16 : 0) + (view.legend === 'bottom' && series.length > 1 ? 22 : 0);
  const mLeft = 56 + (yTitle ? 16 : 0);

  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };
  const plotW = box.x1 - box.x0;
  const plotH = box.y0 - box.y1;
  const yScale = (v) => box.y0 - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const out = [svgOpen(chartAltText(model, view, `${cats.length} categories, ${series.length} series.`))];
  if (chartTitle) out.push(text(W / 2, 20, esc(chartTitle), { size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400, italic: !!view.titleItalic, anchor: 'middle', fill: '#222' }));

  for (const t of ticks) {
    const y = yScale(t);
    if (view.gridlines !== false) {
      out.push(`<line x1="${box.x0}" y1="${r(y)}" x2="${box.x1}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
    }
    out.push(`<line x1="${r(box.x0 - 5)}" y1="${r(y)}" x2="${r(box.x0)}" y2="${r(y)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(text(box.x0 - 8, y + 4, fmtNum(t), { size: 11, anchor: 'end', fill: AXIS }));
  }
  minorTicks(out, ticks, yScale, 'y', box.x0);
  out.push(`<line x1="${box.x0}" y1="${r(yScale(yMax))}" x2="${box.x0}" y2="${r(yScale(yMin))}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${box.x0}" y1="${r(yScale(yMin))}" x2="${box.x1}" y2="${r(yScale(yMin))}" stroke="${AXIS}" stroke-width="1"/>`);

  const band = plotW / Math.max(1, cats.length);
  const xCenter = (ci) => box.x0 + band * (ci + 0.5);

  if (isLine) {
    drawLines(out, { series, cats, view, valueAt, xCenter, yScale });
  } else if (stack === 'none') {
    drawGroupedBars(out, { series, cats, view, valueAt, rawAt, band, x0: box.x0, yScale, yMin });
  } else {
    drawStackedBars(out, { series, cats, view, valueAt, stack, band, x0: box.x0, yScale });
  }

  for (let ci = 0; ci < cats.length; ci++) {
    const cx = xCenter(ci);
    const lab = esc(cats[ci].label || cats[ci].key);
    if (rotate) {
      out.push(`<text x="${r(cx)}" y="${r(box.y0 + 12)}" font-size="11" fill="${AXIS}" text-anchor="end" transform="rotate(-40 ${r(cx)} ${r(box.y0 + 12)})">${lab}</text>`);
    } else {
      out.push(text(cx, box.y0 + 16, lab, { size: 11, anchor: 'middle', fill: AXIS }));
    }
  }

  if (xTitle) {
    const xts = view.xAxisTitleSize || 12;
    const xtw = view.xAxisTitleBold ? ' font-weight="600"' : '';
    const xti = view.xAxisTitleItalic ? ' font-style="italic"' : '';
    out.push(`<text x="${r((box.x0 + box.x1) / 2)}" y="${r(H - 4)}" font-size="${xts}" fill="#333" text-anchor="middle"${xtw}${xti}>${esc(xTitle)}</text>`);
  }
  if (yTitle) {
    const yts = view.yAxisTitleSize || 12;
    const ytw = view.yAxisTitleBold ? ' font-weight="600"' : '';
    const yti = view.yAxisTitleItalic ? ' font-style="italic"' : '';
    const my = (box.y0 + box.y1) / 2;
    out.push(`<text x="14" y="${r(my)}" font-size="${yts}" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})"${ytw}${yti}>${esc(yTitle)}</text>`);
  }

  if (series.length > 1) {
    const items = series.map((s, i) => ({ label: s.label || s.key, color: colorFor(view, s.key, i) }));
    out.push(legendBlock(items, view.legend, box));
  }

  out.push('</svg>');
  return out.join('');
}

function drawGroupedBars(out, { series, cats, view, valueAt, rawAt, band, x0, yScale, yMin }) {
  const n = Math.max(1, series.length);
  const pad = band * 0.18;
  const inner = band - pad * 2;
  const bw = inner / n;
  const zeroY = yScale(Math.max(0, yMin));
  for (let ci = 0; ci < cats.length; ci++) {
    const bx0 = x0 + band * ci + pad;
    for (let si = 0; si < series.length; si++) {
      const v = valueAt(series[si], ci);
      const yv = yScale(v);
      const top = Math.min(yv, zeroY);
      const h = Math.abs(yv - zeroY);
      const x = bx0 + bw * si;
      out.push(`<rect x="${r(x)}" y="${r(top)}" width="${r(Math.max(1, bw - 1))}" height="${r(h)}" fill="${colorFor(view, series[si].key, si)}"/>`);
      if (view.valueLabels && v) out.push(text(x + bw / 2, top - 3, fmtNum(v), { size: view.valueLabelSize || 9.5, anchor: 'middle', fill: '#444', weight: view.valueLabelBold ? 600 : undefined, italic: !!view.valueLabelItalic }));
    }
  }

  // Error bars (grouped bars only, requires raw observations)
  const ebType = view.errorBars || 'none';
  if (ebType !== 'none' && rawAt) {
    for (let ci = 0; ci < cats.length; ci++) {
      const bx0 = x0 + band * ci + pad;
      for (let si = 0; si < series.length; si++) {
        const raw = rawAt(series[si], ci);
        if (!raw || raw.length < 2) continue;
        const stats = computeStats(raw);
        const eb = errorBounds(stats, ebType);
        if (!eb) continue;
        const cx = bx0 + bw * si + bw / 2;
        const yLo = yScale(eb.lo);
        const yHi = yScale(eb.hi);
        const capW = Math.min(bw * 0.4, 6);
        out.push(`<line x1="${r(cx)}" y1="${r(yLo)}" x2="${r(cx)}" y2="${r(yHi)}" stroke="#333" stroke-width="1.5"/>`);
        out.push(`<line x1="${r(cx - capW)}" y1="${r(yLo)}" x2="${r(cx + capW)}" y2="${r(yLo)}" stroke="#333" stroke-width="1.5"/>`);
        out.push(`<line x1="${r(cx - capW)}" y1="${r(yHi)}" x2="${r(cx + capW)}" y2="${r(yHi)}" stroke="#333" stroke-width="1.5"/>`);
      }
    }
  }

  // Point overlay (grouped bars only, requires raw observations)
  if (view.pointOverlay && rawAt) {
    for (let ci = 0; ci < cats.length; ci++) {
      const bx0 = x0 + band * ci + pad;
      for (let si = 0; si < series.length; si++) {
        const raw = rawAt(series[si], ci);
        if (!raw || !raw.length) continue;
        const cx = bx0 + bw * si + bw / 2;
        const offsets = jitterOffsets(raw.length, bw * 0.7);
        const col = colorFor(view, series[si].key, si);
        for (let pi = 0; pi < raw.length; pi++) {
          if (!Number.isFinite(raw[pi])) continue;
          out.push(`<circle cx="${r(cx + offsets[pi])}" cy="${r(yScale(raw[pi]))}" r="2.5" fill="${col}" stroke="#fff" stroke-width="0.7" fill-opacity="0.75"/>`);
        }
      }
    }
  }
}

function drawStackedBars(out, { series, cats, view, valueAt, stack, band, x0, yScale }) {
  const pad = band * 0.18;
  const bw = band - pad * 2;
  for (let ci = 0; ci < cats.length; ci++) {
    const x = x0 + band * ci + pad;
    const total = stack === 'percent' ? (series.reduce((acc, s) => acc + Math.max(0, valueAt(s, ci)), 0) || 1) : 0;
    let cum = 0;
    for (let si = 0; si < series.length; si++) {
      let v = Math.max(0, valueAt(series[si], ci));
      if (stack === 'percent') v = (v / total) * 100;
      if (v <= 0) continue;
      const yTop = yScale(cum + v);
      const yBot = yScale(cum);
      const h = Math.abs(yBot - yTop);
      out.push(`<rect x="${r(x)}" y="${r(yTop)}" width="${r(bw)}" height="${r(h)}" fill="${colorFor(view, series[si].key, si)}"/>`);
      if (view.valueLabels && h > 12) {
        out.push(text(x + bw / 2, (yTop + yBot) / 2 + 3, stack === 'percent' ? `${Math.round(v)}%` : fmtNum(v), { size: view.valueLabelSize || 9.5, anchor: 'middle', fill: '#fff', weight: 600, italic: !!view.valueLabelItalic }));
      }
      cum += v;
    }
  }
}

function drawLines(out, { series, cats, view, valueAt, xCenter, yScale }) {
  for (let si = 0; si < series.length; si++) {
    const col = colorFor(view, series[si].key, si);
    const pts = cats.map((_, ci) => `${r(xCenter(ci))},${r(yScale(valueAt(series[si], ci)))}`);
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (let ci = 0; ci < cats.length; ci++) {
      const cx = xCenter(ci);
      const cy = yScale(valueAt(series[si], ci));
      out.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="3.2" fill="${col}"/>`);
      if (view.valueLabels) out.push(text(cx, cy - 7, fmtNum(valueAt(series[si], ci)), { size: view.valueLabelSize || 9.5, anchor: 'middle', fill: '#444', weight: view.valueLabelBold ? 600 : undefined, italic: !!view.valueLabelItalic }));
    }
  }
}

// =============================================================================
// KIND: scatter (points, optional grouping, regression line)
// =============================================================================

registerChartKind('scatter', {
  colorLabel: 'Groups',
  reorderCategories: false,
  // Grouped → one colour item per group; ungrouped → a single "Points" entry so the
  // colour picker still works (and palette/legend stay hidden for one item).
  colorItems: (model) => (model.groups && model.groups.length
    ? model.groups.map((g) => ({ key: g.key, label: g.label || g.key }))
    : [{ key: '__points__', label: 'Points' }]),
  baseView: (model) => ({
    trendLine: !!model.trend,
    pointSize: 4,
    legend: model.groups && model.groups.length > 1 ? 'right' : 'none',
  }),
  controls: (model) => [
    ...(model.trend
      ? [{ id: 'trendLine', group: 'Chart', label: 'Trend line', type: 'check', get: (v) => !!v.trendLine, set: (v, x) => { v.trendLine = x; } }]
      : []),
    {
      id: 'pointSize', label: 'Point size', type: 'select', group: 'Chart',
      options: [['3', 'Small'], ['4', 'Medium'], ['6', 'Large']],
      get: (v) => String(v.pointSize || 4), set: (v, x) => { v.pointSize = Number(x); },
    },
    gridlinesControl(),
    paletteControl(),
    legendControl(),
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => renderScatter(model, view),
});

function renderScatter(model, view) {
  const pts = (model.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const groups = model.groups && model.groups.length ? ordered(model.groups, view.seriesOrder) : null;
  const colorOf = (p) => {
    if (!groups) return colorFor(view, '__points__', 0);
    const gi = groups.findIndex((g) => g.key === p.g);
    return colorFor(view, p.g, gi < 0 ? 0 : gi);
  };

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let xMin = Math.min(...xs, 0);
  let xMax = Math.max(...xs, 1);
  let yMin = Math.min(...ys, 0);
  let yMax = Math.max(...ys, 1);
  if (!pts.length) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }
  const xMinUser = Number.isFinite(view.xAxisMin);
  const xMaxUser = Number.isFinite(view.xAxisMax);
  const yMinUser = Number.isFinite(view.yAxisMin);
  const yMaxUser = Number.isFinite(view.yAxisMax);
  if (xMinUser) xMin = view.xAxisMin;
  if (xMaxUser) xMax = view.xAxisMax;
  if (yMinUser) yMin = view.yAxisMin;
  if (yMaxUser) yMax = view.yAxisMax;
  const xticks = niceTicks(xMinUser ? xMin : Math.min(...xs, xMin), xMaxUser ? xMax : Math.max(...xs, xMax), 6);
  const yticks = niceTicks(yMinUser ? yMin : Math.min(...ys, yMin), yMaxUser ? yMax : Math.max(...ys, yMax), 5);
  xMin = xticks[0]; xMax = xticks[xticks.length - 1];
  yMin = yticks[0]; yMax = yticks[yticks.length - 1];

  const chartTitle = view.titleText || model.title;
  const xTitle = view.xAxisTitle || model.axes?.x?.title;
  const yTitle = view.yAxisTitle || model.axes?.y?.title;

  const legendRight = view.legend === 'right' && groups && groups.length > 1;
  const mRight = legendRight ? Math.min(200, Math.max(70, Math.max(...groups.map((g) => (g.label || g.key).length)) * 7 + 28)) : 18;
  const mTop = chartTitle ? 34 : 16;
  const mBottom = 42 + (xTitle ? 16 : 0);
  const mLeft = 56 + (yTitle ? 16 : 0);
  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };
  const xScale = (x) => box.x0 + ((x - xMin) / (xMax - xMin || 1)) * (box.x1 - box.x0);
  const yScale = (y) => box.y0 - ((y - yMin) / (yMax - yMin || 1)) * (box.y0 - box.y1);

  const out = [svgOpen(chartAltText(model, view, `${pts.length} points.`))];
  if (chartTitle) out.push(text(W / 2, 20, esc(chartTitle), { size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400, italic: !!view.titleItalic, anchor: 'middle', fill: '#222' }));

  for (const t of yticks) {
    const y = yScale(t);
    if (view.gridlines !== false) {
      out.push(`<line x1="${box.x0}" y1="${r(y)}" x2="${box.x1}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
    }
    out.push(`<line x1="${r(box.x0 - 5)}" y1="${r(y)}" x2="${r(box.x0)}" y2="${r(y)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(text(box.x0 - 8, y + 4, fmtNum(t), { size: 11, anchor: 'end', fill: AXIS }));
  }
  for (const t of xticks) {
    const x = xScale(t);
    if (view.gridlines !== false) {
      out.push(`<line x1="${r(x)}" y1="${box.y1}" x2="${r(x)}" y2="${box.y0}" stroke="${GRID}" stroke-width="1"/>`);
    }
    out.push(`<line x1="${r(x)}" y1="${r(box.y0)}" x2="${r(x)}" y2="${r(box.y0 + 5)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(text(x, box.y0 + 18, fmtNum(t), { size: 11, anchor: 'middle', fill: AXIS }));
  }
  minorTicks(out, yticks, yScale, 'y', box.x0);
  minorTicks(out, xticks, xScale, 'x', box.y0);
  out.push(`<line x1="${box.x0}" y1="${r(yScale(yMax))}" x2="${box.x0}" y2="${r(yScale(yMin))}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${box.x0}" y1="${r(yScale(yMin))}" x2="${r(xScale(xMax))}" y2="${r(yScale(yMin))}" stroke="${AXIS}" stroke-width="1"/>`);

  const r0 = Math.max(1.5, view.pointSize || 4);
  for (const p of pts) {
    out.push(`<circle cx="${r(xScale(p.x))}" cy="${r(yScale(p.y))}" r="${r0}" fill="${colorOf(p)}" fill-opacity="0.62"/>`);
  }

  if (view.trendLine && model.trend && Number.isFinite(model.trend.slope)) {
    const { slope, intercept, r2 } = model.trend;
    const x1 = xMin;
    const x2 = xMax;
    out.push(`<line x1="${r(xScale(x1))}" y1="${r(yScale(slope * x1 + intercept))}" x2="${r(xScale(x2))}" y2="${r(yScale(slope * x2 + intercept))}" stroke="#e74c3c" stroke-width="2"/>`);
    if (Number.isFinite(r2)) out.push(text(box.x1, box.y1 - 4, `R² = ${r2.toFixed(3)}`, { size: 12, anchor: 'end', fill: '#e74c3c' }));
  }

  if (xTitle) {
    const xts = view.xAxisTitleSize || 12;
    const xtw = view.xAxisTitleBold ? ' font-weight="600"' : '';
    const xti = view.xAxisTitleItalic ? ' font-style="italic"' : '';
    out.push(`<text x="${r((box.x0 + box.x1) / 2)}" y="${r(H - 4)}" font-size="${xts}" fill="#333" text-anchor="middle"${xtw}${xti}>${esc(xTitle)}</text>`);
  }
  if (yTitle) {
    const yts = view.yAxisTitleSize || 12;
    const ytw = view.yAxisTitleBold ? ' font-weight="600"' : '';
    const yti = view.yAxisTitleItalic ? ' font-style="italic"' : '';
    const my = (box.y0 + box.y1) / 2;
    out.push(`<text x="14" y="${r(my)}" font-size="${yts}" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})"${ytw}${yti}>${esc(yTitle)}</text>`);
  }

  if (groups && groups.length > 1) {
    const items = groups.map((g, i) => ({ label: g.label || g.key, color: colorFor(view, g.key, i) }));
    out.push(legendBlock(items, view.legend, box));
  }

  out.push('</svg>');
  return out.join('');
}

// =============================================================================
// KIND: pie (slices, start-angle rotation, % labels)
// =============================================================================

registerChartKind('pie', {
  colorLabel: 'Slices',
  reorderCategories: false,
  colorItems: (model) => (model.slices || []).map((s) => ({ key: s.key, label: s.label || s.key })),
  baseView: () => ({ legend: 'right', valueLabels: true, pieRotation: 0 }),
  controls: () => [
    {
      id: 'pieRotation', group: 'Chart', label: 'Rotate (°)', type: 'number', min: 0, max: 360, step: 15,
      get: (v) => v.pieRotation || 0, set: (v, x) => { v.pieRotation = ((Number(x) % 360) + 360) % 360; },
    },
    paletteControl(),
    legendControl(),
    valueLabelsControl('Show %'),
  ],
  render: (model, view) => renderPie(model, view),
});

function renderPie(model, view) {
  const slices = ordered(model.slices, view.seriesOrder).filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;

  const legendRight = view.legend === 'right' && slices.length > 1;
  const mRight = legendRight ? Math.min(220, Math.max(80, Math.max(0, ...slices.map((s) => (s.label || s.key).length)) * 7 + 40)) : 24;
  const mTop = model.title ? 38 : 18;
  const cx = (24 + (W - mRight)) / 2;
  const cy = mTop + (H - mTop - 24) / 2;
  const radius = Math.min((W - mRight - 24) / 2, (H - mTop - 24) / 2) - 6;

  const out = [svgOpen(chartAltText(model, view, `${slices.length} slices.`))];
  if (model.title) out.push(text(W / 2, 22, esc(model.title), { size: 15, weight: 600, anchor: 'middle', fill: '#222' }));

  let ang = -90 + (view.pieRotation || 0); // start at top, + rotation, clockwise
  const items = [];
  slices.forEach((s, i) => {
    const frac = s.value / total;
    const sweep = frac * 360;
    const a0 = ang;
    const a1 = ang + sweep;
    const color = colorFor(view, s.key, i);
    if (slices.length === 1) {
      out.push(`<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(radius)}" fill="${color}"/>`);
    } else {
      out.push(`<path d="${arcPath(cx, cy, radius, a0, a1)}" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
    }
    if (view.valueLabels && frac > 0.03) {
      const mid = (a0 + a1) / 2;
      const lr = radius * 0.62;
      const lx = cx + lr * Math.cos((mid * Math.PI) / 180);
      const ly = cy + lr * Math.sin((mid * Math.PI) / 180);
      out.push(text(lx, ly + 3, `${Math.round(frac * 100)}%`, { size: 11, anchor: 'middle', fill: '#fff', weight: 600 }));
    }
    items.push({ label: `${s.label || s.key}`, color });
    ang = a1;
  });

  const box = { x0: 24, x1: W - mRight, y0: H - 24, y1: mTop };
  if (slices.length > 1) out.push(legendBlock(items, view.legend, box));

  out.push('</svg>');
  return out.join('');
}

/** SVG arc wedge path from `cx,cy` out to radius `rad`, sweeping start→end degrees
 * (0° = east, clockwise because SVG y grows downward). */
function arcPath(cx, cy, rad, startDeg, endDeg) {
  const a0 = (startDeg * Math.PI) / 180;
  const a1 = (endDeg * Math.PI) / 180;
  const x0 = cx + rad * Math.cos(a0);
  const y0 = cy + rad * Math.sin(a0);
  const x1 = cx + rad * Math.cos(a1);
  const y1 = cy + rad * Math.sin(a1);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${r(cx)} ${r(cy)} L ${r(x0)} ${r(y0)} A ${r(rad)} ${r(rad)} 0 ${large} 1 ${r(x1)} ${r(y1)} Z`;
}

// =============================================================================
// KIND: sced (single-case experimental design — multiple-baseline panels)
// =============================================================================

/**
 * The signature SCED figure: one stacked panel per case over a SHARED session axis,
 * with each case's phase change drawn where it actually happened. In a multiple-
 * baseline design those boundaries are deliberately staggered — the staircase IS the
 * design's evidence (the behaviour changes when, and only when, the intervention
 * arrives), so a chart that lined the panels up would destroy the thing being shown.
 *
 * Two drawing conventions here are requirements, not styling, and the defaults say so:
 *
 *  - **No line is drawn across a phase change.** Connecting them implies a continuous
 *    series through the intervention. `connectAcross` exists as a control because a
 *    user may have a reason, but it is off.
 *  - **Phases come from the data, as runs.** Boundaries are recomputed from the point
 *    sequence rather than declared, so an ABAB reversal draws its three boundaries with
 *    no extra plumbing, and a withdrawal phase re-uses phase A's colour.
 *
 * Height grows with the case count (see {@link svgOpenH}) — unlike the fixed-frame
 * kinds, a multiple-baseline chart has no natural single-panel size.
 */

/**
 * Break a caption into at most `maxLines` lines of about `perLine` characters, on word
 * boundaries. The last line is ellipsised rather than dropped, so an over-long label
 * degrades to "Acknowledging and Complimenting…" instead of vanishing.
 */
function wrapLabel(s, perLine, maxLines) {
  const words = String(s ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= perLine || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    // Anything unplaced gets folded into the final line, then ellipsised to fit.
    const placed = lines.join(' ').length;
    if (placed < String(s).trim().length) {
      lines[maxLines - 1] = clip(`${lines[maxLines - 1]}…`, perLine);
    }
  }
  return lines;
}

/**
 * A rotated caption of one or more lines, centred on `cy`.
 *
 * Under `rotate(-90)` the local +y axis points RIGHT on screen, so successive `dy`
 * offsets stack the lines side by side as a vertical column of text — which is exactly
 * how these captions are set in print — rather than wrapping along the reading
 * direction.
 */
function rotatedLabel(cx, cy, lines, { size = 10, fill = '#333', weight } = {}) {
  if (!lines.length) return '';
  const step = size * 1.15;
  const first = -((lines.length - 1) * step) / 2;
  const spans = lines.map((ln, i) =>
    `<tspan x="${r(cx)}" dy="${r(i === 0 ? first : step)}">${esc(ln)}</tspan>`).join('');
  return `<text x="${r(cx)}" y="${r(cy)}" font-size="${size}" fill="${fill}" text-anchor="middle"`
    + `${weight ? ` font-weight="${weight}"` : ''} transform="rotate(-90 ${r(cx)} ${r(cy)})">${spans}</text>`;
}

/**
 * Marker vocabulary for multi-series panels, ordered so that **fill alternates before
 * shape does**: filled circle, open circle, filled triangle, open triangle, …
 *
 * That order is the point. Journals print black and white, so a second measure in the
 * same panel has to be told apart without colour — and open-vs-closed of the same shape
 * is the distinction published SCED figures actually use. Eight glyphs before anything
 * repeats, which is more measures than a readable panel holds.
 */
const SCED_MARKERS = ['circle', 'circle-open', 'triangle', 'triangle-open',
  'square', 'square-open', 'diamond', 'diamond-open'];

/** One data marker. Open variants are white-filled with a coloured rim so they stay
 * legible against a connecting line of the same colour. */
function markerSvg(shape, cx, cy, rad, color) {
  const open = shape.endsWith('-open');
  const base = open ? shape.slice(0, -5) : shape;
  const fill = open ? '#ffffff' : color;
  const stroke = open ? color : '#ffffff';
  const sw = open ? 1.3 : 0.8;
  const attrs = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`;
  if (base === 'square') {
    return `<rect x="${r(cx - rad)}" y="${r(cy - rad)}" width="${r(rad * 2)}" height="${r(rad * 2)}" ${attrs}/>`;
  }
  if (base === 'triangle') {
    const h = rad * 1.15;
    return `<polygon points="${r(cx)},${r(cy - h)} ${r(cx + h)},${r(cy + h * 0.75)} ${r(cx - h)},${r(cy + h * 0.75)}" ${attrs}/>`;
  }
  if (base === 'diamond') {
    const d = rad * 1.25;
    return `<polygon points="${r(cx)},${r(cy - d)} ${r(cx + d)},${r(cy)} ${r(cx)},${r(cy + d)} ${r(cx - d)},${r(cy)}" ${attrs}/>`;
  }
  return `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" ${attrs}/>`;
}

/**
 * A panel's series. `panel.points` is sugar for a single unnamed series, so the
 * single-measure figure — which is most of them — needs no `series` key at all and
 * renders exactly as it did before this existed.
 */
function scedSeriesOf(panel) {
  if (Array.isArray(panel.series) && panel.series.length) return panel.series;
  return [{ key: '__one__', label: '', points: panel.points || [] }];
}

/** Ordered union of series keys across panels; empty when no panel declares any.
 * Panels legitimately carry different measures — in a real figure some behaviours are
 * scored on two and some on one — so this is a union, not an intersection. */
function scedSeriesKeys(model) {
  const out = [];
  for (const p of model.panels || []) {
    for (const s of (Array.isArray(p.series) ? p.series : [])) {
      if (!out.some((x) => x.key === s.key)) out.push({ key: s.key, label: s.label || s.key });
    }
  }
  return out;
}

/** Like {@link legendBlock} but keyed by MARKER rather than a colour swatch, so it
 * still distinguishes the entries when the figure is printed in black and white. */
function markerLegend(items, place, box) {
  if (!items.length || place === 'none') return '';
  const out = [];
  if (place === 'right') {
    let ly = box.y1 + 10;
    const lx = box.x1 + 20;
    for (const it of items) {
      out.push(markerSvg(it.shape, lx, ly, 4, it.color));
      out.push(text(lx + 12, ly + 4, esc(clip(it.label, 24)), { size: 11, fill: '#333' }));
      ly += 19;
    }
  } else {
    const gap = 18;
    const widths = items.map((it) => 16 + clip(it.label, 22).length * 6.2 + gap);
    const total = widths.reduce((a, b) => a + b, 0) - gap;
    let lx = (box.x0 + box.x1) / 2 - total / 2;
    const ly = place === 'top' ? box.y1 - 16 : box.y0 + 38;
    items.forEach((it, i) => {
      out.push(markerSvg(it.shape, lx + 5, ly - 3, 4, it.color));
      out.push(text(lx + 15, ly + 1, esc(clip(it.label, 22)), { size: 11, fill: '#333' }));
      lx += widths[i];
    });
  }
  return out.join('');
}

/** Consecutive same-phase runs of a panel's points, in session order. */
function scedRuns(points) {
  const sorted = [...points].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  const runs = [];
  for (const pt of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.phase === pt.phase) last.points.push(pt);
    else runs.push({ phase: pt.phase, points: [pt] });
  }
  return runs;
}

registerChartKind('sced', {
  // With more than one measure in a panel the marker has to carry the MEASURE, which
  // frees phase to be carried spatially by the boundary lines and condition labels —
  // the encoding swap the published convention makes. So the colour list follows
  // whichever channel is actually doing the distinguishing.
  colorLabel: (model) => (scedSeriesKeys(model).length ? 'Measures' : 'Phases'),
  reorderCategories: false,
  colorItems: (model) => {
    const series = scedSeriesKeys(model);
    return series.length ? series : (model.phases || []).map((p) => ({ key: p.key, label: p.label || p.key }));
  },
  baseView: (model) => ({
    mark: 'both',
    connectAcross: false,
    phaseLines: true,
    // One connected step-path across the panels, not an independent line per panel.
    // In a multiple-baseline figure the staircase IS the experimental argument, and
    // drawing it as one path is what makes the panels read as a single claim.
    staircase: (model.panels || []).length > 1,
    phaseLineStyle: 'solid', // JABA convention; dashed is the option, not the default
    phaseLabels: 'top',
    sharedY: true,
    mono: false,
    panelOrder: 'stagger',
    caseLabel: (model.panels || []).length > 1 ? 'axis' : 'panel',
    pointSize: 3.5,
    panelHeight: 130,
    yTickCount: 5, // 0/20/…/100 on percentage-of-opportunities data
    legend: (model.phases || []).length > 1 ? 'bottom' : 'none',
    gridlines: false, // SCED figures are conventionally clean; opt in if wanted
  }),
  controls: (model) => [
    {
      id: 'mark', label: 'Draw', type: 'select', structural: true, group: 'Chart',
      options: [['both', 'Points + lines'], ['points', 'Points only'], ['line', 'Lines only']],
      get: (v) => v.mark || 'both', set: (v, x) => { v.mark = x; },
    },
    {
      id: 'connectAcross', label: 'Connect across phase change', type: 'check', group: 'Chart',
      get: (v) => !!v.connectAcross, set: (v, x) => { v.connectAcross = x; },
    },
    {
      id: 'phaseLines', label: 'Phase change lines', type: 'check', group: 'Phases',
      get: (v) => v.phaseLines !== false, set: (v, x) => { v.phaseLines = x; },
    },
    {
      id: 'caseLabel', label: 'Case label', type: 'select', structural: true, group: 'Panels',
      options: [['axis', 'Beside the Y axis'], ['panel', 'Inside the panel'], ['none', 'Hidden']],
      get: (v) => v.caseLabel || ((model.panels || []).length > 1 ? 'axis' : 'panel'),
      set: (v, x) => { v.caseLabel = x; },
    },
    {
      id: 'panelOrder', label: 'Panel order', type: 'select', structural: true, group: 'Panels',
      options: [['stagger', 'By phase change (staircase)'], ['model', 'As in the data']],
      get: (v) => v.panelOrder || 'stagger', set: (v, x) => { v.panelOrder = x; },
      visible: () => (model.panels || []).length > 1,
    },
    {
      id: 'staircase', label: 'Connect as staircase', type: 'check', group: 'Phases',
      get: (v) => !!v.staircase, set: (v, x) => { v.staircase = x; },
      visible: (v) => v.phaseLines !== false && (model.panels || []).length > 1,
    },
    {
      id: 'phaseLineStyle', label: 'Phase line', type: 'select', group: 'Phases',
      options: [['solid', 'Solid'], ['dashed', 'Dashed']],
      get: (v) => v.phaseLineStyle || 'solid', set: (v, x) => { v.phaseLineStyle = x; },
      visible: (v) => v.phaseLines !== false,
    },
    {
      id: 'mono', label: 'Black & white (print)', type: 'check', structural: true, group: 'Style',
      get: (v) => !!v.mono, set: (v, x) => { v.mono = x; },
    },
    {
      id: 'phaseLabels', label: 'Condition labels', type: 'select', group: 'Phases',
      options: [['top', 'Top panel only'], ['all', 'Every panel'], ['none', 'Hidden']],
      get: (v) => v.phaseLabels || 'top', set: (v, x) => { v.phaseLabels = x; },
    },
    {
      id: 'sharedY', label: 'Same Y scale on all panels', type: 'check', group: 'Panels',
      get: (v) => v.sharedY !== false, set: (v, x) => { v.sharedY = x; },
      visible: () => (model.panels || []).length > 1,
    },
    {
      id: 'panelHeight', label: 'Panel height', type: 'number', min: 70, max: 320, step: 10, group: 'Panels',
      get: (v) => v.panelHeight || 130, set: (v, x) => { v.panelHeight = Number(x) || undefined; },
    },
    {
      id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style',
      get: (v) => v.pointSize || 3.5, set: (v, x) => { v.pointSize = Number(x) || undefined; },
    },
    {
      id: 'yTickCount', label: 'Y tick count', type: 'number', min: 2, max: 11, step: 1, group: 'Style',
      get: (v) => v.yTickCount || 5, set: (v, x) => { v.yTickCount = Number(x) || undefined; },
    },
    gridlinesControl(),
    // In black & white every phase is the same ink, so a palette chooser and a colour
    // legend would both be lying about carrying information. Phase is read off the
    // staircase and the condition labels instead — which is the convention's whole point.
    { ...paletteControl(), visible: (v, m) => !v.mono && (getChartKind(m.kind).colorItems(m).length > 1) },
    { ...legendControl(), visible: (v, m) => !v.mono && (getChartKind(m.kind).colorItems(m).length > 1) },
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => renderSced(model, view),
});

function renderSced(model, view) {
  // A panel carries either `points` or `series` — accept both, or a series-only panel
  // is silently dropped and the whole figure renders empty.
  const panelHasData = (p) => p && ((Array.isArray(p.points) && p.points.length)
    || (Array.isArray(p.series) && p.series.some((s) => (s.points || []).length)));
  let panels = (model.panels || []).filter(panelHasData);
  if (!panels.length) return errorSvg('SCED chart: no cases with plottable data.');

  const phaseList = ordered(model.phases || [], view.seriesOrder);
  const phaseOrder = new Map((model.phases || []).map((p, i) => [p.key, i]));
  const phaseLabel = new Map((model.phases || []).map((p) => [p.key, p.label || p.key]));
  const colorOfPhase = (key) => (view.mono ? '#000000' : colorFor(view, key, phaseOrder.get(key) ?? 0));

  // Series live under the panels; `points` is sugar for one unnamed series.
  const seriesKeys = scedSeriesKeys(model);
  const multiSeries = seriesKeys.length > 0;
  const seriesIndex = new Map(seriesKeys.map((s, i) => [s.key, i]));
  const colorOfSeries = (key) => (view.mono
    ? '#000000'
    : colorFor(view, key, seriesIndex.get(key) ?? 0));
  const markerOfSeries = (key) => SCED_MARKERS[(seriesIndex.get(key) ?? 0) % SCED_MARKERS.length];
  /** Every point in a panel, across its series — the phase structure is a property of
   * the panel's sessions, not of any one measure. */
  const allPointsOf = (p) => scedSeriesOf(p).flatMap((s) => s.points || []);

  let runsPer = panels.map((p) => scedRuns(allPointsOf(p)));

  // Tier order. A multiple-baseline figure is conventionally ordered by WHEN the
  // intervention arrived, earliest at the top — that is what makes the boundaries
  // descend left-to-right and read as a rollout. Left in data order (often
  // alphabetical) the same correct data draws a staircase running backwards, which
  // looks like a mistake and buries the design's argument. Sorting is stable, and
  // panels that never change phase keep their place at the end.
  if ((view.panelOrder || 'stagger') === 'stagger') {
    const firstBoundary = (runs) => (runs.length > 1
      ? (runs[0].points[runs[0].points.length - 1].x + runs[1].points[0].x) / 2
      : Infinity);
    const order = panels.map((p, i) => ({ p, runs: runsPer[i], i, at: firstBoundary(runsPer[i]) }))
      .sort((a, b) => (a.at - b.at) || (a.i - b.i));
    panels = order.map((o) => o.p);
    runsPer = order.map((o) => o.runs);
  }

  const allX = [];
  const allY = [];
  for (const runs of runsPer) for (const run of runs) for (const pt of run.points) { allX.push(pt.x); allY.push(pt.y); }
  if (!allX.length) return errorSvg('SCED chart: no cases with plottable data.');

  // The x axis is SHARED — that is what makes the staggered boundaries readable.
  const xMinUser = Number.isFinite(view.xAxisMin);
  const xMaxUser = Number.isFinite(view.xAxisMax);
  const xticks = niceTicks(xMinUser ? view.xAxisMin : Math.min(...allX),
    xMaxUser ? view.xAxisMax : Math.max(...allX), 7);
  const xMin = xMinUser ? view.xAxisMin : xticks[0];
  const xMax = xMaxUser ? view.xAxisMax : xticks[xticks.length - 1];

  const chartTitle = view.titleText || model.title;
  const xTitle = view.xAxisTitle || model.axes?.x?.title;
  const yTitle = view.yAxisTitle || model.axes?.y?.title;

  const panelH = Math.max(70, view.panelHeight || 130);
  const gap = 24;              // between a panel's baseline and the next panel's top
  const mTop = chartTitle ? 34 : 14;
  // A phase legend is colour-only, so mono kills it (phase is spatial then). A MEASURE
  // legend survives mono, because the markers still differ — that is the whole reason
  // measures are encoded by marker rather than colour.
  const showLegend = multiSeries ? seriesKeys.length > 1 : (!view.mono && phaseList.length > 1);
  const legendRow = view.legend === 'bottom' && showLegend ? 34 : 0;
  const mBottom = 34 + (xTitle ? 18 : 0) + legendRow;
  const legendRight = view.legend === 'right' && showLegend;
  const mRight = legendRight
    ? Math.min(200, Math.max(70, Math.max(...phaseList.map((p) => (p.label || p.key).length)) * 7 + 28))
    : 20;
  // Row labels. Published SCED figures stack TWO rotated captions to the left of the y
  // axis — outer: the antecedent the behaviour is scored against ("Newcomer's Arrival"),
  // inner: the behaviour itself ("Acknowledging and Complimenting Others"). Both need
  // word wrapping: a panel is ~130px tall and those captions do not fit on one line, so
  // clipping them to the panel height (the first attempt) truncated every real label.
  const caseLabelAt = view.caseLabel || (panels.length > 1 ? 'axis' : 'panel');
  const LAB_SIZE = 10;
  const labWidth = Math.max(1, Math.floor((panelH - 6) / (LAB_SIZE * 0.56))); // chars per line
  const contextLines = panels.map((p) => (p.context ? wrapLabel(p.context, labWidth, 3) : []));
  const caseLines = panels.map((p) => (caseLabelAt === 'axis'
    ? wrapLabel(p.label || p.key, labWidth, 3) : []));
  const gutterFor = (lineSets) => {
    const n = Math.max(0, ...lineSets.map((l) => l.length));
    return n ? n * (LAB_SIZE * 1.15) + 6 : 0;
  };
  const yTitleW = yTitle ? 18 : 0;
  const contextGutter = gutterFor(contextLines);
  const caseGutter = gutterFor(caseLines);
  const mLeft = 54 + yTitleW + contextGutter + caseGutter;
  const topPad = view.phaseLabels === 'none' ? 0 : 14;
  const totalH = mTop + topPad + panels.length * (panelH + gap) - gap + mBottom;

  const xScale = (x) => mLeft + ((x - xMin) / (xMax - xMin || 1)) * ((W - mRight) - mLeft);

  const out = [svgOpenH(totalH, chartAltText(model, view, `${panels.length} ${panels.length === 1 ? "case" : "cases"}, ${multiSeries ? seriesKeys.length + " measures" : phaseList.length + " phases"}.`))];
  if (chartTitle) {
    out.push(text(W / 2, 21, esc(chartTitle), {
      size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400,
      italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
    }));
  }

  // Shared Y domain (default) — panels are only comparable when the scale is.
  const yMinUser = Number.isFinite(view.yAxisMin);
  const yMaxUser = Number.isFinite(view.yAxisMax);
  const nyTicks = Math.max(2, view.yTickCount || 5);
  const sharedTicks = niceTicks(yMinUser ? view.yAxisMin : Math.min(...allY),
    yMaxUser ? view.yAxisMax : Math.max(...allY), nyTicks);

  // Phase-line ink. Solid by default (the JABA convention); the boundary is structural
  // information, so it is drawn darker and heavier than a gridline.
  const PHASE_INK = '#222222';
  const PHASE_W = 1.2;
  const phaseDash = (view.phaseLineStyle || 'solid') === 'dashed' ? ' stroke-dasharray="4 3"' : '';
  const staircaseOn = view.phaseLines !== false && !!view.staircase && panels.length > 1;
  /** x of the boundary AFTER run `i` — midway between the adjacent sessions. */
  const boundaryAt = (runs, i) =>
    (runs[i].points[runs[i].points.length - 1].x + runs[i + 1].points[0].x) / 2;
  const panelTop = (pi) => mTop + topPad + pi * (panelH + gap);
  const panelBottom = (pi) => panelTop(pi) + panelH;

  panels.forEach((panel, pi) => {
    const runs = runsPer[pi];
    const y1 = panelTop(pi);                           // panel top
    const y0 = y1 + panelH;                            // panel baseline
    const ys = runs.flatMap((run) => run.points.map((p) => p.y));
    const yticks = view.sharedY === false
      ? niceTicks(yMinUser ? view.yAxisMin : Math.min(...ys), yMaxUser ? view.yAxisMax : Math.max(...ys), nyTicks)
      : sharedTicks;
    const yLo = yticks[0];
    const yHi = yticks[yticks.length - 1];
    const yScale = (y) => y0 - ((y - yLo) / (yHi - yLo || 1)) * (y0 - y1);

    for (const t of yticks) {
      const y = yScale(t);
      if (view.gridlines) out.push(`<line x1="${r(mLeft)}" y1="${r(y)}" x2="${r(W - mRight)}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
      out.push(`<line x1="${r(mLeft - 5)}" y1="${r(y)}" x2="${r(mLeft)}" y2="${r(y)}" stroke="${AXIS}" stroke-width="1"/>`);
      out.push(text(mLeft - 8, y + 4, fmtNum(t), { size: 10.5, anchor: 'end', fill: AXIS }));
    }
    out.push(`<line x1="${r(mLeft)}" y1="${r(y1)}" x2="${r(mLeft)}" y2="${r(y0)}" stroke="${AXIS}" stroke-width="1"/>`);
    out.push(`<line x1="${r(mLeft)}" y1="${r(y0)}" x2="${r(W - mRight)}" y2="${r(y0)}" stroke="${AXIS}" stroke-width="1"/>`);

    const isLast = pi === panels.length - 1;
    for (const t of xticks) {
      const x = xScale(t);
      if (x < mLeft - 0.5 || x > W - mRight + 0.5) continue;
      out.push(`<line x1="${r(x)}" y1="${r(y0)}" x2="${r(x)}" y2="${r(y0 + 4)}" stroke="${AXIS}" stroke-width="1"/>`);
      if (isLast) out.push(text(x, y0 + 17, fmtNum(t), { size: 11, anchor: 'middle', fill: AXIS }));
    }

    // Phase-change lines sit BETWEEN the adjacent sessions, not on a data point.
    // With the staircase on, this panel's FIRST boundary belongs to the connected path
    // drawn after the loop; any further boundaries (an ABAB reversal) stay local.
    if (view.phaseLines !== false) {
      const skipFirst = staircaseOn ? 1 : 0;
      for (let i = skipFirst; i < runs.length - 1; i++) {
        const bx = xScale(boundaryAt(runs, i));
        out.push(`<line x1="${r(bx)}" y1="${r(y1 - 2)}" x2="${r(bx)}" y2="${r(y0)}" stroke="${PHASE_INK}" stroke-width="${PHASE_W}"${phaseDash}/>`);
      }
    }

    // Condition labels, centred over each run's span.
    if (view.phaseLabels === 'all' || (view.phaseLabels !== 'none' && pi === 0)) {
      runs.forEach((run, ri) => {
        const first = run.points[0].x;
        const last = run.points[run.points.length - 1].x;
        const prev = ri > 0 ? runs[ri - 1].points[runs[ri - 1].points.length - 1].x : null;
        const next = ri < runs.length - 1 ? runs[ri + 1].points[0].x : null;
        const lo = prev === null ? xScale(first) : xScale((prev + first) / 2);
        const hi = next === null ? xScale(last) : xScale((last + next) / 2);
        out.push(text((lo + hi) / 2, y1 - 5, esc(clip(phaseLabel.get(run.phase) || run.phase, 22)),
          { size: 11, anchor: 'middle', fill: '#333', weight: 600 }));
      });
    }

    // Data. Lines are drawn per RUN so no segment spans a phase change, and each
    // measure is drawn independently — a panel may carry one measure or several.
    const drawLine = view.mark !== 'points';
    const drawPts = view.mark !== 'line';
    const rad = Math.max(1.5, view.pointSize || 3.5);
    for (const s of scedSeriesOf(panel)) {
      const sRuns = multiSeries ? scedRuns(s.points || []) : runs;
      const ink = multiSeries ? colorOfSeries(s.key) : null;
      if (drawLine) {
        const segments = view.connectAcross
          ? [sRuns.flatMap((run) => run.points)]
          : sRuns.map((run) => run.points);
        segments.forEach((seg, si) => {
          if (seg.length < 2) return;
          const d = seg.map((p) => `${r(xScale(p.x))},${r(yScale(p.y))}`).join(' ');
          const stroke = ink ?? (view.connectAcross ? '#555' : colorOfPhase(sRuns[si].phase));
          out.push(`<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="1.6"/>`);
        });
      }
      if (drawPts) {
        const shape = multiSeries ? markerOfSeries(s.key) : null;
        for (const run of sRuns) {
          const fill = ink ?? colorOfPhase(run.phase);
          for (const p of run.points) {
            out.push(shape
              ? markerSvg(shape, xScale(p.x), yScale(p.y), rad, fill)
              : `<circle cx="${r(xScale(p.x))}" cy="${r(yScale(p.y))}" r="${rad}" fill="${fill}" stroke="#ffffff" stroke-width="0.8"/>`);
          }
        }
      }
    }

    // Row captions. Either stacked as two rotated gutters left of the axis (the
    // published convention) or the compact in-panel name.
    const midY = (y1 + y0) / 2;
    if (contextLines[pi].length) {
      out.push(rotatedLabel(yTitleW + contextGutter / 2, midY, contextLines[pi]));
    }
    if (caseLabelAt === 'axis' && caseLines[pi].length) {
      out.push(rotatedLabel(yTitleW + contextGutter + caseGutter / 2, midY, caseLines[pi], { weight: 600 }));
    } else if (caseLabelAt !== 'none' && caseLabelAt !== 'axis') {
      // Inside the panel so it stays with its data when panels are tall.
      out.push(text(W - mRight - 6, y1 + 13, esc(clip(panel.label || panel.key, 28)),
        { size: 11.5, anchor: 'end', fill: '#333', weight: 600 }));
    }
  });

  // The staircase: one connected step-path through every panel's first boundary.
  // Down through a panel, right across the inter-panel gap, down through the next —
  // so the rollout reads as a single sequence rather than five unrelated verticals.
  if (staircaseOn) {
    const steps = [];
    panels.forEach((_, pi) => {
      if (runsPer[pi].length > 1) steps.push({ pi, x: xScale(boundaryAt(runsPer[pi], 0)) });
    });
    if (steps.length) {
      const pts = [];
      pts.push([steps[0].x, panelTop(steps[0].pi)]);
      for (let i = 0; i < steps.length; i++) {
        const last = i === steps.length - 1;
        // Down through this panel — to its baseline, or into the gap if more follow.
        const yEnd = last ? panelBottom(steps[i].pi) : panelBottom(steps[i].pi) + gap / 2;
        pts.push([steps[i].x, yEnd]);
        if (!last) pts.push([steps[i + 1].x, yEnd]); // across the gap to the next riser
      }
      out.push(`<polyline points="${pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' ')}" fill="none" stroke="${PHASE_INK}" stroke-width="${PHASE_W}"${phaseDash}/>`);
    }
  }

  const lastBaseline = mTop + topPad + panels.length * (panelH + gap) - gap;
  if (xTitle) {
    const s = view.xAxisTitleSize || 12;
    const w = view.xAxisTitleBold ? ' font-weight="600"' : '';
    const it = view.xAxisTitleItalic ? ' font-style="italic"' : '';
    out.push(`<text x="${r((mLeft + (W - mRight)) / 2)}" y="${r(lastBaseline + 34)}" font-size="${s}" fill="#333" text-anchor="middle"${w}${it}>${esc(xTitle)}</text>`);
  }
  if (yTitle) {
    const s = view.yAxisTitleSize || 12;
    const w = view.yAxisTitleBold ? ' font-weight="600"' : '';
    const it = view.yAxisTitleItalic ? ' font-style="italic"' : '';
    const my = (mTop + topPad + lastBaseline) / 2;
    out.push(`<text x="14" y="${r(my)}" font-size="${s}" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})"${w}${it}>${esc(yTitle)}</text>`);
  }

  if (showLegend) {
    const box = { x0: mLeft, x1: W - mRight, y0: lastBaseline + (xTitle ? 18 : 0), y1: mTop + topPad };
    if (multiSeries) {
      out.push(markerLegend(seriesKeys.map((s) => ({
        label: s.label || s.key, color: colorOfSeries(s.key), shape: markerOfSeries(s.key),
      })), view.legend, box));
    } else {
      const items = phaseList.map((p, i) => ({ label: p.label || p.key, color: colorFor(view, p.key, i) }));
      out.push(legendBlock(items, view.legend, box));
    }
  }

  out.push('</svg>');
  return out.join('');
}

// =============================================================================
// Shared frame for distribution kinds (violin / dots / paired)
// =============================================================================

/**
 * The scaffolding every "categories along x, numbers up y" chart needs: margins,
 * a nice y domain, gridlines, axes, titles. Extracted because violin, dots and
 * paired are the same picture with a different mark in each band — writing it three
 * times would have been three chances to drift.
 *
 * Returns the open SVG buffer plus the geometry a kind needs to draw into it.
 */
function bandFrame(model, view, { allValues, bands, legendItems = [], alt = plural(bands, 'group') + '.' }) {
  const title = view.titleText || model.title;
  const xTitle = view.xAxisTitle || model.axes?.x?.title;
  const yTitle = view.yAxisTitle || model.axes?.y?.title;

  const yMinUser = Number.isFinite(view.yAxisMin);
  const yMaxUser = Number.isFinite(view.yAxisMax);
  const lo = yMinUser ? view.yAxisMin : Math.min(...allValues);
  const hi = yMaxUser ? view.yAxisMax : Math.max(...allValues);
  const yticks = niceTicks(lo, hi, view.yTickCount || 6);
  const yLo = yMinUser ? view.yAxisMin : yticks[0];
  const yHi = yMaxUser ? view.yAxisMax : yticks[yticks.length - 1];

  const showLegend = view.legend !== 'none' && legendItems.length > 1;
  const mRight = showLegend && view.legend === 'right'
    ? Math.min(200, Math.max(70, Math.max(...legendItems.map((i) => i.label.length)) * 7 + 28))
    : 20;
  const mTop = title ? 34 : 16;
  const mBottom = 46 + (xTitle ? 16 : 0) + (showLegend && view.legend === 'bottom' ? 26 : 0);
  const mLeft = 56 + (yTitle ? 16 : 0);
  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };
  const yScale = (v) => box.y0 - ((v - yLo) / (yHi - yLo || 1)) * (box.y0 - box.y1);
  const band = (box.x1 - box.x0) / Math.max(1, bands);
  const centre = (i) => box.x0 + band * (i + 0.5);

  const out = [svgOpen(chartAltText(model, view, alt))];
  if (title) {
    out.push(text(W / 2, 21, esc(title), {
      size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400,
      italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
    }));
  }
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
    if (showLegend) out.push(legendBlock(legendItems, view.legend, box));
    out.push('</svg>');
    return out.join('');
  };

  return { out, box, yScale, band, centre, close, yLo, yHi };
}

/** "1 group" / "2 groups" — alt text is read aloud, so the plural has to be right. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Summary statistics a distribution mark draws: median, quartiles, whiskers, mean. */
function fiveNumber(values) {
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
function kde(values, steps = 48) {
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
function jitterFor(i, n) {
  if (n <= 1) return 0;
  // Golden-ratio low-discrepancy sequence: even spread, no clumping, no RNG.
  return ((i * 0.6180339887) % 1) * 2 - 1;
}

/** Replicate keys present across a model's groups, in order of first appearance. */
function replicateKeys(model) {
  const out = [];
  for (const g of model.groups || []) {
    for (const rep of g.reps || []) if (rep != null && !out.includes(String(rep))) out.push(String(rep));
  }
  return out;
}

/** Controls shared by the two distribution kinds (violin / dots). */
function distributionControls(model) {
  const reps = replicateKeys(model);
  return [
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => v.showPoints !== false, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style',
      get: (v) => v.pointSize || 3, set: (v, x) => { v.pointSize = Number(x) || undefined; },
      visible: (v) => v.showPoints !== false,
    },
    {
      id: 'summary', label: 'Summary', type: 'select', group: 'Chart',
      options: [['median', 'Median + quartiles'], ['mean', 'Mean + SD'], ['none', 'None']],
      get: (v) => v.summary || 'median', set: (v, x) => { v.summary = x; },
    },
    {
      // The SuperPlot convention (Lord et al. 2020): colour points by biological
      // replicate and mark each replicate's MEAN, so the reader sees that the effect
      // reproduces across experiments rather than across pooled cells.
      id: 'replicateMeans', label: 'Replicate means', type: 'check', group: 'Chart',
      get: (v) => v.replicateMeans !== false, set: (v, x) => { v.replicateMeans = x; },
      visible: () => reps.length > 1,
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ];
}

/** Points + summary marks, shared by violin and dots. */
function drawDistributionMarks(out, { model, view, groups, centre, yScale, band, colourOf }) {
  const reps = replicateKeys(model);
  const rad = Math.max(1.5, view.pointSize || 3);
  const half = band * 0.32;

  groups.forEach((g, gi) => {
    const cx = centre(gi);
    const values = (g.values || []).filter(Number.isFinite);
    if (!values.length) return;

    if (view.showPoints !== false) {
      values.forEach((v, i) => {
        const x = cx + jitterFor(i, values.length) * half * 0.8;
        const rep = g.reps?.[i] != null ? String(g.reps[i]) : null;
        const fill = rep && reps.length > 1
          ? colorFor(view, rep, reps.indexOf(rep))
          : colourOf(g, gi);
        out.push(`<circle cx="${r(x)}" cy="${r(yScale(v))}" r="${rad}" fill="${fill}" fill-opacity="0.75" stroke="#ffffff" stroke-width="0.6"/>`);
      });
    }

    // Replicate means: one large marker per replicate (the SuperPlot payload).
    if (reps.length > 1 && view.replicateMeans !== false && g.reps) {
      const byRep = new Map();
      values.forEach((v, i) => {
        const k = String(g.reps[i]);
        if (!byRep.has(k)) byRep.set(k, []);
        byRep.get(k).push(v);
      });
      for (const [k, vs] of byRep) {
        const m = vs.reduce((a, b) => a + b, 0) / vs.length;
        out.push(`<circle cx="${r(cx)}" cy="${r(yScale(m))}" r="${r(rad * 2.1)}" fill="${colorFor(view, k, reps.indexOf(k))}" stroke="#222222" stroke-width="1.2"/>`);
      }
    }

    const s = fiveNumber(values);
    const mode = view.summary || 'median';
    if (mode === 'none') return;
    if (mode === 'median') {
      out.push(`<line x1="${r(cx - half)}" y1="${r(yScale(s.median))}" x2="${r(cx + half)}" y2="${r(yScale(s.median))}" stroke="#222222" stroke-width="2"/>`);
      for (const q of [s.q1, s.q3]) {
        out.push(`<line x1="${r(cx - half * 0.55)}" y1="${r(yScale(q))}" x2="${r(cx + half * 0.55)}" y2="${r(yScale(q))}" stroke="#222222" stroke-width="1"/>`);
      }
    } else {
      const sd = Math.sqrt(values.reduce((a, x) => a + (x - s.mean) ** 2, 0) / Math.max(1, values.length - 1));
      out.push(`<line x1="${r(cx - half)}" y1="${r(yScale(s.mean))}" x2="${r(cx + half)}" y2="${r(yScale(s.mean))}" stroke="#222222" stroke-width="2"/>`);
      out.push(`<line x1="${r(cx)}" y1="${r(yScale(s.mean - sd))}" x2="${r(cx)}" y2="${r(yScale(s.mean + sd))}" stroke="#222222" stroke-width="1"/>`);
      for (const e of [s.mean - sd, s.mean + sd]) {
        out.push(`<line x1="${r(cx - half * 0.4)}" y1="${r(yScale(e))}" x2="${r(cx + half * 0.4)}" y2="${r(yScale(e))}" stroke="#222222" stroke-width="1"/>`);
      }
    }
  });
}

/** Legend items: replicates when present (SuperPlot), else the groups themselves. */
function distributionLegend(model, view) {
  const reps = replicateKeys(model);
  if (reps.length > 1) return reps.map((k, i) => ({ label: k, color: colorFor(view, k, i) }));
  const groups = ordered(model.groups || [], view.seriesOrder);
  return groups.length > 1
    ? groups.map((g, i) => ({ label: g.label || g.key, color: colorFor(view, g.key, i) }))
    : [];
}

// =============================================================================
// KIND: violin (distribution shape + optional points/replicates)
// =============================================================================

registerChartKind('violin', {
  colorLabel: (model) => (replicateKeys(model).length > 1 ? 'Replicates' : 'Groups'),
  reorderCategories: false,
  colorItems: (model) => {
    const reps = replicateKeys(model);
    return reps.length > 1
      ? reps.map((k) => ({ key: k, label: k }))
      : (model.groups || []).map((g) => ({ key: g.key, label: g.label || g.key }));
  },
  baseView: (model) => ({
    showPoints: (model.groups || []).every((g) => (g.values || []).length <= 60),
    summary: 'median',
    violinWidth: 0.8,
    legend: replicateKeys(model).length > 1 ? 'right' : 'none',
  }),
  controls: (model) => [
    {
      id: 'violinWidth', label: 'Violin width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart',
      get: (v) => v.violinWidth ?? 0.8, set: (v, x) => { v.violinWidth = Number(x) || undefined; },
    },
    ...distributionControls(model),
  ],
  render: (model, view) => {
    const groups = ordered(model.groups || [], view.seriesOrder)
      .filter((g) => (g.values || []).some(Number.isFinite));
    if (!groups.length) return errorSvg('Violin plot: no numeric values to plot.');
    const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
    const f = bandFrame(model, view, {
      allValues, bands: groups.length, legendItems: distributionLegend(model, view),
      alt: `${plural(groups.length, 'group')}, ${plural(allValues.length, 'observation')}.`,
    });
    const colourOf = (g, i) => colorFor(view, g.key, i);
    const half = f.band * 0.32 * ((view.violinWidth ?? 0.8) / 0.8);

    groups.forEach((g, gi) => {
      const values = g.values.filter(Number.isFinite);
      const cx = f.centre(gi);
      if (values.length < 2) return; // a density from one point is meaningless
      const dens = kde(values);
      const left = dens.map((p) => `${r(cx - p.w * half)},${r(f.yScale(p.v))}`);
      const right = dens.slice().reverse().map((p) => `${r(cx + p.w * half)},${r(f.yScale(p.v))}`);
      f.out.push(`<polygon points="${left.concat(right).join(' ')}" fill="${colourOf(g, gi)}" fill-opacity="0.28" stroke="${colourOf(g, gi)}" stroke-width="1.2"/>`);
    });

    drawDistributionMarks(f.out, { model, view, groups, centre: f.centre, yScale: f.yScale, band: f.band, colourOf });
    return f.close(groups.map((g) => g.label || g.key));
  },
});

// =============================================================================
// KIND: dots (column scatter — every observation, jittered)
// =============================================================================

registerChartKind('dots', {
  colorLabel: (model) => (replicateKeys(model).length > 1 ? 'Replicates' : 'Groups'),
  reorderCategories: false,
  colorItems: (model) => {
    const reps = replicateKeys(model);
    return reps.length > 1
      ? reps.map((k) => ({ key: k, label: k }))
      : (model.groups || []).map((g) => ({ key: g.key, label: g.label || g.key }));
  },
  baseView: (model) => ({
    showPoints: true,
    summary: 'median',
    legend: replicateKeys(model).length > 1 ? 'right' : 'none',
  }),
  controls: (model) => distributionControls(model),
  render: (model, view) => {
    const groups = ordered(model.groups || [], view.seriesOrder)
      .filter((g) => (g.values || []).some(Number.isFinite));
    if (!groups.length) return errorSvg('Dot plot: no numeric values to plot.');
    const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
    const f = bandFrame(model, view, {
      allValues, bands: groups.length, legendItems: distributionLegend(model, view),
      alt: `${plural(groups.length, 'group')}, ${plural(allValues.length, 'observation')}.`,
    });
    drawDistributionMarks(f.out, {
      model, view, groups, centre: f.centre, yScale: f.yScale, band: f.band,
      colourOf: (g, i) => colorFor(view, g.key, i),
    });
    return f.close(groups.map((g) => g.label || g.key));
  },
});

// =============================================================================
// KIND: paired (before-after — one line per subject across conditions)
// =============================================================================

registerChartKind('paired', {
  colorLabel: 'Direction',
  reorderCategories: false,
  colorItems: (model, view) => {
    const mode = view?.colourBy || 'direction';
    if (mode === 'subject') return (model.subjects || []).map((s) => ({ key: s.key, label: s.label || s.key }));
    return [{ key: '__up__', label: 'Increase' }, { key: '__down__', label: 'Decrease' }];
  },
  baseView: () => ({ colourBy: 'direction', showPoints: true, summary: 'mean', legend: 'bottom' }),
  controls: (model) => [
    {
      id: 'colourBy', label: 'Colour lines by', type: 'select', structural: true, group: 'Chart',
      options: [['direction', 'Direction of change'], ['subject', 'Subject'], ['none', 'One colour']],
      get: (v) => v.colourBy || 'direction', set: (v, x) => { v.colourBy = x; },
    },
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => v.showPoints !== false, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'summary', label: 'Group summary', type: 'select', group: 'Chart',
      options: [['mean', 'Mean per condition'], ['none', 'None']],
      get: (v) => v.summary || 'mean', set: (v, x) => { v.summary = x; },
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => {
    const conds = model.conditions || [];
    const subjects = (model.subjects || []).filter((s) => (s.values || []).some(Number.isFinite));
    if (conds.length < 2 || !subjects.length) {
      return errorSvg('Before-after plot: needs at least two conditions and one subject.');
    }
    const allValues = subjects.flatMap((s) => s.values.filter(Number.isFinite));
    const mode = view.colourBy || 'direction';
    const legendItems = mode === 'none' ? []
      : getChartKind('paired').colorItems(model, view).map((it, i) => ({
        label: it.label, color: colorFor(view, it.key, i),
      }));
    const f = bandFrame(model, view, { allValues, bands: conds.length, legendItems,
      alt: `${plural(subjects.length, 'subject')} across ${plural(conds.length, 'condition')}.` });

    subjects.forEach((s, si) => {
      const pts = s.values.map((v, i) => (Number.isFinite(v) ? { x: f.centre(i), y: f.yScale(v) } : null));
      const first = s.values.find(Number.isFinite);
      const last = [...s.values].reverse().find(Number.isFinite);
      let stroke;
      if (mode === 'subject') stroke = colorFor(view, s.key, si);
      else if (mode === 'direction') {
        const up = (last ?? 0) >= (first ?? 0);
        stroke = colorFor(view, up ? '__up__' : '__down__', up ? 0 : 1);
      } else stroke = '#5a6470';
      const d = pts.filter(Boolean).map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
      f.out.push(`<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="1.3" stroke-opacity="0.75"/>`);
      if (view.showPoints !== false) {
        for (const p of pts.filter(Boolean)) {
          f.out.push(`<circle cx="${r(p.x)}" cy="${r(p.y)}" r="3" fill="${stroke}" stroke="#ffffff" stroke-width="0.6"/>`);
        }
      }
    });

    if ((view.summary || 'mean') === 'mean') {
      conds.forEach((c, ci) => {
        const vals = subjects.map((s) => s.values[ci]).filter(Number.isFinite);
        if (!vals.length) return;
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const cx = f.centre(ci);
        const half = f.band * 0.22;
        f.out.push(`<line x1="${r(cx - half)}" y1="${r(f.yScale(m))}" x2="${r(cx + half)}" y2="${r(f.yScale(m))}" stroke="#222222" stroke-width="2.5"/>`);
      });
    }

    return f.close(conds.map((c) => c.label || c.key));
  },
});

// =============================================================================
// KIND: box (Tukey box-and-whisker)
// =============================================================================

/**
 * Whisker ends and outliers under Tukey's rule: whiskers reach the furthest value
 * within 1.5 IQR of the hinges, and anything beyond is drawn individually.
 *
 * Drawn rather than clipped, because an outlier is a fact about the data. A boxplot
 * that silently truncates its own tails is the same category of error as a violin
 * bulging past its range — the mark stops describing the sample it was given.
 */
function boxWhiskers(values) {
  const s = fiveNumber(values);
  const iqr = s.q3 - s.q1;
  const loFence = s.q1 - 1.5 * iqr;
  const hiFence = s.q3 + 1.5 * iqr;
  const inside = values.filter((v) => v >= loFence && v <= hiFence);
  return {
    ...s,
    lo: inside.length ? Math.min(...inside) : s.min,
    hi: inside.length ? Math.max(...inside) : s.max,
    outliers: values.filter((v) => v < loFence || v > hiFence),
  };
}

registerChartKind('box', {
  colorLabel: 'Groups',
  reorderCategories: false,
  colorItems: (model) => (model.groups || []).map((g) => ({ key: g.key, label: g.label || g.key })),
  baseView: (model) => ({
    summary: 'none', // the box IS the summary; the shared marks would double it
    showPoints: false,
    notch: false,
    legend: (model.groups || []).length > 1 ? 'none' : 'none',
  }),
  controls: (model) => [
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => !!v.showPoints, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'showMean', label: 'Mark the mean', type: 'check', group: 'Chart',
      get: (v) => !!v.showMean, set: (v, x) => { v.showMean = x; },
    },
    {
      id: 'boxWidth', label: 'Box width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart',
      get: (v) => v.boxWidth ?? 0.7, set: (v, x) => { v.boxWidth = Number(x) || undefined; },
    },
    {
      id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style',
      get: (v) => v.pointSize || 3, set: (v, x) => { v.pointSize = Number(x) || undefined; },
      visible: (v) => !!v.showPoints,
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => {
    const groups = ordered(model.groups || [], view.seriesOrder)
      .filter((g) => (g.values || []).some(Number.isFinite));
    if (!groups.length) return errorSvg('Boxplot: no numeric values to plot.');
    const stats = groups.map((g) => boxWhiskers(g.values.filter(Number.isFinite)));
    // The y domain must cover the OUTLIERS too, or they are drawn off the canvas.
    const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
    const f = bandFrame(model, view, {
      allValues,
      bands: groups.length,
      legendItems: groups.length > 1 && view.legend !== 'none'
        ? groups.map((g, i) => ({ label: g.label || g.key, color: colorFor(view, g.key, i) })) : [],
      alt: `${plural(groups.length, 'group')}, ${plural(allValues.length, 'observation')}.`,
    });

    const half = f.band * 0.5 * (view.boxWidth ?? 0.7) * 0.9;
    const rad = Math.max(1.5, view.pointSize || 3);

    groups.forEach((g, gi) => {
      const st = stats[gi];
      const cx = f.centre(gi);
      const colour = colorFor(view, g.key, gi);

      // Whiskers, with caps at the furthest non-outlying values.
      f.out.push(`<line x1="${r(cx)}" y1="${r(f.yScale(st.hi))}" x2="${r(cx)}" y2="${r(f.yScale(st.q3))}" stroke="#444" stroke-width="1"/>`);
      f.out.push(`<line x1="${r(cx)}" y1="${r(f.yScale(st.lo))}" x2="${r(cx)}" y2="${r(f.yScale(st.q1))}" stroke="#444" stroke-width="1"/>`);
      for (const e of [st.lo, st.hi]) {
        f.out.push(`<line x1="${r(cx - half * 0.45)}" y1="${r(f.yScale(e))}" x2="${r(cx + half * 0.45)}" y2="${r(f.yScale(e))}" stroke="#444" stroke-width="1"/>`);
      }

      const top = f.yScale(st.q3);
      const bot = f.yScale(st.q1);
      f.out.push(`<rect x="${r(cx - half)}" y="${r(top)}" width="${r(half * 2)}" height="${r(Math.max(1, bot - top))}" fill="${colour}" fill-opacity="0.30" stroke="${colour}" stroke-width="1.4"/>`);
      f.out.push(`<line x1="${r(cx - half)}" y1="${r(f.yScale(st.median))}" x2="${r(cx + half)}" y2="${r(f.yScale(st.median))}" stroke="#222222" stroke-width="2"/>`);

      if (view.showMean) {
        // A cross, so it is distinguishable from the median line in black and white.
        const my = f.yScale(st.mean);
        f.out.push(`<line x1="${r(cx - 5)}" y1="${r(my)}" x2="${r(cx + 5)}" y2="${r(my)}" stroke="#222222" stroke-width="1.2"/>`);
        f.out.push(`<line x1="${r(cx)}" y1="${r(my - 5)}" x2="${r(cx)}" y2="${r(my + 5)}" stroke="#222222" stroke-width="1.2"/>`);
      }

      // Outliers are always drawn; "show data points" adds the rest.
      const shown = view.showPoints ? g.values.filter(Number.isFinite) : st.outliers;
      shown.forEach((v, i) => {
        const isOut = st.outliers.includes(v);
        const x = view.showPoints ? cx + jitterFor(i, shown.length) * half * 0.6 : cx;
        f.out.push(`<circle cx="${r(x)}" cy="${r(f.yScale(v))}" r="${rad}" fill="${isOut ? '#ffffff' : colour}" fill-opacity="${isOut ? 1 : 0.7}" stroke="${colour}" stroke-width="1.1"/>`);
      });
    });

    return f.close(groups.map((g) => g.label || g.key));
  },
});

// =============================================================================
// KIND: wordcloud (single field, or partitioned into labelled themes)
// =============================================================================

/**
 * One kind for both word clouds this app had.
 *
 * builtin-textanalytics drew one field with themes encoded as COLOUR (from a
 * statistical clustering); builtin-caqdas drew a separate labelled sub-cloud per theme
 * (from coding tags). They looked like two chart types, but the difference is layout:
 * the same `{word, count, theme}` tuples arranged one way or the other. So it is one
 * kind with a `layout` control — and each side gains the mode it never had.
 *
 * **Author colours are DATA here, not style.** A CAQDAS code's colour comes from the
 * codebook and appears on every other CAQDAS surface; if the palette control repainted
 * it the cloud would silently disagree with the rest of the app. So a `color` on a word
 * wins over the palette, and the palette control hides itself when colours are supplied.
 * That distinction did not exist in the chart layer before this kind needed it.
 */

/** Do any words carry an author-supplied colour? Then the palette must not override. */
function cloudHasAuthorColours(model) {
  return (model.words || []).some((w) => typeof w.color === 'string' && w.color);
}

/** Distinct themes across the words, in order of first appearance. */
function cloudThemes(model) {
  const out = [];
  for (const w of model.words || []) {
    const k = w.theme == null ? null : String(w.theme);
    if (k != null && !out.some((t) => t.key === k)) {
      out.push({ key: k, label: w.themeName || k });
    }
  }
  return out;
}

/**
 * Archimedean-spiral placement with rectangle collision, from a given origin.
 *
 * Shared by both layouts, which is the point: the two implementations this replaces
 * had separately tuned near-identical spirals, and any future fix would have had to be
 * made twice. Placement is deterministic — no Math.random — because these charts are
 * persisted and re-rendered from the model, and a cloud that reshuffles on every
 * reopen reads as instability rather than as data.
 */
function placeWord(placed, { cx, cy, halfW, halfH, step, bounds, tries = 1400 }) {
  for (let s = 0; s < tries; s++) {
    const ang = 0.5 * s;
    const rad = step * 0.2 * ang;
    const px = cx + rad * Math.cos(ang);
    const py = cy + rad * Math.sin(ang);
    const box = { x0: px - halfW, x1: px + halfW, y0: py - halfH, y1: py + halfH };
    if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
    if (!placed.some((b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) {
      placed.push(box);
      return { x: px, y: py };
    }
  }
  return null; // no room — caller drops the word rather than overlapping
}

registerChartKind('wordcloud', {
  colorLabel: (model) => (cloudThemes(model).length > 1 ? 'Themes' : 'Words'),
  reorderCategories: false,
  colorItems: (model) => {
    const themes = cloudThemes(model);
    return themes.length > 1 ? themes : [{ key: '__words__', label: 'Words' }];
  },
  baseView: (model) => ({
    layout: cloudThemes(model).length > 1 ? 'clustered' : 'single',
    maxWords: 120,
    minSize: 11,
    maxSize: 44,
    legend: 'none',
    gridlines: false,
  }),
  controls: (model) => {
    const themed = cloudThemes(model).length > 1;
    const authored = cloudHasAuthorColours(model);
    return [
      {
        id: 'layout', label: 'Layout', type: 'select', structural: true, group: 'Chart',
        options: [['single', 'One cloud'], ['clustered', 'Grouped by theme']],
        get: (v) => v.layout || 'single', set: (v, x) => { v.layout = x; },
        visible: () => themed,
      },
      {
        id: 'maxWords', label: 'Max words', type: 'number', min: 10, max: 400, step: 10, group: 'Chart',
        get: (v) => v.maxWords || 120, set: (v, x) => { v.maxWords = Number(x) || undefined; },
      },
      {
        id: 'minSize', label: 'Smallest text', type: 'number', min: 6, max: 24, step: 1, group: 'Style',
        get: (v) => v.minSize || 11, set: (v, x) => { v.minSize = Number(x) || undefined; },
      },
      {
        id: 'maxSize', label: 'Largest text', type: 'number', min: 16, max: 90, step: 2, group: 'Style',
        get: (v) => v.maxSize || 44, set: (v, x) => { v.maxSize = Number(x) || undefined; },
      },
      // Hidden when the caller supplied colours: offering a palette that cannot take
      // effect is worse than offering nothing (see the gridlines lesson — a control
      // with no visible effect reads as broken).
      { ...paletteControl(), group: 'Style', visible: (v, m) => !cloudHasAuthorColours(m) && cloudThemes(m).length > 1 },
      { ...legendControl(), group: 'Style', visible: (v, m) => cloudThemes(m).length > 1 },
      ...titleControls(model),
    ].filter(Boolean).concat(authored ? [{
      id: '__authorColours', label: 'Colours come from the data', type: 'check', group: 'Style',
      get: () => true, set: () => {},
      visible: () => true,
    }] : []);
  },
  render: (model, view) => {
    const all = (model.words || []).filter((w) => w && w.word && Number.isFinite(w.count) && w.count > 0);
    if (!all.length) return errorSvg('Word cloud: no words to show.');
    const words = [...all].sort((a, b) => b.count - a.count).slice(0, Math.max(1, view.maxWords || 120));
    const themes = cloudThemes(model);
    const clustered = (view.layout || 'single') === 'clustered' && themes.length > 1;
    const authored = cloudHasAuthorColours(model);

    const title = view.titleText || model.title;
    const mTop = title ? 34 : 8;
    const bounds = { x0: 4, x1: W - 4, y0: mTop, y1: H - 6 };
    const out = [svgOpen(chartAltText(model, view,
      `${plural(words.length, 'word')}${themes.length > 1 ? `, ${plural(themes.length, 'theme')}` : ''}.`))];
    if (title) {
      out.push(text(W / 2, 21, esc(title), {
        size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400,
        italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
      }));
    }

    const counts = words.map((w) => w.count);
    const lo = Math.min(...counts);
    const hi = Math.max(...counts);
    const minPx = view.minSize || 11;
    const maxPx = view.maxSize || 44;
    // sqrt scale: font AREA tracks the count, which is how a reader judges these.
    const sizeOf = (c) => (hi === lo ? (minPx + maxPx) / 2
      : minPx + (maxPx - minPx) * Math.sqrt((c - lo) / (hi - lo)));
    const colourOf = (w) => {
      if (authored && w.color) return w.color;
      if (themes.length > 1 && w.theme != null) {
        const i = themes.findIndex((t) => t.key === String(w.theme));
        return colorFor(view, String(w.theme), i < 0 ? 0 : i);
      }
      return colorFor(view, '__words__', 0);
    };

    const placed = [];
    const emit = (w, at) => {
      const fs = sizeOf(w.count);
      out.push(`<text x="${r(at.x)}" y="${r(at.y)}" font-size="${r(fs)}" fill="${colourOf(w)}" `
        + `text-anchor="middle" dominant-baseline="central"`
        + `${fs >= (minPx + maxPx) / 2 ? ' font-weight="600"' : ''}>`
        + `<title>${esc(w.word)}${w.themeName ? ` — ${esc(w.themeName)}` : ''} (${w.count})</title>`
        + `${esc(w.word)}</text>`);
    };

    if (!clustered) {
      const cx = (bounds.x0 + bounds.x1) / 2;
      const cy = (bounds.y0 + bounds.y1) / 2;
      for (const w of words) {
        const fs = sizeOf(w.count);
        const at = placeWord(placed, {
          cx, cy, halfW: w.word.length * fs * 0.30 + 3, halfH: fs * 0.62,
          step: Math.max(2, fs * 0.22), bounds,
        });
        if (at) emit(w, at);
      }
    } else {
      // A grid of sub-clouds, each with its theme's name above it.
      const cols = Math.ceil(Math.sqrt(themes.length));
      const rows = Math.ceil(themes.length / cols);
      const cellW = (bounds.x1 - bounds.x0) / cols;
      const cellH = (bounds.y1 - bounds.y0) / rows;
      themes.forEach((t, ti) => {
        const cxc = bounds.x0 + cellW * (ti % cols) + cellW / 2;
        const cyc = bounds.y0 + cellH * Math.floor(ti / cols) + cellH / 2;
        const cell = {
          x0: cxc - cellW / 2 + 3, x1: cxc + cellW / 2 - 3,
          y0: cyc - cellH / 2 + 16, y1: cyc + cellH / 2 - 3,
        };
        const labelY = cell.y0 - 5;
        out.push(text(cxc, labelY, esc(clip(t.label, Math.max(8, Math.floor(cellW / 7)))),
          { size: 11.5, anchor: 'middle', fill: '#333', weight: 600 }));
        placed.push({ x0: cxc - cellW / 2, x1: cxc + cellW / 2, y0: labelY - 11, y1: labelY + 4 });
        for (const w of words.filter((x) => String(x.theme) === t.key)) {
          const fs = sizeOf(w.count);
          const at = placeWord(placed, {
            cx: cxc, cy: cyc, halfW: w.word.length * fs * 0.30 + 3, halfH: fs * 0.62,
            step: Math.max(2, fs * 0.18), bounds: cell, tries: 1200,
          });
          if (at) emit(w, at);
        }
      });
    }

    if (view.legend !== 'none' && themes.length > 1 && !authored) {
      out.push(legendBlock(themes.map((t, i) => ({ label: t.label, color: colorFor(view, t.key, i) })),
        view.legend, { x0: bounds.x0, x1: bounds.x1 - 8, y0: bounds.y1, y1: bounds.y0 }));
    }
    out.push('</svg>');
    return out.join('');
  },
});
