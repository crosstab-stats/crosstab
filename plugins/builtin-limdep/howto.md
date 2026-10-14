# builtin-limdep — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: limdep-quantile
Ordinary regression models the **mean**. Quantile regression models whatever part of the distribution you ask for — the median, the 10th percentile, the top decile.

**Analyze ▸ Regression ▸ Quantile regression…**, then pick the outcome, the predictors, and **taus**: a comma-separated list of quantiles, e.g. `0.25, 0.5, 0.75`.

It earns its keep when an effect differs across the distribution — a policy that lifts the bottom without moving the median, say. One mean coefficient cannot show that, and will look like "no effect" when the effects cancel.

Syntax:

`run builtin-limdep.quantile {"y": "wage", "ivs": ["educ"], "taus": "0.25, 0.5, 0.75"}`

--- id: limdep-tobit
For an outcome that piles up at a limit — hours that cannot go below zero, a score that tops out, spending with a floor at nothing.

**Analyze ▸ Regression ▸ Tobit (censored) regression…**, then set the outcome, predictors, and the censoring limits **left** and **right** (0 or blank for none).

Treating censored data as ordinary continuous data biases the slope toward zero, because the model tries to fit values the measurement could never have recorded.

Censoring (the value exists but was not observed past a limit) is different from **selection** (the case is only in the data at all because of something). For the second, see [Heckman](howto:limdep-heckman).

Syntax:

`run builtin-limdep.tobit {"y": "hours", "ivs": ["age"], "left": 0, "right": 0}`

--- id: limdep-heckman
When the outcome is only observed for cases that passed some selection — wages exist only for people in work — modelling the observed cases alone answers a question about the selected group, not the population.

**Analyze ▸ Regression ▸ Heckman selection model…**, then set:

- **y** — the outcome, observed only for the selected;
- **sel** — the selection indicator, 1 where y is observed;
- **outIv** / **selIv** — predictors for the outcome and for selection.

It helps most when `selIv` contains something that affects selection but not the outcome. Identifying the model purely from functional form is possible and fragile, so say which exclusion you relied on.

Syntax:

`run builtin-limdep.heckman {"y": "wage", "outIv": ["educ"], "sel": "working", "selIv": ["kids"]}`
