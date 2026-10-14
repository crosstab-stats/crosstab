# builtin-decisions - how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: decisions-tools
A **workspace tab** (Decisions) rather than a menu item. Inside it, pick a tool:

- **Cost-effectiveness (ICER)** — incremental cost per unit of effect;
- **Decision matrix** — options scored against weighted criteria;
- **Cost-benefit (NPV)** — discounted net present value;
- **Expected value** — outcomes weighted by probability;
- **Decision tree** — sequential choices and chances.

Results push to the Output tab, so they export with everything else.

These take the numbers you give them and do the arithmetic correctly. The assumptions — the discount rate, the probabilities, the valuation of an outcome — are yours, and they, not the arithmetic, are what a reader will want to argue with. The sensitivity and tornado charts are there to show which of them the answer actually depends on.
