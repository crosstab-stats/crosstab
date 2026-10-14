# builtin-inequality — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: inequality-indices
How unequally a quantity is distributed — income, wealth, land.

**Analyze ▸ Descriptive Statistics ▸ Inequality (Gini / Theil / Lorenz)…**, then pick a non-negative variable **x**.

You get Gini, Theil, Atkinson and the coefficient of variation, plus a **Lorenz curve**.

They are not interchangeable: Gini is most sensitive to the middle of the distribution, Theil is decomposable into within- and between-group parts, and Atkinson carries an explicit inequality-aversion parameter. Two distributions can swap rank depending on which index you quote, so name it.

The Lorenz curve is worth showing alongside: it makes visible *where* in the distribution the inequality sits, which a single number cannot.

Syntax:

`run builtin-inequality.inequality {"x": "income"}`

--- id: inequality-segregation
How unevenly two groups are spread across units — neighbourhoods, schools, firms.

**Analyze ▸ Descriptive Statistics ▸ Segregation indices…**, then pick the per-unit counts for **groupA** and **groupB**.

You get dissimilarity, isolation and interaction. Dissimilarity is the share of one group that would have to move for the two to be evenly spread; isolation depends on the group's overall size as well as its spread, so a small group can look less isolated than it feels.

These indices ignore *where* the units are — two cities with identical dissimilarity can be segregated in quite different geographies. [Spatial autocorrelation](howto:spatial-autocorrelation) addresses that part.

Syntax:

`run builtin-inequality.segregation {"groupA": "minority", "groupB": "majority"}`
