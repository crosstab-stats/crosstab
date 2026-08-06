/**
 * @file charts/kinds/sced.js
 * Chart kind: single-case experimental design — multiple-baseline panels.
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
  AXIS,
  GRID,
  errorSvg,
  text,
  r,
  esc,
  clip,
  fmtNum,
  niceTicks,
  legendBlock,
  ordered,
  svgOpenH,
  chartAltText,
} from '../runtime.js';

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

registerChartKind('sced', {
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
