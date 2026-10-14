# builtin-mixture — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: mixture-lca
Finds unobserved subgroups from **categorical** indicators — people who answer a set of items in characteristically different ways.

**Analyze ▸ Analyze ▸ Latent class analysis (categorical items)…**, then pick the items, how many **classes** to consider, a **seed**, and whether to **save** each case's class to a new dataset.

You get a comparison table for every k from 1 up — AIC, BIC, entropy, smallest class — plus the detail for the largest k.

Read that table rather than taking the k you asked for. Lower BIC is better, entropy says how cleanly cases separate, and a **tiny smallest class** usually means the solution has split noise rather than found a group. Set the seed so the solution is reproducible; these fits depend on their starting values.

For continuous indicators use [latent profile analysis](howto:mixture-lpa).

Syntax:

`run builtin-mixture.lca {"items": ["q1", "q2", "q3", "q4"], "classes": 3, "seed": 12345}`

--- id: mixture-lpa
The continuous-indicator counterpart of [latent class analysis](howto:mixture-lca): subgroups with characteristically different *profiles* across a set of measures.

**Analyze ▸ Analyze ▸ Latent profile analysis (continuous items)…**, then pick the items, the number of **classes**, a **seed**, and whether to **save** class membership.

Compared with [k-means](howto:cluster-kmeans) this is model-based: it gives fit statistics you can compare across k, and probabilities of membership rather than a hard assignment. That is why it can say something about *how many* groups there are, where k-means can only do as it is told.

Syntax:

`run builtin-mixture.lpa {"items": ["anx", "dep", "som"], "classes": 3, "seed": 12345, "save": "yes"}`

--- id: mixture-gmm
Classes of **trajectory**: subgroups that change over time in different ways — improvers, decliners, the stable.

**Analyze ▸ Analyze ▸ Growth mixture model (classes of trajectory)…**

Where [a latent growth curve](howto:sem-growth) fits one average trajectory with variation around it, this asks whether there are genuinely distinct *kinds* of trajectory.

Treat the number of classes with care. These models will almost always find more classes if asked, and a class can emerge from non-normality rather than from a real subgroup. The fit table and the smallest class size are the evidence; the substantive meaning of each class is the argument you still have to make.
