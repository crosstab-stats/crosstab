# builtin-csv-codec - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: codec-csv
**File ▸ Import data…** (or **Export data…**), then choose **CSV (.csv / .tsv / .txt)**.

Reads and writes RFC-4180 delimited text — the lowest common denominator that every tool can open.

What CSV does not carry is everything [the Variables tab](howto:variable-types) holds: types, value labels, declared missing codes. A column of 1s and 2s arrives as numbers with no memory that they meant *agree* and *disagree*. If you are moving data between statistics packages rather than into a spreadsheet, [SPSS/Stata/SAS](howto:codec-readstat) or [Parquet](howto:codec-parquet) keeps more of it.
