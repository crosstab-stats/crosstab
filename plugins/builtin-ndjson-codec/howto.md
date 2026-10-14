# builtin-ndjson-codec - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: codec-ndjson
**File ▸ Import data…** (or **Export data…**), then choose **JSON Lines (.ndjson / .jsonl)**.

One JSON object per line, streamed. It is the shape most APIs and log pipelines emit, and because each line stands alone the file can be read a row at a time rather than loaded whole — which is what makes very large files practical.

Nested objects have to become columns somehow; flat records import most predictably.
