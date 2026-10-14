# builtin-bootstrap — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: bootstrap-mean
Estimates the uncertainty in a mean by resampling the data itself, rather than relying on a formula.

**Analyze ▸ Resampling ▸ Bootstrap the mean…**, then pick the variable and the number of **reps** (default 2000).

You get the estimate, a bootstrap standard error, and a 95% **percentile** confidence interval. The resample means are also emitted as a new dataset, so you can plot the bootstrap distribution yourself.

Worth using when the sampling distribution is doubtful — small N, visible skew, a statistic with no neat formula. It does not rescue a biased sample: resampling reproduces whatever the data already is, including how it was collected.

Syntax:

`run builtin-bootstrap.run {"x": "income", "reps": 2000}`

--- id: bootstrap-statistic
The same resampling as [bootstrapping the mean](howto:bootstrap-mean), for a statistic of your choice.

**Analyze ▸ Resampling ▸ Bootstrap a statistic…**, then pick the variable, the **reps**, and the **stat**: `mean`, `median`, `sd`, `var`, `IQR` or `trim`.

This is where the bootstrap earns its keep. A confidence interval for a median or an IQR has no convenient textbook formula, and resampling gives you one without inventing an assumption.

Syntax:

`run builtin-bootstrap.bootStatistic {"x": "income", "stat": "median", "reps": 2000}`

--- id: bootstrap-correlation
A resampled confidence interval for [a correlation](howto:correlation-bivariate).

**Analyze ▸ Resampling ▸ Bootstrap a correlation…**, then pick the two variables and the number of reps.

Useful because a correlation's sampling distribution is skewed except near zero — so the symmetric interval people often quote is wrong at exactly the end where the interesting results live.

Syntax:

`run builtin-bootstrap.bootCorr {"x": "x", "y": "y", "reps": 2000}`

--- id: bootstrap-permutation
Tests a group difference by shuffling the group labels thousands of times and seeing how often chance produces a difference as large as the real one.

**Analyze ▸ Resampling ▸ Permutation test (2 groups)…**, then pick the outcome **y**, the **group** variable, the **stat** (`mean` or `median`) and the number of **reps** (default 5000).

It assumes almost nothing about the distribution — only that under the null the labels are exchangeable — which makes it a clean alternative to [the t-test](howto:compare-independent) when its assumptions are shaky.

Syntax:

`run builtin-bootstrap.permutation {"y": "score", "group": "condition", "stat": "mean", "reps": 5000}`

--- id: bootstrap-power
How often a study of a given size would detect an effect of a given size — estimated by simulating it many times.

**Analyze ▸ Resampling ▸ Power by simulation (t-test)…**

Power is a question about a design, so it is worth asking **before** collecting data, when the answer can still change what you do. Afterwards the useful question is the confidence interval, not the power you turned out to have — "observed power" computed from the result you got adds nothing the p-value did not already say.
