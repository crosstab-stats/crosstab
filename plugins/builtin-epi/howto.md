# builtin-epi — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: epi-measures
The clinical/epidemiological summary of a binary exposure against a binary outcome.

**Analyze ▸ Categorical ▸ Risk / odds ratios (2×2)…**, then pick the **exposure** (1 = exposed) and the **outcome** (1 = case).

You get the 2×2 table plus **relative risk**, **odds ratio**, **risk difference**, **NNT/NNH** and the attributable fraction, each with a 95% CI.

Which to quote depends on the design and on what the reader needs. Risk ratio and risk difference speak directly about probability; the odds ratio is what [logistic regression](howto:logistic-binary) produces and approximates the risk ratio only when the outcome is rare. NNT is the most concrete of the four and the easiest to act on.

Check which category counts as "exposed" and "case" before reading the direction — a 2×2 reported the wrong way round is a correct calculation of the opposite claim.

Syntax:

`run builtin-epi.run {"exposure": "treated", "outcome": "relapse"}`
