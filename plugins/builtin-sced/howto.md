# builtin-sced - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: sced-indices
Effect sizes for single-case designs, computed from how little the intervention phase overlaps the baseline.

**Analyze ▸ Single-Case Design ▸ Non-overlap indices…**, then set:

- **Outcome** — the measure;
- **Phase** — baseline/intervention;
- **Case** — optional, one panel per case;
- **Session** — optional, the ordering within a case;
- **direction** — `increase` (default: improvement means higher scores) or `decrease`.

You get the multiple-baseline chart plus NAP, PND, Tau-U and IRD.

**The first phase to appear in session order is treated as the baseline (A)**, and the output says which is which — check that line, because data sorted the wrong way silently inverts the comparison.

Set `direction` to match what improvement means for your measure. For disruptive behaviours, improvement is a *decrease*, and leaving the default would report a successful intervention as a failure.

These indices are computed in JavaScript with no R required, and are validated against the R package `scan`.

Syntax:

`run builtin-sced.run {"y": "disruptions", "phase": "condition", "caseVar": "child", "session": "session", "direction": "decrease"}`

--- id: sced-graph
The chart on its own — one panel per case, with the phase change marked.

**Analyze ▸ Single-Case Design ▸ Multiple-baseline graph…**, then set the outcome, phase, case and session variables.

Visual analysis is the primary method in this tradition, not a decoration on the statistics: level, trend and immediacy of change are read from the chart, and [the non-overlap indices](howto:sced-indices) summarise what the chart shows rather than replacing it.

Syntax:

`run builtin-sced.graph {"y": "disruptions", "phase": "condition", "caseVar": "child", "session": "session"}`

--- id: sced-graph-series
Several measures scored in the same sessions, drawn in one panel — "saying thank you" and "eye contact" tracked together.

**Analyze ▸ Single-Case Design ▸ Multiple-baseline graph, several measures…**

It needs **long format**: one row per measure per session, with a **Measure** column. That shape is what lets each panel carry its own measures with nothing to configure — and it is the usual stumbling block, since data is often recorded one column per measure. [Aggregate or reshape](howto:aggregate-collapse) first if yours is wide.

Each measure gets its own marker — filled circle, open circle, filled triangle — so the figure stays readable in print and in black and white.

Syntax:

`run builtin-sced.graphSeries {"y": "value", "measure": "measure", "phase": "condition", "caseVar": "behaviour", "session": "session"}`
