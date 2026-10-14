# builtin-sna — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: sna-network
Analyses a set of ties between actors, given as an **edge list** — one row per tie.

**Analyze ▸ Multivariate ▸ Network analysis (edge list)…**, then pick the **from** and **to** columns and whether edges are **directed** (`undirected` by default).

You get density, components, path length, clustering, the most central actors, and a plot.

Getting `directed` right matters more than it looks: "A nominated B" is directed and "A and B sat together" is not, and centrality means different things in each. An undirected reading of directed data quietly turns every nomination into a mutual tie.

Syntax:

`run builtin-sna.run {"from": "source", "to": "target", "directed": "undirected"}`
