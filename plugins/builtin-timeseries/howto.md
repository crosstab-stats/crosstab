# builtin-timeseries — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: ts-correlogram
Autocorrelation at each lag — how much a series resembles itself one step back, two steps back, and so on.

**Analyze ▸ Time Series ▸ Correlogram (ACF / PACF)…**, then pick the numeric **series**. Rows are taken **in row order**, so the data must already be sorted by time. Set **maxlag** or leave it at 0 to choose automatically.

Slowly decaying autocorrelation usually means the series is not stationary — [check that directly](howto:ts-stationarity) before modelling it. Spikes at seasonal lags (12, 4) say there is a seasonal cycle to account for.

Syntax:

`run builtin-timeseries.correlogram {"series": "value", "maxlag": 0}`

--- id: ts-stationarity
Most time-series methods assume the series is **stationary** — that its mean and variance are not drifting.

**Analyze ▸ Time Series ▸ Stationarity tests (ADF, KPSS)…**, then pick the series.

The two tests are set up opposite ways round, which catches people out: **ADF**'s null is that the series has a unit root (non-stationary), while **KPSS**'s null is that it IS stationary. Agreement between them is reassuring; disagreement usually means the evidence is weak either way.

The standard remedy for a non-stationary series is differencing. Running a regression of one drifting series on another without doing so is how spurious relationships are manufactured — which is what [cointegration](howto:cointegration-johansen) exists to distinguish from the real thing.

Syntax:

`run builtin-timeseries.stationarity {"series": "value"}`

--- id: ts-decompose
Splits a series into trend, seasonal and remainder components.

**Analyze ▸ Time Series ▸ Decomposition (STL)…**, then pick the series and set **frequency** — the number of steps in one seasonal cycle: 12 for monthly data, 4 for quarterly.

Getting `frequency` right is the whole job. Tell it 12 when the data is quarterly and the "seasonal" component it finds is an artefact of the wrong period.

The remainder is often the most informative panel: once trend and season are removed, what is left is the unusual events.

Syntax:

`run builtin-timeseries.decompose {"series": "value", "frequency": 12}`

--- id: ts-arima
Fits an ARIMA model automatically and forecasts forward.

**Analyze ▸ Time Series ▸ ARIMA forecast (auto)…**, then pick the series, the horizon **h**, and the seasonal **frequency** (1 for none).

The forecast comes with a prediction interval, and the interval is the honest part: it widens with the horizon because the uncertainty genuinely does. A point forecast ten steps out quoted without its interval is a guess wearing a decimal point.

ARIMA extrapolates the patterns in the data it was given. It cannot anticipate anything that has not happened before, which is the limitation that matters most in practice.

Syntax:

`run builtin-timeseries.arima {"series": "value", "h": 10, "frequency": 1}`
