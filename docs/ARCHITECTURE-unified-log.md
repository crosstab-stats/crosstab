# Unified operation log — architecture plan

**Status:** design agreed; build in progress on `feat/unified-op-log`.
**Supersedes:** the scattered change-tracking described in the change-tracking audit
(five parallel systems). This doc is the target we are refactoring *toward*.

> Guiding principle for this work: *extra work now is fine if it best assures less
> pain later.* We lift weights at 20 so we can lift the coffee cup at 70. Every
> decision below trades a little plumbing now against a class of bugs later.

---

## 1. Why

An audit of how "change" is tracked found **five parallel subsystems**, each with its
own identity scheme, persistence shape, merge behaviour, undo participation, and
change signal:

1. **Data inside a dataset** — a real event-sourced op-log (`DataStore.#log`): ids,
   undo, rewind, replay. *Almost right — the model to generalise.*
2. **The dataset collection** (add/remove/rename/reorder/active) — a `Map` + events.
   No ops, no ids, no undo. Deletion = absence in the next snapshot.
3. **Plugin/workspace state** (CAQDAS coding, memos, spatial) — opaque whole-blob
   overwrite. No ids, no history, not undoable.
4. **Analysis runs** — an ordered list, but **positional (no ids)** and **not merged**.
5. **UI / selection / presence** — transient view state.

Every bug we chased (delete-doesn't-propagate, phantom conflicts, the co-author
"bounce", gap-fill corruption) lived on a **seam between two of these systems**, not
inside any one. The fix is not more patches on seams — it is to remove the seams by
making **all persistent change one kind of thing**.

## 2. Core decision: one log, many projections

There is **one ordered operation log per project**. Everything persistent is an
operation in it. Derived state (a DuckDB view, the dataset set, the Output pane, a
plugin blob) is a **projection** — a pure fold over the subset of ops that target it.
This is standard event-sourcing: one event stream, many read-models.

`DataStore` already does this internally (`rederive` partitions `#log` by op kind
before folding). We are lifting that pattern from the dataset to the whole project.

## 3. The operation envelope

Every change becomes one `Op`:

```
Op {
  id      : string        // stable unique identity (random uuid)
  hlc     : {wall, counter}   // Hybrid Logical Clock — total order + human time (§5)
  target  : string        // what it writes: "coll", "ds:2/var:income",
                          //   "analysis", "ws:builtin-caqdas/coding/2/seg:abc"
  owner   : "core" | pluginId   // decides the merge strategy + who may fold it
  author  : {authorId, initials, name, color}
  type    : string        // the verb; core knows core's, a plugin owns its own
  payload : {...}         // LIGHT metadata only; heavy bytes are asset refs (§9)
  reads   : string[]      // targets this op depends on — the causal DAG (§4)
}
```

`author` is a first-class field, not the bolted-on afterthought it is today.

## 4. Ordering: `reads[]` is causality, HLC is the tiebreak

Two orders coexist and do different jobs:

- **`reads[]` — the partial order (causality).** An op lists the targets it reads.
  This makes the log a **DAG**, not a line. Merge orders ops by this DAG so a step
  never lands before the step that produced what it reads. This is *kept in v1*
  (decision): it is the single highest-leverage investment, paying off in **four**
  places — dependency-aware merge ordering, reproducibility (the pipeline DAG is
  explicit), undo/reorder validation (today's implicit `validateOrder` becomes a
  first-class reusable check), and **dangling-reference detection for free** (an op
  whose read-target is gone is *detectably* orphaned instead of silently wrong).

- **HLC — the total order (tiebreak + human time).** Breaks ties between
  DAG-incomparable ops deterministically, and drives the History/undo sequence and
  human-readable timestamps.

## 5. Clock: Hybrid Logical Clock (not Lamport, not wall-clock)

- **Lamport** guarantees order but is *timeless* — useless for an audit trail /
  memoing / "who did what when", which this app needs.
- **Naive wall-clock** gives time but is *dangerous* — collaborators' clocks disagree,
  and a backward clock step (NTP/DST) sorts ops wrong.
- **HLC** = `(physical-time, logical-counter)`: within a bounded skew of real time,
  **and** causally correct, **and** monotonic across backward clock jumps. One value
  is both "when" and "order", so we never grow a second timestamp field that can
  disagree with the first (the drift seam we are trying to kill).

## 6. The projection primitive

Each subsystem supplies only its fold; the host owns the envelope forever.

```
Projection {
  consumes   : target-glob         // e.g. "ds:2/*", "coll", "analysis"
  fold(ops)  -> state              // pure replay -> derived state (may be async: DuckDB)
  materialize?(state)              // the impure tail: build the view / paint Output
  merger     : strategy | fn       // three-way | add-wins | lww | plugin-declared
  invert?(op) -> antiOp            // undo hook; default = "re-fold without this op"
}
```

The host owns: id, HLC, ordering, merge dispatch, undo, persistence.
A projection owns: fold + merger + materialize. That is the whole contract.

## 7. How each system maps on

| System | Ops | Fold produces | Merger | Fit |
|---|---|---|---|---|
| 1 · dataset data | today's `#log` types | DuckDB view + metadata | three-way | reference impl (+ §5 clock, §9 assets) |
| 2 · dataset collection | add/remove/rename/reorder | `{ids, names, order}` | three-way | **full** |
| 4 · analysis runs | `runAnalysis{id}`, chart-model edits | run list; Output pane (materialize) | three-way (mostly disjoint adds) | **full** — merge the list + chart *model*; regenerate pixels |
| 3 · plugin data | `applyItem/removeItem/…` (opaque payload) | the plugin blob | plugin-declared (add-wins/lww) | **near-full** (§8) |
| 5 · UI/selection/presence | — none — | view state | — | **stays out, by design** |

`setActive` (which dataset is shown) is **view state, not an op** — the same call
System 1 already makes for variable *selection* (`#selected`, never logged).

## 8. Plugin data (System 3): near-full, with a documented escape hatch

Opacity is **not** a blocker for the log — it only decides *where the fold runs*.

- **Collection-shaped state (the common case; both builtins).** The plugin emits
  `applyItem{itemId, payload:opaque}` / `removeItem{itemId}`. The host folds these
  **generically** ("apply opaque item by id to a collection" needs no understanding of
  the payload) and merges them with the generic add-wins/three-way strategies. No
  sandbox roundtrip, no opacity break, **full fold-in.**
- **Genuinely unstructured state.** The fold runs *in the sandbox* (the plugin already
  executes there for rendering). Host still owns id/order/merge/undo.

**Escape hatch — kept, but documented as the bad-citizen path.** `set(blob)` remains
for some truly wild plugin we can't foresee. Crucially it is *not outside the model*:
a `set(blob)` is **one opaque op** with an `lww` merger and empty `reads[]`. So there
is exactly one model; "good citizen vs. not" is purely **op granularity** — a coding
as 200 fine-grained ops merges/undoes/orders beautifully; the same state as one blob
can only lww-clobber and can't join the dependency order. **Both builtins go
fine-grained as the reference implementations of good citizenship.**

## 9. Persistence (save-breaking is allowed — there are no users yet)

We design clean and carry **zero migration weight**:

- **The saved project is the op-log + a content-addressed asset store.** Heavy bytes
  (Parquet, media, plugin blobs) are `asset:<hash>` references *inside* ops; the log
  stays light and mergeable. (`media-store` already content-addresses — we generalise
  an existing pattern.) This also unifies **gap-fill**: "fetch a missing asset by hash"
  is one mechanism for all heavy bytes, retiring the bespoke `SourceExchange` path.
- **Drop `deterministicOpId` and the whole legacy-migration path** — it existed only
  for pre-collab saves. One id minter.
- **Drop `buildManifest`/`datasetToOps` reconstruction** — the log *is* the artifact;
  merge consumes the real ops, not a re-derived shape. A "manifest" survives only as a
  *derived* summary projection (for the catalog / room id), never as truth.
- **Drop `project.base.json` and the in-memory `#lastManifest`** — see §10.

## 10. Merge

One pass, dispatched by owner:

1. Compute the **common ancestor from the shared op-id set** (git's merge-base, by id
   intersection) — no separately-tracked base file, no fragile in-memory ancestor.
2. Partition all three logs (ancestor/mine/theirs) by **owner**; run each owner's
   strategy (core → three-way; plugin → declared) over its op subset.
3. Reassemble via the `reads[]` DAG + HLC order; collect **all** conflicts; one
   conflict UI; commit atomically.

This replaces **both** `mergeProject` and `mergeManifests` with one thing that
operates on the real log. `removeDataset` is a normal op merged by three-way, so
**deletion-as-absence is gone** and my delete-inference hack disappears.

## 11. Undo

One coordinator over one log: "invert the highest-HLC op not yet undone" via its
owner's `invert` (default: re-fold without it). This single mechanism covers dataset
edits, dataset deletes, analysis runs, **and** plugin coding/memos — the current
`UndoCoordinator`'s reason for existing (reconciling separate logs) evaporates.

## 12. Checkpoint vs. Seal (two different operations)

Load speed and history-discarding were being conflated. They are separate:

- **Checkpoint — cheap, non-destructive (the load-speed answer).** Cache a
  materialised fold-state so load starts from it instead of replaying every op.
  **Keeps every op and payload.** Zero downside: op-merge still works, undo still
  crosses it, audit is complete, **no disagreement problem** (nothing discarded). May
  be automatic on save.

- **Seal — rare, deliberate, destructive.** Checkpoint **plus discard payloads**
  before it → the "in stone, no undo past here" wall. User-invoked ("Seal project…")
  with an honest warning. Only this introduces merge risk (§13). Most projects never
  need it (it is for privacy redaction or a genuinely enormous history).

**Tombstones carry audit metadata.** A sealed op leaves
`{id, hlc, author, target, type, label}` — everything an auditor needs to *see what
was done*, minus the replayable `payload`. So a sealed region stays **legible** even
though it is no longer **rewindable**: reproducibility of the *record* survives; only
reproducibility of the *state* is traded.

## 13. Disagreeing seals (merge must tolerate them)

CrossTab is **transport-agnostic**: a bundle can fork to an offline peer we will never
know about, so "seal only when synced" is unenforceable. Merge degrades gracefully,
never forbidding, never silently corrupting:

- **Tier A — shared history still live on the merging side** → normal full op
  three-way. (The vast majority.)
- **Tier B — both sealed the *same* region** (same tombstone id-set + matching
  checkpoint content-hash) → the checkpoint state *is* a valid shared ancestor;
  op-merge each side's still-live ops on top. Lossless.
- **Tier C — sealed *different* regions** → the ancestor *state* is unrecoverable
  (payloads gone, folds differ). Surface a **"divergent sealed history"** conflict that
  uses the tombstone **audit metadata** to describe each side's sealed contents; the
  user picks a base; the other side's still-**live** ops replay on top; any op whose
  **`reads[]`** can't resolve against the chosen base **surfaces as dangling** instead
  of silently producing a wrong number.

Tier C costs the losing side's *sealed* divergent work wholesale — the irreducible
price of having discarded payloads — but the tombstone metadata makes it a
**described, consented** loss, not a silent one. Tier C is safe **only because** of two
things locked for other reasons: the audit-metadata tombstones and `reads[]`. Neither
was designed for this; both pay off here — the compounding return.

## 14. Seams this dissolves (from the audit)

- **Reconstruction seam** — merge consumes the real log; `datasetToOps` retires.
- **Deletion-as-absence** — `removeDataset` is a real merged op.
- **Unreliable ancestor** — ancestor is derived from the shared id-set; `base.json`
  (dead code) and `#lastManifest` (fragile) both go away.
- **Two orchestrators** — one merge; tested path = shipped path.
- **Gap-fill** — content-addressed assets → one fetch-by-hash mechanism.
- **Fragmented event vocabulary + re-entrant bus** — a single change signal off the
  log; a re-entrancy/cycle guard on the bus (kills the "bounce" *class*).
- **Un-undoable plugin state** — plugin ops join the one undo.

## 15. Named hard parts (not pretending they're free)

1. **Replay cost** — solved by non-destructive checkpoints (§12), possibly automatic.
2. **Pipeline-order conflicts** — the residual hard correctness area; `reads[]` + HLC
   reduce but do not eliminate the need to *surface* order conflicts.
3. **Dangling cross-references** — now *visible* via `reads[]` (a removed variable
   orphans an analysis op); defined behaviour: fold to no-op + surface.
4. **Asset GC / tombstones** for content-addressed bytes when referencing ops are
   undone or merged away (the recycle-bin already hoards deleted bytes — repurpose it).
5. **Plugin fold performance** for the unstructured-blob case (mitigated: most state is
   collection-shaped and folds host-side).

## 16. Build sequence (reviewable units; commit + test each)

1. **HLC** (`core/hlc.js`) — pure, headless-tested. ← foundation
2. **Op envelope + merge-base + `reads[]` topological order** (`core/op-log.js`) —
   pure, headless-tested. The genuinely new algorithmic pieces.
3. **The generic aggregate/projection primitive** — log + fold + undo + merge dispatch.
4. **Fold in System 2 (dataset collection)** as the first live aggregate — first
   in-browser milestone (`removeDataset` merges; delete-inference deleted).
5. **Fold in System 4 (analysis runs)** — ids + merge the list.
5b. **Output pane keyed by analysis `runId`** — output blocks are tagged with the run
   that produced them; History-delete and undo remove output BY ID (precise for
   middle-deletes), not by fragile position. Found while testing unit 5.
6. **Point merge at the real log** — DONE for the collection tier.
   - 6a: `mergeManifests` decides membership from a three-way merge of the collection
     op-log (removeDataset propagates as a real op; add/rename too). Headless-tested.
   - 6b: the real collection log is threaded through `#snapshot → buildManifest →
     ProjectStore.load → loadBundle` + the live-apply path, retiring the deterministic
     reconstruction and (for new saves) the delete-inference hack. Also fixed a
     pre-existing bug: `buildManifest` dropped `analysisLog` (analyses didn't survive
     save/reload). Single-window verified; two-window live/folder delete propagation is
     user-driven. Minor follow-up: a rename-only change applies on next save, not
     instantly live (hits the tabular-unchanged fast path).
   - Still deferred to later units: the DATA tier (System 1 per-dataset logs) still
     merges via `datasetToOps` reconstruction (faithful); `project.base.json`/
     `#lastManifest`/`deterministicOpId` retire once all tiers are on the log.
7. **Content-addressed assets**; unify gap-fill.
8. **Checkpoint** (non-destructive), then **Seal** (destructive + Tier A/B/C merge).
9. **Fold in System 3 (plugin data)** — `apply(op)` API; migrate both builtins;
   document the `set(blob)` escape hatch.
10. **Event vocabulary + bus re-entrancy guard.**

Headless (node) tests are the right verification for units 1–3 and the merge logic;
in-browser testing begins at unit 4 (live wiring).

## 17. Open / deferred

- Snapshot/compaction *policy* beyond the manual Seal (automatic checkpoint cadence).
- N>2-peer convergence proof (core case is two).
- Whether chart-model edits get their own op target or ride the analysis op.
