/**
 * @file charts/kinds/box.js
 * Chart kind: Tukey box-and-whisker.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  gridlinesControl,
  titleControls,
  axisControls,
  errorSvg,
  r,
  ordered,
  bandFrame,
  plural,
  fiveNumber,
  jitterFor,
} from '../runtime.js';

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

registerChartKind('box', {
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
  controls: (model) => [
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => !!v.showPoints, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'showMean', label: 'Mark the mean', type: 'check', group: 'Chart',
      get: (v) => !!v.showMean, set: (v, x) => { v.showMean = x; },
    },
    {
      id: 'boxWidth', label: 'Box width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart',
      get: (v) => v.boxWidth ?? 0.7, set: (v, x) => { v.boxWidth = Number(x) || undefined; },
    },
    {
      id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style',
      get: (v) => v.pointSize || 3, set: (v, x) => { v.pointSize = Number(x) || undefined; },
      visible: (v) => !!v.showPoints,
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
    ...titleControls(model),
    ...axisControls('x', model),
    ...axisControls('y', model),
  ],
  render: (model, view) => {
    const groups = ordered(model.groups || [], view.seriesOrder)
      .filter((g) => (g.values || []).some(Number.isFinite));
    if (!groups.length) return errorSvg('Boxplot: no numeric values to plot.');
    const stats = groups.map((g) => boxWhiskers(g.values.filter(Number.isFinite)));
    // The y domain must cover the OUTLIERS too, or they are drawn off the canvas.
    const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
    const f = bandFrame(model, view, {
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
