# CrossTab — TODO

Single source of truth for pending work. The README narrates *status*; this file
tracks *tasks*. When something here lands, check it off (and update the README
milestone/open-question prose if it changes the story).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Now / near-term

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
- [ ] **Multi-file plugins.** Blob-imported modules can't resolve relative
      imports. Decide on an import-map or bundling story so plugins can span files.

## Deferred features (intentionally not built yet)

- [ ] **File import** (priority order): CSV with type inference → SPSS `.sav` via
      Haven through WebR (preserves metadata) → Excel via SheetJS. Lands first,
      then delete the temporary `core/demo-data.js` seed.
- [ ] **Import data from a web page (URL scrape).** Point the app at a URL; it
      fetches and parses tabular data (e.g. HTML `<table>`s) into a new dataset
      for analysis, with an option to save the parsed data locally as CSV (or
      another suitable format) for archival.
  - **Approach is an open decision, not a given.** The original idea named Python
    + BeautifulSoup, but CrossTab runs entirely client-side (vanilla JS + WebR):
    there is no Python runtime, and the browser can't fetch arbitrary
    cross-origin URLs (CORS). Two sub-decisions:
    - *How to fetch:* a small serverless proxy (e.g. Cloudflare Worker/Function)
      that does the cross-origin GET — and could also run BeautifulSoup if we
      want a Python parse step server-side — **or** a no-server fallback where
      the user pastes page HTML / uploads a saved page.
    - *How to parse:* client-side via the browser's `DOMParser` table extraction,
      or R's `rvest`/`xml2` inside WebR, or (if we add the proxy) BeautifulSoup
      server-side. Pick based on the fetch decision.
  - Reuses the same ingest path as file import (`DataStore.setDataset`); the
    "save as CSV" archival option overlaps with CSV export work.
- [ ] **Data editor.** The current `VariablesSidebar` in `core/app.js` is a
      minimal stand-in.
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
- [ ] DuckDB-WASM evaluation for large datasets (data layer).
- [ ] Settings persistence (localStorage) and dataset persistence (IndexedDB).
