/**
 * @file plugins/builtin-plots/index.js
 * Built-in plugin: the **Graphs** menu — histogram, scatter (+ trend line),
 * boxplot, pie chart, and a bar chart with error bars.
 *
 * Plots are drawn in R with base graphics on an **`svglite`** device
 * (`svgstring()`), which returns the chart as an SVG *string* — exactly what
 * `app.results.appendPlot` wants, and what survives the host's SVG-aware
 * sanitiser. No cairo/file juggling. Each chart honours `missingValues` (recoded
 * to NA before plotting), themes to the app blue, and is made responsive by
 * dropping `svglite`'s fixed pt size and leaning on the `viewBox`.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-plots',
  name: 'Plots',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Graphs',
  keywords: ['chart', 'histogram', 'scatter', 'boxplot', 'bar', 'pie', 'plot'],
  rPackages: ['svglite'],
};

const ACCENT = '#2980b9';

/** @param {object} app */
export async function activate(app) {
  const reg = (id, label, order, fn) =>
    app.menus.register({
      id: `builtin-plots:${id}`,
      path: ['Graphs'],
      label,
      order,
      command: () => fn(app),
    });
  await reg('hist', 'Histogram…', 10, openHistogram);
  await reg('scatter', 'Scatter…', 20, openScatter);
  await reg('box', 'Boxplot…', 30, openBoxplot);
  await reg('pie', 'Pie chart…', 40, openPie);
  await reg('errbar', 'Bar chart with error bars…', 50, openErrorBars);
}

// --- chart commands ----------------------------------------------------------

async function openHistogram(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Histogram',
    hint: 'Choose a numeric variable.',
    multiple: false,
    types: ['numeric'],
  });
  if (!chosen?.length) return;
  const name = chosen[0];
  const meta = await metaMap(app);
  const code = `
    ${recodeR([name], meta)}
    x <- as.numeric(df[[${rlit(name)}]]); x <- x[is.finite(x)]
    hist(x, col = "${ACCENT}", border = "white",
         main = ${rlit(label(meta, name))}, xlab = ${rlit(label(meta, name))})`;
  await renderPlot(app, 'Histogram', code, [name]);
}

async function openScatter(app) {
  const xs = await app.ui.selectVariables({
    title: 'Scatter — X',
    hint: 'Choose the X (horizontal) numeric variable.',
    multiple: false,
    types: ['numeric'],
  });
  if (!xs?.length) return;
  const ys = await app.ui.selectVariables({
    title: 'Scatter — Y',
    hint: `X: ${xs[0]}. Now choose the Y (vertical) numeric variable.`,
    multiple: false,
    types: ['numeric'],
  });
  if (!ys?.length) return;
  const x = xs[0];
  const y = ys[0];
  if (x === y) {
    await app.results.appendError('Scatter: choose two different variables.');
    return;
  }
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

async function openBoxplot(app) {
  const ys = await app.ui.selectVariables({
    title: 'Boxplot — variable',
    hint: 'Choose a numeric variable.',
    multiple: false,
    types: ['numeric'],
  });
  if (!ys?.length) return;
  const gs = await app.ui.selectVariables({
    title: 'Boxplot — split by (optional)',
    hint: 'Optionally choose a categorical variable to split by — or Cancel for none.',
    multiple: false,
    types: ['factor', 'string'],
  });
  const y = ys[0];
  const g = gs?.length ? gs[0] : null;
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

async function openPie(app) {
  const chosen = await app.ui.selectVariables({
    title: 'Pie chart',
    hint: 'Choose a categorical variable.',
    multiple: false,
    types: ['factor', 'string'],
  });
  if (!chosen?.length) return;
  const name = chosen[0];
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

async function openErrorBars(app) {
  const ys = await app.ui.selectVariables({
    title: 'Error-bar chart — measure',
    hint: 'Choose a numeric variable (the measure).',
    multiple: false,
    types: ['numeric'],
  });
  if (!ys?.length) return;
  const gs = await app.ui.selectVariables({
    title: 'Error-bar chart — groups',
    hint: `Measure: ${ys[0]}. Choose a categorical variable to group by.`,
    multiple: false,
    types: ['factor', 'string'],
  });
  if (!gs?.length) return;
  const y = ys[0];
  const g = gs[0];
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
 * Run plotting `code` on an svglite device, capture the SVG string, and append
 * it to the results pane. `code` runs with `df` injected; it should issue base
 * graphics calls (the device + `dev.off()` are wrapped here).
 *
 * @param {object} app
 * @param {string} title
 * @param {string} code - R plotting commands.
 * @param {string[]} vars - Variables to inject.
 */
async function renderPlot(app, title, code, vars) {
  await app.events.emit('analysis:started', { plugin: manifest.id, title });
  await app.results.beginSection(title);
  try {
    const svg = await drawSvg(app, code, vars, 7, 4.5); // 7×4.5in default
    // appendPlot returns a handle; the onRedraw button re-runs the recipe at the
    // box's pixel size (the only way to truly re-flow the plot to a new ratio —
    // dragging alone just scales the SVG).
    let handle;
    handle = await app.results.appendPlot(svg, {
      onRedraw: (wpx, hpx) => void redrawPlot(app, handle, title, code, vars, wpx, hpx),
    });
  } catch (err) {
    await app.results.appendError(`${title} failed: ${err.message}`);
    console.error(err);
  }
  await app.events.emit('analysis:finished', { plugin: manifest.id, title });
}

/**
 * Run the plot recipe on an svglite device at the given size (inches) and return
 * the SVG, with svglite's fixed pt width/height stripped so it fills its box via
 * CSS (the `viewBox` keeps it crisp and undistorted).
 */
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
