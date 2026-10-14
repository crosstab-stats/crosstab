# Frequencies — how-to topics.
#
# Sections are delimited by `--- id: <topic-id>`, and every id must appear in this
# plugin's `howtoIndex`. This file is read through the same path the host's own guide is:
# nothing here is special to a built-in plugin, and a third-party plugin writing the same
# two manifest fields gets the same placement, the same search and the same rendering.

--- id: frequencies-basics
A frequency table counts how often each value occurs. It is usually the first thing worth
doing to a new dataset: it shows the categories you actually have, rather than the ones you
expected.

1. Choose **Analyze ▸ Descriptive Statistics ▸ Frequencies…**
2. Pick one or more variables. You get one table per variable.
3. Leave the Statistics panel alone for tables only.

Each table shows the value, its **frequency**, and the percentage — both of all rows and of
the rows that answered. Value labels are used where the variable has them, so you read
*Strongly agree* rather than `1`, and codes you declared as [missing](howto:variable-types)
are reported separately rather than counted as real answers.

Unlike Descriptives, this works on **nominal and ordinal** variables, which is where a mode
belongs and a mean does not.

--- id: frequencies-statistics
The second dialog is SPSS's *Statistics* panel. Tick what you want and a Statistics table
appears above the frequency tables.

- **Mode** — the commonest value. The honest summary for a nominal variable.
- **Median** — the middle value. Needs an ordinal or scale [measure](howto:variable-types).
- **Variance**, **Range** — spread, for scale variables.

Tick nothing, or press Cancel, and you get the tables alone.

If a statistic you want is greyed out or refused, the variable's **measure** is usually the
reason rather than its contents — a scale variable stored as nominal will not offer a
median. Setting the measure is one step in the Variables tab.

--- id: frequencies-weighted
Survey data usually comes with a weight, and a frequency table that ignores it reports the
sample rather than the population.

Set a weight once with [Weight cases](howto:weight-cases) and Frequencies will offer it as
the default, pre-filled into its own **Weight cases by** control. You can still change it
for one run without disturbing the project-level setting — the override is the point.

Counts then become weighted case counts, and the table's caption names the weight that
produced them. A result that cannot say what weighted it is a result nobody can reproduce.

Syntax form:

`run builtin-frequencies.run {"vars": ["gender"], "weight": "wtssps"}`
