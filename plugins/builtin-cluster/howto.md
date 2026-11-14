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

--- id: cluster-hierarchical
Builds a **nesting** rather than a partition: every case starts alone, the two closest join, then the two closest of what remains, until one cluster holds everything. You decide where to cut, with the tree in front of you.

**Analyze ▸ Multivariate ▸ Hierarchical cluster analysis…**, then pick the numeric variables and:

- **clusters to cut at** — where to cut the tree. The cut line is drawn on the dendrogram and you can move it there afterwards without re-running;
- **linkage** — how far apart two *clusters* are once they hold more than one case;
- **distance** — how far apart two *cases* are;
- **standardize** — `z` (default) or `raw`, for the same reason as k-means.

**Linkage changes the tree, so it is reported.** Ward joins the pair that adds least within-cluster variance and tends to give compact, similar-sized clusters; complete uses the furthest pair, which is compact but sensitive to one odd case; average uses the mean distance; single uses the nearest pair and can chain long straggly clusters together through a line of intermediates. None is the "right" one — they answer slightly different questions about what "close" means for a group.

**Reading the dendrogram.** The height of a join is the distance at which the two things below it merged. Cut where the branches below are short and the join above is long: a tall join means the two groups it merged were not alike, so keeping them apart is telling you something.

Use this rather than [k-means](howto:cluster-kmeans) when you do not know how many groups there are, when the nesting itself is of interest (which communities resemble which, which items hang together), or when you want to see whether a clean cut exists at all. Use k-means when you have many cases — a dendrogram of ten thousand leaves is not a figure anyone can read — or when you already know k.

Syntax:

`run builtin-cluster.hierarchical {"vars": ["x", "y"], "k": 3, "linkage": "ward.D2", "plots": ["tree"]}`
