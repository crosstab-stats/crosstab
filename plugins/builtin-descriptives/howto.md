# builtin-descriptives — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: descriptives-basics
**Analyze ▸ Descriptive Statistics ▸ Descriptives…** gives the SPSS-style summary table: N, missing, mean, standard deviation, variance, minimum, maximum, range, quartiles and mode — one row per variable.

Pick one or more variables and run it. Declared [missing codes](howto:variable-types) are excluded, and the table reports how many cases that cost, so the N you see is the N the numbers were computed from.

Labelled categorical variables can be chosen too. Most of the table will be meaningless for one, but the **mode** is exactly right — it is the statistic that means something for a nominal variable, and the reason they are not refused outright.

For counts per category rather than summary statistics, [a frequency table](howto:frequencies-basics) is the better tool.

Syntax:

`run builtin-descriptives.run {"vars": ["age", "income"]}`

--- id: descriptives-explore
**Analyze ▸ Descriptive Statistics ▸ Explore (confidence interval for the mean)…** is SPSS's Explore: a point estimate with a lower and upper bound.

1. Pick the variables.
2. Set the **confidence level** — 95% unless you have a reason, and say which you used when reporting.
3. Optionally give a **grouping variable** to get a separate interval per group.

Splitting by a group is how you compare two means informally — but overlapping intervals are not a significance test, and non-overlapping ones are a conservative one. If the comparison is the point, run the test that answers it rather than reading it off the bounds.

Both this and plain [Descriptives](howto:descriptives-basics) accept a [survey weight](howto:weight-cases), read as a frequency weight, so N becomes its sum.

Syntax:

`run builtin-descriptives.explore {"vars": ["tvhours"], "level": 99, "by": "sex"}`
