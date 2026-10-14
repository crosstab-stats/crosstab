# builtin-assumptions — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: regression-assumptions
**Analyze ▸ Assumptions ▸ Normality (Shapiro–Wilk)…**, then pick the numeric variables. You get Shapiro–Wilk, skewness, kurtosis and a Q–Q plot for each.

How to read it, and the trap: the test's power depends on N. With a few thousand cases it will flag departures too small to matter; with twenty it will miss ones that matter a lot. So treat the **Q–Q plot and the skewness** as the evidence and the p-value as a prompt, not the other way round.

What usually needs to be normal is the model's **residuals**, not the raw variable — a skewed predictor is not by itself a problem. And when a distribution really will not behave, [a rank-based test](howto:nonparametric-mannwhitney) answers the same question without the assumption.

Syntax:

`run builtin-assumptions.normality {"vars": ["income", "age"]}`

--- id: assumptions-levene
Several tests assume the groups have similar spread. Levene's test asks whether they do.

**Analyze ▸ Assumptions ▸ Homogeneity of variance (Levene's)…**, then pick the numeric **outcome** and the variable defining the **groups**.

If it says the variances differ, the usual answer is not to abandon the comparison but to use a version that does not assume equality — the [independent-samples t-test](howto:compare-independent) reports Welch's row for exactly this, and reading the right row is the whole fix.

Syntax:

`run builtin-assumptions.levene {"outcome": "income", "groups": "region"}`
