/**
 * @file charts/kinds/steps.js
 * Chart kind: step functions with an optional confidence band.
 */
import {
  colorFor,
  registerChartKind,
  paletteControl,
  legendControl,
  gridlinesControl,
  titleControls,
  axisControls,
  H,
  errorSvg,
  r,
  ordered,
  xyFrame,
  plural,
} from '../runtime.js';

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

registerChartKind('steps', {
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
