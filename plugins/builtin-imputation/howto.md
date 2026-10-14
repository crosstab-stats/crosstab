# builtin-imputation — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: imputation-mi
The default answer to missing data — drop any case with a gap — throws away everything else those cases knew, and biases the result unless the gaps are completely random.

**Analyze ▸ Regression ▸ Multiple imputation regression…**, then pick the outcome and predictors, set **m** (the number of imputations, default 5) and the **model** (`linear` or `logistic`).

Each imputation is a complete dataset with the gaps filled in differently; the model is fitted in each and the results pooled by Rubin's rules, so the extra uncertainty from not knowing the missing values ends up in the standard errors rather than being quietly discarded.

You also get **FMI** (fraction of missing information) and a **missingness table**. Read the table first: it says how much is missing and where, which is what decides whether this was worth doing.

Syntax:

`run builtin-imputation.run {"y": "income", "ivs": ["educ", "age"], "m": 5, "model": "linear"}`
