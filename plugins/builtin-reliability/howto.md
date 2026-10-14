# builtin-reliability — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: reliability-alpha
How consistently a set of items measures the same thing — Cronbach's alpha and its companions.

**Analyze ▸ Scale ▸ Reliability analysis…**, then pick two or more scale items.

Two things to watch. **Alpha rises with the number of items**, so a long scale can look reliable while measuring several things at once; it is a statement about consistency, not about validity. And **reverse-worded items must be recoded first** — forget that and alpha collapses for a reason that has nothing to do with the scale's quality. [Recode](howto:recode-a-variable) them before running this.

The item-total statistics are where to look when alpha disappoints: they say which item is pulling against the rest.

Whether the items belong together as one dimension at all is [a factor analysis](howto:factor-analysis) question.
