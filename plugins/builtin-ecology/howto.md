# builtin-ecology — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: ecology-diversity
Per-site diversity plus an ordination of the sites, from a species-by-site table.

**Analyze ▸ Multivariate ▸ Diversity & ordination…**, then pick one **count column per species** — each row is a site.

You get richness, Shannon, Simpson and evenness per site, plus an **NMDS** ordination plot.

The indices answer different questions: richness counts species and ignores how common each is; Shannon and Simpson weight by abundance, Simpson more heavily toward the dominant ones. Two sites can swap rank depending on which you quote, so say which you used.

Syntax:

`run builtin-ecology.run {"species": ["sp1", "sp2", "sp3"]}`
