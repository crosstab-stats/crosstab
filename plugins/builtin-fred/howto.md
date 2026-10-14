# builtin-fred - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: import-fred
**File ▸ Import data… ▸ FRED (economic data)…**, then enter a series id (for example `UNRATE`) and your free FRED API key. You get a date + value dataset.

The key is free from the St. Louis Fed and is yours — the request goes from this device to FRED and nowhere else.

What arrives is one series in time order, which is exactly the shape [the time-series methods](howto:ts-correlogram) want. For two or more series, import each and join them on the date column.
