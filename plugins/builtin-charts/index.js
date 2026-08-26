/**
 * @file plugins/builtin-charts/index.js
 * Built-in plugin: **the chart engine**. Every data-driven figure CrossTab draws.
 *
 * Charts used to live in core. They do not any more, and the reason is the project's
 * own rule: "everything is a plugin" carries an asterisk only for things that genuinely
 * cannot work behind the sandbox boundary. Charts do not meet that bar, so out they go —
 * through the same door a third-party SuperCharts would use, with the same rights.
 *
 * ## What the host keeps, and what this plugin owns
 *
 * The host owns the chart RUNTIME: the kind registry, the view state, the controls
 * panel, the colour pickers, persistence, PNG/SVG export, and the results pane itself.
 * This plugin owns the chart TYPES. Same split as menus — the shell is the host's, the
 * items are not.
 *
 * ## Two verbs
 *
 * `manifest.charts` names the kinds and the factory that builds them. Each kind answers
 * exactly two calls:
 *
 *   describe(model) -> {altNoun, colorLabel, reorderCategories, colorItems,
 *                       controls, baseView}      // pure data, once per model
 *   render(model, view) -> svgString                                // per change
 *
 * There is no third verb because control *visibility* is resolved host-side from the
 * descriptors, which makes a kind's controls a pure function of the model. Twenty twiddles
 * of the options panel still cost one `describe`.
 *
 * ## Where the drawing code comes from
 *
 * `chartKinds(lib)` receives core's chart stdlib — palettes, SVG primitives, scales,
 * ticks, legends, `bandFrame`, `xyFrame`. A sandboxed opaque-origin frame cannot import
 * from core, so the host sends that module's SOURCE and the frame imports it here. That
 * indirection is load-bearing: there is ONE copy of the drawing code, in core, and a fix
 * to `niceTicks` reaches every chart plugin without anyone re-bundling anything.
 *
 * Consequently nothing in this file may import from core directly, and every kind takes
 * its helpers from `lib`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-charts',
  // "Chart engine", not "Charts". Sitting beside a plugin called "Plots", the two names
  // were synonyms in English and neither said which was which — the owner reasonably
  // disabled Plots to test chart behaviour, then could not tell why the options panel
  // survived. "Engine" says infrastructure, and explains why this one has no menu.
  name: 'Chart engine',
  version: '0.1.0',
  apiVersion: '0.1.0',
  // Filed under Graphs so it sorts directly above Plots in the plugin manager, where the
  // pairing is visible rather than something to infer. Category also picks the top-level
  // MENU, but this plugin contributes no menu items, so none appears.
  category: 'Graphs',
  keywords: ['chart', 'charts', 'plot', 'graph', 'figure', 'bar', 'line', 'scatter',
    'pie', 'violin', 'boxplot', 'box plot', 'dot plot', 'word cloud', 'forest plot',
    'kaplan-meier', 'survival curve', 'single-case', 'sced'],
  howto:
    'Draws every figure in CrossTab. It has no menu of its own — other plugins compute the numbers and hand them here to be drawn.\n' +
    'Eight plugins depend on it: Plots, Survival (Kaplan–Meier), Meta-analysis (forest), SCED, Factor, Time series, Text analytics and CAQDAS (word clouds).\n' +
    'Switch it off and: existing charts still SHOW their saved figure, but the ⚙ Chart options panel goes; and a NEW analysis reports which chart type is missing instead of drawing one.\n' +
    '  • Same rule as everywhere else — a result stays readable without the plugin that made it; you just cannot make or re-style another one.',
  // The declarative section. `kinds` is the list the host registers by name; `via` is
  // the exported factory that builds them. No app.charts.registerKind() verb exists:
  // the loader is explicit that a plugin can only do what a manifest section allows.
  charts: {
    via: 'chartKinds',
    kinds: ['categorical', 'scatter', 'pie', 'violin', 'dots', 'paired', 'box', 'steps', 'forest', 'sced', 'wordcloud'],
  },
};

/**
 * Build every chart kind, given the host's drawing stdlib.
 *
 * Called once, inside the sandbox, at load. Returns `name -> {describe, render}`; those
 * objects stay in this frame, because they hold functions and could never be posted to
 * the host. The host holds only the names and calls back in.
 *
 * @param {object} lib core/charts/stdlib.js, imported into this realm
 * @returns {Object<string, {describe: Function, render: Function}>}
 */
export function chartKinds(lib) {
  const {
    PALETTES, DEFAULT_PALETTE, colorFor, paletteControl, legendControl,
    valueLabelsControl, gridlinesControl, hasRawValues, pointOverlayControl,
    errorBarsControl, titleControls, axisControls, valueLabelFormatControls,
    W, H, FONT, AXIS, GRID, errorSvg, text, r, esc, clip, fmtNum,
    computeStats, errorBounds, jitterOffsets, minorTicks, niceTicks, niceNum,
    legendBlock, ordered, svgOpen, svgOpenH, chartAltText,
    bandFrame, xyFrame, plural, fiveNumber, kde, jitterFor,
  } = lib;

  /** name -> kind definition, in the shape the kind bodies below assign into. */
  const kinds = {};

  // --------------------------------------------------------------------------
  // categorical
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/categorical.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: grouped / stacked / 100%-stacked bars and lines.
   */

  // =============================================================================
  // KIND: categorical (grouped / stacked / 100%-stacked bars + lines)
  // =============================================================================

  kinds['categorical'] = ({
    altNoun: 'Chart',
    colorLabel: 'Series',
    reorderCategories: true,
    colorItems: (model) => (model.series || []).map((s) => ({ key: s.key, label: s.label || s.key })),
    baseView: (model) => ({
      mark: 'bar',
      stack: 'none',
      legend: (model.series || []).length > 1 ? 'right' : 'none',
    }),
    controls: (model) => {
      const multi = (model.series || []).length > 1;
      return [
      {
        id: 'mark', label: 'Type', type: 'select', structural: true, group: 'Chart', default: 'bar',
        options: [['bar', 'Bars'], ['line', 'Lines']],
      },
      // Stacking is meaningless for lines and for a single series. The line half is a
      // view dependency; the single-series half is a fact about the model, so it is
      // settled here by omitting the control rather than carried as a predicate.
      ...(multi ? [{
        id: 'stack', label: 'Stacking', type: 'select', group: 'Chart', default: 'none',
        options: [['none', 'Grouped'], ['stacked', 'Stacked'], ['percent', '100% stacked']],
        visibleWhen: { control: 'mark', equals: 'bar' },
      }] : []),
      pointOverlayControl(model),
      errorBarsControl(model),
      gridlinesControl(),
      paletteControl(multi),
      legendControl(multi, 'right'),
      valueLabelsControl(),
      ...valueLabelFormatControls(),
      ...titleControls(model),
      ...axisControls('x', model),
      ...axisControls('y', model),
      ];
    },
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

    const out = [svgOpen(chartAltText(model, view, `${cats.length} categories, ${series.length} series.`, 'Chart'))];
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


  // --------------------------------------------------------------------------
  // scatter
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/scatter.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: points, optional grouping, regression line.
   */

  // =============================================================================
  // KIND: scatter (points, optional grouping, regression line)
  // =============================================================================

  kinds['scatter'] = ({
    altNoun: 'Scatter plot',
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
    controls: (model) => {
      const multi = (model.groups || []).length > 1;
      return [
      ...(model.trend
        ? [{ id: 'trendLine', group: 'Chart', label: 'Trend line', type: 'check', default: false }]
        : []),
      {
        id: 'pointSize', label: 'Point size', type: 'select', group: 'Chart', valueType: 'number', default: 4,
        options: [['3', 'Small'], ['4', 'Medium'], ['6', 'Large']],
      },
      gridlinesControl(),
      paletteControl(multi),
      legendControl(multi, 'right'),
      ...titleControls(model),
      ...axisControls('x', model),
      ...axisControls('y', model),
      ];
    },
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

    const out = [svgOpen(chartAltText(model, view, `${pts.length} points.`, 'Scatter plot'))];
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


  // --------------------------------------------------------------------------
  // pie
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/pie.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: slices, start-angle rotation, percentage labels.
   */

  // =============================================================================
  // KIND: pie (slices, start-angle rotation, % labels)
  // =============================================================================

  kinds['pie'] = ({
    altNoun: 'Pie chart',
    colorLabel: 'Slices',
    reorderCategories: false,
    colorItems: (model) => (model.slices || []).map((s) => ({ key: s.key, label: s.label || s.key })),
    baseView: () => ({ legend: 'right', valueLabels: true, pieRotation: 0 }),
    controls: (model) => {
      const multi = (model.slices || []).length > 1;
      return [
        // `wrap` rather than clamp: 370° is a legitimate way to type 10°, and clamping it
        // to 360 would silently mean "no rotation" instead.
        { id: 'pieRotation', group: 'Chart', label: 'Rotate (°)', type: 'number', min: 0, max: 360, step: 15, wrap: 360, default: 0 },
        paletteControl(multi),
        legendControl(multi, 'right'),
        valueLabelsControl('Show %'),
      ];
    },
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

    const out = [svgOpen(chartAltText(model, view, `${slices.length} slices.`, 'Pie chart'))];
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


  // --------------------------------------------------------------------------
  // distribution
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/distribution.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: violin, dots and paired — the three band-frame distribution kinds.
   */

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
    // Colour items are the replicates when there are any, else the groups — so that is
    // what decides whether a palette and legend have anything to say.
    const multi = reps.length > 1 || (model.groups || []).length > 1;
    return [
      { id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart', default: true },
      {
        id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style', default: 3,
        // Note this is the SAME declaration as the boxplot's point-size dependency, even
        // though that kind defaults `showPoints` off and this one defaults it on. Naming
        // the control instead of the view key is what makes the two identical.
        visibleWhen: { control: 'showPoints', truthy: true },
      },
      {
        id: 'summary', label: 'Summary', type: 'select', group: 'Chart', default: 'median',
        options: [['median', 'Median + quartiles'], ['mean', 'Mean + SD'], ['none', 'None']],
      },
      // The SuperPlot convention (Lord et al. 2020): colour points by biological
      // replicate and mark each replicate's MEAN, so the reader sees that the effect
      // reproduces across experiments rather than across pooled cells.
      ...(reps.length > 1
        ? [{ id: 'replicateMeans', label: 'Replicate means', type: 'check', group: 'Chart', default: true }]
        : []),
      gridlinesControl(),
      paletteControl(multi),
      legendControl(multi, 'right'),
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

  kinds['violin'] = ({
    altNoun: 'Violin plot',
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
      { id: 'violinWidth', label: 'Violin width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart', default: 0.8 },
      ...distributionControls(model),
    ],
    render: (model, view) => {
      const groups = ordered(model.groups || [], view.seriesOrder)
        .filter((g) => (g.values || []).some(Number.isFinite));
      if (!groups.length) return errorSvg('Violin plot: no numeric values to plot.');
      const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
      const f = bandFrame(model, view, { noun: 'Violin plot',
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

  kinds['dots'] = ({
    altNoun: 'Dot plot',
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
      const f = bandFrame(model, view, { noun: 'Dot plot',
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

  kinds['paired'] = ({
    altNoun: 'Before-after plot',
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
        default: 'direction',
        options: [['direction', 'Direction of change'], ['subject', 'Subject'], ['none', 'One colour']],
      },
      { id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart', default: true },
      {
        id: 'summary', label: 'Group summary', type: 'select', group: 'Chart', default: 'mean',
        options: [['mean', 'Mean per condition'], ['none', 'None']],
      },
      gridlinesControl(),
      paletteControl(true),
      legendControl(true, 'none'),
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
        // Its own colour items — `kinds.paired` is this very definition. It used to ask
        // the registry for itself, which was always a detour and is now impossible: a
        // plugin has no registry. `colorItems` here takes the VIEW as well as the model,
        // because what gets a colour depends on the colourBy mode.
        : kinds.paired.colorItems(model, view).map((it, i) => ({
          label: it.label, color: colorFor(view, it.key, i),
        }));
      const f = bandFrame(model, view, { noun: 'Before-after plot', allValues, bands: conds.length, legendItems,
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


  // --------------------------------------------------------------------------
  // box
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/box.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: Tukey box-and-whisker.
   */

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

  kinds['box'] = ({
    altNoun: 'Boxplot',
    colorLabel: 'Groups',
    reorderCategories: false,
    colorItems: (model) => (model.groups || []).map((g) => ({ key: g.key, label: g.label || g.key })),
    baseView: (model) => ({
      summary: 'none', // the box IS the summary; the shared marks would double it
      showPoints: false,
      notch: false,
      legend: (model.groups || []).length > 1 ? 'none' : 'none',
    }),
    controls: (model) => {
      const multi = (model.groups || []).length > 1;
      return [
      { id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart', default: false },
      { id: 'showMean', label: 'Mark the mean', type: 'check', group: 'Chart', default: false },
      { id: 'boxWidth', label: 'Box width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart', default: 0.7 },
      {
        id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style', default: 3,
        visibleWhen: { control: 'showPoints', truthy: true },
      },
      gridlinesControl(),
      paletteControl(multi),
      legendControl(multi, 'none'),
      ...titleControls(model),
      ...axisControls('x', model),
      ...axisControls('y', model),
      ];
    },
    render: (model, view) => {
      const groups = ordered(model.groups || [], view.seriesOrder)
        .filter((g) => (g.values || []).some(Number.isFinite));
      if (!groups.length) return errorSvg('Boxplot: no numeric values to plot.');
      const stats = groups.map((g) => boxWhiskers(g.values.filter(Number.isFinite)));
      // The y domain must cover the OUTLIERS too, or they are drawn off the canvas.
      const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
      const f = bandFrame(model, view, { noun: 'Boxplot',
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


  // --------------------------------------------------------------------------
  // steps
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/steps.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: step functions with an optional confidence band.
   */

  // =============================================================================
  // KIND: steps (step functions with an optional confidence band)
  // =============================================================================

  /**
   * A step function per series, drawn as a staircase with an optional shaded CI band
   * and optional tick marks sitting on the line.
   *
   * Written for Kaplan–Meier but deliberately NOT called `km`: a survival curve is one
   * instance of "a quantity that holds its value until an event changes it", and so are
   * cumulative-incidence curves, empirical CDFs and hazard step plots. The kind models
   * the SHAPE; builtin-survival supplies the meaning by labelling the axes.
   *
   * The staircase matters statistically, not just visually. Joining (t1,s1) to (t2,s2)
   * with a straight line claims the estimate declined gradually across the interval, and
   * the Kaplan–Meier estimator claims precisely the opposite — nothing is known to have
   * happened between the two events, so the estimate is FLAT there and drops only at the
   * event. A line chart of the same numbers is a different, and wrong, statement.
   */

  /** A series' points as staircase path data: hold the value, then step to the next. */
  function stepPath(points, { xScale, yScale }) {
    const d = [];
    points.forEach((p, i) => {
      if (i === 0) d.push(`M ${r(xScale(p.x))} ${r(yScale(p.y))}`);
      else d.push(`H ${r(xScale(p.x))}`, `V ${r(yScale(p.y))}`);
    });
    return d.join(' ');
  }

  /** The CI ribbon as a closed polygon that steps in sympathy with the curve. */
  function stepBandPath(points, { xScale, yScale }) {
    const usable = points.filter((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));
    if (usable.length < 2) return '';
    const up = [];
    const down = [];
    usable.forEach((p, i) => {
      const x = r(xScale(p.x));
      if (i === 0) up.push(`M ${x} ${r(yScale(p.hi))}`);
      else up.push(`H ${x}`, `V ${r(yScale(p.hi))}`);
    });
    for (let i = usable.length - 1; i >= 0; i--) {
      const x = r(xScale(usable[i].x));
      if (i === usable.length - 1) down.push(`L ${x} ${r(yScale(usable[i].lo))}`);
      else down.push(`V ${r(yScale(usable[i].lo))}`, `H ${x}`);
    }
    return `${up.join(' ')} ${down.join(' ')} Z`;
  }

  kinds['steps'] = ({
    altNoun: 'Step chart',
    colorLabel: 'Curves',
    reorderCategories: false,
    colorItems: (model) => (model.series || []).map((s) => ({ key: s.key, label: s.label || s.key })),
    baseView: (model) => ({
      legend: (model.series || []).length > 1 ? 'right' : 'none',
      confidenceBand: stepsHaveBand(model),
      censorMarks: true,
      lineWidth: 2,
    }),
    controls: (model) => {
      const multi = (model.series || []).length > 1;
      const hasMarks = (model.series || []).some((s) => (s.marks || []).length);
      return [
      ...(stepsHaveBand(model)
        ? [{ id: 'confidenceBand', label: 'Confidence band', type: 'check', group: 'Chart', default: true }]
        : []),
      // The mark means "censored" for survival and something else elsewhere, so the
      // model names it rather than the kind assuming.
      ...(hasMarks
        ? [{ id: 'censorMarks', label: model.markLabel || 'Event marks', type: 'check', group: 'Chart', default: true }]
        : []),
      { id: 'lineWidth', label: 'Line width', type: 'number', min: 1, max: 5, step: 0.5, group: 'Style', default: 2 },
      gridlinesControl(),
      paletteControl(multi),
      legendControl(multi, 'right'),
      ...titleControls(model),
      ...axisControls('x', model),
      ...axisControls('y', model),
      ];
    },
    render: (model, view) => {
      const series = ordered(model.series || [], view.seriesOrder)
        .map((s) => ({ ...s, points: (s.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) }))
        .filter((s) => s.points.length);
      if (!series.length) return errorSvg('Step chart: no points to plot.');

      const xValues = series.flatMap((s) => s.points.map((p) => p.x));
      const yValues = series.flatMap((s) => s.points.flatMap((p) => [
        p.y,
        ...(view.confidenceBand && Number.isFinite(p.lo) ? [p.lo] : []),
        ...(view.confidenceBand && Number.isFinite(p.hi) ? [p.hi] : []),
      ]));
      const f = xyFrame(model, view, { noun: 'Step chart',
        xValues,
        yValues,
        legendItems: view.legend !== 'none' && series.length > 1
          ? series.map((s, i) => ({ label: s.label || s.key, color: colorFor(view, s.key, i) })) : [],
        alt: `${plural(series.length, 'curve')}, ${plural(xValues.length, 'step')}.`,
      });

      series.forEach((s, si) => {
        const colour = colorFor(view, s.key, si);
        if (view.confidenceBand) {
          const band = stepBandPath(s.points, f);
          if (band) f.out.push(`<path d="${band}" fill="${colour}" fill-opacity="0.15" stroke="none"/>`);
        }
        f.out.push(`<path d="${stepPath(s.points, f)}" fill="none" stroke="${colour}" `
          + `stroke-width="${r(view.lineWidth || 2)}" stroke-linejoin="miter"/>`);

        // Censoring ticks: short verticals ON the curve, the convention readers of
        // survival curves already know (R's own `mark.time = TRUE` draws the same).
        if (view.censorMarks !== false) {
          for (const m of s.marks || []) {
            if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
            const x = f.xScale(m.x);
            const y = f.yScale(m.y);
            f.out.push(`<line x1="${r(x)}" y1="${r(y - 4)}" x2="${r(x)}" y2="${r(y + 4)}" stroke="${colour}" stroke-width="${r((view.lineWidth || 2) * 0.8)}"/>`);
          }
        }
      });

      return f.close();
    },
  });

  /** Does any point carry a confidence interval? Gates the band control and default. */
  function stepsHaveBand(model) {
    return (model.series || []).some((s) => (s.points || []).some((p) => Number.isFinite(p.lo)));
  }


  // --------------------------------------------------------------------------
  // forest
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/forest.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: one estimate + CI per study, with a pooled summary diamond.
   */

  // =============================================================================
  // KIND: forest (one estimate + CI per study, with a pooled summary diamond)
  // =============================================================================

  /**
   * The standard meta-analysis figure: a row per study showing its effect estimate as a
   * box (area ∝ its weight in the pool) with a confidence interval whisker, a reference
   * line at the null, and a diamond for the pooled estimate.
   *
   * Three conventions here are load-bearing rather than decorative, and getting any of
   * them wrong makes the figure misreport the analysis:
   *
   *  - **Box AREA tracks weight, so the side scales with √weight.** Sizing the side
   *    linearly makes a study with 4× the weight look 16× as important. Readers judge
   *    these marks by area, and the whole point of the box is to show at a glance which
   *    studies are driving the pooled estimate.
   *  - **The diamond spans the pooled CI**, it is not a scaled-up study box. Its width
   *    IS the interval; that is why a diamond is used instead of another box.
   *  - **Ratio measures need a log axis.** On a linear axis a halving (0.5) and a
   *    doubling (2.0) sit at wildly different distances from 1.0, so a symmetric CI is
   *    drawn lopsided and the null line lands off-centre. `logScale` puts them right.
   */

  /** Rows drawn, in model order, dropping any without a finite estimate. */
  function forestRows(model) {
    return (model.studies || []).filter((s) => Number.isFinite(s.est));
  }

  /** Transform for the x axis — identity, or log for ratio measures. */
  function forestAxis(view) {
    const log = !!view.logScale;
    return {
      fwd: (v) => (log ? Math.log(v) : v),
      ok: (v) => Number.isFinite(v) && (!log || v > 0),
    };
  }

  kinds['forest'] = ({
    altNoun: 'Forest plot',
    colorLabel: 'Studies',
    reorderCategories: false,
    // One colour item, not one per study: a forest plot is a single population of
    // estimates and colouring each study differently implies a grouping that is not
    // there. Users who want to highlight a subgroup can still override one key.
    colorItems: () => [{ key: '__studies__', label: 'Studies' }],
    baseView: (model) => ({
      legend: 'none',
      gridlines: false,
      logScale: !!model.logScale,
      showWeights: true,
      showValues: true,
      rowHeight: 22,
    }),
    controls: (model) => [
      { id: 'logScale', label: 'Log scale (ratio measures)', type: 'check', group: 'Chart', structural: true, default: false },
      { id: 'showValues', label: 'Estimate column', type: 'check', group: 'Labels', default: true },
      ...(forestRows(model).some((s) => Number.isFinite(s.weight))
        ? [{ id: 'showWeights', label: 'Weight column', type: 'check', group: 'Labels', default: true }]
        : []),
      { id: 'rowHeight', label: 'Row height', type: 'number', min: 14, max: 40, step: 2, group: 'Style', default: 22 },
      gridlinesControl(),
      ...titleControls(model),
      ...axisControls('x', model),
    ],
    render: (model, view) => {
      const rows = forestRows(model);
      if (!rows.length) return errorSvg('Forest plot: no study estimates to plot.');
      const ax = forestAxis(view);
      const summary = model.summary && Number.isFinite(model.summary.est) ? model.summary : null;
      const hasWeights = view.showWeights !== false && rows.some((s) => Number.isFinite(s.weight));

      const title = view.titleText || model.title;
      const xTitle = view.xAxisTitle || model.axes?.x?.title;
      const rowH = view.rowHeight || 22;

      // Height is driven by the study count — a 40-study meta-analysis cannot be squeezed
      // into the shared 460px canvas without the rows colliding.
      const mTop = (title ? 34 : 14) + 18; // + column header strip
      const mBottom = 40 + (xTitle ? 16 : 0);
      const bodyH = rowH * rows.length + (summary ? rowH * 1.6 : 0);
      const height = mTop + bodyH + mBottom;

      // Left column holds study labels, right column the numeric readout.
      const labelW = Math.min(210, Math.max(90, Math.max(...rows.map((s) => String(s.label || s.key).length)) * 6.2 + 12));
      const valueW = (view.showValues !== false ? 118 : 0) + (hasWeights ? 52 : 0);
      const box = { x0: 12 + labelW, x1: W - 12 - valueW, y0: mTop, y1: mTop + bodyH };

      const finite = [];
      for (const s of rows) {
        for (const v of [s.est, s.lo, s.hi]) if (ax.ok(v)) finite.push(ax.fwd(v));
      }
      if (summary) for (const v of [summary.est, summary.lo, summary.hi]) if (ax.ok(v)) finite.push(ax.fwd(v));
      const refRaw = Number.isFinite(model.refLine) ? model.refLine : (view.logScale ? 1 : 0);
      if (ax.ok(refRaw)) finite.push(ax.fwd(refRaw));

      const userMin = Number.isFinite(view.xAxisMin) && ax.ok(view.xAxisMin);
      const userMax = Number.isFinite(view.xAxisMax) && ax.ok(view.xAxisMax);
      const lo = userMin ? ax.fwd(view.xAxisMin) : Math.min(...finite);
      const hi = userMax ? ax.fwd(view.xAxisMax) : Math.max(...finite);
      const pad = (hi - lo) * 0.06 || 1;
      const xLo = lo - pad;
      const xHi = hi + pad;
      const xScale = (v) => box.x0 + ((ax.fwd(v) - xLo) / (xHi - xLo || 1)) * (box.x1 - box.x0);

      const out = [svgOpenH(height, chartAltText(model, view,
        `${plural(rows.length, 'study', 'studies')}${summary ? ', with a pooled summary' : ''}.`, 'Forest plot'))];
      if (title) {
        out.push(text(W / 2, 21, esc(title), {
          size: view.titleSize || 15, weight: view.titleBold !== false ? 600 : 400,
          italic: !!view.titleItalic, anchor: 'middle', fill: '#222',
        }));
      }

      // Column headings.
      const headY = mTop - 6;
      out.push(text(12, headY, esc(model.labelHeading || 'Study'), { size: 10.5, fill: '#555', weight: 600 }));
      if (view.showValues !== false) {
        out.push(text(W - 12, headY, esc(model.valueHeading || 'Estimate [95% CI]'),
          { size: 10.5, anchor: 'end', fill: '#555', weight: 600 }));
      }
      if (hasWeights) {
        out.push(text(box.x1 + 46, headY, 'Weight', { size: 10.5, anchor: 'end', fill: '#555', weight: 600 }));
      }

      // Null-effect reference line, drawn behind the estimates.
      if (ax.ok(refRaw)) {
        const rx = xScale(refRaw);
        out.push(`<line x1="${r(rx)}" y1="${r(box.y0 - 4)}" x2="${r(rx)}" y2="${r(box.y1 + 4)}" stroke="#888" stroke-width="1" stroke-dasharray="4 3"/>`);
      }

      const colour = colorFor(view, '__studies__', 0);
      const maxW = Math.max(...rows.map((s) => (Number.isFinite(s.weight) ? s.weight : 1)), 1);
      const fmtCi = (e, l, h) => `${fmtNum(e)} [${ax.ok(l) ? fmtNum(l) : '–'}, ${ax.ok(h) ? fmtNum(h) : '–'}]`;

      rows.forEach((s, i) => {
        const cy = box.y0 + rowH * (i + 0.5);
        out.push(text(12, cy + 4, esc(clip(s.label || s.key, Math.floor(labelW / 6.2))), { size: 11, fill: '#333' }));

        if (ax.ok(s.lo) && ax.ok(s.hi)) {
          out.push(`<line x1="${r(xScale(s.lo))}" y1="${r(cy)}" x2="${r(xScale(s.hi))}" y2="${r(cy)}" stroke="${colour}" stroke-width="1.2"/>`);
          for (const e of [s.lo, s.hi]) {
            out.push(`<line x1="${r(xScale(e))}" y1="${r(cy - 3.5)}" x2="${r(xScale(e))}" y2="${r(cy + 3.5)}" stroke="${colour}" stroke-width="1.2"/>`);
          }
        }
        // √weight, so the reader's area-based judgement matches the actual weighting.
        const side = Math.max(4, Math.min(rowH * 0.72, rowH * 0.72 * Math.sqrt((Number.isFinite(s.weight) ? s.weight : maxW) / maxW)));
        const bx = xScale(s.est);
        out.push(`<rect x="${r(bx - side / 2)}" y="${r(cy - side / 2)}" width="${r(side)}" height="${r(side)}" fill="${colour}"/>`);

        if (view.showValues !== false) {
          out.push(text(W - 12, cy + 4, esc(fmtCi(s.est, s.lo, s.hi)), { size: 10.5, anchor: 'end', fill: '#333' }));
        }
        if (hasWeights && Number.isFinite(s.weight)) {
          out.push(text(box.x1 + 46, cy + 4, `${fmtNum(s.weight)}%`, { size: 10.5, anchor: 'end', fill: '#555' }));
        }
      });

      if (summary) {
        const cy = box.y0 + rowH * rows.length + rowH * 0.8;
        const half = rowH * 0.3;
        const cxE = xScale(summary.est);
        const cxL = ax.ok(summary.lo) ? xScale(summary.lo) : cxE;
        const cxH = ax.ok(summary.hi) ? xScale(summary.hi) : cxE;
        out.push(`<polygon points="${r(cxL)},${r(cy)} ${r(cxE)},${r(cy - half)} ${r(cxH)},${r(cy)} ${r(cxE)},${r(cy + half)}" fill="#222222"/>`);
        out.push(text(12, cy + 4, esc(summary.label || 'Pooled estimate'), { size: 11, fill: '#222', weight: 600 }));
        if (view.showValues !== false) {
          out.push(text(W - 12, cy + 4, esc(fmtCi(summary.est, summary.lo, summary.hi)),
            { size: 10.5, anchor: 'end', fill: '#222', weight: 600 }));
        }
      }

      // x axis under the estimate column only — it measures effect size, and running it
      // beneath the study names would imply those columns share the scale.
      const axisY = box.y1 + 12;
      out.push(`<line x1="${r(box.x0)}" y1="${r(axisY)}" x2="${r(box.x1)}" y2="${r(axisY)}" stroke="${AXIS}" stroke-width="1"/>`);
      const ticks = niceTicks(xLo, xHi, 6);
      for (const t of ticks) {
        if (t < xLo - 1e-9 || t > xHi + 1e-9) continue;
        const shown = view.logScale ? Math.exp(t) : t;
        const x = box.x0 + ((t - xLo) / (xHi - xLo || 1)) * (box.x1 - box.x0);
        out.push(`<line x1="${r(x)}" y1="${r(axisY)}" x2="${r(x)}" y2="${r(axisY + 4)}" stroke="${AXIS}" stroke-width="1"/>`);
        out.push(text(x, axisY + 16, fmtNum(shown), { size: 10.5, anchor: 'middle', fill: AXIS }));
      }
      if (xTitle) {
        out.push(text((box.x0 + box.x1) / 2, height - 6, esc(xTitle),
          { size: view.xAxisTitleSize || 12, anchor: 'middle', fill: '#333' }));
      }
      out.push('</svg>');
      return out.join('');
    },
  });


  // --------------------------------------------------------------------------
  // sced
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/sced.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: single-case experimental design — multiple-baseline panels.
   */

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

  kinds['sced'] = ({
    altNoun: 'Single-case design chart',
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
    controls: (model) => {
      const panels = (model.panels || []).length;
      // Mirrors colorItems: measures carry the colour when panels declare any, else phases.
      const series = scedSeriesKeys(model);
      const multi = (series.length ? series : (model.phases || [])).length > 1;
      // In black & white every phase is the same ink, so a palette chooser and a colour
      // legend would both be lying about carrying information. Phase is read off the
      // staircase and the condition labels instead — which is the convention's whole point.
      const notMono = { control: 'mono', truthy: false };
      return [
      {
        id: 'mark', label: 'Draw', type: 'select', structural: true, group: 'Chart', default: 'both',
        options: [['both', 'Points + lines'], ['points', 'Points only'], ['line', 'Lines only']],
      },
      { id: 'connectAcross', label: 'Connect across phase change', type: 'check', group: 'Chart', default: false },
      { id: 'phaseLines', label: 'Phase change lines', type: 'check', group: 'Phases', default: true },
      {
        id: 'caseLabel', label: 'Case label', type: 'select', structural: true, group: 'Panels',
        // The default depends on the model (one panel wants the label inside it), which
        // is known here — so it is resolved now rather than carried as a predicate.
        default: panels > 1 ? 'axis' : 'panel',
        options: [['axis', 'Beside the Y axis'], ['panel', 'Inside the panel'], ['none', 'Hidden']],
      },
      ...(panels > 1 ? [{
        id: 'panelOrder', label: 'Panel order', type: 'select', structural: true, group: 'Panels', default: 'stagger',
        options: [['stagger', 'By phase change (staircase)'], ['model', 'As in the data']],
      }] : []),
      ...(panels > 1 ? [{
        id: 'staircase', label: 'Connect as staircase', type: 'check', group: 'Phases', default: false,
        visibleWhen: { control: 'phaseLines', truthy: true },
      }] : []),
      {
        id: 'phaseLineStyle', label: 'Phase line', type: 'select', group: 'Phases', default: 'solid',
        options: [['solid', 'Solid'], ['dashed', 'Dashed']],
        visibleWhen: { control: 'phaseLines', truthy: true },
      },
      { id: 'mono', label: 'Black & white (print)', type: 'check', structural: true, group: 'Style', default: false },
      {
        id: 'phaseLabels', label: 'Condition labels', type: 'select', group: 'Phases', default: 'top',
        options: [['top', 'Top panel only'], ['all', 'Every panel'], ['none', 'Hidden']],
      },
      ...(panels > 1
        ? [{ id: 'sharedY', label: 'Same Y scale on all panels', type: 'check', group: 'Panels', default: true }]
        : []),
      { id: 'panelHeight', label: 'Panel height', type: 'number', min: 70, max: 320, step: 10, group: 'Panels', default: 130 },
      { id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style', default: 3.5 },
      { id: 'yTickCount', label: 'Y tick count', type: 'number', min: 2, max: 11, step: 1, group: 'Style', default: 5 },
      gridlinesControl(),
      multi ? { ...paletteControl(true), visibleWhen: notMono } : null,
      multi ? { ...legendControl(true, 'right'), visibleWhen: notMono } : null,
      ...titleControls(model),
      ...axisControls('x', model),
      ...axisControls('y', model),
      ];
    },
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

    const out = [svgOpenH(totalH, chartAltText(model, view, `${panels.length} ${panels.length === 1 ? "case" : "cases"}, ${multiSeries ? seriesKeys.length + " measures" : phaseList.length + " phases"}.`, 'Single-case design chart'))];
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


  // --------------------------------------------------------------------------
  // wordcloud
  // --------------------------------------------------------------------------

  /**
   * Chart kind — was charts/kinds/wordcloud.js before the kinds moved into this plugin (#131 L3)
   * Chart kind: one field, or partitioned into labelled themes.
   */

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

  kinds['wordcloud'] = ({
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
        ...(themed ? [{
          id: 'layout', label: 'Layout', type: 'select', structural: true, group: 'Chart',
          default: 'clustered',
          options: [['single', 'One cloud'], ['clustered', 'Grouped by theme']],
        }] : []),
        { id: 'maxWords', label: 'Max words', type: 'number', min: 10, max: 400, step: 10, group: 'Chart', default: 120 },
        { id: 'minSize', label: 'Smallest text', type: 'number', min: 6, max: 24, step: 1, group: 'Style', default: 11 },
        { id: 'maxSize', label: 'Largest text', type: 'number', min: 16, max: 90, step: 2, group: 'Style', default: 44 },
        // Hidden when the caller supplied colours: offering a palette that cannot take
        // effect is worse than offering nothing (see the gridlines lesson — a control
        // with no visible effect reads as broken).
        paletteControl(themed && !authored),
        legendControl(themed, 'none'),
        // …and say WHY the palette is missing, rather than leaving a hole. This used to
        // be a permanently-checked checkbox, which was the very sin the comment above
        // warns about: a control that cannot do anything. `note` is inert by construction.
        ...(authored
          ? [{ id: 'authorColours', type: 'note', group: 'Style', label: 'Colours come from the data, so the palette does not apply.' }]
          : []),
        ...titleControls(model),
      ];
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
        `${plural(words.length, 'word')}${themes.length > 1 ? `, ${plural(themes.length, 'theme')}` : ''}.`, 'Word cloud'))];
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


  // Adapt each definition to the two-verb wire contract. `describe` is the same
  // computation core used to do in `chartSpecOf`; it lives here now because the kind,
  // not the host, is what knows its own controls and colour items.
  const out = {};
  for (const [name, kd] of Object.entries(kinds)) {
    out[name] = {
      describe: (model) => ({
        altNoun: kd.altNoun || 'Chart',
        colorLabel: (typeof kd.colorLabel === 'function' ? kd.colorLabel(model) : kd.colorLabel) || 'Series',
        reorderCategories: !!kd.reorderCategories,
        colorItems: kd.colorItems ? kd.colorItems(model) : [],
        // Shared builders return null when a control does not apply to this model, so
        // a kind can list them flat.
        controls: (kd.controls ? kd.controls(model) : []).filter(Boolean),
        baseView: kd.baseView ? kd.baseView(model) : {},
      }),
      render: (model, view) => kd.render(model, view),
    };
  }
  return out;
}
