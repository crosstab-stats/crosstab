# CrossTab

> Working title. A browser-based statistical analysis platform for social
> science researchers — a web-native alternative to SPSS/Stata that runs on any
> device (including iPad) with no installation.

CrossTab runs **R in your browser** via [WebR](https://docs.r-wasm.org/webr/)
(R compiled to WebAssembly). Statistics are computed by real R; results are
rendered as clean, SPSS-style tables rather than raw console output.

## Architecture: everything is a plugin

The core engine has **zero** statistical functionality. It is pure
infrastructure: a plugin loader, the WebR runtime manager, a data store, a
results renderer, a dynamic menu shell, and an event bus. The official analyses
(Frequencies, Regression, …) are themselves plugins that load through the same
public API third-party developers use. This is the Factorio / VS Code model:
the base content is just the official mod.

**All plugins are equal.** There is no privileged loading path: every plugin —
the built-in Frequencies analysis included — runs in its own sandboxed
`<iframe>` and reaches the engine only over `postMessage`. Plugin code never
enters the engine's heap, and never touches the host DOM. The official content
really is just the official mod, behind the same boundary as any third party.

```
core/
  event-bus.js     app-wide pub/sub
  data-store.js    canonical dataset + published data API
  webr-manager.js  WebR runtime, serial job queue, host-side data injection
  results-pane.js  SPSS-style output renderer (shadow DOM)
  sanitize-html.js allowlist sanitiser for untrusted plugin output
  menu-shell.js    dynamic menubar built from plugin registrations
  ui-service.js    host-rendered dialogs (app.ui) for sandboxed plugins
  plugin-broker.js host side of the plugin RPC (postMessage protocol)
  loader.js        plugin lifecycle; one sandboxed iframe per plugin
  app.js           composition root — wires it all together
  demo-data.js     temporary seed dataset (removed once import lands)
plugins/
  builtin-frequencies/   the reference plugin
sdk/
  plugin-api.d.ts  the formal plugin contract (every method is async)
  README.md        plugin developer guide
plugin-host.html   the sandbox document + in-iframe RPC client / app proxy
index.html         app shell + chrome styles
sw.js              cross-origin-isolation service worker (COOP/COEP)
manifest.json      PWA manifest
```

The plugin contract is the load-bearing decision; read
[`sdk/README.md`](./sdk/README.md) and [`sdk/plugin-api.d.ts`](./sdk/plugin-api.d.ts).
The postMessage protocol lives in [`core/plugin-broker.js`](./core/plugin-broker.js)
(host) and [`plugin-host.html`](./plugin-host.html) (sandbox).

## Running it locally

Everything is static files and native ES modules — no build step. But you
**must** serve it over HTTP (ES modules and service workers don't work from
`file://`), and the page needs to be **cross-origin isolated** for WebR's fast
path. The bundled `sw.js` injects the required COOP/COEP headers, so a plain
static server works:

```sh
# from the repo root
python -m http.server 8080
#   then open http://localhost:8080/
```

On first load the page registers `sw.js` and reloads once to become isolated;
WebR (tens of MB of WASM) downloads in the background the first time you run an
analysis. For production, deploy to **Cloudflare Pages** with a `_headers` file
setting `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which makes `sw.js` a no-op.

## First milestone — prove the hard parts

The goal of this stage is **not** UI polish; it is to prove the engine and the
plugin contract end to end:

1. ✅ WebR loads in a Web Worker, receives the dataset, runs R, returns
   structured output to the results pane. *(`core/webr-manager.js`)*
   **Verified in Chrome:** `lm(income ~ age)` returns coefficients; the
   Frequencies analysis renders a correct SPSS-style table.
2. ✅ A plugin loaded dynamically registers a menu item, triggers an analysis,
   and renders output **using only the published `app` API** — from inside a
   sandboxed iframe, over postMessage, with no engine or host-DOM access.
   *(`plugins/builtin-frequencies/` + `plugin-host.html` + `core/plugin-broker.js`)*
   **Verified in Chrome:** blob-module import in the sandbox, the postMessage RPC,
   the `app.ui` dialog, and result sanitisation all work end to end.
3. ⏳ Works on iPad Safari. *(still needs a hands-on device test — see note.)*

Milestones 1–2 were verified against desktop Chrome with cross-origin isolation
on (`crossOriginIsolated === true`, `SharedArrayBuffer` available). The iPad
Safari pass is the remaining unknown.

### How to verify

1. Serve the app and open it. You should see the **CrossTab** menubar, a
   **Variables** sidebar (5 demo variables), and an empty results pane.
2. Click **Analyze ▸ Descriptive Statistics ▸ Frequencies…**.
3. Tick `gender` and/or `education`, click **OK**. The status line shows the R
   runtime loading on first use, then an SPSS-style frequency table appears.
4. (`lm()` proof:) open the console and run
   `await crosstab.webr.run('coef(lm(income ~ age, data = df))', {injectData:true})`
   — `result` should contain the regression coefficients.
5. Repeat steps 1–3 on an actual iPad in Safari, early.

> **Remaining risk — iPad Safari.** The desktop-Chrome path is confirmed; the
> open question is whether Safari on iPadOS handles two things the same way:
> 1. **Blob-module import inside a sandboxed (opaque-origin) iframe**
>    (`plugin-host.html`). Confirmed working in Chrome. If a plugin fails to load
>    on iPad with "Failed to fetch dynamically imported module", this is why —
>    the fallback is a `data:`-URL import or a bundling step.
> 2. **Cross-origin isolation via the `coi-serviceworker`** path (`sw.js`). The
>    local test used real COOP/COEP headers instead; the service-worker reload
>    dance that GitHub Pages relies on has not been exercised on Safari yet.

> **Not built yet, by design:** the data editor and file import. The point of
> this milestone is to prove the engine and plugin contract first. A small
> synthetic dataset (`core/demo-data.js`) stands in until CSV/.sav import lands.

## Status of the open questions

See [`TODO.md`](./TODO.md) for the full task tracker; the highlights:

- **postMessage protocol** for iframe-isolated plugins — **now resolved**, by
  necessity: because *all* plugins are sandboxed equally, this is on the critical
  path, not deferrable. The protocol is implemented in `core/plugin-broker.js`
  (host) and `plugin-host.html` (sandbox); see those files for the message
  envelope, callback/disposer marshalling, and version tag.
- **Plugins can't render host DOM** — *resolved:* the engine exposes
  `app.ui` (host-rendered dialogs, `core/ui-service.js`); plugins describe UI
  declaratively instead of drawing it.
- **Untrusted plugin output** — *resolved (starter):* result HTML/SVG is run
  through an allowlist sanitiser (`core/sanitize-html.js`). Replace with a vetted
  library (DOMPurify) before public release.
- **Shadow DOM for the results pane** — *resolved: yes* (style isolation +
  one canonical table stylesheet). See `core/results-pane.js`.
- **R package pre-loading strategy** — *open.* Plugins declare `rPackages` in
  their manifest; what ships by default vs. installs on demand is undecided.
- **Plugin/API versioning interaction** — *partially resolved.* Loader enforces
  matching major + engine-minor-≥-plugin-minor; migration policy for major bumps
  is open.

## Tech

WebR (R via WASM) in a Web Worker · SharedArrayBuffer + `coi-serviceworker` ·
vanilla JS ES modules (no framework, to stay lean on iPad Safari) · IndexedDB
(persistence, planned) · File System Access API (file I/O, planned) ·
DuckDB-WASM (large datasets, under consideration).

## License

TBD (intended to be open source). Contributions and plugin authors welcome.
