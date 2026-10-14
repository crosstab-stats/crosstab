# builtin-trend — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: trend-mann-kendall
A rank-based test for a **monotonic trend** — is the series going up or down over time, without assuming the trend is a straight line or that the data is normal.

**Analyze ▸ Time Series ▸ Mann-Kendall trend…**, then pick the series in time order.

It is the standard tool in environmental monitoring for exactly those reasons: real measurement series are rarely normal, often have outliers, and the question is usually direction rather than rate.

It tests for a consistent direction, so a series that rises then falls can come back as no trend while obviously having changed. Plot it as well — [trends over time](howto:plots-trends) — rather than reading the test alone.
