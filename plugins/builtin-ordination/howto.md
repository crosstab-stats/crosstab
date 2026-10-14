# builtin-ordination — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: ordination-correspondence
Turns a two-way table of categories into a **map**: rows and columns placed so that associated categories sit near each other.

**Analyze ▸ Multivariate ▸ Correspondence analysis…**, then pick the **rowvar** and **colvar**.

You get a row/column biplot and the inertia decomposition, which says how much of the association each dimension accounts for — check it before reading the picture, since a map of a dimension carrying 4% of the inertia is mostly noise arranged attractively.

Distances between a row point and a column point are not directly interpretable in the way row-to-row distances are; the honest reading is which rows sit near which columns, in broad terms.

Syntax:

`run builtin-ordination.correspondence {"rowvar": "brand", "colvar": "attribute"}`

--- id: ordination-mds
Places objects on a map so that the distances between them reflect how dissimilar they are.

**Analyze ▸ Multivariate ▸ Multidimensional scaling (MDS)…**, then pick the numeric **vars** that describe each object, and optionally a **label** column to name the points.

The axes have no inherent meaning — only the distances do. Rotating or flipping the map changes nothing, so "object A is to the left" is not a finding; "A and B are close, both far from C" is.

Syntax:

`run builtin-ordination.mds {"vars": ["price", "quality", "service"], "label": "brand"}`
