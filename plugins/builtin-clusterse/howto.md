# builtin-clusterse — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: clusterse-robust
OLS coefficients with standard errors that allow for correlation **within** clusters — pupils in a school, observations on a firm, repeated measures on a person.

**Analyze ▸ Regression ▸ Cluster-robust regression…**, then pick the outcome, the predictors and the **cluster** variable.

The table shows cluster-robust (CR/HC1) standard errors alongside the classical ones, so you can see what ignoring the clustering was costing — usually a good deal of apparent precision.

This corrects the inference and leaves the coefficients alone. If the group structure is itself of interest — how much variance sits between clusters, whether an effect varies across them — [a mixed model](howto:multilevel-linear) answers that and this does not.

Syntax:

`run builtin-clusterse.run {"y": "score", "ivs": ["x", "z"], "cluster": "school"}`
