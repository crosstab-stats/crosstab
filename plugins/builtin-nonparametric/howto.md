# builtin-nonparametric — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: nonparametric-mannwhitney
The rank-based counterpart of [the independent-samples t-test](howto:compare-independent): two separate groups, no normality assumption.

**Analyze ▸ Nonparametric ▸ Mann-Whitney U (2 groups)…**, then pick the test variable **y** and the grouping variable **g**.

You get a ranks table, the statistic, the normal-approximation Z, the asymptotic p and an effect size.

Use it for ordinal outcomes, small samples, or distributions that will not behave. It compares ranks rather than means, so a significant result says the distributions are shifted — report a median or the ranks rather than a mean difference.

Syntax:

`run builtin-nonparametric.mannWhitney {"y": "score", "g": "group"}`

--- id: nonparametric-wilcoxon
The rank-based counterpart of [the paired t-test](howto:compare-paired): two measures on the same cases.

**Analyze ▸ Nonparametric ▸ Wilcoxon signed-rank (paired)…**, then pick **x1** and **x2**.

It ranks each case's own change, so it keeps the advantage of pairing while dropping the normality requirement.

Syntax:

`run builtin-nonparametric.wilcoxon {"x1": "before", "x2": "after"}`

--- id: nonparametric-kruskal
The rank-based counterpart of [one-way ANOVA](howto:compare-oneway): three or more groups.

**Analyze ▸ Nonparametric ▸ Kruskal-Wallis (k groups)…**, then pick **y** and **g**.

As with ANOVA, a significant result says the groups are not all alike and does not say which pair differs.

Syntax:

`run builtin-nonparametric.kruskal {"y": "score", "g": "group"}`
