/**
 * @file chart-drag.js
 * Drag the three chart layers — plot, legend, title — into place by hand.
 *
 * The positions the renderers choose are defaults, and defaults are a guess about
 * composition. Every automatic rule we have tried has been wrong for somebody: the
 * legend's old right-hand margin was measured off the longest label (so the data
 * decided how much canvas the data got), and the title sat in a fixed band whose size
 * was really a cap on the title's own size. The owner's verdict on the result,
 * 2026-10-08: *"the placement of these elements is way off from ideal. But again, this
 * is just my aesthetic preference."* Which is the point — it is an aesthetic judgement,
 * so the person whose figure it is should be making it.
 *
 * ## How it attaches to an opaque figure
 *
 * A chart arrives as an SVG *string* from a kind that may live in a sandboxed plugin,
 * so the host knows nothing about where anything was drawn. What makes this possible is
 * that each layer is emitted as a `<g class="ct-layer ct-layer--…">` (see `LAYERS` in
 * charts/stdlib.js). Once that markup is in the document the browser answers every
 * geometric question for us:
 *
 *   - `getBoundingClientRect()` on the group gives its on-screen box, already including
 *     the letterboxing `preserveAspectRatio` applies inside the user's resizable frame.
 *     No aspect-ratio arithmetic here, which is where this would otherwise go wrong.
 *   - `getScreenCTM()` on the `<svg>` gives the scale, to turn a pointer delta in CSS
 *     pixels into the viewBox units the view stores.
 *
 * The class, not a `data-` attribute, carries the layer's identity: chart markup passes
 * through sanitize-html.js on its way into the pane, and that allowlist keeps `class`,
 * `role` and `aria-*` and drops everything else.
 *
 * ## Why the overlay is a sibling of the figure
 *
 * `ResultsPane`'s re-render does `holder.innerHTML = item.svg`, which destroys every
 * child of the holder. So the outlines live in a sibling layer positioned over it, and
 * re-measure when the markup changes (a `MutationObserver`) or the frame is resized (a
 * `ResizeObserver`). Anything parented inside the holder would silently vanish on the
 * first control change.
 *
 * ## Why a commit happens on release, not during the drag
 *
 * Writing the view re-renders, and a render can cross a postMessage boundary to a
 * plugin — `ResultsPane` already sequence-guards replies because they land out of
 * order. Committing per pointermove would mean a round trip per frame. So a drag moves
 * the group's own `transform` locally at pointer speed and writes the view once, on
 * release.
 *
 * ## Keyboard, not as polish
 *
 * Each outline is a real `<button>` that nudges with the arrow keys. Drag-only
 * positioning fails WCAG 2.1.1 (Keyboard) and 2.5.7 (Dragging Movements) outright, and
 * it is also the only way to do this on a phone, where a one-unit drag is not a
 * gesture anyone can make. It doubles as the fine adjustment after a rough drag.
 */

import { LAYERS, layerOffsetOf } from './charts/stdlib.js';

/** How far an arrow key moves a layer, and how far Shift+arrow moves it. */
export const NUDGE = 1;
export const NUDGE_FAR = 10;

/** Human names, for the outline's tag and its accessible name. */
const LAYER_NAMES = { plot: 'chart', legend: 'legend', title: 'title' };

/** What to call a layer in the interface. One place, so an outline's tag and the button
 * that resets it cannot end up calling the same thing by two names. */
export function layerName(n) { return LAYER_NAMES[n] || n; }

/**
 * ## Nothing constrains where a layer may go
 *
 * There was a clamp that kept 24 units of every layer on the canvas, on the grounds
 * that a layer with nothing left to grab is unrecoverable. It went, for two reasons.
 *
 * The owner's, which is the deciding one: *"remove all guards on drag location. Put a
 * 'reset to default' button in the relevant chart option control to recover if an
 * element is dragged off the canvas"* (2026-10-08). The recovery exists, so the guard
 * was buying nothing that the reset does not already buy.
 *
 * And a bug it was causing, reported as dead zones on an iPhone that a layer refused to
 * be dragged into. The clamp needed the layer's position in canvas coordinates, which it
 * got by mixing `getScreenCTM()`'s TRANSLATION with `getBoundingClientRect()` — and on
 * iOS those two disagree whenever the visual viewport is offset from the layout
 * viewport, which is to say whenever the page is pinch-zoomed, the URL bar is
 * collapsing, or the keyboard is up. The drag itself was unaffected because it only uses
 * the matrix's SCALE, which no viewport offset changes; so the layer tracked the finger
 * perfectly and then refused to be put down in places that looked fine. Deleting the
 * clamp deletes the only thing that needed those coordinates.
 */

/** The view's offset map, created on demand. */
function offsetsOf(view) {
  if (!view.layerOffsets) view.layerOffsets = {};
  return view.layerOffsets;
}

/** Has the user moved anything? Drives whether "Reset positions" is worth showing. */
export function hasMovedLayers(view) {
  return movedLayers(view).length > 0;
}

/** Put every layer back where the renderer would have placed it. */
export function resetLayerPositions(view) {
  delete view.layerOffsets;
}

/**
 * Put ONE layer back, leaving the others where the user put them.
 *
 * With no clamp, the way a layer gets lost is a single careless drag — and resetting
 * all three to recover from that would throw away the two that were placed on purpose.
 */
export function resetLayerPosition(view, name) {
  if (view && view.layerOffsets) delete view.layerOffsets[name];
}

/** Which layers have been moved — what the reset buttons are offered for. */
export function movedLayers(view) {
  return LAYERS.filter((n) => {
    const o = layerOffsetOf(view, n);
    return o.x !== 0 || o.y !== 0;
  });
}

/**
 * Show draggable outlines over a chart's layers.
 *
 * @param {HTMLElement} holder - the element whose innerHTML is the chart's SVG
 * @param {{view: object}} item - the chart item; its `view` is written on commit
 * @param {() => void} onCommit - called after a move is written to the view
 * @returns {{destroy: () => void, sync: () => void}}
 */
export function mountLayerDrag(holder, item, onCommit) {
  const doc = holder.ownerDocument;
  const frame = holder.parentElement || holder;
  // Everything attached to the document is tied to this, so closing the panel part-way
  // through a drag cannot leave a listener behind watching for a move that will never
  // come.
  const life = new AbortController();

  const overlay = doc.createElement('div');
  overlay.className = 'ct-drag';
  // Inert except for the handles themselves, so the figure's own resize grip and
  // anything else beneath stays reachable.
  overlay.setAttribute('aria-hidden', 'false');
  // The how-to lives in the options panel (chart-controls.js), not here. Anchored under
  // the figure it landed on top of the "Chart options" button, and the figure has no
  // spare room of its own to give it — the panel does, and it opens directly below.
  frame.append(overlay);

  /** layer name → its handle button. Built once; only geometry changes after that. */
  const handles = new Map();

  const svgOf = () => holder.querySelector('svg');

  /** CSS pixels per viewBox unit, as the browser is actually drawing it. */
  const scaleOf = (svg) => {
    const m = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    return {
      x: m && Math.abs(m.a) > 1e-6 ? m.a : 1,
      y: m && Math.abs(m.d) > 1e-6 ? m.d : 1,
    };
  };

  const handleFor = (name) => {
    let h = handles.get(name);
    if (h) return h;
    h = doc.createElement('button');
    h.type = 'button';
    h.className = `ct-drag__handle ct-drag__handle--${name}`;
    // The layer order is also the hit order: a title over the legend over the plot, so
    // grabbing where two outlines overlap grabs the one drawn on top.
    h.style.zIndex = String(10 + LAYERS.indexOf(name));
    const label = doc.createElement('span');
    label.className = 'ct-drag__tag';
    label.textContent = layerName(name);
    h.append(label);
    h.setAttribute('aria-label', `Move the ${layerName(name)}. Arrow keys to nudge.`);
    wire(h, name);
    overlay.append(h);
    handles.set(name, h);
    return h;
  };

  /** Position every handle over its layer. Cheap enough to run on any change. */
  const sync = () => {
    const svg = svgOf();
    if (!svg) return;
    const base = frame.getBoundingClientRect();
    const seen = new Set();
    for (const g of svg.querySelectorAll('.ct-layer')) {
      const name = LAYERS.find((n) => g.classList.contains(`ct-layer--${n}`));
      if (!name) continue;
      seen.add(name);
      const h = handleFor(name);
      const r = g.getBoundingClientRect();
      // An empty layer (no title set, no legend shown) has a zero-sized box and gets
      // no outline — an invisible 0×0 target would be a tab stop that does nothing.
      if (r.width < 1 || r.height < 1) { h.hidden = true; continue; }
      h.hidden = false;
      h.style.left = `${r.left - base.left}px`;
      h.style.top = `${r.top - base.top}px`;
      h.style.width = `${r.width}px`;
      h.style.height = `${r.height}px`;
    }
    for (const [name, h] of handles) if (!seen.has(name)) h.hidden = true;
  };

  /** Write one layer's offset and tell the pane to redraw and mark itself dirty. */
  const commit = (name, offset) => {
    // Rounded, and otherwise taken as given — see the note above on why there is no
    // clamp. A drag divides a pixel delta by the render scale, so it naturally produces
    // things like 91.71974522292993, which the markup rounds to 2dp anyway and which
    // would otherwise sit in the saved project forever as noise in the one field that
    // differs between two saves of an unchanged chart.
    const at = { x: round(offset.x), y: round(offset.y) };
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    if (at.x === 0 && at.y === 0) delete offsetsOf(item.view)[name];
    else offsetsOf(item.view)[name] = at;
    onCommit();
  };

  function wire(h, name) {
    let drag = null;

    h.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const svg = svgOf();
      const g = svg && svg.querySelector(`.ct-layer--${name}`);
      if (!g) return;
      e.preventDefault();
      const from = layerOffsetOf(item.view, name);
      drag = {
        id: e.pointerId, g, scale: scaleOf(svg), from,
        x0: e.clientX, y0: e.clientY,
        left: parseFloat(h.style.left) || 0, top: parseFloat(h.style.top) || 0,
        moved: false, at: from,
      };
      // Capture if we can, but do NOT depend on it. Measured in Chrome: once the
      // pointer leaves the handle, pointermove stops arriving at the handle — so a
      // title whose outline is 14px tall broke after 14px of travel and sprang back
      // to where it started, which is exactly what "I drag up and it bounces back
      // down" looks like. The document listeners below are what actually make a drag
      // longer than the handle work; the capture is a bonus when it takes.
      try { h.setPointerCapture(e.pointerId); } catch { /* not all pointers capture */ }
      const opts = { signal: life.signal };
      doc.addEventListener('pointermove', onMove, opts);
      doc.addEventListener('pointerup', end, opts);
      doc.addEventListener('pointercancel', end, opts);
      h.classList.add('is-dragging');
    });

    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dxPx = e.clientX - drag.x0;
      const dyPx = e.clientY - drag.y0;
      if (!drag.moved && Math.abs(dxPx) + Math.abs(dyPx) < 2) return; // a click, not a drag
      drag.moved = true;
      drag.at = { x: drag.from.x + dxPx / drag.scale.x, y: drag.from.y + dyPx / drag.scale.y };
      // Local only: the group moves with the pointer and the view is left alone until
      // release, so one drag costs one render rather than one per frame.
      drag.g.setAttribute('transform', `translate(${round(drag.at.x)} ${round(drag.at.y)})`);
      h.style.left = `${drag.left + dxPx}px`;
      h.style.top = `${drag.top + dyPx}px`;
    };

    function end(e) {
      if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return;
      const { moved, at } = drag;
      drag = null;
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', end);
      doc.removeEventListener('pointercancel', end);
      h.classList.remove('is-dragging');
      // An un-moved press is a plain click — leave the view untouched rather than
      // writing an identical offset and spending a render on it.
      if (moved) commit(name, at);
      else sync();
    }

    h.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? NUDGE_FAR : NUDGE;
      const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!by) return;
      e.preventDefault();
      const from = layerOffsetOf(item.view, name);
      commit(name, { x: from.x + by[0], y: from.y + by[1] });
    });
  }

  // The figure is replaced wholesale on every control change, and resized by dragging
  // its grip — so re-measure on both rather than hoping to be told.
  const mo = new MutationObserver(() => sync());
  mo.observe(holder, { childList: true, subtree: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => sync()) : null;
  if (ro) ro.observe(holder);

  sync();

  return {
    sync,
    destroy() {
      life.abort();
      mo.disconnect();
      if (ro) ro.disconnect();
      overlay.remove();
      handles.clear();
    },
  };
}

function round(n) { return Math.round(n * 100) / 100; }
