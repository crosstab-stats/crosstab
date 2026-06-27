# iPad / Safari on-device test checklist (#91)

CrossTab is browser-only but iPadOS Safari has its own quirks (storage eviction,
memory limits, OPFS, sandboxed iframes, no custom HTTP headers → SW-injected
cross-origin isolation). This list is **UI-observable** — no dev tools needed.
If you can attach the iPad to a Mac, Safari ▸ Develop ▸ [iPad] ▸ the page gives a
real console, but it's optional.

**Target:** https://crosstab-stats.github.io/crosstab/ in Safari.

Designed to run across multiple sittings — tick as you go. Log anything odd in
**Findings** at the bottom (step #, what you saw, dataset/analysis, screenshot).

---

## 0. Cold load
- [x] Page loads; a single **flash/reload** at the very start is expected (the SW
      grabbing cross-origin isolation). A *repeating* loop would be the red flag.
- [x] Launcher appears, no error overlay.

## 1. Runtime works on iOS (make-or-break)
*If R analyses produce output, isolation + SharedArrayBuffer + WebR all work.*
- [x] Launch **demo (quant)**.
- [x] Run **Frequencies/Descriptives** → results table. (First run downloads WebR,
      ~10–40s with progress — not a hang.)
- [x] Run a **plot** analysis → SVG chart renders.
- 🚩 Red flags: "SharedArrayBuffer is not defined", forever-spinner, silent no-output.

## 2. Core data flow — PASS
- [x] Data grid scrolls smoothly; value labels show.
- [x] Variable View: edit a label → it sticks.
- [x] **Import a file** (File ▸ Import, pick CSV/.sav from Files/iCloud). A *folder*
      import (CAQDAS .txt) may not be offered on iOS — fine, just note it.
- [x] Extract columns → new dataset; dataset⋈dataset **join** → new dataset. Join is
      captured in History as an undoable step.

## 3. Persistence (Safari evicts tab storage ~weekly — the real risk) — PASS
- [x] Make a change, **close the tab, reopen the URL** → project/data still there (OPFS).
      Verified stronger: survived a **force-quit of Safari** (swipe-up) — renamed
      project + renamed dataset both intact.
- [x] Inline-rename a project → sticks after reload.
- [x] Delete something → lands in **recycle bin** → restores.
- [x] Full project auto-save (incl. Output) round-trips across loads.

## 4. PWA install + offline — PASS (one transient, see findings)
- [x] Launcher nudges **"Add to Home Screen"** → do it (Share ▸ Add to Home Screen).
- [x] Launch from the **Home Screen icon** → full-screen, no Safari chrome.
- [x] Launcher ▸ **Pre-cache selected plugins** → reads clearly, progresses to done.
- [x] **Airplane Mode**, relaunch from icon → app loads, a cached analysis still runs.

## 5. Plugins & the CAQDAS flagship
- [ ] Edit ▸ Plugins → toggle one off/on; no "failed to load."
- [ ] Launch **demo (qual)** → the **Coding** workspace tab mounts (sandboxed iframe).
- [ ] Apply a code to a text selection → persists after reload.

## 6. Touch & layout (narrow screen)
- [ ] Menubar: long menus scroll *within the menu*, not the whole page.
- [ ] Variable-picker dialogs: multi-select by tapping; buttons not cut off.
- [ ] Rotate portrait ↔ landscape → reflows, nothing clipped.
- [ ] Tap targets big enough (no fat-finger misfires on grid/menus).

## 7. Stress / memory (iPadOS kills heavy tabs)
- [ ] Run a heavier analysis (regression, or a package-installer like lavaan/lme4)
      → completes, or fails *gracefully* with a message.
- 🚩 Red flag: tab **reloads itself mid-analysis** ("a problem repeatedly occurred")
      = iOS memory kill — note the analysis + dataset size.

---

## Findings

- **Stage 0–1: PASS.** Cold load + reload-to-isolate works on iPadOS Safari; WebR
  runs (R 4.6.0), Frequencies + plots produce output.
- *Not a bug (resolved):* Frequencies on **gender** = 50/50 while a Pie on
  **education** ≈ thirds — two different variables; gender is binary, education is
  3-level. Both correct.
- **Stage 2 — BUG FOUND & FIXED:** CSV import failed with "loadStreaming: batch
  before begin()". Cause: `ctx.begin()` (async — creates the DuckDB ingester) wasn't
  awaited in import-service.js before draining batches; slower iPad Safari lost the
  race so the first batch arrived before the ingester existed. Fixed by awaiting
  begin(). Re-test the CSV import after the deploy lands.
- **Stage 2 — BUG #2 FOUND & FIXED:** After the begin() fix, CSV import failed with
  "The object can not be cloned." Cause: the sandbox→host `postMessage` transfers
  column ArrayBuffers (zero-copy), but iOS/Safari WebKit refuses a transfer list
  across the sandboxed opaque-origin iframe boundary (Chrome allows it — verified).
  Fixed in plugin-host.html + plugin-host-codec.html: try transfer once, fall back to
  a plain clone for the session (Chrome keeps zero-copy; Safari clones). Re-test CSV
  import after deploy. *(NB: this WebKit transfer-refusal is real, but it turned out
  not to be the cause of this import failure — see BUG #3. The fallback is kept as
  correct hardening.)*
- **Stage 2 — BUG #3 (the actual cause) FOUND & FIXED:** the bare "object can not be
  cloned" was NOT the sandbox boundary. The on-device stack trace pointed at DuckDB
  `registerFileHandle` (duckdb-manager.js): the out-of-core streaming ingest hands an
  OPFS `FileSystemFileHandle` to the worker, which WebKit can't structured-clone.
  Fixed with an in-memory ingest fallback when OPFS handles aren't postable (Chrome
  keeps the OPFS parts path). Large-Safari out-of-core parity tracked as task #122.
  Also fixed the "had to kill the tab to get new code" issue: the SW now calls
  `registration.update()` on focus/visibility so deploys propagate without a tab close.
  Added plugin version badges + a build-time stamp as permanent freshness tools.
- **Stage 2 — PASS (verified on iPad):** CSV imports clean (30×10), extract columns
  works, join two datasets works, join captured in History as an undoable step.
- **Stage 3 — PASS (verified on iPad):** persistence survived a **force-quit of
  Safari** (renamed project + renamed dataset intact) — strongest form of the
  eviction test. Recycle bin works; full project auto-save incl. Output round-trips
  across loads. No bugs.
- **Stage 4 — PASS, with one transient (hardened):** install + full-screen + offline
  pre-cache + offline analysis all work. On the **first action after going offline**,
  one save failed with `Out of bounds call_indirect` — a transient DuckDB-WASM trap
  during the Parquet export; every subsequent save worked (the engine recovered).
  Not reproducible. Hardened by adding a one-shot retry to all three save paths
  (#fullSave/#flush/#settle) in project-sync.js: a transient engine trap now self-
  heals instead of surfacing a failed-save error (protects the "everything is saved"
  guarantee). The export/OPFS write is idempotent, so the retry is safe. If it ever
  recurs persistently, escalate to resetting the engine (DuckDBManager.close) before
  the retry.
- **ReadStat/SPSS import — iOS memory limit (tracked #123):** importing a single-year
  `GSS2024.sav` fails on **both** iPhone and iPad with a hard ReadStat worker crash
  ("crashed with no message"). Identical across devices despite very different RAM →
  it's WebKit's per-worker memory cap, not device RAM; GSS `.sav` is very wide
  (thousands of vars + big value-label dictionaries) so the parse exceeds it. The
  crash is below JS (uncatchable — diagnostics confirm). CSV import works fine on iOS.
  Interim: the in-app error now points to "choose variables…" / desktop. Real fix
  (WASM mem flags / var-subset / streaming) tracked as #123. The full cumulative GSS
  `.dta` (~1.4 GB) is desktop-scale regardless.
- _(add findings here as you go: step #, what you saw, dataset/analysis, screenshot)_
