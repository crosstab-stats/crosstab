# builtin-survival — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: survival-km
Survival curves for time-to-event data, with the log-rank test comparing groups.

**Analyze ▸ Survival ▸ Kaplan–Meier & log-rank…**, then set:

- **time** — follow-up time until the event or until censoring;
- **status** — the event indicator, **1 = event, 0 = censored**;
- **group** — an optional grouping variable.

Censoring is the whole point of these methods: someone who left the study after 10 months without the event is not a 10-month survivor and not a missing case — they are known to have survived *at least* 10 months, and Kaplan–Meier uses exactly that.

Getting `status` backwards inverts the analysis silently, so check which value means "event" before reading the curve.

Syntax:

`run builtin-survival.kaplanMeier {"time": "months", "status": "died", "group": "treatment"}`

--- id: survival-cox
Regression for time-to-event data: the effect of covariates on the hazard, without assuming a shape for the baseline risk.

**Analyze ▸ Survival ▸ Cox proportional hazards…**, then set **time**, **status** (1 = event) and the **preds**.

Results are **hazard ratios**: 1.5 means the event happens at 1.5 times the rate, at any given moment, for a one-unit higher covariate.

"Proportional" is the assumption doing the work — that the ratio stays constant over follow-up. When it does not (a treatment that helps early and not later), a single hazard ratio averages two different stories into one number. The [Kaplan–Meier curves](howto:survival-km) are the usual first look at whether that is plausible.

Syntax:

`run builtin-survival.cox {"time": "months", "status": "died", "preds": ["age", "treatment"]}`
