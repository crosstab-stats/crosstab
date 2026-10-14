# builtin-meta — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: meta-analysis
Combine effect sizes from several studies — one row per study — into a pooled estimate.

**Analyze ▸ Regression ▸ Meta-analysis…**, then set:

- **yi** — each study's effect size;
- **prec** — its precision, with **precType** saying whether that column is a standard error (`se`, the default) or a variance (`var`);
- **model** — `REML` random effects (the default) or `FE` fixed/common effect;
- **mods** — optional moderators, which turns it into a meta-regression;
- **label** — an optional study name for the forest plot.

You get the pooled effect, heterogeneity (**Q**, **I²**, **τ²**) and a forest plot.

Check heterogeneity before quoting the pooled number. A large I² says the studies are not estimating one common effect, and an average of genuinely different things is a number with no referent.

Syntax:

`run builtin-meta.metaAnalysis {"yi": "effect", "prec": "se", "precType": "se", "model": "REML"}`
