# builtin-manova — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: manova-multivariate
Compares groups on **several outcomes at once**, rather than running a separate ANOVA per outcome.

**Analyze ▸ Multivariate ▸ MANOVA…**, then pick two or more numeric outcomes and the grouping factor.

You get the four multivariate tests — Pillai, Wilks, Hotelling–Lawley, Roy — plus a per-outcome ANOVA. **Pillai's trace** is the usual default report, being the most robust of the four when assumptions wobble.

The reason to use it rather than several ANOVAs is the error rate: each separate test is another chance at a false positive, and MANOVA asks the single question "do these groups differ on this set of measures?" first. The per-outcome ANOVAs are then the follow-up, read in light of the multivariate result rather than instead of it.

Syntax:

`run builtin-manova.run {"dvs": ["score1", "score2"], "group": "treatment"}`
