/**
 * @file charts/kinds/distribution.js
 * Chart kind: violin, dots and paired — the three band-frame distribution kinds.
 */
import {
  colorFor,
  registerChartKind,
  getChartKind,
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
  kde,
  jitterFor,
} from '../runtime.js';

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
  return [
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => v.showPoints !== false, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'pointSize', label: 'Point size', type: 'number', min: 1, max: 10, step: 0.5, group: 'Style',
      get: (v) => v.pointSize || 3, set: (v, x) => { v.pointSize = Number(x) || undefined; },
      visible: (v) => v.showPoints !== false,
    },
    {
      id: 'summary', label: 'Summary', type: 'select', group: 'Chart',
      options: [['median', 'Median + quartiles'], ['mean', 'Mean + SD'], ['none', 'None']],
      get: (v) => v.summary || 'median', set: (v, x) => { v.summary = x; },
    },
    {
      // The SuperPlot convention (Lord et al. 2020): colour points by biological
      // replicate and mark each replicate's MEAN, so the reader sees that the effect
      // reproduces across experiments rather than across pooled cells.
      id: 'replicateMeans', label: 'Replicate means', type: 'check', group: 'Chart',
      get: (v) => v.replicateMeans !== false, set: (v, x) => { v.replicateMeans = x; },
      visible: () => reps.length > 1,
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
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

registerChartKind('violin', {
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
    {
      id: 'violinWidth', label: 'Violin width', type: 'number', min: 0.2, max: 1, step: 0.1, group: 'Chart',
      get: (v) => v.violinWidth ?? 0.8, set: (v, x) => { v.violinWidth = Number(x) || undefined; },
    },
    ...distributionControls(model),
  ],
  render: (model, view) => {
    const groups = ordered(model.groups || [], view.seriesOrder)
      .filter((g) => (g.values || []).some(Number.isFinite));
    if (!groups.length) return errorSvg('Violin plot: no numeric values to plot.');
    const allValues = groups.flatMap((g) => g.values.filter(Number.isFinite));
    const f = bandFrame(model, view, {
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

registerChartKind('dots', {
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
    const f = bandFrame(model, view, {
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

registerChartKind('paired', {
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
      options: [['direction', 'Direction of change'], ['subject', 'Subject'], ['none', 'One colour']],
      get: (v) => v.colourBy || 'direction', set: (v, x) => { v.colourBy = x; },
    },
    {
      id: 'showPoints', label: 'Show data points', type: 'check', group: 'Chart',
      get: (v) => v.showPoints !== false, set: (v, x) => { v.showPoints = x; },
    },
    {
      id: 'summary', label: 'Group summary', type: 'select', group: 'Chart',
      options: [['mean', 'Mean per condition'], ['none', 'None']],
      get: (v) => v.summary || 'mean', set: (v, x) => { v.summary = x; },
    },
    { ...gridlinesControl(), group: 'Style' },
    { ...paletteControl(), group: 'Style' },
    { ...legendControl(), group: 'Style' },
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
      : getChartKind('paired').colorItems(model, view).map((it, i) => ({
        label: it.label, color: colorFor(view, it.key, i),
      }));
    const f = bandFrame(model, view, { allValues, bands: conds.length, legendItems,
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
