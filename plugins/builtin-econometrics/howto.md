# builtin-econometrics — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: econ-robust
OLS with heteroskedasticity-consistent standard errors, plus the Breusch–Pagan test.

**Analyze ▸ Econometrics ▸ Robust (HC) regression…**, then pick the outcome and predictors.

Heteroskedasticity — error variance that changes with the predictors — leaves the coefficients unbiased but makes the classical standard errors wrong. HC1 fixes the standard errors and leaves the estimates alone.

For correlation **within groups** rather than changing variance, the right tool is [cluster-robust](howto:clusterse-robust) instead.

Syntax:

`run builtin-econometrics.robust {"dv": "wage", "ivs": ["educ", "exper"]}`

--- id: econ-iv
For a predictor that is **endogenous** — correlated with the error, so its coefficient is not the effect you want.

**Analyze ▸ Econometrics ▸ Instrumental variables (2SLS)…**, then set:

- **endog** — the endogenous regressor(s);
- **instruments** — the instrument(s);
- **controls** — optional exogenous controls.

An instrument must predict the endogenous variable and affect the outcome **only through it**. The first half is testable and the diagnostics report it; the second half is not testable at all and rests entirely on your argument about the setting.

Weak instruments are the standard failure: when the instrument barely predicts the regressor, 2SLS can be more biased than the OLS it was meant to fix, and its confidence intervals mislead. Check the first-stage strength before believing the second stage.

Syntax:

`run builtin-econometrics.iv {"dv": "wage", "endog": ["educ"], "instruments": ["nearc"], "controls": ["exper"]}`

--- id: econ-panel
For data with the same units observed repeatedly — firms over years, people over waves.

**Analyze ▸ Econometrics ▸ Panel regression (FE / RE)…**, then pick the outcome, predictors and the entity and time identifiers.

**Fixed effects** uses only variation within each unit, so anything constant about a unit — measured or not — is differenced away. That is its strength and its limit: it controls for unobserved stable confounders, and it cannot estimate the effect of anything that does not change within a unit.

**Random effects** uses both within and between variation and is more efficient, at the price of assuming the unit effects are uncorrelated with the predictors. The Hausman test is the usual arbiter.

[A multilevel model](howto:multilevel-linear) expresses much the same structure from a different tradition, with more interest in the variance components themselves.

Syntax:

`run builtin-econometrics.panel {"dv": "y", "ivs": ["x"], "id": "firm", "time": "year"}`
