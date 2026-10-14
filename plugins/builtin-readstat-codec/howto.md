# builtin-readstat-codec - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: codec-readstat
**File ▸ Import data…** (or **Export data…**), then choose **SPSS / Stata / SAS** — `.sav`, `.zsav`, `.dta`, `.por`, `.xpt`, `.sas7bdat`.

This is the format pair to use when the metadata matters. Variable labels, value labels and declared missing codes all travel, so a survey arrives already describing itself rather than as a grid of bare codes — and that is most of what [the Variables tab](howto:variable-types) would otherwise have to be filled in by hand.

Large files are streamed, and import can optionally read **only the variables you select**, which is the difference between workable and not on a file with 900 columns. Export writes `.sav` or `.dta`.
