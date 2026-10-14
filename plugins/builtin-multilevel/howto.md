# builtin-multilevel — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: multilevel-linear
When cases are **nested** — pupils in schools, measurements in patients, days in people — observations within a group are not independent, and a model that ignores that reports standard errors that are too small.

**Analyze ▸ Regression ▸ Linear mixed model…**, then pick:

- **y** — the outcome;
- **fixed** — the predictors whose average effect you want;
- **group** — the cluster variable, fitted as a random intercept;
- **slope** — optionally, a predictor allowed to vary in effect across groups.

You get fixed effects with Satterthwaite degrees of freedom, the random-effect variances, and the **ICC** — the share of variance that lives between groups rather than within them. A near-zero ICC says the grouping barely matters; a large one says it is most of the story.

If you only want corrected standard errors and not a model of the group structure, [cluster-robust regression](howto:clusterse-robust) is the lighter tool.

Syntax:

`run builtin-multilevel.linear {"y": "achievement", "fixed": ["ses"], "group": "school"}`

--- id: multilevel-logistic
The same nested structure as [the linear mixed model](howto:multilevel-linear), for a **binary** outcome.

**Analyze ▸ Regression ▸ Logistic mixed model…**, then pick the outcome, the fixed predictors and the grouping variable.

Results come as odds ratios. One thing to keep in mind when comparing with [ordinary logistic](howto:logistic-binary): these coefficients are *conditional on the group* — the effect for a typical cluster — rather than averaged over the population, and the two are not the same number even when both are right.

Syntax:

`run builtin-multilevel.logistic {"y": "passed", "fixed": ["ses"], "group": "school"}`
