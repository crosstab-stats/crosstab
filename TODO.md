# CrossTab — TODO

Single source of truth for pending work. The README narrates *status*; this file
tracks *tasks*. When something here lands, check it off (and update the README
milestone/open-question prose if it changes the story).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Now / near-term

- [x] **#174 — DONE (2026-09-12). The gaps a real intro-soc methods class falls into
      (user, 2026-09-11).** Source: `sample-data/Sarabia_GSS2014_MODULES_ON_IMMIGRATION_…_STUDENT_VERSION.pdf`
      — Heidy Sarabia, PhD, 17 labs of SPSS coursework on GSS 2014, handed to students as
      their first statistics assignment. **This list was not a guess about what teaching
      needs. It was the assignment.** Every item below is something a student is instructed,
      in writing, to produce; the practice problems then grade them on the number.

      All thirteen shipped, each as its own commit with an in-browser test, and every
      statistic checked against ground truth rather than eyeballed (local R 4.6.0; the
      weighted work against **case expansion** — with an integer weight, a weighted figure
      must equal the unweighted figure on the physically replicated data).

      - [x] **a. Sort the variable list — and search it.** `ui.selectVariables` gains the
            filter box the other two variable surfaces already had, plus a file-order /
            name / label toggle remembered in localStorage (SPSS files its equivalent
            under Edit ▸ Options, not in the .sav, for the same reason). Grouping is
            computed once from the incoming selection so ticking a box cannot make a row
            jump under the cursor, and ticks live outside the DOM so filtering is lossless.
      - [x] **b/c/d. Mode; variance and range; statistics for a factor.** Frequencies
            gains SPSS's **Statistics** panel — a tick-list (mean, median, mode, sum, SD,
            variance, S.E., range, min, max, quartiles) printed above the frequency tables,
            variables across the top. Descriptives gains Variance, Range and Mode and now
            accepts factors. The mode is read off the raw column (the one statistic here
            defined for a nominal variable whose codes are strings) and shown through the
            value label; ties report the smallest and say so. Host: `kind: 'choice'` learns
            `multiple`, which is what made a Statistics panel expressible declaratively.
            Also fixed: Frequencies folded designated missing *codes* but not *ranges*, and
            the mini-markdown renderer knew `*italic*` but not `_italic_`.
      - [x] **e. A confidence interval at a level you choose.** Descriptive Statistics ▸
            **Explore** — dependent list, optional factor list, confidence level in percent.
            SPSS's Explore Descriptives table. Bounds come from `t.test(conf.level=)`
            unweighted; skewness and kurtosis are deliberately absent (they would be the
            only hand-rolled statistics in the table).
      - [x] **f. Weights on the everyday analyses.** Decided: a **per-analysis Weight
            input, never a global mode** — an SPSS-style WEIGHT BY toggle would have
            reintroduced exactly the hidden state `builtin-survey` was designed to avoid.
            Frequencies, Descriptives, Explore, Crosstabs+χ², all four t-tests/ANOVA and
            correlation each take an optional weight, named in every caption. Read as a
            **frequency weight**: N is `sum(w)` and variances divide by `sum(w) - 1`. Each
            helper falls through to R's own unweighted function at w = 1, so switching
            weighting off reproduces the previous output *exactly*. Crosstabs rounds
            weighted cells to whole cases before testing, so the printed table and the
            chi-square answer to the same numbers. The t-tests and ANOVA are computed from
            weighted group Ns/means/variances rather than `t.test`/`aov`, because
            `lm(weights=)` are ANALYTIC weights — same estimates, wrong residual df.
            Correlation weights **Pearson only**: weighted ranking has no single agreed
            definition, so a rank method with a weight is an error that says why.
      - [x] **g/h. A plain bar chart, a plain line chart, and a settable bin count.**
            Graphs ▸ **Bar chart…** and ▸ **Line chart…**, each the distribution of one
            variable as counts or valid percent — two menu items because being findable by
            name was the whole point. Histogram takes a **Number of intervals** (0 keeps
            Sturges, so existing output is unchanged).
      - [x] **i. A recoded variable is usable in the bivariate analyses.** The picker
            filtered on STORAGE type, so a dichotomy recoded to 1/2 was invisible to
            Crosstabs, the t-test's grouping variable and ANOVA's factor. It now reads the
            ROLE: a categorical role also admits a numeric variable whose **measure** is
            nominal or ordinal. Measure was already first-class (importers carry it,
            Variable View edits it) — this uses what the app already knew.
      - [x] **j. Label the new variable and its values while recoding.** Variable label,
            per-rule value labels and a measure (defaulted from the rules, overridable).
            The metadata lands as an ordinary `setVariable` patch, so the recode stays one
            losslessly round-tripping `recode` line in the syntax editor.
      - [x] **k. An index builder.** Transform ▸ **Count values within cases…**, emitting
            an ordinary `computeVar` so the step is undoable, in History, and exports as
            one `compute` line. Its completeness guard tests designated missing **codes**,
            not just blank cells — caught in testing, where a respondent who answered
            nothing scored as a complete responder with an index of 0.
      - [x] **l. Levene's and the equal-variances row.** The independent-samples t-test
            prints SPSS's two-row Independent Samples Test: Levene's F and Sig, then
            "equal variances assumed" and "not assumed" with their own df, SE and CI. The
            Levene here is **mean-centred** (SPSS's T-TEST variant); the footnote names the
            difference from the Assumptions plugin's median-centred Brown–Forsythe.
      - [x] **m. The regression equation on the scatter fit.** `Y = A + B(X)` beside R² on
            the chart (on a white plate — the top-right corner is also where a steep fit
            line passes through), plus a **Least-squares fit** table with the intercept,
            slope, R² and N, so the coefficients survive export without depending on the
            Trend line toggle.

      **Two follow-ups this work surfaced, both since closed:**

      - [x] **#174n — DONE (2026-09-12). `recode … missing → X` folded only SQL NULLs,
            not designated missing CODES.** `recodeCaseSql`'s `missing` rule emitted
            `src IS NULL`, so a GSS variable whose 8/9 mean Don't know / No answer
            matched nothing — the codes stay in the raw column by design, so only a
            declaration makes them missing, and the recode was not reading it. Now uses
            the same `designatedMissingSql` test `DataStore#missingWrap` applies at
            analysis injection, read from the source's metadata **as of that step** in
            the replay. No migration, per the owner: nothing relied on the old behaviour,
            which was that the rule silently did nothing.

      - [x] **#174o — DONE (2026-09-12). The histogram bins at DRAW time, from live
            controls.** A histogram's intervals are not a detail of how it was drawn —
            they are the argument it makes, so they belong in the chart, not in a dialog
            that has already closed. There is now a real `histogram` chart kind that is
            handed the raw observations (as `scatter` already is with its points) and
            bins on render: **Automatic** (Sturges), **by number of intervals**, **by
            interval width and first boundary**, or **at your own cut points**. Plus
            contiguous bars on a numeric axis, boundary marks, count / percent / density
            heights, a normal curve, and a mean / SD / N block. Every setting is ordinary
            view state, so it persists with the project and survives a reload still live.

            Two invariants the binning is tested on (`test/histogram-bins.test.mjs`),
            because both fail *invisibly*: the maximum must land inside the last interval
            rather than past its edge, and moving the first boundary above the minimum
            must widen the picture downward rather than drop the low tail. Cut points
            that do not span the data say how many values they left out instead of
            drawing a plausible chart of part of them. The dialog's `bins` input stays —
            it seeds the chart and is how a script states an interval count — and a
            column past 100k values is drawn from a uniform random sample, so the model
            does not put a million numbers in the project file.
