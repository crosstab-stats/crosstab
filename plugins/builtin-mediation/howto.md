# builtin-mediation — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: mediation-indirect
Does X affect Y **through** M? Mediation splits the total effect into a direct part and an indirect one that runs via the mediator.

**Analyze ▸ Regression ▸ Mediation (X → M → Y)…**, then set the roles: **x** (predictor), **m** (mediator), **y** (outcome), plus optional **covs** controls.

**`se`** picks the inference: `delta` (the default) or `bootstrap`. Bootstrap intervals are the usual recommendation for an indirect effect, because the product of two coefficients is not symmetric and a delta-method interval assumes it is.

The arrows are yours, not the data's. The same three variables fit equally well in several orders; mediation estimates the decomposition you specify, it does not test whether your causal story is the right one.

Syntax:

`run builtin-mediation.mediation {"x": "stress", "m": "coping", "y": "wellbeing", "se": "delta"}`

--- id: mediation-moderation
Does the effect of X **depend on** W? Moderation fits the X×W interaction and reports simple slopes — the effect of X at different values of the moderator.

**Analyze ▸ Regression ▸ Moderation (X × W)…**, then pick **y** (outcome), **x** (focal predictor) and **w** (moderator), plus optional **covs**.

Read the simple slopes, not just the interaction's p-value: a significant interaction says the slopes differ, and the slopes themselves say whether either of them is anything. A non-significant interaction is also not evidence that the effect is the same in both groups — interactions are low-powered, and this is the most common over-reading of them.

Syntax:

`run builtin-mediation.moderation {"y": "wellbeing", "x": "stress", "w": "support"}`
