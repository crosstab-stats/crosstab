/**
 * @file chart-controls.js
 * The interactive control strip for a data-driven chart (see chart-renderer.js).
 *
 * Builds a small, collapsible "Chart options" panel under a chart that mutates its
 * {@link ViewState} in place and calls back to re-render — instantly, host-side, no
 * WebR round-trip. Because it edits the persisted view (not the model), every tweak
 * survives a project save/reopen.
 *
 * Controls: chart type (bars/lines), stacking (grouped/stacked/100%), palette,
 * legend placement, value labels, and a per-series list with colour pickers and
 * reordering (the "group order" the user asked for).
 */

import { PALETTES, DEFAULT_PALETTE, colorFor } from './chart-renderer.js';

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

  const isCategorical = model.kind === 'categorical';
  const multiSeries = (model.series || []).length > 1;

  // Rebuild the panel contents from the current view. Called on structural changes
  // (type/order) so dependent controls (e.g. stacking, only for bars) appear/vanish
  // and the series list re-sorts.
  const paint = () => {
    panel.replaceChildren();

    if (isCategorical) {
      panel.append(
        rowSelect('Type', [['bar', 'Bars'], ['line', 'Lines']], view.mark, (v) => {
          view.mark = v;
          paint();
          onChange();
        }),
      );
      if (view.mark === 'bar' && multiSeries) {
        panel.append(
          rowSelect('Stacking', [['none', 'Grouped'], ['stacked', 'Stacked'], ['percent', '100% stacked']], view.stack, (v) => {
            view.stack = v;
            onChange();
          }),
        );
      }
    }

    panel.append(
      rowSelect(
        'Palette',
        Object.entries(PALETTES).map(([k, p]) => [k, p.label]),
        view.palette || DEFAULT_PALETTE,
        (v) => {
          view.palette = v;
          paint(); // refresh the per-series swatches
          onChange();
        },
      ),
      rowSelect('Legend', [['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['none', 'Hidden']], view.legend, (v) => {
        view.legend = v;
        onChange();
      }),
      rowCheck('Value labels', !!view.valueLabels, (on) => {
        view.valueLabels = on;
        onChange();
      }),
    );

    // Per-series colour + order.
    if ((model.series || []).length) {
      const header = elem('div', 'results-chart__seriesheader');
      header.textContent = multiSeries ? 'Series (colour · order)' : 'Colour';
      panel.append(header);
      const list = elem('div', 'results-chart__series');
      view.seriesOrder.forEach((key, idx) => {
        const s = (model.series || []).find((x) => x.key === key);
        if (!s) return;
        const srow = elem('div', 'results-chart__srow');

        const color = document.createElement('input');
        color.type = 'color';
        color.className = 'results-chart__swatch';
        color.value = toHex(colorFor(view, key, idx));
        color.title = 'Series colour';
        color.addEventListener('input', () => {
          view.colors[key] = color.value;
          onChange();
        });

        const name = elem('span', 'results-chart__sname');
        name.textContent = s.label || key;
        name.title = s.label || key;

        srow.append(color, name);
        if (multiSeries) {
          const up = iconBtn('▲', 'Move up', idx === 0, () => {
            move(view.seriesOrder, idx, -1);
            paint();
            onChange();
          });
          const down = iconBtn('▼', 'Move down', idx === view.seriesOrder.length - 1, () => {
            move(view.seriesOrder, idx, +1);
            paint();
            onChange();
          });
          srow.append(up, down);
        }
        list.append(srow);
      });
      panel.append(list);

      if (Object.keys(view.colors).length) {
        panel.append(
          textBtn('Reset colours', () => {
            view.colors = {};
            paint();
            onChange();
          }),
        );
      }
    }
  };

  paint();
  return wrap;
}

// --- small DOM builders ------------------------------------------------------

function elem(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function rowSelect(labelText, options, value, onPick) {
  const row = elem('label', 'results-chart__row');
  const span = elem('span', 'results-chart__rowlabel');
  span.textContent = labelText;
  const sel = document.createElement('select');
  sel.className = 'results-chart__select';
  for (const [val, lab] of options) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = lab;
    if (val === value) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => onPick(sel.value));
  row.append(span, sel);
  return row;
}

function rowCheck(labelText, checked, onToggle) {
  const row = elem('label', 'results-chart__row results-chart__row--check');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onToggle(cb.checked));
  const span = elem('span', 'results-chart__rowlabel');
  span.textContent = labelText;
  row.append(cb, span);
  return row;
}

function iconBtn(glyph, title, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'results-chart__ord';
  b.textContent = glyph;
  b.title = title;
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

/** Coerce a colour (e.g. '#abc', '#aabbcc', or named) to '#rrggbb' for <input type=color>. */
function toHex(c) {
  if (typeof c === 'string') {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c.slice(1).split('').map((ch) => ch + ch).join('')).toLowerCase();
  }
  return '#2980b9';
}
