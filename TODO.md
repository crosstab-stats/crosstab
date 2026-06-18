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
  - *Still to do:* editing cells (the **Data editor**, needs the transform API);
    a raw-codes vs value-labels toggle; column sort/resize and per-column width
    (fixed 120px today). Possibly retire the sidebar variable list now that grid
    headers carry selection (under consideration).
- [ ] **Data editor.** The current `VariablesSidebar` in `core/app.js` is a
      minimal stand-in. Becomes the editing layer over the data-grid view above.
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
    - [ ] **Cell editor must use a sparse override transform** when built — not a
          destructive cell write. Preventive; the override-layer transform type
          isn't implemented yet (no cell editing yet).
  - *Still to do (follow-ups the log unlocks):* expose the log to a **history/undo
    UI** and to plugins; **export-to-syntax** (do-file) from the log; treat
    append/load as logged steps too (today they manage `#sources`, edits are the
    logged transforms) for a fully unified history; redo.
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
- [x] **`app.ui.showForm`** — a general declarative form dialog (text/password/
      number fields). Built (`core/ui-service.js`) for the FRED importer; also used
      by the dataset library's name prompt.
- [x] **Dataset library (save / catalog / one-click reload).** *Built* —
      `core/dataset-store.js` (OPFS) + `core/library.js` (binding, autosave, browse
      modal, File-menu items) + `DataStore.exportState`/`restoreState`. Caches the
      post-import result so reload never re-parses.
  - **Storage: OPFS** under `datasets/` — `catalog.json` index + one folder per
    entry (`manifest.json` + `source_N.parquet`). `navigator.storage.persist()` is
    called on first save (avoids eviction). Export to real disk via File System
    Access remains a possible *secondary* feature later (portability/backup).
  - **Saved entry = the whole reproducible stack** (decision: "save everything,
    sources immutable"): each immutable source as Parquet + the transform log +
    metadata. Reload reconstructs sources + log → derived view, so **undo and
    provenance survive a round-trip**, and a pooled multi-file dataset saves
    naturally (N sources). *Not* saved: analysis output (regenerable).
  - **Living-document autosave.** Saving **binds** the session to the entry;
    thereafter any transform-log change (edit/undo/redo/append) schedules a
    debounced save — never "unsaved work" after the first save. Cheap because
    sources are immutable: a metadata edit rewrites only `manifest.json` + catalog
    (`writeSources:false`), not the Parquet. Import-`replace` **unbinds** (new
    project); `restore` doesn't autosave (already saved). Footer shows
    saved✓/saving…. "Save as copy…" forks a named entry.
  - **Single active dataset; load = replace the current one.** True multi-dataset
    (several loaded at once) waits on the join feature.
  - **Verified end to end in Chrome:** save→bind→edit→debounced autosave (catalog
    timestamp advances); **survives a full page reload** — Open library → load
    restored data *and* the transform log (an autosaved relabel persisted); browse
    modal lists entries w/ rows·vars·date; replace→unbind; delete; Parquet data
    integrity (age/income/gender values intact). Host UI, not a plugin (OPFS is
    origin-scoped); `app.datasets` plugin API can come later. Supersedes the old
    IndexedDB persistence idea.
- [ ] **Export results / output (PDF default).** Save the Output pane (tables,
      future plots, notes) to a shareable file — PDF as the sensible default for a
      write-up artifact. *Approach is a real decision, hence listed not assumed:*
  - *Rendering path:* (a) a **print stylesheet + `window.print()`** → "Save as PDF"
    — zero deps, native, but the user goes through the print dialog and pagination
    is the browser's; (b) **jsPDF (+ html2canvas)** — programmatic, but rasterises
    HTML to images (fuzzy text, big files) unless content is rebuilt as PDF
    primitives; (c) **Paged.js** — proper CSS paged media (running headers, page
    numbers, table-aware breaks) at the cost of a vendored lib. Lean (a) for v1,
    (c) if we want publication-grade pagination.
  - *Wrinkle:* the results pane is **sanitised shadow-DOM** — a print/snapshot path
    must reach into the shadow root (or render from the underlying result model
    rather than the live DOM). Rendering from a model also enables non-PDF targets.
  - *Scope:* output-only first. "Output + syntax + data summary" as a combined
    report ties to export-to-syntax (transform log) and is a later combination.
  - *Also cheap & adjacent:* HTML and single-table CSV export of individual result
    tables; overlaps with the data-export item below.
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
  - *Future — generalise plots over piped results (deferred, design note).* Tempting
    to let a plot consume another plugin's *output* (e.g. Descriptives' group means
    → the error-bar chart) instead of recomputing from data. The on-architecture
    shape is **not** a bespoke plot-input channel (which needs structured result
    objects + a plugin↔plugin mediator + agreed schemas) but "**analyses emit a
    derived dataset; plots consume datasets** like everything else" — one currency,
    reusing import/transform/join primitives (the tidyverse `summarize() |> plot()`
    shape). Build plots concretely first; the canary is the error-bar plot and
    Descriptives both computing group means — that duplication is the real signal to
    extract a shared "summary dataset" (ties to an aggregate/summarise step, Phase 2
    recode territory). Don't design the pipe before there's a second consumer.
- *Testing note (Chrome automation):* driving **two sequential modal `<dialog>`s**
  is flaky via CDP — a synthetic `button.click()` closes the dialog but does *not*
  fire the `close` event (so the app's promise never resolves), and long evals
  that hold a modal open hit the 45 s CDP timeout. Use `dialog.close('ok')`
  (fires `close` deterministically) and keep modal-driving evals short; or verify
  the analysis R directly and check rendering manually. Single-dialog analyses
  (Descriptives) drive fine.

## Nice-to-have / optimisations

- [ ] Batch a multi-variable Frequencies run into one R call instead of one job
      per variable (`plugins/builtin-frequencies/index.js`).
- [ ] Settings persistence (localStorage). (Dataset persistence is now its own
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
