/**
 * @file plugins/builtin-plots/index.js
 * Built-in plugin: the **Graphs** menu — histogram, scatter (+ trend line),
 * boxplot, pie chart, and a bar chart with error bars.
 *
 * Plots are drawn in R with base graphics on an **`svglite`** device
 * (`svgstring()`), which returns the chart as an SVG *string* — exactly what
 * `app.results.appendPlot` wants, and what survives the host's SVG-aware
 * sanitiser. Each chart honours `missingValues`, themes to the app blue, and is
 * responsive via `viewBox`.
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
  version: '0.2.0',
  apiVersion: '0.1.0',
  category: 'Graphs',
  keywords: ['chart', 'histogram', 'scatter', 'boxplot', 'bar', 'pie', 'plot'],
  rPackages: ['svglite'],
  menu: [
    {
      label: 'Histogram…',
      run: 'histogram',
      order: 10,
      inputs: [{ name: 'v', kind: 'variables', multiple: false, types: ['numeric'] }],
    },
    {
      label: 'Scatter…',
      run: 'scatter',
      order: 20,
      inputs: [
        { name: 'x', kind: 'variables', label: 'X', multiple: false, types: ['numeric'], unique: true },
        { name: 'y', kind: 'variables', label: 'Y', multiple: false, types: ['numeric'], unique: true },
      ],
    },
    {
      label: 'Boxplot…',
      run: 'boxplot',
      order: 30,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Variable', multiple: false, types: ['numeric'] },
        { name: 'g', kind: 'variables', label: 'Split by (optional)', multiple: false, types: ['factor', 'string'], optional: true },
      ],
    },
    {
      label: 'Pie chart…',
      run: 'pie',
      order: 40,
      inputs: [{ name: 'v', kind: 'variables', multiple: false, types: ['factor', 'string'] }],
    },
    {
      label: 'Bar chart with error bars…',
      run: 'errorBars',
      order: 50,
      inputs: [
        { name: 'y', kind: 'variables', label: 'Measure', multiple: false, types: ['numeric'] },
        { name: 'g', kind: 'variables', label: 'Groups', multiple: false, types: ['factor', 'string'] },
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
  const code = `
    ${recodeR([x, y], meta)}
    xx <- as.numeric(df[[${rlit(x)}]]); yy <- as.numeric(df[[${rlit(y)}]])
    ok <- is.finite(xx) & is.finite(yy); xx <- xx[ok]; yy <- yy[ok]
    plot(xx, yy, pch = 19, col = "${ACCENT}88",
         xlab = ${rlit(label(meta, x))}, ylab = ${rlit(label(meta, y))})
    if (length(xx) > 2) {
      fit <- lm(yy ~ xx); abline(fit, col = "#e74c3c", lwd = 2)
      legend("topleft", bty = "n", text.col = "#e74c3c",
             legend = sprintf("R² = %.3f", summary(fit)$r.squared))
    }`;
  await renderPlot(app, 'Scatter plot', code, [x, y]);
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
  const vl = meta.get(name)?.valueLabels;
  const vmap = vl
    ? `vmap <- c(${Object.entries(vl)
        .map(([k, l]) => `${rlit(String(k))} = ${rlit(String(l))}`)
        .join(', ')}); labs <- ifelse(labs %in% names(vmap), vmap[labs], labs)`
    : '';
  const code = `
    ${recodeR([name], meta)}
    x <- df[[${rlit(name)}]]; x <- x[!is.na(x)]
    tb <- sort(table(as.character(x)), decreasing = TRUE)
    labs <- names(tb)
    ${vmap}
    pct <- round(100 * as.numeric(tb) / sum(tb))
    pie(as.numeric(tb), labels = paste0(labs, " (", pct, "%)"),
        col = hcl.colors(length(tb), "Blues"), main = ${rlit(label(meta, name))})`;
  await renderPlot(app, 'Pie chart', code, [name]);
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

/** Render a JS value as an R literal for safe interpolation into R source. */
function rlit(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
