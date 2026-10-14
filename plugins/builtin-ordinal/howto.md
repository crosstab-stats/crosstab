# builtin-ordinal — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: ordinal-ordinal
For an outcome with **ordered** categories — a Likert scale, a satisfaction rating, a severity grade.

**Analyze ▸ Regression ▸ Ordinal logistic regression…**, then pick the outcome and predictors.

You get odds ratios under the **proportional odds** assumption, plus the thresholds between categories. Proportional odds means one set of coefficients is assumed to describe every cut-point: the effect of a predictor on "at least agree" is taken to be the same as on "at least strongly agree".

If the categories are not genuinely ordered, [multinomial](howto:ordinal-multinomial) is the right model — ordinal buys its precision by assuming an order that must actually be there.

Syntax:

`run builtin-ordinal.ordinal {"dv": "satisfaction", "ivs": ["age", "income"]}`

--- id: ordinal-multinomial
For an outcome with **unordered** categories — which party, which brand, which diagnosis.

**Analyze ▸ Regression ▸ Multinomial logistic regression…**, then pick the outcome and predictors.

You get relative-risk ratios per category, each compared with a baseline. Every predictor therefore has one coefficient *per outcome category*, which is why the table is long and why a predictor can push toward one category and away from another.

If the outcome IS ordered, [ordinal](howto:ordinal-ordinal) uses that and gives you far fewer numbers to interpret.

Syntax:

`run builtin-ordinal.multinomial {"dv": "party", "ivs": ["age", "income"]}`
