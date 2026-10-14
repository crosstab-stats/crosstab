# builtin-compare — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: compare-one-sample
Compares one group's mean against a fixed value — a target, a published norm, zero.

**Analyze ▸ Comparison ▸ One-sample t-test…**, then pick the numeric variable and set **mu**, the reference value (default 0).

Set `mu` deliberately. Testing against 0 is the default because it is the common case, not because it is usually the interesting one: for a change score 0 is meaningful, for a raw measurement it rarely is.

Syntax:

`run builtin-compare.oneSample {"x": "score", "mu": 0}`

--- id: compare-independent
Compares the means of **two separate groups** — treatment versus control, men versus women.

**Analyze ▸ Comparison ▸ Independent-samples t-test…**, then pick:

- **y** — the numeric outcome;
- **g** — the grouping variable;
- **g1** / **g2** — which two groups to compare. The difference reported is **g1 − g2**, so swapping them flips the sign. Omit them and the first two groups are used.

The output follows SPSS, with Levene's test and both the equal-variances and Welch rows. [If Levene's is significant](howto:assumptions-levene), read the Welch row — that is what it is there for.

Different people measured once each is this test. The **same** people measured twice is [paired](howto:compare-paired), and using the wrong one of the two is the most common test-selection error there is.

Syntax:

`run builtin-compare.independent {"y": "score", "g": "group", "g1": "A", "g2": "B"}`

--- id: compare-paired
For **two measures on the same cases** — before and after, left and right, twin and twin.

**Analyze ▸ Comparison ▸ Paired-samples t-test…**, then pick **x1** and **x2**.

Pairing is what gives the test its power: it analyses each case's own change, so stable differences between people cancel out instead of becoming noise. Treating paired data as [independent](howto:compare-independent) throws that away and usually loses the effect.

[A before-after plot](howto:plots-before-after) is the natural figure to go with it — it shows whether everyone moved a little or a few moved a lot, which the means cannot.

Syntax:

`run builtin-compare.paired {"x1": "pre", "x2": "post"}`

--- id: compare-oneway
Compares the means of **three or more** groups at once.

**Analyze ▸ Comparison ▸ One-way ANOVA…**, then pick the numeric outcome **y** and the grouping variable **g**.

A significant F says the group means are not all equal. It does **not** say which differ — that needs a post-hoc comparison, and reading the group means and deciding by eye is where false positives come from.

Running a t-test on every pair instead is the thing ANOVA exists to avoid: each test carries its own error rate, and with four groups that is six chances to find something that is not there. For two factors at once, see [factorial ANOVA](howto:anova-factorial).

Syntax:

`run builtin-compare.oneway {"y": "score", "g": "group"}`
