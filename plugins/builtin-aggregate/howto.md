# builtin-aggregate — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: aggregate-collapse
Turns case-level data into group-level data: one output row per group.

**Transform ▸ Aggregate / collapse…**, then pick:

- **groupby** — the variable(s) defining the groups;
- **measures** — the numeric variable(s) to summarise;
- **func** — `mean` (default), `sum`, `median`, `min`, `max`, `sd` or `count`.

The result arrives as a **new dataset**, so the original is untouched and both stay open.

An N column comes with it, and it is worth looking at: a group mean computed from three cases and one from three hundred appear identically in a table of means, and only the N distinguishes them.

Syntax:

`run builtin-aggregate.run {"groupby": ["year"], "measures": ["income"], "func": "mean"}`
