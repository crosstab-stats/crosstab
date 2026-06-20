/**
 * @file plugins/builtin-timeseries/index.js
 * Built-in plugin: Time Series ▸ the econometrician's starting kit, run on a
 * numeric column taken in row order as the series:
 *  - **Correlogram** — ACF & PACF plots + a Ljung–Box test for autocorrelation.
 *  - **Stationarity** — ADF and KPSS tests (tseries), with their opposite nulls.
 *  - **Decomposition** — STL into trend / seasonal / remainder (needs a seasonal
 *    frequency, e.g. 12 for monthly, 4 for quarterly).
 *  - **ARIMA forecast** — auto.arima picks the model (forecast), then forecasts h
 *    steps with 95% intervals and a plot.
 *
 * Pairs with the FRED importer. The series is the column in its current row order;
 * non-finite values are dropped.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-timeseries',
  name: 'Time Series',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Time Series',
  keywords: ['time series', 'acf', 'pacf', 'arima', 'forecast', 'stationarity', 'adf', 'kpss', 'stl', 'decomposition', 'autocorrelation'],
  rPackages: ['tseries', 'forecast', 'svglite'],
  menu: [
    {
      label: 'Correlogram (ACF / PACF)…',
      run: 'correlogram',
      order: 10,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', types: ['numeric'] },
        { name: 'maxlag', kind: 'number', label: 'Max lag (0 = auto)', default: 0 },
      ],
    },
    {
      label: 'Stationarity tests (ADF, KPSS)…',
      run: 'stationarity',
      order: 20,
      inputs: [{ name: 'series', kind: 'variables', label: 'Series', types: ['numeric'] }],
    },
    {
      label: 'Decomposition (STL)…',
      run: 'decompose',
      order: 30,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', types: ['numeric'] },
        { name: 'frequency', kind: 'number', label: 'Seasonal frequency (e.g. 12 monthly, 4 quarterly)', default: 12 },
      ],
    },
    {
      label: 'ARIMA forecast (auto)…',
      run: 'arima',
      order: 40,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', types: ['numeric'] },
        { name: 'h', kind: 'number', label: 'Forecast horizon (steps)', default: 10 },
        { name: 'frequency', kind: 'number', label: 'Seasonal frequency (1 = non-seasonal)', default: 1 },
      ],
    },
  ],
};

export async function correlogram(app, { series, maxlag }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const ml = Number.isFinite(maxlag) && maxlag >= 1 ? Math.round(maxlag) : null;
  const rCode = `
    ${recode('series', missing(meta, series))}
    x <- series[is.finite(series)]
    library(svglite)
    .d1 <- svgstring(width = 6.2, height = 3.4, pointsize = 10); par(mar = c(4, 4, 2, 1))
    acf(x, lag.max = ${ml || 'NULL'}, main = "ACF"); dev.off(); svgAcf <- .d1()
    .d2 <- svgstring(width = 6.2, height = 3.4, pointsize = 10); par(mar = c(4, 4, 2, 1))
    pacf(x, lag.max = ${ml || 'NULL'}, main = "PACF"); dev.off(); svgPacf <- .d2()
    lb <- Box.test(x, lag = min(20, length(x) - 1), type = "Ljung-Box")
    list(svgAcf = svgAcf, svgPacf = svgPacf, n = length(x),
         lbStat = unname(lb$statistic), lbDf = unname(lb$parameter), lbP = lb$p.value)`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendText(`**Correlogram — ${label(meta, series)}** (N = ${int(r.n1('n'))})`);
  if (/<svg[\s>]/i.test(r.s1('svgAcf'))) await app.results.appendPlot(stripSize(r.s1('svgAcf')));
  if (/<svg[\s>]/i.test(r.s1('svgPacf'))) await app.results.appendPlot(stripSize(r.s1('svgPacf')));
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Ljung–Box Q', f(r.n1('lbStat'), 3)],
        ['df', int(r.n1('lbDf'))],
        ['Sig.', fmtP(r.n1('lbP'))],
      ],
      rowHeaders: true,
    },
    { caption: 'Ljung–Box test (H₀: no autocorrelation)' },
  );
}

export async function stationarity(app, { series }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const rCode = `
    ${recode('series', missing(meta, series))}
    x <- series[is.finite(series)]
    library(tseries)
    adf <- suppressWarnings(adf.test(x)); kp <- suppressWarnings(kpss.test(x))
    list(adfStat = unname(adf$statistic), adfP = adf$p.value,
         kpssStat = unname(kp$statistic), kpssP = kp$p.value, n = length(x))`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendTable(
    {
      columns: ['Test', 'Statistic', 'Sig.', 'Null hypothesis'],
      rows: [
        ['Augmented Dickey–Fuller', f(r.n1('adfStat'), 3), fmtP(r.n1('adfP')), 'unit root (non-stationary)'],
        ['KPSS', f(r.n1('kpssStat'), 3), fmtP(r.n1('kpssP')), 'stationary'],
      ],
      rowHeaders: true,
    },
    { caption: `Stationarity — ${label(meta, series)} (N = ${int(r.n1('n'))})` },
  );
  await app.results.appendText('Stationary if ADF is significant (p < .05, reject unit root) **and** KPSS is not (p > .05). The two have opposite nulls, so they cross-check each other. (p-values are clipped to the tests’ tables at the extremes.)');
}

export async function decompose(app, { series, frequency }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const freq = Number.isFinite(frequency) ? Math.round(frequency) : 12;
  const rCode = `
    ${recode('series', missing(meta, series))}
    x <- series[is.finite(series)]
    f <- ${freq}
    if (f < 2) stop("STL needs a seasonal frequency >= 2")
    if (length(x) < 2 * f) stop(paste0("need at least two full periods (", 2 * f, " observations) for frequency ", f))
    ts1 <- ts(x, frequency = f)
    fit <- stl(ts1, s.window = "periodic")
    library(svglite); .d <- svgstring(width = 6.6, height = 5.2, pointsize = 10)
    plot(fit, main = "STL Decomposition"); dev.off()
    list(svg = .d(), n = length(x))`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendText(`**STL Decomposition — ${label(meta, series)}** (frequency ${freq}, N = ${int(r.n1('n'))})`);
  if (/<svg[\s>]/i.test(r.s1('svg'))) await app.results.appendPlot(stripSize(r.s1('svg')));
}

export async function arima(app, { series, h, frequency }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const horizon = Number.isFinite(h) && h >= 1 ? Math.round(h) : 10;
  const freq = Number.isFinite(frequency) && frequency >= 1 ? Math.round(frequency) : 1;
  const rCode = `
    ${recode('series', missing(meta, series))}
    x <- series[is.finite(series)]
    ts1 <- ts(x, frequency = ${freq})
    library(forecast)
    fit <- auto.arima(ts1)
    fc <- forecast(fit, h = ${horizon})
    library(svglite); .d <- svgstring(width = 6.6, height = 4, pointsize = 10); par(mar = c(4, 4, 2, 1))
    plot(fc, main = "ARIMA forecast"); dev.off()
    list(order = paste(arimaorder(fit), collapse = ", "), aic = fit$aic,
         point = as.numeric(fc$mean), lo = as.numeric(fc$lower[, ncol(fc$lower)]),
         hi = as.numeric(fc$upper[, ncol(fc$upper)]), svg = .d())`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Model (p,d,q)(P,D,Q)', r.s1('order')],
        ['AIC', f(r.n1('aic'), 2)],
      ],
      rowHeaders: true,
    },
    { caption: `ARIMA — ${label(meta, series)}` },
  );
  const point = r.num('point');
  const lo = r.num('lo');
  const hi = r.num('hi');
  await app.results.appendTable(
    {
      columns: ['Step', 'Forecast', '95% Low', '95% High'],
      rows: point.map((pt, i) => [String(i + 1), f(pt, 3), f(lo[i], 3), f(hi[i], 3)]),
      rowHeaders: true,
    },
    { caption: 'Forecast' },
  );
  if (/<svg[\s>]/i.test(r.s1('svg'))) await app.results.appendPlot(stripSize(r.s1('svg')));
}

// --- helpers -----------------------------------------------------------------

function metaMap(meta) {
  return new Map((meta || []).map((m) => [m.name, m]));
}
function label(meta, name) {
  return meta.get(name)?.label || name;
}
function missing(meta, name) {
  return (meta.get(name)?.missingValues ?? []).filter((v) => Number.isFinite(Number(v))).map(Number);
}
function recode(rvar, mv) {
  return mv.length ? `${rvar}[${rvar} %in% c(${mv.join(', ')})] <- NA` : '';
}
function stripSize(svg) {
  return svg.replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
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
    num: (k) => arr(byName[k]).map((x) => (x == null ? NaN : Number(x))),
    str: (k) => arr(byName[k]).map((x) => (x == null ? '' : String(x))),
    n1: (k) => {
      const a = arr(byName[k]);
      return a.length ? (a[0] == null ? NaN : Number(a[0])) : NaN;
    },
    s1: (k) => {
      const a = arr(byName[k]);
      return a.length ? String(a[0] ?? '') : '';
    },
  };
}
const f = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '—');
const fmtP = (p) => (Number.isFinite(p) ? (p < 0.001 ? '< .001' : p.toFixed(3)) : '—');
