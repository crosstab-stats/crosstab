# builtin-charts - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: charts-engine
Draws the **data-driven** figures in CrossTab — the ones built from numbers a plugin hands over, rather than from a picture. It has no menu of its own.

Fourteen plugins depend on it: [Plots](howto:plots-choosing), Regression, Logistic, Assumptions, Survival, Meta-analysis, SCED, Factor, Time series, Cointegration, Inequality, Text analytics, CAQDAS word clouds and Decisions.

**What happens if you switch it off**, which is the reason this page exists:

- charts already in your Output still **show their saved figure** — nothing you have produced disappears;
- those figures lose their **⚙ Chart options** panel, so they stop being re-editable;
- a **new** analysis reports which chart type is missing instead of drawing one.

**Figures drawn in R are not affected.** A network diagram, a choropleth or a biplot is composed by CrossTab itself rather than by this plugin, so it keeps its options panel — title, caption, legend wording, layout — whether the chart engine is on or off.

So a missing chart with an otherwise working analysis is this plugin being disabled, not the analysis failing.
