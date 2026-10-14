# builtin-charts - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: charts-engine
Draws **every** figure in CrossTab. It has no menu of its own: other plugins compute the numbers and hand them here to be drawn.

Nine plugins depend on it — [Plots](howto:plots-choosing), Survival, Meta-analysis, SCED, Factor, Time series, Text analytics, CAQDAS word clouds, and Decisions.

**What happens if you switch it off**, which is the reason this page exists:

- charts already in your Output still **show their saved figure** — nothing you have produced disappears;
- the **⚙ Chart options** panel goes, so existing figures stop being re-editable;
- a **new** analysis reports which chart type is missing instead of drawing one.

So a missing chart with an otherwise working analysis is this plugin being disabled, not the analysis failing.
