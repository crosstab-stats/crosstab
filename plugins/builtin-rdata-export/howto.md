# builtin-rdata-export - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: export-rdata
**File ▸ Export data…**, then choose **R data frame (.rds)** or **R workspace (.RData)**.

Writes a real R object rather than a text file: typed columns, and value-labelled variables as **factors**. It reopens with `readRDS()` or `load()` with nothing to re-specify.

The point is that the metadata survives the trip — export the same data as [CSV](howto:codec-csv) and your colleague's first job in R is re-declaring every factor level you had already defined.
