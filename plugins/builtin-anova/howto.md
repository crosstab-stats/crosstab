# builtin-anova — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: anova-factorial
Two or more grouping factors at once, with their interaction.

**Analyze ▸ Comparison ▸ Factorial ANOVA…**, then pick the outcome **dv** and the **factors**.

The interaction is usually the reason to run it: it asks whether the effect of one factor depends on the level of the other. When it is significant, the main effects become hard to describe on their own — "treatment helped" is not true if it helped one group and harmed another, and the interaction is what tells you so.

**Plots.** The dialog's last step is a tick-list, as SPSS's Plots sub-dialog is. *Cell means with error bars* draws the means you are testing, with a 95% confidence interval on each — the interval is around the MEAN, which is what an ANOVA is about; the SD of individuals is a different question, and it is one click away on the chart if you want it. *Interaction (profile) plot* is the same means drawn as lines, where non-parallel lines are the interaction term made visible. *Pairwise differences* gives each pair of groups as a difference with its Tukey 95% interval against a zero line — the honest answer to "how much more?", because eyeballing whether two means' error bars overlap is not the same test, and two 95% intervals can overlap while the difference between them is significant.

Every plot is a live chart, not a picture: the error-bar type, the data-point overlay, the bar-or-line mark, the palette and the titles are all controls on the chart itself, and the figure is saved with the project.

Syntax:

`run builtin-anova.factorial {"dv": "score", "facs": ["treatment", "sex"], "plots": ["means", "tukey"]}`

--- id: anova-repeated
The same subjects measured under several conditions or at several times.

**Analyze ▸ Comparison ▸ Repeated-measures ANOVA…**, then pick the variables — **one column per condition**, in wide format. Each row is a subject.

Data in long format (one row per measurement) has to be reshaped first; this is the shape that catches people out, not the statistics.

For a design that also has a between-subjects factor, [mixed ANOVA](howto:ancova-mixed) handles both at once.

**Plots.** *Condition means with error bars* draws the means across conditions. Read its bars with care: they are computed across subjects, so they describe each condition's own mean, and in a within-subjects design the comparison is usually far sharper than those bars suggest — the output says so beside the chart. *One line per subject* is the before-after view, which shows whether everyone moved the same way or an average is hiding two opposite groups. *Pairwise differences* is the one to read for size: each pair as the mean of **each subject's own change**, with a Bonferroni-adjusted 95% interval against a zero line.

Syntax:

`run builtin-anova.repeated {"vars": ["time1", "time2", "time3"], "plots": ["means", "diff"]}`
