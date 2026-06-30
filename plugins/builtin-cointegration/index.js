/**
 * @file plugins/builtin-cointegration/index.js
 * Built-in plugin: **cointegration / VECM** and **GARCH volatility** — the two
 * pieces of applied time-series econometrics that the VAR and ARIMA tools don't
 * cover.
 *
 *  - **Cointegration (Johansen)** — `urca::ca.jo` trace test for the number of
 *    long-run equilibrium relationships among non-stationary series, the
 *    normalized cointegrating vector, and the VECM speed-of-adjustment
 *    coefficients (`cajorls`, assuming rank 1).
 *  - **GARCH volatility** — `fGarch::garchFit` for conditional
 *    heteroskedasticity / volatility clustering in a return series, with a
 *    conditional-volatility plot and the persistence (α+β).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-cointegration',
  name: 'Cointegration & GARCH',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Time Series',
  keywords: ['cointegration', 'johansen', 'vecm', 'error correction', 'garch', 'arch', 'volatility', 'conditional variance', 'urca', 'fgarch'],
  disciplines: ['Economics', 'Business'],
  howto:
    'GUI: Time Series ▸ Cointegration (Johansen)…, pick 2+ trending series (time order); or Time Series ▸ GARCH volatility…, pick a return series. You get the trace test + VECM, or a volatility model with a conditional-SD plot.\n' +
    'Syntax: run builtin-cointegration.cointegration {"series": ["gdp", "consumption"], "ecdet": "const", "K": 2}\n' +
    '  • series — 2+ non-stationary series, in time order.\n' +
    '  • ecdet — "const" (default) | "trend" | "none".\n' +
    '  • K — lags in levels (≥ 2; default 2).\n' +
    'Syntax: run builtin-cointegration.garch {"series": "returns", "q": 1, "p": 1, "dist": "norm"}\n' +
    '  • series — the return/series to model.\n' +
    '  • q / p — ARCH and GARCH orders (default 1, 1).\n' +
    '  • dist — "norm" (default) | "std" | "ged".',
  rPackages: ['urca', 'fGarch', 'svglite'],
  menu: [
    {
      label: 'Cointegration (Johansen)…',
      run: 'cointegration',
      order: 70,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series (2+ non-stationary, in time order)', hint: 'Two or more trending series, rows sorted by time.', multiple: true, types: ['numeric'], unique: true },
        { name: 'ecdet', kind: 'choice', label: 'Deterministic term', hint: 'Whether to allow a constant or trend in the long-run relationship.', default: 'const', options: [
          { value: 'const', label: 'Constant (restricted)' },
          { value: 'trend', label: 'Linear trend' },
          { value: 'none', label: 'None' },
        ] },
        { name: 'K', kind: 'number', label: 'Lags (K, in levels; ≥ 2)', hint: 'How many past periods to include; at least two.', default: 2 },
      ],
    },
    {
      label: 'GARCH volatility…',
      run: 'garch',
      order: 80,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Return / series (time order)', hint: 'The return or series whose changing volatility you want to model.', multiple: false, types: ['numeric'], unique: true },
        { name: 'q', kind: 'number', label: 'ARCH order (q)', hint: 'How many recent shocks feed into current volatility.', default: 1 },
        { name: 'p', kind: 'number', label: 'GARCH order (p)', hint: 'How much past volatility carries over; 1 is the usual choice.', default: 1 },
        { name: 'dist', kind: 'choice', label: 'Conditional distribution', hint: 'The error distribution; heavier tails handle extreme moves better.', default: 'norm', options: [
          { value: 'norm', label: 'Normal' },
          { value: 'std', label: "Student's t" },
          { value: 'ged', label: 'GED' },
        ] },
      ],
    },
  ],
};

const ACCENT = '#2980b9';

// --- Cointegration (Johansen + VECM) ----------------------------------------

export async function cointegration(app, { series, ecdet, K }) {
  if (!series || series.length < 2) {
    await app.results.appendError('Cointegration: choose at least two non-stationary series (in time order).');
    return;
  }
  await app.webr.installPackages(['urca']);
  const meta = metaMap(await app.data.getVariableMeta());
  const ec = ['const', 'trend', 'none'].includes(ecdet) ? ecdet : 'const';
  const k = Number.isFinite(K) && K >= 2 ? Math.floor(K) : 2;
  const recodes = series.map((n) => recodeLine(`series[[${rStr(n)}]]`, meta.get(n))).filter(Boolean).join('\n');
  const rCode = `
    suppressMessages(library(urca))
    ${recodes}
    d <- as.data.frame(lapply(series, as.numeric)); colnames(d) <- paste0("V", seq_len(ncol(d)))
    nm <- c(${series.map((n) => rStr(labelOf(meta.get(n), n))).join(', ')})
    d <- d[stats::complete.cases(d), , drop = FALSE]
    jo <- ca.jo(d, type = "trace", ecdet = ${rStr(ec)}, K = ${k})
    ts <- rev(jo@teststat); cv <- jo@cval[nrow(jo@cval):1, , drop = FALSE]
    r_index <- seq_len(length(ts)) - 1
    beta <- jo@V[, 1] / jo@V[1, 1]
    adj <- tryCatch({ cj <- cajorls(jo, r = 1); co <- coef(cj$rlm); co["ect1", ] }, error = function(e) rep(NA_real_, ncol(d)))
    list(rlabels = paste0("r <= ", r_index), rzero = r_index, stat = as.numeric(ts),
         c10 = as.numeric(cv[, 1]), c5 = as.numeric(cv[, 2]), c1 = as.numeric(cv[, 3]),
         betaNames = names(beta), beta = as.numeric(beta), nm = nm, adj = as.numeric(adj), nobs = nrow(d))`;
  const r = flat(await runR(app, rCode));
  const rlab = r.strs('rlabels'), stat = r.nums('stat'), c10 = r.nums('c10'), c5 = r.nums('c5'), c1 = r.nums('c1');
  const nm = r.strs('nm');

  // Determine rank: first r (from r=0) where stat <= 5% crit.
  let rank = stat.length;
  for (let i = 0; i < stat.length; i++) {
    if (!(stat[i] > c5[i])) { rank = i; break; }
  }

  await app.results.appendTable(
    {
      columns: ['H₀', 'Trace stat', 'Crit 10%', 'Crit 5%', 'Crit 1%', 'Reject (5%)'],
      rows: rlab.map((lab, i) => [lab, f(stat[i], 2), f(c10[i], 2), f(c5[i], 2), f(c1[i], 2), stat[i] > c5[i] ? 'yes' : 'no']),
      rowHeaders: true,
    },
    { caption: `Johansen Cointegration (trace) — ${nm.join(', ')} (N = ${r.num('nobs')})` },
  );

  const beta = r.nums('beta'), adj = r.nums('adj');
  await app.results.appendTable(
    {
      columns: ['', 'Cointegrating vector (β)', 'Adjustment speed (α)'],
      rows: nm.map((v, i) => [v, f(beta[i], 4), Number.isFinite(adj[i]) ? f(adj[i], 4) : '—']),
      rowHeaders: true,
    },
    { caption: 'Long-run Relationship (normalized, rank r = 1)' },
  );
  await app.results.appendText(
    `**Cointegration rank ≈ ${rank}** (number of long-run relationships, by the 5% trace test). Read top-down: reject "r ≤ 0" then fail to reject "r ≤ 1" ⇒ one cointegrating vector. ` +
      'The **β** vector is the stationary long-run combination; the **α** (adjustment) speeds say how fast each series corrects back toward equilibrium. Rank 0 means no cointegration (use a VAR in differences instead); the β/α table assumes rank 1.',
  );
}

// --- GARCH -------------------------------------------------------------------

export async function garch(app, { series: sName, q, p, dist }) {
  if (!sName) {
    await app.results.appendError('GARCH: choose a return/series column.');
    return;
  }
  await app.webr.installPackages(['fGarch']);
  const meta = metaMap(await app.data.getVariableMeta());
  const Q = Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
  const P = Number.isFinite(p) && p >= 0 ? Math.floor(p) : 1;
  const cd = ['norm', 'std', 'ged'].includes(dist) ? dist : 'norm';
  const recodes = recodeLine('series', meta.get(sName));
  const rCode = `
    suppressMessages({library(fGarch); library(svglite)})
    ${recodes}
    x <- as.numeric(series); x <- x[is.finite(x)]
    fit <- garchFit(~ garch(${Q}, ${P}), data = x, trace = FALSE, cond.dist = ${rStr(cd)})
    cf <- fit@fit$matcoef
    vol <- fit@sigma.t
    ll <- -fit@fit$value; np <- length(fit@fit$coef); aic <- 2 * np - 2 * ll
    aterms <- rownames(cf)
    persist <- sum(cf[grepl("^alpha", aterms), 1]) + sum(cf[grepl("^beta", aterms), 1])
    .ct_dev <- svgstring(width = 7, height = 3.6, pointsize = 11)
    par(mar = c(4, 4.2, 2, 1), col.axis = "#555555", col.lab = "#333333", fg = "#999999")
    plot(vol, type = "l", col = "${ACCENT}", lwd = 1.4, xlab = "Time", ylab = "Conditional SD",
         main = "Conditional volatility")
    dev.off(); svg <- .ct_dev()
    list(terms = aterms, est = as.numeric(cf[, 1]), se = as.numeric(cf[, 2]),
         t = as.numeric(cf[, 3]), p = as.numeric(cf[, 4]),
         persist = persist, ll = ll, aic = aic, n = length(x), svg = svg)`;
  const r = flat(await runR(app, rCode));
  const terms = r.strs('terms'), est = r.nums('est'), se = r.nums('se'), tv = r.nums('t'), pv = r.nums('p');

  await app.results.appendTable(
    {
      columns: ['', 'Estimate', 'Std. Error', 't', 'Sig.'],
      rows: terms.map((t, i) => [garchTerm(t), f(est[i], 5), f(se[i], 5), f(tv[i], 2), fmtP(pv[i])]),
      rowHeaders: true,
    },
    { caption: `GARCH(${Q},${P}) — ${labelOf(meta.get(sName), sName)} (N = ${r.num('n')}, ${cd})` },
  );
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Persistence (Σα + Σβ)', f(r.num('persist'), 4)],
        ['Log-likelihood', f(r.num('ll'), 2)],
        ['AIC', f(r.num('aic'), 2)],
      ],
      rowHeaders: true,
    },
    { caption: 'Model Summary' },
  );
  const svg = r.str1('svg');
  if (svg && /<svg[\s>]/i.test(svg)) await app.results.appendPlot(cleanSvg(svg));
  await app.results.appendText(
    'GARCH models **volatility clustering** — periods where large changes follow large changes. **α** is the reaction to recent shocks, **β** the carry-over of past volatility; **persistence (α+β)** near 1 means shocks to volatility die out slowly. The plot shows the estimated conditional standard deviation over time.',
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

function garchTerm(t) {
  if (t === 'mu') return 'μ (mean)';
  if (t === 'omega') return 'ω (constant)';
  if (/^alpha/.test(t)) return `α${t.replace('alpha', '')} (ARCH)`;
  if (/^beta/.test(t)) return `β${t.replace('beta', '')} (GARCH)`;
  if (t === 'shape') return 'shape (df/ν)';
  if (t === 'skew') return 'skew';
  return t;
}

function metaMap(meta) {
  return new Map(meta.map((m) => [m.name, m]));
}

function recodeLine(expr, meta) {
  const mv = (meta?.missingValues ?? []).filter((v) => Number.isFinite(Number(v)));
  return mv.length ? `${expr}[${expr} %in% c(${mv.map(Number).join(', ')})] <- NA` : '';
}

function labelOf(meta, name) {
  return meta?.label ? `${meta.label} (${name})` : name;
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
