# builtin-anova — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: anova-factorial
Two or more grouping factors at once, with their interaction.

**Analyze ▸ Comparison ▸ Factorial ANOVA…**, then pick the outcome **dv** and the **factors**.

The interaction is usually the reason to run it: it asks whether the effect of one factor depends on the level of the other. When it is significant, the main effects become hard to describe on their own — "treatment helped" is not true if it helped one group and harmed another, and the interaction is what tells you so.

Syntax:

`run builtin-anova.factorial {"dv": "score", "facs": ["treatment", "sex"]}`

--- id: anova-repeated
The same subjects measured under several conditions or at several times.

**Analyze ▸ Comparison ▸ Repeated-measures ANOVA…**, then pick the variables — **one column per condition**, in wide format. Each row is a subject.

Data in long format (one row per measurement) has to be reshaped first; this is the shape that catches people out, not the statistics.

For a design that also has a between-subjects factor, [mixed ANOVA](howto:ancova-mixed) handles both at once.

Syntax:

`run builtin-anova.repeated {"vars": ["time1", "time2", "time3"]}`
