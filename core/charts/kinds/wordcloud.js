/**
 * @file charts/kinds/wordcloud.js
 * Chart kind: one field, or partitioned into labelled themes.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  titleControls,
  W,
  H,
  errorSvg,
  text,
  r,
  esc,
  clip,
  legendBlock,
  svgOpen,
  chartAltText,
  plural,
} from '../runtime.js';

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
  altNoun: 'Word cloud',
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
