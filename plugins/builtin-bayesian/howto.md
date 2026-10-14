# builtin-bayesian — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: bayes-regression
[Linear regression](howto:regression-linear) estimated in the Bayesian way: posterior means and SDs with **credible intervals**.

**Analyze ▸ Bayesian ▸ Linear regression…**, then pick the outcome and predictors.

A 95% credible interval means what most people wrongly believe a confidence interval means: given the model and the data, there is a 95% probability the parameter lies in it. That directness is the main practical reason to prefer it when reporting.

Syntax:

`run builtin-bayesian.regression {"dv": "income", "ivs": ["age", "education"]}`

--- id: bayes-ttest
A Bayes factor for a two-group comparison — how much the data favours one hypothesis over the other.

**Analyze ▸ Bayesian ▸ Bayes factor: t-test…**, then pick the numeric outcome **y** and the two-level **group**.

The reason to reach for it: a Bayes factor can support the **null**. A non-significant [t-test](howto:compare-independent) is silent between "no effect" and "not enough data", and a BF near 1 versus a BF of 10 in favour of the null are completely different findings that a p-value cannot distinguish.

Syntax:

`run builtin-bayesian.bfTTest {"y": "score", "group": "condition"}`

--- id: bayes-corr
A Bayes factor for [a correlation](howto:correlation-bivariate), with the same advantage as [the t-test version](howto:bayes-ttest): it can quantify evidence *for* the absence of a relationship rather than merely failing to find one.

**Analyze ▸ Bayesian ▸ Bayes factor: correlation…**, then pick the two variables.

Syntax:

`run builtin-bayesian.bfCorr {"x": "x", "y": "y"}`

--- id: bayes-bvar
[Vector autoregression](howto:var-model) with Bayesian shrinkage, and a forecast band rather than a point path.

**Analyze ▸ Bayesian ▸ Vector autoregression (BVAR)…**, then pick two or more series and set **lags** and **horizon**.

VARs run out of degrees of freedom quickly — every extra series and lag multiplies the parameters. Shrinkage is what keeps a richer model usable on a short series, which is the usual reason to choose this over the classical version.

Syntax:

`run builtin-bayesian.bvar {"series": ["gdp", "cpi"], "lags": 2, "horizon": 8}`
