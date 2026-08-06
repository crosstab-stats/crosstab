/**
 * @file charts/kinds/forest.js
 * Chart kind: one estimate + CI per study, with a pooled summary diamond.
 */
import {
  colorFor,
  registerChartKind,
  gridlinesControl,
  titleControls,
  axisControls,
  W,
  AXIS,
  errorSvg,
  text,
  r,
  esc,
  clip,
  fmtNum,
  niceTicks,
  svgOpenH,
  chartAltText,
  plural,
} from '../runtime.js';

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

registerChartKind('forest', {
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
      `${plural(rows.length, 'study', 'studies')}${summary ? ', with a pooled summary' : ''}.`))];
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
