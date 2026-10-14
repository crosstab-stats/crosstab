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

/**
 * The host's reporting formatters, from core/plugin-stdlib.js.
 *
 * Read from the sandbox global rather than `app.std` because these are module-scope
 * helpers and `app` exists only inside an invoked function. One implementation, because
 * the local copies had drifted: 32 of `fmtP` in three different spellings of "p < .001".
 */
const { fmtP, fixed: f, rounded: int, metaMap, unpackR: flat } = globalThis.ctStd;

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-timeseries',
  name: 'Time Series',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Time Series',
  keywords: ['time series', 'acf', 'pacf', 'arima', 'forecast', 'stationarity', 'adf', 'kpss', 'stl', 'decomposition', 'autocorrelation'],
  disciplines: ['Economics', 'Public Policy & Administration', 'Environmental Studies'],
  howto:
    'GUI: Time Series ▸ Correlogram… / Stationarity tests… / Decomposition… / ARIMA forecast…, then pick a numeric series (taken in row order). You get ACF/PACF, ADF & KPSS tests, an STL split, or a forecast.\n' +
    'Syntax: run builtin-timeseries.correlogram {"series": "value", "maxlag": 0}\n' +
    'Syntax: run builtin-timeseries.stationarity {"series": "value"}\n' +
    'Syntax: run builtin-timeseries.decompose {"series": "value", "frequency": 12}\n' +
    'Syntax: run builtin-timeseries.arima {"series": "value", "h": 10, "frequency": 1}\n' +
    '  • series — the numeric column, in time order.\n' +
    '  • frequency — steps per seasonal cycle (12 monthly, 4 quarterly); h — forecast horizon.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'ts-correlogram',
      title: 'Correlogram (ACF / PACF)',
      category: 'Time Series',
      keywords: ['acf', 'pacf', 'autocorrelation', 'correlogram', 'lag', 'time series', 'serial correlation'],
      needs: ['builtin-timeseries'],
      seeAlso: ['ts-stationarity', 'ts-arima'],
    },
    {
      id: 'ts-stationarity',
      title: 'Stationarity tests (ADF, KPSS)',
      category: 'Time Series',
      keywords: ['stationarity', 'adf', 'kpss', 'unit root', 'dickey fuller', 'differencing', 'trend', 'time series'],
      needs: ['builtin-timeseries'],
      seeAlso: ['ts-correlogram', 'ts-arima', 'cointegration-johansen'],
    },
    {
      id: 'ts-decompose',
      title: 'Decomposition (STL)',
      category: 'Time Series',
      keywords: ['decomposition', 'stl', 'seasonal', 'trend', 'remainder', 'frequency', 'seasonality', 'time series'],
      needs: ['builtin-timeseries'],
      seeAlso: ['ts-arima', 'plots-trends'],
    },
    {
      id: 'ts-arima',
      title: 'ARIMA forecast (auto)',
      category: 'Time Series',
      keywords: ['arima', 'forecast', 'prediction', 'auto arima', 'horizon', 'time series', 'seasonal', 'projection'],
      needs: ['builtin-timeseries'],
      seeAlso: ['ts-stationarity', 'ts-decompose'],
    },
  ],
  rPackages: ['tseries', 'forecast', 'svglite'],
  menu: [
    {
      howto: 'ts-correlogram',
      label: 'Correlogram (ACF / PACF)…',
      run: 'correlogram',
      order: 10,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', hint: 'The numeric column to analyze, taken in row order over time.', types: ['numeric'] },
        { name: 'maxlag', kind: 'number', label: 'Max lag (0 = auto)', hint: 'How many past time steps to check; 0 picks a sensible default.', default: 0 },
      ],
    },
    {
      howto: 'ts-stationarity',
      label: 'Stationarity tests (ADF, KPSS)…',
      run: 'stationarity',
      order: 20,
      inputs: [{ name: 'series', kind: 'variables', label: 'Series', hint: 'The numeric column to test for a stable mean over time.', types: ['numeric'] }],
    },
    {
      howto: 'ts-decompose',
      label: 'Decomposition (STL)…',
      run: 'decompose',
      order: 30,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', hint: 'The numeric column to split into trend, season, and remainder.', types: ['numeric'] },
        { name: 'frequency', kind: 'number', label: 'Seasonal frequency (e.g. 12 monthly, 4 quarterly)', hint: 'How many time steps make one full cycle, like 12 for monthly.', default: 12 },
      ],
    },
    {
      howto: 'ts-arima',
      label: 'ARIMA forecast (auto)…',
      run: 'arima',
      order: 40,
      inputs: [
        { name: 'series', kind: 'variables', label: 'Series', hint: 'The numeric column to fit a model to and project forward.', types: ['numeric'] },
        { name: 'h', kind: 'number', label: 'Forecast horizon (steps)', hint: 'How many future time steps to predict.', default: 10 },
        { name: 'frequency', kind: 'number', label: 'Seasonal frequency (1 = non-seasonal)', hint: 'How many steps make one cycle; use 1 if there is no season.', default: 1 },
      ],
    },
  ],
};

export async function correlogram(app, { series, maxlag }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const ml = Number.isFinite(maxlag) && maxlag >= 1 ? Math.round(maxlag) : null;
  // Layer-2 correlograms: compute ACF/PACF values (plot = FALSE) and emit bar charts
  // the host renders with live controls; no svglite for these two.
  const rCode = `
    x <- series[is.finite(series)]
    af <- acf(x, lag.max = ${ml || 'NULL'}, plot = FALSE)
    pf <- pacf(x, lag.max = ${ml || 'NULL'}, plot = FALSE)
    lb <- Box.test(x, lag = min(20, length(x) - 1), type = "Ljung-Box")
    list(
      acf = as.numeric(af$acf), acfLag = as.numeric(af$lag),
      pacf = as.numeric(pf$acf), pacfLag = as.numeric(pf$lag),
      ci = qnorm(0.975) / sqrt(length(x)), n = length(x),
      lbStat = unname(lb$statistic), lbDf = unname(lb$parameter), lbP = lb$p.value)`;
  const r = flat((await app.webr.run(rCode)).result);
  const seriesLabel = label(meta, series);
  await app.results.appendText(`**Correlogram — ${seriesLabel}** (N = ${int(r.num1('n'))})`);
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const corrChart = (title, seriesLbl, vals, lags) => ({
    kind: 'categorical',
    title,
    categories: lags.map((L) => ({ key: String(Math.round(L)), label: String(Math.round(L)) })),
    series: [{ key: 'r', label: seriesLbl, values: vals.map(round3) }],
    axes: { x: { title: 'Lag' }, y: { title: 'Correlation' } },
    view: { mark: 'bar', legend: 'none' },
  });
  const acf = r.nums('acf');
  const pacf = r.nums('pacf');
  if (acf.length) await app.results.appendChart(corrChart(`ACF — ${seriesLabel}`, 'ACF', acf, r.nums('acfLag')));
  if (pacf.length) await app.results.appendChart(corrChart(`PACF — ${seriesLabel}`, 'Partial ACF', pacf, r.nums('pacfLag')));
  const ci = r.num1('ci');
  if (Number.isFinite(ci)) {
    await app.results.appendText(`_95% significance bound ≈ ±${round3(ci)}; bars beyond it indicate autocorrelation._`);
  }
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Ljung–Box Q', f(r.num1('lbStat'), 3)],
        ['df', int(r.num1('lbDf'))],
        ['Sig.', fmtP(r.num1('lbP'))],
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
        ['Augmented Dickey–Fuller', f(r.num1('adfStat'), 3), fmtP(r.num1('adfP')), 'unit root (non-stationary)'],
        ['KPSS', f(r.num1('kpssStat'), 3), fmtP(r.num1('kpssP')), 'stationary'],
      ],
      rowHeaders: true,
    },
    { caption: `Stationarity — ${label(meta, series)} (N = ${int(r.num1('n'))})` },
  );
  await app.results.appendText('Stationary if ADF is significant (p < .05, reject unit root) **and** KPSS is not (p > .05). The two have opposite nulls, so they cross-check each other. (p-values are clipped to the tests’ tables at the extremes.)');
}

export async function decompose(app, { series, frequency }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const freq = Number.isFinite(frequency) ? Math.round(frequency) : 12;
  const rCode = `
    x <- series[is.finite(series)]
    f <- ${freq}
    if (f < 2) stop("STL needs a seasonal frequency >= 2")
    if (length(x) < 2 * f) stop(paste0("need at least two full periods (", 2 * f, " observations) for frequency ", f))
    ts1 <- ts(x, frequency = f)
    fit <- stl(ts1, s.window = "periodic")
    library(svglite); .d <- svgstring(width = 6.6, height = 5.2, pointsize = 10)
    plot(fit); dev.off()
    list(svg = .d(), n = length(x))`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendText(`**STL Decomposition — ${label(meta, series)}** (frequency ${freq}, N = ${int(r.num1('n'))})`);
  if (/<svg[\s>]/i.test(r.str1('svg'))) await app.results.appendPlot(stripSize(r.str1('svg')), { title: `STL Decomposition — ${label(meta, series)}` });
}

export async function arima(app, { series, h, frequency }) {
  if (!series) return void app.results.appendError('Pick a series.');
  const meta = metaMap(await app.data.getVariableMeta());
  const horizon = Number.isFinite(h) && h >= 1 ? Math.round(h) : 10;
  const freq = Number.isFinite(frequency) && frequency >= 1 ? Math.round(frequency) : 1;
  const rCode = `
    x <- series[is.finite(series)]
    ts1 <- ts(x, frequency = ${freq})
    library(forecast)
    fit <- auto.arima(ts1)
    fc <- forecast(fit, h = ${horizon})
    library(svglite); .d <- svgstring(width = 6.6, height = 4, pointsize = 10); par(mar = c(4, 4, 2, 1))
    plot(fc, main = ""); dev.off()
    list(order = paste(arimaorder(fit), collapse = ", "), aic = fit$aic,
         point = as.numeric(fc$mean), lo = as.numeric(fc$lower[, ncol(fc$lower)]),
         hi = as.numeric(fc$upper[, ncol(fc$upper)]), svg = .d())`;
  const r = flat((await app.webr.run(rCode)).result);
  await app.results.appendTable(
    {
      columns: ['', 'Value'],
      rows: [
        ['Model (p,d,q)(P,D,Q)', r.str1('order')],
        ['AIC', f(r.num1('aic'), 2)],
      ],
      rowHeaders: true,
    },
    { caption: `ARIMA — ${label(meta, series)}` },
  );
  const point = r.nums('point');
  const lo = r.nums('lo');
  const hi = r.nums('hi');
  await app.results.appendTable(
    {
      columns: ['Step', 'Forecast', '95% Low', '95% High'],
      rows: point.map((pt, i) => [String(i + 1), f(pt, 3), f(lo[i], 3), f(hi[i], 3)]),
      rowHeaders: true,
    },
    { caption: 'Forecast' },
  );
  if (/<svg[\s>]/i.test(r.str1('svg'))) await app.results.appendPlot(stripSize(r.str1('svg')), { title: `ARIMA forecast — ${label(meta, series)}` });
}

// --- helpers -----------------------------------------------------------------

function label(meta, name) {
  return meta.get(name)?.label || name;
}
function stripSize(svg) {
  return svg.replace(/(<svg\b[^>]*?)\s+width='[^']*'/i, '$1').replace(/(<svg\b[^>]*?)\s+height='[^']*'/i, '$1');
}
