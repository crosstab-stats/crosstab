/**
 * @file plugins/builtin-var/index.js
 * Built-in plugin: **Vector Autoregression (VAR)** — the multivariate time-series
 * workhorse for macro/political-economy questions where several series move
 * together and feed back on each other. Estimates a VAR, tests **Granger
 * causality**, and traces **impulse responses** (how a shock to one series ripples
 * through the system). Uses the `vars` package.
 *
 * One menu action does the full workflow: data-driven lag selection (or a fixed
 * lag), the per-equation coefficients, a Granger-causality table, and an
 * impulse-response grid.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-var',
  name: 'Vector Autoregression',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Time Series',
  keywords: ['var', 'vector autoregression', 'granger', 'causality', 'impulse response', 'irf', 'macroeconometrics', 'multivariate time series'],
  disciplines: ['Economics', 'Public Policy & Administration'],
  howto:
    'GUI: Time Series ▸ Vector autoregression (VAR)…, then pick two or more numeric series in time order. You get lag selection, per-equation coefficients, Granger causality, and an impulse-response grid.\n' +
    'Syntax: run builtin-var.varModel {"series": ["gdp", "inflation"], "lag": 0, "type": "const", "horizon": 10}\n' +
    '  • series — two or more numeric series, rows in time order.\n' +
    '  • lag — number of past periods (0 = choose by AIC).\n' +
    '  • type — "const" | "trend" | "both" | "none".\n' +
    '  • horizon — impulse-response horizon in steps.',
  rPackages: ['vars', 'svglite'],
  menu: [
    {
      label: 'Vector autoregression (VAR)…',
      run: 'varModel',
      order: 60,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Time series (2 or more, in time order)', hint: 'Two or more numeric series, rows already sorted by time.', multiple: true, types: ['numeric'], unique: true },
        { name: 'lag', kind: 'number', label: 'Lag order (0 = choose by AIC)', hint: 'How many past periods to include; 0 lets the data decide.', default: 0 },
        { name: 'type', kind: 'choice', label: 'Deterministic terms', hint: 'Whether to allow a constant and trend in each equation.', default: 'const', options: [
          { value: 'const', label: 'Constant' },
          { value: 'trend', label: 'Trend' },
          { value: 'both', label: 'Constant + trend' },
          { value: 'none', label: 'None' },
        ] },
        { name: 'horizon', kind: 'number', label: 'Impulse-response horizon (steps)', hint: 'How many periods ahead to trace a shock\'s effect.', default: 10 },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

export async function varModel(app, { series, lag, type, horizon }) {
  if (!series || series.length < 2) {
    await app.results.appendError('VAR: choose at least two time series (numeric columns, in time order).');
    return;
  }
  await app.webr.installPackages(['vars']);
  const meta = metaMap(await app.data.getVariableMeta());
  const dtype = ['const', 'trend', 'both', 'none'].includes(type) ? type : 'const';
  const H = Number.isFinite(horizon) && horizon > 0 ? Math.floor(horizon) : 10;
  const pFixed = Number.isFinite(lag) && lag >= 1 ? Math.floor(lag) : 0;
  const recodes = series.map((n) => recodeLine(`series[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    suppressMessages({library(vars); library(svglite)})
    ${recodes}
    d <- as.data.frame(lapply(series, as.numeric))
    colnames(d) <- paste0("V", seq_len(ncol(d)))
    nm <- c(${series.map((n) => rStr(labelOf(meta.get(n), n))).join(', ')})
    d <- d[stats::complete.cases(d), , drop = FALSE]
    sel <- VARselect(d, lag.max = min(8L, floor(nrow(d) / (ncol(d) + 2)) - 1L), type = ${rStr(dtype)})
    p <- ${pFixed >= 1 ? pFixed : 'as.integer(sel$selection["AIC(n)"])'}
    if (!is.finite(p) || p < 1) p <- 1L
    v <- VAR(d, p = p, type = ${rStr(dtype)})
    eqNames <- names(v$varresult)
    co <- lapply(v$varresult, function(e) summary(e)$coefficients)
    # Granger causality: each variable causing the rest
    gcF <- c(); gcP <- c()
    for (nm_i in colnames(d)) { gc <- tryCatch(causality(v, cause = nm_i)$Granger, error = function(e) NULL)
      gcF <- c(gcF, if (is.null(gc)) NA_real_ else as.numeric(gc$statistic))
      gcP <- c(gcP, if (is.null(gc)) NA_real_ else as.numeric(gc$p.value)) }
    # IRF grid plot
    ir <- irf(v, n.ahead = ${H}, boot = FALSE, ortho = TRUE)
    k <- ncol(d)
    .ct_dev <- svgstring(width = 7, height = max(4, 2.1 * k), pointsize = 10)
    par(mfrow = c(k, k), mar = c(2.4, 2.6, 1.8, 0.6), col.axis = "#555555", fg = "#aaaaaa")
    for (imp in colnames(d)) for (resp in colnames(d)) {
      yv <- ir$irf[[imp]][, resp]
      plot(0:${H}, yv, type = "l", lwd = 2, col = "${ACCENT}", xlab = "", ylab = "",
           main = paste(nm[match(imp, colnames(d))], "→", nm[match(resp, colnames(d))]), cex.main = 0.9)
      abline(h = 0, col = "#cccccc", lty = 2)
    }
    dev.off(); svg <- .ct_dev()
    list(p = p, nobs = nrow(d), dispnames = nm, varcols = colnames(d),
         aic = as.integer(sel$selection["AIC(n)"]), hq = as.integer(sel$selection["HQ(n)"]),
         sc = as.integer(sel$selection["SC(n)"]), fpe = as.integer(sel$selection["FPE(n)"]),
         eqNames = eqNames,
         coefFlat = unlist(lapply(co, function(m) as.numeric(t(m[, c("Estimate","Std. Error","t value","Pr(>|t|)")])))),
         coefRows = unlist(lapply(co, function(m) nrow(m))),
         coefTerms = unlist(lapply(co, rownames)),
         gcF = gcF, gcP = gcP, svg = svg)`;
  const r = flat(await runR(app, rCode));
  const disp = r.strs('dispnames');
  const p = r.num('p');

  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Lag order (p)', `${f(p, 0)}${pFixed >= 1 ? ' (fixed)' : ' (AIC)'}`],
        ['Observations used', f(r.num('nobs'), 0)],
        ['Suggested lags — AIC / HQ / SC / FPE', `${r.num('aic')} / ${r.num('hq')} / ${r.num('sc')} / ${r.num('fpe')}`],
      ],
      rowHeaders: true,
    },
    { caption: `VAR(${f(p, 0)}) — ${disp.join(', ')}` },
  );

  // Per-equation coefficient tables.
  const flat4 = r.nums('coefFlat'), rowsPer = r.nums('coefRows'), allTerms = r.strs('coefTerms'), eqNames = r.strs('eqNames');
  let ci2 = 0, ti = 0;
  for (let e = 0; e < eqNames.length; e++) {
    const nr = rowsPer[e];
    const rows = [];
    for (let row = 0; row < nr; row++) {
      const b = flat4[ci2], se = flat4[ci2 + 1], tval = flat4[ci2 + 2], pv = flat4[ci2 + 3];
      ci2 += 4;
      rows.push([varTerm(allTerms[ti++], disp, r.strs('varcols')), f(b, 4), f(se, 4), f(tval, 2), fmtP(pv)]);
    }
    await app.results.appendTable(
      { columns: ['', 'B', 'Std. Error', 't', 'Sig.'], rows, rowHeaders: true },
      { caption: `Equation: ${disp[e] ?? eqNames[e]}` },
    );
  }

  const gcF = r.nums('gcF'), gcP = r.nums('gcP');
  await app.results.appendTable(
    {
      columns: ['Cause', 'Granger F', 'Sig.'],
      rows: disp.map((d, i) => [`${d} → (all others)`, f(gcF[i], 3), fmtP(gcP[i])]),
      rowHeaders: true,
    },
    { caption: 'Granger Causality Tests' },
  );

  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    'Each VAR equation regresses one series on lags of *all* series. **Granger causality** asks whether a variable\'s past helps predict the others beyond their own past (a small p = yes). The **impulse-response** grid (orthogonalized) traces how a one-time shock to the column variable propagates to each row variable over the horizon — the core of VAR interpretation. Make sure the series are stationary first (see the Time Series ▸ stationarity tests).',
  );
}

// --- helpers -----------------------------------------------------------------

async function runR(app, rCode) {
  const { result } = await app.webr.run(rCode);
  if (!result) throw new Error('R returned no result');
  return result;
}

function cleanSvg(svg) {
  return String(svg)
    .replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}

/** Map a VAR coefficient term like "V1.l1" / "const" / "trend" to a readable label. */
function varTerm(term, disp, varcols) {
  const m = /^V(\d+)\.l(\d+)$/.exec(term);
  if (m) {
    const idx = varcols.indexOf(`V${m[1]}`);
    const nm = idx >= 0 ? disp[idx] : `V${m[1]}`;
    return `${nm} (lag ${m[2]})`;
  }
  if (term === 'const') return '(Constant)';
  if (term === 'trend') return 'Trend';
  return term;
}

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label}` : name;
}

function f(n, d) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function fmtP(p) {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< .001' : p.toFixed(3);
}

function rStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function flat(rList) {
  const byName = {};
  if (rList && Array.isArray(rList.names) && Array.isArray(rList.values)) {
    rList.names.forEach((n, i) => (byName[n] = rList.values[i]));
  } else {
    Object.assign(byName, rList || {});
  }
  const arr = (v) => (v == null ? [] : Array.isArray(v?.values) ? v.values : [].concat(v));
  return {
    nums: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    strs: (k) => arr(byName[k]).map((x) => (x == null ? 'NA' : String(x))),
    num: (k) => {
      const a = arr(byName[k]);
      return a.length ? Number(a[0]) : NaN;
    },
    str1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0]) : '';
    },
  };
}
