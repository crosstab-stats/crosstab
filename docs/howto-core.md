# CrossTab's own how-to topics (#192)
#
# Sections are delimited by a line reading `--- id: <topic-id>`, and every id here must
# appear in core/howto-core.js. This file is read exactly the way a plugin's sidecar is.
# Anything before the first delimiter — including this note — is ignored.

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
