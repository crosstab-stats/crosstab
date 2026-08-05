/**
 * @file chart-controls.js
 * The interactive control strip for a data-driven chart (see chart-renderer.js).
 *
 * Builds a small, collapsible "Chart options" panel that mutates the chart's
 * {@link ViewState} in place and calls back to re-render — instantly, host-side, no
 * WebR round-trip. Because it edits the persisted view (not the model), every tweak
 * survives a project save/reopen.
 *
 * This file is **kind-agnostic**: it asks the renderer for the model's UI spec
 * ({@link chartUiSpec}) — a list of control descriptors plus the colour-item and
 * category-reorder info — and renders whatever it's given. A new chart kind that
 * registers its own controls gets a working panel here with no edits to this file.
 *
 * ## Grouping
 *
 * Controls are bucketed into collapsible sections by their descriptor's `group`, in
 * order of first appearance, with only the first section open. This is not decoration:
 * the SCED kind alone shows **29 controls on the simplest possible chart**, and 16 of
 * those are the generic title/axis block that every kind carries. A flat list of thirty
 * widgets is unusable however few of them you actually need, and splitting a chart kind
 * in two would have duplicated the sixteen rather than removed them — the bloat lives
 * here, so the fix belongs here.
 *
 * Open/closed state is remembered across repaints (`paint()` replaces the panel's
 * children whenever a `structural` control changes, which would otherwise slam every
 * section shut mid-edit).
 */

import { chartUiSpec, colorFor } from './chart-renderer.js';

/**
 * @param {{model: import('./chart-renderer.js').ChartModel, view: import('./chart-renderer.js').ViewState}} item
 * @param {() => void} onChange - called after any control changes the view (host re-renders).
 * @returns {HTMLElement}
 */
export function buildChartControls(item, onChange) {
  const { model, view } = item;
  const wrap = elem('div', 'results-chart__controls');

  const toggle = elem('button', 'results-chart__opts-toggle');
  toggle.type = 'button';
  toggle.textContent = '⚙ Chart options';
  const panel = elem('div', 'results-chart__opts');
  panel.hidden = true;
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.classList.toggle('is-open', !panel.hidden);
  });
  wrap.append(toggle, panel);

  // Which sections the user has open. Seeded on the first paint with the first
  // section only, then owned by the user and preserved across repaints.
  const open = new Set();
  let seeded = false;

  // Rebuild the panel from the kind's UI spec. Re-run on structural changes (a
  // control with structural:true, or any reorder) so dependent controls show/hide
  // and the colour/order lists re-sort.
  const paint = () => {
    panel.replaceChildren();
    const spec = chartUiSpec(model);

    /** group name → {nodes, rows} in order of first appearance. `rows` is the count
     * shown in the header, which is not the node count: a reorder list is ONE node
     * holding one row per series. */
    const groups = new Map();
    const into = (name, node, rows = 1) => {
      if (!groups.has(name)) groups.set(name, { nodes: [], rows: 0 });
      const g = groups.get(name);
      g.nodes.push(node);
      g.rows += rows;
    };

    // 1. The kind's declared control widgets (type, stacking, rotation, …).
    for (const ctl of spec.controls) {
      if (ctl.visible && !ctl.visible(view, model)) continue;
      into(ctl.group || 'Chart', buildControl(ctl, view, () => {
        if (ctl.structural) paint();
        onChange();
      }));
    }

    // 2. Colour + order list for the kind's colour items (series / slices / groups).
    const items = spec.colorItems || [];
    const multi = items.length > 1;
    if (items.length) {
      // Named "Colour & order (Phases)" rather than "Phases", so it cannot collide with
      // a kind's own section of the same name — SCED has both a Phases section (lines,
      // labels) and a per-phase colour list, and two identically-titled sections is a
      // puzzle rather than a grouping.
      const name = multi ? `Colour & order (${spec.colorLabel})` : 'Colour';
      into(name, reorderList(items, view.seriesOrder, view, multi, paint, onChange), items.length);
      if (Object.keys(view.colors).length) {
        into(name, textBtn('Reset colours', () => { view.colors = {}; paint(); onChange(); }), 0);
      }
    }

    // 3. Category (x-axis) order — kinds that opt in (categorical).
    if (spec.reorderCategories && (spec.categories || []).length > 1) {
      into('Category order',
        reorderList(spec.categories, view.categoryOrder, null, true, paint, onChange),
        spec.categories.length);
    }

    if (!seeded) {
      const first = groups.keys().next();
      if (!first.done) open.add(first.value);
      seeded = true;
    }

    for (const [name, { nodes, rows }] of groups) {
      const section = document.createElement('details');
      section.className = 'results-chart__group';
      section.open = open.has(name);
      const summary = document.createElement('summary');
      summary.className = 'results-chart__grouphead';
      summary.textContent = `${name} (${rows})`;
      section.append(summary, ...nodes);
      section.addEventListener('toggle', () => {
        if (section.open) open.add(name); else open.delete(name);
      });
      panel.append(section);
    }
  };

  paint();
  return wrap;
}

/** Build one labelled control widget from a descriptor. */
function buildControl(ctl, view, changed) {
  if (ctl.type === 'check') {
    const row = elem('label', 'results-chart__row results-chart__row--check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!ctl.get(view);
    cb.addEventListener('change', () => { ctl.set(view, cb.checked); changed(); });
    const span = elem('span', 'results-chart__rowlabel');
    span.textContent = ctl.label;
    row.append(cb, span);
    return row;
  }
  if (ctl.type === 'number') {
    const row = elem('label', 'results-chart__row');
    const span = elem('span', 'results-chart__rowlabel');
    span.textContent = ctl.label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'results-chart__num';
    if (ctl.min != null) inp.min = ctl.min;
    if (ctl.max != null) inp.max = ctl.max;
    if (ctl.step != null) inp.step = ctl.step;
    inp.value = String(ctl.get(view));
    if (ctl.placeholder) inp.placeholder = ctl.placeholder;
    inp.addEventListener('change', () => { ctl.set(view, inp.value); inp.value = String(ctl.get(view)); changed(); });
    row.append(span, inp);
    return row;
  }
  if (ctl.type === 'text') {
    const row = elem('label', 'results-chart__row');
    const span = elem('span', 'results-chart__rowlabel');
    span.textContent = ctl.label;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'results-chart__text';
    inp.value = String(ctl.get(view) ?? '');
    if (ctl.placeholder) inp.placeholder = ctl.placeholder;
    inp.addEventListener('change', () => { ctl.set(view, inp.value); changed(); });
    row.append(span, inp);
    return row;
  }
  // select
  const row = elem('label', 'results-chart__row');
  const span = elem('span', 'results-chart__rowlabel');
  span.textContent = ctl.label;
  const sel = document.createElement('select');
  sel.className = 'results-chart__select';
  const opts = typeof ctl.options === 'function' ? ctl.options() : ctl.options;
  const cur = String(ctl.get(view));
  for (const [val, lab] of opts) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lab;
    if (val === cur) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => { ctl.set(view, sel.value); changed(); });
  row.append(span, sel);
  return row;
}

/** A list of `items` ({key,label}) in `order`, each with optional colour picker
 * (when `viewForColor` is given) and ▲▼ reorder buttons. Mutates `order` in place. */
function reorderList(items, order, viewForColor, showOrder, paint, onChange) {
  const by = new Map(items.map((it) => [it.key, it]));
  const list = elem('div', 'results-chart__series');
  order.forEach((key, idx) => {
    const it = by.get(key);
    if (!it) return;
    const row = elem('div', 'results-chart__srow');

    if (viewForColor) {
      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'results-chart__swatch';
      color.value = toHex(colorFor(viewForColor, key, idx));
      color.title = 'Colour';
      color.addEventListener('input', () => { viewForColor.colors[key] = color.value; onChange(); });
      row.append(color);
    }

    const name = elem('span', 'results-chart__sname');
    name.textContent = it.label || key;
    name.title = it.label || key;
    row.append(name);

    if (showOrder) {
      row.append(
        iconBtn('▲', 'Move up', idx === 0, () => { move(order, idx, -1); paint(); onChange(); }),
        iconBtn('▼', 'Move down', idx === order.length - 1, () => { move(order, idx, +1); paint(); onChange(); }),
      );
    }
    list.append(row);
  });
  return list;
}

// --- small DOM builders ------------------------------------------------------

function elem(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function iconBtn(glyph, title, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'results-chart__ord';
  b.textContent = glyph;
  b.title = title;
  // The glyph is decorative; `title` alone is a weak accessible name (VoiceOver
  // ignores it in several contexts, and most of these buttons are destructive).
  b.setAttribute('aria-label', title);
  b.disabled = !!disabled;
  b.addEventListener('click', onClick);
  return b;
}

function textBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'results-chart__reset';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Move item at `idx` by `delta` within `arr`, in place (clamped). */
function move(arr, idx, delta) {
  const j = idx + delta;
  if (j < 0 || j >= arr.length) return;
  const [x] = arr.splice(idx, 1);
  arr.splice(j, 0, x);
}

/** Coerce a colour to '#rrggbb' for <input type=color>. */
function toHex(c) {
  if (typeof c === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map((ch) => ch + ch).join('')).toLowerCase();
  }
  return '#2980b9';
}
