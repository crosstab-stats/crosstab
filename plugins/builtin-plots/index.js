/**
 * @file plugins/builtin-plots/index.js
 * Built-in plugin: the **Graphs** menu — histogram, scatter (+ trend line),
 * boxplot, pie chart, and a bar chart with error bars.
 *
 * **Every chart here is data-driven (#131).** Each aggregates in JS and emits a
 * structured chart MODEL to `app.results.appendChart`; the host renders the SVG and
 * the user can re-order, recolour, re-stack and re-title it live (see
 * core/chart-renderer.js), with the result persisted and still editable after reload.
 *
 * **This plugin needs no R at all.** Boxplot was the last holdout — it went to an
 * `svglite` device for a finished picture, which by definition has nothing left to
 * control — and it moved to the `box` kind on 2026-08-05 once `fiveNumber()` existed.
 * With it went the whole R harness (`renderPlot`/`drawSvg`/`redrawPlot`) and the
 * `svglite` dependency, so the Graphs menu now works instantly and offline with no
 * package download.
 *
 * (The header previously claimed histogram and bar+error-bars were R-baked as well.
 * Both had been migrated long before and nobody updated the note, so it under-reported
 * our own progress — worth remembering that stale comments mislead in both directions.)
 *
 * Declarative plugin with **multiple** menu items: the manifest declares one menu
 * entry per chart, each with its own inputs and a named function. (Plots still
 * inject via `df` explicitly so a chart's "Redraw at this size" callback — which
 * fires after the action has returned — can re-run with the data re-injected.)
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-plots',
  name: 'Plots',
  version: '0.8.0',
  apiVersion: '0.1.0',
  category: 'Graphs',
  keywords: ['chart', 'histogram', 'scatter', 'boxplot', 'bar', 'pie', 'plot'],
  howto:
    'GUI: Graphs ▸ Histogram, Scatter, Trends over time, Boxplot, Pie chart, or Bar chart with error bars — pick the variables. ' +
    'Data-driven charts (scatter, trends, pie) render as live, re-editable chart models; others are baked SVG plots.\n' +
    'Syntax: run builtin-plots.histogram {"v": "age"}\n' +
    'Syntax: run builtin-plots.scatter {"x": "age", "y": "income"}\n' +
    'Syntax: run builtin-plots.trends {"x": "year", "g": "bracket", "y": "income", "summary": "percent", "display": "lines"}\n' +
    'Syntax: run builtin-plots.violin {"y": "score", "g": "dose", "rep": "experiment"}\n' +
    'Syntax: run builtin-plots.dotplot {"y": "score", "g": "dose"}\n' +
    'Syntax: run builtin-plots.beforeAfter {"vars": ["pre", "post"], "idVar": "subject"}\n' +
    '  • violin/dotplot: supply `rep` (a replicate column) to get a SuperPlot — points coloured by replicate with each replicate mean marked.\n' +
    '  • trends summary — "percent" (default) | "count" | "mean" (needs y); display — "lines" (default) | "stacked" | "stacked100".\n' +
    '  • other charts: Boxplot — run builtin-plots.boxplot {"y": "income", "g": "region"}; ' +
    'Pie — run builtin-plots.pie {"v": "region"}; Bar+error bars — run builtin-plots.errorBars {"y": "income", "g": "region"}.',
  menu: [
    {
      label: 'Histogram…',
      run: 'histogram',
      order: 10,
      inputs: [{ name: 'v', kind: 'variables', hint: 'The numeric variable whose distribution you want to see.', multiple: false, types: ['numeric'] }],
    },
    {
      label: 'Scatter…',
      run: 'scatter',
      order: 20,
      inputs: [
        { name: 'x', kind: 'variables', label: 'X', hint: 'The variable on the horizontal axis.', multiple: false, types: ['numeric'], unique: true },
        { name: 'y', kind: 'variables', label: 'Y', hint: 'The variable on the vertical axis.', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Trends over time…',
      run: 'trends',
      order: 25,
      inputs: [
        { name: 'x', kind: 'variables', label: 'X axis', hint: 'The axis to plot across — often a time variable like year.', multiple: false, types: ['numeric', 'factor', 'string'], unique: true },
        { name: 'g', kind: 'variables', label: 'Group (optional)', hint: 'A category to draw one line / bar segment per group (e.g. income bracket). Omit for a single series.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
        { name: 'y', kind: 'variables', label: 'Measure (optional)', hint: 'A numeric measure — used only when “Value” is Mean.', multiple: false, types: ['numeric'], optional: true, unique: true },
        {
          name: 'summary',
          kind: 'choice',
          label: 'Value',
          hint: 'Percent within each X (composition), a case count, or the mean of a measure.',
          default: 'percent',
          options: [
            { value: 'percent', label: '% within each X (e.g. income mix per year)' },
            { value: 'count', label: 'Count of cases' },
            { value: 'mean', label: 'Mean of the measure' },
          ],
        },
        {
          name: 'display',
          kind: 'choice',
          label: 'Display as',
          hint: 'Lines for trends; stacked bars for absolute composition; 100% stacked to compare shares.',
          default: 'lines',
          options: [
            { value: 'lines', label: 'Lines' },
            { value: 'stacked', label: 'Stacked bars' },
            { value: 'stacked100', label: '100% stacked bars' },
          ],
        },
      ],
    },
    {
      label: 'Boxplot…',
      run: 'boxplot',
      order: 30,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Variable', hint: 'The numeric measure to summarize with the box.', multiple: false, types: ['numeric'] },
        { name: 'g', kind: 'variables', label: 'Split by (optional)', hint: 'A grouping variable to draw one box per group.', multiple: false, types: ['factor', 'string'], optional: true },
      ],
    },
    {
      label: 'Pie chart…',
      run: 'pie',
      order: 40,
      inputs: [{ name: 'v', kind: 'variables', hint: 'The category variable whose shares form the slices.', multiple: false, types: ['factor', 'string'] }],
    },
    {
      label: 'Bar chart with error bars…',
      run: 'errorBars',
      order: 50,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Measure', hint: 'The numeric measure whose group means are plotted.', multiple: false, types: ['numeric'] },
        { name: 'g', kind: 'variables', label: 'Groups', hint: 'The variable defining the bars to compare.', multiple: false, types: ['factor', 'string'] },
      ],
    },
    {
      label: 'Violin plot…',
      run: 'violin',
      order: 60,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Measure', hint: 'The numeric measure whose distribution shape you want to see.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups (optional)', hint: 'A category to draw one violin per group. Omit for a single distribution.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
        { name: 'rep', kind: 'variables', label: 'Replicate (optional)', hint: 'Biological/experimental replicate. Supply it to get a SuperPlot: points coloured by replicate, with each replicate’s mean marked.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
      ],
    },
    {
      label: 'Dot plot (column scatter)…',
      run: 'dotplot',
      order: 70,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Measure', hint: 'The numeric measure — every observation is drawn.', multiple: false, types: ['numeric'], unique: true },
        { name: 'g', kind: 'variables', label: 'Groups (optional)', hint: 'A category to draw one column per group.', multiple: false, types: ['factor', 'string'], optional: true, unique: true },
        { name: 'rep', kind: 'variables', label: 'Replicate (optional)', hint: 'Biological/experimental replicate. Supply it to get a SuperPlot: points coloured by replicate, with each replicate’s mean marked.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
      ],
    },
    {
      label: 'Before-after plot…',
      run: 'beforeAfter',
      order: 80,
      inputs: [
        { name: 'vars', kind: 'variables', label: 'Conditions', hint: 'Two or more columns measured on the same subjects (e.g. pre and post). One line is drawn per row.', multiple: true, types: ['numeric'] },
        { name: 'idVar', kind: 'variables', label: 'Subject id (optional)', hint: 'Labels each line. Omit to number the rows.', multiple: false, types: ['factor', 'string', 'numeric'], optional: true, unique: true },
      ],
    },
  ],
};

// --- distribution + paired charts (#140) -------------------------------------

/** Group a measure by an optional category, carrying an optional replicate key.
 * Shared by the violin and dot plots, which differ only in what they draw. */
async function groupedValues(app, { y, g, rep }) {
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [y, g, rep].filter(Boolean) });
  const yCol = cols[y] || [];
  const gCol = g ? cols[g] || [] : null;
  const rCol = rep ? cols[rep] || [] : null;
  const yMiss = missingSet(meta, y);
  const gMiss = g ? missingSet(meta, g) : new Set();
  const gName = g ? labelMapper(meta, g) : null;
  const rName = rep ? labelMapper(meta, rep) : null;

  const byGroup = new Map();
  for (let i = 0; i < yCol.length; i++) {
    const v = Number(yCol[i]);
    if (!Number.isFinite(v) || yMiss.has(String(yCol[i]))) continue;
    if (gCol && (isBlank(gCol[i]) || gMiss.has(String(gCol[i])))) continue;
    const key = gCol ? String(gCol[i]) : '__all__';
    if (!byGroup.has(key)) {
      byGroup.set(key, { key, label: gCol ? gName(key) : label(meta, y), values: [], reps: [] });
    }
    const entry = byGroup.get(key);
    entry.values.push(v);
    entry.reps.push(rCol && !isBlank(rCol[i]) ? rName(String(rCol[i])) : null);
  }
  const groups = [...byGroup.values()];
  // Drop the replicate channel entirely when it carries nothing, so the chart does
  // not offer SuperPlot controls for a figure that has no replicates.
  if (!rCol) for (const grp of groups) delete grp.reps;
  return { groups, meta, yLabel: label(meta, y), gLabel: g ? label(meta, g) : '' };
}

/** Violin plot — distribution shape per group, with optional points/replicates. */
export async function violin(app, inputs) {
  const { groups, yLabel, gLabel } = await groupedValues(app, inputs);
  if (!groups.length) { await app.results.appendError('Violin plot: no values to plot after removing missing data.'); return; }
  await app.results.appendChart({
    kind: 'violin',
    title: gLabel ? `${yLabel} by ${gLabel}` : `Distribution of ${yLabel}`,
    axes: { x: { title: gLabel }, y: { title: yLabel } },
    groups,
  });
}

/** Dot plot / column scatter — every observation, jittered. */
export async function dotplot(app, inputs) {
  const { groups, yLabel, gLabel } = await groupedValues(app, inputs);
  if (!groups.length) { await app.results.appendError('Dot plot: no values to plot after removing missing data.'); return; }
  await app.results.appendChart({
    kind: 'dots',
    title: gLabel ? `${yLabel} by ${gLabel}` : `${yLabel} by observation`,
    axes: { x: { title: gLabel }, y: { title: yLabel } },
    groups,
  });
}

/**
 * Before-after plot — one line per subject across two or more conditions.
 *
 * Takes conditions as COLUMNS (wide format), because that is how paired measurements
 * are almost always stored: pre and post are two variables on one row for the same
 * person. The row IS the subject, so no id column is required.
 */
export async function beforeAfter(app, { vars, idVar }) {
  const names = Array.isArray(vars) ? vars.filter(Boolean) : [vars].filter(Boolean);
  if (names.length < 2) {
    await app.results.appendError('Before-after plot: pick at least two condition columns (e.g. pre and post).');
    return;
  }
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [...names, idVar].filter(Boolean) });
  const idCol = idVar ? cols[idVar] || [] : null;
  const idName = idVar ? labelMapper(meta, idVar) : null;
  const misses = names.map((n) => missingSet(meta, n));

  const subjects = [];
  const n = (cols[names[0]] || []).length;
  for (let i = 0; i < n; i++) {
    const values = names.map((nm, k) => {
      const raw = (cols[nm] || [])[i];
      const v = Number(raw);
      return Number.isFinite(v) && !misses[k].has(String(raw)) ? v : NaN;
    });
    // A line needs at least two points to say anything about change.
    if (values.filter(Number.isFinite).length < 2) continue;
    subjects.push({
      key: `s${i}`,
      label: idCol && !isBlank(idCol[i]) ? idName(String(idCol[i])) : `Row ${i + 1}`,
      values,
    });
  }
  if (!subjects.length) {
    await app.results.appendError('Before-after plot: no rows have values in at least two of the chosen conditions.');
    return;
  }
  await app.results.appendChart({
    kind: 'paired',
    title: `${label(meta, names[0])} → ${label(meta, names[names.length - 1])}`,
    axes: { x: { title: '' }, y: { title: label(meta, names[0]) } },
    conditions: names.map((nm) => ({ key: nm, label: label(meta, nm) })),
    subjects,
  });
}

// --- chart functions ---------------------------------------------------------

export async function histogram(app, { v: name }) {
  if (!name) return;
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [name] });
  const miss = missingSet(meta, name);
  const xs = [];
  for (const raw of cols[name] || []) {
    if (isBlank(raw) || miss.has(String(raw))) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) xs.push(n);
  }
  if (!xs.length) { await app.results.appendError('Histogram: no finite values to plot.'); return; }
  const { edges, counts } = binData(xs);
  // Bins become categories (gapped bars — the smart-chart trade for live recolour/
  // reorder/relabel + persistence). Value = count per bin.
  const categories = counts.map((_, i) => ({ key: String(i), label: `${round2(edges[i])}–${round2(edges[i + 1])}` }));
  await app.results.appendChart({
    kind: 'categorical',
    title: `Histogram of ${label(meta, name)}`,
    categories,
    series: [{ key: 'count', label: 'Count', values: counts }],
    axes: { x: { title: label(meta, name) }, y: { title: 'Count' } },
    view: { mark: 'bar', legend: 'none' },
  });
}

export async function scatter(app, { x, y }) {
  if (!x || !y) return;
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [x, y] });
  const xCol = cols[x] || [];
  const yCol = cols[y] || [];
  const xMiss = missingSet(meta, x);
  const yMiss = missingSet(meta, y);
  const points = [];
  for (let i = 0; i < xCol.length; i++) {
    const xv = Number(xCol[i]);
    const yv = Number(yCol[i]);
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    if (xMiss.has(String(xCol[i])) || yMiss.has(String(yCol[i]))) continue;
    points.push({ x: xv, y: yv });
  }
  if (!points.length) {
    await app.results.appendError('Scatter plot: no finite data after removing missing values.');
    return;
  }
  await app.results.appendChart({
    kind: 'scatter',
    title: `${label(meta, y)} vs ${label(meta, x)}`,
    points,
    trend: leastSquares(points),
    axes: { x: { title: label(meta, x) }, y: { title: label(meta, y) } },
  });
}

/**
 * Trends-over-time chart: aggregate a summary across X (often a time variable),
 * optionally one series per group, drawn as lines or stacked bars. `summary`:
 *  - `percent` — within each X value, the % in each group (composition); without a
 *    group, each X's share of the whole. The income-mix-over-years chart.
 *  - `count`   — number of cases per X (per group).
 *  - `mean`    — mean of a numeric measure per X (per group).
 * `display`:
 *  - `lines`      — one line per group across X (numeric X plots on a real axis).
 *  - `stacked`    — stacked bars (absolute composition per X).
 *  - `stacked100` — 100% stacked bars (each X normalised to 100% — compare shares).
 * Categories/levels honour value labels on the legend and a categorical X axis.
 */
export async function trends(app, { x, g, y, summary, display }) {
  if (!x) return;
  if (summary === 'mean' && !y) {
    await app.results.appendError('Trends over time: pick a Measure variable for the Mean value (or choose % / Count).');
    return;
  }
  const meta = await metaMap(app);
  const hasG = !!g;
  const isMean = summary === 'mean';
  const vars = [x, g, y].filter(Boolean);

  // Aggregate in JS (no WebR round-trip): sum/mean per (X value × group). The chart
  // is now data-driven, so the host renders it and the user can re-order/recolour/
  // re-stack it live — none of which a baked R image allowed.
  const cols = await app.data.getColumns({ variables: vars });
  const xs = cols[x] || [];
  const gs = hasG ? cols[g] || [] : null;
  const ys = isMean ? cols[y] || [] : null;
  const xMiss = missingSet(meta, x);
  const gMiss = hasG ? missingSet(meta, g) : null;

  const cells = new Map(); // xKey → Map(gKey → {sum, n})
  const groupKeys = new Set();
  for (let i = 0; i < xs.length; i++) {
    const xv = xs[i];
    if (isBlank(xv)) continue;
    const xk = String(xv);
    if (xMiss.has(xk)) continue;
    let gk = 'All';
    if (hasG) {
      const gv = gs[i];
      if (isBlank(gv)) continue;
      gk = String(gv);
      if (gMiss.has(gk)) continue;
    }
    let yv = 1;
    if (isMean) { yv = Number(ys[i]); if (!Number.isFinite(yv)) continue; }
    if (!cells.has(xk)) cells.set(xk, new Map());
    const gm = cells.get(xk);
    const cell = gm.get(gk) || { sum: 0, n: 0 };
    cell.sum += yv; cell.n += 1;
    gm.set(gk, cell);
    groupKeys.add(gk);
  }
  if (!cells.size) {
    await app.results.appendError('Trends over time: no data after removing missing values.');
    return;
  }

  const catKeys = [...cells.keys()].sort(numAwareCmp);
  const grpKeys = hasG ? [...groupKeys].sort(numAwareCmp) : ['All'];
  const raw = (xk, gk) => {
    const c = cells.get(xk)?.get(gk);
    if (!c) return 0;
    return isMean ? (c.n ? c.sum / c.n : 0) : c.sum; // sum == count when isMean is false
  };
  // summary='percent' bakes the share into the value (so a lines view shows %).
  let valueAt = raw;
  if (summary === 'percent') {
    if (hasG) {
      valueAt = (xk, gk) => {
        const tot = grpKeys.reduce((a, k) => a + raw(xk, k), 0) || 1;
        return (raw(xk, gk) / tot) * 100;
      };
    } else {
      const grand = catKeys.reduce((a, xk) => a + raw(xk, 'All'), 0) || 1;
      valueAt = (xk) => (raw(xk, 'All') / grand) * 100;
    }
  }

  const xLabel = labelMapper(meta, x);
  const gLabel = labelMapper(meta, g);
  const categories = catKeys.map((k) => ({ key: k, label: xLabel(k) }));
  const series = grpKeys.map((k) => ({
    key: k,
    label: hasG ? gLabel(k) : 'All',
    values: catKeys.map((xk) => round2(valueAt(xk, k))),
  }));

  const yLab = y ? label(meta, y) : '';
  const valLab = summary === 'percent' ? 'Percent' : summary === 'count' ? 'Count' : `Mean ${yLab}`;
  await app.results.appendChart({
    kind: 'categorical',
    title: `${valLab} by ${label(meta, x)}`,
    categories,
    series,
    axes: { x: { title: label(meta, x) }, y: { title: valLab } },
    // Plugin-suggested defaults; the user can change all of these in the chart.
    view: {
      mark: display === 'lines' ? 'line' : 'bar',
      stack: display === 'stacked' ? 'stacked' : display === 'stacked100' ? 'percent' : 'none',
      legend: hasG ? 'right' : 'none',
    },
  });
}

export async function boxplot(app, { y, g }) {
  if (!y) return;
  // Was the last R-baked chart in this plugin: it went to svglite for a picture, which
  // meant no live controls and no re-editability. A boxplot needs five numbers per
  // group and nothing more, so it is now a chart model like everything else here.
  const { groups, yLabel, gLabel } = await groupedValues(app, { y, g });
  if (!groups.length) {
    await app.results.appendError('Boxplot: no values to plot after removing missing data.');
    return;
  }
  await app.results.appendChart({
    kind: 'box',
    title: gLabel ? `${yLabel} by ${gLabel}` : `Boxplot of ${yLabel}`,
    axes: { x: { title: gLabel }, y: { title: yLabel } },
    groups,
  });
}

export async function pie(app, { v: name }) {
  if (!name) return;
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [name] });
  const col = cols[name] || [];
  const miss = missingSet(meta, name);
  const labelOf = labelMapper(meta, name);
  const counts = new Map();
  for (const raw of col) {
    if (isBlank(raw)) continue;
    const k = String(raw);
    if (miss.has(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) {
    await app.results.appendError('Pie chart: no data after removing missing values.');
    return;
  }
  // Largest slice first (the conventional pie ordering); the user can re-order.
  const slices = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ key: k, label: labelOf(k), value: n }));
  await app.results.appendChart({
    kind: 'pie',
    title: label(meta, name),
    slices,
  });
}

export async function errorBars(app, { y, g }) {
  if (!y || !g) return;
  const meta = await metaMap(app);
  const cols = await app.data.getColumns({ variables: [y, g] });
  const yv = cols[y] || [];
  const gv = cols[g] || [];
  const yMiss = missingSet(meta, y);
  const gMiss = missingSet(meta, g);
  const gLabelOf = labelMapper(meta, g);
  const groups = new Map(); // group key → raw numeric y values
  for (let i = 0; i < yv.length; i++) {
    const yy = yv[i];
    const gg = gv[i];
    if (isBlank(yy) || isBlank(gg) || yMiss.has(String(yy)) || gMiss.has(String(gg))) continue;
    const yn = Number(yy);
    if (!Number.isFinite(yn)) continue;
    const gk = String(gg);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(yn);
  }
  if (!groups.size) { await app.results.appendError('Bar chart: no complete cases to plot.'); return; }
  const gkeys = [...groups.keys()].sort(numAwareCmp);
  const categories = gkeys.map((k) => ({ key: k, label: gLabelOf(k) }));
  // rawValues drives the renderer's error bars (it computes sem/sd/ci95); the bar
  // height is the group mean. The user can switch the error type or turn it off.
  const rawValues = gkeys.map((k) => groups.get(k));
  const values = gkeys.map((k) => round2(meanOf(groups.get(k))));
  const yLab = `Mean ${label(meta, y)}`;
  await app.results.appendChart({
    kind: 'categorical',
    title: `${yLab} by ${label(meta, g)}`,
    categories,
    series: [{ key: y, label: yLab, values, rawValues }],
    axes: { x: { title: label(meta, g) }, y: { title: yLab } },
    view: { mark: 'bar', legend: 'none', errorBars: 'ci95' },
  });
}

// --- tiny helpers ------------------------------------------------------------

/** name → meta map for the current dataset. */
async function metaMap(app) {
  return new Map((await app.data.getVariableMeta()).map((m) => [m.name, m]));
}

/** Display label for a variable (its label, falling back to its name). */
function label(meta, name) {
  return meta.get(name)?.label || name;
}

/** Set of a variable's user-missing codes (as strings), for filtering in JS. */
function missingSet(meta, name) {
  return new Set((meta.get(name)?.missingValues ?? []).map(String));
}

/** A null / NaN / empty cell from getColumns (numeric missing comes back as NaN). */
function isBlank(v) {
  return v == null || (typeof v === 'number' && Number.isNaN(v)) || v === '';
}

/** Map a category code to its value label (codes → labels), identity if none. */
function labelMapper(meta, name) {
  const vl = name ? meta.get(name)?.valueLabels : null;
  if (!vl || !Object.keys(vl).length) return (k) => String(k);
  return (k) => (k in vl ? vl[k] : String(k));
}

/** Compare two category keys numerically when both look numeric, else as text —
 * so years sort 2019,2020,… not lexically, but string categories still sort sanely. */
function numAwareCmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a !== '' && Number.isFinite(na);
  const bNum = b !== '' && Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  return String(a).localeCompare(String(b));
}

/** Round to 2 dp (compact, avoids float noise in the persisted model). */
function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Arithmetic mean of a numeric array (NaN if empty). */
function meanOf(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

/** Even-width histogram bins over [min,max] using Sturges' rule (k = ⌈log₂n⌉+1).
 * Returns `{edges: number[k+1], counts: number[k]}`; the max value lands in the last
 * bin. A single distinct value degenerates to one bin. */
function binData(xs) {
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  if (min === max) return { edges: [min, min + 1], counts: [xs.length] };
  const k = Math.max(1, Math.ceil(Math.log2(xs.length)) + 1);
  const width = (max - min) / k;
  const edges = Array.from({ length: k + 1 }, (_, i) => min + i * width);
  edges[k] = max; // guard float drift so max is included, not spilled past the edge
  const counts = new Array(k).fill(0);
  for (const x of xs) {
    let b = Math.floor((x - min) / width);
    if (b >= k) b = k - 1; // the max value → last bin
    if (b < 0) b = 0;
    counts[b] += 1;
  }
  return { edges, counts };
}

/** Ordinary least-squares fit of y on x → {slope, intercept, r2}, or null if the
 * points are degenerate (n<3 or zero x-variance). Matches lm(y ~ x) + R². */
function leastSquares(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
  const dx = n * sxx - sx * sx;
  if (dx === 0) return null;
  const slope = (n * sxy - sx * sy) / dx;
  const intercept = (sy - slope * sx) / n;
  const dy = n * syy - sy * sy;
  const rNum = n * sxy - sx * sy;
  const r2 = dy === 0 ? 0 : (rNum * rNum) / (dx * dy);
  return { slope, intercept, r2 };
}

