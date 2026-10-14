# builtin-margins — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: margins-effects
A logistic coefficient is a log-odds, which almost nobody can interpret directly. Marginal effects put the answer back on the scale the question was asked in: **probability**, or expected count.

**Analyze ▸ Regression ▸ Marginal effects (AME / MEM)…**, then pick the outcome and predictors, the model **family** (`logistic`, `probit`, `poisson` or `linear`) and the **kind**:

- **AME** (average marginal effect, the default) — compute the effect for every case, then average. "On average, a one-unit increase is worth this many percentage points."
- **MEM** (marginal effect at the mean) — the effect for one hypothetical case holding everything at its mean. Quicker to say, but that average case may not exist.

Standard errors come from the delta method.

Syntax:

`run builtin-margins.margins {"dv": "voted", "ivs": ["age", "income"], "family": "logistic", "kind": "ame"}`
