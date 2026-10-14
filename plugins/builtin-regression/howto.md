# builtin-regression — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: regression-linear
**Analyze ▸ Regression ▸ Linear**, then pick one numeric outcome and one or more predictors.

You get the coefficient table — each predictor's slope, its standard error, t and p — along with the model summary and the ANOVA table.

A coefficient is "the change in the outcome per one-unit change in this predictor, **holding the others in the model fixed**". That last clause is doing the work: adding or removing a predictor can change every other coefficient, so the number is a property of the model you fitted, not of the variable.

Before trusting it, look at [a scatter plot](howto:plots-scatter) — a straight line fitted to a curve has a coefficient, a p-value, and no meaning. [Assumption checks](howto:regression-assumptions) cover the rest.

Syntax:

`run builtin-regression.run {"dv": "income", "ivs": ["age", "educ"]}`
