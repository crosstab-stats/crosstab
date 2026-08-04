  - [x] **A8: destructive replace-import — CLOSED by removing "Replace" entirely.**
        *Decision:* a dataset can be created, deleted, and have rows/columns added or
        removed — but NOT wholesale cleared and refilled. The import dialog's `Replace`
        is gone; in its place `Swap in (old one goes to the bin)` imports into a NEW
        dataset that **inherits the outgoing dataset's name**, then bins the old one —
        after the import succeeds, so a failed import never costs data you still have.
        Same one-click gesture, none of the machinery: nothing is superseded within a
        dataset, so there is no generation to bin (A8a) and nothing is stranded (A7).
        The old dataset keeps its rows, its id, and its coding, and is restorable for
        free. NOTE: the engine's `loadDataset({mode:'replace'})` remains — it is how any
        *empty* dataset gets filled, and `restoreState`/`pullLatest` rely on `load` as
        the replace barrier (B1). Only the destructive user-facing option is gone.
# CrossTab — TODO

Single source of truth for pending work. The README narrates *status*; this file
tracks *tasks*. When something here lands, check it off (and update the README
milestone/open-question prose if it changes the story).

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Now / near-term

- [ ] **#149 — One-true-log stability gate (post-#148 fresh-eyes audit). BLOCKS ALL
      NEW FEATURES.** A full cross-model review of the #148 migration (done with a
      different model as proofreader) found the gaps below. Several are silent data
      corruption; nothing new ships until this list is cleared. Grouped by severity.
      The test for "done": every user-data change is an appended op (or is
      *deliberately* declared scalar/out-of-log and merges sanely), and no feature
      path physically removes durable ops.

  **A. Edits that escape the log / merge-safety violations**

  - [x] **A1 (serious): `analysisLog.clear()` physically deleted durable ops
        mid-session — DONE.** Both halves fixed. (a) *Merge resurrection:* `clear()`
        now appends a `removeAnalysis` op per live run instead of `clearWhere`, so
        the deletion propagates rather than dropping the runs out of the shared-id
        ancestor for a peer to re-contribute. (b) *Overbroad trigger:* `replace` is
        now emitted only when a load actually **destroyed existing data** — filling a
        fresh dataset (`createWithData`, `extractColumns`, seeding a blank) reports
        the new `load` reason — and the clear is scoped to the replaced dataset via
        `clearFor(datasetId)`, with `datasetId` stamped on each entry by
        `PluginActions`. Entries predating the field are left alone rather than
        guessed at. Downstream consumers of the reason were updated with it:
        `project-sync` marks sources dirty on `load` too (else a first import's
        Parquet never gets written), and `undo-coordinator` resets on `switch`
        (project open / new project) rather than relying on the seed's `replace`.
  - [x] **A2 (serious): `library.pullLatest` rewrote a live dataset's history outside
        the log — DONE.** The pull ran `restoreState` → `#resetDataHard` →
        `clearWhere(#mine)`, physically dropping an established (possibly already
        synced) slice and re-minting the ops. On the next merge the peer's copies of
        the dropped ops read as *their additions* and unioned back in alongside the
        re-minted duplicates — a doubled pipeline, the delete-inference class again.
        *Fixed:* the pull now APPENDS (`replaceHistory: false`). Nothing is removed
        from anyone's log; the recipe opens with a `load`, and B1's replace barrier
        folds the superseded ops away identically on every peer. Verified: after a
        pull every pre-pull op id is still present, only the new pipeline is live, the
        data is v2 and the local transform is re-applied on top. (`#add` was always
        safe — a fresh dataset has an empty slice.)
  - [x] **A3: project NAME is user data and is now an op — DONE.** *Decision: name as
        an op, not a merged scalar* — it's user data, and with `author` on every op it
        answers "who named this project that?". `setProjectName` on target
        `project/name`, folded by the `PROJECT_META` projection, carried in
        `manifest.log`, applied on every load/merge path, and the folded value WINS over
        `manifest.name` so a co-author's rename actually lands. Gotcha found in
        testing: `store.rename` only patches `manifest.name` in place, so the rename now
        also marks dirty + schedules a real save, or the op never reached disk.
  - [x] **A4 (serious for qual): recycle-bin round-trip lost workspace/coding
        state — DONE.** Restore minted a NEW dataset id, but `ws:` leaves are keyed
        by dataset id, so a deleted-then-restored coded dataset came back with its
        CAQDAS codebook silently gone. *Fixed by restoring under the ORIGINAL id*
        (`DatasetManager.restoreDeleted`; the bin entry now carries `datasetId` in
        its catalog record) — the leaves re-attach with nothing to re-home. The
        replay is appended *alongside* the deleted dataset's orphaned ops rather than
        clearing them (`restoreState(..., {replaceHistory:false})`): physically
        dropping them is the A2 resurrection pattern, and the B1 replace barrier
        already keeps them dead on every peer. `WorkspaceStore.dropDataset`'s fate
        decided: **delete no longer calls it** (deletion must stay recoverable) — it
        now runs on *permanent purge*, guarded to the project that's actually open.
        Added `rehomeDataset(old,new)` as the log-native fallback for the
        should-never-happen case where the original id is taken.
  - [x] **A5: media assets are now INSIDE the project — DONE (bar gap-fill).** They
        lived in their own OPFS root (`media-assets/`) with a `.json` metadata sidecar
        per asset, so a shared project's audio/video/images simply weren't there for
        the recipient. Now: bytes go to the project's own `assets/<id>.bin` through
        `ProjectStore` (so at-rest encryption, folder mode and the project layout all
        apply for free), and the metadata is an **op** — `addAsset`/`removeAsset` on
        target `asset:<id>` — folded by the new `ASSETS` projection, so the index
        merges, undoes and travels like every other tier. Writes stream through the
        driver (`writeStream`), and an unprotected read hands back the file handle's
        own Blob, so a multi-GB movie is never materialised in either direction; a
        *protected* project buffers, deliberately, rather than storing media in the
        clear. `.crosstab` carries `assets/<id>.bin` + the ops. Adding media to a
        never-saved project creates the project first (`ProjectSync.ensureProject`).
        **Still open:** live-P2P gap-fill for assets (`MediaStore.missing()` is the
        hook), and a one-time cleanup of the now-stale `media-assets/` and `recycle/`
        OPFS roots left over from the old stores.
  - [x] **A9: project export now asks about linked building blocks — DONE (bundle
        path).** *Finding that reshaped it:* the three options in the original plan
        (embed / keep link / unlink) collapse to two, because a bundle already carries
        every dataset's own sources — the DATA travels either way, so there is no
        embed-vs-reference size trade-off. All that's at stake is the `libraryLink`
        badge and its Pull-update button. *And that link is local by construction:* a
        block's id is a `crypto.randomUUID()` minted on whichever machine first saved
        it, and there is **no mechanism to share a block between machines at all**, so a
        recipient's library will never hold that id — not even if they independently
        imported the identical file. Keeping the link is only useful for a copy coming
        back to the same machine. So: `.crosstab` export detects linked datasets and
        asks Keep / **Drop (default)**, saying plainly that the link won't resolve for
        anyone else. Drop nulls `libraryLink` in the exported `datasetMeta`.
  - [ ] **A9b: the same prompt for the folder + live paths.** A folder-backed project
        and a live hand-off leak the same dangling link, but they're *continuously*
        synced — a one-shot modal is the wrong shape. Wants a project-level setting
        ("share links to my building blocks: no") rather than a prompt per save.
  - [ ] **A9c (design): building-block ids aren't portable.** The deeper issue A9
        surfaced. Blocks are addressable only by a locally-minted random UUID, so a
        shared block is *impossible*, not merely unsupported — two people who import the
        same file get different ids. If cross-machine blocks should ever work, ids need
        to be content- or origin-derived and blocks need an export/import path. Belongs
        with [[first-class-plugin-data]] and #150.
        *Related, measured:* adding a block **instantiates** it — `library.#add` creates a
        real dataset and `restoreState`s the block's Parquet into the project — so the
        link is pure provenance (`{id, version, baseLen}`), never a data reference. A
        project with two native datasets plus one from a block holds three Parquet
        sidecars of its own, and the block's bytes exist twice on the machine (library +
        project) before any export. That's the honest cost of the template model, and it
        is *why* dropping the link on export is harmless: the recipient already has the
        data as an ordinary dataset. The library COULD be content-addressed to dedupe
        instantiations (as media now is), but that would make projects non-self-contained
        — directly against what A5/A8 established. Self-containment wins; recorded so the
        trade-off is a decision, not an oversight. It also fits the design that upgrading
        a project to a newer block version is deliberately opt-in (`pullLatest`).

  **B. Bugs introduced/exposed by the rewrite**

  - [x] **B1 (serious): undo past a replace-import bricks the dataset — DONE.**
        `#resetData` retracted the old steps but `#dropDuckDB` physically dropped
        their bytes, and the retracts stayed undoable: import-replace → Ctrl+Z ×2
        revived a byte-less source, `rederive` threw, and kept throwing.
        *Fixed by deriving the reset instead of logging it.* A `load` already
        restarts the projection, so `foldDataOps` now treats the last live `load` as
        a **replace barrier** and drops what precedes it (fixed by HLC order, so a
        reorder moves steps but never resurrects them). A replace therefore appends
        no ops at all — nothing is retracted, so one undo of the `load` lifts the
        barrier and the whole previous pipeline returns. `#pruneDeadSources` frees
        only what is *already* behind a barrier, so exactly one generation stays
        materialised for that undo. And `rederive` now **skips** a source op whose
        bytes this peer lacks (reporting it on `missingSources`) instead of throwing
        — a durable op can no longer poison every later fold. That last part is also
        the landing pad for B3 and for live gap-fill's byte-less window.
  - [x] **B2 (serious, silent wrong data): row-id collision after reload — DONE.**
        Restores restarted `#sourceSeq` at 0 while restored Parquet kept row ids
        baked from the ORIGINAL seq, so with a gap in the log (routine after #148 —
        every replace leaves a byte-less source that consumes no seq on restore) the
        next appended file was handed a live range: duplicate `__ct_rid` across the
        UNION, and a `setCell` CASE editing TWO rows. Verified in-browser both ways
        (fix off → 2 rows changed by one edit; fix on → 1). *Fixed:* `#ensureRowId`
        now returns the base actually in the table (read back off a restored source
        via `min(__ct_rid)`), and every source-materialising path feeds it to
        `#noteRowidBase`, which advances `#sourceSeq` past it.
  - [x] **B3 (serious): a failed `rawRestore` dropped a dataset's ops from the next
        save — DONE.** `receiveOps` ran only after ALL sources materialised, so one
        unreadable Parquet threw, the dataset was dropped, and its data ops never
        reached the in-memory log — while its collection membership survived. The next
        save is a blind overwrite, not a merge, so it wrote a manifest permanently
        missing that dataset's entire history. *Fixed:* materialisation is now guarded
        **per source op** — a failure lands the envelope byte-less (bytes stripped,
        `file` ref kept so it can heal) instead of aborting, and `receiveOps` always
        runs before the re-derive, so the history is durable even if the re-derive
        itself throws. B1's `missingSources` tolerance does the rest: the pipeline
        replays without the dead source and names it. Verified by corrupting a
        `src_<opId>.parquet` on disk and reopening: the dataset stays, reports
        `missingSources: [{label: 'A'}]`, keeps all three steps applied, and after a
        further edit the re-saved manifest still carries every op. The live-P2P
        byte-less window (ops ahead of their gap-filled bytes) rides the same path.
  - [x] **B4: deterministic workspace merge-op ids could violate op immutability —
        DONE.** The id hashed only (target + resolved value), so a later merge that
        resolved to a previously-emitted value re-minted the SAME id with a HIGHER hlc
        — reachable via delete-and-redo cycles under add-wins. `receiveOps` dedups by
        id, so the newer copy was dropped and the leaf's fold could then pick an
        ordinary write over the merge result: peers genuinely out of step while
        `manifestsEqual` (an id-set comparison) reported them in sync. *Fixed:* the
        contributing op-id set (sorted, so operand order can't matter) is mixed into
        the hash. Covered by a unit test on `deterministicOpId` plus a re-run
        determinism test.
  - [x] **B5: identical concurrent intents surfaced phantom conflicts — DONE.**
        `threeWayLog`'s add/add target pass flagged two peers both undoing (or both
        retracting) the SAME op as a conflict, though every resolution yields the
        identical outcome. *Fixed:* an exemption for `undo`/`redo`/`retract` ops whose
        `payload.opId` matches. Deliberately EXCLUDES `reorder` — rival orderings are a
        real disagreement, and a reorder names no single op. Four tests pin it,
        including two negative controls (undoing *different* ops on one target, and
        rival reorders, both still conflict); verified load-bearing by disabling the
        guard and watching exactly the two positive cases fail.

  **C. Hygiene / decisions**

  - [x] **C1: live-P2P applied peer ops never marked `#dirty` — DONE.** *Decision:
        peer work is work.* Applied ops lived in memory until our OWN next edit, so a
        crash, a closed tab or a power cut lost a co-author's contribution locally —
        "it's still on their machine" isn't persistence. `#persistPeerWork` now marks
        the project dirty and schedules a save on every successful live apply.
        Deliberately NOT routed through `#onChange`, which would also fire
        `#scheduleLivePublish` and echo the just-received state back at the peer — this
        takes only the persistence half. When the data tier was rebuilt it also marks
        every live dataset's sources dirty, or the incremental save would write a
        manifest referencing `src_<opId>.parquet` sidecars never written for a peer's
        new dataset.
  - [x] **C2: byte files were never pruned — DONE.** A purged dataset's Parquet and
        every replaced import's sidecar stayed on disk forever (`orphanDataOps` stripped
        the `file` ref; nothing removed the file). `ProjectStore.#sweep` now runs after
        each save, keyed on **the manifest just written**: a file survives iff some op in
        the saved log names it. That rule can't drift from what a load will read, covers
        source sidecars and media assets alike, and stays correct when #150 adds asset
        ownership — and when A8a starts binning replaced generations, their ops will name
        their files, so the sweep keeps them with no change. Runs after the manifest is
        durable, so a crash mid-sweep loses only garbage; best-effort, never fails a save.
        Verified: after a replace-import the superseded generation's sidecar is gone and
        only the live one remains.
  - [x] **C7 (decision): post-merge Undo semantics — DECIDED, no code change.**
        Edit ▸ Undo targets the highest-HLC live op in the active dataset regardless of
        author, so right after a sync Ctrl+Z can undo a COLLABORATOR's newest edit (and
        the marker syncs back). *Decision: keep it.* Either rule disappoints someone;
        this one is simple, matches "the log is shared history", and the History panel
        already exists for undoing a specific action further back. Documented rather
        than changed.


- [ ] **#153 — Converge plugin data and datasets into ONE notion of project content.**
      Raised by the user looking at the shipped sidebar: Map Layers sit in their own
      section, styled as indented grey children, while datasets are bold boxed rows — and
      if building blocks are to be one list, the sidebar would then carry two areas with
      different organising schemes. The framing to design against (user): **promote
      third-party data UP to first-class, and demote host-owned datasets DOWN**, and see
      where they meet.

  **AUDIT — every way a record differs from a dataset today** (read off `#datasetRow`,
  `#recordRow`, and the `.proj__ds` / `.proj__blob` rules in index.html):

  | dimension | dataset | record (map layer) | intrinsic? |
  |---|---|---|---|
  | visual weight | bold, boxed, 13px | indented 24px, grey, 12px | **no** |
  | click to activate | yes (`--active`) | none | **partly** — see below |
  | drag to library | yes | no | **no** — the block contract is dataset-shaped |
  | rename | always | only with `labelField` | **no** — an authoring gap |
  | metadata shown | row count | none | **no** — records could declare a summary |
  | library link badge / pull update | yes | no | **no** — follows portability |
  | memo affordance | yes (💬) | **none** | **no** — a record has a target already |
  | delete → bin, restore, purge | yes | yes | — same |
  | History rows, undo/redo | yes | yes | — same |

  So of nine dimensions, **one** is arguably intrinsic and the rest are accidents of
  plugin data having grown up as a dataset side-car.

  **The one real asymmetry: activation.** "The active dataset" is a genuine global mode —
  analyses run against it. A map layer has no host-level equivalent… except spatial
  plainly HAS an active layer, it just manages it privately inside its own tab. So this is
  not a difference in kind; it is a concept the host declines to model. Modelling it
  ("active record, per collection") also answers the deferred question of whether sidebar
  rows should be clickable: **yes, and clicking means exactly what it means for a
  dataset.** That is a principled answer rather than an invented interaction.

  **Specific bug this audit found:** project-scoped records render at TOP level
  (`app.js:1837` passes `dsId = null`) but reuse `.proj__blob`, which has
  `padding-left: 24px`. Map layers are peers of datasets being drawn as children of
  nothing. Dataset-SCOPED records (CAQDAS coding) genuinely are subordinate and should
  stay nested; project-scoped ones should not be indented at all.

  **Where the two directions meet — "content items".** The project holds content items,
  each with: identity, a name, a kind, an optional summary line, lifecycle
  (bin/restore/purge), a memo anchor, and portability to the library. A **dataset** is a
  content item whose kind additionally supports activation and the tabular pipeline; a
  **map layer** is a content item of kind `boundarySets`. One row treatment, one set of
  affordances, kind conveyed by its section heading rather than by making some rows look
  second-class.

  **Deliberately NOT converging: storage.** A dataset owns a DuckDB table and a transform
  pipeline; a boundary set is bytes plus fields. That difference is real and the tiers
  stay separate. What converges is the MODEL and the presentation — naming, lifecycle,
  visibility, annotation, portability — none of which has any business differing.

  Worth noting the collection tier already mirrors the item tier: datasets are
  add/remove/rename/reorder ops under `coll/ds:<id>`, records are put/remove under
  `item:…`. The convergence is a real structural symmetry, not a coat of paint.

  - **DECIDED (user, 2026-08-04):**
    - **D1 — Building Blocks vs the project list: SHARED RENDERER.** The user's constraint
      is not "flat" or "grouped" but *"however items in a project are displayed should
      match how items in building blocks are displayed"* — and one flat Building Blocks
      list is acceptable **only if the active project is also one flat list**. Type
      separation (possibly collapsible) has value but is more code and may never be needed.
      **So the answer is to make the row and section renderers SHARED between the two
      areas.** Then flat-vs-grouped stops being a commitment: it is one switch applied to
      both, consistency is structural rather than maintained by hand, and adding groups
      later is cheap instead of a second rewrite. Start flat-with-kind-badge (least code);
      revisit only if a real project gets noisy.
    - **D2 — selection is NOT globally unique.** Superseding the earlier "active record"
      framing: selecting the ZIP-code boundary layer AND survey2 *at the same time* is a
      real workflow (run frequencies on survey2 filtered to a ZIP). So the host models one
      active item **per kind**, and the actives coexist as a selection SET. This is what
      makes cross-plugin flows composable (#147) — spatial reads the active layer, the
      analysis reads the active dataset, neither has to ask the other.
      *Still open:* multi-select WITHIN one kind (two layers at once). Spatial's own tab
      has a single active layer, so nothing needs it yet — do not build it speculatively.
    - **D3 — summary field: yes.** An optional declared summary so a record can show
      "11 regions" where a dataset shows its row count.
    - **D4 — the host owns active state; plugins READ it.** Spatial should react (switch
      the displayed layer); CAQDAS may reasonably ignore it. Opt-in, so a plugin that does
      not care needs no code.

  - **Assets are not content items.** "Stored files" is a byte tally, not a row in the
    list: an asset is the *bytes behind* a content item, not a thing you name, reuse or
    annotate. It stays a summary line with the reclaim action, outside the unified list.

  - [ ] **Then:** records block = item ops + the assets their declared `assetRefs` point
        at, instantiated on add (ids re-minted, per #149 A9c). That is the
        "building-block contract expansion" #146 parked, and #152 already supplies every
        piece it needs.

- [ ] **#154 — Workspace plugin lifecycle: audit + rebuild ("sandbox did not become
      ready in time").** Full trace of the lifecycle before touching the symptom, per the
      user. Files: `plugin-manager.js` (catalogue), `loader.js` (compute frame + probe),
      `plugin-sandbox.js` (the cage), `plugin-broker.js` (protocol), `plugin-host.html`
      (guest), `workspace-manager.js` (tabs + mount).

  **THE LIFECYCLE AS BUILT**

  1. **Catalogue (source read #1).** On a `CATALOG_VERSION` bump or a new plugin,
     `PluginManager` probes every entry: `loader.#probe` spins a **throwaway sandbox
     iframe per plugin**, imports the source with deny-all service stubs, reads
     `manifest`, and discards the frame. **Sequential** (`await` in a loop) over ~60
     built-ins. Only whitelisted manifest fields are kept (`menu`, `workspaces`,
     `collections`, `codecs`, `media`, …) — anything not whitelisted is invisible to the
     host forever after, which is how `collections` was silently missing (#152).
  2. **Activation (source read #2).** `loader.activate` makes a *hidden compute* iframe,
     `iframe.src = await sandboxBlobUrl('strict')`, `whenReady()` (20 s, **no retry**),
     `sendLoad(source)`, `sendActivate`. The source is fetched and parsed AGAIN — the
     probe's parse is thrown away with its frame.
  3. **Workspace mount (source read #3).** `reconcile` → `#mount` per declared workspace:
     builds a pane + toolbar + iframe + overlay, `tabs.addTab` (which appends the pane
     **`hidden`**), then fires `void #mountWithRetry` — deliberately not awaited.
     `#handshake` then: `src = await sandboxBlobUrl(cap)` → `whenReady(ms)` →
     `fetchSource` → `sendLoad` → `sendActivate` → `sendMountWorkspace`. Retry ladder
     `[20 s, 40 s, 60 s]`, each attempt discarding the iframe and building a fresh one.
     A third read+parse of the same source, in a third frame.
  4. **Mid-life.** `notifyDatasetChanged` → guest `onDatasetChanged` (5 s race);
     `notifyWorkspaceRefresh` → `onRefresh`; `sendPluginsChanged` push. All ack via one
     `#lifecycleAck` deferred — **a single slot**, so two overlapping hooks clobber it.
  5. **Teardown.** `#restart` → `sendDeactivate` → `#retry`. Deactivation/project switch →
     `#teardown` → `sendDeactivate().catch(()=>{})` → `broker.dispose()` → `iframe.remove()`
     → `tabs.removeTab`.

  **FINDINGS**

  - **F1 (root cause candidate) — the sandbox URL outlives its usefulness by design, and
    dies before the handshake can finish.** `sandboxBlobUrl` does
    `setTimeout(() => URL.revokeObjectURL(url), 15000)`. The ready timeouts are
    **20 s / 40 s / 60 s**. So a frame that has not loaded within 15 s has its SOURCE
    revoked out from under it and can never become ready — and the longer retries are
    therefore useless: every attempt still dies at 15 s. On a busy boot this is not a
    timeout, it is a self-inflicted abort. Fix: revoke on the iframe's `load`, or on
    broker dispose — never on a wall clock.
  - **F2 — every workspace mounts eagerly, hidden.** `addTab` appends the pane with
    `hidden = true`, and `reconcile` mounts every active workspace plugin at boot
    regardless of which tab is shown. So N sandboxes race to load, hidden and
    deprioritised, while DuckDB and WebR are warming. `addTab` already accepts an
    `onShow` hook — mounting lazily on first view is available and unused.
  - **F3 — I bumped `CATALOG_VERSION` to 17 today (#152).** Every existing install
    therefore re-probes ~60 built-ins on next load, each a fresh sandbox frame, which is
    exactly the condition F1 punishes. Plausibly why this got louder right now.
  - **F4 — `sendDeactivate` races a 500 ms timeout** (`Promise.race`). A flush slower
    than that is silently abandoned, and the host proceeds to tear the frame down. Also
    interacts with #153's epoch guard: a flush must land BEFORE the project boundary
    advances, or the guard correctly drops it and the hook looks wired while doing
    nothing. (NOTE: the hook IS wired — an earlier claim in this file that the host never
    sends it was wrong; `plugin-broker.sendDeactivate` → guest `case 'deactivate'`.)
  - **F5 — one `#lifecycleAck` slot for all hooks.** `sendDatasetChanged`,
    `sendWorkspaceRefresh` and `sendDeactivate` each overwrite `this.#lifecycleAck`. Two
    in flight and the first never resolves. Reachable: a dataset switch during a refresh.
  - **F6 — mount is fire-and-forget.** `void this.#mountWithRetry(...)`, so `reconcile`
    resolves before any workspace is usable and nothing can await "workspaces ready".
  - **F7 — the same source is fetched and parsed up to three times** (probe, compute
    frame, each workspace mount + each retry), in separate frames, with no sharing.

  **DESIGN: `docs/ARCHITECTURE-plugin-lifecycle.md`** — the new envelope, written after
  MEASURING the platform rather than assuming it. Three findings reshaped it:

  - **Sandboxed opaque-origin iframes already run OUT OF PROCESS.** A guest burning
    2500 ms of CPU left the host ticking with a 109 ms max gap. A plugin taking 90 seconds
    — or hours — does not block the UI today. The user asked for threading so the UI stays
    responsive; that property is already held, by the isolation mechanism, for free.
  - **A Worker cannot be spawned inside the cage.** An opaque origin makes
    `blob:null/…` URLs, which are not fetchable, so `new Worker(blob)` constructs and
    fails to load. `worker-src blob:` does not help — the URL is the blocker, not the
    policy. So the cage+worker composition is off the table, and unnecessary.
  - Therefore the rebuild is **reporting and patience**, not concurrency: explicit failure
    signals for every step, guest-side global error handlers so silence is impossible,
    rid-keyed acks, progress + heartbeat, and exactly ONE advisory timer that may change
    wording and nothing else.

  **OLD DIRECTION (superseded, kept for the reasoning)**

  - Tie sandbox URL lifetime to the frame, not to a timer. This alone may fix the symptom.
  - Mount lazily on first tab view; keep eager mount only where a workspace must run
    unseen (none known today).
  - One explicit handshake state machine per mount — `idle → booting → loading →
    activating → mounted → failed` — so retry, teardown and refresh cannot interleave,
    replacing flags spread across `#mounted`, the overlay and the broker.
  - Per-hook ack keyed by hook name, not one slot.
  - Deactivate: real budget, awaited, and sequenced before the epoch advances.
  - Consider caching the probe manifest so activation does not re-parse; and reusing one
    frame per plugin rather than one per surface.

- [ ] **#151 — Re-home tool: repoint what referenced dataset A at dataset B.** With
      in-place replace gone (#149 A8), the "here's a corrected version of my data"
      workflow is: import as a new dataset, bin the old. What doesn't follow
      automatically is everything keyed to the OLD dataset id — CAQDAS coding, analysis
      runs (`datasetId` on each entry), `libraryLink`, and anything a plugin keyed
      itself. Build a tool that lists those references and offers to move them, with the
      honest caveats: coding segments anchor on `__ct_rid`, so they can only re-home
      where the row ids still match (a re-exported file usually re-bakes them) — offer
      match-by-key as the fallback; analyses just need their `datasetId` repointed and a
      re-run. Until it exists, the user re-does that work by hand.

- [ ] **#150 — Generalise the asset store beyond "media" (owner-tagged, plugin-
      enumerable). AFTER the #149 bugfix gate.** #149 A5 moved asset BYTES into the
      project and made the index a log tier, and the byte path is already generic:
      `media.load`/`media.put` are dispatched to **any** activated plugin with no
      gating (`plugin-broker.js`), and the `media: true` manifest flag only widens the
      sandbox CSP so an iframe can *render* a blob — it does not gate storage. A
      spatial plugin can already store a shapefile under the default `strict` cage,
      because reading a Blob's bytes isn't subject to CSP. What is NOT generic:

  - [ ] **Vocabulary.** `MediaStore`, `services.media`, a `medium` metadata field, a
        CSP capability named `media`. A boundary shapefile is not media. The on-disk
        directory and the op types already say `asset`; only the JS-facing names are
        inconsistent. Renaming is a **plugin API break** — batch it with the rest.
  - [ ] **No owner tag.** Assets are one flat content-addressed pool, unlike workspace
        blobs which are owner-namespaced for exactly this reason. Dedup across plugins
        is a genuine feature and must survive, so the owner belongs on the *reference*
        (who points at it), not on the bytes.
  - [ ] **Plugins can't enumerate.** `list()`/`missing()` are host-side; the broker
        exposes only `load`/`put`. A plugin managing reusable boundary sets needs to
        list its own assets.
  - [ ] **No reference tracking → no GC.** `removeAsset` is manual and nothing knows
        who still points at an asset. CAQDAS puts refs in a dataset string column;
        spatial would put them in a workspace blob; nothing scans either, so a deleted
        boundary set leaks its bytes.

      **Design together with [[first-class-plugin-data]]** (reusable boundary sets as
      building blocks) — an owner-namespaced, enumerable asset store is most of what
      that item needs, so designing them separately would mean doing it twice.
      **→ Now Layer 5 of #152**, which is where the fourth bullet (reference tracking →
      GC) becomes solvable at all: refs have to be host-visible before anything can count
      them, and that's what #152's item tier does.

      *Sequencing (checked):* none of this blocks a #149 item. The one real contact
      point is **C2's sweep** — key it on the LOG (delete files no live op references),
      which is owner-agnostic and stays correct after #150 adds ownership. The other
      contact is cosmetic: A5's remaining gap-fill work calls `MediaStore.missing()`,
      so a later rename touches it, which is churn rather than rework.

- [ ] **#152 — Plugin data on the one true log: items, universal memos, undoable plugin
      actions.** Consolidates three items tracked separately that are one lift: "Undoable
      plugin actions" (below), the deferred generalisation of memos (#148 step 3), and the
      tail of [[first-class-plugin-data]] + #150. All three are the same sentence said
      three ways: **a plugin's state is an opaque blob, so the host cannot identify,
      order, undo, merge, display, reference, or annotate anything inside it.**

      **What is already true (don't rebuild it).** #148 put the `ws:` tier ON the log:
      every workspace write is a `setWorkspace` op (`workspace-store.js:155`) that
      persists, exports, and merges. #146 gave blobs 4-D identity `(owner, wsId, slotId,
      dsId)` + sidebar management. #145 built verb dispatch. What's missing is *granularity*
      — the op's payload is the ENTIRE blob, so the log records "the coding workspace
      changed", never "KC added a memo on segment s1".

      **The finding that changes the cost estimate.** The objection recorded under
      "Undoable plugin actions" — *"the op-log is currently a tabular pipeline (`rederive`
      replays it into DuckDB); plugin ops would need to be replayable no-ops on the data
      side, i.e. the log stops being purely tabular"* — was written **before #148 and is
      now obsolete**. `DataStore` folds only its own slice (`#mine = owner === 'core' &&
      target.startsWith('ds:<id>/')`, `data-store.js:240`), and the log already carries
      four non-tabular tiers (`ws:`, `analysis:`, `asset:`, `project/name`). Plugin ops
      need **no `rederive` changes at all**. The stated cost of the decided option is gone.

  - **DESIGN — "collections + config", host-folded.** The host can't fold a schema it
    doesn't know, so the instinct is to have plugins ship a `fold`. Don't. Checked against
    the only real client: CAQDAS state is exactly **3 id-keyed collections** (`codes`,
    `segments`, `memos`) plus **2 LWW config scalars** (`textColumn`, `labelColumn`) and
    one transient (`pendingImport`) — `builtin-caqdas/index.js:1842-1904`. So the host
    defines the *model*, not the schema: a workspace's state is **named collections of
    id-keyed items** the host folds generically, plus a config blob that stays LWW.
    - **Spatial is deliberately NOT this shape, and that's the useful part.** Checked
      (`builtin-spatial/index.js:41-62, 523-535`): `spatial-map` is project-scoped with
      **one slot per boundary set** (slot id = file name), each slot holding
      `{keyProp, fileName, features}`; `spatial-link` is dataset-scoped config
      (`{dataColumn, shadeColumn, selected}`). Both declare `merge: {strategy:'lww'}` for a
      reasoned cause: *"you don't line-merge polygons"* — geometry is atomic, and slot-set
      add-wins already comes free from the host unioning slot keys. Spatial is therefore
      the **negative control**: it proves D2 (the blob path must survive) rather than
      exercising collections. Do not migrate its geometry to items.
    - Ops: `putItem {collection, id, fields}` / `removeItem {collection, id}` on target
      `ws:<owner>\0<wsId>\0<slot>\0<dsKey>\0<collection>\0<itemId>`; `setWorkspace` stays
      for config/singleton state.
    - **Merge becomes op-union** — no plugin merger. `mergeState`'s hand-rolled
      `addWinsSet` over three collections IS what op-union does for free, and
      `builtin-mergers.js`'s CAQDAS entry largely evaporates. Third-party plugins get
      correct merge instead of today's fall-back-to-conflict.
    - **Undo works generically** — retract a `putItem`. No plugin cooperation needed.
    - **History display works generically** — the host knows an item was added, by whom,
      and can render it without understanding what a "segment" is.
    - Fine granularity kills the 300ms debounced whole-blob rewrite
      (`builtin-caqdas/index.js:280`). Per [[one-true-log-explicit-ops]] a spammy log is
      the goal; only keystroke-level text editing coalesces (commit on blur/idle).
  - **Universal memos fall out of it.** A memo stops being a CAQDAS array and becomes a
    host-level collection whose anchor is **an op-log target string** — which is already
    the universal addressing scheme of the whole system. That yields, with no new
    addressing work: memo on a dataset (`ds:<id>`), on an analysis run
    (`analysis:<runId>` — "why did I run this", the audit-trail case), on a variable, on a
    plugin item (`…\0segments\0<id>` — today's CAQDAS memo), and on an op itself.
  - **#150 gets its refcount for free.** "No reference tracking → no GC" is unsolvable
    while refs hide in blobs. Once refs live in host-visible item fields (declared in the
    manifest), the host can scan them, and asset GC becomes the same log-keyed sweep as
    #149 C2. This is why #150 says design them together — confirmed, not assumed.
  - **Spatial is what makes #150 urgent rather than tidy — a NEW finding.** Spatial stores
    the entire GeoJSON `features` array *inline* in the workspace value
    (`index.js:526-528`), and since #148 a workspace value is an **op payload**. So a
    boundary set's full geometry is inlined in the one true log, serialised into
    `project.json`, carried in every bundle, and **copied again on every re-write of that
    slot** — with no size guard, and no compaction (by design: [[one-true-log-explicit-ops]]
    endorses a spammy log, but that was about op *count*, not megabytes per op). The
    plugin uses the asset store nowhere (zero `app.media` calls). GeoJSON bytes are exactly
    an asset: opaque, content-addressable, dedup-worthy. Moving them is what turns a
    boundary set into the reusable building block [[first-class-plugin-data]] has wanted
    since the start, and it is the concrete driver for Layer 5.
    - Spatial's honest item shape is thin: a `boundarySets` **registry** collection
      (`{id, keyProp, fileName, assetId}`), geometry in the asset store. The registry gets
      identity/undo/merge; the bytes stay atomic. That's collections and blobs each doing
      the job they're good at.
  - **Also unblocks:** `#146`'s remaining "building-block eligibility" (a slot's content
    becomes a log slice, so promoting one is a slice-and-copy), and the κ/α analysis
    (#148 step 4) which wants per-coder segments as queryable records rather than blob rows.

  - **Open decisions (need the user before Layer 1):**
    - **D1 — host-owned collection model vs plugin-supplied fold.** *Recommend collections*
      (above). The cost is that a plugin whose state isn't id-keyed collections must keep
      using the blob; the benefit is merge/undo/history/GC all become host-generic.
      **Argued, after the spatial correction raised "doesn't that divergence justify a
      fold?" — no, and spatial is the evidence against:**
      1. Spatial's shape is already served by a mechanism we have (slot-set add-wins +
         per-slot LWW bytes). A fold would give it nothing it lacks. The divergence shows
         **two mechanisms already span both clients**; the escape hatch for an exotic
         third-party shape is the blob path spatial already uses, so a fold would be a
         *third* mechanism covering a gap neither client demonstrates.
      2. A fold buys less than it looks like. Merge, undo, history and GC are functions of
         **op identity and shape**, not of folded state — op-union, retract-and-refold, an
         action label, and field-level ref visibility respectively. A fold hands back
         derived state and leaves all four unsolved. What unlocks them is *declared
         structure* (a manifest), not executable code across the sandbox boundary.
      3. **Decisive: a fold only runs when the plugin is activated.** The host would hold
         ops it can never interpret alone. Storage survives (we persist ops, not state) and
         so does merge-by-union — but asset ref-scanning, the History panel, memo anchors
         onto plugin items, the conflict dialog's "what changed", and building-block
         promotion all degrade to "activate that plugin first". `workspace-store.js:29-31`
         promises the opposite (preserve-on-missing-plugin), and today's merge degrades
         only to conflict-surfacing, never to unreadable.
      **The one case that would genuinely force a fold:** state derived by a non-trivial
      function of ordered ops — character-level co-editing of a memo body instead of LWW on
      the whole string. If we ever want that, the right shape is a **host-provided shared-
      text type** plugins opt into, not a per-plugin fold: a CRDT has to be correct, and
      three plugin authors shipping three of them is three chances to be wrong. Reopen D1
      only with a concrete client neither collections nor blob can serve.
    - **D2 — keep the opaque blob path?** *Recommend yes*, explicitly, for config and
      viewport state. Not everything wants identity, and forcing it produces fake ids.
    - **D3 — memo anchor shape.** A cell (`__ct_rid` + column) isn't an op target.
      *Recommend* a structured anchor `{kind, target, ref?}` rather than a bare string.
    - **D4 — orphaned memos.** When the anchor is binned/purged, does the memo die?
      *Recommend* memos survive, show as orphaned, and re-attach on restore (consistent
      with #149 A4: deletion is recoverable, purge is the point of no return).
    - **D5 — undo scope.** *Recommend* extending the C7 decision (#149) — one timeline,
      undo targets the highest live HLC regardless of tier — rather than a focus-scoped
      Ctrl-Z. `UndoCoordinator`'s data/analysis split then collapses instead of gaining a
      third case.

  **ORDER (user, 2026-08-03): 1 → 5 → 2 → 3 → 4.** Layer 5 bumped ahead of the memo work:
  spatial's inline GeoJSON is a cost being paid today, memos are a feature not yet missed.
  Save-breaking changes are fine through all of it — dev mode, and the handful of users
  know it.

  - [ ] **Layer 1 — the item tier (host-only, nothing uses it).** `putItem`/`removeItem`
        ops, generic fold, an `ItemStore` keyed `(owner, wsId, slotId, dsKey, collection,
        itemId)`, projection registered on `ProjectLog`. Headless tests: fold, undo,
        concurrent add-wins, delete-vs-edit. No UI, no plugin API, no migration.
  - [ ] **Layer 2 — universal memos, host-side.** A `memos` collection on the item tier +
        core UI on the two anchors the host already owns: a dataset (sidebar) and an
        analysis output block. Ships user-visible value with no plugin involved, and proves
        the tier. Validate the schema against CAQDAS's known memo shape on paper first —
        anchored, flat, chronological, author-stamped — so Layer 3 doesn't re-cut it.
  - [ ] **Layer 3 — CAQDAS migrates onto it.** codes/segments/memos become collections;
        the v4 blob one-time folds into items; `mergeState`'s add-wins deleted; CAQDAS
        memos become host memos. **The riskiest step** — the migration must be lossless and
        the QDPX round-trip must survive it. Undo + History for qualitative work land here.
  - [ ] **Layer 4 — plugin API.** Broker RPCs (`state.put`/`state.remove`/`state.items`),
        manifest declaration of collections + which fields are asset refs, `app.memos.*`.
        **Second-client check:** the collections model's two clients are host memos
        (Layer 2) and CAQDAS (Layer 3) — spatial does NOT exercise it. Two clients where
        one is host-owned is thinner validation than the verb interface got, so treat the
        API as provisional until a genuine third arrives, and don't freeze it early.
  **STATUS (2026-08-03).** Layer 1 DONE (`core/item-store.js`, 23 tests). Layer 4 DONE
  early — pulled forward because spatial cannot write a registry without it
  (`app.items.*`, owner-scoped `app.assets.list()`, broker + plugin-host namespaces).
  Layer 5 infrastructure DONE: media→asset rename, `core/asset-refs.js` refcounting with
  the abstain rule (14 tests), item tier wired through save/load/merge/purge, both ref
  scanners registered. **Remaining: spatial's own migration (5), Layer 2, Layer 3.**
  All headless; NOTHING browser-verified yet — the tier is inert until a client writes to
  it, which is the right moment to check persistence before there is data to lose.

  - **DESIGN (user, 2026-08-03) — THE SIDEBAR IS THE PROJECT'S INVENTORY.** The steer that
    reframes the "Map layers" question: map layers (and media libraries, and anything else
    a project holds) should sit in the sidebar *like datasets do*. The objection to plugin
    data living only inside the plugin was never about convenience — it was **loss of user
    visibility that "this project has data here."** So the fix is not to port one hardcoded
    section; it is to render the project's contents **generically** from the host's own
    registries, with no per-plugin special-casing. This is only possible post-#152: before
    the item and asset tiers the host could not enumerate plugin content at all, which is
    precisely why it was invisible.
    - **Consequence 1 — the manifest declaration I already shipped is the wrong shape.**
      `assetRefs: [{collection, field}]` was built for refcounting alone. A generic sidebar
      also needs a human LABEL for the collection and which field carries a record's
      display name (else the heading reads "boundarySets" and rename is impossible). One
      declaration should describe the collection:
      `collections: [{ id, label, labelField, sidebar, assetRefs: [field] }]`.
      Nothing depends on the old shape yet — change it before anything does.
    - **Consequence 2 — enumerate vs count.** Boundary sets are a handful, memos dozens,
      but CAQDAS segments run to thousands and would drown the sidebar. So `sidebar` is
      `'list'` (each record, renameable/deletable), `'count'` (one summary line, "Codes ·
      23"), or `'none'`. Proposed: boundary sets + memos `list`; codes + segments `count`.
    - **Consequence 3 — assets earn a section**, and refcounting is what makes it worth
      having: "Media · 14 files · 1.2 GB", plus "3 files nothing references" with a sweep
      action. That question was unanswerable before `findOrphans`.
    - Dataset-scoped collections nest under their dataset (as workspace blobs do today);
      project-scoped ones get their own section. Not new UX — the existing shape, made
      general.

  - [ ] **SEMANTIC CHANGE to weigh (#152 L3) — same-field concurrent edits stopped
        surfacing a conflict.** The old CAQDAS blob merger raised an `edit/edit` conflict
        when two coders set the SAME field of one code differently (classically: recoloured
        it two ways) and asked the user to choose. Item records resolve per FIELD by HLC
        instead, so the later write wins silently.
        *Why it was still the right trade:* the blob merger's conflict dialog resolved by
        DISCARDING one side wholesale, so two coders editing *different* fields of one code
        lost one of the edits. Per-field merge keeps both, which is strictly less lossy and
        the far more common case. What is genuinely lost is **visibility** when they collide
        on the same field — and a field holds one value, so something must give either way.
        *If we want it back:* route item ops through `threeWayLog` rather than the per-owner
        union in `collab-sync.mergeProjects` — but that reinstates whole-record
        discard-one-side, so it needs a conflict shape that is per-field, not per-op. Don't
        do it without that. Covered by a test in `test/caqdas-merge.test.mjs` that pins the
        current behaviour deliberately.

  - [ ] **DEFERRED (user, 2026-08-03) — are sidebar inventory rows interactive?** Map-layer
        rows render in the sidebar but aren't clickable; spatial switches layers with its
        own control inside its tab, which still works. Open question for after the
        migration: should an inventory row be clickable at all, and if so does the host
        define the behaviour or offer a **handle the owning plugin may react to** (a
        declared `onActivate` verb) — with "not interactive" a legitimate answer. Don't
        guess the interaction while the storage layer is still moving.

  - [ ] **Spatial migration (the Layer 5 client) — design settled, not yet built.**
        `boundarySets` items `{keyProp, fileName, assetId}` replace the per-set
        `spatial-map` SLOTS; geometry bytes move to the asset store; `spatial-link` stays
        a blob (config, dataset-scoped, LWW — correct per D2). Manifest gains
        `assetRefs: [{collection:'boundarySets', field:'assetId'}]`, which is what lets the
        host count the refs. Two write paths need it (`loadBoundaries` and the direct
        `app.state.write('spatial-map', …)` path), plus `wsLoadFromSlots`,
        `wsRebuildSetLinks`, `wsSaveState` and `clearBoundaries`.
        **Known regression to handle in the same change:** the sidebar's "Map layers"
        section lists project-scoped workspace BLOBS (`wsStore.listForDataset(null)`).
        Once spatial writes items instead, that section goes empty — it has to be ported
        to list items, or renaming/deleting a boundary set from the sidebar is lost.
  - [ ] **Layer 5 — #150 asset generalisation + spatial as its client.** media→asset
        rename (a plugin API break, so batch it here), owner on the reference,
        `app.assets.list()`, refcount GC scanning declared ref fields — then move spatial's
        GeoJSON out of the op payload into assets, leaving a `boundarySets` registry. This
        layer stands alone: it needs Layer 1's item tier for the registry, but nothing from
        Layers 2–4, so it can be pulled forward if log bloat starts to bite.

- [x] **Workspace ownership model → "read the world, write your own" (#145) — DONE.**
      *Decision (committed):* **activation = full trust**, so we stop pretending
      plugin workspace state is confidential. A dataset is already world-readable to
      any activated plugin; a coding blob is just derived data and shouldn't get a
      *stronger* secrecy class merely because it lives in a blob instead of a
      dataset column. The one guarantee worth keeping is **integrity**: a plugin can
      mutate only its own persistent state (blobs are the sole place plugins hold
      read-*write* state; datasets are read + additive-create, destructive commit is
      host-only). So ownership becomes **namespacing for integrity, not isolation for
      secrecy**.
  - [x] **Owner-keyed storage refactor — DONE.** Key workspace state by
        `(owner, wsId, dataset)` so a colliding `wsId` from a different author is a
        *different slot* — collision-safe and squat-proof by construction. Drop the
        fragile TOFU `#owners` map + `#mayAccess`; drop the null-bypass on the
        plugin `state.read`/`state.write` path (it silently defeated #89 — a
        same-id third-party could read/corrupt another plugin's blob). Reads scope
        to the caller's own owner (addressing default, **not** a claimed security
        barrier — cross-space read is an unbuilt convenience we don't preclude).
        Writes are own-only by construction. Persistence bumps to `__wsv:3`
        (owner-nested) with best-effort v2/flat migration (resolve owner from the
        declaring plugin; the only real legacy case is builtin `caqdas-coding`).
        Files: `workspace-store.js` (keying + `ownerToken` moves here), `app.js`
        (`workspaceRead`/`Write`, `applyWorkspaces` migrate), `workspace-manager.js`
        (get/set signatures), `plugin-manager.js` (deactivation purge), SECURITY.md
        reframe. *Superseded/extended by #146, which pushed the key to 4-D
        `(owner, wsId, slotId, dataset)` at `__wsv:4`.*
  - [x] **Space-verb dispatch interface — BUILT.** (Spatial workspace is the 2nd
        consumer.) The endgame from the design chat: the host should own a *shell*,
        not a merge vocabulary. A "space" plugin declares its own **verbs** (buttons)
        — the four we know (New/Append/Join/Merge) are just verbs a *tabular* space
        would declare; a different space might declare "stamp/stomp/strike/stare".
        The host renders declared verbs, routes a click to the plugin fn, and
        enforces only the **envelope**, never the meaning:
        - **Contract:** verb → real exported fn; writes only to its own space;
          typed return **envelope** `{ ok, message?, refresh? }` drives host refresh.
          Refresh vocabulary: `columns`, `dataset`, `output`, `workspace`.
        - **Inputs:** a verb gathers most inputs itself mid-run via `app.ui.*`. The
          one **irreducible** exception is a **picked file** — the browser's
          user-activation rule forces the host to open the file dialog *synchronously
          on the click* (see `import-service.js` header), so any file-consuming verb
          must **declare** `needsFile: { extensions }` up front. File-input is the
          host's only structural input concern; everything else is the plugin's.
          Optionally a verb may also declare `inputs` (the existing host-gathered
          variable-picker schema) for cases like column selection before running.
        - **Category controls placement:** `toolbar` (workspace tab toolbar strip),
          `import` (File ▸ Import picker), `export` (File ▸ Export picker), `menu`
          (top-level menu alongside analysis items). The host renders; the plugin
          defines meaning.
        - **Escape hatch:** anything the host shell can't present, the plugin
          presents **inside its own tab** (`workspace.mount` is a full realm) — so
          there's no ceiling, just a boundary routing each verb to whoever can render
          it.
        - **Reuse:** this is the existing declarative-action pattern (`label` +
          `inputs`, host-gathered + dispatched, scriptable via `run <id>.<fn>`)
          applied to spaces — not greenfield. The import dialog is the one hardcoded
          holdout to dissolve.
        - **Cross-owner "contribute" falls out of this.** B contributing into A's
          space = host mediates workflow + identity + consent, **A's own verb does
          the semantic merge on A's blob** (A stays sole writer). One interface,
          both features. The host can't blind-merge an opaque blob the way it
          SQL-joins a dataset — the owner must apply.
        - **Lifecycle hooks** (opt-in, safe fallback to remount if absent):
          `onDatasetChanged(app)` — the active dataset switched, space should re-read
          `app.state.get()` and re-render without a full iframe teardown.
          `onDeactivate(app)` — plugin deactivating, flush unsaved state.
        - **`menu` and `verbs` coexist.** Analysis plugins keep `menu`; workspace
          plugins use `verbs` for space-bound ops + optionally `menu` for standalone
          analyses (e.g. spatial plugin's Moran's I stays a `menu` item).
        - **Migration order:** (1) build schema, (2) migrate CAQDAS as first client
          (QDPX import/export → `category:'import'`/`'export'` verbs; toolbar buttons
          → `category:'toolbar'` verbs), (3) build spatial workspace as 2nd client
          (load-boundaries, shade-by-variable, export-map, clear-boundaries verbs),
          (4) refactor import picker to discover space verbs.
        - **2nd consumer: spatial workspace.** `builtin-spatial` gains a workspace
          tab (interactive boundary map, region checkbox selection, coverage audit).
          sf/spdep/spatialreg already work in WebR. Spatial filtering (point-in-polygon)
          is pure JS (Turf.js) for responsiveness; R reserved for statistical tests.
          No tile server — boundaries rendered from local GeoJSON, consistent with
          offline/privacy promise. Real-world users: PPA (constituent surveys by
          district), Public Health (screening by census tract), political orgs
          (precinct canvass coverage). Verb set is structurally unlike CAQDAS — validates
          the abstraction is honest.
        - **Spatial region-filtered analysis pattern:** the spatial workspace owns
          the filtering — it does point-in-polygon in JS (Turf.js), creates a
          **derived dataset** via `app.data.create`, and invokes analysis as a normal
          `run builtin-histogram.histogram` (or whatever) against it. The host never
          needs to know about spatial filtering; the verb returns
          `{ ok, refresh: 'dataset' }` and the user picks their analysis from the
          menu as usual. This means "filtered subset" is NOT an input type the verb
          schema needs to handle — it's an output the spatial workspace produces.
        - **Input shapes are sufficient as-is:** (1) file via `needsFile`,
          (2) own workspace state via implicit `app.state.get()`, (3) dataset
          columns via optional `inputs` array. No `hostProvides` or typed
          capabilities declaration needed.
        - **Cross-plugin invocation (#147) — BUILT.** A plugin can discover and
          run another plugin's analysis: `app.plugins.list()` returns active
          analyses (id, label, inputs), `app.plugins.onChange(cb)` fires when the
          active set changes, `app.run.analysis('pluginId.fn', { inputs })` runs
          through the host dispatcher (same path as do-file `run id.fn`). Inputs
          fully pre-filled skip the picker; missing required inputs show host
          dialogs. Spatial workspace uses this: "Analyse selection…" → filtered
          dataset → picker of available analyses → cross-plugin `app.run.analysis`.
- [ ] **CAQDAS cross-plugin invocation.** (Pulled out of #145 — a CAQDAS/#147
      concern, not the ownership model.) The coding workspace should be able to run
      analysis plugins on coded-theme subsets (e.g. run frequencies on all segments
      coded "anxiety"). Needs design thought on: does the derived dataset contain the
      coded text segments, the source rows, or a frequency table of codes? Different
      analyses want different shapes. The `app.run.analysis` plumbing is ready — this
      is a CAQDAS design question, not an infrastructure one.
- [ ] **Spatial workspace features (post-verb).** Pulled out of #145's space-verb
      item — these are `builtin-spatial` features, unrelated to verb dispatch.
  - [ ] **Layer tree in region selection column.** Display loaded boundary sets as a
        tree in the region-selection sidebar, so the user can expand/collapse layers
        and select regions within each.
  - [ ] **Point-in-polygon geocoding.** Given boundaries and a dataset with lat/long
        columns, assign each observation to the region it falls in (adds a region-ID
        column). Pure JS via Turf.js — no R needed.

- [x] **Plugin data as first-class citizens (#146).** *Built.*
      Workspace blobs promoted from opaque side-cars to host-managed, independently
      addressable objects. **Phase 1** (sidebar visibility) shipped earlier. **Phase 2**
      (first-class attachments) now complete:
  - **4-dimensional store:** `(owner, wsId, slotId, dsId)` — each workspace blob
    lives in a named **slot** chosen by the plugin. Spatial plugin stores each
    boundary set in its own slot (e.g. "us-counties", "voting-districts");
    CAQDAS uses the default `_default` slot unchanged.
  - **Plugin manifest `scope`:** `'dataset'` (default, CAQDAS — one blob per
    dataset) vs `'project'` (spatial — boundaries shared across datasets, stored
    with `NO_DS` sentinel). Host enforces scope — plugins don't need to care.
  - **Sidebar:** each slot appears as its own line, independently renameable via
    inline edit. Project-scoped blobs appear after all datasets.
  - **Plugin API:** `app.state.get(slotId?)`, `app.state.set(value, {slot?, label?})`,
    `app.state.list()`, `app.state.delete(slotId)`.
  - **Migration:** v3 → v4 lifts all existing blobs under `_default` slot; labels
    get a 4-part key. v2/legacy migrations chain through.
  - [ ] **Building-block eligibility** — a slot can be saved as a reusable
    building block (pending building-block contract expansion). *Waits on #152: once a
    slot's content is item ops, promoting one is a log slice rather than a blob copy.*

- [ ] **Undoable plugin actions — let plugins add actions to the history where
      appropriate. → FOLDED INTO #152**, which carries the design and the phasing; the
      history below is the decision record. NOTE the cost stated at the end of the DECIDED
      bullet is **obsolete post-#148** — see #152.
      Today the core transform op-log (`data-store.js #log`) is fully
      undoable/redoable, but **plugin actions are not** — e.g. CAQDAS "mark this
      passage with a code" writes straight to the workspace blob via a debounced
      `app.state.set()` (`builtin-caqdas` ~L245), so it never enters the undo stack.
      A coder can't Ctrl-Z a mis-code, and the History/do-file panel doesn't show
      qualitative work at all. Want plugin actions to participate in history where it
      makes sense. **DECISION (2026, deferred to when we tackle it): option 3 — the
      "principled fix" — plugin actions join the MAIN core history/op-log (the first
      shape below), NOT a separate per-plugin undo stack.** Chosen so there's ONE undo
      timeline and plugin ops get op-identity + merge treatment for free (composes with
      #143/#148). Confirmed while building #148 memos: notes + all CAQDAS coding write to
      the workspace blob and so escape Edit▸Undo — the concrete driver for this. Kept as a
      tracked gap; not scheduled yet.
  - *[DECIDED] Plugins add each action to the **main** history* — one unified undo timeline the
    user already knows; the action shows in the History panel alongside recodes; and
    it would **compose with the collaboration work** (#143) — a logged action gets a
    stable op id + merge treatment for free, instead of the whole blob merging as one
    opaque unit. Cost: the op-log is currently a *tabular* pipeline (`rederive`
    replays it into DuckDB); plugin ops would need to be replayable no-ops on the data
    side that instead re-drive the owning plugin's state, i.e. the log stops being
    purely tabular.
  - *Plugins maintain their **own** history* — a per-plugin undo stack the workspace
    owns; simpler blast radius, no changes to `rederive`, but a second undo model the
    user has to understand (whose Ctrl-Z am I in?) and it doesn't unify with the main
    timeline or the merge op-log.
  - *Open questions:* granularity (every keystroke vs. per-coding-action); does a
    global Ctrl-Z reach into whichever surface is focused; how it interacts with the
    debounced blob-save; and whether the add-wins merge already makes fine-grained
    coding-op identity worthwhile. Ties to [[dofile-editor]], [[plugin-verb-declaration]],
    and the op-identity work in [[collab-merge-kernel]].

- [x] **Build and prove the DuckDB-WASM data engine — FOUNDATIONAL — DONE.**
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
  - [x] **Ingest path for large/real data — DONE.** Three Arrow-based tiers, all
        wired to importers: small one-shot (`replaceTable`), out-of-core streaming
        (`beginStreamIngest` → OPFS Parquet parts → CTAS), and ultra-wide
        (`openParquetWriter`/`registerParquetFile`, JS Parquet encode). Explicit
        column typing closes the leading-NULL mis-infer risk — the streaming path
        builds the Arrow schema from `types` (not inferred), and even `replaceTable`
        is fed metadata-typed arrays via `coerceColumn`. **Verified with a real
        4.6 GB GSS `.sav` import.** (`.arrow`/Feather *file* import is deliberately
        NOT built — Parquet covers the columnar-file case; Arrow stays an internal
        interchange format only. Trivially codec-addable later if demand appears.)
  - [x] **Vendor + pin DuckDB-WASM + Arrow — DECIDED AGAINST.** Keep pulling the
        current versions live from CDN; not worth the long-term maintenance of
        vendoring what we don't have to. (Air-gap mode already serves from
        `./vendor/` when self-hosted — that path stays available for offline use.)
  - [x] **iPad Safari** run of the whole engine (Milestone 3) — **DONE**, verified
        working on iPad and iPhone.
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
    iPad Safari run of the same path is also **verified** (works on iPad + iPhone).
  - ~~**Vendor + pin** the DuckDB-WASM build and its worker/WASM assets.~~
    *Decided against* — keep pulling current versions live from CDN (not worth the
    maintenance); air-gap mode still serves `./vendor/` when self-hosted.
  - Blocks/feeds: **File import** (DuckDB reads CSV/Parquet natively, which
    reshapes that task), **SPSS-style data grid** (virtualised grid backed by
    `LIMIT/OFFSET` SQL windows over DuckDB — a natural fit), **Data
    transform/recode API** (becomes SQL / `CREATE TABLE AS`). Settle the
    `getDataFrame`/`getColumns` contract here so those don't get reworked later.
- [ ] **Verify CAQDAS import/export round-trip + legacy-project load.** Runtime
      regression check (not tied to any one code change): confirm a CAQDAS coding
      project exports and re-imports losslessly (QDPX / project bundle), and that an
      older-format saved project still loads and hydrates its coding state. Exercises
      the workspace-store migration chain (legacy → v2 → v3 → v4) end to end in the app.
- [x] **Add a committed dev server for contributors — DONE.**
      `scripts/dev-server.mjs` (zero-dependency Node) serves the repo root with
      COOP `same-origin` + COEP `credentialless` + CORP `cross-origin`, correct
      `.js`/`.mjs`/`.wasm` MIME types, and `Cache-Control: no-store`. Wired as
      `npm run dev`; README updated to use it instead of `python -m http.server`.
      This is the same server we use for internal Chrome testing — dogfood it.
- [x] **Add a `LICENSE` — DONE.** Released public-domain under the **Unlicense**
      (#137); `vendor/readstat/` noted as MIT.
- [x] **Provide the PWA icons — DONE.** `vendor/icon-192.png`, `vendor/icon-512.png`
      (+ `icon-180.png` Apple touch) exist and are referenced by `manifest.json`.

## Hardening before any public/shared deploy

> **#89 hardening pass — DONE (see [docs/SECURITY.md](docs/SECURITY.md)).** Full
> exploit audit + 4 fixes shipped (stored-XSS on project open, plugin-name XSS on
> fork, per-origin `web.get` consent, workspace-state ownership) and a dead-code/
> stale-comment cleanup. Threat model + by-design decisions (#5/#6/#7) + accepted
> residual risks recorded there. The items below are remaining *defence-in-depth*
> upgrades, not blockers: the sanitiser audit found **no confirmed bypass** (DOMPurify
> stays a nice-to-have), the WebR-pin/vendor item is the accepted runtime-integrity
> decision (#9 — vendor-from-own-origin at deploy, no hash babysitting), and shell
> PWA precache already shipped (#92).

- [ ] **Make `"plugin sandbox did not become ready in time"` impossible (after #148).**
      This mount-handshake timeout has haunted the project for a long time — kill the
      whole error *class*, don't just retry it. Root cause: `WorkspaceManager.#handshake`
      / `PluginBroker.whenReady` race a wall-clock `setTimeout` against the sandbox iframe
      posting `ready`, but a **backgrounded/occluded window throttles `setTimeout` and
      pauses rendering** (Chrome Native Window Occlusion — see [[local-testing-setup]]),
      so the ready signal misses its window and the mount "fails" even though nothing is
      actually wrong. It bit hardest in two-window co-authoring, where the non-focused
      peer's workspace remounted on every sync (that specific trigger is now gone — sync
      refreshes in place via `onRefresh`, #148 — but the *timeout* itself must stop being
      reachable). Directions (pick what holds up): (a) don't fail on a timeout at all —
      **wait for readiness as an event, retry with backoff indefinitely, and (re)start the
      handshake on `visibilitychange`→visible** so an occluded tab simply mounts when it's
      next shown; (b) make readiness not depend on a throttled timer (the ready ping is a
      `postMessage`, which is NOT throttled — so the failure is purely the host-side
      timeout giving up; a message-driven wait with no hard deadline may be enough); (c)
      surface a calm "waiting for this tab to come to the foreground" state instead of a
      scary "failed to mount" error + retry overlay. Acceptance: a workspace never shows a
      mount-failure overlay due to being in the background; it mounts (or resumes) cleanly
      once visible. Touches `core/workspace-manager.js`, `core/plugin-broker.js`, maybe
      `core/plugin-sandbox.js`.

- [x] **Replace the HTML sanitiser with DOMPurify — DEFERRED (won't vendor).**
      *Decision:* keep the hand-rolled allowlist (`core/sanitize-html.js`); do **not**
      adopt DOMPurify. Rationale: adopting it means **vendoring a security library**
      (it runs on every plugin result incl. offline/air-gap, so it can't be lazily CDN-
      loaded — it must always be present), which is exactly the lifelong pin-and-CVE
      maintenance burden the project deliberately avoids. The residual risk is small and
      accepted: the declarative API shrank the surface to **plugin plot SVG only** (a
      constrained drawing subset — tables are host-rendered from data, notes are escaped
      markdown), the allowlist is hardened (no `on*`/URL attrs, `style` value-filtered,
      size-capped), and the **#89 audit found no confirmed bypass**. Consistent with the
      security-no-theatre / no-needless-vendoring stance (see docs/SECURITY.md). Revisit
      only if a real bypass surfaces.
  - *Separable, still-open (NOT a dependency — no vendoring):* a **host-page CSP**
        (tuned around the WebR/DuckDB CDNs + blob workers) as cheap defence-in-depth, so
        even a sanitiser miss can't execute in the host. The plugin *sandbox* CSP is
        already in place; this is just the host document. Its own small item, unaffected
        by the DOMPurify decision.
- [x] **Pin the WebR version — DONE; vendoring decided against.** The CDN default now
      pins **WebR v0.6.0** (`core/assets.js`: `webrUrl` + `webrOptions.baseUrl` both on
      `…/v0.6.0/`), matching the already-pinned DuckDB/Arrow/hyparquet — so a silent
      WebR release can't shift R results under us. Pulled live from the CDN, **not
      vendored** (consistent with the DuckDB decision — don't vendor what we don't have
      to). **Verified in Chrome:** WebR loads its payload from the versioned baseUrl and
      runs R 4.6.0 (`mean(1:5)=3`). *Vendoring capability still exists* for the opt-in
      air-gap deploy (`./vendor/` via `scripts/vendor-assets.mjs`, which records the
      grabbed version). Bump the pin deliberately when adopting a new WebR.
- [x] **PWA precaching — DONE** (stale framing: it never needed vendoring). `sw.js`
      already does a two-tier cache (#92): the same-origin app shell is precached on
      install + cached-on-use; the cross-origin runtimes (WebR/DuckDB/Arrow/hyparquet)
      and R-package binaries cache-on-use from the known runtime hosts, served
      cache-first. Verified in Chrome: after one warm run the SW cache holds **197
      entries / ~117 MB** — full WebR runtime, 48 R-package files, DuckDB/Arrow, and the
      app shell. **Fixed a real bug:** the page-side `core/offline.js` was pinned to
      cache name `crosstab-offline-v1` while the SW had moved to `v3`, so `status()`
      reported 0 (looked like "nothing is happening"), `disable()` deleted the wrong
      cache, and the marker was written where the SW never looks. `offline.js` now
      resolves the live `crosstab-offline-*` cache by prefix — skew-proof against future
      SW cache-name bumps. (True offline *serving* not automation-tested — can't cut the
      network in the driver — but the cache is correctly populated and the SW serves it
      cache-first.)

## Open questions / decisions to make

- [x] **API version mismatch → warn-and-allow — DONE.** No shims, no hard break: a
      plugin whose `apiVersion` differs from the engine (different major, or a newer
      minor) **still loads** — the loader classifies it (`apiCompatStatus` →
      `ok`/`older`/`newer`, `core/loader.js`) and activates anyway, recording the level
      on the plugin record (`loader.apiCompat(id)`). The plugin manager renders a red
      **⚠ old API / ⚠ new API** badge with a "Built for a different version of CrossTab
      — may not work correctly" tooltip. A call into a genuinely-changed/removed API
      just errors at runtime, sandbox-contained. A *missing/malformed* apiVersion stays
      a hard error (invalid manifest). **Verified in Chrome:** a builtin bumped to
      apiVersion `1.0.0` loaded, ran normally, and showed the red `⚠ new API` badge —
      only on that plugin.
- [x] **R package pre-loading — DECIDED: keep on-demand.** Don't pre-declare a
      "preload" set — we won't guess which packages matter enough to warm speculatively,
      and heavy ones (Stan/brms, lavaan) risk the WebR ~4 GB ceiling. Packages install
      on demand when an analysis first runs (the "installing…" watchdog progress already
      covers the wait); the "Make available offline" toggle prefetches the dependency
      closure for offline use. Revisit only if on-demand latency becomes a real
      complaint. The `bit64` sub-decision below stands.
  - *Decided: `bit64` is install-on-demand, not default.* int64 columns are
    carried as **character** by default (storage stays native `BIGINT` in DuckDB;
    R has no native int64 — see the data-engine item). `bit64::integer64` buys
    nothing for storage/transport/display (JS `Number` hits the same 2⁵³ wall),
    so it's only worth loading for genuine 64-bit *arithmetic in R* — a per-
    variable opt-in to add later, purely additive, no debt from deferring.
- [ ] **Multi-file plugins via import maps (decided approach; to build).** Let a
      plugin's *code* span several ES modules with normal relative imports
      (`import { foo } from './util.js'`). **Chosen: import maps, not bundling** — no
      build step (fits the no-tooling / everything-inspectable ethos), and it reuses the
      `.ctplugin` bundle plumbing (#119). Mechanism: the host creates a `blob:` URL per
      module file the plugin ships and injects an **import map** into the sandbox
      document mapping each relative specifier → its blob URL, so `import './x.js'`
      resolves inside the opaque-origin sandbox. *Why it's needed:* today the entry
      module is a single blob-imported file (relative imports don't resolve against a
      blob origin); a `.ctplugin` bundle already carries multiple **asset** files
      (fetched by name via `app.*.loadAsset` → `resolveAsset`), but those are *data, not
      importable modules* — this closes exactly that gap. *Build:* a manifest way to
      list the module files, per-file blob creation in `core/loader.js`, and import-map
      injection in `core/plugin-sandbox.js`.

## Deferred features (intentionally not built yet)

- [ ] **Online collaboration — async (folder-backed) + live (P2P) (#143).**
      Recurring faculty ask; keeps coming back. Two features people picture as
      separate — "put my project in a OneDrive folder" and "two of us edit at
      once" — are really *one* build wearing two hats. **The load-bearing piece is
      neither OneDrive nor WebRTC; it's making the op-log mergeable.** Live-sync and
      folder-sync are just two *transports* over that foundation.
  - **The foundation — a mergeable op-log (the real project). [~] STARTED** —
    `core/merge.js` + op identity in `core/data-store.js` shipped on branch
    `feat/collab-merge-kernel`, 13 headless tests (`npm test`). Done so far:
    (1) every `#log` op carries a **stable id** (deterministic content+index id for
    pre-collab legacy saves so they stay mergeable; random for new ops), persisted
    in export/restore, undo/redo-safe; (2) the pure merge kernel — `threeWayLog`
    (core tabular class), `addWinsSet` (CAQDAS codebook), `lww` (spatial slot bytes),
    and `mergeProject()` which **dispatches each state class to its owner's declared
    merger** and aggregates conflicts across tiers. **Key architecture decision (from
    design chat): the engine coordinates, the *owner* defines "merge"** — a plugin
    declares `manifest.merge = { strategy }` or exports a `merge()` fn; core is just
    the owner of the tabular class (so its three-way merge isn't a kernel exception).
    The #145/#146 integrity model contains an untrusted merger to its own blob, which
    is what makes delegating merge *meaning* safe.
    **CAQDAS + spatial builtins now declare their merge** (commit be8200a): caqdas
    exports a custom `mergeState` (composite blob — `merge:{via:'mergeState'}`,
    codes/segments add-wins + config LWW; the "two coders on the same transcripts"
    Dedoose case is a passing test); spatial declares `merge:{strategy:'lww'}` per
    slot (add-wins slot set + LWW bytes). 19 headless tests, all green, incl. the
    real caqdas merger imported from the plugin. *Still open:* stored common-
    ancestor marker (a transport concern — the merge fn takes ancestor as an arg
    today); wiring `mergeProject` into a real transport (incl. the tiny glue that
    resolves a manifest `merge.via` string → the module's exported fn); dependency-
    aware op ordering (MVP appends mine-adds then theirs-adds); the host conflict-
    resolution UI; **in-browser check of the op-id persistence path** (syntax-checked
    only — DuckDB path can't run headlessly). See [[collab-merge-kernel]].
    The transform log
    (`core/data-store.js`, op types at ~L149–153: `load/append/join/setVariable/
    setCell/computeVar/recodeVar`) is a **dependent pipeline**, not a bag of
    commuting changes — each op folds onto the accumulated result of the prior ones
    (`(sql) UNION ALL BY NAME (…)`, joins resolve columns against the `byName` map
    built so far, recodes read earlier-derived vars). So you **cannot** drop a CRDT
    (Yjs/Automerge) over the whole thing: if A renames a var and B concurrently
    recodes reading the old name, "union the op sets" yields a pipeline that won't
    run — a *dependency* conflict, not a merge conflict a CRDT resolves. Conflict
    resolution therefore splits **per class of state**, and only one class is hard:
    - *Transform pipeline* — **git-style three-way merge**: common ancestor + replay
      each side, auto-merge provably-disjoint ops, and **surface** genuine collisions
      / broken dependencies to the user. **No silent auto-merge here** — not just on
      effort but on principle: a wrong silent merge in a stats tool doesn't crash, it
      produces plausible numbers that feed a published finding. Faculty vastly prefer
      being asked ("you and Pat both edited `income_recode` — keep yours / theirs /
      see both"). This is also the cheapest correct MVP: detection + user resolution
      ships long before any clever auto-merge.
    - *Variable metadata* (`setVariable {name, patch}`) — per-field last-writer-wins;
      commutes across different variables. CRDT-easy.
    - *CAQDAS codebook* (the opaque workspace blob, `core/workspace-store.js`) —
      set-like codes → add-wins CRDT. **This** is where Yjs actually earns its keep.
    - *Output* — regenerable; union or replace.
    - **The primitive that unifies both transports:** give every op a **stable id**
      and record a **common ancestor** (last op both sides agreed on). Then folder =
      three-way merge of two divergent files; live = the *same* three-way merge run
      continuously. Same algorithm, different clock.
  - **Async transport — folder-backed projects (FSA). [x] DONE + VERIFIED LIVE**
    (branch `feat/collab-merge-kernel`). Shipped end-to-end and confirmed with **two
    real Chrome windows co-editing a shared local folder**: File ▸ Move project to a
    folder… / Open project from a folder… / Close project folder; one-gate passphrase
    (set for a fresh folder, enter for an encrypted one); autosaves route through the
    merge-aware `syncFolderProject`; a 3s poll pulls peer writes (backs off when
    hidden); conflicts via `showConflictDialog`. On-disk everything is ciphertext bar
    the plaintext salt/verifier. Bidirectional variable-recode merge, **step-reorder
    merge**, rapid-edit debouncing, and idle quiescence all verified. Four real bugs
    that live-testing caught (headless tests had missed) were fixed + regression-tested:
    write-storm (undefined-key JSON asymmetry), two-window ping-pong (canonical operand
    order), clobber/"A owns it" (per-peer base, not a shared `project.base.json`), and
    reorder-not-synced (three-way-merge the step order). 93 headless tests.
    *Remaining (NOT folder-sync):* recipient import-side decrypt of a `.enc` export;
    live P2P 2-machine test + invite/presence UI; OPFS opt-in toggle + settings;
    chunked-Parquet crypto. Original foundation notes kept below.
  - **Async transport — folder-backed projects — foundation notes.** Commit 7e8cdb8. Done: the FSA **seam** —
    `ProjectStore.useDirectory(handle)`/`folderBacked`, `#root()` now parameterized
    around an injected picked-folder handle (falls back to OPFS); op `id` threaded
    through source save/load; `readManifest()` (cheap stat+parse for change-detection
    / reading "theirs"), `readBase()`/`writeBase()` (the `project.base.json`
    common-ancestor snapshot). Plus **`core/collab-sync.js`** — the project-level
    three-way merge (`mergeManifests`): per-dataset op-log three-way (add-wins the
    dataset *set* — never drop data), owner-dispatched workspace-leaf merge,
    `buildMergers` resolving each plugin's `merge` (strategy or `via`→exported fn),
    one aggregated dataset-tagged conflict list. 9 headless tests (28 total).
    **Orchestration + handle-persist now DONE too** (commits fd66f7d, 90fd138):
    `core/folder-sync.js` — `decideSync` (seed/in-sync/push/merge) + `syncOnce`
    (read theirs+base → decide → write manifest+base); `ProjectStore.writeManifest`
    with atomic temp+`move()` rename (`#writeAtomic`, torn-read-safe);
    `core/folder-handle.js` — IndexedDB persist of the picked dir handle +
    `ensureReadWrite`. **34 headless tests + VERIFIED IN-BROWSER** against real OPFS
    File System Access I/O (OPFS dir as a stand-in shared folder): a peer's on-disk
    edits + local edits three-way merge (dataset op-log + caqdas codebook via the
    real `mergeState`), 0 conflicts on disjoint edits, atomic write leaves no `.tmp`,
    base updated to merged; dir handle round-trips IndexedDB as a live handle. Op-id
    persistence path also verified end-to-end through real DuckDB.
    **Conflict resolution now DONE too** (commit 4c22509): merge is a pure function
    of user choices — every conflict carries a stable key, and feeding a `resolutions`
    map (key→mine/theirs/both) back re-runs deterministically to 0 conflicts (threaded
    through the whole kernel + `mergeManifests` + `syncOnce`, which withholds the write
    until conflicts are resolved). `core/conflict-ui.js` renders the "keep yours /
    theirs / both" modal. Resolution even reaches *inside* the caqdas custom merger
    with no plugin change (resolveMerger pre-binds the ctx into its helpers). 40
    headless tests; VERIFIED IN-BROWSER (2 conflicts → form → flip → re-merge → clean).
    **The full app sync flow is now DONE too** (commit feaf9c1): `syncFolderProject`
    — land my Parquet (`writeSourcesOnly`), build my manifest (`buildManifest`,
    extracted from `save()` so save & sync never drift), read peer+base, merge,
    resolve via a callback, write merged+base atomically, reload only when a peer
    contributed. 44 headless tests; VERIFIED IN-BROWSER against real OPFS (peer+I
    edit income → conflict → resolve → merged reloads). So the **entire reusable
    engine** — kernel → clients → project merge → folder sync → conflict UI → app
    flow — is built, tested, and in-browser-verified.
    *Genuinely all that's left is the "clickable" layer, and ALL of it needs a MANUAL
    folder pick to verify (`showDirectoryPicker` is an OS dialog CDP can't drive) — so
    it's a LOCAL-session job:* (1) the File-menu **"Open folder…"** button
    (`showDirectoryPicker` → `useDirectory` + `saveFolderHandle` → save/load there);
    (2) **hook `project-sync.js`** to route folder-mode saves through `syncFolderProject`
    (bundle from `#snapshot`, `resolveConflicts` = `showConflictDialog`, `applyMerged`
    = re-open) instead of blind `store.save`; (3) a **poll loop** (`readManifest` mtime,
    backoff when hidden) that syncs on peer change; (4) **IndexedDB handle restore** on
    boot (reconnect via `ensureReadWrite`). See [[collab-merge-kernel]]. Original plan below.
    `core/project-store.js` is *already* written entirely against
    `FileSystemDirectoryHandle` (`getDirectoryHandle`/`getFileHandle`/
    `createWritable`/`getFile`); the **only** OPFS-specific line is `#root()` at
    `project-store.js:244` (`navigator.storage.getDirectory()`).
    `showDirectoryPicker()` returns the *identical* handle type, so:
    - Parameterize `#root()` to take an injected picked handle, falling back to OPFS.
    - Persist the handle in IndexedDB (handles are structured-cloneable); re-grant
      write via `requestPermission()` once per session (browser won't give silent
      persistent write to a user folder — one click, unavoidable).
    - **OneDrive sync itself is free**: CrossTab does plain local file I/O, the
      OneDrive *desktop client* mirrors the folder to the cloud. No Graph, no OAuth,
      no CrossTab cloud code. **Provider-agnostic** — Dropbox / Google Drive / iCloud
      folders are the identical mechanism. The `writeSourcesFor` cheap-save
      (`project-store.js:101`, rewrites `project.json` + only the changed dataset's
      Parquet) is already sync-client-friendly (no gigabyte re-uploads per edit).
    - **Costs:** Chromium **desktop only** (`showDirectoryPicker` absent in Firefox /
      Safari / **iPad Safari**); needs the desktop sync client installed; good for
      *sequential* use (laptop ↔ desktop, or close-then-hand-off) but **simultaneous**
      open → OneDrive drops `project-DESKTOP-xyz.json` conflict copies (it syncs
      files, not op-logs) → that's the doorway back to the live layer.
    - **Change detection — watch the manifest, not the folder.** FSA gives **no change
      events** (no `onchange`, no watch) in its baseline, so polling is the floor — but
      "scan the folder every second" is wrong on both axes:
      - *Wrong granularity.* `project.json` already rewrites on every save and already
        indexes every dataset (`project-store.js:16-18,143`), so watching **that one
        file** covers adds/removes/edits. `getFileHandle('project.json') → getFile()`
        exposes `.lastModified`/`.size` — a **stat, not a read**. When mtime moves, *then*
        parse it, diff the manifest, and fetch only the Parquet sources whose entries
        changed (ties to the content-hashed index above). No directory walk.
      - *Wrong rate.* The **sync client's latency (seconds–minutes) is the real floor**,
        not the poll rate — 1 Hz just spins waiting for bytes the client hasn't landed.
        Poll ~2–5 s while focused, **back off when the tab is hidden** (Page Visibility),
        and **poll-now right after a local save** (when a reply is expected).
      - *Two levers beyond a dumb timer:* (1) **`FileSystemObserver`** — emerging Chromium
        API giving real change callbacks on FSA handles; use as progressive enhancement,
        poll as universal fallback (**verify current availability** — new, uneven). (2)
        **Trystero beacon as a "look now" nudge** — when both are online, an "I just
        saved" ping means network says *look now*, filesystem delivers the bytes; near-
        instant without fast polling, degrades to the timer when the beacon can't connect.
      - *Sync-client gotchas:* **torn reads** (may read a half-written `project.json` mid-
        sync → `JSON.parse` throws) → write **atomically (temp + rename)** and
        **tolerate-and-retry** next tick rather than treating a parse failure as
        corruption. **Conflict-copy filenames** (`project (conflicted copy).json`) are
        themselves an after-the-fact concurrency signal → the doorway back to live.
  - **Graph mode — to include iPads (wanted).** Because `showDirectoryPicker` doesn't
    exist on iPad Safari, the folder route can't reach tablets. **Microsoft Graph /
    OneDrive REST** works without the desktop client and *on iPad/mobile*. Cost:
    OAuth + Azure app registration + token refresh + network handling, and it's
    OneDrive-specific — reintroduces some backend coupling. Design it as a
    **pluggable storage backend** so FSA-handle and Graph are two implementations
    behind one seam (`project-store` root), and a future Google Drive / Dropbox API
    backend slots in the same way. Only reach for Graph where iPad/mobile is the hard
    requirement; on Chromium desktop the free folder-handle route stays strictly
    better.
    - **Same model, REST driver.** Graph isn't a distinct collab mode — it's the *same*
      async folder-backed model with an HTTP driver: identical `project.json` + Parquet
      layout in the same OneDrive, reached via `GET/PUT …/content` (small files simple
      PUT, large Parquet via resumable **upload session**) instead of
      `getFile`/`createWritable`. The cheap-save maps directly.
    - **Change detection beats the folder route:** **delta query** (`/delta` + token →
      server-computed diff, poll the *diff* not the files) and **ETag `If-Match`
      compare-and-swap** (a `412` on write = detected collision → route into the
      three-way merge, instead of OneDrive's silent conflict copies). But **webhooks
      need a public HTTPS endpoint** a browser-only app lacks → for serverless CrossTab
      the practical path is **delta polling, not webhooks**. Graph still only signals
      "the *file* changed," never "someone has it *open*" → presence stays on the beacon.
    - **Auth decision — own registration + device-code UX; borrowed first-party
      client-id rejected.** The tempting shortcut (device-code flow against a well-known
      pre-consented Microsoft client_id — Azure CLI / Office / Graph-PS — so *no* app
      registration) is **rejected**: (1) Microsoft is actively closing it, and tenants
      lock-down enough to block **device code flow via Conditional Access** are exactly
      our university targets — it trips the same wire it was meant to dodge; (2) consent
      screen + sign-in logs show the *borrowed* app ("Azure CLI"), not "CrossTab" — an
      audit/IRB-integrity problem for human-subjects data; (3) we don't own it, can't
      scope it, likely violates MS terms. Crucially it **doesn't escape the hard case** —
      a tenant needing admin consent / blocking device-code blocks the borrowed app too.
      So: **register our own Azure app** (free, one-time, stable id we control, correct
      "CrossTab" naming, exact scopes) — the cost was always *admin consent*, not the
      registration — but **keep the device-code *flow*** ("pop a short code, log in on
      MS's page, poll for the token"; MFA/CA handled by Microsoft) with *our* client_id
      for the same no-redirect ergonomics. Public client → **auth-code+PKCE or
      device-code**, `offline_access` for refresh.
    - **Invitation is half OneDrive's ACL.** Multi-user needs the folder actually
      *shared* between accounts (OneDrive share, or a SharePoint/Teams library both
      reach via `/me/drive/sharedWithMe` or the shared drive id) — so onboarding is half
      CrossTab's invite-key, half Microsoft's sharing dialog; reconcile with the live-
      mode self-contained invite when unifying modes.
  - **Vendor-neutral cloud-API family — Dropbox & Google Drive are peers, not
    afterthoughts.** Two corrections to "Graph = *the* tablet story": (1) the
    `showDirectoryPicker` gap is **not iPad-specific** — Android Chrome and mobile
    browsers generally lack the FSA directory picker too (**verify current support**), so
    *every* tablet/phone needs *a* cloud API regardless of vendor; **Chromebooks** are the
    edge case (Chrome OS is desktop Chrome → folder mode works), but a third-party cloud
    folder isn't always mounted as a pickable local dir there, so the API may still be the
    path. (2) Provider choice is the **user's**, not ours — Dropbox and Google Drive are
    **peer backends**, not OneDrive-with-an-asterisk (the storage analog of format-equality
    / no-lock-in: don't privilege one vendor). The seam makes it cheap: **device** decides
    you need a cloud API, **the user's provider** decides which driver — all three sit
    behind `project-store` root as near-identical drivers (OAuth2 + PKCE, `GET/PUT`
    content + chunked upload, a delta/cursor change feed, rev/ETag conflict detection), so
    build the *interface* once and vendor-neutrally, adding drivers as real demand appears:
    - *Dropbox* (App Console reg): **friendlier to a serverless browser app** —
      `list_folder/longpoll` waits for changes with **no public endpoint** (vs Graph
      webhooks) and a **server-provided `content_hash`** partly hands you the shared-index
      primitive. Downside: **no device-code flow** (redirect/popup PKCE only).
    - *Google Drive* (Google Cloud reg): natural for **Chromebook** users; `changes.list`
      + page tokens for delta, push webhooks need an endpoint (→ poll), OAuth2 + PKCE —
      same shape as the others.
    - *No shared/borrowed id across providers* — each is its own one-time registration
      (the borrowed-client-id trap was Microsoft-specific and rejected anyway). But
      **desktop users of any provider need none** — the desktop sync client + folder mode
      already covers them (Dropbox/OneDrive/Drive/iCloud folders are identical to FSA).
  - **Live transport — P2P over WebRTC (proven pattern, from sortie). [~] SIGNALING
    LAYER BUILT** (commit 20d6427): `assets.js` pins trystero@0.21.5 (MQTT), lazy-loaded;
    `core/live-invite.js` (rendezvous addressing = hashed-UUID topic + invite secret in
    the URL fragment); `core/live-sync.js` (`LiveSession` wrapping a Trystero room —
    presence + beacon + ordered/reliable op-log actions — plus `buildIceServers` /
    get·setTurnConfig). 58 headless tests; in-browser verified the pinned lib loads +
    TURN config threads. *Still to build:* the op-log WIRE PROTOCOL over the channel
    (snapshot-then-tail late-join, gap detection — convergence reuses the mergeable
    op-log), and the presence/invite UI. *Verification boundary:* the actual peer
    CONNECTION is a 2-machine/2-network + reachable-broker test (Trystero filters
    same-page selfId → un-testable in one tab), user-gated like the OS picker.
    **[~] CONVERGENCE PROTOCOL + PRESENCE now BUILT too** (commits 8202ebc, 0eb4065):
    `core/live-protocol.js` `LiveDoc` runs the same three-way merge continuously over
    the channel — commutativity solved by canonicalising operand order by peer id (no
    kernel change); late-join = same `state` message (empty joiner add-wins to full);
    conflicts SHARED via a `resolve` message so peers don't re-surface them; full-
    manifest exchange sidesteps per-op gap detection. `core/presence.js` `PresenceRoom`
    = pure "who's here" roster. Glue: `attachLiveDoc` / `attachPresence`. 69 headless
    tests + in-browser stack-load/run verified. *Still to build:* base-data gap-fill
    (Parquet a peer lacks — detection headless, transfer channel-gated) + the UIs +
    the real 2-machine connection test. Editing SHARED data needs no gap-fill.
    The serverless-handshake part is already solved and battle-tested in *sortie*
    (asteroids clone, https://lograh.github.io/sortie-game): **Trystero (MQTT
    strategy)** does signaling via public MQTT brokers (EMQX/HiveMQ) — nothing we
    host — then drops to a real WebRTC data channel. Its "repair" channels use
    `createDataChannel()` defaults = **ordered + reliable**, exactly the mode an
    op-log wants (and *not* the mode a game usually wants). What sortie did **not**
    need and CrossTab does:
    - *Convergence, not just dedup.* A game floods ephemeral state and self-heals each
      frame; `_mid` dedup is enough. Op-logs must *converge* — a missed op can't be
      papered over by "the next frame." Needs the mergeable-op-log foundation above
      (sequenced, gap-detecting, or CRDT per state class).
    - *TURN — DECIDED: bring-your-own, we host nothing.* Sortie's clever peer-**gossip**
      relay dodged TURN — but it only rescues connectivity when there's a **third peer**
      to route through. CrossTab's core case is **two** faculty behind university
      symmetric NATs, no third party → sometimes needs a real **TURN** relay. Decision:
      **we run none.** Instead the user (or their institution) can define a TURN server —
      `setTurnConfig({urls,username,credential})`, threaded into `iceServers` by
      `buildIceServers` (default = public STUN only). So an institution adopting the app
      can stand up its own TURN for its faculty; without one, a hard-NAT pair simply
      can't connect and the UI must say so (**detected ≠ connectable**). Built in
      `core/live-sync.js` (commit 20d6427).
    - *Late-join.* Snapshot-then-tail: ship the whole existing op-log to a joiner,
      then follow with the live tail.
  - **Concurrency detection / presence — "Jane has this open, co-author?"** The key
    reframe: **presence is separable from storage** — "who else has project X open"
    rides the *network*, not the bytes, so you answer it *once* (a thin layer keyed on
    project id) and all three storage modes borrow it, rather than solving it per mode.
    - *Live mode gets it free.* In Trystero the **room is the presence mechanism** —
      `onPeerJoin`/`onPeerLeave` fire on join. Not a feature added on top of live mode;
      a byproduct of it.
    - *Folder + Graph borrow the same beacon.* On open, every client (wherever its
      files live) joins a lightweight Trystero **presence room** and broadcasts a tiny
      `{who, mode, since}` beacon — no data channel, just "I'm here." Seeing a peer →
      prompt *"Jane also has this open — start co-authoring?"* → escalating promotes the
      **same room** to a reliable data channel + op-log sync. So detection and the
      live-mode handshake are the same machinery pointed at the same room.
    - *Filesystem-native path is the degraded fallback.* A **lock file**
      (`project.lock`, heartbeat + staleness timeout) is the offline answer but is
      advisory and slow: OneDrive sync latency (seconds–minutes) means two people can
      both "open simultaneously" inside the sync window and neither sees the other's
      lock; crashes leave stale locks (hence heartbeats); OneDrive can conflict-copy the
      lock file itself. **Graph** only offers change *notifications* (webhooks/delta —
      "the file changed"), not "someone has it open," so it also falls back to a
      drive-lock-file or (better) the beacon. Hierarchy: **beacon when networked
      (good), lock file when not (best-effort warning only).**
    - *Nice consequence:* presence-only is buildable **cheaply and early**, ahead of the
      hard merge foundation — ship *"Jane's in here too"* + the co-author prompt on
      Trystero alone, and it doubles as the escalation handshake later.
    - *Caveats:* (1) **same population problem** — the beacon needs a reachable public
      MQTT broker, so on locked-down university networks / air-gap it may not connect
      (back to the lock file, which needs the sync client, or nothing); (2) **detected ≠
      connectable** — the beacon can say "Jane's here" while TURN-less P2P then fails to
      link up, so the UI must handle that gracefully (ties to the TURN note above);
      (3) **room-key privacy** — derive the presence room key from a **salted hash of
      the project UUID** (store already mints `crypto.randomUUID()` ids) so the room is
      unguessable and non-enumerable on a public broker, not "is anyone editing
      `dissertation`?".
  - **Access control / confidentiality — a shared secret, kept separate from the
    room key.** The salted-UUID-hash room key (caveat 3 above) makes the room
    *unguessable to outsiders* but not *private from the broker/relay operator*, who
    routes by that key and so necessarily knows it. A hash is one-way for the *string*
    but not for *participation*: the operator still sees the topic has subscribers and
    reads whatever rides it in the clear. Fix = split the two roles, don't conflate:
    - *Addressing* stays the salted UUID hash — the operator sees this topic regardless.
    - *Confidentiality* = a shared secret → strong KDF (Argon2id/scrypt) → AES key that
      encrypts everything on the broker: **signaling and the presence beacon**. Keep it
      **orthogonal** to the room key — folding the secret into the key means rotating it
      changes the room *address* (collaborators lose each other) and a weak secret
      becomes an enumerable topic.
    - *What needs protecting is smaller than it looks.* Once WebRTC connects, the bulk
      op-log is **DTLS-encrypted peer-to-peer** already, so the secret's real job is the
      **signaling (which leaks participant IPs via ICE)** and the **beacon**
      (`{who,mode,since}`) — not the data. **Trystero ships a built-in `password` config
      that AES-encrypts its signaling**, which would do most of this for free (confirm
      against the pinned version — not vendored yet, only referenced here).
    - *Default should be a generated high-entropy key, not a typed password* — delivered
      in the invite link/code (key in the URL fragment, never hits a server; the
      Jitsi/Excalidraw E2EE pattern) so it's immune to the offline dictionary grind a
      memorable password invites. Offer a user-chosen password as the memorable-but-
      weaker opt-in.
    - *Residual, stated honestly (no theatre):* even fully encrypted, the operator still
      sees topic existence, subscriber count, timing, and message sizes — traffic
      analysis that encryption can't hide.
  - **[~] Base-data GAP-FILL BUILT (headless) — commit 89e99a2.** `core/gap-fill.js`:
    fetch a Parquet source a peer lacks over the channel — identity = the manifest source
    **op id** (no schema change / no per-file hash), integrity = transfer-time SHA-256
    verified before store, chunked (256 KiB) for multi-GB, consent/size-gated via
    `allowSend`. `SourceExchange` (requestMissing → need → chunk+hash+send → reassemble+
    verify+store) rides the live channel (`t:'need'/'src-chunk'`; LiveDoc ignores). 75
    tests incl. full 2-peer round-trip, consent-decline, integrity-reject. Byte read/store
    are ProjectStore callbacks; real transfer over Trystero is part of the 2-machine test.
    The *invite* half + the sneakernet index UI below remain. Original design follows.
  - **Onboarding + base-data sharing — the invite carries the key; an index fills the
    gaps.** Two questions the op-log foundation quietly skips: how the second user gets
    *in*, and how they get the *base bytes*. The log's first op is `load`, referencing an
    immutable source the joiner may not hold — e.g. two field studies in different cities,
    each holding only its own data file and needing to combine **both ways**.
    - *Invitation = key distribution.* The invite link/code is exactly the artifact from
      the access-control note: room topic (UUID hash) + high-entropy key. One thing to
      share out-of-band; accepting it decrypts signaling, connects, and late-joins.
    - *Late-join already ships the op-log snapshot* (above) — but its `load/append/join`
      ops (`data-store.js` §log, the universal operation log) point at immutable sources
      persisted as `ds{id}_src{i}.parquet` (`project-store.js:101`) that the joiner lacks.
      **That's the gap.**
    - *Index/manifest, separate from bytes (the user's instinct).* Broadcast a cheap
      manifest — `{datasetId, sourceHash, name, rows, cols, byteSize}` — content-**hashing**
      each Parquet source (today they're named only *positionally*, `ds{id}_src{i}`; a
      hash is what makes "do I have this?" answerable, enables dedup so identical files
      aren't re-sent, and lets a received file be integrity-checked against what the log
      expects). Replaying a log and hitting a `load`/`join` for a hash you don't hold =
      the gap → prompt **"share this file!"**.
    - *"Both ways" falls out of the foundation.* A merged log with A's `load city-A` +
      B's `load city-B` + an `append` means each peer, replaying, hits a gap for the
      *other's* source and fetches it — combine-in-both-directions is just the mergeable
      op-log plus on-demand fetch, not a separate feature.
    - *Transfer is consent- and size-gated, not silent.* Sources can be multi-GB (codec
      note); auto-streaming one over a field-site link is rude. Both sides see size —
      needer: *"missing city-B.parquet (3.1 GB) — request from Jane?"*; haver: *"Jane
      needs city-B.parquet (3.1 GB) — send?"* Bytes stream chunked over the same reliable
      data channel.
    - *Sneakernet fallback for locked-down / air-gap nets* (same population problem as the
      beacon): when P2P won't connect, the index still names *exactly which file* to hand
      over out-of-band, and CrossTab verifies the imported bytes' hash against the log's
      expectation — the index earns its keep even with no automated transfer.
    - *Async/folder mode mostly gets this free* — the sync client mirrors the Parquet
      sources, so gaps appear only inside the sync-latency window; the mechanism is
      chiefly a live-mode concern plus the sneakernet path.
  - **Core-vs-plugin boundary — apply the doctrine we already have, don't invent one.**
    `import-service.js` states the rule: the engine owns **"only what the security model
    forces it to"** — host UI, the user-activated picker, and **the destructive commit**
    (replace/append/join is host-only, so no plugin can overwrite your active data
    unprompted; a plugin *may* create **new** datasets and write its **own** state —
    additive vs destructive, not host vs plugin). No privileged importer; official CSV/SPSS register through the same
    public call a third party uses. Plugins run in a **sandboxed opaque-origin iframe**
    over the `plugin-broker` postMessage bridge. Collaboration = the *same* split applied
    to storage + transport:
    - **Kernel (core), because integrity/security force it:** the op-log +
      **three-way merge** (a wrong silent merge = plausible-but-wrong published numbers —
      can't live in untrusted code); the **crypto envelope** (KDF/AES/invite-key); the
      **content-hash / index / gap** logic; the storage **interface + the commit**; and the
      **presence *concept*** (who's-here keyed on project id).
    - **Plugins (pure pipes) behind those contracts:** every **storage driver**
      (FSA-folder, OneDrive/Graph, Dropbox, Google Drive, **WebDAV → Nextcloud/OwnCloud/
      self-hosted in one adapter**, S3…); the **presence/signaling transport** (Trystero
      strategy — MQTT/Nostr/…); provider **OAuth** bundled per driver. The WebRTC
      data-channel⇄op-log stays core (coupled to merge); only the *rendezvous* is a plugin.
    - **The insight that makes untrusted storage drivers safe:** core encrypts *before*
      `write` and decrypts *after* `read`, so a driver only ever touches **ciphertext** —
      even a malicious provider plugin can't read content (residual: metadata — paths,
      sizes, timing). Pushing crypto into the kernel is what lets the whole provider
      ecosystem be untrusted plugins. Analog of format-equality: no privileged provider.
    - **[~] BUILT (core interface, not sandboxed) — commit 34fc4de.** `core/storage-driver.js`
      is the path-based seam (`read/write/remove/removeTree/list/stat` + `kind/available`);
      `OpfsDriver` + `FsaFolderDriver` extend a `HandleDriver` base, and `ProjectStore`
      sits on it via `useDirectory()`/`useDriver()`. Deliberately a **core-registered
      interface, NOT `app.storage.register` in a sandbox** — resolving the "two caveats"
      below (FSA gesture/handle + gigabytes over postMessage) in favor of main-thread
      drivers. **Crypto sits above it**, so drivers only ever see ciphertext. A cloud
      driver now = implement the same surface over HTTP + `useDriver()`; the flags below
      (CAS/contentHash/nativeWatch) are the still-unbuilt capability-negotiation layer.
    - **Original proposed extension point** (by analogy to `importers.register`):
      `app.storage.register({ id, label, auth, read→{bytes,rev,mtime,size,contentHash?},
      write(path,bytes,{ifMatch:rev})→rev, delta(cursor)→{changes,cursor}, watch?(cb),
      capabilities:{conditionalWrite,contentHash,nativeWatch,sharing} })`. Core reads the
      **capability flags** and degrades: no CAS → lock-file/beacon; no `contentHash` → host
      computes it; no `nativeWatch` → poll `delta` (longpoll/delta/PROPFIND all normalize
      here).
    - **Two caveats storage-plugins have that codecs don't:** (1) the postMessage boundary
      vs **gigabytes** — must pass bytes by reference / transferable / streaming (importers
      already pass `File` by handle to avoid copying into the sandbox), and it's open
      whether a sandboxed iframe is even the right execution model for a high-throughput
      network driver; (2) a storage driver makes its own `fetch()` and custodies **OAuth
      tokens** — network + credentials → a **higher trust tier than a codec** (ciphertext
      guards confidentiality, but a bad driver can still refuse/corrupt/DoS sync and sees
      metadata). WebDAV extra: no native change-feed (→ poll) and **CORS** (self-hosted
      servers must send headers; many don't by default).
  - **Suggested build order:** (1) mergeable op-log foundation — stable op ids +
    common-ancestor + per-class merge rules; (2) folder transport (FSA seam in
    `project-store.js`) — first driver behind the new `app.storage` contract; (3) presence
    beacon (cheap, standalone — the "Jane's here, co-author?" prompt on Trystero, no
    convergence needed yet) + its confidentiality (encrypt the beacon; the beacon is where
    metadata first leaks); (4) cloud-API drivers as plugins (Graph / Dropbox / WebDAV) for
    tablet/mobile reach; (5) live transport (Trystero + reliable channel + TURN), which
    reuses the presence room as its handshake, the invite link as its key distribution, and
    the index/gap-fill for base-data sharing.

- [~] **Collaborator identity, authorship & memos (#148).** Who did what — the human
      layer on top of the merge kernel (#143). Driven by qualitative practice: **inter-
      coder reliability** (Cohen's κ / Krippendorff's α, coder-vs-coder comparison, bias/
      drift) is a first-class qual method and is *impossible without per-coder attribution*
      — the Dedoose-parity gap. Decided with the user (chat rejected as out-of-scope side-
      conversation; comments reframed as **memos/annotations**, a named qual technique —
      grounded-theory memoing + reflexivity + audit trail — anchored, persistent, part of
      the record, and useful SOLO not just in collab). Identity is **self-asserted** (no
      auth, serverless) → attribution is advisory, not forensic; κ needs consistent labels,
      not verified ones. Ties: [[collab-merge-kernel]] op identity, [[first-class-plugin-data]]
      (a memo is exactly the first-class attachment that's currently second-class), the
      "plugins add actions to the log" item, [[qualitative-first-class]].
  - [x] **1. User identity profile (name / initials / colour). DONE.** Per-USER, per-device
    (localStorage) — travels across all their projects, NOT per-project. A stable minted
    `authorId` so attribution survives a display-name change; initials auto-derived from the
    name but editable; a CB-safe colour for avatars. Small editor dialog. Distinct from the
    project-level `collabId`/`collabSecret`. **BUILDING NOW.**
  - [x] **2. Authorship stamp on codes / ops. DONE.** Snapshot `{authorId, initials, name, colour}`
    into each code-application / log op the user creates (snapshot, so it survives a later
    rename and other peers see it without the author's live profile). The prerequisite for
    step 3.
    - [x] **2a. Core log ops DONE** — stamped in `data-store.js#ensureIds` (new ops only,
      never retroactive); round-trips export/restore; verified in-browser.
    - [x] **2b. CAQDAS code-application authorship DONE** — `app.identity` broker RPC +
      `app.identity` namespace in plugin-host; the CAQDAS mount fetches `me` and stamps
      each code + each applied segment (text/region/time/track) via `authored()`; import-
      resolved codings + the QDPX parser are left unstamped. Author survives the add-wins
      merge (normalize spreads). End-to-end coding attribution to confirm by reading the
      persisted blob after coding (CAQDAS is cross-origin, can't be driven from the page).
  - [ ] **Authorship DISPLAY (tabled — user pondering the shape).** Surface who-coded-what
    in the CAQDAS UI (colour + initials chip on segments / retrieve list). User's steer:
    a plain "stamp every edit visibly" gets cluttered → lean toward **showing the chip only
    when the author ≠ the current viewer** (your own edits stay clean). Data already stamps
    everything (step 2); this is display-only. Revisit after the shape settles.
  - [x] **PREREQUISITE for 3 + 4 — segment identity & author-aware merge. DONE.** Found while
    verifying step 2b: `mergeState` keys segments by CONTENT
    (`doc|codeId|start|end|tStart|tEnd|region`), with **no author** in the key. Two
    consequences: (a) a content key is not a stable anchor for a memo (edit the span → key
    changes); (b) worse — **two coders applying the SAME code to the SAME passage collapse to
    ONE segment** under add-wins, silently discarding coder B's application. That *defeats
    inter-coder reliability* (κ/α need to see BOTH coded it). Fix: give each segment a stable
    `id` (fold into the `authored()` helper: `{ id: o.id || uid(), ...o, author }`), and make
    `segKey` use the id when present (content-key fallback for legacy/imported segments) — so
    per-coder codings stay DISTINCT and memos get a durable anchor. Changes merge semantics
    (more segments survive a merge), so confirm the methodology intent before shipping.
  - [x] **3. Memos / annotations (anchored comments). DONE (3a data+merge, 3b UI).** Word/Docs-style margin comments,
    but anchored + persistent + part of the analytic record. **Decisions (with user):**
    (i) memos REPLACE the old inline `memo` string going forward (legacy memo shown as a
    read-only first note; no lossy migration); (ii) **flat / chronological, author-stamped**
    — not nested threads — so a faculty reply in the teaching/office-hours case can't get
    buried under a fold and all students see it (record leaves room for an optional
    `replyTo` later); (iii) memos are their OWN add-wins collection anchored by id, NOT
    nested in the segment — required so faculty + student can both annotate the same coding
    without one clobbering the other. Anchor: coded segment / code first (segments now have
    stable ids); generalise to cells/variables/outputs later.
    - [x] **3a. Data model + merge DONE** — `state.memos = [{id, anchorKind, anchorId,
      author, text, createdAt}]`; add-wins by memo id in `mergeState` + normalize; +1 test
      (both people's annotations on one coding survive). 113 pass.
    - [x] **3b. Thread UI DONE** — `renderThread()` replaces the inline memo editors on
      the segment popup + code details: chronological author-stamped notes (colour+initials
      chip), add (button / Ctrl+Cmd-Enter), delete your own; legacy memo shown read-only;
      has-note markers updated; notes re-anchor when same-code segments merge. Verified via
      the persisted blob (3 KC-stamped, anchored memos; deletion persisted). Overflow fixed.
      **NOTE:** notes (like ALL CAQDAS actions) persist via the workspace blob, so they are
      NOT covered by core Edit▸Undo — the pre-existing "plugins add actions to the log" gap.
      **→ #152 fixes this** and generalises memos beyond CAQDAS (anchor becomes any op-log
      target, so a memo can sit on a dataset, a variable, or an analysis run).
  - **4. Inter-coder reliability analysis (κ / α) — MOVED.** This is an *analysis*
    feature, not a collab one, so it lives in **"## More analyses"** below (the stats
    backlog). The collab foundation it needs — per-coder attribution + distinct per-coder
    segments — is DONE here (steps 2–3); the κ/α computation is the analysis-side work.
  - [~] **5. Presence chips in the top bar. BUILT (awaiting 2-window verify).** Live editors shown by initials/colour. Cheap
    add-on, but coupled to **live P2P** (`core/presence.js` broadcasts peers) — lands WITH
    the live co-authoring chunk, not before. The self-chip built in step 1 is its seed.
    - **DESIGN (user, 2026) — collaboration is TRANSPORT-AGNOSTIC.** Do NOT assume OPFS
      projects are non-collaborative: a user can export a bundle → flash drive → a
      collaborator imports it to OPFS, and the two copies should meet in the SAME room.
      So **every project carries a collab identity** (collabId/secret), minted on first
      save and **carried in the export bundle** (+ restored on import), independent of
      folder/live/cloud. `collabReady` becomes true for all saved projects. (Supersedes
      5a's folder-only minting.) TODO: mint in `#snapshot` for any project; thread
      collabId/secret through project-bundle export + openBundle import.
    - **DESIGN (user) — presence gating = a global setting, not a per-session button.**
      A profile setting (like name/initials) **"auto-check for live collaborators" on/off**:
      OFF → today's manual "Go live" button stays; ON → CrossTab auto-joins the room on
      project open (online + not air-gap) and the user only clicks the final **"start live
      co-authoring with X"** offer. Presence = automatic awareness; the click consents to
      DATA streaming.
    - [x] **5a. Collab identity minted+persisted for folder projects** (roomFor now works)
      — to be GENERALISED to all projects per the transport-agnostic design above.
    - [~] **5b. Go-live toggle + peer chips** — `core/live-presence.js` (LiveSession +
      PresenceRoom) + header UI; explicit opt-in; identity-beacon only. Solo-verified
      (hidden for OPFS, wired, no errors); needs a two-window test on a shared folder to
      confirm peers actually see each other's chips. This is also the first live-P2P
      session wired — the handshake the future **live data co-authoring** layer reuses.
  - [~] **6. Live DATA co-authoring — WIRED end-to-end (6a+6b+6c); awaiting a two-window test.** — the layer the "start co-authoring" prompt launches.**
    Presence (step 5) is *awareness only*. The convergence **ENGINE is done + proven
    headlessly** — `core/live-protocol.js` `LiveDoc` (canonical-peerId ordering → byte
    convergence) + `attachLiveDoc`, with tests covering disjoint recodes, order-independence,
    late-join, a genuine conflict resolving, AND CAQDAS codebooks converging live. `LiveSession`
    now exposes `.selfId` (done) for the wiring. What remains is the **app integration**, and
    studying it surfaced **three concrete prerequisites** (none trivial, so NOT built blind):
    - [x] **6a. Live-apply materialisation. DONE.** Applying a peer's merged manifest live has NO
      disk round-trip (unlike folder `#applyMergedManifest`, which reloads from the folder
      after the merge wrote it). Need a path that rebuilds datasets from the merged manifest
      **reusing the local Parquet** (matched by source id) + merged transforms + merged
      workspace blobs — i.e. restoreState-from-manifest without re-fetching bytes we already
      have. Feasible for the shared-base case (both peers hold the same sources).
    - [x] **6b. Plugin-merger assembly DONE — (ALSO fixes folder-sync coding merge).** The app never
      calls `buildMergers` with real plugin modules — `#folderSave` passes `{core}` only — so
      plugin/blob (CAQDAS coding) merge doesn't happen in the REAL app today, folder OR live;
      it surfaces as conflict/LWW. Need host access to builtin plugin mergers (import
      builtin `mergeState` host-side — builtins are trusted) or the sandbox-bridge for
      3rd-party. **High value: unblocks coder-merge for BOTH transports**, and it's the
      office-hours driver. Ties [[plugin-verb-declaration]].
    - [x] **6c. Base-data byte gap-fill. DONE (wired).** Cold join / a peer adding a NEW dataset → the
      merged manifest references Parquet the other lacks → transfer over the channel
      (content-hash index → "send this file"). `core/gap-fill.js` (`SourceExchange`) exists
      but isn't wired. Required for the flash-drive/OPFS-import cold-start case; shared-base
      editing (recodes/coding) needs no transfer.
    - Then wire the **"start co-authoring with X" offer** (auto-offer on peer-appear) →
      `attachLiveDoc` on the presence session → local change publishes, merged applies (6a),
      conflicts → `showConflictDialog`. **DONE + wired.**
    - **LANDED ON MAIN 2026-08-01** pending wider device/lab testing. Two-window
      verification found + fixed: self-echo presence, the co-author-button "bounce"
      (emitProject→PROJECT_CHANGED→stopLive recursion), phantom conflicts on sequential
      edits + inverted conflict labels, MQTT broker spam, conflict-dialog auto-dismiss on
      remote resolve, **gap-fill chunk bytes mangled by Trystero's JSON action encoding
      (base64 fix)**, and **dataset deletion not propagating (add-wins → proper three-way
      delete)**.
    - **Known edges still open** (not blockers): (a) delete-vs-concurrent-edit keeps the
      data with no user prompt (no silent loss, but no choice); (b) deleting the *last*
      remaining dataset doesn't propagate live (empty-project apply path is guarded).
  - [ ] **~~In-project chat~~ — DEFERRED / maybe never.** Disproportionate scope
    (persistence, history, retention, notifications) for uncertain value when teams already
    have Slack/Teams; and it's the *unanchored* opposite of a memo. If ever, rescope to
    ephemeral live-session-only messages, decided on its own. (Talked through with the user.)

- [~] **Encryption at rest — opt-in for local storage, opt-out for exports (#144).**
      **CRYPTO KERNEL + FOLDER AT-REST DONE** (commit 341879e): `core/crypto-envelope.js`
      (PBKDF2-HMAC-SHA256 → AES-256-GCM, native WebCrypto — no vendored lib; master key
      derived once per session from passphrase + per-project public salt, fresh IV per
      file; self-describing envelope so plaintext/ciphertext coexist and migrate in place;
      key never persisted). `ProjectStore.unlock()/lock()/encrypted` wrap all data I/O →
      a folder handed to OneDrive/Dropbox holds only ciphertext (project.json, catalog,
      Parquet); salt/verifier meta stays plaintext; wrong passphrase caught at unlock.
      51 headless tests + verified in-browser incl. a full ENCRYPTED folder sync.
      **POLICY + ENCRYPTED EXPORTS now DONE too** (commit 99736fb): `core/at-rest.js` =
      per-target policy (export & folder default-ON/opt-out, local default-OFF/opt-in) +
      persisted overrides + an injected passphrase-provider seam (safe-by-default: no
      provider → plaintext). `core/crypto-envelope.js` gained a **self-contained**
      envelope (salt embedded) for exports; `export-service.js` `#runExport` encrypts a
      leaving file when policy+passphrase say so (`.enc`, all formats). 88 tests + in-
      browser verified. **Passphrase PROMPT UI DONE** (commit 30969de):
      `core/passphrase-ui.js` (enter/set modes, confirm-match, "no recovery" warning) +
      `installPassphraseUI()` wired from app.js as the at-rest provider — so encrypted
      export now prompts + engages. Verified in-browser (DOM).
      **IMPORT-SIDE DECRYPT now DONE** (commit history around import-service): a dedicated
      "Encrypted CrossTab file (.enc)" importer entry (+ a safety net that catches a `.enc`
      picked under any format) prompts, decrypts the self-contained envelope, recovers the
      inner format from the filename (`data.csv.enc`→CSV) and reuses `#resolveDownload`;
      wrong passphrase fails closed. **OPFS PER-PROJECT AT-REST now DONE**: `ProjectStore`
      grew per-project encryption (`#metaPath(id)`, `unlock(passphrase,id)`,
      `hasEncryption(id)`, `removeEncryption(id)`, key bound to `#keyId` + a save-guard
      against wrong-key writes; catalog kept plaintext since it spans projects with
      different keys). `openProject` unlocks a protected OPFS project before load;
      `File ▸ Protect this project… / Remove protection…` set/remove a passphrase **in
      place for BOTH OPFS and folder** projects (change-your-mind either way); default-
      protect prompts a new OPFS project at first save when the policy's on;
      `File ▸ Encryption settings…` toggles that policy. Each OPFS project has its OWN
      passphrase (shared-lab case). Verified against real OPFS. See [[at-rest-encryption]].
  - [ ] **SERIOUS GAP — shared-folder encryption change has no live-peer key coordination.**
      Flipping a *shared* folder project's protection (Protect / Remove protection, or a
      passphrase change) only lands cleanly for peers who **reopen** the folder. A peer
      who is **actively connected** keeps their old in-memory key, so their next save
      re-encrypts with the stale key (after an unprotect) or fails to read the newly-keyed
      files (after a protect / rekey) — silent divergence or read errors, exactly when the
      data's confidentiality is what's changing. There is currently **no protocol to tell
      connected peers "the folder's key changed → re-derive / re-prompt / relock."** Needs:
      a versioned key epoch in the plaintext folder meta (peers detect a bump on poll) →
      relock + re-prompt (or, once live P2P is up, an in-band "rekey" control message);
      and a decision on whether unprotect should force-disconnect peers first. Until then,
      the UI **warns** (unprotect confirm says it affects everyone), but that's mitigation,
      not a fix. Ties into the live co-authoring elevation + [[collab-merge-kernel]].
      *Still open (other):* the **chunked-Parquet** path for multi-GB sources (today a
      source encrypts whole — fine to ~100s of MB; OOM concern below at GBs). Original design below.
      Today the whole project bundle persists **plaintext** to OPFS / IndexedDB /
      localStorage, and exports land plaintext wherever saved (see SECURITY.md #10 for the
      full threat scope). Browser storage is origin-isolated (other *sites* can't read it)
      but offers nothing against **local/offline access** — stolen or shared machine,
      forensic image, profile backup/sync. **Primary at-rest answer stays OS full-disk
      encryption** (BitLocker/FileVault/LUKS) — document + nudge, don't reinvent. This TODO
      is the *optional* app-level layer for the FDE-gap and the off-machine case, built on
      the **collaboration crypto kernel** (same KDF/AES envelope — do not fork a second
      crypto path).
  - **Two different default postures, deliberately asymmetric:**
    - *Local storage → opt-**in**.* Passphrase off by default (most users have FDE; always-on
      would tax everyone and fight the large-data path). A "protect this project with a
      passphrase" toggle: key derived from the passphrase via the shared KDF, **never
      stored**, unlock once per session (in-memory key only). Forgotten passphrase =
      unrecoverable (no server) → the UX must say so unmistakably.
    - *Exports → opt-**out** (default-on).* Data leaving the machine is the higher-risk
      moment, so the nudge is stronger: encrypt exports **by default**, user can turn it off
      per-export. Applies to *all* export formats, not just `.crosstab` (format-equality /
      no-lock-in) — an encrypted wrapper around the produced bytes, with a clear "this file
      is passphrase-protected" affordance for the recipient.
  - **Why keyed by a user secret, not an auto-stored key:** automatic decrypt ⇒ the key sits
    on disk beside the ciphertext = theatre. Only a passphrase (or hardware-backed key) the
    machine doesn't persist is real. This is *the* reason it can't just mirror the collab
    "storage only sees ciphertext" pattern for free — locally, key-holder == storage-holder
    unless a human supplies the secret.
  - **Open problem — passphrase vs OOM-prone data (the hard part, must design before
    building).** DuckDB reads Parquet **directly from OPFS handles** (`BROWSER_FSACCESS`,
    `core/duckdb-manager.js`) so it can *stream* multi-GB sources without loading them into
    WASM memory. Naïve at-rest encryption breaks that: decrypt-whole-file-into-memory OOMs
    on exactly the large datasets the codec/large-file architecture exists for. Options to
    weigh, none free: (a) encrypt only the *small* stuff (`project.json`, metadata, output)
    and leave large Parquet to FDE — honest but leaves the biggest bytes plaintext;
    (b) **streaming/chunked AES** with a DuckDB read path that decrypts block-by-block
    (real fix, but needs a supported streaming-read seam in DuckDB-wasm — likely fragile);
    (c) decrypt to a scratch OPFS file on unlock (defeats the purpose — plaintext hits disk
    again). Also interacts with the storage-driver plugins (those already only see
    ciphertext) and with export streaming for big files. **Resolve the large-file story
    first; it likely decides the whole feature's shape.**

- [x] **Multimedia qualitative coding — audio / image / video (#139) — CORE DONE.**
      Selector generalization, image/audio/video import + rendering, region-over-time
      keyframing, and REFI-QDA/QDPX export are all built (see the STATUS line below).
      **The transcript-linked workflow, transcript import, and Whisper auto-transcription
      are broken out to their own TODO below** ("Transcript-linked qualitative coding")
      — still wanted, not yet built. Original design notes kept here for reference. Mature the
      qualitative side from text-only to multimedia. The current coder
      (`plugins/builtin-caqdas/index.js`) does text: pick a text column (one document per
      row), highlight character spans, tag with codes; a segment is
      `{doc: rowId, codeId, start, end, text}`, the codebook lives in the workspace blob,
      plus retrieve-by-code, per-segment memos, merge-on-overlap, paint mode.
  - **Core insight — generalize the *selector*, don't build four coders.** A text segment
    is a **1-D interval in character space**. Every medium is the *same* segment over a
    different coordinate space, so the segment becomes `{doc, codeId, selector}`:
    - *Text* — `{start, end}` chars (today).
    - *Audio* — `{tStart, tEnd}` seconds (1-D interval, float instead of int — nearly
      identical to text).
    - *Image* — `{region}` bbox/polygon (2-D, no time).
    - *Video* — `{tStart, tEnd, region?}` — time **+** optional spatial region, region
      keyframed over the interval.
    Then the **entire existing apparatus is reused** — codebook, retrieve-by-code, memos,
    code frequencies, overlap handling. Only two things vary by medium: the **selector
    type** and the **rendering surface** (text pane → `<audio>`/`<video>`/`<img>` + overlay
    canvas). This is deliberately the W3C **Web Annotation** selector model.
  - **Interop target — REFI-QDA / QDPX.** That exchange format (NVivo, ATLAS.ti, MAXQDA,
    Dedoose, Taguette all read/write it) already models audio/video **time** selectors and
    picture **regions**. Shape our selectors at REFI-QDA so a coded project round-trips to
    the other tools — the format-equality / no-lock-in principle applied to qual. **Reject**
    the old "embed coding inside the media" ideas (MP4 alternate stream, PNG
    steganography/metadata): media must stay **immutable and referenced**, annotations live
    in the project — embedding breaks on any re-encode, is non-standard, and throws away
    this interop.
  - **Media are assets, not cells (CrossTab-specific, ties to two live threads).** Text is
    one-doc-per-row in a column; media are large binaries that can't sit in dataset cells.
    Mirror the Parquet-source model: media live as **assets** (OPFS files / handles), the
    row holds a **reference** (`assetId` + content hash), segments reference
    `{assetId, time/region}`. This plugs straight into: (1) **collab base-data sharing
    (#143)** — a media asset *is* the big base file a collaborator may lack → the
    content-hashed index + "share this file!" gap-fill is its transport; (2) **encryption /
    OOM (#144)** — a `<video>` streams from an OPFS file URL without loading into memory,
    but *encrypted* media can't stream to the element → same large-file wall as #144, same
    solution surface.
  - **Rendering surfaces & gestures:**
    - *Audio/video* — `<media>` element + a timeline; **drag-select a time range → apply
      code** (the same paint-mode gesture, in time instead of chars). Playback **speed
      control** is trivial (`HTMLMediaElement.playbackRate`).
    - *Image* — `<img>`/`<canvas>` with a region tool (bbox → polygon).
    - *Video spatial* — overlay canvas on the `<video>`, region keyframed across the time
      interval ("where in the frame," the old open question — it's just the 2-D selector).
  - **Transcript-linked is the target workflow (fork resolved).** The dominant real
    practice isn't coding a raw waveform — it's a **time-aligned transcript**: code the
    text, click a line to **seek the playhead** (NVivo/oTranscribe style). Make the
    time-aligned transcript a **first-class document that references the media**, not just
    media-timeline coding. More work, but it's what qual researchers actually do.
  - **Transcription — import first, auto-transcribe as a deferred Phase 2 (fork resolved).**
    Phase 1: **import existing transcripts** (VTT / SRT / timestamped rows) → 80% of the
    value cheaply. Phase 2: in-browser auto-transcription — **feasibility CONFIRMED** (see
    below), but a real epic (30–180 MB model download, WebGPU-dependent speed, worker
    architecture), so it waits.
  - **Whisper feasibility (checked 2026-07, available):** two mature fully-client-side
    routes — **transformers.js** (Xenova) running ONNX Whisper on **WebGPU with a WASM
    fallback** (`whisper-web`, `browser-whisper`), and **whisper.cpp WASM** (SIMD). Models:
    tiny 75 MB (Q5 31 MB), base 142 MB (Q5 57 MB), small 466 MB (Q5 182 MB) — **small is the
    browser ceiling**; tiny/base are practical. Speed: **WebGPU ~5–8× real-time** on a ~76 MB
    model (5–10×+ faster than WASM); **WASM-only ~2–3× real-time** (60 s clip in ~20–30 s).
    WebGPU needs Chromium 113+; WASM SIMD is the broad fallback. Models **cache for offline**
    exactly like the R packages / runtime assets already do (fits the CDN-default +
    "make available offline" pattern, and the air-gap vendoring path #71). So Phase 2 is
    viable when we want it — the deferral is *scope/effort*, not feasibility.
    - *Mobile WebGPU is new — design WASM-fallback-first.* WebGPU only just reached mobile:
      **iPadOS/iOS Safari 26+** (on by default, but the last major platform to ship it, so
      older institutional iPads lack it) and **Android Chrome 121+** gated on **Android 12+
      with a supported GPU**. So on a *current* iPad you get the 5–8× path, but on an older
      iPad / low-end Android you fall back to WASM (~2–3×) with tighter RAM — realistically
      **tiny/base only** on mobile. Treat WebGPU as the bonus fast path, WASM as baseline;
      on tablets prefer **transcript import** or desktop-transcribe-then-sync (via the #143
      asset share) over grinding a model on-device.
  - **Suggested phasing:** (1) generalize the segment selector + refactor the text coder
    onto it (no behavior change — pure groundwork); (2) **audio** coding (closest to text —
    1-D time selector + timeline drag) + transcript import & time-aligned seek; (3) **image**
    region coding (2-D selector + canvas); (4) **video** (time + keyframed spatial overlay);
    (5) **REFI-QDA/QDPX** import/export across all selector types; (6) **Whisper Phase 2**
    auto-transcription. Media-asset storage (with `#143`/`#144` ties) lands with step 2.
    **STATUS: (1)–(4) BUILT** (text, image regions+layers, audio/video time-ranges+lanes,
    and video **region-over-time** — static + interpolated manual keyframes + a rough
    template-matching auto-tracker). **(5) REFI-QDA EXPORT BUILT** — caqdas
    `manifest.exports`/`exportQdpx`, on two new reusable capabilities: **`app.zip`**
    (surfaces core/zip.js) and **`app.state.read(wsId)`** (owner-scoped read of a
    workspace blob the plugin declares, from the compute frame — #89-safe). text/image-
    rect/time round-trip; region-over-time exports time-span only. SCHEMA to validate vs
    NVivo/ATLAS (time units ms vs s = `TIME_SCALE`; not XSD-verified). Remaining: (5b)
    QDPX **import** (time-selections → time codings, faithful, per user; spatialize-later
    needs a time-coding→region-over-time upgrade path that does NOT exist yet) and (6)
    Whisper.
  - **Video region-over-time — tracker rungs (built 1–3; rung 4 deferred).** Region-over-
    time coding is a spatiotemporal segment `{keys:[{t,x,y,w,h}], tStart,tEnd}` — a box
    that interpolates between keyframes (`regionAtTime`). **Built:** (1) static region +
    time span, (2) manual keyframes + interpolation, (3) a **rough in-JS auto-tracker** —
    downscaled-canvas grayscale **template matching** (translation only, subsampled,
    suggestion-with-correction; `matchTemplate`/`grayPatch` in builtin-caqdas). Good for
    slow/roughly-rigid motion (e.g. proxemics); weak on fast/deforming/occluding subjects.
    - **Rung 4 — robust ML/CV tracker (CSRT/KCF via OpenCV.js, or a deep tracker):
      INTENTIONALLY DEFERRED, possibly never.** Only pursue if rung 3 proves too rough for
      real footage. Cost is real: it's **WASM**, which the media-CSP workspace sandbox does
      **not** allow (only the codec sandbox has `wasm-unsafe-eval`), so it needs either
      widening that CSP (a security decision) or a separate WASM worker, plus a large model
      download. None of rungs 1–4 round-trip to QDPX (video is time-only there) — a
      deliberate CrossTab-only extension.
    - **Box editing — BUILT.** The active track box is drag-to-move + 8-handle resize in ✎
      Region mode (`attachBoxEditing`); a gesture upserts the keyframe at the current time,
      so fixing tracker drift is scrub → nudge, and a tighter box feeds the matcher less
      background. Decision (user, testing rects first): favour **better rect-editing tools
      over a heavier tracker**.
    - **Polygon / non-rect shapes — DEFERRED refinement (evaluate after rectangles).**
      Would sharpen target definition and (via a polygon mask on the template) cut spurious
      background from the matcher. Not built yet — too much to design blindly before the
      rectangle pain points are known. When revisited, the load-bearing constraints: region
      gains an optional `pts` vertex list (rects untouched, polygon opt-in); **fixed vertex
      count per shape** so keyframes interpolate vertex-by-vertex (variable-vertex morphing
      is out of scope); tracker masks SSD to in-polygon pixels and translates all vertices
      together; touches draw + vertex-edit + hit-test (point-in-polygon) + interpolation
      across BOTH image regions and video tracks. Still CrossTab-only (no QDPX round-trip).

- [ ] **Transcript-linked qualitative coding (#139 follow-on).** Broken out from the
      multimedia item above (whose media-coding core is done). Still wanted — it's the
      dominant real qual practice. Two parts + a deferred phase:
  - [ ] **Transcript import (Phase 1).** Import existing time-aligned transcripts —
        **VTT / SRT / timestamped rows** — as a first-class document that references the
        media asset. ~80% of the value cheaply; no ML needed. New importer parsers
        (`.vtt`/`.srt` → cues with `{tStart, tEnd, text}`), attach to a media row.
  - [ ] **Transcript-linked coding surface.** A time-aligned transcript pane beside the
        `<audio>`/`<video>`: code the *text* (reuse the char-span selector), and clicking
        a line **seeks the playhead** (NVivo / oTranscribe style). The playhead/seek
        machinery already exists (`builtin-caqdas`); this adds the transcript document
        model + the line↔time binding.
  - [ ] **Whisper auto-transcription (Phase 2 — DEFERRED, feasibility confirmed).** In-
        browser transcription via transformers.js (WebGPU + WASM fallback) or whisper.cpp
        WASM; models cache offline like the R packages. A real epic (30–180 MB model
        download, worker architecture) — the deferral is scope/effort, not feasibility.
        See the Whisper feasibility notes under #139 above.

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
    - [x] **Real GSS files — VERIFIED.** Real GSS `.sav` (including large) imported
          end to end, not just the synthetic round-trip. *Residual (distinct, still
          open):* SAS value labels need the separate `.sas7bcat` catalog
          (`read_sas(data, catalog_file)`) — not yet wired; `na_range` (range-style
          SPSS missing) not yet captured, only discrete `na_values`.
    - [x] **Large-file ceilings (the haven-in-WebR path) — RESOLVED via the ReadStat
          codec.** haven-in-WebR kept OOMing on large files, so the streaming
          **ReadStat codec** (`plugins/builtin-readstat-codec/` — the "compile ReadStat
          to wasm + stream rows → Parquet/DuckDB" lift noted below) became the
          large-file path; real + large GSS now import through it, while haven stays
          for the labelled small/extract case. Original per-limit analysis kept for
          context. Two distinct limits, both hit by the full GSS 1972–2024 cumulative
          (`.sav` 3.8 GB, `.sas7bdat` 2.4 GB, `.dta` 597 MB):
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
  - Excel import broken out to its own top-level TODO below (in progress).
  - *Note:* the Parquet return path (`DataStore.loadDataset` +
    `DuckDBManager.replaceTableFromParquet`) is built and unit-exercised by the
    contract but not yet driven end to end until the `haven` importer lands.
- [x] **Excel (`.xlsx`/`.xls`) import + export via SheetJS — DONE.**
      `plugins/builtin-excel-codec/` — a read+write format codec (#98). **Import** reads
      the workbook with SheetJS, prompts for a sheet when there's more than one
      (single-sheet imports straight through), treats the first row as the header,
      conservative numeric inference matching the CSV codec (numeric only if every
      non-empty value is a real number; dates → ISO text; blank/duplicate headers
      auto-named/uniquified), then batches rows into the host ingest. **Export** writes
      the current dataset to a single-sheet `.xlsx` (raw values — numbers as numbers,
      missing → empty cell; Excel row-ceiling guarded). SheetJS (`xlsx@0.18.5`) is a
      host-vetted shared library fetched via `app.codec.loadAsset('xlsx')` (CDN by
      default), blob-imported in the sandbox. **Both directions verified in Chrome** end
      to end (import: menu → picker → sandboxed parse → DuckDB grid; export: round-trip
      re-parsed identically) with a mixed-type/date/blank/duplicate-header workbook.
      **Multi-sheet import — DONE (split model).** A multi-sheet workbook prompts with a
      sheet checklist (row×col hints, first sheet pre-checked) so summary/codebook sheets
      can be skipped; each selected sheet becomes **its own dataset** (heterogeneous
      sheets shouldn't be pooled/row-stacked — join is the existing Merge feature's job).
      First selected sheet streams as the primary; the rest are created via
      `app.data.create` (added `selected` seed to `ui.selectFromList`). **Verified in
      Chrome** — a 2-sheet workbook split into two correct datasets. *Minor follow-up:*
      the primary dataset takes the host's default import name (e.g. "Dataset 1") rather
      than its sheet name — a host-level codec-naming behavior shared by all codecs, not
      Excel-specific; extra sheets are already sheet-named.
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
- [x] **SPSS-style data grid view — DONE** (incl. edit-in-cell). Read-only grid
      (`core/data-views.js`) + the separate editable-cells item below; only cosmetic
      polish remains (see *Still to do*).
      A tabbed workspace (**Data | Variables | Output**) beside the sidebar.
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
  - *Still to do:* a raw-codes vs value-labels toggle; column sort/resize and
    per-column width (fixed 120px today). Possibly retire the sidebar variable list
    now that grid headers carry selection (under consideration).
- [x] **Data editor (editable cells) — BUILT** (`core/data-views.js` +
      `core/data-store.js`). Double-click a cell in the Data View to edit it. The
      edit is a **sparse override transform** (`{type:'setCell', row, column,
      value}`): non-destructive (the immutable source table is untouched —
      verified the raw source keeps its original value), undoable/redoable, shown
      as a step in the **History** panel ("Edited cell · age — row 1 = 777"), and
      emitted by **export-to-syntax** (`d[["age"]][1] <- 777`). Applied in
      `rederive` by wrapping the derived view: `row_number()` over the view's
      natural order (the same order the grid reads) + a `CASE` per overridden cell;
      numeric columns parse the value, blank → NA. **Verified end to end in
      Chrome:** UI double-click → edit → persists + shows in grid; undo reverts;
      source immutable; History + syntax both reflect it.
  - **Stable per-row ids — DONE (edits are reorder-proof).** Each immutable source
    bakes a hidden `__ct_rid` column at creation (`sourceIndex × 1e9 + rownum`),
    persisted in the source Parquet and **never regenerated on restore**. The
    derived view carries it through (UNION aligns it; joins inherit the base row's
    id), and cell overrides key on it (`CASE __ct_rid WHEN <id> …`) instead of a
    positional index — so an edit follows its row through appends and
    row-reordering joins. The id is hidden (never in `getVariableMeta`/`getColumns`/
    `getDataFrame`, so analyses/CSV/R injection are untouched); the grid reads it
    via `getRows({includeRowId})`; ids cross the BIGINT→JS boundary as digit
    strings (no float precision loss). **Verified in Chrome:** the edited row keeps
    its value after an append and a join; ordering the view by id puts the edited
    row at scan position 31 yet it still reads the edited value (position-
    independent); and the edit survives an export→restore round-trip with the id
    intact. `row` is retained on the transform only as a display label for History/
    syntax.
  - *Still to do:* edit a factor cell by picking a **label** (today you type the
    raw code); range/fill edits; the old `VariablesSidebar` stand-in in `app.js`
    can now lean on this for any remaining inline editing.
- [x] **Source-immutability + transform log — DONE** (`core/data-store.js`).
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
    - [x] **Cell editor uses a sparse override transform** — not a destructive
          cell write. `{type:'setCell', row, column, value}` applied as a `CASE` in
          the derived view; the source stays immutable (see the Data editor item).
  - [x] **Universal log + strict sequential replay — BUILT.** `#sources` + a
    separate transform log were merged into **one ordered `#log`** in
    `core/data-store.js`: every operation — `load`/`append`/`join` (data loads) and
    `setVariable`/`setCell`/`computeVar`/`recodeVar` (data transforms) — is a
    single, ordered, undoable entry. `rederive` **folds the log strictly in order**
    (sequential replay), so each op sees exactly the state the prior ops produced —
    true script semantics. So **imports/appends/joins are first-class History
    steps you can undo, redo, and rewind across**, AND order is honoured: a compute
    logged before an append is evaluated over the pre-append data, and the appended
    rows get NULL for it (via `UNION ALL BY NAME`). The engine result therefore
    matches running the log as a script.
    - **Reproducibility (the point):** persisted shape stays `{sources, transforms}`
      *plus* an `order` tag stream (`['s','t','s',…]`) so a restore replays the
      exact interleaving — same result on another machine. Old saves without
      `order` fall back to source-ops-then-transforms. `getTransforms` stays
      data-only, so projects/library/version-pull are untouched (backward-compat).
      `order` threaded through `project-store` + `dataset-store`.
    - *Tradeoff (faithful, less forgiving):* a retype/recode *before* an append no
      longer auto-covers the appended rows — sequence the cleaning *after* loading,
      exactly like a real script.
    - **Verified in Chrome:** compute-before-append → appended rows NULL for it;
      compute-after-append → all rows; the `order` hint survives `exportState`/
      `restoreState` *and* a full project JSON round-trip (appended row stays NULL
      for the pre-append compute); undo across source ops; join + retype under
      sequential; rid cell-edits stable; no rid/source leak.
    - **Fixed an autosave auto-create race** (surfaced while testing this): a burst
      of changes *during* the first project auto-create couldn't schedule (no
      binding yet) and `#fullSave` then cleared the dirty set, so a rapid
      replace→compute→append right after the first edit lost the append.
      `ProjectSync` now records `#changedWhileCreating` and does a full catch-up
      save once the binding exists. Verified: the no-spacing burst now round-trips
      through project open with the full history + the appended row intact.
  - [x] **History / rewind panel — BUILT** (`core/data-views.js` `HistoryView`, a
    4th workspace tab between Variables and Output). A **linear** transform-history
    view: an as-imported base step + a numbered step per logged transform, each
    described in plain language ("Edited age · type → numeric · missing: -99");
    click any step to rewind (or fast-forward) to that state. The current position
    is highlighted; steps *ahead* of it (undone but redoable) render greyed and
    stay clickable. Engine: `DataStore.getHistory()` (applied + future + sources)
    and `DataStore.rewindTo(n)` (moves the applied/redo boundary and re-derives
    **once**, cheaper than walking N undo/redo calls), delegated through
    `DatasetManager`. A fresh edit after a rewind discards the steps ahead (standard
    linear branch-discard). The rewound state autosaves (a `'rewind'` DATA_CHANGED
    reason — not source-dirtying, so no Parquet rewrite). Verified end to end in
    Chrome: backward rewind reverts derived metadata, forward fast-forward restores
    it, branch-discard works, autosave fires. Decision (settled): **linear, not
    git-style branching** — the audience thinks in linear syntax files, and
    divergent exploration is already served by the multi-dataset workspace (fork =
    a separate dataset). No branch tree / diff UI / prune.
    - *Now the universal log:* imports/appends/joins are first-class steps too,
      with an explicit "Start (empty)" step 0.
    - **Relocated to Edit ▸ History… as an editable floating panel — DONE.**
      History is *actions* (what you did), not an input/output, so it left the
      Data/Variables/Output tab strip and became a non-blocking floating panel
      opened from **Edit ▸ History…** (beside Undo/Redo). The panel docks right and
      doesn't dim the grid, so clicking a step **rewinds live** while you watch the
      Data grid update behind it. Each applied step (except the pinned base import)
      has **▲▼ to reorder** and **✕ to delete** — now meaningful because replay is
      sequential (move an append above a transform → the transform covers the
      appended rows). Guarded by `DataStore.moveOp`/`removeOp` +
      `validateOrder`: an order that breaks a dependency (e.g. editing `foo` before
      the compute that creates it, or removing a step a later one needs) is
      rejected with an inline message; the SQL re-derive is the backstop for
      compute-expression deps. **Verified in Chrome:** reorder flips an appended
      row's computed value null→value; the guard blocks "edit before create" and
      "remove a depended-on step"; base import can't be moved/removed; delete works;
      live rewind updates the grid behind the open panel.
    - **"Collect imports" button** (panel toolbar): one click stable-partitions the
      log so all data-loading steps (load/append/join) move above the transforms —
      the professional "import everything, then process" order. Reuses the guarded
      reorder (`DataStore.collectImports` → `#applyReorder`), so it's rejected/
      rolled back if a join key depends on a transform. Verified: an interleaved
      load/compute/append/recode collapses to load/append/compute/recode and the
      appended row picks up the (now-earlier-than-it) compute (null → value).
      *Deferred:* drag-to-reorder (▲▼ cover it for now); a per-step timestamp.
  - **Accepted boundary (not a violation):** "source" = the *as-imported* table,
    not the original file bytes. Pair with the **Dataset library** to enable full
    file→result reproduction if wanted.
- [x] **Data transform/recode — DONE** (both phases). Phase 1 *metadata transforms*
      via an **editable Variable View** — click a variable to edit it; Phase 2
      *compute/recode new variables* via the Transform menu (both below). The
      cross-cutting "honour missingValues everywhere" concern is split out to its own
      item below; remaining bits are noted polish.
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
  - **Phase 2 — compute / recode (new derived variables) — BUILT**
    (`core/compute-recode.js` + `core/data-store.js`; **Transform** menu). Both
    create a *new* variable as a logged, non-destructive transform (sources stay
    immutable, undoable, shown in History, exported to syntax) — added as a derived
    column in the view, never a `CREATE TABLE`/mutation.
    - **Compute** (`computeVariable`): a DuckDB scalar expression over existing
      vars (`income / 1000`, `a + b + c`, `sqrt(x)`, `CASE …`). Dialog has a
      click-to-insert variable palette. Invalid SQL is **rolled back** (the
      transform is popped + re-derived) so a typo never leaves the dataset broken.
    - **Recode** (`recodeVariable`): structured rules (exact value / numeric range
      / missing → a value, copy, or system-missing) compiled to a `CASE`; an
      else-rule for all other values (default copy). Stored structured, so it
      re-edits and exports cleanly.
    - Derived vars chain (a later compute can use an earlier one), cast to the
      declared type, and are full variables (analyse/plot/recode them further).
      Export-to-syntax emits R: compute → `with(d, <expr>)` (SQL identifiers →
      backticks); recode → base-R assignments applied first-match-wins.
    - **Verified end to end in Chrome:** Transform ▸ Compute `income_k = income /
      1000` → 52; Transform ▸ Recode `age` → `agegroup` bins (45→2, 33→1, 52→3);
      both show in History; invalid expression rolls back; the exported `.R`
      **parses and runs** on synthetic data with identical results
      (`income_k=52,39.8,…`, `agegroup=2,1,1,3,NA`).
    - *Still to do:* surface the new var with auto value-labels for a recode (e.g.
      label the agegroup codes); a "recode into same variable" option; an `if`
      condition (compute only where …); expose `app.transform.compute/recode` to
      plugins (the AI auto-recode idea) — additive, host-only for now.
  - *Still to do (Phase 1 polish):* a GSS-aware "mark missing" preset (the known
    iap/dk/na/refused/… labels); **range** missing (e.g. all `< 0`), not just a
    discrete list; value-label conflict policy on multi-year append; and the
    earlier idea of surfacing a warning when imported data has un-designated
    candidate missing codes. (The "honour `missingValues` in every analysis" gap is
    now its own item below.)
- [x] **Honour `missingValues` centrally at injection — DONE.** (Correction to the
      earlier note: it was never "only Frequencies" — **~45 analysis plugins each
      re-implemented** the same `x[x %in% codes] <- NA` recode; the real risk was
      duplication + any plugin forgetting/diverging.) The host now folds designated
      missing codes to SQL `NULL` (→ R `NA`) at the **analysis injection boundary** — a
      `CASE WHEN TRY_CAST(col AS DOUBLE) IN (codes) THEN NULL` in
      `DataStore.getInjectionParquet`/`getColumns` (`#missingWrap`), gated by an
      `applyMissing` flag threaded from `webr.run`. Every declarative analysis honours
      `missingValues` for free, correct-by-construction. **Opt-out:** an analysis item
      declares `keepMissing: true` to receive raw codes (Frequencies, which reports the
      valid/missing breakdown); the raw `injectData`/r-console path and the **Data grid
      (`getRows`) stay raw** (SPSS shows the code). Plumbed through
      plugin-actions → loader → broker across the menu, script-replay, and `runAnalysis`
      paths. **Verified in Chrome:** injected R `vars` stripped `1,2,3,NA,5` vs opt-out
      raw `1,2,3,-99,5`; grid raw `-99`; Descriptives N=4 / Missing=1 / mean=2.75; a real
      Descriptives run carries `keepMissing=false`, Frequencies `keepMissing=true`.
  - [x] *Cleanup — DONE.* Removed the now-redundant per-plugin `%in% codes <- NA`
        recode (and its `missingValues` extraction) from **41 exclude-style analysis
        plugins** — the central strip covers them. Kept in the three that genuinely
        need raw codes: **Frequencies** (opts out via `keepMissing`), **plots** (reads
        `getColumns`/`injectData` raw — neither is stripped), and **syntax-export**
        (emits the recode into the exported standalone `.R`). Verified: all plugins
        parse; `missingValues` gone from the 41; no dangling references; descriptives/
        correlation/regression run clean with `-99` still excluded (x: N=5, Missing=1).
- [x] **`app.ui.showForm`** — a general declarative form dialog (text/password/
      number fields). Built (`core/ui-service.js`) for the FRED importer; also used
      by the dataset library's name prompt.
- [x] **Two-tier persistence: Projects + building-block library.** *Built.*
  - **Projects (living documents)** — `core/project-store.js` + `core/project-sync.js`.
    A project is the whole working set (every open dataset + active), saved as one
    self-contained OPFS bundle (`projects/<id>/project.json` + `ds<id>_src<n>.parquet`)
    and **autosaved** on any change. File ▸ New / Open / Save project(/as). Cheap:
    autosave rewrites only the changed dataset's Parquet (`writeSourcesFor`), else
    just `project.json`. Verified: build a 2-dataset set, save, edit → autosave;
    reload → Open restores all datasets + active + edits.
  - **Building-block datasets (reusable)** — `core/dataset-store.js` (OPFS
    `datasets/`) + `core/library.js` (`DatasetLibrary`). Explicit File ▸ Save
    dataset to library… / Add dataset from library… (copies a block into the
    project). **No autosave/binding** here — the project tier owns persistence; a
    building block is only updated by an explicit re-save, so in-project edits never
    mutate the shared block (copy-in independence). Verified: save the demo as a
    block → appears in the library → Add → a copy joins the project.
  - Each saved dataset (in either tier) = the whole reproducible stack (immutable
    sources as Parquet + transform log + metadata), so undo/provenance survive a
    round-trip and pooled/joined datasets save naturally. `navigator.storage.persist()`
    on first save.
  - **Always-saving:** the first edit in a fresh session auto-creates an autosaving
    "Untitled project" (no more unsaved-work gap). Deleting the active project →
    fresh Untitled.
  - **Sidebar = project manager** (`ProjectSidebar`): three zones — active project
    (name + ✎/✕, its datasets, ＋add), other Projects (open/rename/delete), and
    Building blocks (add/delete/drag). Drag a dataset → Building blocks (promote to
    v1 + link); drag a block → Datasets (linked copy).
  - **Linking + versioning + propagation (feature-3 — DONE):** blocks are
    versioned (v1 → bump on update); a dataset carries `libraryLink
    {id,version,baseLen}` (badge "v<n>"), set on promote/add, persisted in the
    bundle. **Version propagation/pull is now built** (`DatasetLibrary.pullLatest`):
    when a linked dataset's block has a newer version, the sidebar row shows an
    **"↑v<n>" pull button** instead of the static badge; clicking it fetches the
    new block version and **re-applies the dataset's local transform overlay** on
    top (`baseLen` splits block-origin transforms from local edits). The dataset
    opts in (pull, not push); other linked projects update only when they choose.
    Verified end to end in Chrome: block bumped to v2, a linked dataset with a
    local edit pulled → kept the block's v1 + v2 changes **and** its own local
    edit, link advanced to v2. Reconciliation is best-effort (a local transform
    referencing a now-missing variable no-ops; everything stays saved + undoable);
    local *source* additions to a linked dataset aren't preserved (block sources
    replace them — linked datasets diverge via transforms).
  - *Deferred:* drag a dataset onto another on-disk project (workflow exists via
    open + add); pruning orphaned Parquet after a dataset is removed mid-project;
    export to real disk (File System Access); `app.datasets` plugin API. Supersedes
    the old IndexedDB idea.
- [x] **Export results / output — BUILT, and now plugin-architected.** Save the
      Output pane (tables, plots, notes) as a shareable report via **File ▸ Export
      output…**.
  - **Architecture correction (honours "everything is a plugin"):** the first cut
    was host-owned and scraped the shadow DOM — a violation of our own model. Fixed:
    - **Result model** (`core/results-pane.js`): the pane now keeps an ordered,
      structured record of output (section / text-html / table-html / plot{svg,id} /
      error) alongside the DOM, and exposes a **read surface** to plugins —
      `app.results.getModel()`, `getStyles()`, and `getPlotPng(id)` (host rasterises
      the plot from the live SVG, so export plugins need no canvas in their sandbox).
    - **Output-exporter extension point** `app.outputExporters.register/deliver`
      (mirror of `app.exporters` for data; broker + plugin-host wired). The host
      (`core/output-export.js`, now `OutputExportService`) owns only the picker
      dialog, the download, and the print path; it builds the format-button list
      from whatever plugins registered.
    - **HTML and Word are now plugins** — `plugins/builtin-html-export/` and
      `plugins/builtin-docx-export/` — each reads the model via the API and delivers
      bytes. Verified end-to-end through the real sandboxed round-trip (HTML 7/7
      content checks; docx 26 KB with real table + embedded plot PNG + unicode).
    - **Print stays host** — it's the one export that genuinely needs the browser
      (`window.print()` on a host iframe), exactly the "only the print dialog is
      non-plugin" end state.
  - Both report targets render faithfully (HTML reuses the pane's own stylesheet;
    print clones the live DOM — WYSIWYG):
  - **PDF** (chosen rendering path: print, not a PDF lib): render the report into a
    hidden same-origin **iframe and `print()`** it → the user picks "Save as PDF".
    Zero-dependency, native, iPad-Safari-friendly (Save to Files), and printing
    from normal DOM sidesteps the shadow-DOM-in-print wrinkle. (jsPDF/Paged.js
    rejected for v1 — rasterises or needs a vendored lib; revisit Paged.js only if
    publication-grade pagination is wanted.)
  - **HTML**: the same report written to a self-contained `.html` file (Blob
    download via the shared `downloadFile`, now exported from `export-service.js`).
    Great for archival / re-opening; plots stay crisp (inline vector SVG).
  - **Per-plot SVG / PNG** (`core/results-pane.js`): each plot in the Output pane
    gets hover-revealed **⬇ SVG / ⬇ PNG** buttons. SVG is serialised directly
    (xmlns guaranteed); PNG is rasterised via a canvas at ~2× device pixels on
    white (the SVG is self-contained, so the canvas isn't tainted and `toBlob`
    works). Default title = the active project's name (`ProjectSync.activeName`).
  - **Verified in Chrome:** real menu → dialog → Download HTML produced a report
    with the title/header, the table, the plot SVG and the print CSS, with the
    interactive buttons stripped; the PDF iframe path ran with no exception and no
    leaked iframe (print() is a silent no-op under automation but opens the dialog
    interactively); per-plot SVG (valid) and PNG (~25 KB, untainted) both download.
  - **Word / .docx — BUILT** (officer + flextable in WebR; the "Download Word"
    button in the same dialog). No vendored lib needed: verified WebR's repo (R
    4.6) has the whole chain — `officer`, `flextable`, `zip`, `xml2`, `gdtools`,
    `systemfonts`, `ragg`, `textshaping`, `uuid`, `openssl` — and that they
    **build a valid .docx at runtime in wasm** (spiked before wiring). officer
    builds from R objects, not HTML, so the exporter walks the live Output pane
    into a small content model (title/headings/paragraphs/table-grids/plot-PNGs)
    and generates R that assembles it: section titles → headings, each result
    table → a real editable **flextable**, each plot → an embedded **PNG** (Word
    renders SVG unreliably; reuses the per-plot canvas rasteriser), notes →
    paragraphs. Cell text passes through a `\u`/`\U`-escaping R-string encoder so
    no jsonlite/encoding round-trip is needed. The officer chain installs once per
    session on first Word export (~one-time, with a status note). **Verified in
    Chrome:** menu → dialog → Download Word produced a 26 KB .docx whose
    `docx_summary` shows real paragraph + table-cell content (title, table data,
    percentages, **unicode "café" intact**) and whose zip carries the plot PNG in
    `word/media/`.
  - *Deferred:* a combined **Output + syntax + data-summary** report (ties to
    export-to-syntax / the transform log — and the History panel already gives us
    that list); rich Markdown→Word (notes currently flatten to plain paragraphs);
    table-aware pagination via **Paged.js** for the PDF path; per-table CSV/HTML of
    an individual result table (overlaps with data export below).
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
- [x] **Export-to-syntax (script) — BUILT** (`plugins/builtin-syntax-export/`,
      File ▸ Export ▸ R syntax). Turns the dataset's **transform log** (the same
      record the History panel shows) into a runnable **R script** that reproduces
      the recodes — the script an academic pastes into RStudio or drops in a
      methods appendix. Done on-architecture as a **plugin**: the transform log is
      now exposed to plugins via `app.data.getTransforms()` (new read surface,
      wired through broker + plugin-host), and the plugin emits R from it. Each
      logged metadata transform becomes R, in log order: designate-missing →
      `x[x %in% c(codes)] <- NA`; retype → `as.numeric(as.character(x))` /
      `as.character` / `factor`; value labels → `factor(x, levels, labels)`;
      relabel → `attr(x, "label") <- …`; measurement level → a comment (no base-R
      equivalent). Sources are an editable load stub; text is `\u`/`\U`-escaped.
      **Verified in Chrome:** real menu → export produced a script that **parses in
      R** (`parse()` OK) and whose recodes **run correctly** on synthetic data
      (−99 → NA then numeric; factor levels→labels; label attr).
  - **Now emits the full ordered log** (not just a load stub): reads
    `app.data.getHistory()` (the new plugin read surface for the universal log) and
    emits **load/append/join in their true position** alongside the transforms —
    `read.csv` for the base, `dplyr::bind_rows` for an append (NA-fills like
    UNION ALL BY NAME), `merge(..., by.x/by.y, all.x=TRUE)` for a join — so the
    script structurally matches the app's history. Verified: an interleaved
    import→compute→append→recode→join exported all 5 steps in order, parses in R.
    Source bytes aren't embedded — the load lines point at file paths (label hints).
  - *Deferred:* **SPSS `.sps`** syntax (a second format in the same plugin — fast
    follow); including **analyses** in the script (needs a run-log + plugins
    declaring their R — bigger); key-normalisation in the emitted join (the app
    matches case/space-insensitively; the `merge` stub doesn't yet).
- [~] **In-app plugin creator / editor — BUILT** (`core/plugin-creator.js`;
      **Edit ▸ Create plugin…**, and **"+ Create new…"** in the plugin manager).
      A scaffolded editor so non-programmers build the plugin they need without a
      toolchain — pick a template, fill in the analysis, **Save & load** hands the
      source to the same sandboxed loader (`PluginManager.saveAuthored` →
      `loader.loadSource`, untrusted). Authored plugins **persist in localStorage**
      (`kind:'authored'`, source stored) so they survive a restart and re-open in
      the editor (✎ in the manager) to edit in place; removable like any user plugin.
  - **Declarative plugin API (v2) — BUILT (full rewrite; supersedes the `activate`/
    `run`-string notes above).** A plugin is now **manifest (data) + named
    functions**; the host does all wiring and there is **no `activate`** and **no
    registration API** at all. This was the big redesign agreed in design review;
    done in 4 phases (commits) with every built-in migrated. Shape:
    - **Menus:** `manifest.menu = [{ label, run, order?, inputs? }]`; the host files
      each under `category` (placement host-owned — a plugin can't choose), gathers
      the item's declared `inputs` with host dialogs, **binds them into R by name**
      (single var → vector, multi → data.frame, scalar → value), then `invoke`s the
      named `run(app, inputs)`. So the author writes no menu/picker code and the R
      is **static** (no JS interpolation).
    - **Inputs** are general + declarative: `kind: 'variables'|'number'|'choice'|
      'text'`, with `multiple`/`types`/`optional`/`unique` (unique greys out a var
      chosen by an earlier round — scatter X≠Y). Imperative `app.ui.selectVariables`
      survives as a hidden escape hatch for dynamic flows.
    - **Results carry structured data:** `appendTable(data)` (a `{columns, rows,
      caption?, rowHeaders?}` spec or a WebR data.frame result) is **rendered
      host-side via DOM** — plugins ship **no table HTML**. `appendText` is
      markdown (escaped); `appendPlot` is SVG (the lone sanitised surface). The big
      injection surface is gone.
    - **Importers/exporters declarative too:** `manifest.imports/exports/
      outputExports` with named functions that **return** the dataset/bytes; the
      host owns the File menus, picker, commit, download. The whole `*.register`
      API is gone from the plugin surface.
    - **Output attribution:** every output block carries a host-stamped
      `name · origin` line (origin = built-in / from-URL / from-file / created-here);
      the plugin can't forge the origin (anti-impersonation).
    - **Plugin `app` surface shrank** to runtime verbs only (data reads + create,
      webr, results, ui, web) — no menus/importers/exporters/events/transform.
    - **Verified in Chrome (per phase):** all 8 analyses, all 8 importers/exporters,
      and a template-authored plugin all run end-to-end on the new API; output shows
      host attribution; an authored plugin reads "created here".
  - **Templates** (now declarative): **Blank**, **One-variable analysis**,
    **Two-group comparison** (seeds the *Comparison* family), **Plot (histogram)** —
    each a manifest (menu + inputs) + a `run(app, inputs)` whose R references the
    host-bound input names. Generated R uses string concatenation so the scaffold
    carries no backticks/`${}`.
  - **Simple mode (form → no JavaScript) — BUILT.** The creator opens in **Simple**
    mode by default: a form (name, category dropdown, an inputs builder with
    friendly presets — "Numeric variable(s)", "One categorical variable", "A
    number", … — Table/Plot output, and an R-code box). On save it **generates** the
    declarative plugin (the user's R embedded via `JSON.stringify`; for a plot it's
    wrapped in an svglite device so the author writes only the plot call) and loads
    it — so an R-literate, JS-shy social scientist never sees JavaScript. A live
    hint shows which names are bound in R. A **Code** toggle reveals the full
    generated source for power users / editing (one-way: editing leaves Simple
    mode). **Verified in Chrome:** a form-built Table plugin (means by variable) and
    a Plot plugin (histogram) each generate, load, file under their category, and
    run end-to-end.
  - **Editor surface (Code mode):** a textarea with a **line-number gutter** +
    Tab-inserts-spaces — "more than Notepad". Save persists *before* loading (work
    is never lost); a load error stays in the dialog with the message to fix.
  - **Verified end to end in Chrome:** all 4 templates create + load with correct
    categories; the one-variable plugin ran the full chain (menu → variable picker
    → R → table: age N=30, Mean=41, SD=10.888); authored plugins **survive a
    reload** (re-loaded from stored source), **edit-in-place** re-loads + persists,
    and **remove** clears them from the list + storage.
  - *Original framing + still-to-do below.*
  - **Scaffold pre-wires the boilerplate:** a starting template with the **input
    selector** (variable picking via `app.ui.selectVariables`) and the **output
    channels** (`results.appendText`/`appendTable`/`appendPlot`) already typed in,
    plus a filled-in manifest (api version, menu path, declared `rPackages`). The
    author writes the bit in the middle. Offer a few template shapes (one-variable
    analysis, two-picker analysis, plot) since those cover most needs.
  - **Editor surface:** syntax highlighting to catch typos — "nothing crazy."
    Decision point: a tiny self-rolled highlighter vs. vendoring **CodeMirror**
    (the obvious "more than Notepad," but a vendored dep — fits the existing
    "vendor + pin" hardening posture). Lean minimal for v1.
  - **Where the authored plugin lives + runs:** it must persist (OPFS, alongside
    projects/blocks) and load through the existing **sandboxed-iframe loader** via
    blob/`data:`-URL module import — so it ties directly to the open questions on
    **blob-module import inside the opaque-origin iframe** (Milestone 3) and
    **multi-file plugins / import-map**. The trust boundary is unchanged: authored
    code runs in the same sandbox as any other plugin, and its output still goes
    through the HTML sanitiser (so that hardening item covers it too).
  - *Nice follow-on:* a "fork this analysis" button that opens an existing builtin
    plugin's source in the editor as a starting point.
- [x] **Plugin manager (enable/disable plugins) — BUILT** (`core/plugin-manager.js`;
      **Edit ▸ Plugins…**). A dialog listing every built-in plugin with a checkbox;
      toggling is **live** — disabling unloads it (its broker disposer removes the
      menu items/exporters immediately), enabling loads it. The disabled set + a
      `{url:{id,name}}` catalog persist in **localStorage** (first use of it), so
      choices survive a reload; the manager owns the boot load loop (skips disabled
      URLs). **Verified in Chrome:** disabling Plots removed the Graphs menu live,
      it stayed gone after a reload (and the row showed "disabled"), re-enabling
      brought Graphs back and cleared the set. Host-owned, as designed (it drives
      the loader — outside the sandbox allowlist; a plugin couldn't manage peers).
  - **Grouped + searchable** (for when the list grows): the manifest gained
    optional **`category`** (groups the plugin into a section — an unknown value
    just makes a new one; missing → "Other") and **`keywords`** (extra search
    terms). The dialog has a **search box** that matches name *and* keywords *and*
    category *and* id, and renders plugins in ordered category sections
    (Import · Analysis · Graphs · Export, then any custom, then Other). The 16
    built-ins are categorised + keyworded. **Verified:** sections show
    Import 4 / Analysis 7 / Graphs 1 / Export 4; searching "contingency" (only in
    Crosstabs' keywords, not its name) surfaces Crosstabs — so an oddly-named
    third-party plugin stays findable by what it does.
  - **Categorise by method family, not a generic "Analysis"** (avoids the
    junk-drawer that would bloat as analyses grow). Analyses now use specific
    families matching their `Analyze ▸ …` submenus: Descriptive Statistics
    (Frequencies/Descriptives/Crosstabs), Correlation, Regression (Linear/
    Logistic), Resampling (Bootstrap). The manager defines a **recommended ordered
    vocabulary** (Import · Descriptive Statistics · Comparison · Correlation ·
    Regression · Multivariate · Time Series · Resampling · Graphs · Export); a
    plugin may use any string but unrecognised ones sort after the recommended set
    (a gentle nudge), with "Other" last. Documented in the `manifest.category` doc
    (loader.js) so third-party authors see the convention. Verified: sections now
    read Import / Descriptive Statistics / Correlation / Regression / Resampling /
    Graphs / Export.
  - **Plugin menus match the category — now ENFORCED, not a convention.** A plugin
    declares only its menu **label** (`menus.register({ label, command })`); the
    **broker forces the menu path to the plugin's `category`** (`plugin-broker.js`
    overrides the `menus.register` dispatch with `path: [category]`), so any `path`
    a plugin passes is discarded — the menu location *can't* be chosen, and the
    menubar always agrees with how the plugin manager groups the plugin. Built-ins
    dropped their now-redundant `path:` (8 files); the creator templates pass label
    only. Menubar reads File · Edit · Transform · Correlation · Descriptive
    Statistics · Graphs · Regression · Resampling. **Verified in Chrome:** a plugin
    that tried `path: ['HACKED']` got filed under its category (Comparison) with no
    rogue top-level. (Importers/exporters stay under the host-managed File ▸ Import /
    Export — registered by the host, not via `menus.register`; their category still
    drives the manager section.)
  - **Load external plugins (URL + file) — BUILT, with the sandbox hardened.** The
    manager can now add third-party plugins from outside the built-in set, and they
    persist across restarts (`crosstab.plugins.user` in localStorage):
    - **Add from URL** (`addFromUrl`) — re-fetched each boot; the author must
      CORS-enable a cross-origin URL (there's no proxy). Stored as `{kind:'url',url}`.
    - **Add from file** (`addFromFile`, native file picker) — the **source is
      persisted** (`{kind:'file',name,source}`) so it reloads with no file present.
    - User plugins are listed by category alongside the built-ins (origin tag
      `url`/`file`), each with a **✕ remove** (uninstall); built-ins stay
      unremovable. `loader.loadSource(code,label,{trusted})` is the new no-fetch
      entry path; the loader keys catalog/disabled/user generically (built-in key =
      url; file key = `local:<uuid>`).
    - **Untrusted by default + hardened boundary** (the safe-without-a-store
      posture). Externally-loaded plugins are `trusted:false`:
      1. **Sandbox CSP** (`plugin-host.html`): `connect-src 'none'` so a plugin
         has **no network of its own** — it can't silently exfiltrate.
      2. **Network consent gate** (`loader.#gatedServices`): an untrusted plugin's
         *only* network path, `app.web.get`, prompts the user on first use
         (`confirmPluginNetwork` in app.js); decision cached per instance. Built-ins
         stay ungated.
      3. **Sanitiser hardened** (`core/sanitize-html.js`): killed a CSS-escape
         bypass (`u\72l(`→`url(`) and added a fragment size cap; full DOMPurify +
         a host-page CSP remain the production upgrade (see Hardening).
    - **Verified in Chrome:** file-add loads + survives reload from stored source +
      removes cleanly; URL-add (same-origin) loads + persists as a re-fetchable URL;
      an untrusted plugin's own `fetch` is blocked **and** its `app.web.get` fired
      the consent dialog and honoured Block; manager dialog shows the Add buttons +
      trust notice + per-plugin origin/remove.
  - *Deferred:* a "reload plugin" action for the plugin-creator loop; optional
    integrity-hash pinning for URL plugins (so a remote plugin can't silently
    change); per-domain (not per-plugin) network consent.
- [x] **Direct R interface / console — BUILT** (`core/r-console.js` + a new
      **R Console** workspace tab). A live REPL on the **persistent** WebR session
      for power users and plugin authors testing ideas before wiring them into a
      plugin. Host feature (a sandboxed plugin can't draw a terminal).
  - **Persistent eval** (`WebRManager.evalConsole`): runs each entry in the global
    env via `source(print.eval=TRUE)` so visible values auto-print like the R
    prompt and state persists across lines (`x <- 5` then `mean(x)`) — the normal
    `run()` purges per call, so it can't. Errors captured, not thrown.
  - **Data staging matches the plugin contract** (`WebRManager.consoleBind`): the
    checked variables are bound as **`vars`** — a data.frame when several are
    checked, a plain vector when one is — *exactly* what a plugin input receives,
    so console code copy/pastes straight into a plugin's `run`. The info panel says
    what `vars` is and lists loaded libraries (+ a "load library…" box).
  - **UI:** variable checkboxes mirror the data-grid header (filter field +
    single-line horizontal scroll, so a wide file like GSS stays tidy); an inline
    prompt that flows right after the latest output (webR/RStudio feel); **inline
    plots** (captured via `captureGraphics`, drawn to a canvas in the scrollback);
    **multi-line input** (Shift+Enter newline, Enter run; ↑/↓ history).
  - *Decision (settled): not an IDE.* We deliberately do **not** clone the
    RStudio source/console/plot triptych — the plugin creator is the "write a
    script" surface; the console is the interactive scratchpad. Our edge is
    integration (data one checkbox away, bound as a plugin gets it), not out-IDE-ing
    a real IDE.
  - *Deferred:* a typed-command log feeding export-to-syntax (the reproducibility
    tie-in); a clear/reset-session action.

## More analyses (each is just another plugin)

- [ ] **Inter-coder reliability (Cohen's κ / Krippendorff's α) — CAQDAS analysis (from #148).**
      The payoff of the collaborator-authorship work: compute agreement between coders and
      surface disagreements for qualitative coding teams (the Dedoose-parity method). The
      **collab foundation is already DONE** (#148): each coder's coding is a distinct,
      author-stamped segment (per-coder ids + author-aware merge), so the data needed is
      present. This item is the *analysis* side: (1) an **agreement grouping** — group
      overlapping same-code segments across coders into codeable units (text reliability is
      an overlap/unitising computation, NOT exact-match); (2) the coefficients — **Cohen's
      κ** (two coders), **Krippendorff's α** / **Fleiss' κ** (≥2 coders), plus a simple
      percent-agreement + a per-code/per-coder disagreement table; (3) surface it in Output
      (and, later, a "disagreements" review view in the coding pane). R has `irr` /
      `icr` (WebR feasibility probe first, per house style), or hand-roll + validate
      against `irr`. Also decide the unit model (whole-doc code presence vs unitised
      overlap). Driven by faculty running coder-bias meta-analysis. See [[qualitative-first-class]].
- [ ] **Single-Case Experimental Design (SCED) — NEW GAP (coverage backlog).** The
      **multiple-baseline / ABAB / withdrawal** graphs + non-overlap effect sizes that
      applied-behaviour-analysis, special-ed, early-childhood-intervention and school-
      psychology researchers live on (publication-required under What Works Clearinghouse
      SCED standards). Raised by an early-childhood-dev faculty member doing this work
      with students (real, in-scope). **Not supported today** — no chart kind fits (the
      host renderer is single-panel; a multiple-baseline graph is *multi-panel* with
      **staggered phase-change lines**, per-phase line segmentation, and condition
      labels). Plan: a new plugin — phase structure + target behaviours/data → the graph
      (drawn via svglite, so it gets the Layer-1 chart frame for free) **plus** the
      non-overlap stats (**Tau-U, NAP, PND**). R **`scan`** does both graphs + stats;
      `SCDA`/ggplot are alternatives. *First step:* a WebR feasibility probe that `scan`
      installs and runs (like the Phase-0 probes). See the stats-coverage-backlog memory.
- [x] **Comparison: t-tests + one-way ANOVA** (`plugins/builtin-compare/`) — fills
      the *Comparison* menu with four declarative analyses: one-sample t-test,
      independent-samples t-test (Welch), paired-samples t-test, one-way ANOVA.
      Base R (`t.test`/`aov`), inputs bound by name, user-missing recoded, SPSS-style
      tables (group statistics + test). Verified in Chrome on the demo data
      (independent income~gender: Welch t=−3.01, df=25.81, p=.006). *Deferred:*
      post-hoc (Tukey) for ANOVA; Levene + equal-variance t as an option.
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
  - **Chart interaction architecture (#131) — DECIDED: three layers, not
    "model-ise everything."** The host data-model renderer
    (`app.results.appendChart` → `core/chart-renderer.js`) is great for common charts
    but can't model the *variety* of statistical graphics — box/forest/biplot/network/
    word-cloud/dendrogram/step/multi-panel all fell out of it. Forcing everything through
    a host model both boils the ocean AND caps what plugins can draw. So interaction
    splits into three layers (each chart picks a layer; we no longer force outliers into
    the model):
    - [x] **Layer 1 — universal host FRAME (model-free) — DONE.** Every `appendPlot`
      chart now gets a host-owned **editable title + caption** rendered *around* the SVG
      body (not baked into it), persisted in the model (survive save/reload), injection-
      safe (`plaintext-only`). `app.results.appendPlot(svg, { title, caption })`;
      `#buildPlotBlock` in `core/results-pane.js` (shared by append + restore).
      **All 17 appendPlot plugins swept** to pass `opts.title` and drop the baked R
      `main=` (auto-titles suppressed with `main=""`/`NULL`; `xlab`/`ylab` stay
      plugin-drawn — axis-title editing remains model-only, Layer 2). Verified in Chrome:
      boxplot title editable + persists; regression's two plots show host titles with no
      baked doubles (incl. the `qqnorm(main=NULL)` edge). *Follow-ups if wanted:* a small
      "frame options" popover for title font/size + a host caption default; axis-title
      editing for svglite bodies (harder — host can't place them around an opaque SVG).
    - [x] **Layer 2 — host data-model renderer (`appendChart`) — DONE (all strong
      candidates).** Instant, no-round-trip body controls (recolour / reorder / restack)
      for the common `categorical` / `scatter` / `pie` kinds. Reserved for high-value
      **common** charts, NOT a universal mandate. *Migrated:* `plots` scatter, trends,
      pie, histogram, errorBars; **`factor` scree** (line from eigenvalues), **`timeseries`
      correlogram** (ACF/PACF bars from `acf`/`pacf` values), **`textanalytics` word
      frequency** (bars from top-N counts). Each verified in Chrome (correct values, live
      chart). The three R-extraction migrations also dropped `svglite` where it became
      unused. **No further Layer-2 migrations planned** — the remaining charts are either
      fine on the Layer 1 frame or need a new glyph; their optional body-interactivity is
      deferred to Layer 3 (below), not forced into the model.
    - [ ] **Layer 3 — plugin-declared, host-mediated re-chart.** A plugin draws its own
      SVG (full R power) AND declares the alterations it supports
      (`controls: [{ id, label, type, options }]`); the host renders those controls and
      calls back to re-chart on change (generalises the existing `onRedraw` size-recipe).
      Opt-in, for everything not in Layer 2 where body edits are worth a round-trip:
      - *Marginal-fit charts (weren't worth a Layer-2 model):* `decisions` tornado + CE
        plane, `ecology` NMDS, `inequality` Lorenz, `cointegration` volatility,
        `timeseries` forecast.
      - *New-glyph charts (Tier B — no existing kind):* `plots` boxplot, `meta` forest,
        `ordination` biplot, `survival` Kaplan-Meier (step line).
      - *No-data-model charts (only Layer 1 + maybe a redraw/param control):* `sna`
        network, `spatial` map, `decisions` tree, `timeseries` STL decomposition, `var`
        IRF (multi-panel), word clouds, `assumptions`/`regression` Q-Q + residual
        diagnostics.
    - **Superseded:** the earlier Tier A/B/C "migrate-to-model" matrix. Outliers keep
      their svglite bodies and gain Layer 1 (frame) + optional Layer 3 (declared controls);
      only common charts warranted full Layer 2 model migration — now complete.
  - *Generalise plots over derived data — RESOLVED via multi-dataset.* The
    on-architecture answer ("analyses emit a derived dataset; plots consume
    datasets like everything else") is now real: see the **multi-dataset workspace**
    + `app.data.create` below. A plot doesn't take another plugin's output through a
    bespoke channel — the analysis emits a dataset and the plot just plots it.
- [x] **Multi-dataset workspace + derived datasets** (`core/dataset-manager.js`).
      The engine now holds a *set* of open datasets with one active, not a single
      dataset. `DataStore` is per-instance (id-namespaced DuckDB tables, own library
      binding/undo); `DatasetManager` owns the set + active and delegates the whole
      DataStore interface to the active one (so import/export/grid/analyses just act
      on whatever's active). A switcher in the tab bar picks the active dataset.
      **`app.data.create(dataset)`** lets an analysis *emit* a derived dataset (added
      + activated), so analyses are data sources too — one currency (datasets), no
      bespoke plugin↔plugin pipe. Library `Open` now adds a dataset (open several
      side by side); binding is per-dataset. Verified end to end. *Now unblocked /
      partly done:* the library's "single vs. multi-dataset" question (answered:
      multi), and **join across loaded datasets** (engine can hold both; the join UI
      still goes via import — wiring it to pick a loaded dataset is a small follow-up).
- [x] **Bootstrap the mean** (`plugins/builtin-bootstrap/`) — the first analysis
      that emits a derived dataset: resamples a numeric variable B times, emits the
      B resampled means as a new (active) dataset (`boot_mean`) you can plot/describe,
      and prints observed mean, bootstrap SE, and a 95% percentile CI. Verified:
      income, 2000 reps → derived dataset + CI table → histogram of the bootstrap
      distribution. The showcase of "analyses emit datasets, plots consume them."
- *Testing note (Chrome automation):* driving **two sequential modal `<dialog>`s**
  is flaky via CDP — a synthetic `button.click()` closes the dialog but does *not*
  fire the `close` event (so the app's promise never resolves), and long evals
  that hold a modal open hit the 45 s CDP timeout. Use `dialog.close('ok')`
  (fires `close` deterministically) and keep modal-driving evals short; or verify
  the analysis R directly and check rendering manually. Single-dialog analyses
  (Descriptives) drive fine.

## Nice-to-have / optimisations

- [x] **Order the top-level menus: host menus first, then plugins A→Z — DONE**
      (`core/menu-shell.js` `byTopLevel`). The **built-in (host) menus** are pinned
      in a fixed order — **File, Edit, Transform** — and plugin-contributed menus
      (Analyze, Graphs, …) sort alphabetically after. The principle: disable every
      plugin and the base menus stay exactly where they are. Verified: the menubar
      reads File · Edit · Transform · Analyze · Graphs. Per-item order *within* a
      menu still uses the `order` field.
- [ ] Batch a multi-variable Frequencies run into one R call instead of one job
      per variable (`plugins/builtin-frequencies/index.js`).
- [~] Settings persistence (localStorage). *Started:* the plugin manager persists
      its disabled-set + catalog there (`core/plugin-manager.js`). A general
      settings store can generalise that pattern. (Dataset persistence is its own
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

## Blocked until public deploy (GitHub Pages)

- [x] **Milestone 3 — verify on iPad Safari — DONE.** The deploy gate is lifted (live
      at crosstab-stats.github.io/crosstab/) and the app has been **tested multiple times
      on iPad and iPhone** with data import working end to end — which exercises all three
      risks below. Safari/iPadOS is no longer an unknown.
  - [x] Blob-module `import()` inside the sandboxed (opaque-origin) iframe — works
        (codecs/plugins blob-import to parse, and import succeeds on device).
  - [x] Cross-origin isolation via the **`coi-serviceworker`** reload path (`sw.js`) —
        works: the deployed site gets isolation from the SW (Pages sends no COOP/COEP),
        and that's exactly what iPad/iPhone hit, so `sw.js` is now exercised on device.
  - [x] `<dialog>` modal behaviour and touch targets on iPad — fine (the import picker
        and sheet/mode dialogs drive correctly by touch).
  - *Adjacent prep (all now resolved above):* `LICENSE` (Unlicense) and PWA icons done;
    vendor+pin decided against (keep CDN); PWA precaching shipped.
