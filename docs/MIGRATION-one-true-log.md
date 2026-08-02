# Full migration to the one true log — demolition plan (no shims)

**Mandate:** migrate the whole engine to a single project op-log, top to bottom.
**Delete** the old snapshot-diff world outright — no shims, no back-compat, no dual
representations. Any bug that survives should be a *new-code* bug, not an old/new
interaction. Save-breaking is allowed (pre-release). Rollback = discard/reset the
branch if it doesn't converge; that's an accepted outcome.

## The load-bearing decision (locked)

**A `DataStore` no longer owns a private op-log.** There is ONE `ProjectLog` per
project holding *every* op. A dataset's data ops (`load`/`append`/`join`/`recodeVar`/
`computeVar`/`setCell`/`setVariable`/`filterCases`/`dropVars`/`keepVars`/`renameVar`)
live in that one log, each tagged `target: "ds:<id>/…"`, `owner: "core"`. `DataStore`
becomes a **fold**: it reads its slice of the log (ops whose target is `ds:<id>/…`, in
HLC order), replays them to build the DuckDB view + metadata (today's `rederive`), and
its mutators *append to the ProjectLog* instead of a local `#log`. Undo/redo/rewind/
reorder become log operations. "Dataset logs derive from the one log" — literally.

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
