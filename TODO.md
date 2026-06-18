# CrossTab — TODO

Single source of truth for pending work. The README narrates *status*; this file
tracks *tasks*. When something here lands, check it off (and update the README
milestone/open-question prose if it changes the story).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Now / near-term

- [~] **Build and prove the DuckDB-WASM data engine — FOUNDATIONAL.**
      *Core engine wired in and live (desktop Chrome):* `core/duckdb-manager.js`
      owns the runtime; `core/data-store.js` is now a facade over a DuckDB table
      (Arrow IPC in, SQL query out) with metadata cached app-side. The demo
      dataset loads into DuckDB and Frequencies + `lm()` run over it end to end,
      including value labels and `-99` user-missing handling. Remaining sub-tasks
      to fully close this out are checklisted below.
  - [x] **Parquet fast-lane (Bridge B).** Injection now prefers the
        Parquet/`nanoparquet` path (`DuckDBManager.queryToParquet` →
        `WebRManager#buildInjection` → `nanoparquet::read_parquet`), falling back
        to the hardened JS-array path if `nanoparquet` can't install or anything
        errors. `nanoparquet` is installed once, lazily, and cached. Verified in
        Chrome: `lm()` and Frequencies run over the Parquet bridge with identical
        results and no fallback warnings.
  - [x] **Full type handling in `getColumns`.** Now driven by the column's actual
        DuckDB SQL type (cached `#sqlTypes`), not `VariableMeta.type`: numeric→
        DOUBLE, int64→VARCHAR, DATE/TIMESTAMP→ISO text, TIME/BOOLEAN→VARCHAR,
        text passthrough (`classifySqlType`). The non-numeric branches mirror the
        spike SQL but aren't exercised end to end until import brings such types.
  - [x] **Startup UX.** DuckDB and WebR now warm up in parallel (`setDataset`
        kicks off DuckDB; `webr.preload()` runs concurrently); status shows
        "Loading data engine…" and the sidebar shows "Loading data…" until the
        first `DATA_CHANGED`.
  - [ ] **Ingest path for large/real data.** Demo uses a one-shot Arrow ingest of
        small JS arrays; exercise/representative-test bulk ingest (and revisit
        explicit Arrow column typing so a leading-NULL column can't mis-infer).
  - [ ] **Vendor + pin** DuckDB-WASM + Arrow assets (currently CDN) — see below.
  - [ ] **iPad Safari** run of the whole engine (Milestone 3).
      Original framing kept below for context.
  - This is meant to be a real tool for real social-science work — datasets get
      large (hundreds of variables × hundreds of thousands of cases) — so the
      engine has to scale, not just demo.
  - **Decision (made): DuckDB-WASM is the data backend, with Apache Arrow as the
    interchange format.** A modern tablet (e.g. M5 iPad Pro) can comfortably
    carry a second WASM runtime alongside WebR, so the earlier "lean on iPad,
    avoid a second heavy runtime" caution is explicitly overruled. DuckDB owns
    storage + filtering/aggregation/out-of-core; R (WebR) does the statistics;
    Arrow is the zero-copy bridge between them.
  - **What the current store gets wrong at scale (the motivation):** today
    `core/data-store.js` keeps in-memory columnar JS arrays — `Float64Array` for
    *all* numerics (an int-coded factor still costs 8 bytes/cell; 200 vars × 500k
    cases ≈ 800 MB of numerics alone), `getDataFrame()` materialises one object
    per row (O(rows×cols)), and WebR injection (`core/webr-manager.js`) boxes
    every column into a plain `number[]` that R then re-copies (~3× resident).
    DuckDB + Arrow replaces all three with typed columnar storage and a
    near-zero-copy hand-off.
  - **The DuckDB↔WebR bridge — SPIKED & ANSWERED** (`spike/`, see
    `spike/RESULTS.md`). Both directions work on desktop Chrome:
    - **Bridge A (default):** DuckDB result → Arrow JS column `.toArray()` →
      plain JS arrays → WebR `data.frame`. No extra R packages; always viable.
    - **Bridge B (fast lane):** `nanoparquet` **installs cleanly in WebR**, so
      DuckDB `COPY … TO parquet` → bytes through WebR's virtual FS →
      `nanoparquet::read_parquet` in R. Lower-copy; the heavyweight R `arrow`
      package was *not* needed.
    - Confirmed: push filtering/aggregation down to DuckDB and hand R only the
      reduced result — full-table group-by over 500k rows was 0.02 s; R only
      ever sees what an analysis needs.
    - Numbers at 200 × 500k: ~1.25 s to generate in-engine, ~1.24 GB peak with
      *both* runtimes resident (well under the wasm ~4 GB ceiling). The
      "two heavy runtimes" worry is not a blocker at this scale.
    - Messy-data fidelity **spiked & answered** (`spike/messy-data-spike.html`,
      32/32 checks). Both bridges carry NULLs, empty-string-≠-NA, SPSS
      user-missing (`-99`→NA), dirty-text-→-NA, unicode, and factor labels —
      via **metadata-driven cleaning pushed into DuckDB SQL** (see plan below).
      Two real bridge bugs were caught and fixed in the process (see below).
      On the evidence, **prefer Bridge B (Parquet) as the default** (native
      types, decimals, NULLs for free) with hardened Bridge A as fallback.
    - Full type coverage **spiked & answered** (`spike/datatypes-spike.html`,
      52/52 checks). int64, boolean, DATE, TIMESTAMP, ±Inf/NaN, DECIMAL, and
      beyond-BMP unicode all round-trip on both bridges with the rules below.
      **R has no native int64** (confirmed: native int64 → double silently drops
      precision), so carry 64-bit ints as **character** by default.
    - Remaining unknowns are device-/perf-only: cold (uncached) WebR load and
      the whole path **on iPad Safari** (fold into the Milestone-3 device pass).
  - **Messy-data handling plan (bake into the rewrite):** real survey/admin data
    is dirty, so the cleaning rules are part of the engine, not an afterthought.
    App-side `VariableMeta` drives a generated DuckDB cleaning `SELECT`:
    - `sourceText` columns (look numeric, contain junk) → `TRY_CAST(col AS DOUBLE)`
      so junk becomes NULL, never a hard error.
    - `missingValues` → `CASE WHEN col IN (…) THEN NULL …` to fold SPSS
      user-defined missing codes into real NULLs.
    - Factors travel as codes; reapply `factor(x, levels, labels)` in R from the
      app-side value labels. Empty string stays data, not NA.
    - **JS-array bridge must `CAST` numeric columns to `DOUBLE`** (see bug 2).
    - **int64 → `CAST … AS VARCHAR`** (R has no native int64; carry IDs as
      character, opt into `bit64` only for 64-bit arithmetic).
    - **Temporal:** Bridge B reads `DATE`/`TIMESTAMP` natively; Bridge A carries
      them as ISO text and reconstructs with `as.Date`/`as.POSIXct`. Pin
      `tz="UTC"` (DuckDB `TIMESTAMP` is tz-naive) so wall-clock values don't
      shift by the browser's local zone. `TIMESTAMPTZ` needs a policy later.
  - **Two bridge bugs the spike caught (must stay fixed in the real impl):**
    1. Arrow `.toArray()` silently drops NULLs (values buffer ≠ validity bitmap);
       read per-cell with `.get(i)` so missing → `null` → R NA.
    2. DuckDB infers DECIMAL for literals like `55000.0`; Arrow-JS `.get()`
       returns the *unscaled* integer → silent ×10^scale corruption. Fix:
       `CAST … AS DOUBLE` in SQL before JS extraction. (Parquet path is immune.)
  - **Re-architecture this implies:** `DataStore` becomes a thin facade over a
    DuckDB connection rather than the owner of JS arrays; `getColumns` /
    `getDataFrame` / `getVariableMeta` stay as the contract but are now backed by
    SQL queries (+ an Arrow path for the fast lane). Variable metadata
    (labels/value-labels/missing/measure) still lives app-side since SQL columns
    don't carry SPSS semantics. Keep the public `app.data` API stable so plugins
    don't care that the backend changed.
  - **Acceptance / proof — DONE (desktop Chrome).** `spike/duckdb-webr-spike.html`
    loads DuckDB-WASM, generates 200 × 500k in-engine, pushes an aggregate down to
    DuckDB, bridges a reduced result into WebR, and runs `lm()` — measuring memory
    and timings throughout. Round-trip demonstrated; see `spike/RESULTS.md`. The
    remaining acceptance gap is the **iPad Safari** run of the same path.
  - **Vendor + pin** the DuckDB-WASM build and its worker/WASM assets the same
    way the WebR pin is planned (see Hardening), for reproducibility + offline
    PWA use.
  - Blocks/feeds: **File import** (DuckDB reads CSV/Parquet natively, which
    reshapes that task), **SPSS-style data grid** (virtualised grid backed by
    `LIMIT/OFFSET` SQL windows over DuckDB — a natural fit), **Data
    transform/recode API** (becomes SQL / `CREATE TABLE AS`). Settle the
    `getDataFrame`/`getColumns` contract here so those don't get reworked later.
- [ ] **Milestone 3 — verify on iPad Safari.** The desktop-Chrome path is
      confirmed; Safari/iPadOS is the remaining unknown. Two specific risks:
  - [ ] Blob-module `import()` inside the sandboxed (opaque-origin) iframe
        (`plugin-host.html`). Fallback if it fails: `data:`-URL import or a build step.
  - [ ] Cross-origin isolation via the **`coi-serviceworker`** reload path
        (`sw.js`) — local testing used real COOP/COEP headers, so `sw.js` itself
        is still unexercised on a device.
  - [ ] Also sanity-check `<dialog>` modal behaviour and touch targets on iPad.
- [ ] **Add a committed dev server for contributors.** The README points at
      `python -m http.server`, which on Windows can serve `.js` with the wrong
      MIME type and sets no COOP/COEP. Ship a small `scripts/dev-server.mjs`
      (correct MIME + isolation headers) and an npm script, replacing the
      throwaway temp-file server used during testing.
- [ ] **Add a `LICENSE`.** Intended to be open source; license is currently TBD.
- [ ] **Provide the PWA icons** referenced by `manifest.json`
      (`vendor/icon-192.png`, `vendor/icon-512.png`) — they don't exist yet.

## Hardening before any public/shared deploy

- [ ] **Replace the HTML sanitiser with a vetted library (DOMPurify).**
      `core/sanitize-html.js` is a conservative allowlist starter, not an audited
      XSS defence. All plugin output is untrusted, so this matters.
- [ ] **Pin the WebR version and vendor its assets.** `core/webr-manager.js`
      currently loads `…/latest/webr.mjs` for convenience. Pin a version and
      self-host for reproducibility + offline PWA use.
- [ ] **PWA precaching.** Fold asset precaching into `sw.js` once WebR assets are
      vendored, so the app works offline (`sw.js` TODO).

## Open questions / decisions to make

- [ ] **API major-version migration policy.** Loader enforces matching major +
      engine-minor ≥ plugin-minor (`core/loader.js`); what a breaking bump means
      for installed plugins (shims? hard break?) is undecided.
- [ ] **R package pre-loading strategy.** Plugins declare `rPackages` in their
      manifest, but which packages ship with the default plugin set vs. install
      on demand — and how heavy shared deps are handled — is open.
  - *Decided: `bit64` is install-on-demand, not default.* int64 columns are
    carried as **character** by default (storage stays native `BIGINT` in DuckDB;
    R has no native int64 — see the data-engine item). `bit64::integer64` buys
    nothing for storage/transport/display (JS `Number` hits the same 2⁵³ wall),
    so it's only worth loading for genuine 64-bit *arithmetic in R* — a per-
    variable opt-in to add later, purely additive, no debt from deferring.
- [ ] **Multi-file plugins.** Blob-imported modules can't resolve relative
      imports. Decide on an import-map or bundling story so plugins can span files.

## Deferred features (intentionally not built yet)

- [~] **File import — as a plugin extension point.** Importers register via the
      public `app.importers.register({ label, extensions, parse })`; the engine
      (`core/import-service.js`) owns the File ▸ Import menu, the picker, and the
      commit (`DataStore.loadDataset`), and hands the chosen file's bytes to the
      plugin to parse. Dual return contract: `{variables, columns}` (JS-parsed)
      or `{variables, parquet}` (R-parsed/large). Once the format coverage below
      is enough, delete the temporary `core/demo-data.js` seed.
  - [x] **CSV importer plugin** (`plugins/builtin-csv-import/`). Pure-JS parser
        (quotes, embedded commas/newlines, `\r\n`, conservative numeric
        inference) → `{variables, columns}`. Verified in Chrome end to end:
        menu → picker → sandboxed parse → DuckDB; analyses run on the result.
  - [x] **`haven` importer plugin (covers GSS)** (`plugins/builtin-haven-import/`).
        Reads SPSS `.sav`/`.por`, Stata `.dta`, SAS `.sas7bdat`/`.xpt` via R
        `haven`, extracts variable labels + value labels + user-missing +
        measurement level as JSON, writes label-stripped data to Parquet, and
        returns `{variables, parquet}`. New `app.webr.writeFile`/`readFile` stage
        the bytes into / out of WebR's FS (the engine-side work). `haven` installs
        on demand (~5.5s first time). SPSS read uses `user_na = TRUE` so distinct
        GSS missing codes (DK/Refused/NAP) survive as sentinels + metadata rather
        than collapsing to NA. **Verified in Chrome** with a haven-written `.sav`
        round-trip: value labels render in Frequencies, `-99` recodes to Missing.
    - [ ] *Still to test:* real GSS files (the synthetic round-trip proves the
          mechanism, not every real-file quirk); SAS value labels need the
          separate `.sas7bcat` catalog (`read_sas(data, catalog_file)`) — not yet
          wired; `na_range` (range-style SPSS missing) not yet captured, only
          discrete `na_values`.
    - [ ] **Large-file ceilings (the haven-in-WebR path).** Two distinct limits,
          both hit by the full GSS 1972–2024 cumulative (`.sav` 3.8 GB,
          `.sas7bdat` 2.4 GB, `.dta` 597 MB):
      - **WebR `FS.writeFile` ~128 MB (the *first* wall) — LIFTED via WORKERFS.**
        `FS.writeFile` throws "Invalid array length" above ~128–160 MB (a channel
        limit). The haven importer no longer uses it: it stages the upload by
        **mounting the `File` via WORKERFS** (`app.webr.mountFile`), which is lazy
        and copy-free, so there's no staging size limit. **Verified:** a 181 MB
        `.sav` mounts and `haven::read_sav` reads it (700k × 30). The importer
        contract now hands plugins the `File` (by reference, no sandbox copy)
        rather than an `ArrayBuffer`. (A failed import also no longer clobbers the
        loaded dataset — that was a separate bug, fixed.)
      - **`readFile` ~128 MB on the way *back out* (the new edge).** Pulling the
        Parquet snapshot R writes back to JS still uses the channel, so a returned
        Parquet > ~128 MB hits the same limit. Mitigate with **chunked readFile**
        (R splits the file, JS concatenates — exactly the trick used to test the
        181 MB case). Not yet wired into the importer; modest Parquet outputs are
        fine today.
      - **WebR ~4 GB wasm address space (the *second* wall) — now the live limit,
        and it fails gracefully.** Confirmed on the real 597 MB GSS `.dta`: with
        WORKERFS staging it gets *past* the FS wall and into `haven::read_dta`,
        then R exhausts the heap ("cannot allocate vector of size …"). Verified
        this errors **cleanly** — the dataset is preserved (not clobbered), WebR
        recovers (subsequent runs + `lm()` still work), and the importer now shows
        a plain-language out-of-memory message instead of R's cryptic one.
        Confirmed empirically:
        `R.version$platform` = `wasm32-unknown-emscripten`, `.Machine$sizeof.pointer`
        = 4 — WebR is a **wasm32** build, so a single linear memory caps at ~4 GiB.
        Even past the FS limit, haven materialises the whole frame in R (~3.9 GB of
        doubles for the cumulative) and OOMs before our Parquet bridge.
        *Note on wasm64:* the WebAssembly **Memory64** proposal lifts the 4 GiB cap
        and Chrome ships it, but WebR isn't compiled for it (would require rebuilding
        the whole package repo + Fortran toolchain for Memory64, costs perf, and
        regresses Safari/iPad) — and it wouldn't even help here, since the ~128 MB
        FS channel limit and JS ArrayBuffer limits sit earlier in the path. So don't
        wait on wasm64. The real lift: compile **ReadStat** (the C lib haven wraps)
        to wasm standalone and **stream** rows → Parquet/DuckDB without R holding the
        frame — sidesteps the 4 GiB ceiling entirely.
      - **Variable-subset at import — BUILT, and it's the practical answer to the
        4 GB wall.** (Earlier note said this was "hard with haven"; that was wrong.)
        haven's `n_max = 0` reads the variable catalog essentially free, and
        `col_select` reads only chosen columns — so only the selected subset is
        materialised, keeping memory bounded by the selection, not the file. New
        **"SPSS / Stata / SAS — choose variables…"** importer + a searchable
        `app.ui.selectFromList` picker. **Verified:** catalog read instant,
        `col_select` of 3 of 1000 cols ~0.2 s (`.dta` seeks, doesn't parse all),
        end-to-end pick-and-import correct with labels intact. So the full GSS is
        now usable in-browser via choose-variables (only the columns you pick load);
        whole-file import of the cumulative remains OOM-bound and needs the ReadStat
        streaming lift above. Note: `.sav` is compressed so `col_select` there must
        stream (slower than `.dta`), but still memory-safe.
      - Typical GSS *extracts* (well under 128 MB) import whole fine today.
  - [ ] **Excel** via SheetJS later, if wanted (also a plugin).
  - *Note:* the Parquet return path (`DataStore.loadDataset` +
    `DuckDBManager.replaceTableFromParquet`) is built and unit-exercised by the
    contract but not yet driven end to end until the `haven` importer lands.
- [x] **Multi-file import / import-as-append (pooled, row-stack).** Decision:
      pool into ONE table with a `source_file` provenance column (not a
      multi-dataset workspace); row-stack only (column-join/merge is separate).
      Built engine-side — plugins unchanged (still parse one file → one dataset):
  - `DataStore.loadDataset({mode:'replace'|'append', source})` + `#appendDataset`
    stacks via DuckDB **`UNION ALL BY NAME`** (auto column-union + NULL-fill for
    cross-year drift). `source_file` auto-added when pooling (basename per file);
    single-file replace stays clean (no extra column). Variable metadata merged
    (union; existing-wins on shared names).
  - `ImportService` picks **multiple** files (importer `multiple:true` — set on
    whole-file haven + CSV; filtered haven stays single), parses each, and
    prompts **Replace vs. Add to current data** when a dataset is loaded.
  - **Verified in Chrome:** batch-import 2 CSVs with differing columns → 4 rows,
    columns unioned (NULLs filled), tagged `y2022`/`y2024`; then incremental
    append a 3rd → 6 rows, all `source_file` tags correct; group-by `source_file`
    in DuckDB + WebR works. Covers the multi-year GSS workflow (batch or
    incremental; incremental + filtered importer pools huge files a year at a time).
  - *Deferred:* column-join/merge by ID key (separate feature); "filtered +
    batch, pick variables once for all files" (incremental filtered append covers
    the need); richer type-conflict handling (today `UNION ALL BY NAME` coerces or
    errors — surfaced as an error); value-label conflict policy across years (ties
    to the recode API). Also the SAS `.sas7bcat` companion-file case is a
    different "more than one file" still unhandled.
- [ ] **Import data from a web page (URL scrape).** Point the app at a URL; it
      fetches and parses tabular data (e.g. HTML `<table>`s) into a new dataset
      for analysis, with an option to save the parsed data locally as CSV (or
      another suitable format) for archival.
  - **Approach is an open decision, not a given.** Two independent sub-decisions:
    - *How to fetch (the real blocker):* the browser can't GET arbitrary
      cross-origin URLs (CORS) — and this is true even inside a WASM runtime,
      since Pyodide/WebR fetch through the browser too. So: a small serverless
      proxy (e.g. Cloudflare Worker/Function) that does the cross-origin GET,
      **or** a no-server fallback where the user pastes page HTML / uploads a
      saved page. This choice touches the "purely static, no backend" positioning.
    - *How to parse:* Python + BeautifulSoup IS viable client-side via **Pyodide**
      (CPython-in-WASM; bs4 is pure Python, installable with `micropip`) — but
      that pulls in a *second* large WASM runtime on top of WebR. Lighter
      alternatives that add zero new runtime: the browser's native `DOMParser`
      table extraction, or R's `rvest`/`xml2` inside the WebR we already load.
      (Server-side bs4 is also an option if we add the proxy above.) Choose
      deliberately — bs4/Pyodide is the heaviest of these, not the default.
  - Reuses the same ingest path as file import (`DataStore.setDataset`); the
    "save as CSV" archival option overlaps with CSV export work.
- [~] **SPSS-style data grid view.** *Read-only v1 built* (`core/data-views.js`):
      a tabbed workspace (**Data | Variables | Output**) beside the sidebar.
  - **Data View** — **2-D virtualised** cell grid: renders only the rows *and*
    columns near the viewport, fetching each block via `DataStore.getRows` →
    DuckDB `LIMIT/OFFSET` (with the visible column subset). Fixed 120px columns
    (ellipsis + tooltip) make column windowing possible. Verified: a 300-col ×
    500-row import renders ~21 cells/row (not 301) and ~46 rows, windowing on both
    axes; a wide GSS file scrolls smoothly (the all-columns render was the lag).
    Factor codes show as value labels (raw on hover); sticky header + row-number
    gutter. (Resolved old open questions: **host UI, not a plugin**; **read-only**.)
    Watch-out fixed: the workspace flex item needs `min-width:0` or it expands to
    the grid's full width and column virtualisation silently no-ops.
  - **Variable View** — per-variable metadata table (name, label, type, measure,
    value-label summary, missing codes). The consolidated picture for recode
    decisions (you can see GSS's `-99`/value-labels here).
  - Tabs auto-focus: analyses → Output, finished import → Data.
  - *Still to do:* editing cells (the **Data editor**, needs the transform API);
    a raw-codes vs value-labels toggle; column sort/resize and per-column width
    (fixed 120px today).
- [ ] **Data editor.** The current `VariablesSidebar` in `core/app.js` is a
      minimal stand-in. Becomes the editing layer over the data-grid view above.
- [~] **Data transform/recode.** *Metadata transforms built* (Phase 1) via an
      **editable Variable View** — click a variable to edit it.
  - `DataStore.updateVariable(name, patch)`: set label / type / measure / value
    labels / missing codes. **Non-destructive** (data not rewritten, reversible),
    except re-typing **to numeric** casts the column `TRY_CAST → DOUBLE` so numeric
    analyses get real numbers (other type changes are metadata-only). Designating
    missing follows the SPSS model: codes stay in the data, `missingValues`
    metadata marks them, analyses honour it.
  - **Verified in Chrome:** edited demo `gender` → re-type factor→numeric (the
    VARCHAR→DOUBLE cast worked, `getColumns` now returns a `Float64Array`),
    designate code `1` missing, relabel; a Frequencies run then showed Female 15
    valid / **15 Missing** — i.e. the recode flowed end to end into the analysis.
    This is the GSS fix path (retype `age`→numeric + designate negative codes).
  - **Phase 2 (deferred) — value-recode / compute (data-mutating):** collapse
    categories into a new variable, computed vars — `CREATE TABLE … AS SELECT …`,
    default to new-variable. Needs an expression/mapping UI.
  - *Still to do (Phase 1 polish):* a GSS-aware "mark missing" preset (the known
    iap/dk/na/refused/… labels); **range** missing (e.g. all `< 0`), not just a
    discrete list; value-label conflict policy on multi-year append; and the
    earlier idea of surfacing a warning when imported data has un-designated
    candidate missing codes. Also: only the Frequencies plugin honours
    `missingValues` today — future analyses must too (or centralise it at
    injection).
- [ ] **`app.ui.showForm`** — a general declarative form dialog. Only
      `selectVariables`/`selectFromList` exist today (`core/ui-service.js`); add
      this when a second analysis needs options beyond variable choice.
- [ ] **Dataset library (save / catalog / one-click reload).** Researchers
      revisit data constantly; importing GSS via haven is slow (minutes), so the
      big win is **caching the post-import result** — reload should never re-parse.
  - **Storage: OPFS, not a real directory.** The File System Access "point at a
    folder" idea isn't on Safari/iPad (our target). **OPFS works on iPad Safari +
    Chrome**, is persistent, and handles large files — *verified in-browser:*
    round-trips fine, ~10 GB quota, but `navigator.storage.persisted()` is
    `false` by default (call `navigator.storage.persist()` on first save to avoid
    eviction). Keep "export/import to real disk" via File System Access as a
    *secondary* feature on browsers that support it (portability/sharing/backup).
  - **Format:** per dataset, write `<id>.parquet` (DuckDB `queryToParquet`, exists)
    + `<id>.meta.json` (the `VariableMeta` Parquet can't carry) + one
    `catalog.json` index (`{id, name, description, rowCount, varCount, source,
    savedAt}`). Reload = read Parquet → `replaceTableFromParquet` (exists) +
    restore metadata. Caches *past* the slow haven parse → reload is ~instant.
  - **Architecture:** OPFS is origin-scoped, so a sandboxed plugin gets its *own*
    OPFS, not the host's — persistence MUST be an **engine capability** exposed
    like `app.importers`/`app.ui` (e.g. `app.datasets.save/list/load/delete`). The
    "library" is then a **catalog-UI plugin** driving that primitive — on-pattern.
  - **Shape likely hinges on decisions not yet made** (why this is deferred):
    - *Single vs. multi-dataset model.* App holds one DuckDB table today, so
      "load" = *switch* the active dataset. If we later support multiple loaded
      datasets / joins, the library's model changes.
    - *What a "saved dataset" includes.* Just data+metadata, or also recodes/
      transforms (needs the recode API) and saved analyses? Leans on the
      transform/recode surface and any analysis-history feature.
    - *Multi-file/append* entries (a library item that is several GSS years).
    - Supersedes the old "dataset persistence (IndexedDB)" line — OPFS is better.

## More analyses (each is just another plugin)

- [ ] Descriptive Statistics (means, SD, quartiles…)
- [ ] Crosstabs (two-way tables, chi-square)
- [ ] Linear / logistic regression (with SPSS-style coefficient tables)
- [ ] Plots (histograms, scatter, box) — exercises `app.results.appendPlot` + SVG

## Nice-to-have / optimisations

- [ ] Batch a multi-variable Frequencies run into one R call instead of one job
      per variable (`plugins/builtin-frequencies/index.js`).
- [ ] Settings persistence (localStorage). (Dataset persistence is now its own
      item — see **Dataset library** under Deferred features; OPFS, not IndexedDB.)
