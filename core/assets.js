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
 *
 * Mode resolution now also reads `deploy.json` (#185) — see {@link resolveMode} for where it
 * sits in the precedence order.
 */
import { deployConfig } from './deploy-config.js';

/** CDN asset set — the default. Versions pinned for reproducibility. */
const CDN = Object.freeze({
  // Pinned (not `latest`) for reproducibility — a silent WebR release must not
  // change R behaviour/results under us. Pull live from the CDN (no vendoring); bump
  // this deliberately. baseUrl is pinned to the same version so the runtime payload
  // (R.bin.*, worker) matches the module. (#hardening)
  webrUrl: 'https://webr.r-wasm.org/v0.6.0/webr.mjs',
  webrOptions: { baseUrl: 'https://webr.r-wasm.org/v0.6.0/' },
  duckdbUrl: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev56.0/+esm',
  arrowUrl: 'https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm',
  hyparquetWriterUrl: 'https://cdn.jsdelivr.net/npm/hyparquet-writer@0.16.1/+esm',
  // Trystero (MQTT strategy) — serverless WebRTC rendezvous for live collaboration
  // (#143). Signaling rides public MQTT brokers (nothing we host); it then drops to a
  // direct WebRTC data channel. Lazy-loaded only when live collab is used. Pinned.
  trysteroUrl: 'https://cdn.jsdelivr.net/npm/trystero@0.21.5/mqtt/+esm',
  // transformers.js — on-device speech-to-text and speaker embeddings (#139 Phase 2).
  // Lazy-loaded inside a worker, only when someone transcribes. Pinned for the same
  // reason WebR is: a silent release must not change what a transcript says.
  transformersUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1',
  // Null in CDN mode ⇒ let transformers.js use its own defaults: it fetches the
  // onnxruntime WASM from jsDelivr and the model weights from huggingface.co. Named here
  // anyway so the two modes have the same SHAPE — the air-gap gap (#201) existed partly
  // because LOCAL declared a transformers bundle that CDN had no counterpart entry for,
  // and nothing compared the two maps.
  ortWasmPaths: null,
  whisperModelPath: null,
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
  transformersUrl: './vendor/transformers/transformers.mjs',
  // The onnxruntime WASM backend (#201). transformers.js otherwise builds these two URLs
  // itself against `cdn.jsdelivr.net` — see its `backends/onnx.js`, which only applies
  // that default when `wasmPaths` is unset — so without this an air-gapped machine loads
  // the library from disk and then reaches for a CDN that is not there.
  ortWasmPaths: {
    mjs: './vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: './vendor/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm',
  },
  // Where the Whisper weights live. transformers.js resolves a repo id (e.g.
  // `onnx-community/whisper-base`) UNDER this path, so the vendored layout mirrors the
  // repo id and the same model id works in both modes.
  whisperModelPath: './vendor/whisper/',
  // Air-gap note: live P2P collaboration needs a reachable MQTT broker + peers, so
  // it's inherently non-offline; this mirror only keeps the import resolvable.
  trysteroUrl: './vendor/trystero/mqtt.mjs',
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

/**
 * Resolve the mode: the `?assets=` param (testing) beats the page global (index.html), which
 * beats the DEPLOYMENT's own setting in `deploy.json` (#185), which beats the default. More
 * specific wins — a site sets its mode once in the settings file and can still override it
 * per page or per URL without editing that file.
 */
function resolveMode() {
  try {
    const p = new URLSearchParams(location.search).get('assets');
    if (p === 'local' || p === 'cdn') return p;
  } catch {
    /* no `location` (e.g. evaluated in a worker) — fall through */
  }
  const g = globalThis.CROSSTAB_ASSETS_MODE;
  if (g === 'local' || g === 'cdn') return g;
  const d = deployConfig().assetsMode;
  if (d === 'local' || d === 'cdn') return d;
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
  // Per-URL overrides, page global first and then the deployment's file — merged, so a site
  // can mirror WebR in deploy.json while a page still redirects DuckDB somewhere else.
  const fromDeploy = deployConfig().assets;
  const fromPage =
    globalThis.CROSSTAB_ASSETS && typeof globalThis.CROSSTAB_ASSETS === 'object'
      ? globalThis.CROSSTAB_ASSETS
      : null;
  const override = fromDeploy || fromPage ? { ...(fromDeploy || {}), ...(fromPage || {}) } : null;
  const mode = override?.mode === 'local' || override?.mode === 'cdn' ? override.mode : resolveMode();
  const base = mode === 'local' ? LOCAL : CDN;
  cached = Object.freeze(absolutise({ mode, ...base, ...(override || {}) }));
  if (mode === 'local') console.info('[assets] self-hosted (offline) mode — loading runtimes from ./vendor/');
  return cached;
}

/**
 * Resolve every relative asset URL against the DOCUMENT, once, here.
 *
 * **Why this is not the caller's job.** A `./vendor/...` path is correct for the page,
 * which sits at the root, and WRONG for a worker, which resolves it against its own module
 * URL in `/core/`. Measured in the browser while verifying air-gap transcription (#201):
 * the transcription worker asked for
 * `http://localhost:8080/core/vendor/transformers/transformers.mjs`, and the SAME request
 * log showed `http://localhost:8080/core/vendor/webr/dist/webr.mjs` returning 503 — so
 * `?assets=local` was broken for the R runtime too, and had been for as long as local mode
 * has existed. Every consumer that hands a URL across a worker boundary had the same bug
 * waiting, which is why the fix belongs to the thing that produces the URLs rather than to
 * each of the six places that consume them.
 *
 * CDN mode passes through untouched: `new URL` leaves an absolute URL alone. Non-URL
 * values (the `duckdbBundles` thunk, `webrOptions`' nested paths, booleans, null) are
 * handled explicitly — a blind walk would stringify the thunk and break DuckDB.
 */
function absolutise(a) {
  const abs = (u) => {
    if (typeof u !== 'string' || !u) return u;
    try { return new URL(u, baseHref()).href; } catch { return u; }
  };
  const out = { ...a };
  for (const k of ['webrUrl', 'duckdbUrl', 'arrowUrl', 'hyparquetWriterUrl', 'trysteroUrl',
    'transformersUrl', 'whisperModelPath']) {
    if (out[k]) out[k] = abs(out[k]);
  }
  if (out.webrOptions) {
    out.webrOptions = { ...out.webrOptions };
    for (const k of ['baseUrl', 'repoUrl']) {
      if (out.webrOptions[k]) out.webrOptions[k] = abs(out.webrOptions[k]);
    }
  }
  if (out.ortWasmPaths) {
    out.ortWasmPaths = { mjs: abs(out.ortWasmPaths.mjs), wasm: abs(out.ortWasmPaths.wasm) };
  }
  // `duckdbBundles` is deliberately left alone: it is a FUNCTION returning fresh URLs per
  // call, and DuckDB's own `selectBundle` consumes it on the main thread where a relative
  // path resolves correctly.
  return out;
}

/** The document's URL — the base a relative asset path is written against. */
function baseHref() {
  return globalThis.document?.baseURI || globalThis.location?.href || 'http://localhost/';
}
