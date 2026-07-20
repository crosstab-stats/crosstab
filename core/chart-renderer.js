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
 *
 * @typedef {Object} ControlDescriptor
 * @property {string} id
 * @property {string} label
 * @property {'select'|'check'|'number'} type
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
    colorLabel: kd.colorLabel || 'Series',
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
    id: 'palette', label: 'Palette', type: 'select', structural: true,
    options: () => Object.entries(PALETTES).map(([k, p]) => [k, p.label]),
    get: (v) => v.palette || DEFAULT_PALETTE,
    set: (v, x) => { v.palette = x; },
    visible: (v, m) => colorItemCount(m) > 1,
  };
}

/** Legend placement — only when more than one item is shown. */
export function legendControl() {
  return {
    id: 'legend', label: 'Legend', type: 'select',
    options: [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['none', 'Hidden']],
    get: (v) => v.legend,
    set: (v, x) => { v.legend = x; },
    visible: (v, m) => colorItemCount(m) > 1,
  };
}

/** Value-labels toggle. */
export function valueLabelsControl(label = 'Value labels') {
  return {
    id: 'valueLabels', label, type: 'check',
    get: (v) => !!v.valueLabels,
    set: (v, x) => { v.valueLabels = x; },
  };
}

/** Gridlines toggle. */
export function gridlinesControl() {
  return {
    id: 'gridlines', label: 'Gridlines', type: 'check',
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
    id: 'pointOverlay', label: 'Show data points', type: 'check',
    get: (v) => !!v.pointOverlay,
    set: (v, x) => { v.pointOverlay = x; },
    visible: () => hasRawValues(model),
  };
}

/** Error bars selector (only when raw values are available). */
function errorBarsControl(model) {
  return {
    id: 'errorBars', label: 'Error bars', type: 'select',
    options: [['none', 'None'], ['sem', 'SEM'], ['sd', 'SD'], ['ci95', '95% CI']],
    get: (v) => v.errorBars || 'none',
    set: (v, x) => { v.errorBars = x; },
    visible: () => hasRawValues(model),
  };
}

// --- shared drawing helpers --------------------------------------------------

const W = 720;
const H = 460;
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const AXIS = '#555';
const GRID = '#e6eaee';

function errorSvg(msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 80" font-family="${FONT}"><text x="12" y="44" font-size="13" fill="#b00">${esc(msg)}</text></svg>`;
}

function text(x, y, content, { size = 12, anchor = 'start', fill = '#000', weight } = {}) {
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}>${content}</text>`;
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

function svgOpen() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}"><rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
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
      id: 'mark', label: 'Type', type: 'select', structural: true,
      options: [['bar', 'Bars'], ['line', 'Lines']],
      get: (v) => v.mark || 'bar', set: (v, x) => { v.mark = x; },
    },
    {
      id: 'stack', label: 'Stacking', type: 'select',
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
  const ticks = niceTicks(yMin, yMax, 5);
  yMin = ticks[0];
  yMax = ticks[ticks.length - 1];

  const legendRight = view.legend === 'right' && series.length > 1;
  const longest = Math.max(0, ...series.map((s) => (s.label || s.key).length));
  const mRight = legendRight ? Math.min(220, Math.max(70, longest * 7 + 28)) : 18;
  const mTop = (model.title ? 34 : 14) + (view.legend === 'top' && series.length > 1 ? 22 : 0);
  const rotate = cats.length > 6 || Math.max(0, ...cats.map((c) => (c.label || c.key).length)) > 6;
  const longestX = Math.max(0, ...cats.map((c) => (c.label || c.key).length));
  const mBottom = (rotate ? Math.min(120, 28 + longestX * 6) : 40) + (model.axes?.x?.title ? 16 : 0) + (view.legend === 'bottom' && series.length > 1 ? 22 : 0);
  const mLeft = 56 + (model.axes?.y?.title ? 16 : 0);

  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };
  const plotW = box.x1 - box.x0;
  const plotH = box.y0 - box.y1;
  const yScale = (v) => box.y0 - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const out = [svgOpen()];
  if (model.title) out.push(text(W / 2, 20, esc(model.title), { size: 15, weight: 600, anchor: 'middle', fill: '#222' }));

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

  if (model.axes?.x?.title) out.push(text((box.x0 + box.x1) / 2, H - 4, esc(model.axes.x.title), { size: 12, anchor: 'middle', fill: '#333' }));
  if (model.axes?.y?.title) {
    const my = (box.y0 + box.y1) / 2;
    out.push(`<text x="14" y="${r(my)}" font-size="12" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})">${esc(model.axes.y.title)}</text>`);
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
      if (view.valueLabels && v) out.push(text(x + bw / 2, top - 3, fmtNum(v), { size: 9.5, anchor: 'middle', fill: '#444' }));
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
        out.push(text(x + bw / 2, (yTop + yBot) / 2 + 3, stack === 'percent' ? `${Math.round(v)}%` : fmtNum(v), { size: 9.5, anchor: 'middle', fill: '#fff', weight: 600 }));
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
      if (view.valueLabels) out.push(text(cx, cy - 7, fmtNum(valueAt(series[si], ci)), { size: 9.5, anchor: 'middle', fill: '#444' }));
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
      ? [{ id: 'trendLine', label: 'Trend line', type: 'check', get: (v) => !!v.trendLine, set: (v, x) => { v.trendLine = x; } }]
      : []),
    {
      id: 'pointSize', label: 'Point size', type: 'select',
      options: [['3', 'Small'], ['4', 'Medium'], ['6', 'Large']],
      get: (v) => String(v.pointSize || 4), set: (v, x) => { v.pointSize = Number(x); },
    },
    gridlinesControl(),
    paletteControl(),
    legendControl(),
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
  const xticks = niceTicks(Math.min(...xs, xMin), Math.max(...xs, xMax), 6);
  const yticks = niceTicks(Math.min(...ys, yMin), Math.max(...ys, yMax), 5);
  xMin = xticks[0]; xMax = xticks[xticks.length - 1];
  yMin = yticks[0]; yMax = yticks[yticks.length - 1];

  const legendRight = view.legend === 'right' && groups && groups.length > 1;
  const mRight = legendRight ? Math.min(200, Math.max(70, Math.max(...groups.map((g) => (g.label || g.key).length)) * 7 + 28)) : 18;
  const mTop = model.title ? 34 : 16;
  const mBottom = 42 + (model.axes?.x?.title ? 16 : 0);
  const mLeft = 56 + (model.axes?.y?.title ? 16 : 0);
  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };
  const xScale = (x) => box.x0 + ((x - xMin) / (xMax - xMin || 1)) * (box.x1 - box.x0);
  const yScale = (y) => box.y0 - ((y - yMin) / (yMax - yMin || 1)) * (box.y0 - box.y1);

  const out = [svgOpen()];
  if (model.title) out.push(text(W / 2, 20, esc(model.title), { size: 15, weight: 600, anchor: 'middle', fill: '#222' }));

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

  if (model.axes?.x?.title) out.push(text((box.x0 + box.x1) / 2, H - 4, esc(model.axes.x.title), { size: 12, anchor: 'middle', fill: '#333' }));
  if (model.axes?.y?.title) {
    const my = (box.y0 + box.y1) / 2;
    out.push(`<text x="14" y="${r(my)}" font-size="12" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r(my)})">${esc(model.axes.y.title)}</text>`);
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
      id: 'pieRotation', label: 'Rotate (°)', type: 'number', min: 0, max: 360, step: 15,
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

  const out = [svgOpen()];
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
