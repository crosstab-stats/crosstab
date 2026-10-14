# builtin-cluster — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: cluster-kmeans
Splits cases into **k** groups so that cases within a group resemble each other.

**Analyze ▸ Multivariate ▸ k-means cluster analysis…**, then pick the numeric variables and:

- **k** — how many clusters (default 3);
- **standardize** — `z` (z-scores, the default) or `raw`.

Leave standardisation on unless you mean otherwise. On raw values a variable measured in thousands dominates one measured in units, so the clusters end up being about whichever variable happened to have the biggest numbers.

k-means always returns k clusters, whether or not the data has any. The cluster sizes and the variance explained are what tell you whether the split means anything; run it at two or three values of k and see whether the solution is stable.

Syntax:

`run builtin-cluster.kmeans {"vars": ["x", "y"], "k": 3, "standardize": "z"}`
