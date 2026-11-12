# CrossTab full test checklist

Every user-facing feature, with a recipe to trigger it and the result to expect.
**116 plugin menu items across 64 plugins**, plus the core app, the codecs, the
workspaces and the qualitative side. Built by enumerating the actual manifests, not
from memory — if something is missing here it is missing from the app too.

For statistical functions there is a third line: **Reference** — how to run the same
thing in SPSS (or Stata/R/the field's actual authority) so you can check the arithmetic.

Designed for many sittings. Tick as you go. Anything odd goes in
[Findings](#findings) at the bottom with the step number.

---

## How to read an entry

```
- [ ] **Name** — `menu path`
      Recipe:    what to click in CrossTab, with the exact variables to pick.
      Expect:    what correct output looks like — often the exact numbers.
      Reference: the same analysis in SPSS, as a click path.
      Syntax:    the same thing as an SPSS command, if you prefer pasting.
```

**Reference lines are click paths, not just commands.** Every statistical entry names
the SPSS menu route — *Analyze ▸ Compare Means ▸ Independent-Samples T Test…*, which
button to press next, which boxes to tick — because knowing CrossTab well is no help in
finding a dialog in SPSS. Where SPSS genuinely cannot do something, the line says so
outright and names what can: Stata, R, JASP, GeoDa, Mplus, Prism, G\*Power, the Distance
software. 100 of the 118 statistical entries carry an SPSS path; the other 18 say why
not.

**To run a `Syntax:` line in SPSS** (quicker than clicking once you are used to it):
File ▸ **New** ▸ **Syntax**, paste the command, then **Run ▸ All** — or select just the
lines you want and press **Ctrl-R**. Commands end with a full stop; that is not a typo.
`EXECUTE.` after a Transform command is what makes it take effect.

**Module warnings.** Some SPSS procedures live in paid add-ons and simply will not be in
your Analyze menu without them: **Complex Samples** (§28), **Forecasting** (§25),
**Bootstrapping** (§32), **Missing Values** (§18's imputation), **Amos** (CFA/SEM), and
**Power Analysis** (§32). The entries say which, so you are not left hunting for a menu
that was never installed.

Three things worth knowing before you start:

**Exact numbers are quoted where they exist.** Both demo datasets are deterministic
— no RNG, same 30 (and 60) cases every time — so this document quotes the *actual
expected values*, computed on **desktop R 4.6.0** (`scripts/validation/demo-reference.R`).
Where you see `mean = 41.0000`, that is the number to see. You only need SPSS for the
analyses where no figure is quoted, or when you want a second opinion.

**Most of these wrap R, so a mismatch with SPSS is not automatically a bug.** CrossTab
computes nearly everything in R via WebR. Where SPSS and R legitimately disagree by
default (quartile definitions, Levene centring, SS types, tie corrections) the entry
says so, and [§38](#38-known-legitimate-differences-from-spss) collects them. Check
those before filing anything.

**Four plugins hand-roll their arithmetic in JavaScript and call no R at all.** They
are the ones where a wrong number cannot be blamed on anybody else, so they are
marked 🔢 and deserve the closest look: **SCED**, **Plots**, **Aggregate**,
**Decision Support**.

---

## 0. Setup

- [ ] **Serve the app**
      Recipe: in the repo, run `npm run dev`, then open <http://localhost:8080/>.
      Expect: the app loads. Use this and not `python -m http.server` — the bundled dev
      server sends the COOP/COEP headers WebR needs, and Python mis-types `.js` on
      Windows so the app will not boot at all.

- [ ] **Activate the plugins**
      Recipe: **Edit ▸ Plugins…** → tick everything (or just the categories you are
      about to test) → close the dialog. Look at the menu bar before and after.
      Expect: before, the menu bar is File / Edit / Transform / Help only. After, about
      22 category menus appear (Descriptive Statistics, Comparison, Regression, Graphs,
      Time Series …). **Nothing below appears until its plugin is activated** — an empty
      menu bar on a fresh profile is correct, not a bug. *(I activated all 64 in your
      browser while mapping the menus, so this may already be done.)*

- [ ] **Load the demo data**
      Recipe: **Launcher ▸ demo (quant)**. If you are already in the app,
      **File ▸ New project** and pick the demo seed. Then click the **Data** tab.
      Expect: 30 rows; columns `gender` (1 Male / 2 Female), `education` (1 High school /
      2 Bachelor / 3 Postgraduate), `region` (1 North / 2 Central / 3 South), `age`,
      `income`.
      Then: click the **Variables** tab and look at `income`'s missing-values cell.
      Expect: **−99 and −98 are declared missing**, and two cases hold −99. So every
      income statistic should run on **N = 28**, not 30. If an analysis reports N = 30
      for income, it is ignoring designated missing values — that is the single most
      useful trap in this dataset.

- [ ] **Get the same data into SPSS**
      Recipe: **File ▸ Export data…** → type "SPSS" in the picker → **SPSS (.sav)** →
      save. Open that `.sav` in SPSS.
      Expect: value labels and the −99/−98 missing codes arrive with it, so SPSS applies
      them too.
      Reference: a CSV export also works, but then you must re-declare the missing codes
      in SPSS (Variable View ▸ Missing) — forgetting to is the most common source of a
      *fake* mismatch.

- [ ] **Load the spatial demo for the battery analyses**
      Recipe: **File ▸ New project**, pick the **spatial** demo seed (reliability, factor
      analysis and cluster analysis need several numeric variables, which the 30-case
      demo does not have).
      Expect: 60 cases; `satisfaction` (1–10), `commute_min`, `income_k`,
      `household_size`, `zip_code`, `district` (CA-03 × 27, CA-06 × 18, CA-07 × 15).
      Also deterministic, so the quoted values hold.

- [ ] **Have desktop R ready as the tie-breaker**
      Recipe: `C:\Program Files\R\R-4.6.0\bin\Rscript.exe`. To regenerate every number
      quoted in this document:
      `node scripts/validation/dump-demo-csv.mjs .` then
      `Rscript scripts/validation/demo-reference.R` and
      `…/demo-reference-spatial.R`.
      Expect: the figures below, to the digit.
      Reference: for a wrapper plugin there is a sharper test than SPSS — open
      **Edit ▸ History…**, find the analysis row, read the **R it generated**, and run
      that exact text in desktop R. That should match to the last digit; SPSS only
      should match to the method.

---

## 1. Boot and launcher

- [ ] **Cold load**
      Recipe: hard-reload with **Ctrl-Shift-R**.
      Expect: launcher appears, no error overlay, no reload loop. On the live GitHub
      Pages site *one* self-reload at first visit is expected (the service worker
      claiming cross-origin isolation); a *repeating* loop is the red flag.

- [ ] **The launcher's plugin list**
      Recipe: on the launcher screen, read the plugin list; tick a few; pin a discipline
      from the discipline selector.
      Expect: load state and activation state are shown as **different things** (a
      plugin can be catalogued without being activated); pinning a discipline filters
      the list to that discipline's plugins.

- [ ] **Each onboarding path**
      Recipe: from the launcher take **demo (quant)**, then (new project)
      **demo (qual)**, then **blank**.
      Expect: each lands in a usable project.
      Then: load a demo and **immediately reload the page without editing anything**.
      Expect: you are back at the launcher — a demo or blank seed is **not** autosaved
      as though it were your work. Make one real edit first and it *is* saved.

- [ ] **Boot survives a broken plugin**
      Recipe: save a file called `broken.js` containing just `this is not javascript`.
      **Edit ▸ Plugins… ▸ Add from file…** → pick it. Then reload the page.
      Expect: it is listed as **failed** with a readable reason; the app still boots;
      every other plugin still works. It must not be able to take the app down.

- [ ] **Boot survives a broken `deploy.json`**
      Recipe: put `{{{garbage` in `deploy.json` at the repo root, reload.
      Expect: the app boots on defaults. Nothing in that file may break a boot — that is
      its contract.

## 2. Projects and persistence

- [ ] **Autosave**
      Recipe: in the **Data** tab, double-click a cell, change the value, press Enter.
      Wait two seconds, then reload the page.
      Expect: the new value is still there.

- [ ] **New project, switch, recent**
      Recipe: **File ▸ New project**, load the demo, rename something. Then
      **File ▸ Recent projects** → switch back to the first project, and back again.
      Expect: each project keeps its own data, output and codebook; nothing bleeds
      across.

- [ ] **Rename a project**
      Recipe: **File ▸ Manage projects…** → click the project's name → type a new one →
      Enter. Reload.
      Expect: the new name stuck.

- [ ] **Delete a dataset, then restore it from the recycle bin**
      Recipe: in the **sidebar**, add a second dataset so there are two, do something to
      one of them (a recode, some coding), then click its **✕**. A **Recently deleted**
      zone appears under the dataset list — it is only there when something is in it.
      Click the **↩** beside the deleted dataset.
      Expect: it comes back with its data, its transform history, and anything attached
      to it (CAQDAS coding, map layers, memos) still attached — it returns under its
      *original* id, which is what re-attaches them. Deleting is a status change, not a
      copy, so this costs nothing and survives a reload. The **✕** in that zone is the
      permanent one and says so; the bin keeps the 20 most recent and purges beyond that.
      Note this bin is **per project and for things inside it** — datasets and item
      records. There is no bin for whole projects; see the next check.

- [ ] **Delete a project — and there is no undo**
      Recipe: **File ▸ Manage projects…** → **✕** on a project stored in this browser.
      Read the confirmation, confirm, then reload.
      Expect: the dialog says plainly that the project and its data go and that it
      **cannot be undone** — there is deliberately no project-level recycle bin, so a
      safety net means **File ▸ Export project bundle** (`.crosstab`) *before* deleting.
      It is gone from the list and still gone after the reload. Delete the project you
      currently have open and you land in a fresh Untitled project rather than nowhere.
      A project stored in a **folder or remote** is a different offer, and worth checking
      separately: the wording becomes "remove from the list", the files stay put, and
      deleting them too is an unticked checkbox you have to tick yourself.

- [ ] **Change where a project is stored**
      Recipe: **File ▸ Store in…** → pick a local folder (File System Access), then try
      OPFS, then Dropbox or WebDAV if you have them configured.
      Expect: the project moves; **File ▸ Manage projects…** still lists it; a reload
      finds it in its new home.

- [ ] **Storage pressure**
      Recipe: import a very large file (or several) until storage is nearly full, then
      keep editing.
      Expect: an explicit warning. The failure mode to hunt for is a **silent** write
      failure that looks like a successful save.

- [ ] **Project health on a damaged project**
      Recipe: open a project, then delete one of its asset files from the storage
      folder behind the app's back. Reopen it via **File ▸ Manage projects…**.
      Expect: health reports the missing asset and the project still opens. It must not
      refuse to open or throw.

- [ ] **Copy a dataset to another project**
      Recipe: **File ▸ Copy dataset…** → choose a dataset and a target project → confirm.
      Open the target.
      Expect: the dataset arrives **with its variable metadata** — labels, value labels
      and missing codes, not just the numbers.

## 3. Settings — including the "two places must agree" cases

The screen is **Edit ▸ Settings…**. Each row either edits in place, routes you to the
real control, or reports a secret's state without printing it.

- [ ] **Width on a wide window**
      Recipe: maximise the window, then **Edit ▸ Settings…**.
      Expect: the dialog is about 80% of the viewport, capped at 900px — not a narrow
      420px column. No horizontal scrollbar on the page. Narrow the window below 700px
      and it falls back to 92vw. *(#208)*

- [ ] **Screen layout, from both ends**
      Recipe: **Edit ▸ Settings…** → Screen layout → **Small screen mode**. Close the
      dialog and open the **Edit** menu.
      Expect: **☑ Small screen mode** is now ticked, and the layout actually changed.
      Then: click that menu item to turn it off, and reopen Settings.
      Expect: the Settings row now reads the default. One value, two places, agreeing in
      both directions.

- [ ] **Variable list order** *(#210)*
      Recipe: load the demo, click the **Data** tab, note the column order
      (gender, education, region, age, income). **Edit ▸ Settings…** → Variable list
      order → **Name (A–Z)**.
      Expect: the Data grid columns re-order to age, education, gender, income, region
      **immediately**, the **Variables** tab re-orders too, and the little **order
      dropdown in the toolbar above each variable list** now reads "Name (A–Z)".
      Then: change it from that toolbar dropdown instead, and reopen Settings.
      Expect: the Settings row agrees. Try **Name (Z–A)** and **Label (A–Z)** as well.

- [ ] **Show variables as**
      Recipe: **Edit ▸ Settings…** → Show variables as → **Name**.
      Expect: grid headers drop the label half (just `gender`, not "Gender" + `gender`).
      Set it to **Both** from the toolbar dropdown and confirm Settings agrees.

- [ ] **Variable pickers offer** *(#205)*
      Recipe: **Descriptive Statistics ▸ Crosstabs…** and look for `income` in the row
      variable list — it is scale-coded, so it is not offered. Cancel.
      **Edit ▸ Settings…** → Variable pickers offer → **All variables**. Reopen
      Crosstabs.
      Expect: `income` is now offered, and running it produces a very long table — which
      is the point: the restriction is a default, not a veto.
      Then: set it back to **Fitting variables** → `income` disappears from that picker
      again. Reload the page and confirm the choice was remembered.

- [ ] **Frequency weight — a project setting that writes an op** *(#207)*
      Recipe: **Edit ▸ Settings…** → Frequency weight → pick a variable → close.
      Then **Edit ▸ History…**.
      Expect: a **weight step appears in the history**, because a weight is a property of
      the dataset and not a device preference. **Edit ▸ Undo** reverses it. Open
      **Transform ▸ Weight cases…** and it shows the same variable. Change it *there*
      and the Settings row follows.

- [ ] **The scope hint** *(#206)*
      Recipe: read the Settings screen top to bottom.
      Expect: it distinguishes device settings from project settings, so the Frequency
      weight row is not mistaken for a preference.

- [ ] **Plugins you added or created (a routed row)**
      Recipe: **Edit ▸ Plugins… ▸ Add from file…** with a small authored plugin, and
      **Add from URL…** with one served from a host. Then **Edit ▸ Settings…** → the
      **Plugins** group.
      Expect: one row, reading something like *1 from the web (thathost.example) · 1 from
      a file*. The **host** is named — that is the point of the row, since a URL plugin is
      re-fetched from someone else's server and run on every launch. The built-ins are not
      listed, and there is **no Clear button** (clearing the index would orphan the stored
      sources). **Open…** opens the plugin manager. Remove one there, reopen Settings.
      Expect: the count follows. With nothing added it reads *None — only the built-ins*.

- [ ] **Encrypt at rest (a routed row)**
      Recipe: **Edit ▸ Settings…** → the Encrypt at rest row → **Configure…**.
      Expect: the encryption dialog opens. Change the policy, come back.
      Expect: the row now reports the new state.

- [ ] **TURN server** *(#209)*
      Recipe: **Edit ▸ Settings…** → TURN server → **Configure…**. Try, in order:
      a `stun:` URL; a username with no credential; then a full `turn:` URL with both.
      Expect: `stun:` is refused with a reason; a half credential pair is refused; the
      full one saves. Reopen the editor.
      Expect: **the fields are not pre-filled with the stored credential**, and the
      Settings row says only *Configured* / *Not configured* — the credential itself
      appears nowhere on screen.

- [ ] **Rendezvous relays**
      Recipe: **Edit ▸ Settings…** → the relays box → enter two URLs on separate lines
      with a blank line between them → close → reopen.
      Expect: two entries, not three — a blank line is not an entry.

- [ ] **Debug logging**
      Recipe: **Edit ▸ Settings…** → tick Debug logging → close → open the **Edit** menu.
      Expect: **☑ Debug logging** is ticked. Then **Edit ▸ Save debug log…**
      Expect: a log file is produced.

- [ ] **A lifecycle flag stays hidden**
      Recipe: read every row on the Settings screen.
      Expect: nothing resembling `screen.autoNoteSeen` is listed. A setting with no
      label is a lifecycle flag, not a preference, and must not be offered.

- [ ] **Clearing restores the default, not a copy of it**
      Recipe: set Screen layout to Small screen mode, then clear it back to the default.
      Narrow and widen the window.
      Expect: the **viewport decides again**. A stored "full" would outrank the viewport
      and look identical until you resized — which is the bug this checks for.

## 4. Data import and export (codecs)

Everything goes through one searchable picker: **File ▸ Import data…** and
**File ▸ Export data…**. There are deliberately no per-format menu items. *(#113)*

- [ ] **The picker itself**
      Recipe: **File ▸ Import data…** and type "stata" in the search box.
      Expect: one grouped, searchable list; "stata" finds the SPSS/Stata/SAS entry.
      Then pick a format whose plugin you deliberately left deactivated.
      Expect: it is still offered and **activates on use** rather than being hidden.

- [ ] **CSV** — `.csv` / `.tsv` / `.txt`
      Recipe: **File ▸ Export data…** → CSV → save. Then **File ▸ Import data…** → CSV →
      re-import that file.
      Expect: delimiter and header detected; types inferred; the values round-trip.
      Reference: SPSS `GET DATA /TYPE=TXT`, or File ▸ Import Data ▸ CSV Data.

- [ ] **Excel** — `.xlsx` / `.xls` / `.xlsm` / `.xlsb`
      Recipe: export to `.xlsx`, open it in Excel, then re-import. Try a workbook with
      several sheets.
      Expect: you are asked which sheet; values round-trip.
      Reference: **SPSS** — File ▸ **Import Data** ▸ **Excel…** → pick the file → in the
      *Read Excel File* dialog choose the **Worksheet**, tick **Read variable names from
      first row of data** → **OK**. To write one back: File ▸ **Export** ▸ **Excel**.
      Syntax: `GET DATA /TYPE=XLSX /FILE="d.xlsx" /SHEET=NAME "Sheet1"
      /READNAMES=ON.`

- [ ] **SPSS / Stata / SAS, reading** — `.sav` `.zsav` `.dta` `.por` `.xpt` `.sas7bdat`
      Recipe: import the `.sav` you exported in §0.
      Expect: **variable labels, value labels and missing codes all arrive** — check
      `income`'s −99/−98 specifically in the Variables tab. This is the one to test
      hardest; numbers-only import is the failure to look for.

- [ ] **SPSS / Stata / SAS, choosing variables**
      Recipe: **File ▸ Import data…** → "SPSS / Stata / SAS — choose variables…" → pick
      a `.sav` → select two of its variables.
      Expect: only those two columns import.

- [ ] **SPSS (.sav) and Stata (.dta) export**
      Recipe: **File ▸ Export data…** → SPSS (.sav); again for Stata (.dta). Open each in
      its own application.
      Expect: both open with labels intact.
      Expect too: `.por`, `.xpt` and `.sas7bdat` are offered for **reading only** — write
      support is deliberately narrower. Not a gap to file.

- [ ] **Parquet** — `.parquet`
      Recipe: export, re-import.
      Expect: round-trips; types preserved.
      Reference: **SPSS cannot read Parquet.** **R** — `arrow::read_parquet("f.parquet")`.
      **Python** — `pandas.read_parquet("f.parquet")`. For a quick GUI look, **DuckDB**’s
      CLI will do it in one line: `SELECT * FROM "f.parquet" LIMIT 10;`

- [ ] **JSON Lines** — `.ndjson` / `.jsonl`
      Recipe: export, re-import, and open the file in a text editor.
      Expect: one JSON object per line; round-trips.

- [ ] **Wikipedia table import**
      Recipe: **File ▸ Import data…** → **Wikipedia table…** → paste an article URL with
      a table in it → pick the table.
      Expect: it arrives as a dataset with usable column names.

- [ ] **A large file**
      Recipe: import something in the hundreds of megabytes and watch the tab.
      Expect: it streams with progress; the tab stays responsive; memory does not
      explode. *(Two known follow-ups remain open here: an ultra-wide file path, and a
      multi-GB write test.)*

- [ ] **Swap, not replace**
      Recipe: with a dataset already loaded, import another file over it.
      Expect: it offers **Swap** — the new data becomes a **new dataset** and the old one
      goes to the bin. It must never silently clear the live dataset.

## 5. Transform

- [ ] **Compute variable…**
      Recipe: **Transform ▸ Compute variable…** → target name `income_k` → expression
      `income / 1000` → OK. Look at the Data tab, then **Edit ▸ History…**.
      Expect: a new `income_k` column whose first value is **52** (income 52000); the two
      −99 cases come through as **missing, not −0.099**; a history step appears and
      **Edit ▸ Undo** removes the variable.
      Reference: **SPSS** — **Transform** ▸ **Compute Variable…** → **Target Variable** =
      `income_k` → in **Numeric Expression** type `income / 1000` (or build it by
      double-clicking `income` in the variable list) → **OK**. SPSS applies it
      immediately in the dialog version.
      Expect too: SPSS propagates **system-missing** through arithmetic the same way, so
      the two −99 cases should come out missing there too — a useful cross-check that
      the missing codes imported correctly.
      Syntax: `COMPUTE income_k = income / 1000.` then `EXECUTE.`

- [ ] **Recode into new variable…**
      Recipe: **Transform ▸ Recode into new variable…** → source `age`, target
      `age_band` → ranges: lowest–34 → 1, 35–49 → 2, 50–highest → 3 → OK.
      Expect: a new variable; **`age` is untouched**; value labels can be set on the
      result; counts are **10 / 12 / 8** (check with Frequencies).
      Reference: **SPSS** — **Transform** ▸ **Recode into Different Variables…** → move
      `age` across → **Output Variable** Name = `age_band` → **Change** → **Old and New
      Values…** → for each band pick *Range, LOWEST through value* `34` → New Value `1` →
      **Add**; then *Range* `35` through `49` → `2` → **Add**; then *Range, value through
      HIGHEST* `50` → `3` → **Add** → **Continue** → **OK**.
      ⚠️ Use **Recode into Different Variables**, not *Recode into Same Variables* — the
      latter overwrites `age` in place, which is exactly what CrossTab refuses to do.
      Syntax: `RECODE age (LO THRU 34=1)(35 THRU 49=2)(50 THRU HI=3) INTO age_band.`

- [ ] **Count values within cases…**
      Recipe: **Transform ▸ Count values within cases…** → target `n_high` → count the
      value 3 across `education` and `region`.
      Expect: a count per row, 0–2, with no missing.
      Reference: **SPSS** — **Transform** ▸ **Count Values within Cases…** → **Target
      Variable** = `n_high` → move `education` and `region` into **Numeric Variables** →
      **Define Values…** → *Value* `3` → **Add** → **Continue** → **OK**.
      Syntax: `COUNT n_high = education region (3).`

- [ ] 🔢 **Aggregate / collapse…**
      Recipe: **Transform ▸ Aggregate / collapse…** → `groupby = education`,
      `measures = income`, `func = mean` → OK.
      Expect, exactly: 3 rows — **30350.00 / 43836.36 / 60355.56**. Hand-rolled
      JavaScript arithmetic, so check it: those are the same group means the one-way
      ANOVA reports in §15. They must agree with each other.
      Reference: **SPSS** — **Data** ▸ **Aggregate…** → `education` into **Break
      Variable(s)**, `income` into **Summaries of Variable(s)** → click **Function…** →
      **Mean of values** → **Continue** → choose **Create a new dataset containing only
      the aggregated variables** → name it → **OK**.
      Syntax: `AGGREGATE OUTFILE=* MODE=REPLACE /BREAK=education
      /income_mean=MEAN(income).`

- [ ] **Select cases…**
      Recipe: **Transform ▸ Select cases…** → condition `age > 40` → OK. Then run
      **Descriptive Statistics ▸ Frequencies…** on `gender`.
      Expect: the filter is visible in the UI and analyses honour it — gender comes back
      **2 / 12**, N = 14, not 15 / 15, N = 30. Switch it off again and all 30 return.
      Reference: **SPSS** — **Data** ▸ **Select Cases…** → **If condition is satisfied**
      → **If…** → type `age > 40` → **Continue** → under *Output* choose **Filter out
      unselected cases** → **OK**. A `filter_$` variable appears and the excluded rows
      get struck through in Data View.
      ⚠️ Choose **Filter**, not **Delete unselected cases** — Delete is destructive and
      permanent once you save. CrossTab’s filter is always reversible, so Filter is the
      comparable behaviour.
      Syntax: `FILTER OFF.` `USE ALL.` `SELECT IF (age > 40).` `EXECUTE.`

- [ ] **Extract columns to a new dataset…**
      Recipe: **Transform ▸ Extract columns to a new dataset…** → pick `gender` and
      `income` → OK.
      Expect: a second dataset with just those two columns and their metadata; the
      original is unchanged.

- [ ] **Join with another dataset…**
      Recipe: make a small second dataset keyed on `education` (3 rows, a label column),
      then **Transform ▸ Join with another dataset…** → choose the key and the join type.
      Expect: the new column lands on all 30 rows; it appears in **Edit ▸ History…** as
      **one undoable step**; a non-matching key produces missing rather than a silent
      drop.
      Reference: **SPSS** — **Data** ▸ **Merge Files** ▸ **Add Variables…** → pick the
      other dataset → **Continue** → tick **Match cases on key variables in sorted
      files**, choose **Non-active dataset is keyed table** → move `education` into **Key
      Variables** → **OK**.
      ⚠️ SPSS requires **both files sorted on the key** first (Data ▸ Sort Cases…) and
      will refuse or mis-merge otherwise. CrossTab does not — so a difference here is
      most likely an unsorted SPSS file, not a CrossTab bug.
      Syntax: `MATCH FILES /FILE=* /TABLE="other.sav" /BY education.`

- [ ] **Weight cases…**
      Recipe: **Transform ▸ Compute variable…** to make `w = 2`, then
      **Transform ▸ Weight cases…** → `w`. Run **Frequencies** on `gender`.
      Expect: counts are **30 / 30** (each case counted twice) and N = 60; the caption
      names the weight; **Edit ▸ Settings…**'s Frequency weight row shows `w`; History
      records it.
      Then: make a weight with a zero and a negative value in it.
      Expect: those cases are **dropped outright**, not counted as fractions.
      Reference: **SPSS** — **Data** ▸ **Weight Cases…** → **Weight cases by** → move `w`
      into **Frequency Variable** → **OK**. A **Weight On** indicator appears in the
      status bar at the bottom right; that indicator staying on by accident is the
      classic SPSS footgun, which is part of why CrossTab surfaces the weight in each
      run’s own dialog.
      Expect too: SPSS also drops cases with a missing, zero or negative weight rather
      than counting fractions of a case — so the two should agree exactly.
      Syntax: `WEIGHT BY w.` and `WEIGHT OFF.` to clear it.

- [ ] **Run R script…**
      Recipe: **Transform ▸ Run R script…** → type `summary(data)` → Run. Then run
      `data.frame(x = 1:5, y = (1:5)^2)`.
      Expect: the summary prints (the active dataset is bound as `data`); a plot-producing
      script shows its plot; the returned data frame can be **imported as a new dataset**
      — the reverse bridge. Check the new dataset has 5 rows.

---

## 6. History, timeline, and the do-file editor

- [ ] **The History panel**
      Recipe: load the demo, run **Frequencies** on `gender`, do a
      **Transform ▸ Compute variable…**, run **Crosstabs**. Then **Edit ▸ History…**
      Expect: numbered rows; data steps and analyses interleaved **by anchor** (the
      Crosstabs sits after the compute, because that is when it ran); a cursor you can
      move, which moves across both data steps and analyses.

- [ ] **Undo and Redo across a mixed sequence**
      Recipe: with the above history, **Edit ▸ Undo** three times, then **Redo** three
      times, watching the Data tab and the Output pane.
      Expect: steps reverse in order; analyses either **re-run or are marked stale** —
      what must not happen is an analysis quietly showing numbers from data that no
      longer exists.

- [ ] **Reorder an analysis row** *(#190 — unverified by me; a Steam window was
      occluding Chrome, which freezes the renderer and makes timed checks unreliable)*
      Recipe: **Edit ▸ History…** → find an analysis row → click its **▲ / ▼** arrows to
      move it above or below a data step it depends on.
      Expect: the row moves; dependent rows re-run; a **busy indicator appears and then
      clears**. Nothing is left stale-but-looking-fresh.

- [ ] **Branch discard**
      Recipe: **Edit ▸ History…** → move the cursor back three steps → now do something
      new (compute a variable).
      Expect: an explicit **warning that the later branch will be discarded**, and then
      it is discarded. It must not silently rewrite history behind you.

- [ ] **Syntax mode round-trip (lossless)**
      Recipe: **Edit ▸ History…** → the **✎ Syntax** toggle. Read the text, switch back
      to the row view, switch to Syntax again and compare.
      Expect: the whole timeline as editable CrossTab syntax, and **no drift** between
      the two passes — the round-trip is lossless by design.

- [ ] **Edit the syntax and Run**
      Recipe: in Syntax mode, change a value in one of the data steps → **Run**.
      Expect: the data is rebuilt from the edited script and **the analyses are replayed**
      on the new data. This is the do-file promise; a partial replay is the thing to look
      for.

- [ ] **`.ctscript` export and import**
      Recipe: **File ▸ Export analysis script…** → `.ctscript`. Start a new project, load
      the demo, then import that script.
      Expect: the same steps and the same output.

- [ ] **Stata `.do` export and import**
      Recipe: **File ▸ Export analysis script…** → **Stata (.do)**. Open the file in a
      text editor, then (optionally) run it in Stata against the exported data.
      Expect: readable, runnable Stata with the **analyses included**, not just the data
      steps. Re-importing it reproduces the steps.
      Expect too: this is explicitly **best-effort** — it is a translation between two
      languages, not a guarantee. Note what did not survive rather than filing it as a
      defect.

- [ ] **SPSS `.sps` export and import**
      Recipe: same, choosing **SPSS (.sps)**. Paste it into an SPSS syntax window and
      run it against the `.sav` from §0.
      Expect: it runs and produces comparable output. Same best-effort contract.
      Reference: **to run the exported file in SPSS** — File ▸ **Open** ▸ **Syntax…** →
      pick the `.sps` → in the syntax window, **Run** ▸ **All**. Check the first lines
      point at the right data file; adjust the path if you moved it.
      Expect too: this is also the quickest way to get the SPSS commands for any
      arithmetic check further down — export the script and read it rather than typing
      the syntax out.

- [ ] **R syntax export**
      Recipe: **File ▸ Export analysis script…** → **R**. Run the resulting `.R` in
      desktop R against the CSV export of the same data.
      Expect: runnable R that reproduces the analyses. This is the most faithful of the
      three script exports, since the analyses were computed in R to begin with — which
      also makes it the best way to get the exact code for an arithmetic check.
      Reference: **to run it** — open the `.R` in RStudio (or `Rscript the-file.R`),
      having first exported the data as CSV so the paths line up. Compare its output to
      the app’s own, line for line. Because the analyses were computed in R to begin
      with, this should match to the last digit — making it the sharpest of the three
      script exports as a correctness check.

- [ ] **A stale analysis**
      Recipe: run **Descriptive Statistics ▸ Descriptives…** on `income`. Then
      **Transform ▸ Recode** `income` (or edit a value it used).
      Expect: the analysis is **marked stale**; its old output is still there and still
      auditable; re-running updates it. The failure to look for is output that silently
      keeps the old numbers with no indication.

## 7. Plugins — lifecycle and the manager

The vocabulary matters: *catalogued / registered / enabled / activated / failed /
referenced*. "Loaded" and "active" are not states.

- [ ] **The manager**
      Recipe: **Edit ▸ Plugins…** and read the list.
      Expect: every plugin with its state; **enabled and activated are distinct**; a
      failed plugin says *why* it failed.

- [ ] **Activate and deactivate one**
      Recipe: untick **Frequencies** → close → open the **Descriptive Statistics** menu.
      Then re-tick it and look again.
      Expect: `Frequencies…` disappears from the menu and comes back. Menu presence
      follows activation exactly.

- [ ] **The 🔍 how-to**
      Recipe: **Edit ▸ Plugins…** → click the **🔍** beside any plugin.
      Expect: that plugin's one-line how-to. All 60-odd builtins have one.

- [ ] **Add from file, and add from URL**
      Recipe: **Edit ▸ Plugins… ▸ Add from file…** with a small authored plugin; then
      **Add from URL…** with a plugin served from some host.
      Expect: the URL one is namespaced by **host**; the file/authored one gets
      `plugin:<id>` isolation. Two plugins with the same declared id from different
      sources must not be able to read each other's stored data.

- [ ] **Create a plugin**
      Recipe: **Edit ▸ Create plugin…** → accept the scaffold → run the analysis it
      registers. Then **Edit ▸ Plugins…** → **Export plugin** → re-import the exported
      file.
      Expect: the scaffold runs immediately and the export/import round-trips.

- [ ] **Presets** *(#162 — unverified by me, same occlusion block)*
      Recipe: open any analysis dialog (**Descriptive Statistics ▸ Frequencies…**), fill
      in `vars = gender, education` and some Statistics ticks, then use the **preset
      dropdown ▸ Save** and name it. Cancel, reopen the dialog, pick the preset.
      Expect: the inputs come back exactly. Then **Rename** it, then **Delete** it.
      Then: deactivate the plugin that preset belongs to and open the preset list again.
      Expect: **a clear note that the plugin is missing** — not an error, not a silently
      broken entry.

- [ ] **Cross-plugin reads** *(#196)*
      Recipe: in the **Coding** workspace create a codebook and code a passage. Then run
      **Scale ▸ Inter-coder agreement from codings…**
      Expect: it reads the CAQDAS codings across the plugin boundary, because they are
      declared a **public** collection. A collection declared `read: 'owner'` is invisible
      to other plugins — the default — and codings are deliberately public because they
      are analysis substrate.

- [ ] **Site plugins**
      Recipe: add a site plugin directory to `deploy.json`, drop a plugin in it, reload.
      Expect: it is **host-namespaced** and **provided, not privileged** — it gets exactly
      the authority any other plugin gets, no more.

- [ ] **R package resolution**
      Recipe: activate **Multivariate ▸ CFA & SEM** (needs `lavaan`) and run it. Watch
      the progress. Then activate several heavy plugins at once and run one.
      Expect: packages download once, with progress, then are cached. A package that
      cannot load in WebR fails with a **readable message**, not a hang. There is a hard
      ceiling of roughly 20 concurrently-loaded shared objects — a failure naming an
      apparently innocent package is the known symptom of hitting it, not a bug in that
      package.

## 8. Output and export

- [ ] **The Output pane**
      Recipe: run **Frequencies** on `gender` with a weight set, then click **Output**.
      Expect: tables, text and charts in the order they were run; a caption naming the
      **dataset** and the **weight**.

- [ ] **Clear output**
      Recipe: the **Clear output** action beside the tabs.
      Expect: output empties; the data and History are untouched.

- [ ] **Output outlives its maker**
      Recipe: run **Descriptive Statistics ▸ Crosstabs…**. Then **Edit ▸ Plugins…** and
      **deactivate Crosstabs**. Then reload the page and look at Output.
      Expect: the saved output **still renders and is still auditable** — the artefact
      and the R that computed it were persisted, with provenance captured at write time.
      Worst case it degrades to static plus a plain note. It must never vanish or throw.

- [ ] **Export output ▸ HTML**
      Recipe: **File ▸ Export output…** → HTML → save → open in a browser with no network.
      Expect: self-contained; charts included; no broken images.

- [ ] **Export output ▸ Word (.docx)**
      Recipe: same, choosing Word. Open in Word.
      Expect: it opens; **tables are real Word tables** you can click into, not images.

- [ ] **Export output ▸ R Data**
      Recipe: same, choosing R Data. Then `load("file.RData")` in desktop R.
      Expect: the objects load and are inspectable.

- [ ] **Print / Save PDF**
      Recipe: the print action, by hand.
      Expect: sane page breaks; tables not cut mid-row. *(Do this manually — never under
      automation; a print preview blocks the tab's JS thread.)*

- [ ] **Chart editing after the fact**
      Recipe: run **Graphs ▸ Bar chart…** on `education`. In the Output pane open the
      chart's control panel and change the title, the axis titles, the legend, the
      palette and the size. Then **reload the page**.
      Expect: every edit survives. Charts are **models the host renders**, not baked
      images, so they stay editable — including after save and reload.

- [ ] **R-baked figures**
      Recipe: run something that returns an SVG from R — **Multivariate ▸ Diversity &
      ordination…**, **Multivariate ▸ Network analysis…**, **Spatial ▸ …**,
      **Time Series ▸ Decomposition…** or **Vector autoregression…**. Then open its
      controls.
      Expect: the R SVG sits as a graphic layer **under** host-drawn title and legend,
      which stay editable; and a **"Recompute the figure"** group re-runs R with new
      parameters. *(#131/#201)*

- [ ] **Colour scale**
      Recipe: produce a chart with a continuous scale (e.g. **Spatial ▸ Choropleth map…**
      on the spatial demo).
      Expect: a **classed colour bar** in the legend layer, with readable breaks.

- [ ] **Chart export size**
      Recipe: export a chart, choosing a specific width/height.
      Expect: the written SVG/PNG honours the size you asked for.

## 9. Collaboration

- [ ] **Invite a second machine**
      Recipe: on machine A, **File ▸ Copy invite link…**. Open that link on machine B.
      Expect: both see the same project; presence shows two people.

- [ ] **Concurrent edits across the three tiers**
      Recipe: simultaneously — edit a **data** value on A; add a **code to the codebook**
      on B; move a **spatial layer** on both.
      Expect: data merges three-way through the op log; the codebook is **add-wins** (both
      codes survive); spatial state is **last-writer-wins**. Each tier's rule is declared
      by its owner and they are deliberately different.

- [ ] **Conflict UI**
      Recipe: go offline on B, change the same cell on both, bring B back online.
      Expect: a readable conflict presentation. A silent clobber is the failure.

- [ ] **Per-user state**
      Recipe: on both machines, select different variables and put the cursor in
      different cells.
      Expect: selections and cursors do **not** fight — that state is keyed by author.

- [ ] **TURN relay**
      Recipe: configure a TURN server (§3), then connect two peers that cannot reach each
      other directly (e.g. different networks).
      Expect: they still connect, via the relay.

- [ ] **Sharing settings**
      Recipe: **File ▸ Sharing…** and change what is shared.
      Expect: the change takes effect and is legible — you can tell what the other side
      can see.

## 10. Encryption at rest

- [ ] **Protect exports**
      Recipe: **File ▸ Encryption settings…** → turn on protection for exports → set a
      passphrase → **File ▸ Export data…** (or export the project). Try to open the file.
      Expect: it needs the passphrase.

- [ ] **Protect a locally stored project (OPFS)**
      Recipe: **File ▸ Encryption settings…** → opt in for local storage → set a
      per-project passphrase → close the project → reload.
      Expect: the project **catalog is still readable** (you can see your project list)
      while the project *content* is not until you unlock it.

- [ ] **Protect, unprotect, change the passphrase**
      Recipe: do all three from **File ▸ Encryption settings…**, reloading between.
      Expect: all three work; changing the passphrase **re-wraps the key** rather than
      re-encrypting everything (so it is fast even on a large project).

- [ ] **Closed is protected; live is not**
      Recipe: unlock a protected project, leave the tab open, and read what the UI says
      about what is protected.
      Expect: it says plainly that this protects **closed** projects — an open session in
      an open tab is not protected. The thing to check is that it does not **overclaim**.

- [ ] **A wrong passphrase**
      Recipe: try to open a protected project with the wrong passphrase, three times.
      Expect: a clear refusal each time, and **no data loss** — the project still opens
      with the right one afterwards.

## 11. Offline and air-gap

- [ ] **"Make available offline"**
      Recipe: find the offline toggle, select some plugins, turn it on, and let it finish.
      Expect: progress through the asset groups, **including an R package closure
      prefetch** for the plugins you selected.

- [ ] **Airplane mode**
      Recipe: with the above complete, turn off networking, reload the page, run an
      analysis you ran before.
      Expect: it runs. The app shell, WebR and the R packages all come from cache.

- [ ] **Transcription offline**
      Recipe: **first clear the `transformers-cache`** in DevTools ▸ Application ▸ Cache
      Storage. Then with offline caching on, go into airplane mode, import an audio file
      and transcribe it.
      Expect: it works — the transformers.js library, the onnxruntime WASM **and the model
      weights** are all cached.
      ⚠️ Clearing that cache first is not optional: it will happily serve a model you
      thought you had deleted, which makes a negative control read as a pass.

- [ ] **An air-gapped deployment**
      Recipe: `node scripts/vendor-assets.mjs`, then serve with `assets: local` in
      `deploy.json`. Open DevTools ▸ Network, filter to anything not on your origin, and
      use the app properly — import, analyse, chart.
      Expect: **zero off-origin requests**. See `docs/OFFLINE.md`.

- [ ] **PWA install**
      Recipe: install the app to the desktop or home screen from the browser's install
      prompt, then launch from the icon.
      Expect: it opens full-screen with no browser chrome, and works.

## 12. Help and how-to

- [ ] **How to…**
      Recipe: **Help ▸ How to…**, search for "frequency", open a topic.
      Expect: a searchable index (92 topics) and the topic's prose renders.

- [ ] **A dialog's ⓘ**
      Recipe: open **Descriptive Statistics ▸ Frequencies…** and click the **ⓘ**.
      Expect: the topic for *that menu item* ("Make a frequency table"), not a generic
      page. An item with no topic of its own falls back to the plugin's entry page.

- [ ] **Syntax guide…**
      Recipe: **Help ▸ Syntax guide…** Note the list of `run id.fn` calls. Deactivate a
      plugin, reopen the guide.
      Expect: the grammar, plus a **live** call list that reflects the plugins you
      actually have activated — the deactivated one is gone.

- [ ] **The remaining Help items**
      Recipe: open **Getting around…**, **Caveats & limits…**, **Report a bug…**,
      **Ask a question (Discussions)…** and **Source code…** in turn.
      Expect: each opens correctly; the last three reach the right GitHub destinations.

- [ ] **A third-party plugin's how-to**
      Recipe: add a plugin from file that ships `howtoFile` + `howtoIndex`, then
      **Help ▸ How to…** and search for its topic.
      Expect: it appears with **exactly the same placement, search and rendering** as a
      builtin's. There is deliberately nothing privileged about core here.

## 13. Accessibility and small screens

- [ ] **Keyboard only**
      Recipe: put the mouse down. Tab through the menu bar, open a menu with Enter and
      arrow through it, open an analysis dialog, move between its inputs, run it, and
      close the dialog with Escape. Then Tab into the Data grid and move around.
      Expect: everything reachable; **focus always visible**; Escape closes dialogs; no
      keyboard trap.

- [ ] **Contrast**
      Recipe: run an automated contrast check (DevTools ▸ Lighthouse, or axe).
      Expect: **0 failures.** This passed a measured sweep, so treat any new failure as a
      regression rather than a known issue.

- [ ] **Reflow at 320px (WCAG 1.4.10)**
      Recipe: DevTools ▸ device toolbar → set the width to **320px** → use the app.
      Expect: **no horizontal page scrolling**; small-screen mode gives full command
      parity (53 of 53).
      ⚠️ **One known leak:** `.ct-edit` carries a `min-width: 380px` that breaks dialog
      layout below about **404px**. Expected until fixed — do not re-file it.

- [ ] **Screen reader**
      Recipe: turn on NVDA or Narrator. Read a results table, then open an analysis
      dialog and move through its inputs.
      Expect: the table's structure is announced (headers with cells, not a flat run of
      numbers); every input has a name and its state.

- [ ] **Small screen mode on a large window**
      Recipe: **Edit ▸ ☐ Small screen mode** on a maximised window. Then try to reach
      every command you would normally use.
      Expect: all of them are reachable — the mode is user-owned, so it must not be a
      degraded experience you cannot work in.

---

## 14. Descriptive Statistics *(6 items)*

- [ ] **Frequencies…** — `Descriptive Statistics ▸ Frequencies…`
      Recipe: `vars = gender, education, region`. Leave Statistics empty.
      Expect, exactly: `gender` 15 / 15 (50.0 / 50.0 %); `education` 8 / 12 / 10
      (26.7 / 40.0 / 33.3); `region` 11 / 10 / 9 (36.7 / 33.3 / 30.0). Value labels
      shown (Male/Female, High school/Bachelor/Postgraduate, North/Central/South),
      cumulative percent reaching 100.0.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Frequencies… → move
      `gender`, `education` and `region` into **Variable(s)** → leave **Display
      frequency tables** ticked → **OK**.
      Syntax: `FREQUENCIES VARIABLES=gender education region.`

- [ ] **Frequencies ▸ Statistics panel** — same dialog, second page.
      Recipe: `vars = age`; tick Mean, Median, Mode, Sum, Std. Deviation, Variance,
      Std. Error of Mean, Range, Minimum, Maximum, Quartiles.
      Expect, exactly: N = 30, Mean = **41.0000**, Median = **39.5**, Sum = **1230**,
      SD = **10.8881**, Variance = **118.5517**, SE = **1.9879**, Range = **36**,
      Min = **25**, Max = **61**. Quartiles **31.75 / 39.5 / 50.5**.
      ⚠️ Two traps worth knowing: **every one of the 30 ages is unique**, so there is no
      modal value — SPSS prints the *smallest* value (25) with a "multiple modes exist"
      footnote, and anything else (blank, an error, a list of 30) is worth a finding.
      And the quartiles above are SPSS's definition (R's `type = 6`); R's *default*
      `type = 7` gives **32.25 / 39.5 / 49.75** instead. If you see those, the plugin is
      using R's default rather than SPSS's.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Frequencies… → `age`
      into **Variable(s)** → the **Statistics…** button → tick Mean, Median, Mode, Sum,
      Std. deviation, Variance, S.E. mean, Range, Minimum, Maximum and **Quartiles** →
      **Continue** → **OK**.
      Syntax: `FREQUENCIES VARIABLES=age /STATISTICS=ALL.`

- [ ] **Frequencies, weighted** — same dialog, `weight` input.
      Recipe: `vars = education`, `weight =` any positive numeric variable.
      Expect: counts become weighted case counts (N = sum of weights, non-integer is
      fine); **the caption names the weight**; cases with missing/zero/negative weight
      are dropped entirely, not counted as fractions.
      Reference: **SPSS** — first **Data ▸ Weight Cases…** → *Weight cases by* → your
      weight variable → **OK** (a WEIGHT indicator appears in the status bar). Then run
      Analyze ▸ Descriptive Statistics ▸ Frequencies… as above.
      Syntax: `WEIGHT BY w.` then `FREQUENCIES VARIABLES=education.`

- [ ] **Crosstabs…** — `Descriptive Statistics ▸ Crosstabs…`
      Recipe: `rowvar = gender`, `colvar = education`, percentages = row, measures =
      chi-square + Cramér's V.
      Expect, exactly: counts row 1 (Male) **7 / 6 / 2**, row 2 (Female) **1 / 6 / 8**.
      Expected counts **4 / 6 / 5** in both rows. Pearson χ² = **8.1000**, df = **2**,
      p = **.0174**. Cramér's V = **.5196**. Likelihood-ratio χ² = **8.9169**, p = **.0116**.
      A warning that some expected counts are < 5 is correct and should be shown.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Crosstabs… → `gender`
      into **Row(s)**, `education` into **Column(s)** → **Statistics…** → tick
      **Chi-square** and **Phi and Cramer’s V** → **Continue** → **Cells…** → tick
      **Observed**, **Expected**, **Row** and **Column** → **Continue** → **OK**.
      Syntax: `CROSSTABS /TABLES=gender BY education /STATISTICS=CHISQ PHI
      /CELLS=COUNT EXPECTED ROW COLUMN.`

- [ ] **Crosstabs 2×2 and the continuity correction** — the case where SPSS adds a row.
      Recipe: first `Transform ▸ Recode` education into `hs` (1 → 1, else 2). Then
      Crosstabs `gender × hs`.
      Expect, exactly: counts **7 / 8** and **1 / 14**. Uncorrected χ² = **6.1364**,
      p = **.0132**; **Yates continuity-corrected χ² = 4.2614, p = .0390**; Fisher's
      exact p = **.0352**, OR = **11.2622**. For a 2×2 SPSS prints the corrected row too
      — if CrossTab reports only the uncorrected value on a 2×2 that is a real gap.
      Reference: **SPSS** — make the 2×2 first with **Transform ▸ Recode into Different
      Variables…** (`education` → `hs`: Old value 1 → New 1; All other values → 2 →
      **Add** → **Change** → **OK**). Then the same Crosstabs dialog with `gender` × `hs`.
      Expect too: for a 2×2 SPSS adds the **Continuity Correction** and **Fisher’s Exact
      Test** rows to the same table with no extra ticking — that is what you compare.
      Syntax: `CROSSTABS /TABLES=gender BY hs /STATISTICS=CHISQ.`

- [ ] **Descriptives…** — `Descriptive Statistics ▸ Descriptives…`
      Recipe: `vars = age, income`.
      Expect, exactly: `age` N = **30**, min **25**, max **61**, mean **41.0000**,
      SD **10.8881**. `income` **N = 28** (not 30 — the two −99s), min **24000**,
      max **66200**, mean **45292.8571**, SD **12432.9886**.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Descriptives… → `age`
      and `income` into **Variable(s)** → **Options…** → tick Mean, Std. deviation,
      Minimum, Maximum → **Continue** → **OK**.
      Syntax: `DESCRIPTIVES VARIABLES=age income /STATISTICS=MEAN STDDEV MIN MAX.`

- [ ] **Explore (confidence interval for the mean)…** — same menu.
      Recipe: `vars = age, income`, `level = 95`.
      Expect, exactly: `age` mean 41.0000, 95% CI **[36.9343, 45.0657]**;
      `income` mean 45292.8571, 95% CI **[40471.8474, 50113.8668]**.
      Then add `by = gender` and expect the same statistics per group.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Explore… → `age` and
      `income` into **Dependent List** (and `gender` into **Factor List** for the
      by-group version) → under *Display* choose **Statistics** → **Statistics…** → tick
      **Descriptives** with *Confidence Interval for Mean* **95%** → **Continue** → **OK**.
      Read the **Descriptives** table: the CI is the "95% Confidence Interval for Mean"
      Lower/Upper Bound rows.
      Syntax: `EXAMINE VARIABLES=age income /PLOT NONE /STATISTICS DESCRIPTIVES
      /CINTERVAL 95.`

- [ ] **Inequality (Gini / Theil / Lorenz)…** — `Descriptive Statistics ▸ …`
      Recipe: `x = income`.
      Expect: Gini between 0 and 1 (for this data ≈ 0.15 — a low, plausible figure),
      Theil ≥ 0, and a Lorenz curve that starts at (0,0), ends at (1,1) and bows below
      the diagonal.
      Reference: **no SPSS equivalent.** **Stata** — `ssc install ineqdeco` once, then
      `ineqdeco income`. **R** — `ineq::Gini(income)` and `ineq::Theil(income)`.
      For the Lorenz curve: Stata `lorenz estimate income` then `lorenz graph`.

- [ ] **Segregation indices…** — same menu.
      Recipe: `groupA` and `groupB` as two count variables by area.
      Expect: dissimilarity index in [0,1]; identical distributions → 0.
      Reference: **no mainstream GUI.** **R** — the `seg` package. Or by hand, which is
      easy enough to be the better check here: the dissimilarity index is
      `0.5 * sum(|a_i/A - b_i/B|)` across areas — do it in a spreadsheet and compare.

## 15. Comparison *(6 items)*

- [ ] **One-sample t-test…** — `Comparison ▸ One-sample t-test…`
      Recipe: `x = age`, `mu = 40`.
      Expect, exactly: t = **0.5030**, df = **29**, p = **.6187**, mean = 41.0000,
      mean difference = 1.0000, 95% CI of the mean **[36.9343, 45.0657]**.
      ⚠️ SPSS reports the CI **of the difference** — `[−3.0657, 5.0657]` — not of the
      mean. Both are right; make sure the label matches what is shown.
      Reference: **SPSS** — Analyze ▸ Compare Means ▸ One-Sample T Test… → `age` into
      **Test Variable(s)** → set **Test Value** to `40` → **OK**.
      Expect too: SPSS reports the CI **of the difference** — `[−3.0657, 5.0657]` — not of
      the mean. Both are right; just read the column heading before calling a mismatch.
      Syntax: `T-TEST /TESTVAL=40 /VARIABLES=age.`

- [ ] **Independent-samples t-test…** — same menu.
      Recipe: `y = income`, `g = gender`, `g1 = Male`, `g2 = Female`.
      Expect, exactly: Male n = **14**, mean **39085.7143**, SD **10427.0991**;
      Female n = **14**, mean **51500.0000**, SD **11372.7745**.
      Equal variances: t = **−3.0105**, df = **26**, p = **.0057**,
      CI **[−20890.597, −3937.974]**. Welch: t = **−3.0105**, df = **25.8065**,
      p = **.0058**, CI **[−20893.692, −3934.880]**.
      Levene's test: F = **0.5785**, p = **.4537**.
      ⚠️ That Levene figure is **mean-centred**, which is what SPSS does. R's
      `car::leveneTest` defaults to **median**-centred and will give a different number.
      If CrossTab disagrees with SPSS here, check the centring before filing.
      Reference: **SPSS** — Analyze ▸ Compare Means ▸ Independent-Samples T Test… →
      `income` into **Test Variable(s)**, `gender` into **Grouping Variable** →
      **Define Groups…** → Group 1 = `1`, Group 2 = `2` → **Continue** → **OK**.
      Expect too: **Levene’s test appears automatically** in the left of the output
      table, and SPSS prints both the "Equal variances assumed" and "not assumed" rows —
      no extra ticking needed.
      Syntax: `T-TEST GROUPS=gender(1 2) /VARIABLES=income.`

- [ ] **Paired-samples t-test…** — same menu.
      Recipe: needs two commensurate variables — `Transform ▸ Compute` an
      `age_plus = age + 2`, then pair `age` with `age_plus`.
      Expect: mean difference exactly **−2.0000**, SD of differences **0**, and a
      graceful refusal or an infinite/undefined t rather than a crash (zero variance is
      the edge case worth checking). Then try a noisier computed pair for a real t.
      Reference: **SPSS** — Analyze ▸ Compare Means ▸ Paired-Samples T Test… → click
      the two variables so they land as **Variable1** and **Variable2** of Pair 1 → **OK**.
      Syntax: `T-TEST PAIRS=age WITH age_plus (PAIRED).`

- [ ] **One-way ANOVA…** — same menu.
      Recipe: `y = income`, `g = education`.
      Expect, exactly: between df **2**, SS ≈ **3.852 × 10⁹**, MS ≈ **1.926 × 10⁹**;
      within df **25**, SS ≈ **3.220 × 10⁸**, MS ≈ **1.288 × 10⁷**;
      **F = 149.5**, p = **1.24 × 10⁻¹⁴**. Group means **30350.00 / 43836.36 / 60355.56**.
      Levene's (mean-centred) F = **0.0519**, p = **.9495**.
      Also check: post-hoc comparisons if offered, and that N = 28.
      Reference: **SPSS** — Analyze ▸ Compare Means ▸ One-Way ANOVA… → `income` into
      **Dependent List**, `education` into **Factor** → **Options…** → tick
      **Descriptive** and **Homogeneity of variance test** → **Continue** →
      **Post Hoc…** → tick **Tukey** → **Continue** → **OK**.
      Syntax: `ONEWAY income BY education /STATISTICS DESCRIPTIVES HOMOGENEITY
      /POSTHOC=TUKEY ALPHA(0.05).`

- [ ] **Factorial ANOVA…** — `Comparison ▸ Factorial ANOVA…`
      Recipe: `dv = income`, `facs = gender, education`.
      Expect: main effects for both plus the interaction; **Type III sums of squares**
      (SPSS's default); R² and adjusted R². Unbalanced cells here, so SS type genuinely
      matters.
      ⚠️ R's `aov()` gives **Type I** (sequential) SS, which will *not* match SPSS on
      unbalanced data. This plugin is already validated for Type III against desktop R
      (`scripts/validation/factorial-type3.R`) — so if it disagrees with SPSS, suspect
      the comparison, not the plugin.
      Reference: **SPSS** — Analyze ▸ General Linear Model ▸ Univariate… → `income` into
      **Dependent Variable**, `gender` and `education` into **Fixed Factor(s)** →
      **Model…** → leave **Full factorial** and **Type III** (both defaults) →
      **Continue** → **Options…** → tick **Descriptive statistics** → **Continue** → **OK**.
      Syntax: `UNIANOVA income BY gender education /DESIGN=gender education
      gender*education.`

- [ ] **Repeated-measures ANOVA…** — same menu.
      Recipe: compute three related variables (e.g. `t1 = age`, `t2 = age + 3`,
      `t3 = age + 7` with some noise), then `vars = t1, t2, t3`.
      Expect: within-subjects effect; **Mauchly's test of sphericity**; and the
      Greenhouse–Geisser and Huynh–Feldt corrected rows. Already validated against
      desktop R (`scripts/validation/sphericity-reference.R`).
      Reference: **SPSS** — Analyze ▸ General Linear Model ▸ Repeated Measures… →
      **Within-Subject Factor Name** = `time`, **Number of Levels** = `3` → **Add** →
      **Define** → move `t1`, `t2`, `t3` into the three slots → **OK**.
      Expect too: **Mauchly’s Test of Sphericity** and the Greenhouse–Geisser /
      Huynh–Feldt rows are printed automatically.
      Syntax: `GLM t1 t2 t3 /WSFACTOR=time 3 /PRINT=ETASQ.`

## 16. Compare Means *(2 items)*

- [ ] **ANCOVA…** — `Compare Means ▸ ANCOVA…`
      Recipe: `y = income`, `factors = education`, `covs = age`.
      Expect: the covariate row, the adjusted factor effect, and **estimated marginal
      means** adjusted for `age`. Compare the unadjusted means (§15's 30350 / 43836 /
      60356) with the adjusted ones — they should differ, since age correlates with
      income at r = .95.
      Reference: **SPSS** — Analyze ▸ General Linear Model ▸ Univariate… → `income` into
      **Dependent Variable**, `education` into **Fixed Factor(s)**, `age` into
      **Covariate(s)** → **Options…** → move `education` into **Display Means for** →
      **Continue** → **OK**. The adjusted means are the **Estimated Marginal Means** table.
      Syntax: `UNIANOVA income BY education WITH age
      /EMMEANS=TABLES(education) WITH(age=MEAN) /DESIGN=age education.`

- [ ] **Repeated-measures / mixed ANOVA…** — same menu.
      Recipe: `within = t1, t2, t3` (from §15), `between = gender`.
      Expect: within effect, between effect, and the within × between interaction;
      sphericity corrections present.
      Reference: **SPSS** — Analyze ▸ General Linear Model ▸ Repeated Measures… set up as
      in §15, then additionally move `gender` into **Between-Subjects Factor(s)** → **OK**.
      Read the *Tests of Within-Subjects Effects* table for `time` and `time*gender`.
      Syntax: `GLM t1 t2 t3 BY gender /WSFACTOR=time 3.`

## 17. Correlation *(2 items)*

- [ ] **Bivariate…** — `Correlation ▸ Bivariate…`
      Recipe: `vars = age, income`, method = Pearson.
      Expect, exactly: r = **.9515**, p < .0001, **n = 28**, 95% CI **[.8968, .9776]**.
      Then method = Spearman → rho = **.9458**; Kendall → tau-b = **.8170**.
      ⚠️ Kendall has three variants (tau-a, tau-b, tau-c). The figure above is **tau-b**
      (tie-corrected), which is also what SPSS reports. A noticeably different value may
      just be a different variant.
      Reference: **SPSS** — Analyze ▸ Correlate ▸ Bivariate… → `age` and `income` into
      **Variables** → tick **Pearson** (then re-run ticking **Spearman**, then
      **Kendall’s tau-b**) → **OK**. For the Pearson CI you need SPSS 27+:
      **Confidence interval** ▸ tick *Estimate confidence interval* in the same dialog.
      Syntax: `CORRELATIONS /VARIABLES=age income.` and
      `NONPAR CORR /VARIABLES=age income /PRINT=BOTH.`

- [ ] **Partial / part correlation…** — same menu.
      Recipe: `vars = age, income`, `controls = education`, type = partial.
      Expect: a partial r **smaller** than .9515 (education explains part of the
      association), df = n − 2 − (number of controls) = 25.
      Then switch to **part (semi-partial)** and confirm the value changes — the two are
      different statistics and must not return the same number.
      Reference: **SPSS** — Analyze ▸ Correlate ▸ Partial… → `age` and `income` into
      **Variables**, `education` into **Controlling for** → **Options…** → tick
      **Zero-order correlations** (so you can see both at once) → **Continue** → **OK**.
      Expect too: SPSS’s PARTIAL CORR does **not** do part (semi-partial) correlations.
      For those use Analyze ▸ Regression ▸ Linear… ▸ **Statistics…** ▸ tick
      **Part and partial correlations** — they appear in the Coefficients table.
      Syntax: `PARTIAL CORR /VARIABLES=age income BY education /SIGNIFICANCE=TWOTAIL.`

## 18. Regression *(21 items)*

- [ ] **Linear…** — `Regression ▸ Linear…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect, exactly: intercept **6959.8** (SE 2699.8, t = 2.578, p = .0162);
      `age` **514.7** (SE 145.6, t = 3.535, p = .0016); `education` **8563.7**
      (SE 1971.0, t = 4.345, p = .0002). Residual SE **3000** on **25** df.
      R² = **.9461**, adjusted R² = **.9418**, F(2, 25) = **219.4**, p < .0001.
      Reference: **SPSS** — Analyze ▸ Regression ▸ Linear… → `income` into
      **Dependent**, `age` and `education` into **Independent(s)**, Method = **Enter** →
      **Statistics…** → tick **Estimates**, **Confidence intervals**, **Model fit** and
      **Collinearity diagnostics** → **Continue** → **OK**.
      Syntax: `REGRESSION /STATISTICS COEFF OUTS CI(95) R ANOVA COLLIN
      /DEPENDENT income /METHOD=ENTER age education.`

- [ ] **Binary Logistic…** — `Regression ▸ Binary Logistic…`
      Recipe: `dv = gender`, `modelled = Female`, `ivs = age, income`.
      Expect, exactly: intercept **−4.974** (SE 2.057, z = −2.418, p = .0156);
      `age` **0.09661** (SE 0.1428, p = .4988); `income` **2.412 × 10⁻⁵**
      (SE 1.195 × 10⁻⁴, p = .8400). Odds ratios **1.1014** and **1.0000**.
      −2LL = **30.391**, null deviance **38.816**, AIC **36.391**, **n = 28**.
      ⚠️ **Which level is modelled is the whole result.** Switch `modelled` to Male and
      every coefficient must flip sign. This plugin is validated against desktop R
      (`scripts/validation/logistic-reference.R`), and a sibling bug in the 2×2 epi
      table (labels backwards for non-0/1 coding) was a real defect — so test the
      level choice deliberately.
      Also check: `cats` + `ref` (categorical predictors with a chosen reference
      category), and the `opts` extras.
      Reference: **SPSS** — Analyze ▸ Regression ▸ Binary Logistic… → `gender` into
      **Dependent**, `age` and `income` into **Covariates** → **Options…** → tick
      **CI for exp(B) 95%** → **Continue** → **OK**. For a categorical predictor use
      **Categorical…** → move it across → set **Reference Category** to First or Last →
      **Change** → **Continue**.
      ⚠️ SPSS models the **higher** code of the dependent (so Female = 2 here, matching
      the numbers above). It gives you no choice in the dialog — to model the other
      level you must recode. CrossTab asks you outright, so make sure the two agree
      before comparing signs.
      Syntax: `LOGISTIC REGRESSION VARIABLES gender WITH age income /PRINT=CI(95).`

- [ ] **Ordinal logistic regression…** — `Regression ▸ …`
      Recipe: `dv = education` (ordered), `ivs = age, income`.
      Expect: threshold/intercept terms (k − 1 = 2 of them) plus one slope per
      predictor; a proportional-odds assumption note.
      Reference: **SPSS** — Analyze ▸ Regression ▸ Ordinal… → `education` into
      **Dependent**, `age` and `income` into **Covariate(s)** → **Output…** → tick
      **Parameter estimates** and **Test of parallel lines** → **Continue** → **OK**.
      ⚠️ SPSS PLUM prints `location` coefficients with the **opposite sign convention**
      to R’s `MASS::polr`. A uniform sign flip across every predictor is expected; a
      flip on only some of them is not.
      Syntax: `PLUM education WITH age income /LINK=LOGIT /PRINT=PARAMETER TPARALLEL.`

- [ ] **Multinomial logistic regression…** — same menu.
      Recipe: `dv = region`, `base = North`, `ivs = age, income`.
      Expect: two contrasts (Central vs North, South vs North), each with its own
      coefficients; changing `base` re-expresses them.
      Reference: **SPSS** — Analyze ▸ Regression ▸ Multinomial Logistic… → `region` into
      **Dependent** → click **Reference Category…** → choose **First Category** (to match
      `base = North`) → **Continue** → `age` and `income` into **Covariate(s)** → **OK**.
      Syntax: `NOMREG region (BASE=FIRST ORDER=ASCENDING) WITH age income
      /PRINT=PARAMETER.`

- [ ] **Poisson regression…** — `Regression ▸ …`
      Recipe: `dv = household_size` (spatial demo), `ivs = income_k, commute_min`.
      Expect: log-link coefficients, IRRs if offered, deviance and AIC.
      Reference: **SPSS** — Analyze ▸ Generalized Linear Models ▸ Generalized Linear
      Models… → on the **Type of Model** tab pick **Poisson loglinear** → **Response**
      tab: `household_size` as Dependent Variable → **Predictors** tab: the numeric
      predictors into **Covariates** → **Model** tab: move them in as **Main effects** →
      **Statistics** tab: tick **Include exponential parameter estimates** for IRRs →
      **OK**.
      Syntax: `GENLIN household_size WITH income_k commute_min
      /MODEL income_k commute_min DISTRIBUTION=POISSON LINK=LOG.`

- [ ] **Negative binomial regression…** — same menu.
      Recipe: same variables.
      Expect: an extra **dispersion/theta** parameter, and an AIC that should *beat*
      Poisson's when the data are overdispersed (here they may not be — equal fit is a
      legitimate result).
      Reference: **SPSS** — Analyze ▸ **Generalized Linear Models** ▸ **Generalized
      Linear Models…** → **Type of Model** tab: pick **Negative binomial** and set its
      parameter to **Estimate value** (not the default fixed 1) so the dispersion is
      fitted → **Response** tab: `household_size` as Dependent → **Predictors** tab: the
      numeric predictors into **Covariates** → **Model** tab: move them in as main
      effects → **OK**.
      **Stata** — `nbreg household_size income_k commute_min`.
      Syntax: `GENLIN household_size WITH income_k commute_min
      /MODEL income_k commute_min DISTRIBUTION=NEGBIN(MLE) LINK=LOG.`
      Syntax: `GENLIN household_size WITH income_k commute_min
      /MODEL income_k commute_min DISTRIBUTION=NEGBIN(MLE) LINK=LOG.`
      **Stata** — `nbreg household_size income_k commute_min`.

- [ ] **Cluster-robust regression…** — `Regression ▸ …`
      Recipe: `y = income_k`, `ivs = satisfaction, commute_min`, `cluster = district`
      (spatial demo).
      Expect: **coefficients identical to OLS**, standard errors different. That is the
      sharpest check available — if the point estimates move, something is wrong.
      Reference: **Stata is the clean comparator** — `regress income_k satisfaction
      commute_min, vce(cluster district)`. SPSS has no cluster-robust option on
      Analyze ▸ Regression ▸ Linear; the nearest is Analyze ▸ Generalized Estimating
      Equations with `district` as the subject variable, which is a **different
      estimator** and will not match. **R** —
      `lmtest::coeftest(m, vcov = sandwich::vcovCL(m, cluster = ~district))`.

- [ ] **Robust (HC) regression…** — `Econometrics ▸ Robust (HC) regression…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect: same coefficients as §18's Linear (**6959.8 / 514.7 / 8563.7**), different
      SEs. Note which HC variant (HC0–HC3) is used.
      Reference: **SPSS 27 and later** — Analyze ▸ Regression ▸ Linear… → the
      **Bootstrap/Robust** options (the `/ROBUST` subcommand). If your version does not
      offer it, use **Stata** — `regress income age education, robust` (that is HC1).
      **R** — `lmtest::coeftest(m, vcov = sandwich::vcovHC(m, type = "HC1"))`.
      ⚠️ HC0, HC1, HC2 and HC3 give different standard errors on n = 28. Note which
      variant CrossTab reports before comparing — Stata’s `robust` is HC1, R’s
      `vcovHC` default is HC3.

- [ ] **Quantile regression…** — `Regression ▸ Quantile regression…`
      Recipe: `y = income`, `ivs = age, education`, `taus = 0.25, 0.5, 0.75`.
      Expect: three sets of coefficients; the median (τ = .5) set should sit near the
      OLS estimates but not equal them.
      Reference: **no SPSS equivalent.** **Stata** — `qreg income age education,
      quantile(.25)` and again for `.5` and `.75`. **R** —
      `quantreg::rq(income ~ age + education, tau = c(.25, .5, .75))` (the package this
      wraps, so extract the generated R and compare directly).

- [ ] **Tobit (censored) regression…** — same menu.
      Recipe: `y = income`, `ivs = age, education`, `left = 30000`.
      Expect: coefficients larger in magnitude than OLS (censoring attenuates OLS), plus
      a sigma estimate.
      Reference: **no SPSS equivalent.** **Stata** — `tobit income age education,
      ll(30000)`. **R** — `AER::tobit(income ~ age + education, left = 30000)`.

- [ ] **Heckman selection model…** — same menu.
      Recipe: `y = income`, `outIv = age`, `sel =` a binary selection variable,
      `selIv = education`.
      Expect: the outcome equation, the selection equation, and **rho / lambda** (the
      inverse Mills ratio term).
      Reference: **no SPSS equivalent.** **Stata** — `heckman income age, select(sel =
      education)` for the ML version, or add `, twostep` for the two-step. **R** —
      `sampleSelection::heckit`. ⚠️ ML and two-step give different standard errors;
      check which CrossTab ran.

- [ ] **Multiple imputation regression…** — `Regression ▸ …`
      Recipe: `y = income` (it has 2 missing), `ivs = age, education`, `m = 5`.
      Expect: pooled estimates with **Rubin's rules** — SEs larger than complete-case,
      plus fraction-of-missing-information or similar diagnostics. Re-running with the
      same `m` should be reproducible (check whether a seed is exposed; if the numbers
      wander between runs with no seed, that is a finding).
      Reference: **SPSS** (Missing Values module) — Analyze ▸ Multiple Imputation ▸
      **Impute Missing Data Values…** → variables into **Variables in Model** →
      **Imputations** = 5 → choose a **New Dataset** for the output → **OK**. Then run
      Analyze ▸ Regression ▸ Linear on that dataset: SPSS splits by `Imputation_` and
      adds a **Pooled** row automatically, which is the row to compare.
      **Stata** — `mi set wide; mi register imputed income; mi impute chained`
      `(regress) income = age education, add(5); mi estimate: regress income age education`.

- [ ] **Marginal effects (AME / MEM)…** — `Regression ▸ …`
      Recipe: `dv = gender`, `yes = Female`, `ivs = age, income`, family = binomial,
      kind = AME; then kind = MEM.
      Expect: AME ≠ MEM (average of the marginal effects vs the effect at the means);
      both on the probability scale, so values roughly within ±1.
      Reference: **no SPSS equivalent for AME.** **Stata** is the standard here —
      `logit female age income` then `margins, dydx(*)` for the AME and
      `margins, dydx(*) atmeans` for the MEM. **R** — `marginaleffects::avg_slopes(m)`
      and `slopes(m, newdata = "mean")`. SPSS’s EMMEANS gives predicted *values*, not
      marginal effects — do not substitute it.

- [ ] **Mediation (X → M → Y)…** — `Regression ▸ …`
      Recipe: `x = education`, `m = age`, `y = income`, se = bootstrap.
      Expect: direct, indirect and total effects, with **total ≈ direct + indirect**
      (check that identity — it is a free arithmetic test), and a bootstrap CI for the
      indirect effect.
      Reference: **SPSS with the PROCESS macro** (Hayes, free from processmacro.org;
      install it once via Extensions ▸ Utilities ▸ Install Custom Dialog) — then
      Analyze ▸ Regression ▸ **PROCESS** → **Model number 4** → Y = `income`,
      X = `education`, M = `age` → Bootstrap samples = 5000 → **OK**.
      **R** — `lavaan` with an `ab := a*b` defined parameter. **Stata** — `sem` with
      `estat teffects`.

- [ ] **Moderation (X × W)…** — same menu.
      Recipe: `y = income`, `x = age`, `w = education`.
      Expect: the interaction term, and simple slopes / conditional effects at levels
      of `w`.
      Reference: **SPSS with PROCESS** — Analyze ▸ Regression ▸ **PROCESS** →
      **Model number 1** → Y = `income`, X = `age`, W = `education` → under *Options*
      tick **mean center** and **Johnson-Neyman** → **OK**.
      Without PROCESS: Transform ▸ Compute the product term yourself, then
      Analyze ▸ Regression ▸ Linear with `age`, `education` and `age_x_education`.

- [ ] **Difference-in-differences…** — `Regression ▸ …`
      Recipe: needs a treat and a post indicator — compute both, then `y = income`,
      `treat`, `treated` level, `post`, `after` level.
      Expect: the **interaction** coefficient is the DiD estimate; the two main effects
      are reported too.
      Reference: **Stata** — `didregress (income) (treat), group(treat) time(post)`,
      or the transparent version `regress income treat##post` where the
      **interaction coefficient is the DiD estimate**. SPSS: compute the interaction by
      hand and use Analyze ▸ Regression ▸ Linear, or
      Analyze ▸ General Linear Model ▸ Univariate with both as fixed factors.

- [ ] **Regression discontinuity…** — same menu.
      Recipe: `y = income`, `run = age`, `cutoff = 40`.
      Expect: a local estimate at the cutoff with a bandwidth reported; the bandwidth
      choice should be visible and changeable.
      Reference: **no SPSS equivalent.** **Stata / R** — `rdrobust`, the same package
      CrossTab wraps: `rdrobust(y, x, c = 40)` in R or `rdrobust y x, c(40)` in Stata.
      Because it is the same package, extract the generated R from
      **Edit ▸ History…** and expect an exact match, not an approximate one.

- [ ] **Matching (propensity / nearest neighbour)…** — same menu.
      Recipe: `y = income`, `treat`, `treated` level, `covs = age, education`.
      Expect: a balance table before/after matching, matched n, and the treatment
      effect. Covariate balance should **improve** after matching.
      Reference: **no SPSS equivalent** (the PS Matching extension exists but is a
      third-party R wrapper). **Stata** — `teffects psmatch (income) (treat age
      education)`, or `psmatch2 treat age education, outcome(income)`. **R** —
      `MatchIt::matchit(treat ~ age + education)` then `summary()` for the balance table
      — the package this wraps.

- [ ] **Linear mixed model…** — `Regression ▸ Linear mixed model…`
      Recipe: `y = income_k`, `fixed = satisfaction, commute_min`, `group = district`
      (spatial demo), then add `slope = commute_min`.
      Expect: fixed effects with SEs, random-effect variances, and an **ICC** between
      0 and 1. The random-slope version should report a slope variance and a
      correlation.
      Reference: **SPSS** — Analyze ▸ Mixed Models ▸ **Linear…** → in the first dialog
      move `district` into **Subjects** → **Continue** → `income_k` into **Dependent
      Variable**, the predictors into **Covariate(s)** → **Fixed…** → move them in as
      main effects → **Continue** → **Random…** → tick **Include intercept**, move
      `district` into **Combinations** → **Continue** → **Statistics…** → tick
      **Parameter estimates** and **Covariances of random effects** → **OK**.
      ⚠️ Compare the **estimates and variance components** first. SPSS defaults to
      Satterthwaite-style denominator df and `lmerTest` to its own approximation, so the
      p-values can differ slightly while the model is identical.
      Syntax: `MIXED income_k WITH satisfaction commute_min
      /FIXED=satisfaction commute_min /RANDOM=INTERCEPT | SUBJECT(district)
      /METHOD=REML /PRINT=SOLUTION.`

- [ ] **Logistic mixed model…** — same menu.
      Recipe: `y = gender`, `yes = Female`, `fixed = age`, `group = region`.
      Expect: log-odds fixed effects plus a group variance. With only 3 regions and
      30 cases expect a convergence warning — a *readable* warning is the pass
      condition, not silence and not a crash.
      Reference: **SPSS** — Analyze ▸ Mixed Models ▸ **Generalized Linear Mixed
      Models…** → **Data Structure** tab: drag `region` to **Subjects** → **Fields &
      Effects** tab: Target = `gender`, target distribution **Binary logistic** → add
      `age` as a fixed effect → add a random intercept for `region` → **Run**.
      **Stata** — `melogit female age || region:`. **R** —
      `lme4::glmer(female ~ age + (1 | region), family = binomial)`.

- [ ] **Meta-analysis…** — `Regression ▸ Meta-analysis…`
      Recipe: needs an effect-size column and a precision column — make a small
      dataset of 8 studies by hand (`yi` effect, `sei` standard error), then
      `yi`, `prec = sei`, precType = SE, model = random.
      Expect: pooled estimate with CI, **τ² / I² / Q** heterogeneity statistics, and a
      forest plot. Fixed-effect mode should give a *narrower* CI than random-effects.
      Reference: **SPSS 28 and later** added Analyze ▸ **Meta Analysis** ▸ Continuous
      Outcomes ▸ *Raw Means / Effect Sizes…*; if your version has no Meta Analysis menu,
      use one of: **Stata** — `meta set yi sei, random` then `meta summarize` and
      `meta forestplot`; **R** — `metafor::rma(yi, sei = sei)` (the package this wraps);
      or **RevMan** for the Cochrane presentation.
      Expect too: whichever you use, fixed-effect mode must give a **narrower** CI than
      random-effects on the same data — a free check that the model switch is wired.

- [ ] **Response surface (second-order)…** — `Regression ▸ …`
      Recipe: `y = income_k`, `factors = satisfaction, commute_min`.
      Expect: linear, quadratic and cross-product terms; a stationary-point analysis
      and eigenvalues saying whether it is a maximum, minimum or saddle.
      Reference: **no SPSS equivalent.** The field standards are **Minitab** (Stat ▸ DOE ▸
      Response Surface ▸ Analyze Response Surface Design) and **Design-Expert**. **R** —
      `rsm::rsm(y ~ SO(x1, x2))` then `summary()` for the stationary point and
      eigenvalues — the package this wraps.
## 19. Categorical *(6 items)*

- [ ] **Chi-square goodness-of-fit…** — `Categorical ▸ …`
      Recipe: `variable = region`, expected left blank (equal).
      Expect, exactly: observed **11 / 10 / 9**, χ² = **0.2000**, df = **2**,
      p = **.9048**. Then supply unequal expected proportions (e.g. `0.5, 0.3, 0.2`)
      and confirm the statistic changes and that the proportions are normalised.
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      Chi-square… → `region` into **Test Variable List** → leave *Expected Values* on
      **All categories equal** → **OK**. For unequal expectations choose **Values** and
      **Add** each one in category order.
      Syntax: `NPAR TESTS /CHISQUARE=region.` and `/EXPECTED=0.5 0.3 0.2`.

- [ ] **One-proportion test…** — same menu.
      Recipe: `variable = gender`, `category = Female`, `p0 = 0.5`.
      Expect, exactly: k = **15**, n = **30**, p = **1.0000** (exactly half, so the test
      cannot reject). Then try `p0 = 0.3` and expect a significant result.
      Note whether it reports the **exact binomial** or the normal approximation — both
      are defensible, but the label must match the method.
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      Binomial… → `gender` into **Test Variable List** → **Test Proportion** = `0.50` →
      **OK**. That gives the **exact** binomial p.
      Expect too: SPSS 27+ also has Analyze ▸ Compare Means and Proportions ▸
      **One-Sample Proportions…** for the normal-approximation version — a different
      p-value by design.
      Syntax: `NPAR TESTS /BINOMIAL(0.5)=gender.`

- [ ] **Two-proportion test…** — same menu.
      Recipe: `outcome = education` recoded to `hs` (see §14), `success = 2`,
      `groups = gender`, `g1 = Male`, `g2 = Female`.
      Expect: the two proportions (**8/15 = .5333** and **14/15 = .9333**), their
      difference, a CI for the difference, and a p-value consistent with §14's 2×2
      (χ² = 6.1364 uncorrected, p = .0132).
      Reference: **SPSS 27 and later** — Analyze ▸ Compare Means and Proportions ▸
      **Independent-Samples Proportions…** → `hs` as the test variable with its success
      level, `gender` as the grouping variable. On older versions go through
      Analyze ▸ Descriptive Statistics ▸ Crosstabs… ▸ **Statistics…** ▸ **Chi-square**,
      which gives the same test if not the same framing.
      **R** — `prop.test(c(8, 14), c(15, 15))`.

- [ ] **McNemar's test (paired)…** — same menu.
      Recipe: two binary variables measured on the same cases — compute
      `rich1 = income > 40000` and `rich2 = income > 45000`.
      Expect: the 2×2 agreement table, and the test driven **only by the discordant
      cells**. Check that reversing the two variables gives the same p (it must).
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      **2 Related Samples…** → click `rich1` then `rich2` so they pair up → **untick
      Wilcoxon** and **tick McNemar** → **OK**.
      Syntax: `NPAR TESTS /MCNEMAR=rich1 WITH rich2 (PAIRED).`

- [ ] **Log-linear model…** — same menu.
      Recipe: `vars = gender, education, region`, model = saturated, then independence.
      Expect: cell counts with fitted values, parameter estimates, and a
      goodness-of-fit (deviance/Pearson) that is **0 for the saturated model** — a
      useful free check.
      Reference: **SPSS** — Analyze ▸ **Loglinear** ▸ **General…** → the three variables
      into **Factor(s)** → **Model…** → **Saturated** for the saturated fit, or
      **Custom** with only main effects for independence → **Continue** → **Options…** →
      tick **Estimates** → **Continue** → **OK**. Analyze ▸ Loglinear ▸ **Model
      Selection…** does the hierarchical backward elimination instead.
      Syntax: `GENLOG gender education region /MODEL=POISSON
      /DESIGN gender education region.`

- [ ] **Risk / odds ratios (2×2)…** — `Categorical ▸ Risk / odds ratios (2×2)…`
      Recipe: `exposure = gender`, `exposed = Male`, `outcome = hs`, `case = 1`.
      Expect: the 2×2 laid out with the **exposed group as the first row and the case
      as the first column**, then risk in each group, risk ratio, risk difference, and
      odds ratio with CIs. For the §14 table the OR is **11.2622** (Fisher's conditional
      MLE) or 12.25 (the plain cross-product `7×14 / (8×1)`) — note which is reported.
      ⚠️ **Test the level choice deliberately.** This table was once labelled backwards
      for non-0/1 coded variables (#186) — swap `exposed` and `case` to the other levels
      and confirm the numbers move the way they should, rather than trusting the layout.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ Crosstabs… → exposure
      into **Row(s)**, outcome into **Column(s)** → **Statistics…** → tick **Risk** →
      **Continue** → **OK**. The "Risk Estimate" table gives the odds ratio and both
      relative risks with CIs.
      ⚠️ SPSS keys the table off the **first row and first column as they sort**, so the
      OR can come out inverted relative to CrossTab’s explicit `exposed`/`case` choice.
      If one reports 11.26 and the other 0.089, that is the same result read the other
      way round — check before filing.
      **Stata** — `cs outcome exposure` (cohort) or `cc outcome exposure` (case-control).
      Syntax: `CROSSTABS /TABLES=gender BY hs /STATISTICS=RISK.`

## 20. Nonparametric *(3 items)*

- [ ] **Mann-Whitney U (2 groups)…** — `Nonparametric ▸ …`
      Recipe: `y = income`, `g = gender`, `g1 = Male`, `g2 = Female`.
      Expect, exactly: U (R's W) = **43.5**, asymptotic p with continuity correction
      = **.0131**, exact p = **.0110**. Check which one is reported and labelled.
      ⚠️ SPSS prints U, Wilcoxon W, Z and both an asymptotic and (for small n) an exact
      p. Ties are present here, so the tie-corrected variance matters. This plugin has a
      validated ranking path (`scripts/validation/mannwhitney-subset-ranks.R`) — ranks
      must be computed on the **subset actually analysed**, not on all 30 cases.
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      **2 Independent Samples…** → `income` into **Test Variable List**, `gender` into
      **Grouping Variable** → **Define Groups…** → `1` and `2` → **Continue** → tick
      **Mann-Whitney U** → **Exact…** → choose **Exact** to get the exact p as well →
      **Continue** → **OK**.
      Expect too: SPSS prints **U**, **Wilcoxon W**, **Z** and an asymptotic p, plus the
      exact p if you asked. R’s `W = 43.5` is SPSS’s **U**.
      Syntax: `NPAR TESTS /M-W= income BY gender(1 2) /METHOD=EXACT.`

- [ ] **Wilcoxon signed-rank (paired)…** — same menu.
      Recipe: `x1 = age`, `x2 =` a computed `income/1000`.
      Expect, exactly: V = **12.5**, p < .0001.
      Then pair a variable with itself and expect a graceful "no non-zero differences"
      message rather than a crash.
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      **2 Related Samples…** → click the two variables so they pair → tick **Wilcoxon**
      (the default) → **OK**.
      Syntax: `NPAR TESTS /WILCOXON=age WITH income_k (PAIRED).`

- [ ] **Kruskal-Wallis (k groups)…** — same menu.
      Recipe: `y = income`, `g = education`.
      Expect, exactly: χ² = **23.8801**, df = **2**, p < .0001. Mean ranks per group
      should be monotonically increasing here.
      Reference: **SPSS** — Analyze ▸ Nonparametric Tests ▸ **Legacy Dialogs** ▸
      **K Independent Samples…** → `income` into **Test Variable List**, `education`
      into **Grouping Variable** → **Define Range…** → Minimum `1`, Maximum `3` →
      **Continue** → tick **Kruskal-Wallis H** → **OK**.
      Syntax: `NPAR TESTS /K-W=income BY education(1 3).`

## 21. Assumptions *(2 items)*

- [ ] **Normality (Shapiro–Wilk)…** — `Assumptions ▸ …`
      Recipe: `vars = age, income`.
      Expect: W and p per variable, N = 30 for age and **28** for income. `age` is
      near-uniform so expect a *low* W with a possibly significant p — a significant
      result is a correct finding here, not a malfunction.
      Reference: **SPSS** — Analyze ▸ Descriptive Statistics ▸ **Explore…** → `age` and
      `income` into **Dependent List** → **Plots…** → tick **Normality plots with
      tests** → **Continue** → **OK**. Read the **Tests of Normality** table; SPSS prints
      Kolmogorov–Smirnov beside Shapiro–Wilk, so take the right column.
      Syntax: `EXAMINE VARIABLES=age income /PLOT NPPLOT.`

- [ ] **Homogeneity of variance (Levene's)…** — same menu.
      Recipe: `outcome = income`, `groups = education`.
      Expect, exactly: F = **0.0519**, p = **.9495** — *if* mean-centred, which is what
      SPSS does. A median-centred (Brown–Forsythe) variant would give a different
      number; the output should say which it is.
      Reference: **SPSS** — Analyze ▸ Compare Means ▸ One-Way ANOVA… → `income` into
      **Dependent List**, `education` into **Factor** → **Options…** → tick
      **Homogeneity of variance test** → **Continue** → **OK**.
      ⚠️ SPSS’s "Based on Mean" row is the one quoted above. It also prints "Based on
      Median" (Brown–Forsythe), which is what R’s `car::leveneTest` gives by **default** —
      so three numbers are in play and you must match the row to the method.
      Syntax: `ONEWAY income BY education /STATISTICS HOMOGENEITY.`

## 22. Scale *(3 items)*

- [ ] **Reliability analysis…** — `Scale ▸ Reliability analysis…`
      Recipe: spatial demo, `vars = satisfaction, commute_min, income_k, household_size`.
      Expect, exactly: Cronbach's **α = .1473** (raw/covariance) or **.1608**
      (standardised — note which is reported); mean inter-item r = **.0457**.
      Item-total correlations: satisfaction **−.0625**, commute_min **.1449**,
      income_k **.1090**, household_size **.1490**.
      Alpha if item deleted: without satisfaction **.1833**, without commute_min
      **−.0330**, without income_k **.0623**, without household_size **.1466**.
      ⚠️ A **negative** alpha-if-deleted is a legitimate result (negative average
      covariance), not an error — these four variables are not a scale, which is exactly
      why they make a good test. The pass condition is that it reports the numbers above
      without choking on the negative.
      Reference: **SPSS** — Analyze ▸ **Scale** ▸ **Reliability Analysis…** → the four
      variables into **Items** → **Model** = **Alpha** → **Statistics…** → tick
      **Scale**, **Scale if item deleted** and **Correlations** → **Continue** → **OK**.
      Expect too: SPSS’s "Cronbach’s Alpha" column is the **raw** figure (.147) and
      "Cronbach’s Alpha Based on Standardized Items" is the second (.161). The
      alpha-if-deleted column is in the **Item-Total Statistics** table.
      Syntax: `RELIABILITY /VARIABLES=satisfaction commute_min income_k household_size
      /MODEL=ALPHA /SUMMARY=TOTAL /STATISTICS=CORR.`

- [ ] **Inter-rater agreement…** — `Scale ▸ Inter-rater agreement…`
      Recipe: compute two rater columns that mostly agree, then `vars = r1, r2`,
      metric = Cohen's kappa; then try Fleiss (3+ raters), Krippendorff's alpha, ICC.
      Expect: kappa in [−1, 1]; **perfect agreement → exactly 1.0**; and the weighted
      variant differing from unweighted on ordinal data.
      Also check the **`weight` input accepts a labelled weight variable** (#188 — a
      labelled weight was once not selectable).
      Reference: **SPSS, for Cohen’s kappa only** — Analyze ▸ Descriptive Statistics ▸
      Crosstabs… → `r1` into **Row(s)**, `r2` into **Column(s)** → **Statistics…** → tick
      **Kappa** → **Continue** → **OK**. For **ICC**: Analyze ▸ Scale ▸ Reliability
      Analysis… → **Statistics…** → tick **Intraclass correlation coefficient** and pick
      the model (Two-Way Mixed / Absolute Agreement is the usual choice).
      ⚠️ SPSS has **no Fleiss kappa and no Krippendorff’s alpha** natively (there are
      third-party extension bundles). For those, **R** — `irr::kappam.fleiss()` and
      `irr::kripp.alpha()`, which is the package CrossTab wraps.
      Syntax: `CROSSTABS /TABLES=r1 BY r2 /STATISTICS=KAPPA.`

- [ ] **Inter-coder agreement from codings…** — same menu.
      Recipe: in the **Coding** workspace, have two coders code the same documents,
      then run this with metric = kappa.
      Expect: it reads the CAQDAS codings **across the plugin boundary** (they are a
      declared public collection — #196), computes agreement per code, and lists the
      **specific disagreements** (#202) so you can go look at them.
      Expect too: a clear message when there is only one coder, rather than a spurious
      perfect-agreement result.
      Reference: **no mainstream GUI does this from coded qualitative data.** The
      comparators are **Dedoose** (Analyze ▸ Training Center for its own kappa) and
      **NVivo** (Explore ▸ Coding Comparison query, which gives kappa and percentage
      agreement per node per pair of coders).
      For the arithmetic: quantitise to a column per code (§36.4), export it, and run
      `irr::kappa2(cbind(coderA, coderB))` in R on the same per-unit assignments.

## 23. Graphs *(11 items)* 🔢

All chart arithmetic here is hand-rolled JavaScript — no R — and every one emits a
**chart model** the host renders. So for each, also confirm the host controls work:
title, axis titles, legend, palette, size, and that the edits survive save and reload
(§8 covers that once; you do not need to repeat it eleven times).

- [ ] **Histogram…**
      Recipe: **Graphs ▸ Histogram…** → `v = age` → OK. Then run it again with
      `v = income`.
      Expect: bars spanning 25–61 for `age`, with the bar counts summing to **30**; for
      `income` they must sum to **28** (the two −99s are missing, not zero). A sensible
      bin count — Sturges on n = 30 gives **6** bins.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Histogram…** → `age` into
      **Variable** → **OK**. (Chart Builder route: Graphs ▸ Chart Builder… ▸ Histogram
      gallery ▸ drag the first icon up ▸ drag `age` to the X axis ▸ OK.)
      ⚠️ Bin *boundaries* legitimately differ between packages — SPSS picks its own
      anchor. The **total** of the bar counts must not differ: 30 for `age`, 28 for
      `income`.
      Syntax: `GRAPH /HISTOGRAM=age.`

- [ ] **Bar chart…**
      Recipe: **Graphs ▸ Bar chart…** → `v = education` → OK.
      Expect, exactly: three bars of **8 / 12 / 10**, labelled High school / Bachelor /
      Postgraduate on the axis (value labels, not the codes 1/2/3).
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Bar…** → **Simple** →
      *Data in Chart Are* **Summaries for groups of cases** → **Define** →
      **Category Axis** = `education`, *Bars Represent* = **N of cases** → **OK**.
      Syntax: `GRAPH /BAR(SIMPLE)=COUNT BY education.`

- [ ] **Line chart…**
      Recipe: **Graphs ▸ Line chart…** → `v = age` → OK.
      Expect: one point per case in **file order** (45, 33, 28, 52 …), 30 points, joined.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Line…** → **Simple** →
      *Data in Chart Are* **Values of individual cases** → **Define** → *Line Represents*
      = `age` → **OK**. That is the setting that gives one point per case in file order
      rather than a summary.
      Syntax: `GRAPH /LINE(SIMPLE)=VALUE(age).`

- [ ] **Scatter…**
      Recipe: **Graphs ▸ Scatter…** → `x = age`, `y = income` → OK.
      Expect: **28 points** (two dropped for missing income) and a visibly strong
      positive relationship — r = .9515. If a fit line is offered, its slope should match
      a simple regression of income on age.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Scatter/Dot…** → **Simple
      Scatter** → **Define** → **Y Axis** = `income`, **X Axis** = `age` → **OK**. For
      the fit line, double-click the chart in the output to open the Chart Editor →
      Elements ▸ **Fit Line at Total**.
      Syntax: `GRAPH /SCATTERPLOT(BIVAR)=age WITH income.`

- [ ] **Trends over time…**
      Recipe: **Graphs ▸ Trends over time…** → `x = age`, `g = gender`,
      `summary = mean`, `y = income` → OK. Then switch `summary` to count, then to
      percent.
      Expect: one line per group; the values change with each summary; in **percent**
      mode the lines sum to 100 within each x.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Line…** → **Multiple** →
      **Summaries for groups of cases** → **Define** → **Category Axis** = `age`,
      **Define Lines by** = `gender`, *Lines Represent* = **Other statistic** → move
      `income` in and set it to **Mean** → **OK**.
      Syntax: `GRAPH /LINE(MULTIPLE)=MEAN(income) BY age BY gender.`

- [ ] **Boxplot…**
      Recipe: **Graphs ▸ Boxplot…** → `y = age` → OK. Then again with `g = gender`.
      Expect: median **39.5**; quartiles at **31.75 / 50.5** (SPSS's hinge definition) or
      **32.25 / 49.75** (R's default) — note which you get. With `g` set, two boxes side
      by side.
      ⚠️ Whichever quartile definition it uses, it must be **the same one** the
      Frequencies Statistics panel uses (§14). Two different definitions inside one app
      is the real bug to look for here.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Boxplot…** → **Simple** →
      **Summaries of separate variables** → **Define** → `age` into **Boxes Represent**
      → **OK**. For the grouped version choose **Summaries for groups of cases** with
      `gender` as the Category Axis.
      Syntax: `EXAMINE VARIABLES=age /PLOT BOXPLOT /STATISTICS NONE.`

- [ ] **Pie chart…**
      Recipe: **Graphs ▸ Pie chart…** → `v = region` → OK.
      Expect, exactly: three slices of **36.7 / 33.3 / 30.0 %** (11 / 10 / 9 cases),
      summing to 100.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Pie…** → **Summaries for
      groups of cases** → **Define** → **Define Slices by** = `region`, *Slices Represent*
      = **N of cases** → **OK**.
      Syntax: `GRAPH /PIE=COUNT BY region.`

- [ ] **Bar chart with error bars…**
      Recipe: **Graphs ▸ Bar chart with error bars…** → `y = income`, `g = gender` → OK.
      Then cycle the error type through **SEM**, **SD** and **95% CI**, and switch it off.
      Expect, exactly: bar heights are the group means **39085.71** (Male) and
      **51500.00** (Female). Male's SEM = 10427.0991/√14 = **2786.2**; its SD bar is
      **10427.10**; its 95% CI is roughly ±2.16 × SEM (t₍₁₃₎ = 2.160). All three must
      differ from each other, and turning the bars off must leave the bar **heights**
      unchanged.
      Reference: **SPSS** — Graphs ▸ **Legacy Dialogs** ▸ **Error Bar…** → **Simple** →
      **Summaries for groups of cases** → **Define** → **Variable** = `income`,
      **Category Axis** = `gender`, then set *Bars Represent* to **Confidence interval
      for mean** (95%), and re-run choosing **Standard error of mean** and **Standard
      deviation** — that dropdown is exactly the switch being tested → **OK**.
      Syntax: `GRAPH /ERRORBAR(CI 95)=income BY gender.`

- [ ] **Violin plot…**
      Recipe: **Graphs ▸ Violin plot…** → `y = income`, `g = gender` → OK. Then turn on
      the data-point overlay.
      Expect: a density silhouette per group, **open axes** (the Prism convention — no
      box frame), and the individual points overlaid when asked. 14 points per group.
      Reference: **no SPSS equivalent** — neither Chart Builder nor the Legacy Dialogs
      draw violins. **GraphPad Prism** is the convention being matched: New ▸ Column
      table ▸ enter the groups ▸ Graph type **Violin plot**. **R** —
      `ggplot(d, aes(gender, income)) + geom_violin() + geom_jitter()`.

- [ ] **Dot plot (column scatter)…**
      Recipe: **Graphs ▸ Dot plot (column scatter)…** → `y = income`, `g = gender` → OK.
      Expect: every case as its own point, jittered or offset so none are hidden —
      **14 visible points per group**. Count them; overplotting that hides cases is the
      failure.
      Reference: **GraphPad Prism** — New ▸ Column table ▸ Graph type **Scatter dot
      plot**, which is the convention here. **SPSS** gets close with Graphs ▸ Legacy
      Dialogs ▸ Scatter/Dot… ▸ **Simple Dot**, but it bins rather than jittering, so the
      "every case visible" property is not directly comparable. **R** —
      `geom_jitter(width = 0.15)`.

- [ ] **Before-after plot…**
      Recipe: first **Transform ▸ Compute variable…** twice to make `t1 = age` and
      `t2 = age + 5`. Then **Graphs ▸ Before-after plot…** → `vars = t1, t2` → OK. Then
      run it again having set one case's `t2` to missing.
      Expect: one line per case joining its two values, all sloping up by 5; with
      `idVar` set the lines are identifiable. The case with a missing value is **dropped
      visibly**, not drawn down to zero — that is the thing to check.
      Reference: **GraphPad Prism** — New ▸ Column table ▸ Graph type **Before-after**.
      **SPSS** approximates it with Graphs ▸ Legacy Dialogs ▸ Line… ▸ **Multiple** ▸
      **Values of individual cases**, with `t1` and `t2` as the lines. **R** —
      `geom_line(aes(group = id))` over a long-format pair.

## 24. Multivariate *(10 items)*

- [ ] **k-means cluster analysis…** — `Multivariate ▸ …`
      Recipe: spatial demo, `vars = satisfaction, commute_min, income_k,
      household_size`, `k = 3`, standardize = yes.
      Expect: three non-empty clusters, cluster centres, and sizes. On this data
      standardised: sizes around **18 / 20 / 22**, total SS **236.0**, within-cluster SS
      ≈ **152.1**, between/total ≈ **.356**.
      ⚠️ k-means depends on its starting assignment, so treat sizes as approximate
      unless a seed is exposed. **Run it twice**: if there is no seed and the answer
      changes, that is worth recording as a reproducibility gap (it matters for the
      History/replay promise). Also confirm `standardize = no` gives a *different*
      answer — unstandardised, `income_k` dominates by scale.
      Reference: **SPSS** — first standardise, because **QUICK CLUSTER does not**:
      Analyze ▸ Descriptive Statistics ▸ Descriptives… → the four variables → tick
      **Save standardized values as variables** → **OK** (this creates `Zsatisfaction`
      and friends). Then Analyze ▸ **Classify** ▸ **K-Means Cluster…** → the four `Z`
      variables into **Variables** → **Number of Clusters** = `3` → **Save…** → tick
      **Cluster membership** → **Continue** → **OK**.
      ⚠️ That standardise-first step is the most common reason a k-means result does not
      match: unstandardised, `income_k` dominates purely by scale.
      Syntax: `QUICK CLUSTER Zsatisfaction Zcommute_min Zincome_k Zhousehold_size
      /CRITERIA=CLUSTER(3) /PRINT=INITIAL CLUSTER.`

- [ ] **Factor analysis…** — `Multivariate ▸ Factor analysis…`
      Recipe: spatial demo, same four variables, `nfactors = 2`, method = PCA,
      rotation = varimax; then method = ML, `nfactors = 1`, rotation = none.
      Expect, exactly (PCA on the correlation matrix): eigenvalues **1.2562 / 1.0778 /
      0.8894 / 0.7766**, proportions **.3140 / .2694 / .2224 / .1942** (summing to 1).
      Unrotated loadings on PC1/PC2: satisfaction **.2162 / −.8321**, commute_min
      **−.6603 / −.4157**, income_k **−.6195 / .3939**, household_size
      **−.6243 / −.2394**.
      For ML with 1 factor: loadings **−.0130 / .4985 / .2546 / .3227**,
      χ² = **1.1509**, df = **2**, p = **.5625**.
      ⚠️ **Loading signs are arbitrary** — a whole column flipped is not a bug.
      Compare absolute values. Also note SPSS's default extraction is PCA with
      eigenvalue > 1, which here would retain **2** components.
      Reference: **SPSS** — Analyze ▸ **Dimension Reduction** ▸ **Factor…** → the four
      variables into **Variables** → **Extraction…** → Method **Principal components**,
      and either leave *Based on Eigenvalue > 1* or set **Fixed number of factors** = 2 →
      **Continue** → **Rotation…** → **Varimax** → **Continue** → **Descriptives…** →
      tick **Initial solution** → **Continue** → **OK**.
      Expect too: the eigenvalues above are the **Total Variance Explained** table’s
      "Initial Eigenvalues" column. SPSS’s default (eigenvalue > 1) retains **2**
      components here. ⚠️ Loading **signs are arbitrary** — a whole flipped column is not
      a difference; compare absolute values.
      Syntax: `FACTOR /VARIABLES=satisfaction commute_min income_k household_size
      /EXTRACTION PC /CRITERIA FACTORS(2) /ROTATION VARIMAX /PRINT INITIAL EXTRACTION
      ROTATION.`

- [ ] **MANOVA…** — `Multivariate ▸ MANOVA…`
      Recipe: `dvs = age, income`, `group = education`.
      Expect: all four multivariate tests — **Pillai's trace, Wilks' lambda,
      Hotelling's trace, Roy's largest root** — each with F, df and p; plus the
      univariate follow-ups. With 2 DVs and 3 groups the four tests will *not* be
      identical (they coincide only when the hypothesis df is 1).
      Reference: **SPSS** — Analyze ▸ **General Linear Model** ▸ **Multivariate…** →
      `age` and `income` into **Dependent Variables**, `education` into **Fixed
      Factor(s)** → **Options…** → tick **Homogeneity tests** → **Continue** → **OK**.
      Expect too: all four multivariate tests (Pillai, Wilks, Hotelling, Roy) print
      automatically in the *Multivariate Tests* table, with the univariate follow-ups
      below in *Tests of Between-Subjects Effects*.
      Syntax: `GLM age income BY education /PRINT=HOMOGENEITY.`

- [ ] **Confirmatory factor analysis…** — `Multivariate ▸ Confirmatory factor analysis…`
      Recipe: spatial demo, `items =` the four numeric variables, `factorName = F1`.
      Expect: standardised loadings, and fit indices — **χ², df, CFI, TLI, RMSEA,
      SRMR**. With four weakly-correlated items expect *good* fit for a 1-factor model
      (there is little covariance to explain) and small loadings. Both are correct.
      Reference: **not in SPSS itself** — it needs **IBM SPSS Amos**, a separate product:
      draw the latent with its four indicators, then Analyze ▸ Calculate Estimates, and
      read CFI/TLI/RMSEA from View ▸ Text Output ▸ Model Fit. **R** —
      `lavaan::cfa("F1 =~ satisfaction + commute_min + income_k + household_size")`,
      the package CrossTab wraps — so extract its generated syntax from
      **Edit ▸ History…** and expect an exact match. **Stata** — `sem (F1 -> ...)`.

- [ ] **Latent growth curve…** — same menu.
      Recipe: `waves = t1, t2, t3` (computed in §15), `quadratic = no`, then yes.
      Expect: intercept and slope means and variances, and their covariance; the
      quadratic version adds a second-order term.
      Reference: **Mplus** is the field standard (`MODEL: i s | t1@0 t2@1 t3@2;`).
      **R** — `lavaan::growth()`, the function this wraps. **Stata** — `sem` with
      latent intercept and slope, or `mixed` for the equivalent random-coefficient form.
      Not available in SPSS without Amos.

- [ ] **Structural equation model (syntax)…** — same menu.
      Recipe: `vars =` four numeric variables, `model =` lavaan syntax, e.g.
      `income_k ~ satisfaction + commute_min`.
      Expect: parameter estimates and fit indices; a **syntax error in the model text
      produces a readable error**, not a silent empty result. Test that deliberately.
      Reference: **IBM SPSS Amos** (draw the model), or **R** — `lavaan::sem(model)`
      with the same syntax string you typed in, which makes this the easiest of the SEM
      family to check: paste the identical model text into lavaan. **Stata** — `sem`.

- [ ] **Correspondence analysis…** — `Multivariate ▸ Correspondence analysis…`
      Recipe: `rowvar = gender`, `colvar = education`.
      Expect: row and column scores on 2 dimensions, **total inertia = χ²/n =
      8.1000/30 = .2700**, and a biplot. That inertia identity is a free arithmetic
      check against §14.
      Reference: **SPSS** — Analyze ▸ **Dimension Reduction** ▸ **Correspondence
      Analysis…** → `gender` into **Row** → **Define Range…** → Minimum 1, Maximum 2 →
      **Update** → **Continue**; same for `education` into **Column** with 1–3 →
      **Statistics…** → tick **Correspondence table** and **Row/Column profiles** →
      **Continue** → **Plots…** → tick **Biplot** → **Continue** → **OK**.
      Expect too: total inertia = χ²/n = 8.1000/30 = **.2700**, which is a free
      cross-check against §14.
      Syntax: `CORRESPONDENCE TABLE=gender(1 2) BY education(1 3).`

- [ ] **Multidimensional scaling (MDS)…** — same menu.
      Recipe: spatial demo, `vars =` four numeric variables, `label = zip_code`.
      Expect: a 2-D configuration plot plus a **stress** value; stress should fall as
      dimensions increase.
      Reference: **SPSS** — Analyze ▸ **Scale** ▸ **Multidimensional Scaling
      (PROXSCAL)…** → choose **Create proximities from data** → the four variables into
      **Variables** → **Define** the distance measure (Euclidean) → **Model…** → set
      **Dimensions** minimum 2 maximum 2 → **Continue** → **Plots…** → tick **Common
      space** → **OK**. (The older ALSCAL dialog sits beside it and reports Kruskal’s
      stress instead — different number, same idea.)
      Syntax: `PROXSCAL VARIABLES=satisfaction commute_min income_k household_size
      /SHAPE=LOWER /INITIAL=SIMPLEX /CRITERIA=DIMENSIONS(2,2).`

- [ ] **Network analysis (edge list)…** — `Multivariate ▸ Network analysis…`
      Recipe: build a tiny edge list dataset (`from`, `to` columns, ~10 edges with one
      obvious hub), `directed = no`.
      Expect: degree / betweenness / closeness centrality per node, density, components,
      and a graph figure. **The hub must have the highest degree** — the simplest
      possible sanity check. Then `directed = yes` and confirm in-degree and out-degree
      separate.
      Reference: **no SPSS equivalent.** **Gephi** is the easiest GUI check: File ▸
      Import spreadsheet ▸ *Edges table* ▸ then Statistics ▸ run **Average Degree** and
      **Betweenness Centrality**. **UCINET** is the other field standard. **R** —
      `igraph::degree()`, `betweenness()`, `closeness()`, `edge_density()` — the package
      this wraps.

- [ ] **Diversity & ordination…** — `Multivariate ▸ Diversity & ordination…`
      Recipe: a species-abundance table (make ~8 sites × 5 species), `species =` the
      five count columns.
      Expect: **Shannon H′, Simpson, species richness** per site, plus an ordination
      plot. Sanity checks that cost nothing: a site with one species present has
      H′ = **0**; richness equals the count of non-zero columns.
      Reference: **no SPSS equivalent.** **PAST** (free, palaeontological statistics) is
      the quickest GUI: paste the site × species matrix, then Diversity ▸ **Diversity
      indices**. **PRIMER** is the commercial standard. **R** —
      `vegan::diversity(m, "shannon")`, `diversity(m, "simpson")`,
      `specnumber(m)` — the package this wraps.

## 25. Time Series *(8 items)*

- [ ] **Correlogram (ACF / PACF)…** — `Time Series ▸ …`
      Recipe: `series = age` (as a stand-in series), `maxlag = 10`.
      Expect: ACF at **lag 0 = exactly 1.0**, confidence bands drawn at ±1.96/√n, and
      PACF alongside. That lag-0 value is a free check.
      Reference: **SPSS** (Forecasting module) — Analyze ▸ **Forecasting** ▸
      **Autocorrelations…** → the series into **Variables** → tick **Autocorrelations**
      and **Partial autocorrelations** → **Options…** → *Maximum Number of Lags* = `10` →
      **Continue** → **OK**.
      Syntax: `ACF VARIABLES=age /MXAUTO 10 /PARTIAL.`

- [ ] **Stationarity tests (ADF, KPSS)…** — same menu.
      Recipe: `series = age`.
      Expect: ADF statistic and p, KPSS statistic and p, with their **opposite null
      hypotheses** stated (ADF null = non-stationary; KPSS null = stationary). If the
      output does not say which null is which, that is a usability finding.
      Reference: **no SPSS equivalent.** **Stata** — `dfuller age, lags(1)` and
      `kpss age`. **R** — `tseries::adf.test(x)` and `tseries::kpss.test(x)`, the
      package this wraps. **EViews** — View ▸ Unit Root Test.
      ⚠️ Their nulls are opposite (ADF: non-stationary; KPSS: stationary), so "both
      significant" is a real and common state, not a contradiction.

- [ ] **Decomposition (STL)…** — same menu.
      Recipe: a series with a visible cycle; `frequency = 12`.
      Expect: trend + seasonal + remainder panels, and **trend + seasonal + remainder ≈
      the original** at every point (additive identity — check a couple of points).
      Reference: **SPSS** (Forecasting module) — Analyze ▸ **Forecasting** ▸ **Seasonal
      Decomposition…** → the series into **Variables** → *Model* **Additive** →
      **OK**. It saves the components back as new variables (`SAF`, `STC`, `ERR`).
      ⚠️ **This is not STL.** SPSS runs a Census Method I / X-11 style decomposition, a
      different algorithm, so the components will not match term for term. The matching
      reference is **R** — `stl(ts(x, frequency = 12), s.window = "periodic")`.
      Either way the additive identity holds, which is the part worth checking.
      Syntax: `SEASON VARIABLES=x /MODEL=ADDITIVE /MA=CENTERED.`

- [ ] **ARIMA forecast (auto)…** — same menu.
      Recipe: `series =` a trending series, `h = 6`, `frequency = 1`.
      Expect: a chosen (p,d,q) order, coefficients, AIC, and 6 forecasts with widening
      prediction intervals. **Intervals must widen** with the horizon.
      Reference: **SPSS** (Forecasting module) — Analyze ▸ **Forecasting** ▸ **Create
      Traditional Models…** → the series into **Dependent Variables** → **Method** =
      **Expert Modeler** (or ARIMA with an explicit order) → **Statistics** tab: tick
      **Parameter estimates** → **Plots** tab: tick **Series** with *Confidence
      intervals* → **Options** tab: set the forecast horizon → **OK**.
      ⚠️ SPSS’s Expert Modeler and R’s `auto.arima` use different selection criteria and
      will sometimes pick **different orders** on the same series. Compare the fit of a
      *specified* order if you want an exact check.
      Syntax: `TSMODEL /MODELSUMMARY PRINT=[MODELFIT] /AUXILIARY CILEVEL=95
      /MODELDETAILS PRINT=[PARAMETERS].`

- [ ] **Mann-Kendall trend + Sen's slope…** — `Time Series ▸ …`
      Recipe: `series =` a monotonically increasing variable.
      Expect: S, tau, p, and Sen's slope. **A perfectly monotonic series gives
      tau = 1.0** — do that case first, it is unambiguous.
      Reference: **no SPSS equivalent.** **R** — `trend::mk.test(x)` and
      `trend::sens.slope(x)`, the package this wraps. **XLSTAT** has it as a GUI add-in
      for Excel (Time ▸ Mann-Kendall trend test), which is the usual route in
      environmental work. **Stata** — the `mktrend` user package.

- [ ] **Cointegration (Johansen)…** — same menu.
      Recipe: `series =` 2–3 related series, `ecdet = const`, `K = 2`.
      Expect: trace and max-eigenvalue statistics with critical values at 10/5/1%, and
      a stated number of cointegrating relations.
      Reference: **no SPSS equivalent.** **Stata** — `vecrank y1 y2, lags(2) trend(constant)`
      gives the trace and max-eigenvalue statistics with critical values. **EViews** —
      View ▸ Cointegration Test. **R** — `urca::ca.jo(data, type = "trace", K = 2,
      ecdet = "const")`, the package this wraps.

- [ ] **GARCH volatility…** — same menu.
      Recipe: `series =` a return-like series, `q = 1`, `p = 1`, dist = normal.
      Expect: omega, alpha, beta estimates with **alpha + beta < 1** (the stationarity
      condition) and a conditional-volatility plot. Then try the t distribution and
      confirm the shape parameter appears.
      Reference: **no SPSS equivalent.** **Stata** — `arch y, arch(1) garch(1)`.
      **EViews** — Estimate Equation ▸ Method **ARCH**. **R** —
      `fGarch::garchFit(~ garch(1, 1), data = x)`, the package this wraps.
      Expect too: whichever you use, **alpha + beta < 1** or the model is not
      stationary — a free check on the output.

- [ ] **Vector autoregression (VAR)…** — `Time Series ▸ …`
      Recipe: `series =` 2–3 series, `lag = 2`, `type = const`, `horizon = 10`.
      Expect: one equation per series, Granger-causality tests if offered, and
      **impulse-response functions** over 10 periods. A stable VAR's IRFs should decay.
      Reference: **no SPSS equivalent.** **Stata** — `var y1 y2, lags(1/2)` then
      `irf create m, step(10) set(m)` and `irf graph irf`. **EViews** — Quick ▸ Estimate
      VAR. **R** — `vars::VAR(data, p = 2, type = "const")` then `irf(fit, n.ahead = 10)`,
      the package this wraps.

## 26. Econometrics *(3 items — "Robust (HC)" is in §18)*

- [ ] **Instrumental variables (2SLS)…** — `Econometrics ▸ …`
      Recipe: `dv = income`, `endog = education`, `instruments =` a variable correlated
      with education but not directly with income, `controls = age`.
      Expect: 2SLS coefficients, plus the diagnostic trio — **weak-instrument
      (first-stage F), Wu–Hausman endogeneity, and Sargan** (only when
      over-identified; with exactly one instrument Sargan is not computable and should
      say so rather than print a zero).
      Reference: **SPSS can do the estimates** — Analyze ▸ Regression ▸ **2-Stage Least
      Squares…** → `income` into **Dependent**, `education` into **Explanatory**, your
      instrument into **Instrumental** (and `age` into *both* Explanatory and
      Instrumental, since exogenous controls are their own instruments) → **OK**.
      ⚠️ SPSS gives you **no weak-instrument F, no Wu–Hausman and no Sargan** — the three
      things that decide whether the IV is any good. For those use **Stata** —
      `ivregress 2sls income age (education = z)` then `estat firststage` and
      `estat endogenous` / `estat overid`. **R** — `AER::ivreg(...)` then
      `summary(fit, diagnostics = TRUE)`, the package this wraps.

- [ ] **Panel regression (FE / RE)…** — same menu.
      Recipe: spatial demo as a pseudo-panel: `dv = income_k`,
      `ivs = satisfaction, commute_min`, `id = district`, `time =` a computed index,
      `model = fe`; then `re`.
      Expect: FE drops anything time-invariant and reports within-R²; RE reports theta
      and the between/within variance split. **FE and RE coefficients must differ**;
      if they are identical something is not switching.
      Reference: **SPSS has no xtreg.** Random effects can be approximated with
      Analyze ▸ Mixed Models ▸ Linear… (random intercept by `district`), but fixed
      effects would mean entering dummies by hand. **Stata** is the comparator —
      `xtset district t` then `xtreg income_k satisfaction commute_min, fe` and again
      `, re`, with `hausman` to compare them. **R** —
      `plm(..., model = "within")` / `"random"`, the package this wraps.

## 27. Survival *(2 items)*

- [ ] **Kaplan–Meier & log-rank…** — `Survival ▸ …`
      Recipe: build a small survival dataset (`time`, `status` 1 = event / 0 = censored,
      `group`), ~20 cases.
      Expect: a step-function survival curve starting at **S(0) = 1.0**, median survival
      with CI, censoring marks, and a log-rank χ² with df = groups − 1.
      Free checks: the curve never increases; with no censoring the final S hits 0.
      Reference: **SPSS** — Analyze ▸ **Survival** ▸ **Kaplan-Meier…** → `time` into
      **Time**, `status` into **Status** → click **Define Event…** → *Single value* `1` →
      **Continue** → `group` into **Factor** → **Compare Factor…** → tick **Log rank** →
      **Continue** → **Options…** → tick **Survival table(s)**, **Mean and median
      survival** and the **Survival** plot → **Continue** → **OK**.
      Syntax: `KM time BY group /STATUS=status(1) /PRINT TABLE MEAN /PLOT SURVIVAL
      /COMPARE.`

- [ ] **Cox proportional hazards…** — same menu.
      Recipe: same data, `preds =` one or two covariates.
      Expect: coefficients with **hazard ratios = exp(β)** (check that identity
      yourself), SEs, a likelihood-ratio test, and ideally a PH-assumption diagnostic.
      Reference: **SPSS** — Analyze ▸ **Survival** ▸ **Cox Regression…** → `time` into
      **Time**, `status` into **Status** → **Define Event…** → `1` → **Continue** → the
      predictors into **Covariates** → **Options…** → tick **CI for exp(B) 95%** →
      **Continue** → **OK**. The *exp(B)* column is the hazard ratio.
      Expect too: check `exp(B)` equals `exp` of the coefficient yourself — a free
      arithmetic test that costs one calculator keystroke.
      Syntax: `COXREG time /STATUS=status(1) /METHOD=ENTER x /PRINT=CI(95).`

## 28. Survey *(3 items)*

- [ ] **Weighted means…** — `Survey ▸ Weighted means…`
      Recipe: `vars = income`, `weight =` a positive weight variable; then add
      `strata` and `cluster`.
      Expect: weighted mean, and a **design-based standard error that grows when
      clustering is declared** (clustering reduces effective n). Unweighted vs weighted
      means should differ unless the weight is constant — set the weight to a constant
      column of 1s and confirm you get the plain mean **45292.8571** back. That is the
      best single test of a weighting path.
      Reference: **SPSS** (Complex Samples module) — two steps. First Analyze ▸
      **Complex Samples** ▸ **Prepare for Analysis…** → *Create a plan file* → name it →
      **Next** → put `strata` into **Stratify By**, `cluster` into **Clusters**, the
      weight into **Sample Weight** → **Next** through the rest → **Finish**. Then
      Analyze ▸ **Complex Samples** ▸ **Descriptives…** → select that plan file →
      `income` into **Measures** → **OK**.
      ⚠️ **Data ▸ Weight Cases is not a substitute.** It gives the right point estimate
      and the **wrong standard error** — it treats the weights as case replication and
      ignores the design entirely. That mismatch is the single most common fake bug in
      survey work.
      **Stata** — `svyset cluster [pw=w], strata(strata)` then `svy: mean income`.

- [ ] **Weighted crosstab…** — same menu.
      Recipe: `rowvar = gender`, `colvar = education`, `weight`, optional strata/cluster.
      Expect: weighted proportions with design-based CIs and a **Rao–Scott adjusted**
      chi-square — not the naive Pearson χ² on weighted counts.
      Reference: **SPSS** — Analyze ▸ **Complex Samples** ▸ **Crosstabs…** → the plan
      file from above → `gender` into **Rows**, `education` into **Columns** →
      **Statistics…** → tick **Row percentages** and their **Standard error** and
      **Confidence interval** → **Continue** → **OK**.
      Expect too: the chi-square reported must be the **Rao–Scott adjusted** one, not a
      naive Pearson χ² on weighted counts.
      **Stata** — `svy: tabulate gender education, row se`.

- [ ] **Survey regression…** — same menu.
      Recipe: `dv = income`, `ivs = age, education`, family = gaussian, `weight`;
      then `dv = gender`, `yes = Female`, family = binomial.
      Expect: design-based SEs; with a constant weight and no strata/cluster the
      **coefficients should match ordinary regression** (§18: 6959.8 / 514.7 / 8563.7).
      Reference: **SPSS** — Analyze ▸ **Complex Samples** ▸ **General Linear Model…**
      for the gaussian case, or **Logistic Regression…** for the binary one; both take
      the plan file first, then the dependent and predictors as usual.
      **Stata** — `svy: regress income age education` and `svy: logistic female age`.

## 29. Spatial *(3 items)*

- [ ] **Spatial autocorrelation (Moran’s I)…** — `Spatial ▸ …`
      Recipe: a dataset with x/y coordinates and a value; `k = 4` nearest neighbours.
      Expect: Moran's I in roughly [−1, 1], its expectation **E[I] = −1/(n−1)**, a
      variance, a z-score and p. Check E[I] against that formula — it is exact.
      Randomly-arranged values should give I ≈ E[I].
      Reference: **no SPSS equivalent.** **GeoDa** (free) is the field’s GUI: File ▸ Open
      your data → Tools ▸ **Weights Manager** ▸ *Create* ▸ **K-Nearest Neighbors** with
      k = 4 → Create → then **Space** ▸ **Univariate Moran’s I** → pick the variable and
      the weights you just made. Right-click the scatterplot ▸ *Randomization* ▸ 999
      permutations for the pseudo p-value.
      **R** — `spdep::moran.test(x, nb2listw(knn2nb(knearneigh(coords, k = 4))))`, the
      package this wraps. **ArcGIS Pro** — Spatial Statistics ▸ Spatial Autocorrelation
      (Global Moran’s I).

- [ ] **Spatial lag regression…** — same menu.
      Recipe: `outcome`, `preds`, coordinates, `k = 4`.
      Expect: the **spatial autoregressive parameter ρ** with a significance test, plus
      the usual coefficients and a log-likelihood/AIC. ρ must be reported — it is the
      whole point of the model.
      Reference: **GeoDa** — create the weights as above, then **Regression** ▸ set the
      dependent and covariates ▸ tick **Spatial Lag** ▸ select the weights file ▸ Run.
      Read **rho** and its significance from the output window.
      **R** — `spatialreg::lagsarlm(y ~ x, listw = w)`, the package this wraps.

- [ ] **Choropleth map…** — same menu.
      Recipe: spatial demo (it ships ZIP boundaries), `region = zip_code`,
      `value = income_k`, `boundary =` the bundled file, `keyprop = ZCTA`.
      Expect: shaded polygons, a legend with class breaks, and — importantly — a clear
      report of **how many regions failed to join** the boundary file. A silent
      drop is the bug to look for here: deliberately misspell `keyprop` and confirm it
      tells you nothing matched rather than drawing an empty map.
      Reference: **GeoDa** — open the boundary file, Table ▸ **Merge** your data on the
      ZIP key, then **Map** ▸ **Quantile Map** (or Natural Breaks) ▸ pick the variable
      and the number of classes. **QGIS** — Layer Properties ▸ Symbology ▸ **Graduated**
      ▸ classify. Both will also tell you how many features failed to join, which is
      exactly the behaviour being checked here.
      **R** — `sf` + `tmap::tm_shape() + tm_polygons("income_k", style = "quantile")`.


## 30. Ecology *(2 items)*

- [ ] **Distance sampling…** — `Ecology ▸ Distance sampling…`
      Recipe: a column of perpendicular detection distances (~50 values, denser near
      zero), shape = half-normal, key = hn, with a truncation.
      Expect: a detection function with an estimated scale, **effective strip
      half-width**, density/abundance if effort and area are given, and a histogram of
      distances with the fitted curve over it. Density must scale sensibly when you
      halve `area`.
      Reference: **no SPSS equivalent.** **Distance for Windows** (free, from
      distancesampling.org) is the field standard: File ▸ New Project ▸ import the
      observations as a *flat file* with the perpendicular distances ▸ then in the
      Analyses tab create a new analysis ▸ Model Definition ▸ **Key function:
      Half-normal**, set the truncation ▸ **Run**. Read the effective strip half-width
      and the density estimate from the results pane.
      **R** — `mrds::ddf(dsmodel = ~mcds(key = "hn", formula = ~1), data = d,
      meta.data = list(width = 100))`, the package this wraps.

- [ ] **Occupancy / N-mixture…** — same menu.
      Recipe: repeat-visit detection columns (`v1, v2, v3` of 0/1), model = occupancy,
      then N-mixture with `kmax`.
      Expect: separate **detection probability (p)** and **occupancy (ψ)** estimates —
      the point of the model is that these are not the same thing, so confirm both
      appear. Naive occupancy (any detection / n sites) should be **lower** than the
      estimated ψ.
      Reference: **no SPSS equivalent.** **PRESENCE** (free, Patuxent) is the
      purpose-built GUI: enter the detection history matrix ▸ Run ▸ *Single-season*
      model. **MARK** does it too. **R** — `unmarked::occu(~1 ~1, umf)` for occupancy
      and `unmarked::pcount(~1 ~1, umf, K = kmax)` for N-mixture.
      Expect too: whichever you use, naive occupancy (any detection ÷ sites) should be
      **lower** than the estimated ψ — that is the whole point of the model, and a free
      check on the output.

## 31. Bayesian *(4 items)*

- [ ] **Linear regression (Bayesian)…** — `Bayesian ▸ Linear regression…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect: posterior means with **credible intervals** (not confidence intervals —
      check the label), and posterior means close to the OLS estimates
      (**6959.8 / 514.7 / 8563.7**) under weak priors. A large divergence from OLS with
      default priors would be a finding.
      Reference: **SPSS 25 and later** — Analyze ▸ **Bayesian Statistics** ▸ **Linear
      Regression…** → `income` into **Dependent**, `age` and `education` into
      **Covariates** → under *Bayesian Analysis* choose **Use both methods** so you get
      the posterior beside the frequentist fit → **OK**.
      **JASP** (free) — Regression ▸ **Bayesian Linear Regression**. **R** —
      `rstanarm::stan_glm()` or `BayesFactor::lmBF()`.
      ⚠️ Read the label: these are **credible** intervals, not confidence intervals.

- [ ] **Bayes factor: t-test…** — same menu.
      Recipe: `y = income`, `group = gender`, `g1 = Male`, `g2 = Female`.
      Expect: a BF₁₀ well above 1 (the frequentist p was .0057), and its reciprocal
      BF₀₁ reported or derivable. Check that **BF₀₁ = 1/BF₁₀**.
      Reference: **JASP** is the standard comparator (free, jasp-stats.org) — T-Tests ▸
      **Bayesian Independent Samples T-Test** → `income` as the variable, `gender` as the
      grouping variable → the default prior is a **Cauchy with r = 0.707**, which is the
      number everyone quotes.
      **SPSS 25+** — Analyze ▸ Bayesian Statistics ▸ **Independent-Samples Normal…**
      also yields a Bayes factor. ⚠️ SPSS’s default priors differ from JASP’s, so the two
      give **different BF values on the same data** and neither is wrong. Match the prior
      before comparing. **R** — `BayesFactor::ttestBF(x, y)`.
      Expect too: BF₀₁ must equal 1/BF₁₀ — a free check whichever tool you use.

- [ ] **Bayes factor: correlation…** — same menu.
      Recipe: `x = age`, `y = income`.
      Expect: a very large BF (r = .95, n = 28).
      Reference: **JASP** — Regression ▸ **Bayesian Correlation** (or Bayesian
      Correlation Pairs) → `age` and `income`. **SPSS 25+** — Analyze ▸ Bayesian
      Statistics ▸ **Pearson Correlation…**. **R** —
      `BayesFactor::correlationBF(age, income)`. Same prior caveat as above.

- [ ] **Vector autoregression (BVAR)…** — same menu.
      Recipe: 2–3 series, `lags = 2`, `horizon = 10`.
      Expect: posterior coefficient summaries and forecasts with credible bands.
      Reference: **not in SPSS or JASP.** **Stata** — `bayes: var y1 y2, lags(1/2)`.
      **R** — the `BVAR` or `bvartools` packages. **EViews** — Quick ▸ Estimate VAR ▸
      VAR Type **Bayesian VAR**.

## 32. Resampling *(5 items)*

- [ ] **Bootstrap the mean…** — `Resampling ▸ Bootstrap the mean…`
      Recipe: `x = income`, `reps = 2000`.
      Expect: the original mean **45292.8571**, a bootstrap SE near the analytic
      **12432.9886/√28 = 2349.3**, and a percentile CI near the t-based
      **[40471.85, 50113.87]**. Bias should be small and centred on zero.
      ⚠️ Resampling is random — **run it twice**. Small variation is correct; the
      question is whether a seed is exposed for reproducibility, since History claims to
      replay analyses. If not, note it.
      Reference: **SPSS** (Bootstrapping module) — the trick is that bootstrapping is a
      **button inside** the ordinary dialogs, not a menu of its own: Analyze ▸
      Descriptive Statistics ▸ **Explore…** → `income` into Dependent List → click
      **Bootstrap…** → tick **Perform bootstrapping**, *Number of samples* = `2000`,
      *Confidence Intervals* = **Percentile** → **Continue** → **OK**. The bootstrap
      results appear as extra columns beside the Descriptives table.
      **Stata** — `bootstrap r(mean), reps(2000): summarize income`. **R** — `boot`,
      the package this wraps.
      ⚠️ Resampling is random: run it twice. Small variation is correct. The question
      worth recording is whether a **seed** is exposed, because History promises to
      replay analyses and it cannot keep that promise without one.

- [ ] **Bootstrap a statistic…** — same menu.
      Recipe: `x = income`, `stat = median`, `reps = 2000`; then try each other `stat`.
      Expect: each statistic's bootstrap distribution; the median's CI will be wider
      and chunkier than the mean's — correct, not a defect.
      Reference: **SPSS** — same **Bootstrap…** button; for the median use Analyze ▸
      Descriptive Statistics ▸ Explore… (its *Percentiles* output is bootstrapped too).
      **Stata** — `bootstrap r(p50), reps(2000): summarize income, detail`. **R** —
      `boot(income, function(x, i) median(x[i]), R = 2000)`.
      Expect too: the median’s CI will be wider and chunkier than the mean’s in every
      package — correct, not a defect.

- [ ] **Bootstrap a correlation…** — same menu.
      Recipe: `x = age`, `y = income`, `reps = 2000`.
      Expect: centred near **r = .9515**, with an asymmetric CI (correlations near 1
      are skewed) whose upper bound stays **≤ 1**. A CI exceeding 1 is a real bug.
      Reference: **SPSS** — Analyze ▸ Correlate ▸ **Bivariate…** → `age` and `income` →
      click **Bootstrap…** → tick **Perform bootstrapping**, 2000 samples, **Percentile**
      → **Continue** → **OK**.
      **Stata** — `bootstrap r(rho), reps(2000): correlate age income`. **R** — `boot`
      with `cor(x[i], y[i])`.

- [ ] **Permutation test (2 groups)…** — same menu.
      Recipe: `y = income`, `group = gender`, `g1 = Male`, `g2 = Female`,
      `stat = mean difference`, `reps = 5000`.
      Expect: observed difference **−12414.29**, and a permutation p in the
      neighbourhood of the t-test's **.0057**. The permutation null should be centred on
      zero.
      Reference: **SPSS has no true permutation test.** The nearest is the Monte Carlo
      option on an exact test: Analyze ▸ Nonparametric Tests ▸ Legacy Dialogs ▸
      **2 Independent Samples…** → set it up as in §20 → **Exact…** → choose
      **Monte Carlo** with 5000 samples → **Continue** → **OK**. That resamples the
      *rank* statistic rather than the mean difference, so it is close but not the same
      test.
      **Stata** — `permute gender diff = (r(mu_1) - r(mu_2)), reps(5000): ttest income,
      by(gender)`. **R** — `coin::oneway_test(income ~ gender,
      distribution = approximate(nresample = 5000))`.

- [ ] **Power by simulation (t-test)…** — same menu.
      Recipe: `n = 30`, `d = 0.5`, `alpha = 0.05`, `reps = 5000`.
      Expect: power ≈ **0.47** (the analytic value for a two-sample t-test with n = 30
      *per group* is ~.478; for n = 30 *total* it is ~.32 — so **check which n means
      what**, that ambiguity is worth a finding in itself). Power must rise with n and
      with d.
      Reference: **G\*Power** (free) is the field standard and the easiest check:
      *Test family* = **t tests** → *Statistical test* = **Means: Difference between two
      independent means (two groups)** → *Type of power analysis* = **Post hoc** →
      Tail(s) **Two**, Effect size d **0.5**, α **0.05**, Sample size group 1 **30**,
      group 2 **30** → **Calculate** → Power = **0.4779**.
      **SPSS 27+** — Analyze ▸ **Power Analysis** ▸ Means ▸ Independent-Samples T Test.
      **R** — `pwr::pwr.t.test(n = 30, d = 0.5, sig.level = 0.05)`.
      ⚠️ That 0.478 is for n = 30 **per group**. For n = 30 *total* (15 each) power is
      about 0.32. Check which the plugin means by `n` — the ambiguity is worth a finding
      in itself.

## 33. Single-Case Design *(3 items)* 🔢

Hand-rolled in JavaScript — no R at all. Already validated line-by-line against the
**`scan`** R package (`test/sced.test.mjs`, `scripts/validation/sced-reference.R`), so
the job here is to confirm the *shipped UI* produces those numbers.

- [ ] **Non-overlap indices (NAP, PND, Tau-U, IRD)…** — `Single-Case Design ▸ …`
      Recipe: a small AB dataset — `y` (outcome), `phase` (A/B), optional `caseVar` and
      `session`, `direction = increase`.
      Expect: NAP, PND, Tau-U and IRD per case. Free checks that need no software:
      with **complete separation** (every B value above every A value) NAP = **1.0**,
      PND = **100%**, IRD = **1.0**. Flip `direction` to decrease and they should
      invert.
      ⚠️ Two deliberate quirks, both copied from `scan` on purpose: **Tau-U's `VAR_S`
      column will not match its own `Z`** when ties are present (scan reports a
      closed-form SD_S but computes Z from a tie-corrected variance), and **NAP's
      p-value is a normal approximation with continuity correction**, not the exact
      test. Neither is a bug — do not file them.
      Reference: **no SPSS equivalent.** **R** — `install.packages("scan")`, then build
      the data with `scdf()` and run `nap()`, `pnd()`, `tau_u()` and `ird()`. That is the
      package this was ported from line by line, so expect an **exact** match, not an
      approximate one.
      Also: the **Tau-U calculator** at singlecaseresearch.org is the common web tool —
      but ⚠️ expect *it* to differ from both, because it makes different choices about
      baseline trend correction than `scan` does.

- [ ] **Multiple-baseline graph…** — same menu.
      Recipe: same data with a `caseVar` of 3 cases.
      Expect: one stacked panel per case, **staggered phase lines**, and **no line drawn
      across a phase change** (the two SCED drawing conventions, applied by default).
      Panel height, condition labels, points/lines and palette are editable, and edits
      survive save/reload.
      Reference: **R** — `scan::plot(scdf_object)` draws the same two conventions
      (staggered phase lines, no line across a phase change). Compare the shape, not
      pixels. The written authority is the **What Works Clearinghouse** Single-Case
      Design standards, which is where those conventions come from.
      No SPSS equivalent — its charts cannot stagger phase lines per panel.

- [ ] **Multiple-baseline graph, several measures…** — same menu.
      Recipe: add a `measure` variable with 2+ levels.
      Expect: panels grouped by case *and* measure, conventions preserved.
      Reference: **no SPSS equivalent** — its charts cannot stagger phase lines per
      panel. **R** — `scan::plot()` with several dependent variables panels them by case
      and measure the same way; compare the shape, not pixels.

## 34. Text *(7 items)*

Load the **demo (qual)** dataset — it has `response` (open-ended) and `site`.

- [ ] **Word frequency…** — `Text ▸ Word frequency…`
      Recipe: `text = response`, stopwords = English, `topn = 20`, `minlen = 3`.
      Expect: a ranked table; no stopwords ("the", "and") present; nothing shorter than
      3 characters. Set stopwords = none and confirm "the" reappears — that is the test
      that the option is wired, not decorative.
      Reference: **no SPSS equivalent** (IBM’s Text Analytics for Surveys was a separate,
      now-discontinued product). **AntConc** (free) is the quickest GUI check: File ▸
      Open File(s) ▸ load the texts ▸ **Word List** tab ▸ Start — then load a stopword
      list under Settings ▸ Tool Preferences ▸ Word List to reproduce the filtering.
      **R** — `tidytext::unnest_tokens()` + `anti_join(stop_words)` + `count()`, the
      package this wraps.

- [ ] **Word cloud…** — same menu.
      Recipe: `text = response`, `topn = 50`, try each `layout` and `themes`.
      Expect: size proportional to frequency; no overlapping text; the most frequent
      word from the table above is the largest here (cross-check the two).
      Reference: **R** — `wordcloud::wordcloud(words, freq)`. There is no SPSS
      equivalent and no particular standard; the frequencies feeding it are the part
      worth validating, and you already did that in the check above — so cross-check the
      largest word here against the top row there.

- [ ] **Sentiment analysis…** — same menu.
      Recipe: `text = response`, `doc = site`.
      Expect: per-document scores and an overall summary; the **lexicon is named** in
      the output (bing/afinn/nrc give materially different scales — unlabelled scores
      are not interpretable). Write one obviously positive and one obviously negative
      response and confirm the signs.
      Reference: **no SPSS equivalent.** **R** — `tidytext::get_sentiments("bing")`
      (or `"afinn"`, or `"nrc"`) joined to the tokens, the package this wraps.
      **LIWC** (commercial) and **Provalis WordStat** are the established GUI tools.
      ⚠️ bing is ±1 per word, afinn is −5…+5, and nrc is categorical — so the three give
      completely different scales. An unlabelled score is uninterpretable, which is why
      the check above asks that the lexicon be named.

- [ ] **TF-IDF (distinctive terms)…** — same menu.
      Recipe: `text = response`, `doc = site`, `topn = 15`.
      Expect: terms distinctive to each site. A word appearing in **every** document
      has IDF = 0 and must therefore score 0 — a free check.
      Reference: **no SPSS equivalent, and no mainstream GUI** — TF-IDF is a scripting
      job everywhere. **R** — `tidytext::bind_tf_idf(term, document, n)`, the function
      this wraps. **Python** — `sklearn.feature_extraction.text.TfidfVectorizer`.
      ⚠️ Those two use **different IDF smoothing** by default (sklearn adds 1 to both
      numerator and denominator), so expect the *ranking* to agree and the absolute
      values not to. Against the R one, expect an exact match.
      ⚠️ Those two use **different IDF smoothing** by default (sklearn adds 1 to the
      numerator and denominator), so expect the *ranking* to agree and the absolute
      values not to.

- [ ] **Keyword in context (KWIC)…** — same menu.
      Recipe: `text = response`, `term =` a word you know occurs, `window = 5`.
      Expect: each occurrence with 5 words either side; the count matches the word
      frequency table. A term that does not occur gives an empty result with a clear
      message.
      Reference: **AntConc** (free) — Open File(s) ▸ **Concordance** tab ▸ type the
      term ▸ Start, and set the window under Tool Preferences. **NVivo** — Explore ▸
      **Text Search** query ▸ Reference view. **R** —
      `quanteda::kwic(tokens(txt), "term", window = 5)`.

- [ ] **Topic modeling (LDA)…** — same menu.
      Recipe: `text = response`, `k = 3`, `topn = 10`.
      Expect: 3 topics with top terms, and per-document topic probabilities **summing
      to 1** per document. LDA is stochastic — run twice and note whether a seed is
      exposed.
      Reference: **no SPSS equivalent.** **R** — `topicmodels::LDA(dtm, k = 3)`, the
      package this wraps, then `tidy(fit, matrix = "beta")` for the top terms and
      `matrix = "gamma"` for the per-document probabilities. **MALLET** (Java,
      command-line) is the other standard.
      ⚠️ LDA is stochastic. Fix `control = list(seed = 1)` in R and check whether the
      plugin exposes a seed at all; without one, History cannot replay it.

- [ ] **Content-analysis dictionary…** — same menu.
      Recipe: write a small dictionary file (categories → word lists), `text =
      response`, `dict =` that file, `doc = site`.
      Expect: counts per category per document; a word in two categories counts in
      both; an empty category reports 0 rather than being dropped.
      Reference: **no SPSS equivalent.** **LIWC** (commercial) is the reference
      implementation — load the texts, pick or load a dictionary, Analyze. **Provalis
      WordStat** and **Yoshikoder** (free) are the other GUI tools. **R** —
      `quanteda::dfm_lookup(dfm, dictionary(list(cat1 = c("word1", "word2"))))`.
      Expect too: a word listed in two categories must count in **both**, and an empty
      category must report 0 rather than vanishing — both checkable by hand on a
      three-word dictionary, which is the quickest validation here.
      Expect too: a word listed in two categories must count in **both**, and an empty
      category must report 0 rather than vanishing — both are easy to check by hand on a
      three-word dictionary.

## 35. Analyze — mixture models *(3 items)*

- [ ] **Latent class analysis (categorical items)…** — `Analyze ▸ …`
      Recipe: `items = gender, education, region`, `classes = 2`, a fixed `seed`,
      `save = yes`.
      Expect: class sizes/proportions, item-response probabilities per class,
      **AIC / BIC / log-likelihood**, and — with `save` — a new class-membership
      variable in the dataset. Re-run with the **same seed** → identical output
      (that is the point of exposing the seed). Then `classes = 3` and confirm BIC
      changes.
      Reference: **no SPSS equivalent.** **Latent GOLD** is the most approachable GUI
      (File ▸ Open data ▸ right-click the dataset ▸ Cluster model ▸ set classes ▸
      Estimate). **Mplus** is the field standard:
      `VARIABLE: CLASSES = c(2); CATEGORICAL = u1-u3; ANALYSIS: TYPE = MIXTURE;`.
      **R** — `poLCA(cbind(u1, u2, u3) ~ 1, data, nclass = 2)`, the package this wraps.
      Expect too: compare **BIC** across class counts rather than any single solution —
      that is how the class number is actually chosen.

- [ ] **Latent profile analysis (continuous items)…** — same menu.
      Recipe: spatial demo, `items =` the four numeric variables, `classes = 2`, seed.
      Expect: class means per item, proportions, fit indices, saved membership.
      Reference: **no SPSS equivalent.** **Latent GOLD** for a GUI (File ▸ Open data ▸
      right-click the dataset ▸ **Cluster** model ▸ set the number of classes ▸
      **Estimate**). **Mplus** — the same MIXTURE setup as LCA without the CATEGORICAL
      line. **R** — `mclust::Mclust(items, G = 2)` or `tidyLPA::estimate_profiles()`;
      CrossTab wraps `flexmix`.

- [ ] **Growth mixture model (classes of trajectory)…** — same menu.
      Recipe: `waves = t1, t2, t3`, `classes = 2`, seed.
      Expect: a distinct intercept/slope trajectory per class, class proportions, fit
      indices.
      Reference: **Mplus** — this is its signature analysis:
      `CLASSES = c(2); ANALYSIS: TYPE = MIXTURE; MODEL: %OVERALL% i s | t1@0 t2@1 t3@2;`.
      **R** — `lcmm::hlme(..., ng = 2, mixture = ~ time)`, or `flexmix` as wrapped here.
      No SPSS equivalent, with or without Amos.
## 36. Qualitative coding (CAQDAS)

Qualitative work is first-class here, not a side feature — test it at the same depth as
the statistics. Load **demo (qual)** to start (`response`, an open-ended text column,
and `site`), then bring in your own material.

### 36.1 Getting material in *(5 importers)*

All under **File ▸ Import data…**, each producing **one row per file**.

- [ ] **Text files** (`.txt`, `.md`, …)
      Recipe: **File ▸ Import data…** → "Text files → one row per file…" → select three
      `.txt` files (or a folder).
      Expect: three cases, one per document, each with the **filename kept as a label**
      and the full text in a column.

- [ ] **Transcripts** (VTT, SRT, timestamped text)
      Recipe: same picker → "Transcripts (VTT, SRT, timestamped text)…" → pick a `.vtt`
      or `.srt`.
      Expect: one row per file, with the **timestamps parsed into a usable structure** —
      not left as raw text with `00:01:23.456 -->` lines in the middle of sentences.

- [ ] **Image files** (PNG, JPEG, …)
      Recipe: same picker → "Image files…" → pick two images.
      Expect: two rows; each image stored as a **project asset** the row references; the
      image displays in the coding view.

- [ ] **Audio files** (MP3, WAV, M4A, …)
      Recipe: same picker → "Audio files…" → pick an audio file.
      Expect: one row; the audio **plays** in the coding view with a working scrub bar.

- [ ] **Video files** (MP4, WebM, MOV, …)
      Recipe: same picker → "Video files…" → pick a video.
      Expect: one row; the video plays with a working scrub bar.

- [ ] **A folder import on iPadOS**
      Recipe: try the text-files importer on iPadOS Safari.
      Expect: it may not be offered — that is an OS limitation, worth noting rather than
      filing.

### 36.2 Transcription (on-device)

- [ ] **Transcribe an interview**
      Recipe: import an audio file (§36.1), then run the transcription from the
      **Transcripts** tab.
      Expect: progress; a transcript with timestamps; the audio stays linked, so clicking
      a line plays that moment.

- [ ] **A whole interview, not a clip**
      Recipe: run a **full-length** recording, end to end.
      Expect: it completes. *(This item is here deliberately: every shortcut taken in this
      area has produced a confidently wrong answer. A 20-second clip proves nothing about
      a 50-minute file.)*

- [ ] **Language handling**
      Recipe: transcribe something **not in English**.
      Expect: either correct detection or an explicit language choice. The one thing that
      must not happen is silently transcribing it as English — which is exactly what a
      hardcoded default once did here, so test it rather than assuming.

- [ ] **Offline transcription**
      Recipe: see §11 — and clear the `transformers-cache` first.
      Expect: transcription completes with no network at all. Covered in full there; it
      is listed here so the qualitative pass is self-contained.

### 36.3 The Coding workspace *(the `Coding` tab)*

- [ ] **Build a codebook**
      Recipe: **Coding** tab → create three codes → nest two of them under a theme →
      rename one → reorder them → delete one. Reload the page.
      Expect: all of it survives. The codebook lives in the project.

- [ ] **Multiple codebooks**
      Recipe: create a second codebook and switch between them.
      Expect: codes stay with their own codebook; analyses can target **the open
      codebook** or **every codebook in the project** (the quantitise dialogs offer that
      choice).

- [ ] **Code a passage**
      Recipe: select some text in a document → apply a code. Then select an **overlapping**
      span and apply a different code.
      Expect: both highlights persist and both are visible; overlapping codings are
      allowed.

- [ ] **Anchoring survives an edit**
      Recipe: code a passage in the middle of a document. Then **edit the document text
      *before* that passage** — add a sentence at the top. Reload.
      Expect: the coding is **still on its original passage**, not shifted by the number
      of characters you inserted. This is the anchor-resolution path
      (`docs/ARCHITECTURE-coding-anchors.md`) and the thing here most likely to break
      silently.

- [ ] **Code media**
      Recipe: apply a code to a **time range** in an audio or video file, and to a
      **region** of an image.
      Expect: both are recorded and both are shown when you come back to them.

- [ ] **Memos**
      Recipe: attach a memo to a code, to a coded passage, and to a whole document.
      Expect: all three stick and are findable.

- [ ] **Codebook export and import (CSV)**
      Recipe: export the codebook to CSV, add a row in a spreadsheet, change an existing
      code's description, re-import.
      Expect: the new code arrives; the changed description updates; **the existing code
      is not duplicated** — merging is add-wins.

- [ ] **QDPX import**
      Recipe: export a small project from NVivo / MAXQDA / ATLAS.ti as `.qdpx`, then
      import it here.
      Expect: documents, codebook **and codings** all arrive — not just the documents.

- [ ] **QDPX export**
      Recipe: export your coded project to `.qdpx`, then open that file in NVivo.
      Expect: it loads with documents, codes and codings intact. *(This is the comparison
      still outstanding on your side.)*
      Reference: **REFI-QDA** is the standard — NVivo, MAXQDA, ATLAS.ti and Dedoose all
      read and write it, so any of them is a valid check.

### 36.4 Quantitising — the qual→quant bridge *(5 shapes)*

Each produces a **new dataset** you can then run statistics on, which is the whole
point of it.

- [ ] **A column per code**
      Recipe: in the Coding workspace, run the quantitise action and choose **a column
      per code**; pick counts or 0/1.
      Expect: one indicator column per code, one row per document. Totals should match
      what you coded — count one code by hand and check.

- [ ] **A row per passage**
      Recipe: quantitise → **a row per passage**; set "Carry across" to **every other
      column of the source**, then run it again with **nothing**.
      Expect: one row per coding, with the code, the document and the passage text; the
      carry-across choice visibly changes how many columns you get.

- [ ] **A series across occasions**
      Recipe: quantitise → **a series across occasions** → set `Case is`, `Occasion is`
      and `Measures are`.
      Expect: a series shaped for the repeated-measures (§16) and SCED (§33) analyses —
      try feeding it straight into one of those.

- [ ] **Which codes occur together**
      Recipe: quantitise → **which codes occur together** → set "Two codes occur together
      when" to **they appear in the same document**, run it, then run it again with
      **their passages overlap**.
      Expect: a co-occurrence matrix whose **diagonal is each code's own frequency**, and
      **two different answers** from the two definitions. Identical answers mean the
      option is not wired.

- [ ] **Themed word cloud**
      Recipe: quantitise → **themed word cloud**.
      Expect: one cloud per theme, with the theme's codes driving it.

- [ ] **Then run statistics on the result**
      Recipe: quantitise to a column per code, then run **Descriptive Statistics ▸
      Crosstabs…** on two of the resulting columns, and **Scale ▸ Reliability analysis…**
      across all of them.
      Expect: it behaves like any other dataset — because it is one.
      ⚠️ A **bin/convention** question for quantitising is deliberately **not built**, and
      is parked until a real user needs it. Do not file its absence.

### 36.5 Collaboration on codings

- [ ] **Two coders, same project**
      Recipe: invite a second machine (§9), then have both code the same documents —
      some of the same passages, some different.
      Expect: codings merge with no lost work, and **each coding is attributed to its
      coder**.

- [ ] **Then compare them**
      Recipe: **Scale ▸ Inter-coder agreement from codings…** → metric = Cohen's kappa.
      Expect: agreement per code, plus the **specific disagreements listed** so you can go
      look at them (#202). With only one coder present it should say so rather than
      report a spurious perfect agreement.

## 37. Other workspaces

- [ ] **Map workspace**
      Recipe: load the **spatial** demo, click the **Map** tab, then work through its
      verbs in order: **Load boundaries** (the demo ships Sacramento ZIP boundaries) →
      **Shade by variable** (`income_k`) → **Assign regions** → **Analyse selection** →
      **Export map** → **Clear** → **Restart**.
      Expect: each verb does what it says; **Analyse selection** narrows what the
      statistics see (run Descriptives before and after and compare N); Export produces a
      usable image; Clear and Restart leave a clean state rather than a half-torn-down
      one.
      Reference: **GeoDa** for the analytical side (§29).

- [ ] **Decisions workspace** 🔢
      Recipe: click the **Decisions** tab → add three options and three weighted criteria
      → score them → read the ranking. Then change one weight.
      Expect: a ranked result that re-ranks sensibly. **Hand-rolled arithmetic:** compute
      one option's score by hand as Σ (weight × rating) and check it; confirm the weights
      normalise (that scores do not silently depend on whether the weights sum to 1).

- [ ] **Hello Workspace**
      Recipe: click the **Hello WS** tab, change whatever state it offers, reload.
      Expect: it loads, saves its state and restores it. Its whole job is to demonstrate
      the workspace API, so a failure here implicates **every** workspace — check this
      one first if another workspace misbehaves.

- [ ] **Nothing is written on mount**
      Recipe: in each workspace in turn — put some state in it, leave, come back, and then
      **reload immediately without touching anything**.
      Expect: the state is still there. A mount-before-hydrate clobber (writing empty
      state on open, wiping what was stored) was a real bug here, and it only shows if you
      reload right after opening rather than after editing.

---

## 38. Known-legitimate differences from SPSS

Check this list before filing an arithmetic finding. Every row is a case where CrossTab
and SPSS can both be right.

| Area | SPSS | R / CrossTab | What to do |
|---|---|---|---|
| **Quartiles / percentiles** | Its own definition (= R `type = 6`) | R's default is `type = 7` | On `age`: 31.75/50.5 vs 32.25/49.75. Decide which the app claims and be consistent. |
| **Levene's test** | Centred on the **mean** | `car::leveneTest` defaults to **median** (Brown–Forsythe) | Compare like with like; the figures quoted in this doc are mean-centred. |
| **Factorial ANOVA SS** | **Type III** | `aov()` gives **Type I** | Only differs when unbalanced — which the demo is. Type III is already validated here. |
| **Ordinal regression signs** | PLUM convention | `MASS::polr` uses the opposite | A uniform sign flip is expected. |
| **Logistic reference level** | Models the **higher** code | Depends on the `modelled` input | Always check which level is modelled before comparing. |
| **Chi-square on 2×2** | Adds Yates continuity correction and Fisher's exact | `chisq.test` corrects by default; `correct = FALSE` does not | Compare the row with the matching label. |
| **Kendall's tau** | tau-b | `cor.test` gives tau-b; tau-a/tau-c exist | Confirm the variant. |
| **Mann-Whitney p** | Asymptotic (tie-corrected) **and** exact for small n | `exact =` toggles; continuity correction separate | Three p-values are possible; match the method. |
| **Cronbach's alpha** | "Alpha" = raw; "Standardized Items" = second row | Both computable | .1473 vs .1608 on the test battery. |
| **Factor loading signs** | Arbitrary | Arbitrary | A flipped column is not a difference. |
| **Survey SEs** | Complex Samples module; plain `WEIGHT BY` gives **wrong** SEs | `survey` package is design-based | Never compare a design-based SE to a `WEIGHT BY` one. |
| **Mixed models** | MIXED, Satterthwaite df | `lme4` + `lmerTest` | Compare estimates and variances first; df methods differ. |
| **Random-start methods** (k-means, LDA, bootstrap, LCA) | Own seeds | Own seeds | Only comparable with a fixed seed; otherwise compare distributions. |

And three things that are **expected gaps**, not bugs:

- `.por` / `.xpt` / `.sas7bdat` are **read-only** — no write support.
- `.ct-edit`'s `min-width: 380px` breaks dialog layout below ~404px (§13).
- Quantitising bin conventions are deliberately unbuilt (§36.4).

---

## 39. Still outstanding from my side

Two things I built but could not verify in the browser — a Steam window was
occluding Chrome, which freezes the renderer and makes every timed check
unreliable. Both now have full recipes where they belong rather than as separate
entries here, so there is nothing extra to tick:

- **#162** — the preset dropdown, Save / Rename / Delete, and the missing-plugin
  note. See the **Presets** check in [§7](#7-plugins--lifecycle-and-the-manager).
- **#190** — the analysis-row ▲ / ▼ arrows and the busy state. See the **Reorder an
  analysis row** check in [§6](#6-history-timeline-and-the-do-file-editor).

They are the two places to look first if something feels off.

---

## Findings

| # | Step | What I saw | Data / analysis | Screenshot |
|---|---|---|---|---|
|  |  |  |  |  |
