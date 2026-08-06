/**
 * @file charts/kinds/scatter.js
 * Chart kind: points, optional grouping, regression line.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  gridlinesControl,
  titleControls,
  axisControls,
  W,
  H,
  AXIS,
  GRID,
  text,
  r,
  esc,
  fmtNum,
  minorTicks,
  niceTicks,
  legendBlock,
  ordered,
  svgOpen,
  chartAltText,
} from '../runtime.js';

// =============================================================================
// KIND: scatter (points, optional grouping, regression line)
// =============================================================================

registerChartKind('scatter', {
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

  const out = [svgOpen(chartAltText(model, view, `${pts.length} points.`))];
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
