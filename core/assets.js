/**
 * @file assets.js
 * Central registry of CrossTab's heavy external runtime assets — WebR (R-WASM),
 * DuckDB-WASM, Apache Arrow, and the hyparquet-writer — with a **self-hosted /
 * air-gapped** mode.
 *
 * Why this exists: a core security claim is that CrossTab can run on a machine
 * with **no internet at all**. Several data-vendor contracts stipulate that the
 * data "cannot be loaded on any computer connected to the internet", which today
 * would exclude CrossTab because the runtimes load from public CDNs. This module
 * is the one place those URLs live, and it offers a `local` mode that points every
 * asset at same-origin files vendored under `./vendor/` — so an air-gapped deploy
 * fetches nothing cross-origin.
 *
 *  - **cdn** (default): zero-setup, always-current; loads WebR from r-wasm.org and
 *    DuckDB/Arrow/hyparquet from jsDelivr.
 *  - **local**: everything from `./vendor/...` (produced by
 *    `scripts/vendor-assets.mjs`). Run that once on a connected machine, copy the
 *    whole app + `vendor/` to the air-gapped machine, and serve it locally.
 *
 * Mode resolution (first match wins):
 *   1. `?assets=local|cdn`            URL param — handy for testing a vendored build
 *   2. `globalThis.CROSSTAB_ASSETS_MODE = 'local'|'cdn'`   (set in index.html)
 *   3. `globalThis.CROSSTAB_ASSETS = { mode?, ...overrides }`  full override object
 *   4. default → `cdn`
 *
 * Paths in `local` are **relative to the document** (index.html), matching how the
 * built-in plugin URLs and the ReadStat worker are already resolved.
 *
 * Keep the pinned versions here in sync with `scripts/vendor-assets.mjs`.
 */

/** CDN asset set — the default. Versions pinned for reproducibility. */
const CDN = Object.freeze({
  webrUrl: 'https://webr.r-wasm.org/latest/webr.mjs',
  // WebR derives its baseUrl (R.bin/*.data/*.wasm) and package repo from its own
  // CDN by default, so no extra options are needed in cdn mode.
  webrOptions: {},
  duckdbUrl: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev56.0/+esm',
  arrowUrl: 'https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm',
  hyparquetWriterUrl: 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0.16.1/+esm',
  // null ⇒ DuckDBManager uses duckdb.getJsDelivrBundles() (the jsDelivr URLs).
  duckdbBundles: null,
});

/** Self-hosted asset set — the layout `scripts/vendor-assets.mjs` writes into
 * `./vendor/`. Nothing here is cross-origin, so it works fully offline. */
const LOCAL = Object.freeze({
  webrUrl: './vendor/webr/dist/webr.mjs',
  webrOptions: {
    // WebR fetches its runtime payload + package mirror from these; both must be
    // same-origin in an air-gapped deploy.
    baseUrl: './vendor/webr/dist/',
    repoUrl: './vendor/webr-packages/',
  },
  duckdbUrl: './vendor/duckdb/dist/duckdb-browser.mjs',
  arrowUrl: './vendor/arrow/arrow.mjs',
  hyparquetWriterUrl: './vendor/hyparquet-writer/hyparquet-writer.mjs',
  // A local DuckDB bundle (mvp + eh builds); selectBundle() picks per browser
  // features from whatever we provide. Returned as a function so the worker/wasm
  // URLs are produced lazily (and stay relative to the document).
  duckdbBundles: () => ({
    mvp: {
      mainModule: './vendor/duckdb/dist/duckdb-mvp.wasm',
      mainWorker: './vendor/duckdb/dist/duckdb-browser-mvp.worker.js',
    },
    eh: {
      mainModule: './vendor/duckdb/dist/duckdb-eh.wasm',
      mainWorker: './vendor/duckdb/dist/duckdb-browser-eh.worker.js',
    },
  }),
});

/** Resolve the mode from the URL param then a global flag. */
function resolveMode() {
  try {
    const p = new URLSearchParams(location.search).get('assets');
    if (p === 'local' || p === 'cdn') return p;
  } catch {
    /* no `location` (e.g. evaluated in a worker) — fall through */
  }
  const g = globalThis.CROSSTAB_ASSETS_MODE;
  if (g === 'local' || g === 'cdn') return g;
  return 'cdn';
}

let cached = null;

/**
 * The resolved asset set for this session (memoised). Shape:
 * `{ mode, webrUrl, webrOptions, duckdbUrl, arrowUrl, hyparquetWriterUrl, duckdbBundles }`.
 * An advanced deployer can set `globalThis.CROSSTAB_ASSETS` to a partial object to
 * override individual URLs (e.g. mirror only WebR locally but keep DuckDB on CDN).
 *
 * @returns {{mode: string, webrUrl: string, webrOptions: object, duckdbUrl: string,
 *   arrowUrl: string, hyparquetWriterUrl: string, duckdbBundles: (null|Function)}}
 */
export function getAssets() {
  if (cached) return cached;
  const override =
    globalThis.CROSSTAB_ASSETS && typeof globalThis.CROSSTAB_ASSETS === 'object'
      ? globalThis.CROSSTAB_ASSETS
      : null;
  const mode = override?.mode === 'local' || override?.mode === 'cdn' ? override.mode : resolveMode();
  const base = mode === 'local' ? LOCAL : CDN;
  cached = Object.freeze({ mode, ...base, ...(override || {}) });
  if (mode === 'local') console.info('[assets] self-hosted (offline) mode — loading runtimes from ./vendor/');
  return cached;
}
