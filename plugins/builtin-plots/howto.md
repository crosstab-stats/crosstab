# builtin-plots — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: plots-choosing
The variable's [level of measurement](howto:variable-types) picks the picture, and getting that wrong is the commonest charting mistake.

**One categorical variable** — [bar chart](howto:plots-bar) or [pie chart](howto:plots-pie). One slice or bar per category.

**One interval-ratio variable** — [histogram](howto:plots-histogram) or [line chart](howto:plots-line). The shape of a distribution, not a count per label.

**Two interval-ratio variables** — [scatter](howto:plots-scatter).

**A measure split by a group** — [boxplot](howto:plots-boxplot), [bar chart with error bars](howto:plots-error-bars), [violin plot](howto:plots-violin) or [dot plot](howto:plots-dotplot), depending on how much of the raw data you want visible.

**Something changing over time** — [trends over time](howto:plots-trends).

**The same subjects measured twice** — [before-after plot](howto:plots-before-after).

One name causes more confusion than the rest: **"Bar chart"** draws one bar per category of ONE variable. **"Bar chart with error bars"** is a different thing entirely — group means with uncertainty. They are not variations of each other.

Every chart renders as a live, re-editable model, so titles, axes and colours can be changed after the fact without re-running anything.

--- id: plots-histogram
A histogram shows the **shape** of one interval-ratio variable: where the values pile up, how spread out they are, whether they lean one way.

**Graphs ▸ Histogram…**, then pick the variable.

**Bins** is the number of intervals. Leave it at 0 (or omit it) and a sensible number is chosen automatically using Sturges' rule. Set it yourself when you have a reason — bin width changes what the picture appears to say, and a distribution can be made to look smooth or spiky by that choice alone. If a feature only appears at one bin count, it is a feature of the bins.

A histogram is for a **continuous** variable. For counts per category use a [bar chart](howto:plots-bar).

Syntax:

`run builtin-plots.histogram {"v": "age", "bins": 10}`

--- id: plots-bar
One bar per category of ONE variable — how many cases fall in each.

**Graphs ▸ Bar chart…**, then pick the variable.

**`stat`** chooses what the bar height means: `count` (the default) or `percent`.

This is **not** the chart for group means. That is [bar chart with error bars](howto:plots-error-bars), which is a different procedure despite the similar name, and the pair is the most frequently confused thing in this plugin.

Syntax:

`run builtin-plots.bar {"v": "region", "stat": "count"}`

--- id: plots-line
The distribution of ONE variable drawn as a line rather than as bars — useful when the variable has many values and a histogram would be a picket fence.

**Graphs ▸ Line chart…**, then pick the variable. **`stat`** is `count` (the default) or `percent`.

For a quantity changing over time across groups, [trends over time](howto:plots-trends) is the chart you actually want: this one describes a distribution, not a time series.

Syntax:

`run builtin-plots.line {"v": "tvhours", "stat": "percent"}`

--- id: plots-scatter
Two interval-ratio variables, one point per case. The first thing to draw before [correlating](howto:correlation-bivariate) or regressing anything.

**Graphs ▸ Scatter…**, then pick **x** and **y**.

What it shows that a coefficient cannot: curvature, clusters, outliers, and whether a relationship holds across the whole range or only part of it. A correlation near zero with an obvious curve in the scatter is not "no relationship" — it is the wrong summary.

Syntax:

`run builtin-plots.scatter {"x": "age", "y": "income"}`

--- id: plots-trends
A quantity tracked across time, optionally split by group — the survey-analysis workhorse for "has this changed?"

**Graphs ▸ Trends over time…**, then set:

- **x** — the time variable (a year, a wave).
- **g** — the grouping variable, one line per group.
- **y** — the measure, when you are summarising one.
- **summary** — `percent` (the default), `count`, or `mean` (which needs `y`).
- **display** — `lines` (the default), `stacked`, or `stacked100`.

`stacked100` is the right choice when composition is the question ("what share of each year"), and the wrong one when level matters, because every year sums to 100% whatever happened to the totals.

Syntax:

`run builtin-plots.trends {"x": "year", "g": "bracket", "y": "income", "summary": "percent", "display": "lines"}`

--- id: plots-boxplot
Median, quartiles and outliers for a measure, usually split by a group — a compact way to compare several distributions at once.

**Graphs ▸ Boxplot…**, then pick **y** (the measure) and optionally **g** (the group).

A boxplot hides the sample size and the shape within each box: two groups with identical boxes can have very different data. With a small N, [a dot plot](howto:plots-dotplot) showing every point is more honest, and [a violin](howto:plots-violin) shows the shape a box flattens away.

Syntax:

`run builtin-plots.boxplot {"y": "income", "g": "region"}`

--- id: plots-pie
Shares of a whole, one slice per category of a single categorical variable.

**Graphs ▸ Pie chart…**, then pick the variable.

Pies are read by angle, which people judge poorly — a [bar chart](howto:plots-bar) of the same data is easier to compare across categories, and far easier once there are more than about five slices. Use a pie when the point genuinely is "parts of one whole" and the categories are few.

Syntax:

`run builtin-plots.pie {"v": "region"}`

--- id: plots-error-bars
Group **means** with an uncertainty bar on each — a different procedure from the plain [bar chart](howto:plots-bar), despite the name.

**Graphs ▸ Bar chart with error bars…**, then pick **y** (the measure) and **g** (the group).

Two things worth saying when you report one: what the bars represent, and how many cases are behind each bar. A bar chart of means with a small N hides exactly what matters, which is why [a dot plot](howto:plots-dotplot) or [violin](howto:plots-violin) is often the better figure for experimental data.

Syntax:

`run builtin-plots.errorBars {"y": "income", "g": "region"}`

--- id: plots-violin
The full shape of a distribution per group — what a [boxplot](howto:plots-boxplot) summarises away.

**Graphs ▸ Violin plot…**, then pick **y** and **g**.

**`rep` makes it a SuperPlot.** Give it a replicate column — the experiment, the batch, the day — and points are coloured by replicate with each replicate's mean marked. That is the figure that distinguishes "we measured 300 cells" from "we ran the experiment three times", which a plot of pooled points cannot show and which decides what the statistics are allowed to say.

Syntax:

`run builtin-plots.violin {"y": "score", "g": "dose", "rep": "experiment"}`

--- id: plots-dotplot
Every observation drawn as a point, one column per group. The most honest figure for a small sample: nothing is summarised away and the reader can count the N.

**Graphs ▸ Dot plot (column scatter)…**, then pick **y** and **g**.

Like the [violin](howto:plots-violin), supplying **`rep`** turns it into a SuperPlot — points coloured by replicate with each replicate mean marked.

Syntax:

`run builtin-plots.dotplot {"y": "score", "g": "dose"}`

--- id: plots-before-after
The same subjects measured twice, each one drawn as its own line from the first measure to the second.

**Graphs ▸ Before-after plot…**, then give the two (or more) variables and the **id variable** that says which rows belong to the same subject.

This is the picture for paired data, and it shows what two bars of group means cannot: whether everyone moved a little or a few moved a lot, and whether anyone moved the other way. Those are different findings with the same means.

Syntax:

`run builtin-plots.beforeAfter {"vars": ["pre", "post"], "idVar": "subject"}`
