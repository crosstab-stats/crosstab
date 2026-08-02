# Full migration to the one true log — demolition plan (no shims)

**Mandate:** migrate the whole engine to a single project op-log, top to bottom.
**Delete** the old snapshot-diff world outright — no shims, no back-compat, no dual
representations. Any bug that survives should be a *new-code* bug, not an old/new
interaction. Save-breaking is allowed (pre-release). Rollback = discard/reset the
branch if it doesn't converge; that's an accepted outcome.

## Progress (updated 2026-08-02)

Branch `feat/unified-op-log`; nothing pushed. Backbone headless tests green
(171 pass, 4 skipped = folder-sync's mergeManifests tests, pending Layer 5).

- [x] **Layer 1 — ProjectLog final** (`70cc844`). serialize/restore, target `slice`,
      scoped undo (`undoWhere`/`redoWhere`/`undoneOps`). + `dump()` for debugging.
- [x] **Layer 2a — pure `foldDataOps`** (`0252a2b`). retract + reorder resolution, tested.
- [x] **Layer 2b — DataStore is a fold of the one log** (`6347b95`). No private `#log`;
      mutators append `ds:<id>/…` ops; deletion=`retract`, reorder=`reorder`; scoped
      undo; exportState/restoreState → op-recipe `{ops}`.
- [x] **Layer 3 — DatasetManager injects the one log** (`15b0e17`). collection + data
      tiers share it; remove() drops orphaned data ops; loadBundle clears both tiers.
- [x] **Layer 4 — persistence writes/reads the op-recipe** (`84e658f`). Single-peer
      create/edit/save/load round-trips on the log. app.js recycle gate updated.
- [x] **Browser-verified single-peer** (user + agent, 2026-08-02): recode ×2, reorder,
      rename, save/reload, load-from-loader (correct History order); delete-middle-step
      (retract), undo-of-retract, moveOp, real DuckDB data all correct. Decisions in
      [the explicit-ops memory] endorsed by the user.

### Layer 5 — merge/transport (NEXT), with a prerequisite

**Prerequisite (do FIRST — it's a confirmed single-peer BUG, not just collab prep):**
reshape `project.json` to carry `ProjectLog.serialize()` (the WHOLE log — collection +
data + analysis tiers, with **stable** op ids/hlc/author) + source assets, and make
load restore it *preserving ids* (not the current per-dataset re-mint).

> **BUG that proves it (user, 2026-08-02, via `dumpLog`):** save FOLDS the data tier.
> Repro: load project → `dumpLog` shows `…, recodeVar:region, recodeVar:gender`. Reorder
> them in History → `dumpLog` shows a trailing `reorder` op. Save, reload → `dumpLog`
> shows `…, recodeVar:gender, recodeVar:region` **and the `reorder` op is GONE**. The
> reorder's *effect* (order) was saved; the *op* was lost.
>
> **Root cause:** `project-sync.#snapshot` → `DataStore.exportState()` → `#steps()` →
> `foldDataOps()` applies & DROPS `reorder`/`retract` before persisting. The collection
> tier persists raw ops (`collectionLog`); the data tier folds. Asymmetry = the bug.
>
> **Fix:** the project save/load path must persist & restore the **raw** log verbatim
> (all tiers), stable ids preserved — NOT the folded recipe. Keep `exportState`'s folded
> `{ops}` recipe ONLY for the library/bundle re-home path (where re-mint is correct);
> add a raw whole-log path for project save/load. Touches: `project-sync.#snapshot`,
> `project-store` (save/load/buildManifest/writeSources), `dataset-manager.loadBundle`,
> and a DataStore raw-export + source-materialize seam (source bytes keyed by source-op
> id; strip the peer-local table name from the persisted op, rematerialise on load).
> Verify with the exact repro above + `dumpLog` before/after reload.

Merge convergence requires two peers to share op identity for the data tier; Layer 4's
re-mint is fine single-peer, wrong for collab. This unifies save with the log and is the
last thing standing between "works single-peer" and "mergeable".

Then: delete `collab-sync.mergeManifests`/`datasetToOps`/`opsToDataset`; rewrite
`folder-sync` (decideSync/syncFolderProject) + `project-sync` (live + gap-fill) onto
`ProjectLog.merge` (op-exchange, no per-peer base, no delete-inference, no dispose-all);
delete `project-store.readBase`/`writeBase`. Un-skip + rewrite the folder-sync tests.
**Verify with two-window testing** (the user's domain).

### Layer 6 — remaining consumers still on the old shape

`library.js` + `dataset-store.js` (building-block library), `project-bundle.js`
(`.crosstab` export/import), `gap-fill.js`. All off the single-peer boot path; migrate
to the op-recipe / asset model.

### Debugging aid

`crosstab.dumpLog([targetFilter])` in the console dumps the full one true log — every
active op (HLC order) + every undone/redo op, with state/target/owner/type/hlc/author/
payload. Shows the retract/reorder tombstones and undone ops that the folded History
view hides — built for tracing Layer 5 merge issues.

## The load-bearing decision (locked)

**A `DataStore` no longer owns a private op-log.** There is ONE `ProjectLog` per
project holding *every* op. A dataset's data ops (`load`/`append`/`join`/`recodeVar`/
`computeVar`/`setCell`/`setVariable`/`filterCases`/`dropVars`/`keepVars`/`renameVar`)
live in that one log, each tagged `target: "ds:<id>/…"`, `owner: "core"`. `DataStore`
becomes a **fold**: it reads its slice of the log (ops whose target is `ds:<id>/…`, in
HLC order), replays them to build the DuckDB view + metadata (today's `rederive`), and
its mutators *append to the ProjectLog* instead of a local `#log`. Undo/redo/rewind/
reorder become log operations. "Dataset logs derive from the one log" — literally.

## Two refinements the plan glossed (locked while building Layer 1→2)

Discovered by reading `data-store.js` end-to-end against `ProjectLog`'s HLC ordering.
Both follow directly from "everything persistent is an op" + §10 "deletion is an
explicit merged op" — neither is a new principle, just its consequence.

- **Deletion of a pipeline step = an explicit `retract` op (tombstone), never a
  physical removal.** Forced by correctness: `sharedAncestor` derives the merge base
  from the shared op-id *intersection*, so a physically-removed op drops out of the
  ancestor and then reads as the peer's *addition* on merge — it silently returns.
  That is the delete-inference bug class. So `removeOp`/History-delete append a
  `retract{payload:{opId}}`; the fold skips retracted ops; the retract propagates as a
  normal add-wins addition. (Solo Ctrl-Z undo stays physical-to-redo — the deferred
  "collaborative undo" nuance already noted in ProjectLog.)
- **User-editable pipeline order = an explicit `reorder` op.** Order is HLC-derived by
  default; `moveOp`/`collectImports`/`replaceTransforms` append a `reorder{payload:
  {order:[opId,…]}}`; the fold applies the latest one (ops not listed fall back to HLC
  order). Concurrent reorders merge as normal ops (three-way surfaces the conflict).
  Keeps the do-file editor log-native instead of mutating HLC.

## Target architecture

- **One log.** `ProjectLog` = the ordered op stream. Tiers by `owner`/`target`:
  collection (`coll/ds:<id>`), dataset data (`ds:<id>/…`), analysis (`analysis:<id>`),
  plugin workspace (`ws:<owner>/…`, later). `setActive`/selection stay **view state**.
- **State = projections/folds.** collection → membership; each dataset → its DuckDB
  view; analysis → Output pane. All derived, never stored as truth.
- **Merge = `ProjectLog.merge`** — op-union by id, ancestor = shared op-id history,
  per-owner strategy, genuine same-target conflicts surfaced. **No diffing, no
  per-peer base, no delete-inference.** A dataset is gone only via an explicit
  `removeDataset` op. Version skew = "missing some of their ops," never data loss.
- **Persistence = the log + content-addressed assets.** `project.json` = the serialized
  op-log + metadata; source bytes = `asset:<sha>` files. No `datasets[]` snapshot as
  truth. The old "manifest" survives only as an optional *derived* catalog summary.
- **Transports feed the log.** folder-sync / live-protocol exchange ops (or a log the
  other side merges), converge via `ProjectLog.merge`, and re-fold affected
  projections **incrementally** (`planDatasetApply`) — never dispose-all-rebuild.

## Demolish (delete these — do not preserve)

- `collab-sync.js`: `mergeManifests`, `datasetToOps`, `opsToDataset` — the entire
  snapshot-merge + reconstruction. (Keep `flatten/unflattenWorkspaces` + `buildMergers`
  until the plugin tier moves; then revisit.)
- `project-store.js`: `buildManifest`-as-truth, `readBase`/`writeBase`, the
  `datasets[]`-snapshot save/load. Rewrite `save`/`load` to (de)serialize the log +
  assets.
- `folder-sync.js`: `decideSync`/`syncFolderProject` snapshot logic + per-peer base.
  Rewrite as op-exchange + `ProjectLog.merge`. `manifestsEqual`/`contentSig` → op-set
  compare.
- `project-sync.js`: per-peer `#lastManifest` ancestor, `#applyMergedManifestLive`'s
  dispose-all `loadBundle`, the delete-inference fallback path. Rewrite `#snapshot`/
  apply/merge onto the log.
- `data-store.js`: the private `#log` as source of truth (becomes a slice of the
  ProjectLog); `deterministicOpId` legacy path; `exportState`/`restoreState`'s
  `{sources, transforms, order}` shape (the log IS the shape now).
- `dataset-manager.js`: `loadBundle`'s reconstruction fallback + the `collectionLog`
  round-tripping shim.
- The delete-inference legacy branch, everywhere.

## Rebuild — strict dependency order (commit each layer; each must pass headless tests)

1. **`ProjectLog` final form** — holds all tiers; op envelope for data ops; serialize/
   deserialize the whole log; `merge` is the sole merge. Extend tests.
2. **`DataStore` as a fold of the log** — the biggest surgery. It appends data ops to
   the injected ProjectLog (targeted `ds:<id>/…`) and folds its slice in `rederive`.
   Undo/redo/history become log ops. Delete the private `#log`-as-truth + export/restore
   shape.
3. **`DatasetManager`** — collection + data tiers both on the one log; drop the
   reconstruction shim.
4. **Persistence (`project-store`)** — save/load the log + content-addressed assets;
   delete `buildManifest`-as-truth + base sidecar. (Pulls unit 7 forward — assets are
   now load-bearing.)
5. **Merge/transport (`collab-sync` delete, `folder-sync`, `live-protocol`,
   `project-sync`)** — everything converges via `ProjectLog.merge` on ops; incremental
   fold on apply; delete per-peer base + delete-inference + dispose-all.
6. **Analysis + gap-fill** — analysis already a projection; gap-fill → fetch missing
   `asset:<sha>` by hash.
7. **Tests** — rewrite the suite around the log; delete tests for demolished code.
8. **Browser verification** — single-window first, then the user's two-window run.

## Verification & rollback

- Headless tests are the backbone at every layer; a layer isn't "done" until green.
- The app will NOT run end-to-end until ~layer 5 — expected with a no-shim rewrite.
- If the rewrite doesn't converge (correctness or budget), `git reset` the branch to
  the pre-migration commit (`303efb3`-era) — an accepted outcome, and we'll have
  learned the shape.
