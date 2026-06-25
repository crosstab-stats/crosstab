# Running CrossTab offline (air-gapped)

CrossTab's security pitch is that **your data never leaves the machine** — every
analysis runs locally in the browser. For some projects that promise is a hard
contractual requirement: data-vendor agreements can stipulate that the data
"cannot be loaded on any computer connected to the internet."

By default CrossTab loads its heavy runtimes (WebR/R-WASM, DuckDB-WASM, Apache
Arrow, the hyparquet writer) and R packages from public CDNs — so the *default*
build needs a network. This guide makes CrossTab run on a machine with **no
internet at all**.

The idea: vendor every asset to same-origin files once (on a connected machine),
then copy the whole app to the air-gapped machine and tell it to load locally.

> This air-gapped build is one of three ways CrossTab works without a connection.
> See **[The offline model](#the-offline-model)** below for how they fit together.

## The offline model

One model, two cache tiers, applied the same way across every run mode — a browser
tab, an installed desktop PWA, an installed iPad/Home-Screen app, and this
air-gapped build:

- **Tier 1 — the app itself: cached automatically.** The service worker
  ([`sw.js`](../sw.js)) precaches the critical boot files on install, then caches
  every same-origin file as it's served. So after one online load (or a clean
  install) **CrossTab opens and runs its UI with no connection — no opt-in.** An
  *installed* app serves this shell cache-first (instant launch, flaky-network
  proof); a *tab* stays network-first (always fresh) and falls back to cache when
  offline. A navigation to any in-app URL falls back to the cached app document.
- **Tier 2 — the R engine + packages: opt-in.** WebR, DuckDB, Arrow, hyparquet,
  and the R-package closure are large and cross-origin (on the CDN build), so they
  cache only when you turn on **Make available offline** (launcher ▸ Offline). That
  download is what lets you *run analyses* offline.

How the three mechanisms map onto this model:

| Mechanism | Tier | When |
| --- | --- | --- |
| Auto shell cache (precache-on-install + cache-on-use) | 1 | always, every mode |
| "Make available offline" toggle (runtimes + R packages) | 2 | opt-in, CDN build |
| Air-gapped vendored build (this guide) | both | the runtimes are vendored *same-origin*, so **Tier 1 caches them automatically too** — and a local server serves everything regardless |

So on the air-gapped build you don't need the toggle: the runtimes live under
`./vendor/` (same-origin), the local server always serves them, and the Tier-1
cache picks them up as well. The toggle remains the path for a normal CDN install
that wants to go offline later (e.g. a flight) without re-vendoring.

Updates propagate by shipping a new `sw.js` (it `skipWaiting()`s + claims): tabs
get fresh files immediately online; an installed app refreshes one launch behind.
Status shows in the launcher's **Offline** panel (Tier 1 confirmed always; Tier 2
shows cached size + a Remove control) and a status-bar connectivity indicator.

## 1. Vendor the assets (on a connected machine)

```sh
node scripts/vendor-assets.mjs        # WebR + DuckDB + Arrow + hyparquet + R packages
```

You can also vendor a subset: `node scripts/vendor-assets.mjs webr packages`.
This populates `./vendor/`:

```
vendor/
  webr/dist/            WebR runtime (webr.mjs, worker, R.bin.*, *.wasm)
  webr-packages/        a CRAN-style mirror of the R packages the plugins use
  duckdb/dist/          duckdb-browser.mjs + the mvp/eh worker+wasm pairs
  arrow/arrow.mjs       Apache Arrow, bundled to one self-contained ESM file
  hyparquet-writer/hyparquet-writer.mjs
```

`vendor/readstat/` (the SPSS/Stata/SAS reader) is already committed — it has
always been self-hosted.

**Requirements:** Node 18+ and the system `tar` (built into Windows 10+, macOS,
and Linux). No `npm install` is needed — CrossTab has no npm dependencies.

**R packages:** the mirror covers the dependency closure of the R packages the
**bundled plugins declare** (their `rPackages`) plus the host's own bridges
(`nanoparquet`, `svglite`). If you add plugins or new R packages, **re-run the
script** so their packages are mirrored too. Base R packages (`stats`, `methods`,
…) ship inside WebR and are intentionally skipped.

## 2. Switch to local mode

`core/assets.js` resolves which asset set to use, first match wins:

1. `?assets=local` URL parameter — easiest for a quick test of a vendored build.
2. `globalThis.CROSSTAB_ASSETS_MODE = 'local'` — set it in `index.html` before
   the app's module loads, to make local the permanent default for that copy:

   ```html
   <script>window.CROSSTAB_ASSETS_MODE = 'local';</script>
   ```

3. `globalThis.CROSSTAB_ASSETS = { … }` — an advanced partial override (e.g.
   mirror only WebR locally but keep DuckDB on a CDN). Any subset of
   `webrUrl`, `webrOptions`, `duckdbUrl`, `arrowUrl`, `hyparquetWriterUrl`,
   `duckdbBundles` overrides the chosen mode's defaults.

For a true air-gap deploy, use option 2 so the offline copy never depends on a
query string.

## 3. Copy + serve on the offline machine

Copy the entire app directory (including `vendor/`) to the air-gapped machine and
serve it over HTTP with the cross-origin-isolation headers WebR needs:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

On a static host that can't set headers, the bundled `sw.js` service worker
injects them (the existing COI shim). Any local static server works — the key is
that **everything is same-origin**, so no request ever leaves the machine.

### Verifying the isolation

Open DevTools ▸ Network with "offline" forced (or literally unplug the network)
and confirm a full session — load data, run an R analysis that needs a package,
draw a plot — issues **zero cross-origin requests**. The console logs
`[assets] self-hosted (offline) mode …` when local mode is active.

## What's not covered yet

- **PWA precaching / installable offline app.** `sw.js` currently only injects the
  isolation headers; it does not yet precache `vendor/` for use when even the local
  server is down. Tracked as a follow-up (the `sw.js` TODO). It isn't required for
  the air-gap contract — a local static server already keeps everything on-device.
- **Online-only data importers.** Plugins that fetch remote data (FRED, Wikipedia)
  naturally won't work without a network; that's expected and unrelated to the
  core runtimes.
