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

/** The smallest canvas the grip will make. A floor, not a preference: a frame of zero
 * or negative size has no geometry for anything else to be measured against. */
export const MIN_CANVAS = 80;

/** The grip's size, here and in the stylesheet — it has to be known in both, because
 * the grip is positioned by its own far corner so that none of it is ever clipped. */
export const GRIP_PX = 44;

/** The canvas a resize drag arrives at. Pure, because it is the one bit of arithmetic
 * in the grip and the rest is browser measurement. */
export function resizedCanvas(start, dx, dy) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    w: Math.max(MIN_CANVAS, Math.round(n(start.w) + n(dx))),
    h: Math.max(MIN_CANVAS, Math.round(n(start.h) + n(dy))),
  };
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

  /**
   * The canvas's own resize grip.
   *
   * The frame already has `resize: both`, and on a desktop that is the familiar thing
   * to reach for — but the native CSS resizer is not touch-draggable on iOS, confirmed
   * on a real iPhone, so there the canvas could not be sized at all. This is the same
   * technique the layer handles use and it works on touch for the same reason: pointer
   * events with `touch-action: none`, routed through the document so the drag survives
   * the pointer leaving the grip.
   *
   * It writes the view directly rather than leaning on the frame's ResizeObserver. That
   * path still serves the native grip, but it is the one link in this feature I have
   * never been able to exercise — observer delivery is tied to the rendering lifecycle,
   * and an automated tab is occluded — so the touch route does not depend on it.
   */
  const grip = doc.createElement('button');
  grip.type = 'button';
  grip.className = 'ct-drag__grip';
  grip.setAttribute('aria-label', 'Resize the canvas. Arrow keys to adjust.');
  grip.title = 'Drag to resize the canvas';
  // A SIBLING of the overlay, not a child. The overlay is clipped (`overflow: hidden`)
  // so that a layer dragged off the canvas cannot grow the page's scroll — and the grip
  // is centred ON the figure's corner, so half of it, including the corner glyph, fell
  // outside that clip and vanished. The hit area survived, which is the worst version:
  // "I just move the mouse around the corner looking for the pointer change to find it."
  // Nothing about the grip needs clipping; it is always exactly at the corner.
  frame.append(grip);

  /**
   * Resize the canvas, in CHART UNITS.
   *
   * Units, not CSS pixels, and that distinction is the whole design. A phone's figure is
   * about 360px wide while the chart composes itself in a 720-unit space, so equating
   * the two would have made the first touch of this grip shrink the canvas below the
   * chart and clip it — an accident, not a choice. In units the canvas starts out
   * exactly fitting the chart, and only leaves it if the user drags inward on purpose.
   *
   * It also means nothing here writes an inline pixel size. The frame takes its shape
   * from the viewBox (fitHolderToViewBox) after the redraw, so there is one direction of
   * travel — canvas to frame — instead of two that have to be kept agreeing.
   */
  const setCanvas = (w, h, shownW) => {
    item.view.canvasW = Math.max(MIN_CANVAS, Math.round(w));
    item.view.canvasH = Math.max(MIN_CANVAS, Math.round(h));
    // The canvas is in chart units; `frameW` is how wide it is DRAWN, in CSS pixels.
    // Storing both is what makes the grip behave. With only the units, the figure
    // stayed pinned to the pane's width, so a bigger canvas was paid for by shrinking
    // everything on it: "as though the canvas enlarged then suddenly zoomed out to fit
    // back in the previously allocated space" (owner, 2026-10-08). Growing the drawn
    // width in step keeps the zoom, which is what dragging a canvas out should mean.
    if (Number.isFinite(shownW) && shownW > 0) item.view.frameW = Math.max(MIN_CANVAS, Math.round(shownW));
    onCommit();
  };

  /** The canvas the chart is currently drawn on, read back from its own markup. */
  const currentCanvas = () => {
    const svg = svgOf();
    const vb = (svg && svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : { w: 720, h: 460 };
  };

  {
    let rs = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const svg = svgOf();
      const now = currentCanvas();
      rs = {
        id: e.pointerId, ...now, scale: scaleOf(svg), shownW: holder.getBoundingClientRect().width,
        x0: e.clientX, y0: e.clientY, at: null,
      };
      try { grip.setPointerCapture(e.pointerId); } catch { /* capture is a bonus */ }
      const opts = { signal: life.signal };
      doc.addEventListener('pointermove', onResize, opts);
      doc.addEventListener('pointerup', endResize, opts);
      doc.addEventListener('pointercancel', endResize, opts);
      grip.classList.add('is-dragging');
    });

    function onResize(e) {
      if (!rs || e.pointerId !== rs.id) return;
      // The pointer delta is in CSS pixels; the canvas is in chart units. Dividing by
      // the render scale is the same conversion a layer drag makes, and it uses only
      // the matrix's scale — never its translation, which is what made the old clamp
      // misbehave on iOS.
      const dx = e.clientX - rs.x0;
      const dy = e.clientY - rs.y0;
      rs.at = resizedCanvas(rs, dx / rs.scale.x, dy / rs.scale.y);
      // The drawn figure grows by the same pixels the pointer moved, so the zoom is
      // unchanged and everything on the canvas keeps the size it looks on screen.
      rs.at.shownW = Math.max(MIN_CANVAS, rs.shownW + dx);
    }

    function endResize(e) {
      if (!rs || (e && e.pointerId != null && e.pointerId !== rs.id)) return;
      const at = rs.at;
      rs = null;
      doc.removeEventListener('pointermove', onResize);
      doc.removeEventListener('pointerup', endResize);
      doc.removeEventListener('pointercancel', endResize);
      grip.classList.remove('is-dragging');
      // Redrawn once, on release: a render may cross postMessage to a plugin, so one
      // per pointermove would be a round trip per frame.
      if (at) setCanvas(at.w, at.h, at.shownW);
      else sync();
    }

    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 50 : 10;
      const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!by) return;
      e.preventDefault();
      const now = currentCanvas();
      const at = resizedCanvas(now, by[0], by[1]);
      // Same deal as the drag: grow the drawn figure in step, or a keyboard resize
      // quietly zooms out instead of enlarging the canvas.
      const shown = holder.getBoundingClientRect().width;
      setCanvas(at.w, at.h, shown * (at.w / (now.w || 1)));
    });
  }

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
    // The overlay is sized to the FIGURE rather than stretched across the block. Once
    // the canvas can be drawn wider than the pane the figure overflows, and an overlay
    // covering only the block would clip the handles for everything past its edge — it
    // has `overflow: hidden`, so that an off-canvas layer cannot grow the page scroll.
    const base = holder.getBoundingClientRect();
    const br = frame.getBoundingClientRect();
    overlay.style.left = `${base.left - br.left}px`;
    overlay.style.top = `${base.top - br.top}px`;
    overlay.style.width = `${base.width}px`;
    overlay.style.height = `${base.height}px`;
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
    // The grip's own bottom-right corner is put ON the figure's, so the whole target
    // sits INSIDE the figure. Centring it on the corner looked tidier and was not:
    // the figure spans the full pane, so its corner is exactly the scroll container's
    // clipping edge, and the outer half of the grip — the half carrying the glyph —
    // was cut off, leaving a target you could only find by hunting for the cursor to
    // change. Measured against the block because the grip lives outside the clipped
    // overlay.
    grip.style.left = `${base.right - br.left - GRIP_PX}px`;
    grip.style.top = `${base.bottom - br.top - GRIP_PX}px`;
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
  // ...and again once this layout pass has settled. Opening the panel changes the
  // pane's height, which can add or remove its scrollbar, which changes the figure's
  // width — so the measurements taken during the mount can be stale by the time anyone
  // sees them, and the outlines sit a dozen pixels off their layers. The ResizeObserver
  // above would catch it, but only in a tab that is actually rendering; a timeout holds
  // in a background tab too, and costs one measurement.
  const settle = setTimeout(sync, 0);

  return {
    sync,
    destroy() {
      life.abort();
      clearTimeout(settle);
      grip.remove();
      mo.disconnect();
      if (ro) ro.disconnect();
      overlay.remove();
      handles.clear();
    },
  };
}

function round(n) { return Math.round(n * 100) / 100; }
