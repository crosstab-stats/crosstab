# builtin-crosstabs — how-to topics (#192).
#
# Sections are delimited by `--- id: <topic-id>`; every id must appear in this
# plugin's `howtoIndex`. Anything before the first delimiter is ignored.

--- id: crosstabs-basics
A crosstab counts how two categorical variables fall together — region by gender, agreement by age group. It is the workhorse of survey analysis and usually the first thing worth doing once you have two categories.

1. Choose **Analyze ▸ Descriptive Statistics ▸ Crosstabs…**
2. Pick the **row** variable, then the **column** variable.
3. Add [percentages](howto:crosstabs-percentages) if you want proportions rather than counts.

You get the two-way table plus a **chi-square test** of whether the two variables are independent.

Both variables need to be categorical. If one you want is continuous, [recode it into groups](howto:recode-a-variable) first.

Syntax:

`run builtin-crosstabs.run {"rowvar": "region", "colvar": "gender", "percent": "column"}`

--- id: crosstabs-percentages
Counts alone rarely answer the question. The percentage option decides what each cell is a percentage **of**, and picking the wrong base is the commonest way a crosstab gets misread.

- **Row** — each row sums to 100%. Use when the row variable is the one you think of as explanatory: *of people in this region, what fraction are women?*
- **Column** — each column sums to 100%. The mirror image: *of women, what fraction live in this region?*
- **Total** — every cell is a share of the whole table.
- **None** — counts only.

Say which base you used when you report the number. "60% of region 1" and "60% of women" are different claims, and the table alone does not tell a reader which one you meant.

Syntax: `"percent": "none" | "row" | "column" | "total"`

--- id: crosstabs-measures
Chi-square says whether the two variables look independent. It does **not** say how strongly they are related, and with a large sample almost anything reaches significance.

**Association measures** answer the strength question. Tick the ones you want in the dialog — which are appropriate depends on whether your variables are nominal or ordinal, and the dialog lists what is available.

**`pmethod`** chooses how the p-value is computed:

- `asymptotic` (the default) — the usual large-sample approximation.
- `montecarlo` — simulated, for a **sparse** table. When many cells have small expected counts the asymptotic p-value is unreliable, and this is the honest alternative.

A table with lots of near-empty cells is usually telling you the categories are too fine. [Recoding](howto:recode-a-variable) into fewer groups often beats reaching for a different p-value.
