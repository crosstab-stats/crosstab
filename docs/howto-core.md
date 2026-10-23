# CrossTab's own how-to topics (#192)
#
# Sections are delimited by a line reading `--- id: <topic-id>`, and every id here must
# appear in core/howto-core.js. This file is read exactly the way a plugin's sidecar is.
# Anything before the first delimiter — including this note — is ignored.

--- id: task-choose-a-test
What you can ask depends on how your variables are measured, so start there: open the **Variables** tab and look at the Measure column. Nominal is a set of unordered categories, ordinal is ranked, scale is a number you can average.

Then read down this list until one matches what you have.

- **One variable** — its distribution → [describe one variable](howto:task-describe-one-variable)
- **Two nominal or ordinal variables** — whether they are related → [two categorical variables](howto:task-two-categorical)
- **One scale variable and one grouping variable** — whether the groups differ → [compare a mean across groups](howto:task-compare-groups)
- **Two scale variables** — whether they move together → [two numeric variables](howto:task-two-numeric)
- **One outcome and several predictors** — the effect of each, holding the others still → [predict an outcome](howto:task-predict-an-outcome)

Two things worth knowing before you read a p-value.

**A test answers the question you actually asked, not the one you meant.** “Are these groups different?” and “does this variable predict that one, controlling for age?” are different questions with different answers from the same data, and no amount of significance makes one stand in for the other.

**Significance is not size.** With enough rows almost everything is significant; with few rows almost nothing is. Report the difference or the coefficient alongside the p-value, and the confidence interval if you have one — the [confidence interval for a mean](howto:descriptives-explore) is the usual place to start.

If what you want is a picture rather than a test, [choose the right chart](howto:plots-choosing) instead.

--- id: task-prepare-data
Four things, and they are worth doing before the first analysis rather than after the first confusing result.

1. **[Open the file](howto:import-data).** SPSS, Stata, SAS, CSV, Excel and Parquet all come in the same way. Labels and value labels come with it where the format carries them.
2. **[Check the types, labels and missing values](howto:variable-types)** in the **Variables** tab. This is the step people skip. A survey that codes *refused* as 98 and *don’t know* as 99 will happily average them into your mean until you declare them missing.
3. **[Recode what needs grouping](howto:recode-a-variable).** Age into bands, a seven-point scale into three. Name the new variable and its values while you are there — the recode dialog takes both, and a variable called `age_r` with no labels is a variable you will not recognise next week.
4. **[Restrict the rows if you need to](howto:select-cases).** A filter is visible and reversible, which is why it is a better idea than deleting rows.

Everything here is recorded as a step you can see, reorder and undo — see [go back and see what you did](howto:history-and-undo).

--- id: task-describe-one-variable
Which tool depends on the measure, and the quickest way to see it is that one of them counts and the other averages.

- **Categories** — [make a frequency table](howto:frequencies-basics). Counts and percents per category, which is the only sensible summary of a nominal variable.
- **Numbers** — [summarise the variable](howto:descriptives-basics) for the mean, standard deviation, minimum and maximum.
- **Either** — [add a mode, median or variance](howto:frequencies-statistics) to a frequency table. The mode is the one statistic defined for a nominal variable, and it is reported through the value label rather than the code.
- **A mean you intend to quote** — [get a confidence interval for it](howto:descriptives-explore), at a level you choose.

Look at it as well as summarising it: a [histogram](howto:plots-histogram) for a number, a [bar chart](howto:plots-bar) for categories. A mean of 3.4 on a bimodal variable is arithmetically correct and substantively a lie, and the histogram is where you notice.

If your data came with a sampling weight, [use it](howto:task-weighted-analysis).

--- id: task-two-categorical
A crosstab, and then a test.

1. **[Cross-tabulate the two variables](howto:crosstabs-basics).** Independent variable in the columns, dependent in the rows, is the usual convention.
2. **[Choose the percentages](howto:crosstabs-percentages).** This is the decision that makes the table readable or useless. Percent *within* the independent variable — column percents if the IV is in the columns — so each column sums to 100 and you are comparing like with like. Total percents almost never answer the question.
3. **Read chi-square.** It comes with the table and tells you whether the pattern is more than sampling noise. It does not tell you how strong the relationship is, or which cell drives it.
4. **[Add an association measure](howto:crosstabs-measures)** for the strength — Cramér’s V for nominal, gamma or Kendall’s tau for ordinal. For a 2×2, [risk and odds ratios](howto:epi-measures) are usually what a reader wants.

If chi-square’s expected counts are small, the same page offers a Monte Carlo p-value, which is the honest answer when the approximation does not hold.

--- id: task-compare-groups
Count the groups first, and whether they are the same people measured twice.

- **Two groups, different people** — [independent-samples t-test](howto:compare-independent)
- **Two measurements of the same people** — [paired-samples t-test](howto:compare-paired)
- **Three or more groups, different people** — [one-way ANOVA](howto:compare-oneway)
- **Three or more measurements of the same people** — [repeated-measures ANOVA](howto:anova-repeated)
- **One group against a known value** — [one-sample t-test](howto:compare-one-sample)

**Read the equal-variances row before the p-value.** The independent-samples output carries [Levene’s test](howto:assumptions-levene) and both versions of the t-test; if Levene’s is significant, the groups’ spreads differ and the row that does not assume equal variances is the one to quote.

**If the grouping variable is one you recoded,** it is available here — the picker reads the measure you set, not the storage type, so a dichotomy recoded to 1/2 shows up as a grouping variable.

ANOVA tells you *that* the groups differ, not *which* ones. Its page covers the post-hoc comparisons that answer the second question.

--- id: task-two-numeric
Look, then measure.

1. **[Plot them](howto:plots-scatter).** A correlation of 0.0 can hide a perfect U-shape, and a correlation of 0.9 can be two clusters with nothing in between. The scatter plot shows you which world you are in, and it carries an optional fit line with the regression equation on it.
2. **[Correlate them](howto:correlation-bivariate).** Pearson’s r for two scale variables that look roughly linear; Spearman’s rho if either is ordinal or badly skewed, since it works on ranks.
3. **If a third variable might explain the whole thing,** [control for it](howto:correlation-partial). Height and reading ability correlate strongly in children, and the explanation is age.

A correlation is symmetric and says nothing about direction. When you want to say “a one-unit change in X goes with so much change in Y”, that is [linear regression](howto:regression-linear).

--- id: task-predict-an-outcome
What kind of outcome you have decides the model, and getting this wrong is the most common way a regression table ends up meaningless.

- **A number** — [linear regression](howto:regression-linear)
- **Yes or no** — [binary logistic regression](howto:logistic-binary)
- **Ordered categories** — [ordinal logistic regression](howto:ordinal-ordinal)
- **A count of events** — [Poisson regression](howto:count-poisson)

**Categorical predictors need a reference category,** and the one the software picks is rarely the one you want to compare against. [Set it deliberately](howto:logistic-categorical) — every coefficient in the table is a comparison with it, so it decides what the table says.

“Controlling for” is a claim about your model, not about the world. A coefficient is adjusted for the variables you put in, and silent about the ones you did not.

--- id: task-weighted-analysis
Survey data usually comes with a weight, and ignoring it gives you the wrong numbers with full confidence.

1. **[Set the dataset’s weight](howto:weight-cases)** once, in **Transform ▸ Weight cases…**.
2. **Run your analysis as normal.** Each one offers the weight as its default, pre-filled into that analysis’s own control and still changeable there. CrossTab never applies a weight you cannot see — the alternative is how a result ends up unreproducible.
3. **Check the caption.** Every weighted result names the weight it used, which is what you quote in your write-up.

Weighting is read as a **frequency weight**: N becomes the sum of the weights. [Frequency tables](howto:frequencies-weighted), crosstabs, t-tests, ANOVA and correlation all take one.

**For standard errors that account for the sampling design** — strata, clusters, finite population correction — a frequency weight is not enough. Use the survey procedures instead: [weighted means](howto:survey-means), [weighted crosstabs](howto:survey-crosstab), [survey regression](howto:survey-regression).

--- id: task-build-a-scale
Several questions, one score. Two routes depending on what the items look like.

- **Counting how many apply** — **Transform ▸ Count values within cases…** gives the number of listed variables where a case holds a value you name. “How many of these eight symptoms did they report” is this.
- **Adding or averaging** — [compute a new variable](howto:compute-a-variable) from an expression across the items.

Two things to do before you trust the score.

**[Reverse the reversed items](howto:recode-a-variable)** first. One item worded the other way round will cancel out the agreement you are trying to measure, and the score will quietly understate it.

**[Check the reliability](howto:reliability-alpha).** Cronbach’s alpha says whether the items behave as though they measure one thing. A low alpha means your score is a sum of unrelated answers, which is still a number and no longer a scale.

Then [describe the score](howto:task-describe-one-variable) before using it — a scale where everyone lands on the same value cannot explain anything.

--- id: task-write-up
Everything you did is already written down. You do not have to remember it.

**[Open the history](howto:history-and-undo)** — **Edit ▸ History…** — for the numbered list of every import, transform and analysis, in order.

**[Switch it to Syntax](howto:syntax-basics)** for the same thing as text. This is not an export that approximates what you did; it *is* the history, and editing it and pressing **Run** rebuilds the data and re-runs the analyses.

**[Save or send it](howto:syntax-save-load)** as `.ctscript`, or as a Stata `.do` or SPSS `.sps` file if that is what your reader uses.

**[Export the output](howto:export-data)** for the tables and charts themselves.

Two habits worth having. **Quote the weight and the filter**, both of which the captions name for you — a mean from weighted, filtered data is a different number from the one a reader will get otherwise. And **keep the project file**, not just the report: it holds the data, the history and the analyses together, so a question about your numbers in six months is answerable rather than archaeology.

--- id: import-data
CrossTab opens the file formats you already have: **SPSS** (`.sav`), **Stata** (`.dta`), **CSV**, **Excel**, **Parquet** and more. Nothing is converted to a house format on the way in — see [the export topic](howto:export-data).

1. Choose **File ▸ Import data…**
2. Pick the format from the searchable list, or just choose the file and let CrossTab recognise it.
3. Check the **Variables** tab afterwards. Labels, value labels and missing-value codes come across when the format carries them.

Your data stays on this device. There is no upload step and no server — the statistics run in your browser.

If a format you need is missing, it is probably a plugin away: see [finding an analysis](howto:find-an-analysis), which works the same way for importers.

--- id: variable-types
The **Variables** tab is the metadata view — one row per variable, the counterpart to SPSS's Variable View.

- **Type** is how the values are stored: `numeric`, `string` or `factor`.
- **Measure** is what they *mean* — `nominal`, `ordinal` or `scale`. Analyses use this to decide what they will accept, so a variable refused by a procedure is usually a measure that needs setting rather than a bug.
- **Label** is the readable name shown in output instead of the column name.
- **Value labels** map codes to words, so `1` reads as *Strongly agree*.
- **Missing** declares the codes that mean "no answer". Those are folded to `NA` before any analysis sees them, so you never have to recode `-99` by hand.

Double-click a cell to edit it. Every change is a step in [the history](howto:history-and-undo), so nothing here is a one-way door.

--- id: compute-a-variable
**Transform ▸ Compute variable…** makes a new column from an expression.

1. Name the new variable.
2. Write the expression — it is SQL, so `income / 12`, `round(age / 10) * 10` and `upper(name)` all work.
3. Run it. The column appears in the data grid and as a step in the history.

Expressions see every variable by name. Names with spaces or punctuation go in `` `backticks` ``.

To put values into groups rather than compute them, [recode](howto:recode-a-variable) is the better tool.

--- id: recode-a-variable
**Transform ▸ Recode into new variable…** maps values into a new column — age into age bands, a 7-point scale into three groups.

1. Pick the source variable.
2. Add rules. A rule is a single value (`1 → 1`), a range (`18..64 → 2`), or `missing`.
3. Set what happens to everything else: copy it, make it missing, or give it a value.
4. Name the new variable and run.

The new variable arrives with its value labels already attached, so output reads in words rather than codes. Set its [measure](howto:variable-types) to `ordinal` if the groups have an order — several analyses will then accept it where they would refuse a nominal.

--- id: select-cases
**Transform ▸ Select cases…** restricts the analysis to the rows you want — adults only, one wave, complete responses.

Write a condition (`age >= 18 and region = 1`) and the rows that fail it drop out of everything downstream. This is a step like any other, so it appears in the history and can be removed later without rebuilding anything.

It filters **rows**. To remove *columns*, use `drop` in [the script](howto:syntax-basics).

--- id: weight-cases
Survey data usually comes with a weight, and ignoring it gives you the wrong numbers with full confidence.

**Transform ▸ Weight cases…** sets one for the dataset. Once set, analyses offer it as their default weight — pre-filled into each analysis's own control, and still changeable there. CrossTab never applies a weight you cannot see: the alternative, silently weighting everything, is how a result ends up unreproducible.

The weight shows in the **Variables** tab so you can tell at a glance which column is in force.

--- id: history-and-undo
**Edit ▸ History…** is the whole story of what you did: every import, every transform, and every analysis you ran, numbered in one list.

- **Click any step** to go back to it. The data grid rewinds, and the analyses below that point are taken out of Output — so what you see always matches the step you are standing on.
- **▲ and ▼** move a step one row. Moving an analysis past a transform changes which data it describes, so it re-runs; moving it past another analysis does not, so nothing recomputes.
- **✕** removes a step.
- A **stale** badge means a variable that result used was changed after it ran. The ↻ beside it re-runs that one analysis.

**Edit ▸ Undo** names what it will undo, so you can see where you are about to land before you press it.

The history is also [a script you can read](howto:syntax-basics).

--- id: syntax-basics
Everything you do has a text form, and it is not a separate export — it *is* the history.

Open **Edit ▸ History…** and choose **✎ Syntax**. Each step appears as a line; edit the text and press **Run** to rebuild the data and re-run the analyses. `Alt+↑` / `Alt+↓` move the line you are on.

This is what makes a piece of work reproducible: the script is the recipe, and it can be exported, shared, and run again on new data. CrossTab can also read and write **Stata `.do`** and **SPSS `.sps`** files, so a script can leave the building.

The **Syntax guide** (in the same panel, and under Help) lists every command with an example.

--- id: find-an-analysis
Analyses live in plugins, including the ones CrossTab ships with — there is no privileged set, and the built-in Frequencies is registered exactly the way a third-party procedure is.

If a menu you expect is missing, the plugin providing it is probably off:

1. Open **Edit ▸ Plugins…**
2. Search for what you want — try the statistic's name, or the discipline.
3. Enable it. The menus appear immediately.

A how-to topic that needs a plugin you have turned off will say so and offer to turn it on, right there on the page.

--- id: export-data
Your work leaves in whatever shape you need it:

- **File ▸ Export data…** writes the dataset back out — SPSS, Stata, CSV, Parquet and more. No format is privileged; the one CrossTab uses for its own projects is just another option.
- **File ▸ Export output…** saves the results — tables, charts and notes — as a report.
- **The project** itself saves everything: data, history, analyses and notes together, so reopening it puts you exactly where you left off.

Keep your own copies of anything that matters. This is pre-release software and it says so on the launcher for a reason.

--- id: syntax-compute
`compute NAME [as TYPE] = EXPR`

Create or overwrite a variable from a DuckDB expression.

**Example**

`compute bmi = weight / pow(height / 100, 2)`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-recode
`recode SRC into NAME [as TYPE]: RULES`

Map values into a new variable. Rules: `V -> TO`, `LO..HI -> TO`, `missing -> TO`, and a trailing `else TO`. TO is a value, `copy`, or `sysmis`.

**Example**

`recode age into agegrp: 0..17 -> 1; 18..64 -> 2; else 3`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-keep-if
`keep if EXPR`

Filter rows — keep only those where the boolean expression holds.

**Example**

`keep if region = 1 and age >= 18`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-drop
`drop VAR1, VAR2 …`

Remove columns from the dataset view (sources stay intact; reversible).

**Example**

`drop id notes rawscore`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-keep-vars
`keep VAR1, VAR2 …`

Keep only these columns (drops the rest). Note: `keep if` filters rows, `keep VARS` keeps columns.

**Example**

`keep age income region`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-rename
`rename OLD to NEW`

Rename a variable (keeps its position, type, and labels).

**Example**

`rename q1 to satisfaction`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-set-cell
`set cell row N COLUMN = VALUE`

Edit one cell. Row is 1-based; an empty string ("") sets it blank (NA).

**Example**

`set cell row 8 income = 52000`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-label-variable
`label variable NAME "Text"`

Set a variable’s descriptive label.

**Example**

`label variable agegrp "Age group"`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-label-values
`label values NAME code "Label", …`

Attach value labels to codes.

**Example**

`label values agegrp 1 "Minor", 2 "Adult", 3 "Senior"`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-set-type
`set type NAME = numeric | string | factor`

Change a variable’s storage type.

**Example**

`set type agegrp = factor`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-set-measure
`set measure NAME = nominal | ordinal | scale`

Set the measurement level.

**Example**

`set measure agegrp = ordinal`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-set-missing
`set missing NAME = v1, v2   (or none)`

Declare user-missing codes (or clear them with `none`).

**Example**

`set missing income = -99, -98`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-run
`run pluginId.fn {json-inputs}`

Run an analysis or plugin, passing its inputs as JSON. See “Running analyses” below for each plugin’s exact call.

**Example**

`run builtin-frequencies.run {"vars": ["gender"]}`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-comment
`# comment`

A comment line, ignored on Run. Data sources (imports/appends/joins) appear as # comments — they’re read-only anchors; re-import to change them.

**Example**

`# use "survey.sav"`

One statement per line. See [reading and running the script](howto:syntax-basics) for how to edit and re-run them together.


--- id: syntax-expressions
Expressions (EXPR) are DuckDB SQL, kept verbatim — anything DuckDB can evaluate works.

Variable names with spaces or punctuation go in `backticks`. Strings use "double quotes"; numbers are bare.

Tip: run any analysis once from the menu, then open History ▸ ✎ Syntax — its exact `run …` line is right there to copy as a template.


--- id: syntax-save-load
The script is a file you can save, send, and open again.

**Save it** — **File ▸ Export analysis script…**, or **⬇ Export** on the History panel's toolbar. Both open the same chooser:

- **CrossTab syntax (`.ctscript`)** — lossless. It imports back into the editor exactly as it left, so this is the one to keep.
- **Stata do-file (`.do`)** and **SPSS syntax (`.sps`)** — best-effort translation, for a colleague who does not run CrossTab.
- **R script (`.R`)** — a runnable script that reads your data, repeats the preparation and then the analyses, with the R CrossTab actually ran recorded beneath each one.

Before you export, the chooser tells you how much of the script the dialect can carry — "12 of 16 statements translate; 4 are written into the file as comments to finish by hand." That count is the thing that decides whether the file is worth sending, which is why it appears before the download rather than after.

**Open one** — **⬆ Import** on the History panel. A `.ctscript` loads verbatim; a `.do` or `.sps` is translated as far as it goes. Either way it arrives as a **draft**: nothing runs until you have read it and pressed **Run**.

Two things worth knowing. The export sends your **unapplied draft** if you have one, and says so — so what you send is what you are looking at. And `.ctscript` is the only round-trip that is guaranteed: a script that has been through Stata or SPSS and back has been translated twice.

See [reading and running the script](howto:syntax-basics) for the editor itself, and [save your work and export results](howto:export-data) for data and output files — which are a different question from the recipe that made them.
