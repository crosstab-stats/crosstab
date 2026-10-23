# builtin-correlation — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: correlation-bivariate
**Analyze ▸ Correlation ▸ Bivariate…** builds the familiar correlation matrix: every variable against every other, with its coefficient, p-value and N.

Pick two or more numeric variables and a method:

- **Pearson** (the default) — the linear relationship between two interval-ratio variables.
- **Spearman** — the same idea on RANKS. Use it for ordinal data, or when a relationship is monotonic but not straight.
- **Kendall** — also rank-based; often preferred for small samples or many ties.

A coefficient describes a **straight-line** relationship (or, for the rank methods, a monotonic one). A strong curved relationship can show a correlation near zero, which is why it is worth drawing [a scatter plot](howto:plots-scatter) before trusting one.

Syntax:

`run builtin-correlation.run {"vars": ["age", "income"], "method": "pearson"}`

--- id: correlation-partial
**Analyze ▸ Correlation ▸ Partial / part correlation…** asks what is left of a relationship once something else is accounted for — the classic *"is this association just age?"*

1. Pick the variables to correlate.
2. Pick the **controls** to partial out.
3. Choose the **type**: **partial** (the default) removes the control from BOTH variables; **semipartial** (part) removes it from one of them only.

The two answer different questions and routinely give different numbers, so name which you ran.

Controlling for a variable is an arithmetic operation, not a causal argument. It tells you the association within levels of the control; whether that means what you hope it means is a question about your design, not about this output.

Syntax:

`run builtin-correlation.partial {"vars": ["age", "income"], "controls": ["education"], "type": "partial"}`
