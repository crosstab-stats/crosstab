/**
 * @file plugins/builtin-plots/index.js
 * Built-in plugin: the **Graphs** menu — histogram, scatter (+ trend line),
 * boxplot, pie chart, and a bar chart with error bars.
 *
 * Two rendering paths (#131):
 *  - **Data-driven** (trends, scatter, pie): aggregate in JS, then emit a structured
 *    chart MODEL to `app.results.appendChart`. The host renders the SVG and the user
 *    can re-order / recolour / re-stack / rotate it live (see core/chart-renderer.js).
 *    No WebR — these read columns via `app.data.getColumns` and compute in JS.
 *  - **R-baked** (histogram, boxplot, bar+error-bars): still drawn in R on an
 *    `svglite` device and handed to `app.results.appendPlot` as a finished SVG —
 *    they need binning / box stats / CI primitives the chart kinds don't model yet.
 *    Each honours `missingValues`, themes to the app blue, and is responsive.
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
  version: '0.6.0',
  apiVersion: '0.1.0',
  category: 'Graphs',
  keywords: ['chart', 'histogram', 'scatter', 'boxplot', 'bar', 'pie', 'plot'],
  rPackages: ['svglite'],
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
  ],
};

const ACCENT = '#2980b9';

// --- chart functions ---------------------------------------------------------

export async function histogram(app, { v: name }) {
  if (!name) return;
  const meta = await metaMap(app);
  const code = `
    ${recodeR([name], meta)}
    x <- as.numeric(df[[${rlit(name)}]]); x <- x[is.finite(x)]
    hist(x, col = "${ACCENT}", border = "white",
         main = ${rlit(label(meta, name))}, xlab = ${rlit(label(meta, name))})`;
  await renderPlot(app, 'Histogram', code, [name]);
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
  const meta = await metaMap(app);
  const vars = g ? [y, g] : [y];
  const code = g
    ? `
    ${recodeR([y, g], meta)}
    yy <- as.numeric(df[[${rlit(y)}]]); gg <- as.factor(df[[${rlit(g)}]])
    boxplot(yy ~ gg, col = "${ACCENT}33", border = "${ACCENT}",
            xlab = ${rlit(label(meta, g))}, ylab = ${rlit(label(meta, y))},
            main = ${rlit(label(meta, y))})`
    : `
    ${recodeR([y], meta)}
    yy <- as.numeric(df[[${rlit(y)}]]); yy <- yy[is.finite(yy)]
    boxplot(yy, col = "${ACCENT}33", border = "${ACCENT}",
            ylab = ${rlit(label(meta, y))}, main = ${rlit(label(meta, y))})`;
  await renderPlot(app, 'Boxplot', code, vars);
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
  const code = `
    ${recodeR([y, g], meta)}
    yy <- as.numeric(df[[${rlit(y)}]]); gg <- as.factor(df[[${rlit(g)}]])
    ok <- is.finite(yy) & !is.na(gg); yy <- yy[ok]; gg <- droplevels(gg[ok])
    m <- tapply(yy, gg, mean); s <- tapply(yy, gg, sd); n <- tapply(yy, gg, length)
    se <- s / sqrt(n); ci <- qt(0.975, pmax(n - 1, 1)) * se
    top <- max(m + ci, na.rm = TRUE); bot <- min(0, min(m - ci, na.rm = TRUE))
    bp <- barplot(m, col = "${ACCENT}33", border = "${ACCENT}", ylim = c(bot, top * 1.1),
                  xlab = ${rlit(label(meta, g))}, ylab = paste("Mean", ${rlit(label(meta, y))}),
                  main = paste("Mean", ${rlit(label(meta, y))}, "by", ${rlit(label(meta, g))}))
    arrows(bp, m - ci, bp, m + ci, angle = 90, code = 3, length = 0.05, col = "#333")
    mtext("Error bars: 95% CI", side = 3, line = 0.2, cex = 0.8, col = "#777")`;
  await renderPlot(app, 'Bar chart with error bars', code, [y, g]);
}

// --- shared render harness ---------------------------------------------------

/**
 * Run plotting `code` on an svglite device, capture the SVG, and append it. The
 * plot offers a "Redraw at this size" button that re-runs the recipe at the box's
 * pixel size (the only way to truly re-flow the aspect ratio).
 */
async function renderPlot(app, title, code, vars) {
  try {
    const svg = await drawSvg(app, code, vars, 7, 4.5);
    let handle;
    handle = await app.results.appendPlot(svg, {
      onRedraw: (wpx, hpx) => void redrawPlot(app, handle, title, code, vars, wpx, hpx),
    });
  } catch (err) {
    await app.results.appendError(`${title} failed: ${err.message}`);
    console.error(err);
  }
}

/** Run the recipe on an svglite device at the given size (inches), return SVG. */
async function drawSvg(app, code, vars, wIn, hIn) {
  const R = `
    library(svglite)
    .ct_dev <- svgstring(width = ${wIn}, height = ${hIn}, pointsize = 11)
    par(mar = c(4.2, 4.2, 2.2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    ${code}
    dev.off()
    .ct_dev()`;
  const res = await app.webr.run(R, { injectData: true, variables: vars });
  const svg = String(Array.isArray(res.result?.values) ? res.result.values[0] : res.result);
  if (!/<svg[\s>]/i.test(svg)) throw new Error('no SVG was produced');
  return svg
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

/** Re-render the plot at the box's pixel size (px → inches) and swap it in. */
async function redrawPlot(app, handle, title, code, vars, wpx, hpx) {
  try {
    const svg = await drawSvg(app, code, vars, Math.max(2, wpx / 96), Math.max(1.5, hpx / 96));
    await app.results.updatePlot(handle, svg);
  } catch (err) {
    await app.results.appendError(`${title} redraw failed: ${err.message}`);
    console.error(err);
  }
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

/** R lines recoding each variable's user-missing codes to NA (or '' if none). */
function recodeR(vars, meta) {
  return vars
    .map((name) => {
      const mv = meta.get(name)?.missingValues ?? [];
      if (!mv.length) return '';
      const col = `df[[${rlit(name)}]]`;
      return `${col}[${col} %in% c(${mv.map(rlit).join(', ')})] <- NA`;
    })
    .filter(Boolean)
    .join('\n    ');
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

/** Render a JS value as an R literal for safe interpolation into R source. */
function rlit(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
