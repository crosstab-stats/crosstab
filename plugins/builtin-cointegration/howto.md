# builtin-cointegration — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: cointegration-johansen
Two series that both wander can still be tied together in the long run. Cointegration tests for exactly that.

**Analyze ▸ Time Series ▸ Cointegration (Johansen)…**, then pick two or more non-stationary series in time order, with **ecdet** (`const`, `trend` or `none`) and **K** (lags in levels, at least 2).

You get the trace test and a VECM.

This is the distinction between a real long-run relationship and a [spurious regression](howto:ts-stationarity) — two unrelated trending series will look strongly related to ordinary regression, and this is how you tell the cases apart rather than hoping.

Syntax:

`run builtin-cointegration.cointegration {"series": ["gdp", "consumption"], "ecdet": "const", "K": 2}`

--- id: cointegration-garch
Models how **variance** changes over time — the clustering of calm and turbulent periods that returns data famously shows.

**Analyze ▸ Time Series ▸ GARCH volatility…**, then pick the return **series** and set **q**/**p** (the ARCH and GARCH orders, 1/1 is the usual starting point) and the error **dist**.

You get the model and a conditional-SD plot. GARCH(1,1) is the standard first fit, and a heavier-tailed distribution than `norm` is often the more realistic choice for financial returns.

Note this models the variance, not the mean: it says when the series is volatile, not which way it is going.

Syntax:

`run builtin-cointegration.garch {"series": "returns", "q": 1, "p": 1, "dist": "norm"}`
