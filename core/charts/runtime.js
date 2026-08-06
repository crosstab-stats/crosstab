/**
 * @file charts/runtime.js
 * The chart RUNTIME: the registry, view state, and the control-descriptor engine.
 *
 * This is the HOST half. It knows which kinds exist, whether each lives here or behind
 * postMessage, how to build a view from a kind's spec, and how to read and write the
 * declarative control descriptors. It knows nothing about how any chart is drawn —
 * that is ./stdlib.js, which is also shipped into the plugin sandbox.
 *
 * Re-exports the stdlib so existing importers (and the barrel) see one surface.
 */

import {
  PALETTES, DEFAULT_PALETTE, colorFor, errorSvg, esc,
} from './stdlib.js';

export * from './stdlib.js';

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
