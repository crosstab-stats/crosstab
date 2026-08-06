/**
 * @file charts/runtime.js
 * The chart RUNTIME: everything that is true of charts in general, and nothing that is
 * true of any chart in particular.
 *
 * This is the half of the old monolithic chart-renderer.js that does not know what a
 * violin is. It owns the kind registry, view-state defaults, the control-descriptor
 * vocabulary, the palettes, and the drawing primitives (scales, ticks, legends, axis
 * frames) that every kind draws with. Individual kinds live in ./kinds/ and register
 * themselves against this module.
 *
 * The split is not cosmetic. It draws the line a third-party chart type would have to
 * cross: a kind consumes this module's exports and contributes one registry entry, so
 * "what would a plugin need?" now has a concrete, enumerable answer — the export list
 * below — rather than "some unknown subset of a 2,800-line file".
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

/**
 * Register a chart kind that lives in THIS realm (core, or a test harness).
 *
 * `def.provider` optionally names whatever supplies the kind. It exists so a chart can
 * say *what to switch on* when it is reopened somewhere the kind is missing:
 * {@link module:core/results-pane} stamps it onto the saved item at append time,
 * precisely because by the time the chart is being restored the registry can no longer
 * answer.
 */
export function registerChartKind(name, def) {
  KINDS.set(name, { ...def, local: true });
}

/**
 * Register a chart kind supplied by a **plugin**, which lives behind postMessage.
 *
 * Two verbs, and only two, because of what {@link chartSpecOf} guarantees: a kind's
 * controls and colour items are a pure function of the MODEL, and control *visibility*
 * is resolved host-side from the descriptors. So the host asks once per model
 * (`describe`) and then only ever re-renders (`render`) as the view changes.
 *
 * Called by the host on the plugin's behalf, driven by `manifest.charts` — never by the
 * plugin itself. The loader is explicit that the `app` surface exposes no registration
 * verbs and a plugin can only do what a manifest section exists for.
 *
 * @param {string} name
 * @param {{provider:string, describe:(model:object)=>Promise<object>,
 *          render:(model:object, view:object)=>Promise<string>}} remote
 */
export function registerRemoteChartKind(name, remote) {
  KINDS.set(name, { ...remote, local: false });
}

/** Forget a kind — its plugin was deactivated. */
export function unregisterChartKind(name) {
  return KINDS.delete(name);
}

/** Every registered kind name. */
export function chartKindNames() {
  return [...KINDS.keys()];
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
 * Everything the host needs to know about a kind *for one model*, as pure data.
 *
 * This is the whole plugin contract. It is deliberately all-clonable: no functions, so
 * it survives postMessage unchanged whether it was computed here or in a sandbox.
 *
 * @typedef {Object} ChartSpec
 * @property {string} altNoun
 * @property {string} colorLabel
 * @property {boolean} reorderCategories
 * @property {{key:string,label:string}[]} colorItems
 * @property {ControlDescriptor[]} controls
 * @property {Object} baseView
 */

/** Compute a {@link ChartSpec} from a LOCAL kind definition. Pure. */
export function chartSpecOf(kd, model) {
  return {
    altNoun: kd.altNoun || 'Chart',
    colorLabel: (typeof kd.colorLabel === 'function' ? kd.colorLabel(model) : kd.colorLabel) || 'Series',
    reorderCategories: !!kd.reorderCategories,
    colorItems: kd.colorItems ? kd.colorItems(model) : [],
    // `.filter(Boolean)`: a shared builder returns null when its control does not
    // apply (no palette for a single-colour chart), so kinds can list them flat.
    controls: (kd.controls ? kd.controls(model) : []).filter(Boolean),
    baseView: kd.baseView ? kd.baseView(model) : {},
  };
}

/**
 * Ask whoever owns this kind to describe itself for this model. Resolves to null when
 * the kind is not registered — the caller shows the saved figure instead.
 */
export async function describeChart(model) {
  const kd = getChartKind(model && model.kind);
  if (!kd) return null;
  if (kd.local) return chartSpecOf(kd, model);
  const spec = await kd.describe(model);
  return spec ? { ...spec, colorItems: spec.colorItems || [], controls: (spec.controls || []).filter(Boolean) } : null;
}

/** Render, wherever the kind lives. Resolves to null when the kind is not registered. */
export async function renderChartAsync(model, view) {
  const kd = getChartKind(model && model.kind);
  if (!kd) return null;
  return kd.local ? kd.render(model, view) : kd.render(model, view);
}

/**
 * Build the initial {@link ViewState} from a spec: shared defaults, the kind's
 * `baseView`, then the plugin's `model.view`, with colour-item/category order seeded
 * from the model. Pure — returns a fresh object.
 */
export function viewFromSpec(spec, model) {
  const itemKeys = ((spec && spec.colorItems) || []).map((it) => it.key);
  const catKeys = (model.categories || []).map((c) => c.key);
  const v = {
    ...SHARED_DEFAULTS,
    seriesOrder: itemKeys,
    categoryOrder: catKeys,
    ...((spec && spec.baseView) || {}),
    ...(model.view || {}),
  };
  v.seriesOrder = reconcileOrder(v.seriesOrder, itemKeys);
  v.categoryOrder = reconcileOrder(v.categoryOrder, catKeys);
  v.colors = { ...(model.view && model.view.colors ? model.view.colors : {}) };
  return v;
}

/** What the controls panel needs: the spec plus the model's own category list. */
export function uiSpecFromSpec(spec, model) {
  if (!spec) return { controls: [], colorItems: [], colorLabel: 'Series', reorderCategories: false, categories: [] };
  return { ...spec, categories: model.categories || [] };
}

// --- synchronous convenience for LOCAL kinds ---------------------------------
//
// The app goes through the async path above, because a kind may live in a plugin. These
// stay for local kinds — tests, and any kind core still ships — so a pure
// model-in/SVG-out call does not have to be awaited to be checked.

/** @see viewFromSpec — sync, local kinds only. */
export function defaultView(model) {
  const kd = getChartKind(model && model.kind);
  return viewFromSpec(kd && kd.local ? chartSpecOf(kd, model) : null, model);
}

/** Render a chart model + view to an `<svg>` string. Sync, local kinds only. */
export function renderChart(model, view) {
  const kd = getChartKind(model && model.kind);
  if (!kd || !kd.local) return errorSvg(`Unsupported chart kind: ${esc(model && model.kind)}`);
  return kd.render(model, view);
}

/** @see uiSpecFromSpec — sync, local kinds only. */
export function chartUiSpec(model) {
  const kd = getChartKind(model && model.kind);
  return uiSpecFromSpec(kd && kd.local ? chartSpecOf(kd, model) : null, model);
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

// --- control descriptors: pure data, and the engine that reads/writes them ----

/**
 * A control descriptor is **data**, not behaviour.
 *
 * It used to carry `get(view)` / `set(view, x)` / `visible(view, model)` closures. Every
 * one of them turned out to be the same three shapes — read `view[key]` with a default,
 * write `view[key]` with a coercion, and show-if-another-control-is-on — so the closures
 * were pure data wearing a function costume. Making that literal is what lets a chart
 * kind live behind a postMessage boundary: a descriptor now survives `structuredClone`,
 * where a closure could never cross.
 *
 * @typedef {Object} ControlDescriptor
 * @property {string} id - unique within the kind; also the default view key.
 * @property {string} label
 * @property {'check'|'number'|'text'|'select'} type
 * @property {string} [key] - view field to read/write. Defaults to `id`.
 * @property {*} [default] - the value when the view field is undefined. **This is the
 *   single source of truth for a control's default** — renderers must agree with it.
 * @property {[string,string][]} [options] - select only.
 * @property {'string'|'number'} [valueType] - select only; coerce the chosen value.
 * @property {number} [min] @property {number} [max] @property {number} [step]
 * @property {number} [wrap] - number only: values wrap into [0, wrap) instead of clamping.
 * @property {string} [placeholder]
 * @property {string} [group] - collapsible section title in the controls panel.
 * @property {boolean} [structural] - changing it re-lays-out the panel.
 * @property {{control:string, truthy?:boolean, equals?:*}} [visibleWhen] - show only
 *   when ANOTHER control's *effective* value matches. Referencing a control rather than
 *   a raw view key is deliberate: "show the point-size slider when points are on" is one
 *   statement, but `!!v.showPoints` and `v.showPoints !== false` are two, purely because
 *   the two kinds default the toggle differently. Naming the control lets the host apply
 *   that control's own default, so the dependent control does not have to know it.
 */

/** The effective value of a control: what is stored, else its declared default. */
export function controlValue(ctl, view) {
  const raw = view ? view[ctl.key || ctl.id] : undefined;
  const val = raw === undefined ? ctl.default : raw;
  if (ctl.type === 'check') return !!val;
  if (ctl.type === 'select') return String(val ?? '');
  if (ctl.type === 'number') return val ?? '';
  return val ?? '';
}

/** Write a raw widget value into the view, coerced and bounded for the control's type. */
export function setControlValue(ctl, view, raw) {
  const key = ctl.key || ctl.id;
  if (ctl.type === 'check') { view[key] = !!raw; return; }
  if (ctl.type === 'select') { view[key] = ctl.valueType === 'number' ? Number(raw) : raw; return; }
  if (ctl.type === 'text') { view[key] = raw === '' ? undefined : String(raw); return; }
  // number: blank clears back to the default, anything unparseable is ignored rather
  // than stored as NaN (a NaN in the view silently breaks every scale downstream).
  if (raw === '' || raw == null) { view[key] = undefined; return; }
  let n = Number(raw);
  if (!Number.isFinite(n)) { view[key] = undefined; return; }
  if (Number.isFinite(ctl.wrap) && ctl.wrap > 0) n = ((n % ctl.wrap) + ctl.wrap) % ctl.wrap;
  else {
    // Clamp to the declared range. The widget's own min/max only constrain the spinner,
    // not typing, so "max 10" used to accept 999 and hand it straight to the renderer.
    if (Number.isFinite(ctl.min)) n = Math.max(ctl.min, n);
    if (Number.isFinite(ctl.max)) n = Math.min(ctl.max, n);
  }
  view[key] = n;
}

/** Is this control shown, given the view and its sibling descriptors? */
export function controlVisible(ctl, view, controls) {
  const w = ctl.visibleWhen;
  if (!w) return true;
  const dep = (controls || []).find((c) => c.id === w.control);
  if (!dep) return true; // a dangling reference should not hide the control silently
  const val = controlValue(dep, view);
  if ('equals' in w) return val === w.equals;
  return w.truthy === false ? !val : !!val;
}

// --- shared control-descriptor builders (any kind can reuse) -----------------
//
// Each returns plain data, or `null` when the control does not apply to this model.
// chartUiSpec filters the nulls, so a kind can list them unconditionally.

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
    id: 'legend', label: 'Legend', type: 'select', group: 'Style',
    default: fallback,
    options: [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['none', 'Hidden']],
  } : null;
}

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
 * The formatting controls only make sense once there IS a title. When the model supplies
 * one they are always relevant; when it does not, they appear as soon as the user types
 * one — expressed as `visibleWhen` against the text control rather than as a closure
 * over `model.title`, so the whole descriptor stays clonable.
 */
export function titleControls(model) {
  const always = !!model.title;
  const dep = always ? undefined : { control: 'titleText', truthy: true };
  return [
    {
      id: 'titleText', label: 'Title', type: 'text', group: 'Titles & axes',
      placeholder: model.title || '(none)', default: '',
    },
    { id: 'titleSize', label: 'Title size', type: 'number', min: 8, max: 28, step: 1, group: 'Titles & axes', default: 15, visibleWhen: dep },
    { id: 'titleBold', label: 'Title bold', type: 'check', group: 'Titles & axes', default: true, visibleWhen: dep },
    { id: 'titleItalic', label: 'Title italic', type: 'check', group: 'Titles & axes', default: false, visibleWhen: dep },
  ];
}

/** Axis title + formatting + min/max controls for one axis. */
export function axisControls(axis, model) {
  const upper = axis.toUpperCase();
  const modelTitle = model.axes?.[axis]?.title || '';
  const p = `${axis}Axis`;
  const dep = modelTitle ? undefined : { control: `${p}Title`, truthy: true };
  return [
    {
      id: `${p}Title`, label: `${upper} axis title`, type: 'text', group: 'Titles & axes',
      placeholder: modelTitle || '(none)', default: '',
    },
    { id: `${p}TitleSize`, label: `${upper} title size`, type: 'number', min: 8, max: 22, step: 1, group: 'Titles & axes', default: 12, visibleWhen: dep },
    { id: `${p}TitleBold`, label: `${upper} title bold`, type: 'check', group: 'Titles & axes', default: false, visibleWhen: dep },
    { id: `${p}TitleItalic`, label: `${upper} title italic`, type: 'check', group: 'Titles & axes', default: false, visibleWhen: dep },
    // No default: blank means "auto", and a number here is an explicit override.
    { id: `${p}Min`, label: `${upper} axis min`, type: 'number', placeholder: 'auto', group: 'Titles & axes' },
    { id: `${p}Max`, label: `${upper} axis max`, type: 'number', placeholder: 'auto', group: 'Titles & axes' },
  ];
}

/** Value label formatting controls (size, bold, italic). */
export function valueLabelFormatControls() {
  const dep = { control: 'valueLabels', truthy: true };
  return [
    { id: 'valueLabelSize', label: 'Label size', type: 'number', min: 6, max: 18, step: 0.5, group: 'Labels', default: 9.5, visibleWhen: dep },
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

export function text(x, y, content, { size = 12, anchor = 'start', fill = '#000', weight, italic } = {}) {
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${weight ? ` font-weight="${weight}"` : ''}${italic ? ' font-style="italic"' : ''}>${content}</text>`;
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
export function legendBlock(items, place, box) {
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
export function ordered(items, order) {
  const by = new Map((items || []).map((it) => [it.key, it]));
  const out = [];
  for (const k of order || []) if (by.has(k)) out.push(by.get(k));
  for (const it of items || []) if (!order || !order.includes(it.key)) out.push(it);
  return out;
}

export function svgOpen(label) {
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
export function svgOpenH(h, label) {
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
 *
 * The noun comes from the kind's own `altNoun`, not from a table here. It used to be a
 * literal `{scatter: 'Scatter plot', …}` map in this function, which meant every new
 * kind had to remember to edit a switch three hundred lines away from itself — and a
 * kind that forgot was silently announced as "Chart". Anything a kind knows about
 * itself belongs on the kind.
 */
export function chartAltText(model, view, extra) {
  const title = view.titleText || model.title || '';
  const kd = getChartKind(model.kind);
  const kind = (kd && kd.altNoun) || 'Chart';
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
export function bandFrame(model, view, { allValues, bands, legendItems = [], alt = plural(bands, 'group') + '.' }) {
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
export function xyFrame(model, view, { xValues, yValues, legendItems = [], alt, xTickCount = 7, yTickCount = 6 }) {
  const title = view.titleText || model.title;
  const xTitle = view.xAxisTitle || model.axes?.x?.title;
  const yTitle = view.yAxisTitle || model.axes?.y?.title;

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
  const mRight = showLegend && view.legend === 'right'
    ? Math.min(200, Math.max(70, Math.max(...legendItems.map((i) => i.label.length)) * 7 + 28))
    : 20;
  const mTop = title ? 34 : 16;
  const mBottom = 44 + (xTitle ? 16 : 0) + (showLegend && view.legend === 'bottom' ? 26 : 0);
  const mLeft = 56 + (yTitle ? 16 : 0);
  const box = { x0: mLeft, x1: W - mRight, y0: H - mBottom, y1: mTop };

  const xScale = (v) => box.x0 + ((v - xs.lo) / (xs.hi - xs.lo || 1)) * (box.x1 - box.x0);
  const yScale = (v) => box.y0 - ((v - ys.lo) / (ys.hi - ys.lo || 1)) * (box.y0 - box.y1);

  const out = [svgOpen(chartAltText(model, view, alt))];
  if (title) {
    out.push(text(W / 2, 21, esc(title), {
      size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400,
      italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
    }));
  }
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
    if (showLegend) out.push(legendBlock(legendItems, view.legend, box));
    out.push('</svg>');
    return out.join('');
  };

  return { out, box, xScale, yScale, close, xLo: xs.lo, xHi: xs.hi, yLo: ys.lo, yHi: ys.hi };
}
