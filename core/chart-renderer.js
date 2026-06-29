/**
 * @file chart-renderer.js
 * Host-side, data-driven chart renderer — the other half of the plotting model.
 *
 * The legacy path (`results.appendPlot`) takes a finished SVG baked in R: by the
 * time the host sees it, it's a picture, so colours, ordering, stacking and the
 * legend can't be changed without re-running R. This module instead renders a
 * **structured chart model** (categories + series + values) to SVG in plain JS,
 * so a chart can be re-ordered, recoloured and re-stacked *instantly* with no
 * WebR round-trip. (The word cloud already proved this R-computes-data /
 * JS-renders-SVG split works here.)
 *
 * A plugin emits a {@link ChartModel}; the host stores it, picks a {@link ViewState}
 * (the editable, persisted display options), and calls {@link renderChart} to get
 * an `<svg>` string. The control strip in results-pane.js mutates the ViewState and
 * re-renders — the model itself never changes.
 *
 * Pure module: no DOM, no app deps. `renderChart` returns a string. Text from the
 * model is escaped for SVG; callers still sanitise the result before insertion.
 *
 * @typedef {Object} ChartModel
 * @property {'categorical'|'scatter'|'pie'} kind
 * @property {string} [title]
 * @property {{key:string,label:string}[]} [categories] - x items (categorical), in the plugin's natural order.
 * @property {{key:string,label:string,values:(number|null)[]}[]} [series] - one per series; values align to categories.
 * @property {{x:{title?:string},y:{title?:string}}} [axes]
 * @property {Partial<ViewState>} [view] - plugin-suggested display defaults.
 *
 * @typedef {Object} ViewState
 * @property {'bar'|'line'} mark - categorical: bars or lines.
 * @property {'none'|'stacked'|'percent'} stack - grouped, stacked, or 100%-stacked (bars only).
 * @property {string[]} seriesOrder - series keys, in draw/legend order.
 * @property {string[]} categoryOrder - category keys, in axis order.
 * @property {Object<string,string>} colors - per-series colour overrides (key → #hex); absent → palette.
 * @property {string} palette - palette id (see {@link PALETTES}).
 * @property {'right'|'top'|'bottom'|'none'} legend - legend placement.
 * @property {boolean} valueLabels - draw the numeric value on each bar/point.
 * @property {number} pieRotation - pie only: start-angle offset in degrees.
 */

/**
 * Named colour palettes. The default is **Okabe-Ito**, the de-facto colourblind-
 * safe qualitative palette (distinguishable under the common dichromacies) — the
 * fix for the "colours are hard to see / hard to tell apart" complaint. Each is a
 * flat list; series i takes `palette[i % palette.length]`.
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

/** Resolve the colour for series `key` at draw-index `i`: explicit override wins,
 * else the active palette cycled by position. */
export function colorFor(view, key, i) {
  if (view.colors && view.colors[key]) return view.colors[key];
  const pal = (PALETTES[view.palette] || PALETTES[DEFAULT_PALETTE]).colors;
  return pal[i % pal.length];
}

/**
 * Build the initial {@link ViewState} for a model: sensible defaults, overlaid with
 * whatever `model.view` the plugin suggested, with series/category order seeded from
 * the model's natural order. Pure — returns a fresh object.
 * @param {ChartModel} model
 * @returns {ViewState}
 */
export function defaultView(model) {
  const seriesOrder = (model.series || []).map((s) => s.key);
  const categoryOrder = (model.categories || []).map((c) => c.key);
  const base = {
    mark: 'bar',
    stack: 'none',
    seriesOrder,
    categoryOrder,
    colors: {},
    palette: DEFAULT_PALETTE,
    legend: (model.series || []).length > 1 ? 'right' : 'none',
    valueLabels: false,
    pieRotation: 0,
  };
  const v = { ...base, ...(model.view || {}) };
  // Never let a plugin-supplied partial order drop or duplicate keys: reconcile
  // against the model so the renderer always has a complete, valid order.
  v.seriesOrder = reconcileOrder(v.seriesOrder, seriesOrder);
  v.categoryOrder = reconcileOrder(v.categoryOrder, categoryOrder);
  v.colors = { ...(model.view?.colors || {}) };
  return v;
}

/** Keep `wanted`'s order for keys that exist, then append any model keys it missed;
 * drop unknown keys. Guarantees a permutation of `all`. */
function reconcileOrder(wanted, all) {
  const set = new Set(all);
  const seen = new Set();
  const out = [];
  for (const k of wanted || []) if (set.has(k) && !seen.has(k)) { out.push(k); seen.add(k); }
  for (const k of all) if (!seen.has(k)) out.push(k);
  return out;
}

/**
 * Render a chart model + view to an `<svg>` string (responsive via viewBox).
 * @param {ChartModel} model
 * @param {ViewState} view
 * @returns {string}
 */
export function renderChart(model, view) {
  switch (model.kind) {
    case 'categorical':
      return renderCategorical(model, view);
    default:
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 80"><text x="12" y="44" font-family="sans-serif" font-size="13" fill="#b00">Unsupported chart kind: ${esc(model.kind)}</text></svg>`;
  }
}

// --- categorical (bar / grouped / stacked / 100% / line) ---------------------

const W = 720;
const H = 460;
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const AXIS = '#555';
const GRID = '#e6eaee';

function renderCategorical(model, view) {
  const cats = orderedItems(model.categories, view.categoryOrder);
  const series = orderedItems(model.series, view.seriesOrder);
  const isLine = view.mark === 'line';
  // Lines aren't stacked; force 'none' geometry for line marks.
  const stack = isLine ? 'none' : view.stack;
  const valueAt = (s, ci) => {
    const v = s.values?.[model.categories.findIndex((c) => c.key === cats[ci].key)];
    return Number.isFinite(v) ? v : 0;
  };

  // y-domain.
  let yMin = 0;
  let yMax = 1;
  if (stack === 'percent') {
    yMax = 100;
  } else if (stack === 'stacked') {
    yMax = Math.max(1, ...cats.map((_, ci) => series.reduce((acc, s) => acc + Math.max(0, valueAt(s, ci)), 0)));
  } else {
    const all = [];
    for (const s of series) for (let ci = 0; ci < cats.length; ci++) all.push(valueAt(s, ci));
    yMax = Math.max(1, ...all);
    yMin = Math.min(0, ...all);
  }
  const ticks = niceTicks(yMin, yMax, 5);
  yMin = ticks[0];
  yMax = ticks[ticks.length - 1];

  // Layout. Right margin holds the legend when placed there, sized to labels.
  const legendRight = view.legend === 'right' && series.length > 0;
  const longest = Math.max(0, ...series.map((s) => (s.label || s.key).length));
  const mRight = legendRight ? Math.min(220, Math.max(70, longest * 7 + 28)) : 18;
  const mTop = (model.title ? 34 : 14) + (view.legend === 'top' ? 22 : 0);
  // Bottom margin grows with the longest x label (rotated when many categories).
  const rotate = cats.length > 6 || Math.max(0, ...cats.map((c) => (c.label || c.key).length)) > 6;
  const longestX = Math.max(0, ...cats.map((c) => (c.label || c.key).length));
  const mBottom = (rotate ? Math.min(120, 28 + longestX * 6) : 40) + (model.axes?.x?.title ? 16 : 0) + (view.legend === 'bottom' ? 22 : 0);
  const mLeft = 56 + (model.axes?.y?.title ? 16 : 0);

  const x0 = mLeft;
  const x1 = W - mRight;
  const y0 = H - mBottom;
  const y1 = mTop;
  const plotW = x1 - x0;
  const plotH = y0 - y1;
  const yScale = (v) => y0 - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  if (model.title) out.push(text(W / 2, 20, esc(model.title), { size: 15, weight: 600, anchor: 'middle', fill: '#222' }));

  // y gridlines + ticks.
  for (const t of ticks) {
    const y = yScale(t);
    out.push(`<line x1="${x0}" y1="${r(y)}" x2="${x1}" y2="${r(y)}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(text(x0 - 8, y + 4, fmtNum(t), { size: 11, anchor: 'end', fill: AXIS }));
  }
  // axis lines.
  out.push(`<line x1="${x0}" y1="${y1}" x2="${x0}" y2="${y0}" stroke="${AXIS}" stroke-width="1"/>`);
  out.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="${AXIS}" stroke-width="1"/>`);

  // band per category.
  const band = plotW / Math.max(1, cats.length);
  const xCenter = (ci) => x0 + band * (ci + 0.5);

  if (isLine) {
    drawLines(out, { series, cats, view, valueAt, xCenter, yScale });
  } else if (stack === 'none') {
    drawGroupedBars(out, { series, cats, view, valueAt, band, x0, yScale, yMin });
  } else {
    drawStackedBars(out, { series, cats, view, valueAt, stack, band, x0, yScale, yMin });
  }

  // x labels.
  for (let ci = 0; ci < cats.length; ci++) {
    const cx = xCenter(ci);
    const lab = esc(cats[ci].label || cats[ci].key);
    if (rotate) {
      out.push(`<text x="${r(cx)}" y="${r(y0 + 12)}" font-size="11" fill="${AXIS}" text-anchor="end" transform="rotate(-40 ${r(cx)} ${r(y0 + 12)})">${lab}</text>`);
    } else {
      out.push(text(cx, y0 + 16, lab, { size: 11, anchor: 'middle', fill: AXIS }));
    }
  }

  // axis titles.
  if (model.axes?.x?.title) out.push(text((x0 + x1) / 2, H - 4, esc(model.axes.x.title), { size: 12, anchor: 'middle', fill: '#333' }));
  if (model.axes?.y?.title) {
    out.push(`<text x="14" y="${r((y0 + y1) / 2)}" font-size="12" fill="#333" text-anchor="middle" transform="rotate(-90 14 ${r((y0 + y1) / 2)})">${esc(model.axes.y.title)}</text>`);
  }

  // legend.
  if (view.legend !== 'none' && series.length) drawLegend(out, { series, view, x0, x1, y0, y1, mTop, place: view.legend });

  out.push('</svg>');
  return out.join('');
}

function drawGroupedBars(out, { series, cats, view, valueAt, band, x0, yScale, yMin }) {
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
      out.push(`<rect x="${r(x)}" y="${r(top)}" width="${r(bw - 1)}" height="${r(h)}" fill="${colorFor(view, series[si].key, si)}"/>`);
      if (view.valueLabels && v) out.push(text(x + bw / 2, top - 3, fmtNum(v), { size: 9.5, anchor: 'middle', fill: '#444' }));
    }
  }
}

function drawStackedBars(out, { series, cats, view, valueAt, stack, band, x0, yScale }) {
  const pad = band * 0.18;
  const bw = band - pad * 2;
  for (let ci = 0; ci < cats.length; ci++) {
    const x = x0 + band * ci + pad;
    let total = 0;
    if (stack === 'percent') {
      total = series.reduce((acc, s) => acc + Math.max(0, valueAt(s, ci)), 0) || 1;
    }
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

function drawLegend(out, { series, view, x0, x1, y0, y1, place }) {
  const items = series.map((s, i) => ({ label: s.label || s.key, color: colorFor(view, s.key, i) }));
  if (place === 'right') {
    let ly = y1 + 4;
    const lx = x1 + 14;
    for (const it of items) {
      out.push(`<rect x="${r(lx)}" y="${r(ly)}" width="12" height="12" rx="2" fill="${it.color}"/>`);
      out.push(text(lx + 17, ly + 10, esc(clip(it.label, 26)), { size: 11, fill: '#333' }));
      ly += 19;
    }
  } else {
    // top or bottom: a horizontal row, centred.
    const gap = 16;
    const widths = items.map((it) => 16 + clip(it.label, 22).length * 6.2 + gap);
    const totalW = widths.reduce((a, b) => a + b, 0) - gap;
    let lx = (x0 + x1) / 2 - totalW / 2;
    const ly = place === 'top' ? y1 - 16 : y0 + (38);
    for (let i = 0; i < items.length; i++) {
      out.push(`<rect x="${r(lx)}" y="${r(ly - 9)}" width="12" height="12" rx="2" fill="${items[i].color}"/>`);
      out.push(text(lx + 16, ly + 1, esc(clip(items[i].label, 22)), { size: 11, fill: '#333' }));
      lx += widths[i];
    }
  }
}

// --- helpers -----------------------------------------------------------------

/** Map an ordered list of keys back to the model items, skipping any missing. */
function orderedItems(items, order) {
  const by = new Map((items || []).map((it) => [it.key, it]));
  const out = [];
  for (const k of order || []) if (by.has(k)) out.push(by.get(k));
  // include any not named by the order (defensive).
  for (const it of items || []) if (!order || !order.includes(it.key)) out.push(it);
  return out;
}

function text(x, y, content, { size = 12, anchor = 'start', fill = '#000', weight } = {}) {
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}>${content}</text>`;
}

/** Round to 2 dp for compact SVG coordinates. */
function r(n) {
  return Math.round(n * 100) / 100;
}

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

/** "Nice" axis ticks spanning [min,max] — rounded step (1/2/2.5/5 × 10^k). */
function niceTicks(min, max, count) {
  if (min === max) { max = min + 1; }
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
