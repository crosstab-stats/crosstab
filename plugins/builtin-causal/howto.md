# builtin-causal — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: causal-did
The effect of a treatment estimated by comparing the **change** in a treated group with the change in an untreated one over the same period.

**Analyze ▸ Regression ▸ Difference-in-differences…**, then set:

- **y** — the numeric outcome;
- **treat** — 1 for the treated group;
- **post** — 1 for the period after treatment;
- **covs** — optional covariates.

You get the estimated treatment effect with robust inference.

The estimate is only an effect under the **parallel-trends** assumption: that without treatment, the two groups' outcomes would have moved together. Nothing in this output tests that — it is an argument you make from pre-period data and from knowing the setting.

Syntax:

`run builtin-causal.did {"y": "outcome", "treat": "treated", "post": "after", "covs": ["age"]}`

--- id: causal-rdd
When treatment is decided by a **threshold** on some score — a passing mark, an eligibility cut-off — cases just either side of it are near-comparable, and the jump in outcome at the cut-off estimates the effect.

**Analyze ▸ Regression ▸ Regression discontinuity…**, then set:

- **y** — the outcome;
- **run** — the running variable the cut-off applies to;
- **cutoff** — the threshold;
- **bw** — the bandwidth; 0 chooses one automatically.

The estimate is **local**: it describes cases near the cut-off, not everyone. Bandwidth trades bias against precision, so it is worth seeing whether the answer survives a different one.

Syntax:

`run builtin-causal.rdd {"y": "outcome", "run": "score", "cutoff": 0, "bw": 0}`

--- id: causal-matching
Build a comparison group by pairing each treated case with untreated ones that look like it on the covariates.

**Analyze ▸ Regression ▸ Matching (propensity / nearest neighbour)…**, then set **y**, **treat**, the **covs** to match on, and the **distance** (`glm` for a propensity score).

You get the treatment effect **and a balance table**. Read the balance table first: matching is only worth anything if it actually equalised the covariates, and the table is where that is visible rather than assumed.

Matching can only balance what you measured. It is not a substitute for a design, and an unmeasured confounder survives it untouched.

Syntax:

`run builtin-causal.matching {"y": "outcome", "treat": "treated", "covs": ["age", "sex"], "distance": "glm"}`
