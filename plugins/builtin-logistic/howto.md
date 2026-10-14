# builtin-logistic — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: logistic-binary
For an outcome with exactly two categories — passed/failed, voted/did not.

**Analyze ▸ Regression ▸ Binary Logistic…**, then pick the outcome and one or more predictors.

The output is SPSS-shaped: a **Model Summary** (−2LL, Cox & Snell and Nagelkerke R²) and **Variables in the Equation** (B, Wald, Sig., Exp(B)).

**Exp(B) is an odds ratio**, not a probability, and the difference matters when you write it up: 2.0 means the odds double, which is not "twice as likely" unless the baseline probability is small. For effects on the probability scale, use [marginal effects](howto:margins-effects).

**`opts`** turns on the extras: `class` (the classification table, on by default as in SPSS), `ci` (95% CI for Exp(B)), `hl` (Hosmer–Lemeshow and its contingency table), `plot`, and `casewise` (cases with |ZResid| > 2).

Entry is the only method, so there are no steps — nothing for SPSS's "Display: at last step" to choose between.

Syntax:

`run builtin-logistic.run {"dv": "passed", "ivs": ["studyhrs", "attendance"]}`

--- id: logistic-categorical
A predictor that is a **category** has to be dummy-coded, and which category it is measured against changes every coefficient you read.

**`cats`** lists the predictors to dummy-code — SPSS's "Categorical…" button. Variables already typed as factor or text are dummy-coded anyway; list a **numerically coded** one here, otherwise a variable whose codes are 1/2/3 is fitted as a straight line through those numbers, which assumes the categories are evenly spaced and ordered.

**`ref`** picks the reference category: `first` (the default here) or `last`.

**CrossTab defaults to `first`; SPSS defaults to `last`.** That is why assignments written for SPSS tell you to change it — and why a coefficient can look inverted against a worked example. Neither default is wrong, but the comparison only means something when you know which one produced it. Say so when you report.
