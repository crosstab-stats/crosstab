# Driving CrossTab programmatically

How to run the app and verify a change in it, for an agent or a developer automating a
browser. `docs/TESTING.md` is the manual checklist; this is the machine-driven counterpart.

Everything here is an **observed finding with a date**, not a guarantee. Browser behaviour,
WebR and DuckDB-WASM all move. If a recipe stops working, trust the observation that it once
did and re-derive, rather than assuming the app broke.

> **Portability.** Sections marked **[portable]** hold for any machine. Sections marked
> **[this desktop]** are facts about the maintainer's Windows machine and are wrong
> elsewhere — paths, installed tools, and the Chrome profile. A cloud or Linux environment
> needs its own equivalents, and some of it (see *Limits*) has no equivalent at all.

---

## 1. Serving the app — [portable]

**Use the committed dev server.** `npm run dev` (or `node scripts/dev-server.mjs [port]`)
serves the repo root on `http://localhost:8080/`. Zero dependencies.

It sends the headers the app actually needs, which a plain static server does not:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: no-store
```

Cross-origin isolation gates `SharedArrayBuffer`, which gates the fast WebR and DuckDB
paths. `credentialless` rather than `require-corp` because it is lenient toward the WebR
CDN, which supplies its own CORP/CORS and so loads fine. `no-store` means an edit shows on
reload.

If the dev server ever falls short, fix *it* rather than spinning up a throwaway — a
throwaway's headers drift from production's and the difference is invisible until something
subtle fails.

**On GitHub Pages the headers come from the service worker instead**, because Pages cannot
send them. The first visit loads un-isolated and `sw.js` reloads once after taking control,
guarded by a `sessionStorage` flag. That dance **cannot be exercised on the dev server**,
which sends real headers and so skips it — it is only testable on Pages.

### `?launch=` skips the launcher

`?launch=start-blank`, `?launch=demo-quant`, `?launch=demo-qual`. Without one you land on
the launcher and have to click through it. Also useful: `?screen=small|full` overrides
screen mode without persisting, and `?assets=local` switches to vendored runtimes.

## 2. Reaching into the app — [portable]

`window.crosstab` is the live engine, not a debug mirror:

```
bus  datasets  dataStore  duckdb  webr  results  menus  importers  exporters
projects  assetStore  loader  plugins  pluginCreator  services  workspaceStore
workspaceManager  codecs  analysisLog  pluginActions  undoCoordinator  projectLog
itemStore  memoStore
```

`crosstab.datasets` is the DataStore facade — `getVariableMeta()`, `getColumns(names)`,
`createWithData()`, `remove(id)`, `getHistory()`, `exportState()`, `restoreState()`,
`recodeVariable()`. `crosstab.dumpLog(filter)` dumps every op across all tiers including
tombstones.

Two shapes that cost a round trip every time if you guess:

- There is **no `datasets.getRowCount()`** on that facade.
- `results.getModel()` returns a **bare array**, not `{blocks}`. A table's content is nested
  under `b.table` (`.caption` / `.columns` / `.rows`), not on the block. A text block's
  content is `b.html`; `b.text` reads empty.

Make a throwaway dataset with
`datasets.createWithData({ name, variables: [{ name, type, valueLabels, missingValues }], columns: { name: [...] } })`,
and clean up with `datasets.remove(id)` plus `results.clear()`.

New core modules can be smoke-tested in the page with `await import('/core/xyz.js')`.

## 3. Driving Chrome — [this desktop]

Via the Claude-in-Chrome extension: `list_connected_browsers` → `select_browser` →
`navigate` to localhost. Then `javascript_tool` for everything; see the traps below for why
screenshots are not the primary tool.

**`javascript_tool` returns `{}` for a bare async IIFE** — it logs the pending promise.
Prefix the whole expression with `await`:

```js
await (async () => { /* … */ })()
```

Wrap app calls in `try/catch` returning `{ error, stack }` so a rejection surfaces instead
of an empty object. Returning raw source text from an eval can come back
`[BLOCKED: Cookie/query string data]` — compute booleans and counts in the page instead.

## 4. The traps — [portable behaviour, hit via automation]

These are browser behaviours, not CrossTab bugs, and they produce *timeouts* rather than
errors — which reads as "the app hung" when nothing is wrong.

**Render-gated work does not run in a hidden or occluded tab.** `requestAnimationFrame`
never fires; `setTimeout` and microtasks still do. So it is specifically render-dependent
work that stalls. Consequences:

- **A `<dialog>`'s `close` event never fires**, because Chrome dispatches it from the
  rendering steps. `dialogEl.close('ok')` sets `open = false` and `returnValue`, so the DOM
  looks right while the app's promise never resolves and any `await` on it hits the 45-second
  CDP evaluate cap. **Taking a screenshot forces a frame and flushes every queued `close` at
  once** — that is the reliable workaround.
- `appendTable` can run without ever painting.
- Deferred UI work must not assume a rendering tab. Correct code that never runs looks
  exactly like broken code.

**Display sleep causes the same freeze.** When the *screen* powers off while the computer
stays on, Chrome treats the window as occluded: timers throttle to about once a minute and
rendering pauses. This is about window visibility, not CPU sleep, and it made two whole
sessions look flaky before the cause was found. Before a long automated run, either keep the
screen awake or relaunch Chrome with
`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion`.

**Extension screenshots can time out** ("renderer may be frozen") on this project's tab even
while the page answers `javascript_tool` instantly — a heavy-paint/CDP quirk. Read state
through `window.crosstab` rather than looking at pictures.

**Never poll inside one long eval.** A 38-second wait loop blows the 45-second cap. Set a
status flag from a `.then()` and read it with separate one-line evals.

**Never trigger `window.print()` under automation.** The modal print preview blocks the
tab's JS thread, so every later eval queues behind it, and Chrome's own UI cannot be
dismissed from the page. Recovery is to `navigate` the tab — handled by the browser process,
not the blocked renderer. Verify the HTML/docx exporters instead; they return bytes.

**Don't trust `resize_window`.** It has reported success while `innerWidth` stayed put and
`outerWidth` read 0. Size a test iframe instead.

**CDP-synthesised Tab and Escape go to the browser chrome, not the page.** Synthetic
`KeyboardEvent`s do faithfully exercise our own handlers — the logic is ours — but not native
button activation, `:focus-visible` matching, or focus movement.

## 5. Running an analysis without dialogs — [portable]

Plugins are not activated by default. Activate, confirm, then supply every input so the
gather step is skipped entirely:

```js
plugins.applyActivatedSet([...plugins.activatedKeys(), './plugins/builtin-x/index.js']);
pluginActions.listRunnable();            // rich objects: pluginId, run, label, inputs
await pluginActions.runAnalysis('builtin-x.fn', { inputs: { /* … */ } });
results.getModel();
```

**Take the input names from `listRunnable()[i].inputs`, never from a guess.** A wrong key
means `gatherInputs` opens a real `<dialog>` and the run hangs forever. Dismiss a stuck one
with:

```js
[...document.querySelectorAll('dialog.ct-dialog')].find((d) => d.open).close('cancel');
```

### Driving the real dialogs instead

Sometimes the dialog *is* what you are testing. `app.ui.selectVariables` / `selectFromList`
render `<dialog>`s that resolve on `close`.

- Use **`dialogEl.close('ok')`**, not a synthetic click on the OK button. A click sets
  `open = false` and `returnValue` without reliably firing `close`, so the promise never
  resolves.
- Select the *open* dialog: `[...document.querySelectorAll('dialog.ct-dialog')].find(d => d.open)`.
  A blind `document.querySelector('dialog.ct-dialog')` can grab a stale closed one, and
  `dialog[open]` can grab the launcher (`dialog.ctl`, hundreds of buttons).
- Two sequential dialogs have a postMessage round trip between them — **poll for the second,
  never assume a fixed wait.**
- Reading an open dialog's DOM and then `dlg.remove()` works without a close event.

## 6. Driving a real import — [portable, except the file dialog]

The only unautomatable part is the OS file picker, and that is not our code. Stub exactly
that and everything else is the real path: menu → format picker → `pickFiles` → codec
service → sandbox → DataStore.

1. **Activate a codec first** — none is active by default:
   `plugins.applyActivatedSet([...plugins.activatedKeys(), './plugins/builtin-csv-codec/index.js'])`.
2. **Patch the dialog:** override `HTMLInputElement.prototype.click` so a `type="file"` input
   receives `this.files` from a `DataTransfer` holding your `new File([...], 'x.csv')`, then
   dispatches `change`. **The patch dies on every reload** — re-apply it, or the native
   dialog opens and the import silently does nothing: zero datasets, no error, no toast.
3. **File menu:** the item is a plain `<button>` whose text matches `/Import data/`. Click
   `File` first, wait ~150 ms, then click it.
4. **The format picker is `dialog.ct-fmt` and its list is search-filtered.** Set its single
   `<input>`'s `value`, dispatch `input`, then click the row.
5. **Answer each dialog with `dlg.close(value)`.** Values seen: sheet picker `ok`, missing
   codes `ok`, the stack/swap prompt `new` / `swap` / `append`. Several can queue — poll.
6. **Read the result** with `datasets.getVariableMeta()` and `getColumns(names)`.

**A real `.xlsx` to feed it:** `test/xlsx-fixture.mjs` builds genuine OOXML but imports
`node:zlib`, so it cannot run in the page. Generate the bytes in Node and paste them in as
base64 — a small workbook is about 1.5 KB, which fits in one eval.

**A codec that loads an asset cannot be tested in Node as written:** `importAsset` does
`import(URL.createObjectURL(blob))` and Node's ESM loader accepts only `file:`, `data:` and
`node:`. Override `URL.createObjectURL` to return `data:text/javascript;base64,…`, capturing
the source on the way past — a Blob only yields it asynchronously and `createObjectURL` is
synchronous. See `test/excel-codec-streaming.test.mjs` and
`test/parquet-codec-routing.test.mjs`.

## 7. Measuring a pane's layout — [portable]

A workspace pane is an **opaque-origin sandboxed iframe**, so `iframe.contentDocument` is
null from the host page; you cannot measure it the way you measure the host.

The technique that works — and beats a screenshot, because it yields numbers at a width you
choose and is reproducible: **rebuild the pane's DOM in a same-origin iframe you create,
styled with the real stylesheets**, then read `getBoundingClientRect()` and
`getComputedStyle()`.

- `const { BASE_CSS } = await import('/core/plugin-stdlib.js')` for the stdlib sheet.
- For a plugin's own sheet, `fetch('/plugins/<id>/index.js')` and slice between
  ``sheet.replaceSync(` `` and the closing backtick.
- Build `srcdoc` with `<html data-screen="small">`, both `<style>`s and the pane's structure;
  size the iframe to the width you want; measure on `onload`.
- **Measure the same DOM against the old CSS too.** A verified before/after beats "it looks
  better".
- Small-screen mode is attribute-driven, so `[data-screen="small"]` rules apply at any
  viewport — you do not need a narrow window.
- **Leaving a host stylesheet out measures a page the device never sees.** Omitting
  `core/launcher.js`'s injected sheet once hid the actual root cause for an hour.

Do not poke `workspaceManager.remountActive()` to recover a pane — it dropped the pane *and*
its tab, and `reconcile()` did not bring it back. Reload the page.

## 8. Headless Chrome from the CLI — [this desktop]

When the extension is not connected at all (the maintainer was on a phone):

```
chrome.exe --headless=new --disable-gpu --virtual-time-budget=30000 --dump-dom URL
```

`--dump-dom` prints the finished DOM, so a page that measures itself into a `<pre>` returns
its numbers to the shell. `--screenshot=out.png` gives an image for a before/after.

- **`--window-size` clamps the width at about 500px.** Put the phone viewport in a
  same-origin iframe you size yourself and read `contentDocument` from the outer page; `vh`,
  `dvh` and `vw` resolve against the iframe.
- Poll the handshake with `requestAnimationFrame`, not `setInterval` — virtual time stalls
  the timer.
- **Retry 2–3 times.** It silently produces nothing perhaps a third of the time.
- Serve from `npm run dev` so ES-module imports resolve.

## 9. Validating statistics against desktop R — [this desktop]

Harnesses live in `spike/`, need a local R, and exit non-zero on failure:
`spike/compare-desktop-r.mjs`, `spike/compare-geo-sf.mjs`, `spike/validate-mixture-R.R`.

`spike/compare-desktop-r.mjs` is the pattern worth copying: it **extracts the generated R from the
plugin at run time** by stubbing `webr.run`, so the comparison cannot drift from what ships.

On this machine: `C:\Program Files\R\R-4.6.0\bin\Rscript.exe`, with a writable user library
at `C:\Users\Ryan\R-libs` (`$env:R_LIBS_USER`). Local R installs official packages as
prebuilt Windows binaries, including ones that do not build in WebR.

Watch for convention mismatches before declaring a difference — argument order, row-versus-
column dependence, and `sf`'s s2 geometry (a geographic CRS makes an edge a great-circle arc;
`sf_use_s2(FALSE)` forces the planar question, and the difference is quadratic in edge
length: 11.4 km at 10°, 1.2 m at 0.1°).

## 10. Judging whether an R package can run in WebR — [portable]

**Read the index first; do not probe.** WebR publishes a CRAN-style index of everything it
has built:

```
https://repo.r-wasm.org/bin/emscripten/contrib/4.6/PACKAGES
```

`core/offline.js`'s `parsePackages()` already parses that format — import it rather than
writing a second parser. Walk `deps` for the dependency closure and compare against the
ceiling of roughly **20 concurrently loaded shared objects**. Seconds, offline, no browser,
no session to poison. Absence from the index is the one conclusive answer.

Then **`HEAD` the `.tgz` for the package itself** — the index lists packages whose binary
was never built. `webr::install()` has returned successfully having installed nothing, so the
first symptom was `library()` failing much later.

When a load does fail:

- **Failures are cumulative, not per-package.** Past the `.so` ceiling, `dyn.load` fails on
  whichever object is next in line, so the error names an innocent bystander. Always test a
  suspect package standalone before blaming it.
- **A long-lived tab degrades and produces false failures.** Re-check any feasibility result
  in a fresh session before recording it — a wrong "impossible" closes off features
  permanently.
- **The R library filesystem is read-only**, so you cannot trim a package's imports to get
  under the ceiling.
- A convenience wrapper can be the entire cost: check whether the package you want is a
  wrapper before accepting its closure.

When a package genuinely cannot load, ask what it actually *computes* — several measures
turned out to be rank arithmetic, hand-rolled in JS, and better than the R route.

## Limits — what automation cannot establish

- **Real `Tab` / `Escape` / focus-ring behaviour and native button activation.** CDP keys go
  to the browser chrome. These need a human.
- **Touch.** Whether a 44px target suits a thumb, and whether the on-screen keyboard shifts
  a layout. This project is tested on iPhone and iPad regularly, and "works with a mouse" has
  never been the whole story — several defects were found in seconds on real hardware after
  passing every automated check.
- **The service worker's cross-origin-isolation reload on Pages**, which the dev server's real
  headers skip.
- **Anything needing a device's own browser** — in particular, an environment with no access
  to a running Chrome cannot verify a UI change here at all. The test suite is pure Node and
  cannot see render bugs, dialog behaviour, WebR, or DuckDB.

### Two environment traps that invalidated checks — [this desktop]

- **Cache Storage silently fails when Chrome's `--user-data-dir` is under `%TEMP%`.** Every
  `cache.put()` throws `InvalidAccessError: Entry already exists`, even on a provably empty
  cache with a random name, with plenty of quota. Nothing to do with the code under test. Move
  the profile out of the temp tree. The failure mode is *weaker tests that still pass* — a
  service-worker boot test ran green while the offline cache was never exercised at all.
- **`pkill -f dev-server.mjs` does not kill a backgrounded Node server on Windows under Git
  Bash.** It reported success while the server kept serving, which quietly turned a
  "stalled network" negative control into a healthy run. Kill by PID from
  `netstat -ano | grep :8080`, and *prove* the stall with `curl -m 5` (expect exit 28) before
  trusting the result.
