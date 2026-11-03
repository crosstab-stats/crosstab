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
      Recipe: what to click, with the exact variables to pick.
      Expect: what correct output looks like.
      Reference: how to get the same number out of other software.
```

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

- [ ] **Serve the app.** `npm run dev` → <http://localhost:8080/>. The committed dev
      server sets the COOP/COEP headers WebR needs; a plain static server will not do.
- [ ] **Activate the plugins.** Edit ▸ Plugins… ▸ tick everything (or the categories
      you are about to test). **Nothing below appears in a menu until its plugin is
      activated** — an empty menu bar is the expected state on a fresh profile, not a
      bug. *(Note: I activated all 64 in your browser while mapping the menus, so this
      may already be done.)*
- [ ] **Load the demo data.** Launcher ▸ **demo (quant)**, or File ▸ New project ▸ demo.
      30 cases: `gender` (1 Male / 2 Female), `education` (1 High school / 2 Bachelor /
      3 Postgraduate), `region` (1 North / 2 Central / 3 South), `age`, `income`.
      **`income` carries user-missing codes −99 and −98**, and two cases are −99, so
      every income statistic should run on **N = 28**, not 30. That is the single most
      useful thing in the dataset: if an analysis reports N = 30 for income, it is
      ignoring designated missing values.
- [ ] **Get the same data into SPSS.** File ▸ Export data… ▸ SPSS (.sav) — that keeps
      the value labels and the missing codes, so SPSS applies them too. (CSV works but
      you then have to re-declare −99/−98 as missing in SPSS, which is a common source
      of fake mismatches.)
- [ ] **For the battery analyses** (reliability, factor, cluster) load the **spatial
      demo** instead: 60 cases, `satisfaction` (1–10), `commute_min`, `income_k`,
      `household_size`, plus `zip_code` and `district`. Also deterministic.
- [ ] **Desktop R is the tie-breaker.** `C:\Program Files\R\R-4.6.0\bin\Rscript.exe`.
      For a wrapper plugin you can extract the exact R it generated (Edit ▸ History ▸
      the analysis row shows the R) and run that same text locally — that should match
      to the last digit, which is a far sharper test than eyeballing SPSS.

> **The reference scripts.** `scripts/validation/demo-reference.R` and
> `demo-reference-spatial.R` regenerate every number quoted in this document. Run them
> against the CSVs exported from the two demo datasets if you ever want to re-derive
> them.

---

## 1. Boot and launcher

- [ ] **Cold load.** Hard-reload (Ctrl-Shift-R).
      Expect: launcher appears; no error overlay; no reload loop. On GitHub Pages
      *one* self-reload at first visit is expected (the service worker claiming
      cross-origin isolation); a repeating loop is the red flag.
- [ ] **Launcher shows the plugin list** with load/activate state, and the discipline
      pinning.
      Expect: activation ≠ merely catalogued; pinning a discipline filters the list.
- [ ] **Onboarding path.** Launcher ▸ demo (quant) / demo (qual) / blank.
      Expect: each lands in a usable project; the demo/blank seeds are **not** autosaved
      as if they were your work (only real edits create a save).
- [ ] **Boot survives a broken plugin.** Edit ▸ Plugins… ▸ Add from file… ▸ pick a
      deliberately malformed `.js`.
      Expect: it lands in `failed` with a readable reason; the app still boots; other
      plugins unaffected.
- [ ] **Boot survives a broken `deploy.json`.** Put garbage in it, reload.
      Expect: app boots with defaults. Nothing in that file may break a boot.

## 2. Projects and persistence

- [ ] **Autosave.** Change a value in the Data grid, wait, reload the page.
      Expect: the change is still there.
- [ ] **New project / switch / recent.** File ▸ New project, then File ▸ Recent projects.
      Expect: switching keeps each project's data, output and codebook separate.
- [ ] **Rename.** File ▸ Manage projects… ▸ inline-rename.
      Expect: sticks across reload.
- [ ] **Delete → recycle bin → restore.** Manage projects… ▸ delete ▸ restore.
      Expect: restores with data and output intact.
- [ ] **Store in… (location).** File ▸ Store in… ▸ pick a local folder (File System
      Access) / OPFS / Dropbox / WebDAV.
      Expect: the project moves; the catalog still lists it; reload finds it.
- [ ] **Storage pressure.** Fill storage (or simulate), keep working.
      Expect: a clear warning, not a silent write failure.
- [ ] **Project health.** File ▸ Manage projects… on a project with a missing asset.
      Expect: health reports the problem rather than failing to open.
- [ ] **Copy dataset / copy to project.** File ▸ Copy dataset…
      Expect: the dataset (and its variable metadata) arrives in the target project.

## 3. Settings — including the "two places must agree" cases

The Settings screen is **Edit ▸ Settings…**. Every row either edits in place, routes
you to the real control, or reports a secret's state without printing it.

- [ ] **Width.** Open it on a wide window.
      Expect: ~80% of the viewport up to 900px; no horizontal scrollbar on the page;
      narrow windows (<700px) fall back to 92vw. *(#208)*
- [ ] **Screen layout** — set to Small screen mode.
      Expect: layout changes immediately; **Edit ▸ ☐ Small screen mode** now shows
      ticked. Set it back from the *menu* and the Settings row follows. *(Two places,
      one value.)*
- [ ] **Variable list order** — set to "Name (A–Z)". *(#210)*
      Expect: the Data grid columns AND the Variables tab re-order immediately, and the
      **toolbar dropdown above each variable list** now reads the same choice. Change it
      from the toolbar instead → the Settings row agrees. Try `Name (Z–A)` and `Label`.
- [ ] **Show variables as** — set to "Name".
      Expect: grid headers drop the label half; toolbar dropdown agrees both ways.
- [ ] **Variable pickers offer** — set to "All variables". *(#205)*
      Expect: a *categorical* analysis (e.g. Crosstabs) now offers `income` even though
      it is scale-coded. Set back to "Fitting variables" → `income` disappears from that
      picker again. The setting is remembered across reloads.
- [ ] **Frequency weight (project-level)** — pick a variable. *(#207)*
      Expect: it writes an **op in the project log** — Edit ▸ History shows a weight
      step, Undo reverses it, and the row agrees with **Transform ▸ Weight cases…**.
      This is the one that must behave like a dataset property, not a device preference.
- [ ] **Scope hint.** Read the screen.
      Expect: it distinguishes device settings from project settings, so the weight row
      is not mistaken for a preference. *(#206)*
- [ ] **Encrypt at rest** — a routed row with a `Configure…` button.
      Expect: opens the encryption dialog; the row then reports the new state.
- [ ] **TURN server** — `Configure…` / `Change…`. *(#209)*
      Expect: opens an editor; fields are **never pre-filled** with the stored
      credential; it refuses a `stun:` URL and refuses a half-filled credential pair;
      the row reports only *Configured* / *Not configured* — the credential appears
      nowhere on screen.
- [ ] **Rendezvous relays** — a multi-line box.
      Expect: blank lines are not entries; round-trips.
- [ ] **Debug logging** — tick it.
      Expect: **Edit ▸ ☑ Debug logging** agrees; Edit ▸ Save debug log… produces a file.
- [ ] **A lifecycle flag stays hidden.** Nothing like `screen.autoNoteSeen` appears
      anywhere on the screen.
- [ ] **Clearing restores the default**, not a stored copy of it: clear Screen layout
      → the viewport decides again.

## 4. Data import and export (codecs)

All through the single searchable picker — **File ▸ Import data…** and
**File ▸ Export data…**. There are deliberately no per-format menu items. *(#113)*

- [ ] **The picker itself.** Open Import data…
      Expect: one grouped, searchable list; typing "stata" finds the right entry;
      formats whose plugin is not activated are offered and activate on use.
- [ ] **CSV** `.csv/.tsv/.txt` — import and export.
      Expect: delimiter and header detection; types inferred; round-trips.
- [ ] **Excel** `.xlsx/.xls/.xlsm/.xlsb` — import and export.
      Expect: sheet choice; round-trips.
- [ ] **SPSS/Stata/SAS (read)** `.sav/.zsav/.dta/.por/.xpt/.sas7bdat`.
      Expect: **variable labels, value labels and missing codes all arrive.** This is
      the one to test hardest — import the `.sav` you exported in §0 and confirm
      `income`'s −99/−98 are still designated missing.
- [ ] **SPSS/Stata/SAS — choose variables.** The `readstat-pick` entry.
      Expect: pick a subset of a wide file; only those columns import.
- [ ] **SPSS (.sav) export** and **Stata (.dta) export**.
      Expect: written files open in SPSS/Stata with labels intact. (Read support covers
      more formats than write — `.por/.xpt/.sas7bdat` are read-only. Expected.)
- [ ] **Parquet** `.parquet` — import and export.
- [ ] **JSON Lines** `.ndjson/.jsonl` — import and export.
- [ ] **Wikipedia table import.** File ▸ Import data… ▸ Wikipedia table…
      Expect: paste an article URL, pick a table, it arrives as a dataset.
- [ ] **A large file.** Import something in the hundreds of MB.
      Expect: streams with progress; does not freeze the tab; memory does not explode.
      *(Known open follow-ups: an ultra-wide file path, and a multi-GB write test.)*
- [ ] **Swap, not replace.** Import over an existing dataset. *(#no-inplace-replace)*
      Expect: it offers **Swap** — a new dataset, old one binned — and never silently
      clears the live one.

## 5. Transform

- [ ] **Compute variable…** — e.g. `income_k = income / 1000`.
      Expect: new variable; History step; undoable.
- [ ] **Recode into new variable…** — `age` into bands.
      Expect: new variable, original untouched, value labels settable.
- [ ] **Count values within cases…**
      Expect: a count variable across the chosen columns.
- [ ] 🔢 **Aggregate / collapse…** — `groupby = education`, `measures = income`,
      `func = mean`.
      Expect: 3 rows; **30350.00 / 43836.36 / 60355.56** (this is hand-rolled JS
      arithmetic — check it against the ANOVA group means in §8).
      Reference: SPSS `AGGREGATE /BREAK=education /income_mean=MEAN(income).`
- [ ] **Select cases…** — e.g. `age > 40`.
      Expect: filtered analyses honour it; the filter is visible and reversible.
- [ ] **Extract columns to a new dataset…**
- [ ] **Join with another dataset…**
      Expect: key choice, join type, captured in History as one undoable step.
- [ ] **Weight cases…** — set `income`… then a proper weight.
      Expect: weighted counts in Frequencies/Crosstabs; the Settings screen's
      Frequency weight row agrees; History records it.
- [ ] **Run R script…** — `summary(data)` then something returning a data frame.
      Expect: output and plots shown; a returned frame can be imported as a **new**
      dataset (the reverse bridge). `data` is the active dataset.

## 6. History, timeline, and the do-file editor

- [ ] **History panel.** Edit ▸ History…
      Expect: numbered rows; data steps and analyses interleaved by anchor; a cursor
      that moves across both tiers.
- [ ] **Undo / Redo** across a mixed sequence (recode, analysis, recode).
      Expect: order respected; analyses re-run or mark stale rather than silently
      showing old numbers.
- [ ] **Reorder an analysis row** (the ▲▼ arrows) and watch the busy state. *(#190 —
      still unverified by me, blocked earlier by a window-occlusion freeze.)*
      Expect: the row moves, dependent rows re-run, and the busy indicator appears and
      clears. Nothing is left stale-but-looking-fresh.
- [ ] **Branch discard.** Move the cursor back, do something new.
      Expect: the abandoned branch is discarded explicitly, with a warning — not
      silently rewritten.
- [ ] **Syntax mode (✎).** History ▸ Syntax.
      Expect: the whole timeline as editable CrossTab syntax, **losslessly** — switch
      to text and back without drift. **Run** rebuilds the data and replays the
      analyses.
- [ ] **`.ctscript` export / import.** Round-trip a project's script.
- [ ] **Stata `.do` export and import.** File ▸ Export analysis script… ▸ Stata.
      Expect: best-effort but runnable; analyses included; re-importing reproduces the
      steps. (Best-effort is the contract — it is a translation, not a guarantee.)
- [ ] **SPSS `.sps` export and import.** Same.
- [ ] **R syntax export.** Same, via the R Syntax Export plugin.
- [ ] **A stale analysis.** Change a variable an analysis used.
      Expect: the analysis is marked stale; its old output is still auditable; re-run
      updates it.

## 7. Plugins — lifecycle and the manager

Vocabulary matters here: *catalogued / registered / enabled / activated / failed /
referenced*. "Loaded" and "active" are not states.

- [ ] **Manager.** Edit ▸ Plugins…
      Expect: every plugin with its state; enable ≠ activate; a failed plugin says why.
- [ ] **Activate / deactivate** one.
      Expect: its menu items appear and disappear accordingly.
- [ ] **The 🔍 how-to.** Click it on any plugin.
      Expect: the one-line `howto` for that plugin. All 60-odd builtins have one.
- [ ] **Add from file** and **Add from URL**.
      Expect: URL plugins are namespaced by host; file/authored ones get
      `plugin:<id>` isolation. A name collision does not let one plugin read another's
      data.
- [ ] **Create plugin…** Edit ▸ Create plugin…
      Expect: a working scaffold you can run immediately; then **Export plugin** →
      re-import it.
- [ ] **Presets.** On any analysis dialog: the preset dropdown plus Save / Rename /
      Delete. *(#162 — still unverified by me, same occlusion block.)*
      Expect: saving a preset round-trips the inputs; renaming and deleting behave;
      **a preset naming a plugin that is no longer present shows a clear note**, not an
      error.
- [ ] **Cross-plugin reads.** *(#196)*
      Expect: a collection declared `read: 'owner'` is invisible to other plugins; one
      declared `read: 'public'` is listed by `items.publicCollections()`. CAQDAS
      codings are public (they are analysis substrate) — Inter-coder agreement from
      codings… proves it.
- [ ] **Site plugins.** With a `deploy.json` declaring a site plugin directory.
      Expect: host-namespaced, provided-not-privileged — a site plugin gets no more
      authority than any other.
- [ ] **R package resolution.** Activate a plugin needing several R packages, run it.
      Expect: packages download once with progress; a package that cannot load in WebR
      fails with a readable message, not a hang. (There is a hard ceiling around ~20
      concurrently-loaded shared objects — a failure naming an innocent package is a
      known symptom of hitting it.)

## 8. Output and export

- [ ] **Output pane.** Run anything.
      Expect: tables, text and charts in order; a caption naming the dataset and any
      weight.
- [ ] **Clear output.**
- [ ] **Output outlives its maker.** Run an analysis, then **deactivate that plugin**,
      then reload.
      Expect: the saved output still renders and is still auditable — the artefact and
      the R that computed it were persisted, with provenance captured at write time.
      Worst case it degrades to static plus a plain note. It must never vanish or throw.
- [ ] **Export output… ▸ HTML.** Expect: self-contained file; charts included.
- [ ] **Export output… ▸ Word (.docx).** Expect: opens in Word; tables are real tables.
- [ ] **Export output… ▸ R Data.** Expect: loads in R.
- [ ] **Print / Save PDF.** Expect: sane page breaks. *(Do this by hand — never under
      automation.)*
- [ ] **Chart editing.** On any chart: the control panel.
      Expect: titles, axis titles, legend, palette, size all editable **after** the fact,
      and the edits survive save/reload. Charts are models the host renders, not baked
      images — except the R-baked ones below.
- [ ] **R-baked figures.** A plugin that returns an SVG from R (Ecology, Ordination,
      SNA, Spatial, Time Series, VAR).
      Expect: the R SVG sits as a graphic layer *under* host-drawn title and legend,
      which stay editable; and the **"Recompute the figure"** controls re-run R with new
      parameters. *(#131/#201)*
- [ ] **Colour scale.** On a chart with a continuous scale.
      Expect: a classed colour bar in the legend layer.
- [ ] **Chart export size.** Export a chart at a chosen size.
      Expect: the SVG/PNG honours it.

## 9. Collaboration

- [ ] **Invite.** File ▸ Copy invite link… on machine A; open it on machine B.
      Expect: both see the project; presence shows both.
- [ ] **Concurrent edits, three tiers.** Edit data on A, codebook on B, a spatial
      layer on both.
      Expect: the op log merges three-way; the codebook is **add-wins**; spatial state
      is last-writer-wins. Each tier's rule is the owner's, declared per tier.
- [ ] **Conflict UI.** Force a genuine conflict.
      Expect: a readable conflict presentation, not a silent clobber.
- [ ] **Per-user state** keys by author, so two people's cursors/selections do not
      fight.
- [ ] **TURN relay.** With a TURN server configured, connect two peers that cannot see
      each other directly.
- [ ] **Sharing settings.** File ▸ Sharing…

## 10. Encryption at rest

- [ ] **Export protection.** File ▸ Encryption settings… ▸ protect exports; export a
      project.
      Expect: the file needs the passphrase to open.
- [ ] **Local/OPFS protection** (opt-in) — a per-project passphrase.
      Expect: the catalog stays readable (so you can see your project list) while the
      project content does not; the key is held only for the active project; a save
      guard prevents writing plaintext over a protected project.
- [ ] **Protect / unprotect / change passphrase.**
      Expect: all three work; changing re-wraps rather than re-encrypting from scratch.
- [ ] **Closed ≠ live.** Expect: this protects *closed* projects. A live session in an
      open tab is not protected, by design — confirm the UI says so and does not
      overclaim.
- [ ] **Wrong passphrase.** Expect: a clear refusal, no data loss.

## 11. Offline and air-gap

- [ ] **"Make available offline".** Toggle it on; let it finish.
      Expect: progress through the asset groups, including the **R package closure**
      prefetch for the plugins you selected.
- [ ] **Airplane mode.** Reload, run a cached analysis.
      Expect: it runs. WebR, the packages and the app shell all come from cache.
- [ ] **Transcription offline.** With offline caching on, run a transcription in
      airplane mode.
      Expect: works — the transformers.js library, the onnxruntime WASM **and the
      model weights** are all cached. (Clear the `transformers-cache` before testing a
      negative control; it will happily serve a model you thought you deleted.)
- [ ] **Air-gapped deployment.** `node scripts/vendor-assets.mjs`, serve with
      `assets: local`.
      Expect: no network requests at all — check DevTools ▸ Network with a filter for
      anything off-origin. See `docs/OFFLINE.md`.
- [ ] **PWA install.** Install to desktop/home screen; launch from the icon.

## 12. Help and how-to

- [ ] **How to…** Help ▸ How to…
      Expect: a searchable index; 92 topics; opening one renders its prose.
- [ ] **A dialog's ⓘ.** Open any analysis dialog and click ⓘ.
      Expect: the topic for *that* item, falling back to the plugin's entry page.
- [ ] **Syntax guide…** Help ▸ Syntax guide…
      Expect: the grammar plus a **live** list of `run id.fn` calls for the plugins you
      actually have activated.
- [ ] **Getting around…**, **Caveats & limits…**, **Report a bug…**,
      **Ask a question…**, **Source code…** all open correctly.
- [ ] **A third-party plugin's how-to.** Expect: a plugin shipping `howtoFile` +
      `howtoIndex` gets exactly the same placement, search and rendering as a builtin.
      Nothing privileged about core.

## 13. Accessibility and small screens

- [ ] **Keyboard only.** Tab through menus, dialogs, the grid.
      Expect: everything reachable; focus always visible; Escape closes dialogs.
- [ ] **Contrast.** Expect: 0 failures (this passed a measured sweep — treat a new
      failure as a regression).
- [ ] **Reflow at 320px** (WCAG 1.4.10). Narrow the window right down.
      Expect: no horizontal scrolling of the page; small-screen mode gives command
      parity (53/53).
      ⚠️ **One known leak:** `.ct-edit` has a `min-width: 380px` that breaks dialog
      layout below about 404px. Expected until fixed — don't re-file it.
- [ ] **Screen reader** on a results table and a dialog.
- [ ] **Small screen mode by hand** (Edit ▸ Small screen mode) on a large window.
      Expect: every command still reachable.

---
## 14. Descriptive Statistics *(6 items)*

- [ ] **Frequencies…** — `Descriptive Statistics ▸ Frequencies…`
      Recipe: `vars = gender, education, region`. Leave Statistics empty.
      Expect, exactly: `gender` 15 / 15 (50.0 / 50.0 %); `education` 8 / 12 / 10
      (26.7 / 40.0 / 33.3); `region` 11 / 10 / 9 (36.7 / 33.3 / 30.0). Value labels
      shown (Male/Female, High school/Bachelor/Postgraduate, North/Central/South),
      cumulative percent reaching 100.0.
      Reference: SPSS `FREQUENCIES VARIABLES=gender education region.`

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
      Reference: SPSS `FREQUENCIES VARIABLES=age /STATISTICS=ALL.`

- [ ] **Frequencies, weighted** — same dialog, `weight` input.
      Recipe: `vars = education`, `weight =` any positive numeric variable.
      Expect: counts become weighted case counts (N = sum of weights, non-integer is
      fine); **the caption names the weight**; cases with missing/zero/negative weight
      are dropped entirely, not counted as fractions.
      Reference: SPSS `WEIGHT BY w.` then `FREQUENCIES VARIABLES=education.`

- [ ] **Crosstabs…** — `Descriptive Statistics ▸ Crosstabs…`
      Recipe: `rowvar = gender`, `colvar = education`, percentages = row, measures =
      chi-square + Cramér's V.
      Expect, exactly: counts row 1 (Male) **7 / 6 / 2**, row 2 (Female) **1 / 6 / 8**.
      Expected counts **4 / 6 / 5** in both rows. Pearson χ² = **8.1000**, df = **2**,
      p = **.0174**. Cramér's V = **.5196**. Likelihood-ratio χ² = **8.9169**, p = **.0116**.
      A warning that some expected counts are < 5 is correct and should be shown.
      Reference: SPSS `CROSSTABS /TABLES=gender BY education /STATISTICS=CHISQ PHI
      /CELLS=COUNT EXPECTED ROW COLUMN.`

- [ ] **Crosstabs 2×2 and the continuity correction** — the case where SPSS adds a row.
      Recipe: first `Transform ▸ Recode` education into `hs` (1 → 1, else 2). Then
      Crosstabs `gender × hs`.
      Expect, exactly: counts **7 / 8** and **1 / 14**. Uncorrected χ² = **6.1364**,
      p = **.0132**; **Yates continuity-corrected χ² = 4.2614, p = .0390**; Fisher's
      exact p = **.0352**, OR = **11.2622**. For a 2×2 SPSS prints the corrected row too
      — if CrossTab reports only the uncorrected value on a 2×2 that is a real gap.
      Reference: same `CROSSTABS` command; SPSS adds "Continuity Correction" and
      "Fisher's Exact Test" automatically for 2×2.

- [ ] **Descriptives…** — `Descriptive Statistics ▸ Descriptives…`
      Recipe: `vars = age, income`.
      Expect, exactly: `age` N = **30**, min **25**, max **61**, mean **41.0000**,
      SD **10.8881**. `income` **N = 28** (not 30 — the two −99s), min **24000**,
      max **66200**, mean **45292.8571**, SD **12432.9886**.
      Reference: SPSS `DESCRIPTIVES VARIABLES=age income /STATISTICS=MEAN STDDEV MIN MAX.`

- [ ] **Explore (confidence interval for the mean)…** — same menu.
      Recipe: `vars = age, income`, `level = 95`.
      Expect, exactly: `age` mean 41.0000, 95% CI **[36.9343, 45.0657]**;
      `income` mean 45292.8571, 95% CI **[40471.8474, 50113.8668]**.
      Then add `by = gender` and expect the same statistics per group.
      Reference: SPSS `EXAMINE VARIABLES=age income /PLOT NONE
      /STATISTICS DESCRIPTIVES /CINTERVAL 95.`

- [ ] **Inequality (Gini / Theil / Lorenz)…** — `Descriptive Statistics ▸ …`
      Recipe: `x = income`.
      Expect: Gini between 0 and 1 (for this data ≈ 0.15 — a low, plausible figure),
      Theil ≥ 0, and a Lorenz curve that starts at (0,0), ends at (1,1) and bows below
      the diagonal.
      Reference: Stata `ineqdeco income` (SSC) or R `ineq::Gini(income)`. SPSS has no
      native Gini.

- [ ] **Segregation indices…** — same menu.
      Recipe: `groupA` and `groupB` as two count variables by area.
      Expect: dissimilarity index in [0,1]; identical distributions → 0.
      Reference: R `seg` package, or compute D by hand:
      `0.5 * Σ |a_i/A − b_i/B|`. No SPSS equivalent.

## 15. Comparison *(6 items)*

- [ ] **One-sample t-test…** — `Comparison ▸ One-sample t-test…`
      Recipe: `x = age`, `mu = 40`.
      Expect, exactly: t = **0.5030**, df = **29**, p = **.6187**, mean = 41.0000,
      mean difference = 1.0000, 95% CI of the mean **[36.9343, 45.0657]**.
      ⚠️ SPSS reports the CI **of the difference** — `[−3.0657, 5.0657]` — not of the
      mean. Both are right; make sure the label matches what is shown.
      Reference: SPSS `T-TEST /TESTVAL=40 /VARIABLES=age.`

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
      Reference: SPSS `T-TEST GROUPS=gender(1 2) /VARIABLES=income.`

- [ ] **Paired-samples t-test…** — same menu.
      Recipe: needs two commensurate variables — `Transform ▸ Compute` an
      `age_plus = age + 2`, then pair `age` with `age_plus`.
      Expect: mean difference exactly **−2.0000**, SD of differences **0**, and a
      graceful refusal or an infinite/undefined t rather than a crash (zero variance is
      the edge case worth checking). Then try a noisier computed pair for a real t.
      Reference: SPSS `T-TEST PAIRS=age WITH age_plus (PAIRED).`

- [ ] **One-way ANOVA…** — same menu.
      Recipe: `y = income`, `g = education`.
      Expect, exactly: between df **2**, SS ≈ **3.852 × 10⁹**, MS ≈ **1.926 × 10⁹**;
      within df **25**, SS ≈ **3.220 × 10⁸**, MS ≈ **1.288 × 10⁷**;
      **F = 149.5**, p = **1.24 × 10⁻¹⁴**. Group means **30350.00 / 43836.36 / 60355.56**.
      Levene's (mean-centred) F = **0.0519**, p = **.9495**.
      Also check: post-hoc comparisons if offered, and that N = 28.
      Reference: SPSS `ONEWAY income BY education /STATISTICS HOMOGENEITY
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
      Reference: SPSS `UNIANOVA income BY gender education
      /DESIGN=gender education gender*education.`

- [ ] **Repeated-measures ANOVA…** — same menu.
      Recipe: compute three related variables (e.g. `t1 = age`, `t2 = age + 3`,
      `t3 = age + 7` with some noise), then `vars = t1, t2, t3`.
      Expect: within-subjects effect; **Mauchly's test of sphericity**; and the
      Greenhouse–Geisser and Huynh–Feldt corrected rows. Already validated against
      desktop R (`scripts/validation/sphericity-reference.R`).
      Reference: SPSS `GLM t1 t2 t3 /WSFACTOR=time 3 /PRINT=ETASQ
      /EMMEANS=TABLES(time).`

## 16. Compare Means *(2 items)*

- [ ] **ANCOVA…** — `Compare Means ▸ ANCOVA…`
      Recipe: `y = income`, `factors = education`, `covs = age`.
      Expect: the covariate row, the adjusted factor effect, and **estimated marginal
      means** adjusted for `age`. Compare the unadjusted means (§15's 30350 / 43836 /
      60356) with the adjusted ones — they should differ, since age correlates with
      income at r = .95.
      Reference: SPSS `UNIANOVA income BY education WITH age
      /EMMEANS=TABLES(education) WITH(age=MEAN) /DESIGN=age education.`

- [ ] **Repeated-measures / mixed ANOVA…** — same menu.
      Recipe: `within = t1, t2, t3` (from §15), `between = gender`.
      Expect: within effect, between effect, and the within × between interaction;
      sphericity corrections present.
      Reference: SPSS `GLM t1 t2 t3 BY gender /WSFACTOR=time 3.`
      (Uses `afex`/`emmeans` under the hood — SPSS is the better check here.)

## 17. Correlation *(2 items)*

- [ ] **Bivariate…** — `Correlation ▸ Bivariate…`
      Recipe: `vars = age, income`, method = Pearson.
      Expect, exactly: r = **.9515**, p < .0001, **n = 28**, 95% CI **[.8968, .9776]**.
      Then method = Spearman → rho = **.9458**; Kendall → tau-b = **.8170**.
      ⚠️ Kendall has three variants (tau-a, tau-b, tau-c). The figure above is **tau-b**
      (tie-corrected), which is also what SPSS reports. A noticeably different value may
      just be a different variant.
      Reference: SPSS `CORRELATIONS /VARIABLES=age income.` and
      `NONPAR CORR /VARIABLES=age income /PRINT=BOTH.`

- [ ] **Partial / part correlation…** — same menu.
      Recipe: `vars = age, income`, `controls = education`, type = partial.
      Expect: a partial r **smaller** than .9515 (education explains part of the
      association), df = n − 2 − (number of controls) = 25.
      Then switch to **part (semi-partial)** and confirm the value changes — the two are
      different statistics and must not return the same number.
      Reference: SPSS `PARTIAL CORR /VARIABLES=age income BY education /SIGNIFICANCE=TWOTAIL.`

## 18. Regression *(21 items)*

- [ ] **Linear…** — `Regression ▸ Linear…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect, exactly: intercept **6959.8** (SE 2699.8, t = 2.578, p = .0162);
      `age` **514.7** (SE 145.6, t = 3.535, p = .0016); `education` **8563.7**
      (SE 1971.0, t = 4.345, p = .0002). Residual SE **3000** on **25** df.
      R² = **.9461**, adjusted R² = **.9418**, F(2, 25) = **219.4**, p < .0001.
      Reference: SPSS `REGRESSION /DEPENDENT income /METHOD=ENTER age education
      /STATISTICS COEFF OUTS R ANOVA COLLIN.`

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
      Reference: SPSS `LOGISTIC REGRESSION VARIABLES gender WITH age income
      /PRINT=CI(95).` SPSS models the **higher** code by default — mind the direction.

- [ ] **Ordinal logistic regression…** — `Regression ▸ …`
      Recipe: `dv = education` (ordered), `ivs = age, income`.
      Expect: threshold/intercept terms (k − 1 = 2 of them) plus one slope per
      predictor; a proportional-odds assumption note.
      Reference: SPSS `PLUM education WITH age income /LINK=LOGIT /PRINT=PARAMETER.`
      (Analyze ▸ Regression ▸ Ordinal.) ⚠️ `MASS::polr` reports slopes with the
      **opposite sign convention** to SPSS PLUM — a uniform sign flip is expected, not
      a bug.

- [ ] **Multinomial logistic regression…** — same menu.
      Recipe: `dv = region`, `base = North`, `ivs = age, income`.
      Expect: two contrasts (Central vs North, South vs North), each with its own
      coefficients; changing `base` re-expresses them.
      Reference: SPSS `NOMREG region (BASE=1) WITH age income /PRINT=PARAMETER.`

- [ ] **Poisson regression…** — `Regression ▸ …`
      Recipe: `dv = household_size` (spatial demo), `ivs = income_k, commute_min`.
      Expect: log-link coefficients, IRRs if offered, deviance and AIC.
      Reference: SPSS `GENLIN household_size WITH income_k commute_min
      /MODEL income_k commute_min DISTRIBUTION=POISSON LINK=LOG.`
      Or Stata `poisson household_size income_k commute_min`.

- [ ] **Negative binomial regression…** — same menu.
      Recipe: same variables.
      Expect: an extra **dispersion/theta** parameter, and an AIC that should *beat*
      Poisson's when the data are overdispersed (here they may not be — equal fit is a
      legitimate result).
      Reference: Stata `nbreg household_size income_k commute_min`, or SPSS `GENLIN …
      DISTRIBUTION=NEGBIN(MLE)`.

- [ ] **Cluster-robust regression…** — `Regression ▸ …`
      Recipe: `y = income_k`, `ivs = satisfaction, commute_min`, `cluster = district`
      (spatial demo).
      Expect: **coefficients identical to OLS**, standard errors different. That is the
      sharpest check available — if the point estimates move, something is wrong.
      Reference: Stata `regress income_k satisfaction commute_min, vce(cluster district)`.
      R: `lmtest::coeftest(m, vcov = sandwich::vcovCL(m, cluster = ~district))`.

- [ ] **Robust (HC) regression…** — `Econometrics ▸ Robust (HC) regression…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect: same coefficients as §18's Linear (**6959.8 / 514.7 / 8563.7**), different
      SEs. Note which HC variant (HC0–HC3) is used.
      Reference: Stata `regress income age education, robust` (= HC1).
      R: `coeftest(m, vcov = vcovHC(m, type = "HC1"))`.

- [ ] **Quantile regression…** — `Regression ▸ Quantile regression…`
      Recipe: `y = income`, `ivs = age, education`, `taus = 0.25, 0.5, 0.75`.
      Expect: three sets of coefficients; the median (τ = .5) set should sit near the
      OLS estimates but not equal them.
      Reference: Stata `qreg income age education, quantile(.5)`.
      R: `quantreg::rq(income ~ age + education, tau = 0.5)`.

- [ ] **Tobit (censored) regression…** — same menu.
      Recipe: `y = income`, `ivs = age, education`, `left = 30000`.
      Expect: coefficients larger in magnitude than OLS (censoring attenuates OLS), plus
      a sigma estimate.
      Reference: Stata `tobit income age education, ll(30000)`.

- [ ] **Heckman selection model…** — same menu.
      Recipe: `y = income`, `outIv = age`, `sel =` a binary selection variable,
      `selIv = education`.
      Expect: the outcome equation, the selection equation, and **rho / lambda** (the
      inverse Mills ratio term).
      Reference: Stata `heckman income age, select(sel = education)`.

- [ ] **Multiple imputation regression…** — `Regression ▸ …`
      Recipe: `y = income` (it has 2 missing), `ivs = age, education`, `m = 5`.
      Expect: pooled estimates with **Rubin's rules** — SEs larger than complete-case,
      plus fraction-of-missing-information or similar diagnostics. Re-running with the
      same `m` should be reproducible (check whether a seed is exposed; if the numbers
      wander between runs with no seed, that is a finding).
      Reference: SPSS Missing Values module (`MULTIPLE IMPUTATION`), or Stata
      `mi impute chained … ; mi estimate: regress income age education`.

- [ ] **Marginal effects (AME / MEM)…** — `Regression ▸ …`
      Recipe: `dv = gender`, `yes = Female`, `ivs = age, income`, family = binomial,
      kind = AME; then kind = MEM.
      Expect: AME ≠ MEM (average of the marginal effects vs the effect at the means);
      both on the probability scale, so values roughly within ±1.
      Reference: Stata `logit female age income` then `margins, dydx(*)` (AME) and
      `margins, dydx(*) atmeans` (MEM). R: `margins` / `marginaleffects`.

- [ ] **Mediation (X → M → Y)…** — `Regression ▸ …`
      Recipe: `x = education`, `m = age`, `y = income`, se = bootstrap.
      Expect: direct, indirect and total effects, with **total ≈ direct + indirect**
      (check that identity — it is a free arithmetic test), and a bootstrap CI for the
      indirect effect.
      Reference: Hayes **PROCESS** macro for SPSS, model 4. Or R
      `lavaan` with a defined `ab := a*b` parameter. Stata `sem`.

- [ ] **Moderation (X × W)…** — same menu.
      Recipe: `y = income`, `x = age`, `w = education`.
      Expect: the interaction term, and simple slopes / conditional effects at levels
      of `w`.
      Reference: PROCESS model 1, or SPSS `UNIANOVA` with the product term.

- [ ] **Difference-in-differences…** — `Regression ▸ …`
      Recipe: needs a treat and a post indicator — compute both, then `y = income`,
      `treat`, `treated` level, `post`, `after` level.
      Expect: the **interaction** coefficient is the DiD estimate; the two main effects
      are reported too.
      Reference: Stata `didregress (income) (treat#post)`, or plain
      `regress income treat##post`.

- [ ] **Regression discontinuity…** — same menu.
      Recipe: `y = income`, `run = age`, `cutoff = 40`.
      Expect: a local estimate at the cutoff with a bandwidth reported; the bandwidth
      choice should be visible and changeable.
      Reference: Stata/R `rdrobust` (same package CrossTab wraps — so extract its R and
      compare directly).

- [ ] **Matching (propensity / nearest neighbour)…** — same menu.
      Recipe: `y = income`, `treat`, `treated` level, `covs = age, education`.
      Expect: a balance table before/after matching, matched n, and the treatment
      effect. Covariate balance should **improve** after matching.
      Reference: R `MatchIt` (the wrapped package), Stata `teffects psmatch` or
      `psmatch2`.

- [ ] **Linear mixed model…** — `Regression ▸ Linear mixed model…`
      Recipe: `y = income_k`, `fixed = satisfaction, commute_min`, `group = district`
      (spatial demo), then add `slope = commute_min`.
      Expect: fixed effects with SEs, random-effect variances, and an **ICC** between
      0 and 1. The random-slope version should report a slope variance and a
      correlation.
      Reference: SPSS `MIXED income_k WITH satisfaction commute_min
      /FIXED=satisfaction commute_min /RANDOM=INTERCEPT | SUBJECT(district)
      /METHOD=REML.` ⚠️ `lme4` and SPSS MIXED can differ slightly in df method —
      compare the **estimates and variances**, not the p-values, first.

- [ ] **Logistic mixed model…** — same menu.
      Recipe: `y = gender`, `yes = Female`, `fixed = age`, `group = region`.
      Expect: log-odds fixed effects plus a group variance. With only 3 regions and
      30 cases expect a convergence warning — a *readable* warning is the pass
      condition, not silence and not a crash.
      Reference: Stata `melogit`, R `glmer(..., family = binomial)`.

- [ ] **Meta-analysis…** — `Regression ▸ Meta-analysis…`
      Recipe: needs an effect-size column and a precision column — make a small
      dataset of 8 studies by hand (`yi` effect, `sei` standard error), then
      `yi`, `prec = sei`, precType = SE, model = random.
      Expect: pooled estimate with CI, **τ² / I² / Q** heterogeneity statistics, and a
      forest plot. Fixed-effect mode should give a *narrower* CI than random-effects.
      Reference: Stata `meta set yi sei` then `meta summarize`, or R
      `metafor::rma(yi, sei = sei)` (the wrapped package). RevMan for the Cochrane view.
      No SPSS equivalent.

- [ ] **Response surface (second-order)…** — `Regression ▸ …`
      Recipe: `y = income_k`, `factors = satisfaction, commute_min`.
      Expect: linear, quadratic and cross-product terms; a stationary-point analysis
      and eigenvalues saying whether it is a maximum, minimum or saddle.
      Reference: Minitab or Design-Expert (the field standards), or R `rsm::rsm`.
      No SPSS equivalent.
## 19. Categorical *(6 items)*

- [ ] **Chi-square goodness-of-fit…** — `Categorical ▸ …`
      Recipe: `variable = region`, expected left blank (equal).
      Expect, exactly: observed **11 / 10 / 9**, χ² = **0.2000**, df = **2**,
      p = **.9048**. Then supply unequal expected proportions (e.g. `0.5, 0.3, 0.2`)
      and confirm the statistic changes and that the proportions are normalised.
      Reference: SPSS `NPAR TESTS /CHISQUARE=region.` and
      `/EXPECTED=0.5 0.3 0.2`.

- [ ] **One-proportion test…** — same menu.
      Recipe: `variable = gender`, `category = Female`, `p0 = 0.5`.
      Expect, exactly: k = **15**, n = **30**, p = **1.0000** (exactly half, so the test
      cannot reject). Then try `p0 = 0.3` and expect a significant result.
      Note whether it reports the **exact binomial** or the normal approximation — both
      are defensible, but the label must match the method.
      Reference: SPSS `NPAR TESTS /BINOMIAL(0.5)=gender.` (exact).
      R: `binom.test(15, 30, 0.5)` vs `prop.test(15, 30, 0.5)`.

- [ ] **Two-proportion test…** — same menu.
      Recipe: `outcome = education` recoded to `hs` (see §14), `success = 2`,
      `groups = gender`, `g1 = Male`, `g2 = Female`.
      Expect: the two proportions (**8/15 = .5333** and **14/15 = .9333**), their
      difference, a CI for the difference, and a p-value consistent with §14's 2×2
      (χ² = 6.1364 uncorrected, p = .0132).
      Reference: R `prop.test(c(8, 14), c(15, 15))`. SPSS: via Crosstabs with
      `/STATISTICS=CHISQ`.

- [ ] **McNemar's test (paired)…** — same menu.
      Recipe: two binary variables measured on the same cases — compute
      `rich1 = income > 40000` and `rich2 = income > 45000`.
      Expect: the 2×2 agreement table, and the test driven **only by the discordant
      cells**. Check that reversing the two variables gives the same p (it must).
      Reference: SPSS `NPAR TESTS /MCNEMAR=rich1 WITH rich2.`

- [ ] **Log-linear model…** — same menu.
      Recipe: `vars = gender, education, region`, model = saturated, then independence.
      Expect: cell counts with fitted values, parameter estimates, and a
      goodness-of-fit (deviance/Pearson) that is **0 for the saturated model** — a
      useful free check.
      Reference: SPSS `GENLOG gender education region /MODEL=POISSON
      /DESIGN gender education region.` (or `HILOGLINEAR`.)

- [ ] **Risk / odds ratios (2×2)…** — `Categorical ▸ Risk / odds ratios (2×2)…`
      Recipe: `exposure = gender`, `exposed = Male`, `outcome = hs`, `case = 1`.
      Expect: the 2×2 laid out with the **exposed group as the first row and the case
      as the first column**, then risk in each group, risk ratio, risk difference, and
      odds ratio with CIs. For the §14 table the OR is **11.2622** (Fisher's conditional
      MLE) or 12.25 (the plain cross-product `7×14 / (8×1)`) — note which is reported.
      ⚠️ **Test the level choice deliberately.** This table was once labelled backwards
      for non-0/1 coded variables (#186) — swap `exposed` and `case` to the other levels
      and confirm the numbers move the way they should, rather than trusting the layout.
      Reference: SPSS `CROSSTABS /TABLES=gender BY hs /STATISTICS=RISK.`
      Stata `cs hs gender` (cohort) / `cc hs gender` (case-control).

## 20. Nonparametric *(3 items)*

- [ ] **Mann-Whitney U (2 groups)…** — `Nonparametric ▸ …`
      Recipe: `y = income`, `g = gender`, `g1 = Male`, `g2 = Female`.
      Expect, exactly: U (R's W) = **43.5**, asymptotic p with continuity correction
      = **.0131**, exact p = **.0110**. Check which one is reported and labelled.
      ⚠️ SPSS prints U, Wilcoxon W, Z and both an asymptotic and (for small n) an exact
      p. Ties are present here, so the tie-corrected variance matters. This plugin has a
      validated ranking path (`scripts/validation/mannwhitney-subset-ranks.R`) — ranks
      must be computed on the **subset actually analysed**, not on all 30 cases.
      Reference: SPSS `NPAR TESTS /M-W= income BY gender(1 2).`

- [ ] **Wilcoxon signed-rank (paired)…** — same menu.
      Recipe: `x1 = age`, `x2 =` a computed `income/1000`.
      Expect, exactly: V = **12.5**, p < .0001.
      Then pair a variable with itself and expect a graceful "no non-zero differences"
      message rather than a crash.
      Reference: SPSS `NPAR TESTS /WILCOXON=age WITH income_k (PAIRED).`

- [ ] **Kruskal-Wallis (k groups)…** — same menu.
      Recipe: `y = income`, `g = education`.
      Expect, exactly: χ² = **23.8801**, df = **2**, p < .0001. Mean ranks per group
      should be monotonically increasing here.
      Reference: SPSS `NPAR TESTS /K-W=income BY education(1 3).`

## 21. Assumptions *(2 items)*

- [ ] **Normality (Shapiro–Wilk)…** — `Assumptions ▸ …`
      Recipe: `vars = age, income`.
      Expect: W and p per variable, N = 30 for age and **28** for income. `age` is
      near-uniform so expect a *low* W with a possibly significant p — a significant
      result is a correct finding here, not a malfunction.
      Reference: SPSS `EXAMINE VARIABLES=age income /PLOT NPPLOT.` (Shapiro–Wilk
      appears in the Tests of Normality table.)

- [ ] **Homogeneity of variance (Levene's)…** — same menu.
      Recipe: `outcome = income`, `groups = education`.
      Expect, exactly: F = **0.0519**, p = **.9495** — *if* mean-centred, which is what
      SPSS does. A median-centred (Brown–Forsythe) variant would give a different
      number; the output should say which it is.
      Reference: SPSS `ONEWAY income BY education /STATISTICS HOMOGENEITY.`

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
      Reference: SPSS `RELIABILITY /VARIABLES=satisfaction commute_min income_k
      household_size /MODEL=ALPHA /SUMMARY=TOTAL.` SPSS's "Cronbach's Alpha" is the raw
      one; "Based on Standardized Items" is the second.

- [ ] **Inter-rater agreement…** — `Scale ▸ Inter-rater agreement…`
      Recipe: compute two rater columns that mostly agree, then `vars = r1, r2`,
      metric = Cohen's kappa; then try Fleiss (3+ raters), Krippendorff's alpha, ICC.
      Expect: kappa in [−1, 1]; **perfect agreement → exactly 1.0**; and the weighted
      variant differing from unweighted on ordinal data.
      Also check the **`weight` input accepts a labelled weight variable** (#188 — a
      labelled weight was once not selectable).
      Reference: SPSS `CROSSTABS /TABLES=r1 BY r2 /STATISTICS=KAPPA.` (Cohen's only;
      SPSS has no native Fleiss or Krippendorff.) R `irr` package — the one wrapped
      here — for the rest.

- [ ] **Inter-coder agreement from codings…** — same menu.
      Recipe: in the **Coding** workspace, have two coders code the same documents,
      then run this with metric = kappa.
      Expect: it reads the CAQDAS codings **across the plugin boundary** (they are a
      declared public collection — #196), computes agreement per code, and lists the
      **specific disagreements** (#202) so you can go look at them.
      Expect too: a clear message when there is only one coder, rather than a spurious
      perfect-agreement result.
      Reference: no mainstream GUI does this from coded qualitative data —
      **Dedoose** and NVivo's coding-comparison query are the comparators. For
      arithmetic, export the per-unit code assignments and run `irr::kappa2` in R.

## 23. Graphs *(11 items)* 🔢

All chart arithmetic is hand-rolled JavaScript (no R), and all of these emit a **chart
model** the host renders — so for each one also confirm the host controls work: title,
axis titles, legend, palette, size, and that edits survive save/reload.

- [ ] **Histogram…** — `Graphs ▸ Histogram…`
      Recipe: `v = age`.
      Expect: bars covering 25–61; a sensible bin count (check the rule — Sturges on
      n = 30 gives ~6 bins); counts summing to **30**. Then `v = income` and expect
      counts summing to **28**.
      Reference: SPSS `GRAPH /HISTOGRAM=age.` Bin boundaries legitimately differ
      between packages; the **total** must not.

- [ ] **Bar chart…** — same menu.
      Recipe: `v = education`.
      Expect: three bars **8 / 12 / 10** with value labels on the axis.
      Reference: SPSS `GRAPH /BAR(SIMPLE)=COUNT BY education.`

- [ ] **Line chart…** — `v = age`. Expect: one point per case in file order.

- [ ] **Scatter…** — `x = age`, `y = income`.
      Expect: 28 points (two dropped for missing income); a visibly strong positive
      relationship (r = .95). If a fit line is offered it should match the OLS slope
      from a simple regression of income on age.
      Reference: SPSS `GRAPH /SCATTERPLOT(BIVAR)=age WITH income.`

- [ ] **Trends over time…** — `x = age`, `g = gender`, `summary = mean`.
      Expect: one line per group; switching `summary` between mean/sum/count/percent
      changes the values; a percent mode should sum to 100 within each x.

- [ ] **Boxplot…** — `y = age`.
      Expect: median **39.5**, and quartiles at **31.75 / 50.5** (SPSS's hinge
      definition) or **32.25 / 49.75** (R's default). Note which — this is the same
      quartile-definition question as §14, and the two must at least be *consistent*
      with each other inside the app.
      Then `g = gender` for side-by-side boxes.
      Reference: SPSS `EXAMINE VARIABLES=age /PLOT BOXPLOT.`

- [ ] **Pie chart…** — `v = region`.
      Expect: three slices 36.7 / 33.3 / 30.0 %, summing to 100.

- [ ] **Bar chart with error bars…** — `y = income`, `g = gender`.
      Expect: bar heights = group means **39085.71** and **51500.00**; then switch the
      error type between **SEM / SD / 95% CI** and confirm all three differ. SEM for
      Male = 10427.0991/√14 = **2786.2**; the 95% CI should be roughly ±2.16 SEM
      (t₍₁₃₎). Turning error bars off should leave the bars unchanged.
      Reference: SPSS `GRAPH /BAR(SIMPLE)=MEAN(income) BY gender /INTERVAL CI(95.0).`

- [ ] **Violin plot…** — `y = income`, `g = gender`.
      Expect: a density silhouette per group, **open axes** (the Prism convention), and
      the option to overlay the data points.
      Reference: GraphPad Prism is the convention being matched. R
      `ggplot2::geom_violin` for shape comparison.

- [ ] **Dot plot (column scatter)…** — `y = income`, `g = gender`.
      Expect: every case as a point, jittered or offset so none hide; 14 per group.

- [ ] **Before-after plot…** — `vars = t1, t2` (computed), `idVar` optional.
      Expect: one line per case joining its two values; with `idVar` the lines are
      identifiable. A case missing either value should be dropped visibly, not drawn to
      zero.
      Reference: Prism's before-after plot.
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
      Reference: SPSS `QUICK CLUSTER satisfaction commute_min income_k household_size
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
      Reference: SPSS `FACTOR /VARIABLES=… /EXTRACTION PC /ROTATION VARIMAX
      /PRINT INITIAL EXTRACTION ROTATION.`

- [ ] **MANOVA…** — `Multivariate ▸ MANOVA…`
      Recipe: `dvs = age, income`, `group = education`.
      Expect: all four multivariate tests — **Pillai's trace, Wilks' lambda,
      Hotelling's trace, Roy's largest root** — each with F, df and p; plus the
      univariate follow-ups. With 2 DVs and 3 groups the four tests will *not* be
      identical (they coincide only when the hypothesis df is 1).
      Reference: SPSS `GLM age income BY education /PRINT=HOMOGENEITY.`

- [ ] **Confirmatory factor analysis…** — `Multivariate ▸ Confirmatory factor analysis…`
      Recipe: spatial demo, `items =` the four numeric variables, `factorName = F1`.
      Expect: standardised loadings, and fit indices — **χ², df, CFI, TLI, RMSEA,
      SRMR**. With four weakly-correlated items expect *good* fit for a 1-factor model
      (there is little covariance to explain) and small loadings. Both are correct.
      Reference: R `lavaan::cfa` (the wrapped package — extract the generated syntax and
      compare directly). SPSS needs the separate **Amos** product; Stata `sem`.

- [ ] **Latent growth curve…** — same menu.
      Recipe: `waves = t1, t2, t3` (computed in §15), `quadratic = no`, then yes.
      Expect: intercept and slope means and variances, and their covariance; the
      quadratic version adds a second-order term.
      Reference: Mplus is the field standard; `lavaan::growth` is what this wraps.

- [ ] **Structural equation model (syntax)…** — same menu.
      Recipe: `vars =` four numeric variables, `model =` lavaan syntax, e.g.
      `income_k ~ satisfaction + commute_min`.
      Expect: parameter estimates and fit indices; a **syntax error in the model text
      produces a readable error**, not a silent empty result. Test that deliberately.
      Reference: `lavaan` directly, or Stata `sem`.

- [ ] **Correspondence analysis…** — `Multivariate ▸ Correspondence analysis…`
      Recipe: `rowvar = gender`, `colvar = education`.
      Expect: row and column scores on 2 dimensions, **total inertia = χ²/n =
      8.1000/30 = .2700**, and a biplot. That inertia identity is a free arithmetic
      check against §14.
      Reference: SPSS `CORRESPONDENCE TABLE=gender(1 2) BY education(1 3).`
      (Analyze ▸ Dimension Reduction ▸ Correspondence Analysis.)

- [ ] **Multidimensional scaling (MDS)…** — same menu.
      Recipe: spatial demo, `vars =` four numeric variables, `label = zip_code`.
      Expect: a 2-D configuration plot plus a **stress** value; stress should fall as
      dimensions increase.
      Reference: SPSS `PROXSCAL` or `ALSCAL` (Analyze ▸ Scale ▸ Multidimensional
      Scaling).

- [ ] **Network analysis (edge list)…** — `Multivariate ▸ Network analysis…`
      Recipe: build a tiny edge list dataset (`from`, `to` columns, ~10 edges with one
      obvious hub), `directed = no`.
      Expect: degree / betweenness / closeness centrality per node, density, components,
      and a graph figure. **The hub must have the highest degree** — the simplest
      possible sanity check. Then `directed = yes` and confirm in-degree and out-degree
      separate.
      Reference: UCINET or Gephi for the field; R `igraph` (wrapped here) for exact
      numbers. No SPSS equivalent.

- [ ] **Diversity & ordination…** — `Multivariate ▸ Diversity & ordination…`
      Recipe: a species-abundance table (make ~8 sites × 5 species), `species =` the
      five count columns.
      Expect: **Shannon H′, Simpson, species richness** per site, plus an ordination
      plot. Sanity checks that cost nothing: a site with one species present has
      H′ = **0**; richness equals the count of non-zero columns.
      Reference: R `vegan::diversity` (wrapped here). PRIMER or PAST are the field
      standards. No SPSS equivalent.

## 25. Time Series *(8 items)*

- [ ] **Correlogram (ACF / PACF)…** — `Time Series ▸ …`
      Recipe: `series = age` (as a stand-in series), `maxlag = 10`.
      Expect: ACF at **lag 0 = exactly 1.0**, confidence bands drawn at ±1.96/√n, and
      PACF alongside. That lag-0 value is a free check.
      Reference: SPSS `ACF VARIABLES=age /MXAUTO 10.` (Analyze ▸ Forecasting ▸
      Autocorrelations — needs the Forecasting module.) R `acf(x, lag.max = 10)`.

- [ ] **Stationarity tests (ADF, KPSS)…** — same menu.
      Recipe: `series = age`.
      Expect: ADF statistic and p, KPSS statistic and p, with their **opposite null
      hypotheses** stated (ADF null = non-stationary; KPSS null = stationary). If the
      output does not say which null is which, that is a usability finding.
      Reference: Stata `dfuller` / `kpss`; R `tseries::adf.test` / `kpss.test`.

- [ ] **Decomposition (STL)…** — same menu.
      Recipe: a series with a visible cycle; `frequency = 12`.
      Expect: trend + seasonal + remainder panels, and **trend + seasonal + remainder ≈
      the original** at every point (additive identity — check a couple of points).
      Reference: R `stl()`; SPSS `SEASON` (Forecasting module).

- [ ] **ARIMA forecast (auto)…** — same menu.
      Recipe: `series =` a trending series, `h = 6`, `frequency = 1`.
      Expect: a chosen (p,d,q) order, coefficients, AIC, and 6 forecasts with widening
      prediction intervals. **Intervals must widen** with the horizon.
      Reference: R `forecast::auto.arima` (wrapped here). SPSS `TSMODEL` with
      `MODELTYPE=ARIMA` and Expert Modeler, Forecasting module.

- [ ] **Mann-Kendall trend + Sen's slope…** — `Time Series ▸ …`
      Recipe: `series =` a monotonically increasing variable.
      Expect: S, tau, p, and Sen's slope. **A perfectly monotonic series gives
      tau = 1.0** — do that case first, it is unambiguous.
      Reference: R `trend::mk.test` and `trend::sens.slope` (wrapped here); XLSTAT
      for a GUI. No SPSS equivalent.

- [ ] **Cointegration (Johansen)…** — same menu.
      Recipe: `series =` 2–3 related series, `ecdet = const`, `K = 2`.
      Expect: trace and max-eigenvalue statistics with critical values at 10/5/1%, and
      a stated number of cointegrating relations.
      Reference: Stata `vecrank`; EViews; R `urca::ca.jo` (wrapped). No SPSS equivalent.

- [ ] **GARCH volatility…** — same menu.
      Recipe: `series =` a return-like series, `q = 1`, `p = 1`, dist = normal.
      Expect: omega, alpha, beta estimates with **alpha + beta < 1** (the stationarity
      condition) and a conditional-volatility plot. Then try the t distribution and
      confirm the shape parameter appears.
      Reference: Stata `arch y, arch(1) garch(1)`; EViews; R `fGarch::garchFit`.

- [ ] **Vector autoregression (VAR)…** — `Time Series ▸ …`
      Recipe: `series =` 2–3 series, `lag = 2`, `type = const`, `horizon = 10`.
      Expect: one equation per series, Granger-causality tests if offered, and
      **impulse-response functions** over 10 periods. A stable VAR's IRFs should decay.
      Reference: Stata `var y1 y2, lags(1/2)` then `irf create`; R `vars::VAR`
      (wrapped). No SPSS equivalent.

## 26. Econometrics *(3 items — "Robust (HC)" is in §18)*

- [ ] **Instrumental variables (2SLS)…** — `Econometrics ▸ …`
      Recipe: `dv = income`, `endog = education`, `instruments =` a variable correlated
      with education but not directly with income, `controls = age`.
      Expect: 2SLS coefficients, plus the diagnostic trio — **weak-instrument
      (first-stage F), Wu–Hausman endogeneity, and Sargan** (only when
      over-identified; with exactly one instrument Sargan is not computable and should
      say so rather than print a zero).
      Reference: Stata `ivregress 2sls income age (education = z)` then
      `estat firststage` / `estat endogenous`. R `AER::ivreg` (wrapped).

- [ ] **Panel regression (FE / RE)…** — same menu.
      Recipe: spatial demo as a pseudo-panel: `dv = income_k`,
      `ivs = satisfaction, commute_min`, `id = district`, `time =` a computed index,
      `model = fe`; then `re`.
      Expect: FE drops anything time-invariant and reports within-R²; RE reports theta
      and the between/within variance split. **FE and RE coefficients must differ**;
      if they are identical something is not switching.
      Reference: Stata `xtset district t` then `xtreg income_k satisfaction
      commute_min, fe` / `, re`. R `plm` (wrapped).

## 27. Survival *(2 items)*

- [ ] **Kaplan–Meier & log-rank…** — `Survival ▸ …`
      Recipe: build a small survival dataset (`time`, `status` 1 = event / 0 = censored,
      `group`), ~20 cases.
      Expect: a step-function survival curve starting at **S(0) = 1.0**, median survival
      with CI, censoring marks, and a log-rank χ² with df = groups − 1.
      Free checks: the curve never increases; with no censoring the final S hits 0.
      Reference: SPSS `KM time BY group /STATUS=status(1) /PRINT TABLE MEAN
      /COMPARE.` (Analyze ▸ Survival ▸ Kaplan-Meier.)

- [ ] **Cox proportional hazards…** — same menu.
      Recipe: same data, `preds =` one or two covariates.
      Expect: coefficients with **hazard ratios = exp(β)** (check that identity
      yourself), SEs, a likelihood-ratio test, and ideally a PH-assumption diagnostic.
      Reference: SPSS `COXREG time /STATUS=status(1) /METHOD=ENTER x.`

## 28. Survey *(3 items)*

- [ ] **Weighted means…** — `Survey ▸ Weighted means…`
      Recipe: `vars = income`, `weight =` a positive weight variable; then add
      `strata` and `cluster`.
      Expect: weighted mean, and a **design-based standard error that grows when
      clustering is declared** (clustering reduces effective n). Unweighted vs weighted
      means should differ unless the weight is constant — set the weight to a constant
      column of 1s and confirm you get the plain mean **45292.8571** back. That is the
      best single test of a weighting path.
      Reference: Stata `svyset [pw=w], strata(s) psu(c)` then `svy: mean income`.
      SPSS needs the **Complex Samples** module (`CSPLAN` + `CSDESCRIPTIVES`);
      plain `WEIGHT BY` gives the right point estimate but the **wrong** SE.

- [ ] **Weighted crosstab…** — same menu.
      Recipe: `rowvar = gender`, `colvar = education`, `weight`, optional strata/cluster.
      Expect: weighted proportions with design-based CIs and a **Rao–Scott adjusted**
      chi-square — not the naive Pearson χ² on weighted counts.
      Reference: Stata `svy: tabulate gender education, row se`.
      SPSS `CSTABULATE`.

- [ ] **Survey regression…** — same menu.
      Recipe: `dv = income`, `ivs = age, education`, family = gaussian, `weight`;
      then `dv = gender`, `yes = Female`, family = binomial.
      Expect: design-based SEs; with a constant weight and no strata/cluster the
      **coefficients should match ordinary regression** (§18: 6959.8 / 514.7 / 8563.7).
      Reference: Stata `svy: regress` / `svy: logistic`. SPSS `CSGLM` / `CSLOGISTIC`.

## 29. Spatial *(3 items)*

- [ ] **Spatial autocorrelation (Moran’s I)…** — `Spatial ▸ …`
      Recipe: a dataset with x/y coordinates and a value; `k = 4` nearest neighbours.
      Expect: Moran's I in roughly [−1, 1], its expectation **E[I] = −1/(n−1)**, a
      variance, a z-score and p. Check E[I] against that formula — it is exact.
      Randomly-arranged values should give I ≈ E[I].
      Reference: **GeoDa** (the field's GUI standard), ArcGIS Pro ▸ Spatial
      Autocorrelation, or R `spdep::moran.test` (wrapped here). No SPSS equivalent.

- [ ] **Spatial lag regression…** — same menu.
      Recipe: `outcome`, `preds`, coordinates, `k = 4`.
      Expect: the **spatial autoregressive parameter ρ** with a significance test, plus
      the usual coefficients and a log-likelihood/AIC. ρ must be reported — it is the
      whole point of the model.
      Reference: GeoDa, or R `spatialreg::lagsarlm` (wrapped).

- [ ] **Choropleth map…** — same menu.
      Recipe: spatial demo (it ships ZIP boundaries), `region = zip_code`,
      `value = income_k`, `boundary =` the bundled file, `keyprop = ZCTA`.
      Expect: shaded polygons, a legend with class breaks, and — importantly — a clear
      report of **how many regions failed to join** the boundary file. A silent
      drop is the bug to look for here: deliberately misspell `keyprop` and confirm it
      tells you nothing matched rather than drawing an empty map.

- [ ] **Map workspace** (the `Map` tab) — its verbs: load boundaries, shade by
      variable, geocode points, filter to selection, clear boundaries, export map,
      import boundaries.
      Expect: each verb is recorded in the timeline (spatial state is
      last-writer-wins under collaboration); **filter to selection** drives the
      analyses; export produces a usable image.

## 30. Ecology *(2 items)*

- [ ] **Distance sampling…** — `Ecology ▸ Distance sampling…`
      Recipe: a column of perpendicular detection distances (~50 values, denser near
      zero), shape = half-normal, key = hn, with a truncation.
      Expect: a detection function with an estimated scale, **effective strip
      half-width**, density/abundance if effort and area are given, and a histogram of
      distances with the fitted curve over it. Density must scale sensibly when you
      halve `area`.
      Reference: the **Distance** software (distancesampling.org) is the field
      standard; R `mrds` is what this wraps — extract the generated R and compare.
      No SPSS equivalent.

- [ ] **Occupancy / N-mixture…** — same menu.
      Recipe: repeat-visit detection columns (`v1, v2, v3` of 0/1), model = occupancy,
      then N-mixture with `kmax`.
      Expect: separate **detection probability (p)** and **occupancy (ψ)** estimates —
      the point of the model is that these are not the same thing, so confirm both
      appear. Naive occupancy (any detection / n sites) should be **lower** than the
      estimated ψ.
      Reference: **PRESENCE** or **MARK**, or R `unmarked::occu`. No SPSS equivalent.

## 31. Bayesian *(4 items)*

- [ ] **Linear regression (Bayesian)…** — `Bayesian ▸ Linear regression…`
      Recipe: `dv = income`, `ivs = age, education`.
      Expect: posterior means with **credible intervals** (not confidence intervals —
      check the label), and posterior means close to the OLS estimates
      (**6959.8 / 514.7 / 8563.7**) under weak priors. A large divergence from OLS with
      default priors would be a finding.
      Reference: JASP (the closest GUI), Stata `bayes: regress`, or R `rstanarm`/
      `BayesFactor`.

- [ ] **Bayes factor: t-test…** — same menu.
      Recipe: `y = income`, `group = gender`, `g1 = Male`, `g2 = Female`.
      Expect: a BF₁₀ well above 1 (the frequentist p was .0057), and its reciprocal
      BF₀₁ reported or derivable. Check that **BF₀₁ = 1/BF₁₀**.
      Reference: **JASP** ▸ Bayesian Independent Samples T-Test (default Cauchy prior
      r = .707) — the standard comparator. R `BayesFactor::ttestBF`.

- [ ] **Bayes factor: correlation…** — same menu.
      Recipe: `x = age`, `y = income`.
      Expect: a very large BF (r = .95, n = 28).
      Reference: JASP ▸ Bayesian Correlation; R `BayesFactor::correlationBF`.

- [ ] **Vector autoregression (BVAR)…** — same menu.
      Recipe: 2–3 series, `lags = 2`, `horizon = 10`.
      Expect: posterior coefficient summaries and forecasts with credible bands.
      Reference: Stata `bayes: var`; R `BVAR`/`bvartools`.

## 32. Resampling *(5 items)*

- [ ] **Bootstrap the mean…** — `Resampling ▸ Bootstrap the mean…`
      Recipe: `x = income`, `reps = 2000`.
      Expect: the original mean **45292.8571**, a bootstrap SE near the analytic
      **12432.9886/√28 = 2349.3**, and a percentile CI near the t-based
      **[40471.85, 50113.87]**. Bias should be small and centred on zero.
      ⚠️ Resampling is random — **run it twice**. Small variation is correct; the
      question is whether a seed is exposed for reproducibility, since History claims to
      replay analyses. If not, note it.
      Reference: SPSS **Bootstrapping** module (`BOOTSTRAP /SAMPLING=SIMPLE
      /VARIABLES=income` + `DESCRIPTIVES`); Stata `bootstrap r(mean), reps(2000): sum
      income`; R `boot` (wrapped here).

- [ ] **Bootstrap a statistic…** — same menu.
      Recipe: `x = income`, `stat = median`, `reps = 2000`; then try each other `stat`.
      Expect: each statistic's bootstrap distribution; the median's CI will be wider
      and chunkier than the mean's — correct, not a defect.

- [ ] **Bootstrap a correlation…** — same menu.
      Recipe: `x = age`, `y = income`, `reps = 2000`.
      Expect: centred near **r = .9515**, with an asymmetric CI (correlations near 1
      are skewed) whose upper bound stays **≤ 1**. A CI exceeding 1 is a real bug.

- [ ] **Permutation test (2 groups)…** — same menu.
      Recipe: `y = income`, `group = gender`, `g1 = Male`, `g2 = Female`,
      `stat = mean difference`, `reps = 5000`.
      Expect: observed difference **−12414.29**, and a permutation p in the
      neighbourhood of the t-test's **.0057**. The permutation null should be centred on
      zero.
      Reference: Stata `permute`; R `coin::oneway_test`.

- [ ] **Power by simulation (t-test)…** — same menu.
      Recipe: `n = 30`, `d = 0.5`, `alpha = 0.05`, `reps = 5000`.
      Expect: power ≈ **0.47** (the analytic value for a two-sample t-test with n = 30
      *per group* is ~.478; for n = 30 *total* it is ~.32 — so **check which n means
      what**, that ambiguity is worth a finding in itself). Power must rise with n and
      with d.
      Reference: **G\*Power** (the field standard) or R `pwr::pwr.t.test(n = 30, d =
      0.5, sig.level = 0.05)` → power = .4779 for n per group.

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
      Reference: R `scan::nap(...)`, `pnd`, `tau_u`, `ird`. Or the online Tau-U
      calculator at singlecaseresearch.org — but expect *that* to differ, since it
      makes different choices than scan.

- [ ] **Multiple-baseline graph…** — same menu.
      Recipe: same data with a `caseVar` of 3 cases.
      Expect: one stacked panel per case, **staggered phase lines**, and **no line drawn
      across a phase change** (the two SCED drawing conventions, applied by default).
      Panel height, condition labels, points/lines and palette are editable, and edits
      survive save/reload.

- [ ] **Multiple-baseline graph, several measures…** — same menu.
      Recipe: add a `measure` variable with 2+ levels.
      Expect: panels grouped by case *and* measure, conventions preserved.

## 34. Text *(7 items)*

Load the **demo (qual)** dataset — it has `response` (open-ended) and `site`.

- [ ] **Word frequency…** — `Text ▸ Word frequency…`
      Recipe: `text = response`, stopwords = English, `topn = 20`, `minlen = 3`.
      Expect: a ranked table; no stopwords ("the", "and") present; nothing shorter than
      3 characters. Set stopwords = none and confirm "the" reappears — that is the test
      that the option is wired, not decorative.
      Reference: R `tidytext` (wrapped). Or check a handful of counts by hand.

- [ ] **Word cloud…** — same menu.
      Recipe: `text = response`, `topn = 50`, try each `layout` and `themes`.
      Expect: size proportional to frequency; no overlapping text; the most frequent
      word from the table above is the largest here (cross-check the two).

- [ ] **Sentiment analysis…** — same menu.
      Recipe: `text = response`, `doc = site`.
      Expect: per-document scores and an overall summary; the **lexicon is named** in
      the output (bing/afinn/nrc give materially different scales — unlabelled scores
      are not interpretable). Write one obviously positive and one obviously negative
      response and confirm the signs.
      Reference: R `tidytext::get_sentiments`. Provalis or LIWC for the commercial view.

- [ ] **TF-IDF (distinctive terms)…** — same menu.
      Recipe: `text = response`, `doc = site`, `topn = 15`.
      Expect: terms distinctive to each site. A word appearing in **every** document
      has IDF = 0 and must therefore score 0 — a free check.

- [ ] **Keyword in context (KWIC)…** — same menu.
      Recipe: `text = response`, `term =` a word you know occurs, `window = 5`.
      Expect: each occurrence with 5 words either side; the count matches the word
      frequency table. A term that does not occur gives an empty result with a clear
      message.

- [ ] **Topic modeling (LDA)…** — same menu.
      Recipe: `text = response`, `k = 3`, `topn = 10`.
      Expect: 3 topics with top terms, and per-document topic probabilities **summing
      to 1** per document. LDA is stochastic — run twice and note whether a seed is
      exposed.
      Reference: R `topicmodels::LDA` (wrapped); MALLET is the other standard.

- [ ] **Content-analysis dictionary…** — same menu.
      Recipe: write a small dictionary file (categories → word lists), `text =
      response`, `dict =` that file, `doc = site`.
      Expect: counts per category per document; a word in two categories counts in
      both; an empty category reports 0 rather than being dropped.
      Reference: LIWC or Provalis WordStat are the commercial comparators.

## 35. Analyze — mixture models *(3 items)*

- [ ] **Latent class analysis (categorical items)…** — `Analyze ▸ …`
      Recipe: `items = gender, education, region`, `classes = 2`, a fixed `seed`,
      `save = yes`.
      Expect: class sizes/proportions, item-response probabilities per class,
      **AIC / BIC / log-likelihood**, and — with `save` — a new class-membership
      variable in the dataset. Re-run with the **same seed** → identical output
      (that is the point of exposing the seed). Then `classes = 3` and confirm BIC
      changes.
      Reference: R `poLCA` (wrapped here). **Mplus** and **Latent GOLD** are the field
      standards. No SPSS equivalent.

- [ ] **Latent profile analysis (continuous items)…** — same menu.
      Recipe: spatial demo, `items =` the four numeric variables, `classes = 2`, seed.
      Expect: class means per item, proportions, fit indices, saved membership.
      Reference: Mplus; R `flexmix`/`mclust`.

- [ ] **Growth mixture model (classes of trajectory)…** — same menu.
      Recipe: `waves = t1, t2, t3`, `classes = 2`, seed.
      Expect: a distinct intercept/slope trajectory per class, class proportions, fit
      indices.
      Reference: **Mplus** (this is Mplus's signature analysis); R `flexmix`/`lcmm`.
## 36. Qualitative coding (CAQDAS)

Qualitative work is first-class here, not a side feature — test it at the same depth as
the statistics. Load **demo (qual)** to start, then bring in your own material.

### 36.1 Getting material in *(5 importers)*

All under **File ▸ Import data…**, each producing **one row per file**:

- [ ] **Text files** (`.txt`, `.md`, …) → one row per file.
      Expect: a folder or multi-select import; one case per document; the filename kept
      as a label.
- [ ] **Transcripts** (VTT, SRT, timestamped text) → one row per file.
      Expect: timestamps parsed into a usable structure rather than left as raw text.
- [ ] **Image files** (PNG, JPEG, …) → one row per file.
- [ ] **Audio files** (MP3, WAV, M4A, …) → one row per file.
- [ ] **Video files** (MP4, WebM, MOV, …) → one row per file.
      Expect for the three media kinds: the file is stored as a project asset, the row
      references it, and the media plays in the coding view.
- [ ] **A folder import on iPadOS.** Expect: may not be offered — that is an OS
      limitation, worth noting rather than filing.

### 36.2 Transcription (on-device)

- [ ] **Transcribe an interview.** Import an audio file, run the transcription.
      Expect: progress; a transcript with timestamps; the audio stays linked so you can
      click a line and hear it.
- [ ] **A whole interview, not a clip.** Run a full-length recording end to end.
      *(This one is listed deliberately: every shortcut taken in this area has produced
      a confidently wrong answer. A 20-second clip proves nothing.)*
- [ ] **Language handling.** Transcribe something **not** in English.
      Expect: either correct detection, or an explicit language choice — the one thing
      that must not happen is silently transcribing it as English.
- [ ] **Offline.** See §11.

### 36.3 The Coding workspace *(the `Coding` tab)*

- [ ] **Codebook.** Create codes, nest them under themes, rename, delete, reorder.
      Expect: the codebook lives in the project and survives reload (it is stored in
      the workspace store, written on edit — **never on mount**).
- [ ] **Multiple codebooks.** Create a second; switch between them.
      Expect: codes stay with their codebook; analyses can target the open codebook or
      every codebook in the project.
- [ ] **Code a passage.** Select text, apply a code.
      Expect: the highlight persists; overlapping codings are allowed and both show.
- [ ] **Anchoring survives edits.** Code a passage, then **edit the document text
      before it**.
      Expect: the coding stays on its passage rather than sliding. This is the anchor
      resolution path (`docs/ARCHITECTURE-coding-anchors.md`) — the thing most likely to
      break silently.
- [ ] **Code media.** Apply a code to an audio/video time range and to an image region.
- [ ] **Memos.** Attach a memo to a code, a passage and a document.
- [ ] **Codebook import/export (CSV).** Export, edit in a spreadsheet, re-import.
      Expect: round-trips; merging is **add-wins** (an imported code that already exists
      does not duplicate).
- [ ] **QDPX import.** Import a `.qdpx` from NVivo / MAXQDA / ATLAS.ti.
      Expect: documents, codebook and codings all arrive.
- [ ] **QDPX export.** Export, then open it in NVivo.
      Expect: it loads. *(This is the comparison still outstanding on your side.)*
      Reference: the **REFI-QDA** standard — NVivo, MAXQDA, ATLAS.ti and Dedoose all
      read/write it, so any of them is a valid check.

### 36.4 Quantitising — the qual→quant bridge *(5 shapes)*

From the Coding workspace. Each produces a **new dataset** you can then run statistics
on, which is the whole point.

- [ ] **A column per code.** Expect: one indicator column per code, one row per
      document; counts or 0/1 as chosen.
- [ ] **A row per passage.** Expect: one row per coding, with the code, the document and
      the passage text; "carry across" brings the source's other columns or just the
      document label.
- [ ] **A series across occasions.** Recipe: set `Case is`, `Occasion is`,
      `Measures are`.
      Expect: a long/wide series suitable for the repeated-measures and SCED analyses.
- [ ] **Which codes occur together** (co-occurrence). Recipe: choose whether
      co-occurrence means *same document* or *overlapping passages* — and check the two
      give **different** answers; nodes as codes or as themes.
      Expect: a co-occurrence matrix; the diagonal is each code's own frequency.
- [ ] **Themed word cloud.** Expect: a cloud per theme.
- [ ] **Then run statistics on the result.** Quantitise to a column per code, then run
      Crosstabs or Inter-coder agreement on it.
      Expect: it behaves like any other dataset — because it is one.
      ⚠️ Note: a *bin/convention* question for quantitising is deliberately **not
      built** and is parked until a real user needs it. Do not file its absence.

### 36.5 Collaboration on codings

- [ ] **Two coders, same project.** Both code the same documents.
      Expect: codings merge (add-wins codebook, op-log for the rest); no lost work;
      each coding attributed to its coder.
- [ ] **Then Inter-coder agreement from codings…** (§22) reads across both.

## 37. Other workspaces

- [ ] **Map** (`Map` tab) — verbs confirmed present: **Load boundaries, Shade by
      variable, Assign regions, Analyse selection, Clear, Export map, Restart**.
      Expect: each works; **Analyse selection** narrows what the statistics see;
      Restart clears cleanly.
- [ ] **Decisions** (`Decisions` tab) 🔢 — Decision Support.
      Expect: options × weighted criteria; a ranked result. **Hand-rolled arithmetic:**
      check one score by hand (Σ weight × rating), confirm weights normalise, and that
      changing one weight re-ranks sensibly.
- [ ] **Hello WS** (`Hello WS` tab) — the reference workspace for plugin authors.
      Expect: it loads, saves state, and survives reload. Its job is to prove the
      workspace API, so a failure here implicates every workspace.
- [ ] **Workspace state persistence.** In each workspace: make a change, reload.
      Expect: state restored. Specifically: **nothing is written on mount** — a
      mount-before-hydrate clobber was a real bug here, so check that opening a
      workspace and immediately reloading does not wipe what was in it.

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

Two items I built but could not verify in the browser — a Steam window was occluding
Chrome, which freezes the renderer and makes every timed check unreliable. They are
listed in §6 and §7 and are the two places to look first if something feels off:

- [ ] **#162** — the preset dropdown plus Save / Rename / Delete, and the
      missing-plugin note.
- [ ] **#190** — the analysis-row ▲▼ arrows and the busy state.

---

## Findings

| # | Step | What I saw | Data / analysis | Screenshot |
|---|---|---|---|---|
|  |  |  |  |  |
