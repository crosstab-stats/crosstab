# builtin-syntax-export - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: export-rsyntax
**File ▸ Export data… ▸ R syntax (.R)…**

Exports your **data-preparation steps** — [the History panel](howto:history-and-undo) — as a runnable R script.

The useful distinction: [R data export](howto:export-rdata) sends the *result*, this sends the *recipe*. A reviewer can read exactly how a variable was built, re-run it on new data, or adapt it, which is the thing a finished dataset cannot show.

It covers the data steps rather than the analyses; [the Syntax view](howto:syntax-basics) is the lossless record of both.
