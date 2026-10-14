# builtin-survey — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: survey-means
Population estimates from a complex sample, with standard errors that account for the design.

**Analyze ▸ Survey ▸ Weighted means…**, then pick the variables, the **weight** (required), and optionally **strata** and **cluster**/PSU.

The distinction that matters: [a frequency weight](howto:weight-cases) applied to an ordinary analysis gets the point estimate right and the standard errors **wrong**, because it treats a weighted case as if it were several independent observations. Declaring strata and clusters here is what makes the uncertainty honest.

If your dataset came with design variables, use them. A survey analysed as a simple random sample reports confidence intervals that are usually too narrow.

Syntax:

`run builtin-survey.means {"vars": ["age", "income"], "weight": "wt"}`

--- id: survey-crosstab
[A crosstab](howto:crosstabs-basics) with the sample design taken into account.

**Analyze ▸ Survey ▸ Weighted crosstab…**, then pick **rowvar** and **colvar**, the **weight**, and optionally **strata** and **cluster**.

The ordinary chi-square assumes independent observations, which a clustered sample does not have; this is the version that does not make that assumption.

Syntax:

`run builtin-survey.crosstab {"rowvar": "region", "colvar": "vote", "weight": "wt", "strata": "stratum", "cluster": "psu"}`

--- id: survey-regression
[Linear](howto:regression-linear) or [logistic](howto:logistic-binary) regression fitted to a complex sample.

**Analyze ▸ Survey ▸ Survey regression…**, then set the outcome **dv**, the **ivs**, the **family** (`linear` by default, or `logistic`), the **weight**, and optionally **strata** and **cluster**.

The coefficients estimate population relationships rather than sample ones, and the standard errors reflect the design rather than pretending the sample was simple.

Syntax:

`run builtin-survey.regression {"dv": "voted", "ivs": ["age", "income"], "family": "logistic", "weight": "wt"}`
