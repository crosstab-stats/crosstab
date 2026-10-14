# builtin-categorical — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: categorical-gof
Tests whether one categorical variable's counts match an expected distribution.

**Analyze ▸ Categorical ▸ Chi-square goodness-of-fit…**, then pick the **variable** and optionally the **expected** proportions as a comma-separated list. Leave them blank to test against equal proportions.

One variable against a theoretical split is this test. Two variables against each other is [a crosstab](howto:crosstabs-basics).

Syntax:

`run builtin-categorical.gof {"variable": "region", "expected": ""}`

--- id: categorical-oneprop
Tests one observed proportion against a hypothesised value.

**Analyze ▸ Categorical ▸ One-proportion test…**, then set:

- **variable** — the categorical variable;
- **category** — which of its two categories is being tested (omit to test the second);
- **p0** — the proportion to test against;
- **weight** — an optional frequency weight.

Worth knowing: **supplying a weight changes the test**. Without one you get the exact binomial; with one, N becomes the sum of weights and a normal approximation is used instead. That is the honest behaviour — an "exact" test on fractional counts would not be exact — but it means the weighted and unweighted runs are not quite the same procedure.

Syntax:

`run builtin-categorical.oneProp {"variable": "passed", "category": "yes", "p0": 0.5}`

--- id: categorical-twoprop
Compares the proportion with some outcome between two groups.

**Analyze ▸ Categorical ▸ Two-proportion test…**, then pick the binary **outcome** and the **groups** variable.

For the same comparison expressed as risk and odds — relative risk, odds ratio, number needed to treat — see [epidemiological measures](howto:epi-measures), which is usually what a clinical write-up wants.

Syntax:

`run builtin-categorical.twoProp {"outcome": "passed", "groups": "cohort"}`

--- id: categorical-mcnemar
The paired counterpart of the two-proportion test: the **same** cases measured twice on a binary outcome.

**Analyze ▸ Categorical ▸ McNemar's test…**, then pick the two variables **v1** and **v2**.

It looks only at the cases that **changed** — the discordant pairs. Cases that gave the same answer twice carry no information about change, however many of them there are, which is why a large sample can still give a weak result here.

Syntax:

`run builtin-categorical.mcnemar {"v1": "before", "v2": "after"}`

--- id: categorical-loglinear
For contingency tables with **more than two** variables, where "which associations are present?" stops being a single question.

**Analyze ▸ Categorical ▸ Log-linear model…**, then pick the **vars** and the **model** (e.g. `homogeneous`).

It models the cell counts, so the terms you include are the associations you are claiming exist. Comparing models is how you decide which ones the data support.

Syntax:

`run builtin-categorical.loglinear {"vars": ["a", "b"], "model": "homogeneous"}`
