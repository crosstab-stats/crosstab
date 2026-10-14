# builtin-countmodels — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: count-poisson
For an outcome that is a **count** — number of events, visits, citations.

**Analyze ▸ Regression ▸ Poisson regression…**, then pick the count outcome and predictors.

Coefficients come with **incidence-rate ratios** (exp B): 1.3 means 30% more events per unit of the predictor.

The output includes an **overdispersion check**. Poisson assumes the variance equals the mean; real counts are often more variable than that, and when the check says so the model's standard errors are too small and its p-values too cheerful. [Negative binomial](howto:count-negbin) is the over-dispersed alternative.

Syntax:

`run builtin-countmodels.poisson {"dv": "events", "ivs": ["age", "treatment"]}`

--- id: count-negbin
The over-dispersed alternative to [Poisson](howto:count-poisson): same kind of outcome, one extra parameter for the excess variability.

**Analyze ▸ Regression ▸ Negative binomial regression…**, then pick the count outcome and predictors.

Reach for it when Poisson's overdispersion check says the variance exceeds the mean. The coefficients usually move very little; the standard errors widen, which is the point — the difference between the two models is mostly about how confident you are entitled to be.

Syntax:

`run builtin-countmodels.negbin {"dv": "events", "ivs": ["age", "treatment"]}`
