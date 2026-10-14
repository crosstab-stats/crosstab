# builtin-agreement — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: agreement-raters
How much two or more raters agree, beyond what chance alone would produce.

**Analyze ▸ Scale ▸ Inter-rater agreement…**, then pick **one column per rater** (two or more).

Raw percentage agreement always flatters, because two raters who both use one category most of the time will agree often by accident. The chance-corrected coefficients are the ones to report.

Who agrees with whom is a different question from whether a scale hangs together — that is [reliability analysis](howto:reliability-alpha).

--- id: agreement-codings
The same question as [inter-rater agreement](howto:agreement-raters), computed directly from qualitative **codings** rather than from a tidy grid of rater columns.

**Analyze ▸ Scale ▸ Inter-coder agreement from codings…**

This is the one to use when two people have coded the same material in the coding workspace: it reads the codings as they were recorded, so nobody has to flatten them into a spreadsheet first — and flattening is exactly where coding data usually gets quietly mangled.
