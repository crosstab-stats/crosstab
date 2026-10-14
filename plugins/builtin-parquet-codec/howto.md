# builtin-parquet-codec - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: codec-parquet
**File ▸ Import data…** (or **Export data…**), then choose **Parquet (.parquet)**.

Columnar and compressed, read and written row-group by row-group so a file far larger than memory is still workable. Unlike [CSV](howto:codec-csv) it stores real types, so numbers come back as numbers and nothing is re-guessed on the way in.

The natural choice for a large dataset you will open repeatedly, and for moving data to and from the Python/R data-science world.
