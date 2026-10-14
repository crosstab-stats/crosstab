# builtin-var — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: var-model
Several series modelled together, each as a function of the recent past of all of them.

**Analyze ▸ Time Series ▸ Vector autoregression (VAR)…**, then pick two or more series in time order and set:

- **lag** — how many past periods; 0 chooses by AIC.
- **type** — `const`, `trend`, `both` or `none`.
- **horizon** — how far the impulse responses run.

You get lag selection, per-equation coefficients, **Granger causality** and an impulse-response grid.

"Granger causality" means one series helps predict another. That is a statement about forecasting, not about cause, and the name has misled generations of readers — say "Granger-causes" or "helps predict", never just "causes".

Series should be [stationary](howto:ts-stationarity) first; if they are not but move together, [cointegration](howto:cointegration-johansen) is the model that handles it.

Syntax:

`run builtin-var.varModel {"series": ["gdp", "inflation"], "lag": 0, "type": "const", "horizon": 10}`
