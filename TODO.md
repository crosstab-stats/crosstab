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
- [~] **Import data from a web page (URL scrape).** Point the app at a URL; it
      fetches and parses tabular data (e.g. HTML `<table>`s) into a new dataset
      for analysis, with an option to save the parsed data locally as CSV (or
      another suitable format) for archival.
  - [x] **Wikipedia table importer built** — `plugins/builtin-wikipedia/`. The
        first scrape-style importer and a concrete slice of this item. Paste an
        article URL or title → fetches via Wikipedia's **CORS-open REST API**
        (`/api/rest_v1/page/html/<Title>`), so **no proxy needed**; parses with
        native `DOMParser` (no R, no Pyodide). Flattens `colspan`/`rowspan`,
        strips Parsoid-inlined `<style>`/`<link>` (these leak into `textContent`
        — caught a `font-size:80%` becoming a height of `80`), `<br>`→space for
        multi-line headers, and infers numeric columns by leading-number match
        (`"168.2 cm (5 ft 6 in)"`→168.2, `"1,234"`→1234). Multi-table pages show
        a picker with `R×C` + header previews. Verified live end-to-end on the
        height (140×8) and electricity (216×4) tables.
    - *Known best-effort limits:* a messy mixed column like `"18–69 (N= m:…)"`
      gets classed numeric (grabs the `18`); year ranges collapse to the first
      year. The Variable-View retype (immutable transform) is the escape hatch.
      Comma-decimal locales would misparse (en.wikipedia assumes `.` decimals).
    - *Still open for the general case:* arbitrary non-Wikipedia pages still hit
      the proxy-vs-paste fetch decision below, and JS-rendered SPAs won't expose
      tables to a plain GET. The Wikipedia path sidesteps both via its API.
  - **Approach is an open decision, not a given.** Two independent sub-decisions:
    - *How to fetch (the real blocker):* the browser can't GET arbitrary
      cross-origin URLs (CORS) — and this is true even inside a WASM runtime,
      since Pyodide/WebR fetch through the browser too. So: a small serverless
      proxy (e.g. Cloudflare Worker/Function) that does the cross-origin GET,
      **or** a no-server fallback where the user pastes page HTML / uploads a
      saved page. This choice touches the "purely static, no backend" positioning.
      (Note: the FRED work added the **`web` importer source + `app.web.get(url)`**
      primitives and proved a public CORS proxy works through our COEP isolation —
      a scrape plugin can reuse both; the proxy-vs-paste decision still stands.)
    - *How to parse:* Python + BeautifulSoup IS viable client-side via **Pyodide**
      (CPython-in-WASM; bs4 is pure Python, installable with `micropip`) — but
      that pulls in a *second* large WASM runtime on top of WebR. Lighter
      alternatives that add zero new runtime: the browser's native `DOMParser`
      table extraction, or R's `rvest`/`xml2` inside the WebR we already load.
      (Server-side bs4 is also an option if we add the proxy above.) Choose
      deliberately — bs4/Pyodide is the heaviest of these, not the default.
  - Reuses the same ingest path as file import (`DataStore.setDataset`); the
    "save as CSV" archival option overlaps with CSV export work.
- [x] **FRED import (economic time series).** *Built* — `plugins/builtin-fred/`.
      Pulls a St. Louis Fed **FRED** series by ID (e.g. `UNRATE`, `GDP`, `CPIAUCSL`)
      into a 2-column dataset (`date` + the series), best-effort labelled with the
      series title. Economics is a social science and FRED is *the* canonical econ
      source, so this is high-value for that audience. How the open questions resolved:
  - *Fetch / CORS.* Verified (don't assume): FRED's API sends **no**
    `Access-Control-Allow-Origin`, so a direct browser `fetch` is blocked. Routed
    through a **public CORS proxy** (`corsproxy.io`) — confirmed live the proxy
    re-serves FRED's JSON (and its error JSON) intact through our COEP isolation.
  - *API key in a browser.* The user supplies their own key in the import dialog
    (`app.ui.showForm`, masked field); we never bundle one. The key transits the
    proxy — acceptable because a FRED key is a free public-data rate-limit id, not
    a secret (documented in the plugin header). We would never proxy a real
    credential this way.
  - *Architecture gap it surfaced — now closed.* FRED is a network source, not a
    file, so it needed a non-picker ingest path. Added the **`web` importer source**
    (`Importer.source: 'web'`): the engine registers the menu item but opens no
    picker, calls `parse({ ticket })`, and the plugin fetches its own bytes via the
    new **`app.web.get(url)`** surface, then `deliver`s a dataset through the
    existing commit path. The URL-scrape item can reuse both primitives.
- [x] **Merge / join datasets by a key variable.** *Built* — combines two datasets
      side by side on a shared key (e.g. Wikipedia height vs. electricity **by
      country**). Import gains a **Join** mode (alongside Replace / Add rows) for a
      single incoming dataset.
  - **Engine** (`core/data-store.js`): sources gained a `combine` mode —
    base / append (UNION) / **join (LEFT JOIN)**. `rederive` composes stacked rows
    then hangs joined columns off them. Keys are **normalised** (text/lower/trim) so
    case/whitespace don't block a match; the redundant right key is dropped;
    colliding columns are suffixed `col (label)`; unmatched base rows NULL-fill
    (base preserved). Stored on the source descriptor (`combine/joinKey/aliases`),
    so a joined dataset round-trips through the library as a join.
  - **No fuzzy matching — manual pairing instead** (`core/import-service.js`
    `showJoinReview`): the review dialog picks the key on each side, shows a live
    match preview, and lists the leftovers in two columns; click-to-pair resolves
    them by hand → recorded as `aliases` (incoming→base), applied before
    normalisation. Honest-and-visible beats clever-and-occasionally-wrong (no
    silent `Niger`↔`Nigeria`).
  - **Verified end to end in Chrome:** real Wikipedia electricity table joined onto
    a country base — auto key-guess (country↔Location), normalized match (China/US/
    India/Japan), columns merged; and the manual path: base `USA` unmatched →
    paired with incoming `United States` → row got US electricity. Plus headless:
    collision suffix, NULL-fill, alias remap, save/restore preserves the join.
  - *Deferred:* fuzzy/alias-crosswalk reuse across joins, composite (multi-col)
    keys, INNER/FULL options (LEFT only for now), join-with-a-library-entry (today
    it's the import path), and preview for parquet-only importers (haven — needs
    staging the incoming key to DuckDB first; columns-based importers work today).
    Row order isn't base-stable after a join (DuckDB join order) — polish later.
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
  - **Column selection + filter (built).** Each column header carries a checkbox
    tied to the shared variable selection, and a toolbar filter narrows the
    visible columns by name/label (rides the existing column virtualisation). The
    selection is one source of truth across grid headers ↔ sidebar ↔ pickers, so:
    **`selectVariables` now floats already-selected variables into a "Selected"
    group at the top, pre-checked** (`core/ui-service.js`) — tick columns in the
    grid, open a single-round analysis, glance, OK. Single-select (radio) pickers
    only pre-check when exactly one is selected; with several, they're surfaced on
    top but left for the user to choose. No plugin changes; two-round plugins are
    unaffected (the dialog always shows). Verified end to end in Chrome: grid-tick
    age+income → Descriptives picker pre-checked both → ran with no manual ticking;
    filter, toggle, and grid↔sidebar sync all confirmed.
  - Tabs auto-focus: analyses → Output, finished import → Data.
  - *Still to do:* a raw-codes vs value-labels toggle; column sort/resize and
    per-column width (fixed 120px today). Possibly retire the sidebar variable list
    now that grid headers carry selection (under consideration).
- [x] **Data editor (editable cells) — BUILT** (`core/data-views.js` +
      `core/data-store.js`). Double-click a cell in the Data View to edit it. The
      edit is a **sparse override transform** (`{type:'setCell', row, column,
      value}`): non-destructive (the immutable source table is untouched —
      verified the raw source keeps its original value), undoable/redoable, shown
      as a step in the **History** panel ("Edited cell · age — row 1 = 777"), and
      emitted by **export-to-syntax** (`d[["age"]][1] <- 777`). Applied in
      `rederive` by wrapping the derived view: `row_number()` over the view's
      natural order (the same order the grid reads) + a `CASE` per overridden cell;
      numeric columns parse the value, blank → NA. **Verified end to end in
      Chrome:** UI double-click → edit → persists + shows in grid; undo reverts;
      source immutable; History + syntax both reflect it.
  - **Stable per-row ids — DONE (edits are reorder-proof).** Each immutable source
    bakes a hidden `__ct_rid` column at creation (`sourceIndex × 1e9 + rownum`),
    persisted in the source Parquet and **never regenerated on restore**. The
    derived view carries it through (UNION aligns it; joins inherit the base row's
    id), and cell overrides key on it (`CASE __ct_rid WHEN <id> …`) instead of a
    positional index — so an edit follows its row through appends and
    row-reordering joins. The id is hidden (never in `getVariableMeta`/`getColumns`/
    `getDataFrame`, so analyses/CSV/R injection are untouched); the grid reads it
    via `getRows({includeRowId})`; ids cross the BIGINT→JS boundary as digit
    strings (no float precision loss). **Verified in Chrome:** the edited row keeps
    its value after an append and a join; ordering the view by id puts the edited
    row at scan position 31 yet it still reads the edited value (position-
    independent); and the edit survives an export→restore round-trip with the id
    intact. `row` is retained on the transform only as a display label for History/
    syntax.
  - *Still to do:* edit a factor cell by picking a **label** (today you type the
    raw code); range/fill edits; the old `VariablesSidebar` stand-in in `app.js`
    can now lean on this for any remaining inline editing.
- [~] **Source-immutability + transform log — BUILT** (`core/data-store.js`).
      Re-architected per the README principle: immutable per-file source tables
      (`ct_source_N`) + an ordered transform log → a derived DuckDB **VIEW**
      (`dataset`) that every read queries. Metadata transforms recompute only the
      JS metadata; retype-to-numeric is a `CAST` in the view; append is another
      source in the `UNION ALL BY NAME` — so sources are never mutated and there's
      no data duplication. **Verified in Chrome:** retype gender→numeric reflects
      in the view (DOUBLE) while `ct_source_1` stays VARCHAR (immutable); `undo()`
      reverts it; append pools with `source_file` + NULL-fill; replace drops old
      sources cleanly; injection/grid read the view.
  - **To-fix — all the prior violations are now closed:**
    - [x] Source/working/log separation — the core gap; now sources + log →
          derived view.
    - [x] Retype-to-numeric no longer `ALTER`s storage — it's a view-level `CAST`
          over the untouched source column (reversible via `undo`).
    - [x] Append no longer `DROP`/`RENAME`s the table — it adds an immutable
          source and redefines the view.
    - [x] Transform log exists — `getTransforms()` + `undo()` on `DataStore`
          (internal/engine for now; reproducible & undoable).
    - [x] **Cell editor uses a sparse override transform** — not a destructive
          cell write. `{type:'setCell', row, column, value}` applied as a `CASE` in
          the derived view; the source stays immutable (see the Data editor item).
  - [x] **Universal log + strict sequential replay — BUILT.** `#sources` + a
    separate transform log were merged into **one ordered `#log`** in
    `core/data-store.js`: every operation — `load`/`append`/`join` (data loads) and
    `setVariable`/`setCell`/`computeVar`/`recodeVar` (data transforms) — is a
    single, ordered, undoable entry. `rederive` **folds the log strictly in order**
    (sequential replay), so each op sees exactly the state the prior ops produced —
    true do-file semantics. So **imports/appends/joins are first-class History
    steps you can undo, redo, and rewind across**, AND order is honoured: a compute
    logged before an append is evaluated over the pre-append data, and the appended
    rows get NULL for it (via `UNION ALL BY NAME`). The engine result therefore
    matches running the log as a script.
    - **Reproducibility (the point):** persisted shape stays `{sources, transforms}`
      *plus* an `order` tag stream (`['s','t','s',…]`) so a restore replays the
      exact interleaving — same result on another machine. Old saves without
      `order` fall back to source-ops-then-transforms. `getTransforms` stays
      data-only, so projects/library/version-pull are untouched (backward-compat).
      `order` threaded through `project-store` + `dataset-store`.
    - *Tradeoff (faithful, less forgiving):* a retype/recode *before* an append no
      longer auto-covers the appended rows — sequence the cleaning *after* loading,
      exactly like a real do-file.
    - **Verified in Chrome:** compute-before-append → appended rows NULL for it;
      compute-after-append → all rows; the `order` hint survives `exportState`/
      `restoreState` *and* a full project JSON round-trip (appended row stays NULL
      for the pre-append compute); undo across source ops; join + retype under
      sequential; rid cell-edits stable; no rid/source leak.
    - **Fixed an autosave auto-create race** (surfaced while testing this): a burst
      of changes *during* the first project auto-create couldn't schedule (no
      binding yet) and `#fullSave` then cleared the dirty set, so a rapid
      replace→compute→append right after the first edit lost the append.
      `ProjectSync` now records `#changedWhileCreating` and does a full catch-up
      save once the binding exists. Verified: the no-spacing burst now round-trips
      through project open with the full history + the appended row intact.
  - [x] **History / rewind panel — BUILT** (`core/data-views.js` `HistoryView`, a
    4th workspace tab between Variables and Output). A **linear** transform-history
    view: an as-imported base step + a numbered step per logged transform, each
    described in plain language ("Edited age · type → numeric · missing: -99");
    click any step to rewind (or fast-forward) to that state. The current position
    is highlighted; steps *ahead* of it (undone but redoable) render greyed and
    stay clickable. Engine: `DataStore.getHistory()` (applied + future + sources)
    and `DataStore.rewindTo(n)` (moves the applied/redo boundary and re-derives
    **once**, cheaper than walking N undo/redo calls), delegated through
    `DatasetManager`. A fresh edit after a rewind discards the steps ahead (standard
    linear branch-discard). The rewound state autosaves (a `'rewind'` DATA_CHANGED
    reason — not source-dirtying, so no Parquet rewrite). Verified end to end in
    Chrome: backward rewind reverts derived metadata, forward fast-forward restores
    it, branch-discard works, autosave fires. Decision (settled): **linear, not
    git-style branching** — the audience thinks in linear syntax files, and
    divergent exploration is already served by the multi-dataset workspace (fork =
    a separate dataset). No branch tree / diff UI / prune.
    - *Now the universal log:* imports/appends/joins are first-class steps too,
      with an explicit "Start (empty)" step 0.
    - **Relocated to Edit ▸ History… as an editable floating panel — DONE.**
      History is *actions* (what you did), not an input/output, so it left the
      Data/Variables/Output tab strip and became a non-blocking floating panel
      opened from **Edit ▸ History…** (beside Undo/Redo). The panel docks right and
      doesn't dim the grid, so clicking a step **rewinds live** while you watch the
      Data grid update behind it. Each applied step (except the pinned base import)
      has **▲▼ to reorder** and **✕ to delete** — now meaningful because replay is
      sequential (move an append above a transform → the transform covers the
      appended rows). Guarded by `DataStore.moveOp`/`removeOp` +
      `validateOrder`: an order that breaks a dependency (e.g. editing `foo` before
      the compute that creates it, or removing a step a later one needs) is
      rejected with an inline message; the SQL re-derive is the backstop for
      compute-expression deps. **Verified in Chrome:** reorder flips an appended
      row's computed value null→value; the guard blocks "edit before create" and
      "remove a depended-on step"; base import can't be moved/removed; delete works;
      live rewind updates the grid behind the open panel.
    - **"Collect imports" button** (panel toolbar): one click stable-partitions the
      log so all data-loading steps (load/append/join) move above the transforms —
      the professional "import everything, then process" order. Reuses the guarded
      reorder (`DataStore.collectImports` → `#applyReorder`), so it's rejected/
      rolled back if a join key depends on a transform. Verified: an interleaved
      load/compute/append/recode collapses to load/append/compute/recode and the
      appended row picks up the (now-earlier-than-it) compute (null → value).
      *Deferred:* drag-to-reorder (▲▼ cover it for now); a per-step timestamp.
  - **Accepted boundary (not a violation):** "source" = the *as-imported* table,
    not the original file bytes. Pair with the **Dataset library** to enable full
    file→result reproduction if wanted.
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
  - **Phase 2 — compute / recode (new derived variables) — BUILT**
    (`core/compute-recode.js` + `core/data-store.js`; **Transform** menu). Both
    create a *new* variable as a logged, non-destructive transform (sources stay
    immutable, undoable, shown in History, exported to syntax) — added as a derived
    column in the view, never a `CREATE TABLE`/mutation.
    - **Compute** (`computeVariable`): a DuckDB scalar expression over existing
      vars (`income / 1000`, `a + b + c`, `sqrt(x)`, `CASE …`). Dialog has a
      click-to-insert variable palette. Invalid SQL is **rolled back** (the
      transform is popped + re-derived) so a typo never leaves the dataset broken.
    - **Recode** (`recodeVariable`): structured rules (exact value / numeric range
      / missing → a value, copy, or system-missing) compiled to a `CASE`; an
      else-rule for all other values (default copy). Stored structured, so it
      re-edits and exports cleanly.
    - Derived vars chain (a later compute can use an earlier one), cast to the
      declared type, and are full variables (analyse/plot/recode them further).
      Export-to-syntax emits R: compute → `with(d, <expr>)` (SQL identifiers →
      backticks); recode → base-R assignments applied first-match-wins.
    - **Verified end to end in Chrome:** Transform ▸ Compute `income_k = income /
      1000` → 52; Transform ▸ Recode `age` → `agegroup` bins (45→2, 33→1, 52→3);
      both show in History; invalid expression rolls back; the exported `.R`
      **parses and runs** on synthetic data with identical results
      (`income_k=52,39.8,…`, `agegroup=2,1,1,3,NA`).
    - *Still to do:* surface the new var with auto value-labels for a recode (e.g.
      label the agegroup codes); a "recode into same variable" option; an `if`
      condition (compute only where …); expose `app.transform.compute/recode` to
      plugins (the AI auto-recode idea) — additive, host-only for now.
  - *Still to do (Phase 1 polish):* a GSS-aware "mark missing" preset (the known
    iap/dk/na/refused/… labels); **range** missing (e.g. all `< 0`), not just a
    discrete list; value-label conflict policy on multi-year append; and the
    earlier idea of surfacing a warning when imported data has un-designated
    candidate missing codes. Also: only the Frequencies plugin honours
    `missingValues` today — future analyses must too (or centralise it at
    injection).
- [x] **`app.ui.showForm`** — a general declarative form dialog (text/password/
      number fields). Built (`core/ui-service.js`) for the FRED importer; also used
      by the dataset library's name prompt.
- [x] **Two-tier persistence: Projects + building-block library.** *Built.*
  - **Projects (living documents)** — `core/project-store.js` + `core/project-sync.js`.
    A project is the whole working set (every open dataset + active), saved as one
    self-contained OPFS bundle (`projects/<id>/project.json` + `ds<id>_src<n>.parquet`)
    and **autosaved** on any change. File ▸ New / Open / Save project(/as). Cheap:
    autosave rewrites only the changed dataset's Parquet (`writeSourcesFor`), else
    just `project.json`. Verified: build a 2-dataset set, save, edit → autosave;
    reload → Open restores all datasets + active + edits.
  - **Building-block datasets (reusable)** — `core/dataset-store.js` (OPFS
    `datasets/`) + `core/library.js` (`DatasetLibrary`). Explicit File ▸ Save
    dataset to library… / Add dataset from library… (copies a block into the
    project). **No autosave/binding** here — the project tier owns persistence; a
    building block is only updated by an explicit re-save, so in-project edits never
    mutate the shared block (copy-in independence). Verified: save the demo as a
    block → appears in the library → Add → a copy joins the project.
  - Each saved dataset (in either tier) = the whole reproducible stack (immutable
    sources as Parquet + transform log + metadata), so undo/provenance survive a
    round-trip and pooled/joined datasets save naturally. `navigator.storage.persist()`
    on first save.
  - **Always-saving:** the first edit in a fresh session auto-creates an autosaving
    "Untitled project" (no more unsaved-work gap). Deleting the active project →
    fresh Untitled.
  - **Sidebar = project manager** (`ProjectSidebar`): three zones — active project
    (name + ✎/✕, its datasets, ＋add), other Projects (open/rename/delete), and
    Building blocks (add/delete/drag). Drag a dataset → Building blocks (promote to
    v1 + link); drag a block → Datasets (linked copy).
  - **Linking + versioning + propagation (feature-3 — DONE):** blocks are
    versioned (v1 → bump on update); a dataset carries `libraryLink
    {id,version,baseLen}` (badge "v<n>"), set on promote/add, persisted in the
    bundle. **Version propagation/pull is now built** (`DatasetLibrary.pullLatest`):
    when a linked dataset's block has a newer version, the sidebar row shows an
    **"↑v<n>" pull button** instead of the static badge; clicking it fetches the
    new block version and **re-applies the dataset's local transform overlay** on
    top (`baseLen` splits block-origin transforms from local edits). The dataset
    opts in (pull, not push); other linked projects update only when they choose.
    Verified end to end in Chrome: block bumped to v2, a linked dataset with a
    local edit pulled → kept the block's v1 + v2 changes **and** its own local
    edit, link advanced to v2. Reconciliation is best-effort (a local transform
    referencing a now-missing variable no-ops; everything stays saved + undoable);
    local *source* additions to a linked dataset aren't preserved (block sources
    replace them — linked datasets diverge via transforms).
  - *Deferred:* drag a dataset onto another on-disk project (workflow exists via
    open + add); pruning orphaned Parquet after a dataset is removed mid-project;
    export to real disk (File System Access); `app.datasets` plugin API. Supersedes
    the old IndexedDB idea.
- [x] **Export results / output — BUILT, and now plugin-architected.** Save the
      Output pane (tables, plots, notes) as a shareable report via **File ▸ Export
      output…**.
  - **Architecture correction (honours "everything is a plugin"):** the first cut
    was host-owned and scraped the shadow DOM — a violation of our own model. Fixed:
    - **Result model** (`core/results-pane.js`): the pane now keeps an ordered,
      structured record of output (section / text-html / table-html / plot{svg,id} /
      error) alongside the DOM, and exposes a **read surface** to plugins —
      `app.results.getModel()`, `getStyles()`, and `getPlotPng(id)` (host rasterises
      the plot from the live SVG, so export plugins need no canvas in their sandbox).
    - **Output-exporter extension point** `app.outputExporters.register/deliver`
      (mirror of `app.exporters` for data; broker + plugin-host wired). The host
      (`core/output-export.js`, now `OutputExportService`) owns only the picker
      dialog, the download, and the print path; it builds the format-button list
      from whatever plugins registered.
    - **HTML and Word are now plugins** — `plugins/builtin-html-export/` and
      `plugins/builtin-docx-export/` — each reads the model via the API and delivers
      bytes. Verified end-to-end through the real sandboxed round-trip (HTML 7/7
      content checks; docx 26 KB with real table + embedded plot PNG + unicode).
    - **Print stays host** — it's the one export that genuinely needs the browser
      (`window.print()` on a host iframe), exactly the "only the print dialog is
      non-plugin" end state.
  - Both report targets render faithfully (HTML reuses the pane's own stylesheet;
    print clones the live DOM — WYSIWYG):
  - **PDF** (chosen rendering path: print, not a PDF lib): render the report into a
    hidden same-origin **iframe and `print()`** it → the user picks "Save as PDF".
    Zero-dependency, native, iPad-Safari-friendly (Save to Files), and printing
    from normal DOM sidesteps the shadow-DOM-in-print wrinkle. (jsPDF/Paged.js
    rejected for v1 — rasterises or needs a vendored lib; revisit Paged.js only if
    publication-grade pagination is wanted.)
  - **HTML**: the same report written to a self-contained `.html` file (Blob
    download via the shared `downloadFile`, now exported from `export-service.js`).
    Great for archival / re-opening; plots stay crisp (inline vector SVG).
  - **Per-plot SVG / PNG** (`core/results-pane.js`): each plot in the Output pane
    gets hover-revealed **⬇ SVG / ⬇ PNG** buttons. SVG is serialised directly
    (xmlns guaranteed); PNG is rasterised via a canvas at ~2× device pixels on
    white (the SVG is self-contained, so the canvas isn't tainted and `toBlob`
    works). Default title = the active project's name (`ProjectSync.activeName`).
  - **Verified in Chrome:** real menu → dialog → Download HTML produced a report
    with the title/header, the table, the plot SVG and the print CSS, with the
    interactive buttons stripped; the PDF iframe path ran with no exception and no
    leaked iframe (print() is a silent no-op under automation but opens the dialog
    interactively); per-plot SVG (valid) and PNG (~25 KB, untainted) both download.
  - **Word / .docx — BUILT** (officer + flextable in WebR; the "Download Word"
    button in the same dialog). No vendored lib needed: verified WebR's repo (R
    4.6) has the whole chain — `officer`, `flextable`, `zip`, `xml2`, `gdtools`,
    `systemfonts`, `ragg`, `textshaping`, `uuid`, `openssl` — and that they
    **build a valid .docx at runtime in wasm** (spiked before wiring). officer
    builds from R objects, not HTML, so the exporter walks the live Output pane
    into a small content model (title/headings/paragraphs/table-grids/plot-PNGs)
    and generates R that assembles it: section titles → headings, each result
    table → a real editable **flextable**, each plot → an embedded **PNG** (Word
    renders SVG unreliably; reuses the per-plot canvas rasteriser), notes →
    paragraphs. Cell text passes through a `\u`/`\U`-escaping R-string encoder so
    no jsonlite/encoding round-trip is needed. The officer chain installs once per
    session on first Word export (~one-time, with a status note). **Verified in
    Chrome:** menu → dialog → Download Word produced a 26 KB .docx whose
    `docx_summary` shows real paragraph + table-cell content (title, table data,
    percentages, **unicode "café" intact**) and whose zip carries the plot PNG in
    `word/media/`.
  - *Deferred:* a combined **Output + syntax + data-summary** report (ties to
    export-to-syntax / the transform log — and the History panel already gives us
    that list); rich Markdown→Word (notes currently flatten to plain paragraphs);
    table-aware pagination via **Paged.js** for the PDF path; per-table CSV/HTML of
    an individual result table (overlaps with data export below).
- [~] **Export data (exporter extension point).** Symmetric with import: a plugin
      registers `app.exporters.register({ label, extensions, export })`, pulls the
      current (transformed) data via `app.data`, and returns bytes; the engine owns
      the File ▸ Export menu and the download. Exports the derived `dataset` VIEW,
      so transforms/recodes are baked in while sources stay immutable.
  - CSV export plugin (`plugins/builtin-csv-export/`) — RFC-4180 quoting; raw
    values (codes, not labels) for round-tripping; missing → empty cell.
  - *Decisions deferred (format coverage):* a labels-vs-codes toggle; SPSS `.sav` /
    Stata `.dta` write (haven write-side, heavier); Parquet export
    (`DuckDBManager.queryToParquet` exists — nearly free). CSV covers the common
    need first.
- [x] **Export-to-syntax (do-file) — BUILT** (`plugins/builtin-syntax-export/`,
      File ▸ Export ▸ R syntax). Turns the dataset's **transform log** (the same
      record the History panel shows) into a runnable **R script** that reproduces
      the recodes — the do-file an academic pastes into RStudio or drops in a
      methods appendix. Done on-architecture as a **plugin**: the transform log is
      now exposed to plugins via `app.data.getTransforms()` (new read surface,
      wired through broker + plugin-host), and the plugin emits R from it. Each
      logged metadata transform becomes R, in log order: designate-missing →
      `x[x %in% c(codes)] <- NA`; retype → `as.numeric(as.character(x))` /
      `as.character` / `factor`; value labels → `factor(x, levels, labels)`;
      relabel → `attr(x, "label") <- …`; measurement level → a comment (no base-R
      equivalent). Sources are an editable load stub; text is `\u`/`\U`-escaped.
      **Verified in Chrome:** real menu → export produced a script that **parses in
      R** (`parse()` OK) and whose recodes **run correctly** on synthetic data
      (−99 → NA then numeric; factor levels→labels; label attr).
  - **Now emits the full ordered log** (not just a load stub): reads
    `app.data.getHistory()` (the new plugin read surface for the universal log) and
    emits **load/append/join in their true position** alongside the transforms —
    `read.csv` for the base, `dplyr::bind_rows` for an append (NA-fills like
    UNION ALL BY NAME), `merge(..., by.x/by.y, all.x=TRUE)` for a join — so the
    do-file structurally matches the app's history. Verified: an interleaved
    import→compute→append→recode→join exported all 5 steps in order, parses in R.
    Source bytes aren't embedded — the load lines point at file paths (label hints).
  - *Deferred:* **SPSS `.sps`** syntax (a second format in the same plugin — fast
    follow); including **analyses** in the do-file (needs a run-log + plugins
    declaring their R — bigger); key-normalisation in the emitted join (the app
    matches case/space-insensitively; the `merge` stub doesn't yet).
- [ ] **In-app plugin creator / editor.** Let social scientists (who are *not*
      programmers) build the plugin they need without leaving the app or standing
      up a toolchain. The point isn't a full IDE — it's "more than Notepad,"
      scaffolded enough that the author fills in the analysis, not the plumbing.
  - **Scaffold pre-wires the boilerplate:** a starting template with the **input
    selector** (variable picking via `app.ui.selectVariables`) and the **output
    channels** (`results.appendText`/`appendTable`/`appendPlot`) already typed in,
    plus a filled-in manifest (api version, menu path, declared `rPackages`). The
    author writes the bit in the middle. Offer a few template shapes (one-variable
    analysis, two-picker analysis, plot) since those cover most needs.
  - **Editor surface:** syntax highlighting to catch typos — "nothing crazy."
    Decision point: a tiny self-rolled highlighter vs. vendoring **CodeMirror**
    (the obvious "more than Notepad," but a vendored dep — fits the existing
    "vendor + pin" hardening posture). Lean minimal for v1.
  - **Where the authored plugin lives + runs:** it must persist (OPFS, alongside
    projects/blocks) and load through the existing **sandboxed-iframe loader** via
    blob/`data:`-URL module import — so it ties directly to the open questions on
    **blob-module import inside the opaque-origin iframe** (Milestone 3) and
    **multi-file plugins / import-map**. The trust boundary is unchanged: authored
    code runs in the same sandbox as any other plugin, and its output still goes
    through the HTML sanitiser (so that hardening item covers it too).
  - *Nice follow-on:* a "fork this analysis" button that opens an existing builtin
    plugin's source in the editor as a starting point.
- [x] **Plugin manager (enable/disable plugins) — BUILT** (`core/plugin-manager.js`;
      **Edit ▸ Plugins…**). A dialog listing every built-in plugin with a checkbox;
      toggling is **live** — disabling unloads it (its broker disposer removes the
      menu items/exporters immediately), enabling loads it. The disabled set + a
      `{url:{id,name}}` catalog persist in **localStorage** (first use of it), so
      choices survive a reload; the manager owns the boot load loop (skips disabled
      URLs). **Verified in Chrome:** disabling Plots removed the Graphs menu live,
      it stayed gone after a reload (and the row showed "disabled"), re-enabling
      brought Graphs back and cleared the set. Host-owned, as designed (it drives
      the loader — outside the sandbox allowlist; a plugin couldn't manage peers).
  - **Grouped + searchable** (for when the list grows): the manifest gained
    optional **`category`** (groups the plugin into a section — an unknown value
    just makes a new one; missing → "Other") and **`keywords`** (extra search
    terms). The dialog has a **search box** that matches name *and* keywords *and*
    category *and* id, and renders plugins in ordered category sections
    (Import · Analysis · Graphs · Export, then any custom, then Other). The 16
    built-ins are categorised + keyworded. **Verified:** sections show
    Import 4 / Analysis 7 / Graphs 1 / Export 4; searching "contingency" (only in
    Crosstabs' keywords, not its name) surfaces Crosstabs — so an oddly-named
    third-party plugin stays findable by what it does.
  - **Categorise by method family, not a generic "Analysis"** (avoids the
    junk-drawer that would bloat as analyses grow). Analyses now use specific
    families matching their `Analyze ▸ …` submenus: Descriptive Statistics
    (Frequencies/Descriptives/Crosstabs), Correlation, Regression (Linear/
    Logistic), Resampling (Bootstrap). The manager defines a **recommended ordered
    vocabulary** (Import · Descriptive Statistics · Comparison · Correlation ·
    Regression · Multivariate · Time Series · Resampling · Graphs · Export); a
    plugin may use any string but unrecognised ones sort after the recommended set
    (a gentle nudge), with "Other" last. Documented in the `manifest.category` doc
    (loader.js) so third-party authors see the convention. Verified: sections now
    read Import / Descriptive Statistics / Correlation / Regression / Resampling /
    Graphs / Export.
  - **Plugin menus now match the category** (dropped the generic "Analyze"
    wrapper): each analysis registers its menu under its category as the top-level
    (`path: ['Regression', …]` etc.), so a plugin appears in the menu where it's
    filed — easy to find what you add. Menubar reads File · Edit · Transform ·
    Correlation · Descriptive Statistics · Graphs · Regression · Resampling.
    Convention documented in the `manifest.category` doc. (Importers/exporters stay
    under the host-managed File ▸ Import / Export — File is their conventional home;
    their category still drives the manager section.)
  - *Deferred:* manage *installed third-party* plugins too (today the catalog is
    the built-in URL set); a "reload plugin" action for the plugin-creator loop.
- [ ] **Direct R interface / console.** The power-user escape hatch: when the
      canned analyses don't cover a need, drop to R directly. Framing: a plugin
      that does **variable selection + load**, then hands the user an **interactive
      terminal** with their data already staged and a plain-language orientation —
      e.g. "your data is in `df`; `df[[1]]` is *Age*, `df[[2]]` is *Income*…" so a
      non-R-fluent user knows what they're holding.
  - **Data staging:** reuse the existing injection path (DuckDB → Parquet/JS-array
    → WebR `data.frame`) to load the selected variables into the R session under a
    known name, then print the name↔variable legend (using labels) before the
    prompt.
  - **REPL UI:** an interactive terminal (dedicated tab, or in the Output pane) —
    read a line, `webr` eval, print the result. WebR already runs in a worker;
    the work is threading stdin/stdout to a terminal widget and rendering R output
    (text + any `svgstring()` plots) through the sanitiser.
  - **Reproducibility tie-in:** the commands a user types are themselves a do-file
    — this overlaps with **export-to-syntax** (the transform log + a typed-command
    log together *are* the script). Risk is low (arbitrary R is the user's own
    sandboxed WASM session); output rendering still respects the sanitiser.

## More analyses (each is just another plugin)

- [x] **Descriptive Statistics** (`plugins/builtin-descriptives/`) — N, missing,
      mean, SD, min, quartiles, median, max for numeric vars. Honours
      missingValues. Verified end to end in Chrome.
- [x] **Crosstabs** (`plugins/builtin-crosstabs/`) — two-way table + Pearson
      chi-square; two pickers (row, col); honours missingValues; value labels.
      Verified end to end in Chrome (hand-checked χ²).
- [~] **Linear regression** (`plugins/builtin-regression/`) — `lm()`, SPSS-style
      Model Summary + Coefficients; factor IVs dummy-coded; honours missingValues.
      *R/stats verified; two-dialog UI click-through NOT auto-confirmed* (harness
      can't drive sequential modal dialogs — see testing note). **Needs a manual
      click-through check.**
- [~] **Binary logistic regression** (`plugins/builtin-logistic/`) — `glm()`
      binomial; outcome recoded 0/1 (models the higher category, named in the
      caption); SPSS-style Model Summary (&minus;2LL, Cox & Snell / Nagelkerke R²)
      + "Variables in the Equation" (B, S.E., Wald=z², df, Sig., Exp(B)); factor
      predictors dummy-coded; honours missingValues. *R/stats verified directly*
      (gender~age+income on the demo: B/z/p, &minus;2LL=31.348, Cox & Snell=.289,
      Nagelkerke=.386, Wald all hand-checked); **two-dialog UI click-through needs
      a manual check** (same harness limitation as Linear).
- [x] **Bivariate correlation** (`plugins/builtin-correlation/`) — Pearson matrix
      (r / Sig. (2-tailed) / N per pair), pairwise-complete, significance stars;
      honours missingValues. *R verified directly* (r(age,income)=.558, p=.0014,
      N=30; matrix flattening + NA-blanking checked). Single-dialog, but live
      render auto-capture was blocked by the same harness flakiness during this
      session (the proven Descriptives plugin failed to render the same way) —
      worth a manual eyeball.
- [~] **Plots / Graphs** (`plugins/builtin-plots/`) — SVG charts via **`svglite`'s
      `svgstring()`** (R→SVG path **spiked & proven**: `svgstring()` → valid SVG →
      `appendPlot` renders it through the sanitiser untouched, 32/32 points). Set:
      histogram, scatter (+ linear OLS trend line, default on), boxplot (optional
      factor split), pie chart (category shares — included for the audience despite
      being a poor viz), and **bar chart with error bars** (group means by a factor,
      **±95% CI**, t-based, labelled on the plot). Honours `missingValues`,
      app-blue theme, responsive via `viewBox`.
  - *Generalise plots over derived data — RESOLVED via multi-dataset.* The
    on-architecture answer ("analyses emit a derived dataset; plots consume
    datasets like everything else") is now real: see the **multi-dataset workspace**
    + `app.data.create` below. A plot doesn't take another plugin's output through a
    bespoke channel — the analysis emits a dataset and the plot just plots it.
- [x] **Multi-dataset workspace + derived datasets** (`core/dataset-manager.js`).
      The engine now holds a *set* of open datasets with one active, not a single
      dataset. `DataStore` is per-instance (id-namespaced DuckDB tables, own library
      binding/undo); `DatasetManager` owns the set + active and delegates the whole
      DataStore interface to the active one (so import/export/grid/analyses just act
      on whatever's active). A switcher in the tab bar picks the active dataset.
      **`app.data.create(dataset)`** lets an analysis *emit* a derived dataset (added
      + activated), so analyses are data sources too — one currency (datasets), no
      bespoke plugin↔plugin pipe. Library `Open` now adds a dataset (open several
      side by side); binding is per-dataset. Verified end to end. *Now unblocked /
      partly done:* the library's "single vs. multi-dataset" question (answered:
      multi), and **join across loaded datasets** (engine can hold both; the join UI
      still goes via import — wiring it to pick a loaded dataset is a small follow-up).
- [x] **Bootstrap the mean** (`plugins/builtin-bootstrap/`) — the first analysis
      that emits a derived dataset: resamples a numeric variable B times, emits the
      B resampled means as a new (active) dataset (`boot_mean`) you can plot/describe,
      and prints observed mean, bootstrap SE, and a 95% percentile CI. Verified:
      income, 2000 reps → derived dataset + CI table → histogram of the bootstrap
      distribution. The showcase of "analyses emit datasets, plots consume them."
- *Testing note (Chrome automation):* driving **two sequential modal `<dialog>`s**
  is flaky via CDP — a synthetic `button.click()` closes the dialog but does *not*
  fire the `close` event (so the app's promise never resolves), and long evals
  that hold a modal open hit the 45 s CDP timeout. Use `dialog.close('ok')`
  (fires `close` deterministically) and keep modal-driving evals short; or verify
  the analysis R directly and check rendering manually. Single-dialog analyses
  (Descriptives) drive fine.

## Nice-to-have / optimisations

- [x] **Order the top-level menus: host menus first, then plugins A→Z — DONE**
      (`core/menu-shell.js` `byTopLevel`). The **built-in (host) menus** are pinned
      in a fixed order — **File, Edit, Transform** — and plugin-contributed menus
      (Analyze, Graphs, …) sort alphabetically after. The principle: disable every
      plugin and the base menus stay exactly where they are. Verified: the menubar
      reads File · Edit · Transform · Analyze · Graphs. Per-item order *within* a
      menu still uses the `order` field.
- [ ] Batch a multi-variable Frequencies run into one R call instead of one job
      per variable (`plugins/builtin-frequencies/index.js`).
- [~] Settings persistence (localStorage). *Started:* the plugin manager persists
      its disabled-set + catalog there (`core/plugin-manager.js`). A general
      settings store can generalise that pattern. (Dataset persistence is its own
      item — see **Dataset library** under Deferred features; OPFS, not IndexedDB.)
- [ ] **Variable-picker polish (later).** The "Selected" group is a snapshot taken
      when the dialog opens — ticking a box inside the dialog deliberately does
      *not* live-reorder it to the top (reordering rows under the cursor causes
      mis-clicks). Possible later refinements, none urgent: a live "N selected"
      count in the dialog; a "selected only" filter inside the picker (mirroring
      the grid's column filter) for very long lists; and an optional
      **picker→selection write-back** so confirming a picker updates the shared
      selection (today the picker's choice returns to the plugin but doesn't
      change the grid/sidebar selection — a real design call, left as-is for now).

## Blocked until public deploy (GitHub Pages)

- [ ] **Milestone 3 — verify on iPad Safari.** Deferred to the bottom: it's gated
      on switching the repo to public + standing up GitHub Pages (a real served
      origin to test from on a device). The desktop-Chrome path is confirmed;
      Safari/iPadOS is the remaining unknown. Risks to check once it's hosted:
  - [ ] Blob-module `import()` inside the sandboxed (opaque-origin) iframe
        (`plugin-host.html`). Fallback if it fails: `data:`-URL import or a build step.
  - [ ] Cross-origin isolation via the **`coi-serviceworker`** reload path
        (`sw.js`) — local testing used real COOP/COEP headers, so `sw.js` itself
        is still unexercised on a device.
  - [ ] Also sanity-check `<dialog>` modal behaviour and touch targets on iPad.
  - *Adjacent prep that unblocks the deploy:* `LICENSE`, PWA icons, vendor+pin the
    WebR/DuckDB assets, and PWA precaching (all already listed above).
