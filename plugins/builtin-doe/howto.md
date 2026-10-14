# builtin-doe — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: doe-response-surface
For finding the settings that optimise a response — the temperature and time that maximise yield.

**Analyze ▸ Regression ▸ Response surface (second-order)…**, then pick the numeric **response** and two or more continuous **factors**.

You get the quadratic model, the **stationary point** (where the surface flattens) and a **canonical classification** saying whether that point is a maximum, a minimum or a saddle.

The classification is the part worth reading first. A saddle means there is no single best setting — the surface rises in one direction and falls in another — and the stationary point is then not an optimum at all, however precisely it is reported.

Syntax:

`run builtin-doe.run {"y": "yield", "factors": ["temp", "time"]}`
