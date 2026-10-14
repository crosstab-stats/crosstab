# builtin-factor — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: factor-analysis
Finds the smaller set of underlying dimensions behind a batch of correlated items.

**Analyze ▸ Multivariate ▸ Factor analysis…**, then pick the items and optionally:

- **nfactors** — how many to extract. 0 (the default) uses the eigenvalue > 1 rule.
- **method** — `principal` (default), `pa` or `ml`.
- **rotation** — `varimax` (default), `none`, `oblimin` or `promax`.

You get **KMO and Bartlett** (whether the items are correlated enough to factor at all — read these first, since a poor KMO means the rest is decoration), variance explained, a **scree plot** and the rotated loadings.

Rotation changes the loadings but not the fit: `varimax` keeps factors uncorrelated, `oblimin`/`promax` let them correlate. For psychological constructs the oblique ones are usually more honest, because real traits are rarely independent.

This is **exploratory** — it asks what structure is there. To test a structure you already believe in, use [confirmatory factor analysis](howto:sem-cfa).

Syntax:

`run builtin-factor.run {"vars": ["q1", "q2", "q3"], "nfactors": 0, "rotation": "varimax"}`
