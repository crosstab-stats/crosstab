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
    - [ ] **Large-file ceiling (the haven-in-WebR path).** WebR is wasm32 with a
          hard ~4 GB address space. The full GSS 1972–2024 cumulative (~72k ×
          ~6,700 vars: `.sav` 3.8 GB, `.sas7bdat` 2.4 GB, `.dta` 597 MB) cannot
          be read by haven in-browser — R materialises the whole frame (~3.9 GB of
          doubles) and OOMs before our Parquet bridge. Typical GSS *extracts* are
          fine; the cumulative is not. Options to lift the ceiling later:
          (a) compile **ReadStat** (the C lib haven wraps) to wasm standalone and
          stream rows → Parquet/DuckDB without R holding the frame — removes the R
          memory bottleneck; (b) variable-subset *at* import (hard with haven,
          which reads all columns first); (c) chunked reads. The DuckDB side can
          likely hold the data; the R read is the wall.
  - [ ] **Excel** via SheetJS later, if wanted (also a plugin).
  - *Note:* the Parquet return path (`DataStore.loadDataset` +
    `DuckDBManager.replaceTableFromParquet`) is built and unit-exercised by the
    contract but not yet driven end to end until the `haven` importer lands.
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
- [ ] **SPSS-style data grid view.** A spreadsheet view of the dataset, like
      SPSS's two tabs: a **Data View** (rows = cases, columns = variables, the
      cell grid) and a **Variable View** (one row per variable, columns = its
      metadata — name, type, label, value labels, measure level, missing). Today
      only the minimal `VariablesSidebar` (`core/app.js`) exists. Open questions:
      virtualised rendering for large N; whether the grid is host UI or a plugin;
      and whether cells are editable here (read-only display first; editing
      depends on the transform API below). Pairs with the **Data editor** item.
- [ ] **Data editor.** The current `VariablesSidebar` in `core/app.js` is a
      minimal stand-in. Becomes the editing layer over the data-grid view above.
- [ ] **Data transform/recode API.** `app.data` is read-only by design; mutations
      (recode, compute) need an explicit transform surface, not direct writes
      (`core/data-store.js`).
- [ ] **`app.ui.showForm`** — a general declarative form dialog. Only
      `selectVariables` exists today (`core/ui-service.js`); add this when a
      second analysis needs options beyond variable choice.

## More analyses (each is just another plugin)

- [ ] Descriptive Statistics (means, SD, quartiles…)
- [ ] Crosstabs (two-way tables, chi-square)
- [ ] Linear / logistic regression (with SPSS-style coefficient tables)
- [ ] Plots (histograms, scatter, box) — exercises `app.results.appendPlot` + SVG

## Nice-to-have / optimisations

- [ ] Batch a multi-variable Frequencies run into one R call instead of one job
      per variable (`plugins/builtin-frequencies/index.js`).
- [ ] Settings persistence (localStorage) and dataset persistence (IndexedDB).
