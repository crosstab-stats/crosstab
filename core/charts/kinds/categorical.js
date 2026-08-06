/**
 * @file charts/kinds/categorical.js
 * Chart kind: grouped / stacked / 100%-stacked bars and lines.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  valueLabelsControl,
  gridlinesControl,
  titleControls,
  axisControls,
  valueLabelFormatControls,
  pointOverlayControl,
  errorBarsControl,
  W,
  H,
  AXIS,
  GRID,
  text,
  r,
  esc,
  fmtNum,
  computeStats,
  errorBounds,
  jitterOffsets,
  minorTicks,
  niceTicks,
  legendBlock,
  ordered,
  svgOpen,
  chartAltText,
} from '../runtime.js';

// =============================================================================
// KIND: categorical (grouped / stacked / 100%-stacked bars + lines)
// =============================================================================

registerChartKind('categorical', {
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

  const out = [svgOpen(chartAltText(model, view, `${cats.length} categories, ${series.length} series.`))];
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
