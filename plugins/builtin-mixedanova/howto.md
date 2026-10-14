# builtin-mixedanova — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: ancova-adjusted
ANOVA with a covariate held constant — most often comparing groups while adjusting for a baseline measure.

**Analyze ▸ Compare Means ▸ ANCOVA…**, then pick:

- **y** — the outcome;
- **factors** — one or more grouping factors;
- **covs** — the covariates to adjust for.

You get Type III effects, partial η², and **adjusted means** — the group means as they would be if every group had the same covariate average. Report those rather than the raw means, since they are what the test compared.

Adjusting for a baseline usually sharpens a comparison considerably. Adjusting for something measured *after* the treatment can remove the very effect you are looking for.

Syntax:

`run builtin-mixedanova.ancova {"y": "score", "factors": ["group"], "covs": ["pretest"]}`

--- id: ancova-mixed
A within-subjects factor (time, condition) and optionally a between-subjects one (group) in the same model.

**Analyze ▸ Compare Means ▸ Repeated-measures / mixed ANOVA…**, then set:

- **within** — one column per condition or time point, wide format;
- **between** — the optional between-subjects factor.

You get the within-subjects ANOVA with a **sphericity correction**. Sphericity is the repeated-measures analogue of equal variances; when it fails, the uncorrected p-value is too small, and the corrected row is the one to read.

The within × between interaction is typically the question: did the groups change *differently* over time?

Syntax:

`run builtin-mixedanova.mixedAnova {"within": ["time1", "time2", "time3"], "between": "group"}`
