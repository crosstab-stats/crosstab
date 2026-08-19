# Anchors — a stable foundation for coding

Design for #166. Written after #163/#164/#165 turned out to be one fault seen three
ways, and after stress-testing the first sketch against the unified log — which broke
part of it (see *What the review changed*, below).

Companion to `ARCHITECTURE-unified-log.md`; this document assumes its vocabulary
(ops, targets, `reads[]`, folds, HLC).

---

## 1. The problem, in one sentence

A coding is a reference into data, and **the system has no concept of a reference into
data**.

Rows have identity (`__ct_rid`). Columns have names. A cell has a real log address —
`setCell` targets `ds:<id>/cell:<column>:<rid>` (data-store.js). But *a span within a
cell* has no address at all, so a coding is forced to describe its location with two
integers and hope. Everything downstream inherits that hope:

| Symptom | Underlying missing reference |
|---|---|
| edit a cell, the highlight moves (#164) | coding → passage |
| a coding can only be deleted, not adjusted (#165) | the coding's own identity across an edit |
| notes die with the coding they annotate (#165) | note → coding |
| a codebook cannot be a building block (#163) | code → codebook |
| codings cannot follow a dataset re-home (#151, still open) | coding → dataset |

Five features, one absence.

## 2. What is stored today

Established by reading, not assumed:

- **Codebooks, codes, segments are item records on the one true log** —
  `item:<owner>\0<collection>\0<id>`, written with `putItem` / `removeItem` /
  `purgeItem`, folded host-side. Not blobs. Not DuckDB tables.
- **`putItem` shallow-merges `fields`**, so two peers editing *different* fields of one
  record both survive; only a same-field collision is decided, by HLC.
- **Config** (label column, active codebook, viewport) stays a `ws:` blob. Correctly —
  it has no useful identity.
- **The coded text is neither.** It is a dataset cell: it lives in DuckDB and is
  re-derived by replaying data ops.
- Segments already carry a **stable id** minted at creation (`authored()`), and
  `syncState` already writes one op per changed record.

So identity and storage were never the problem. The problem is that the coding is a log
record, the text it quotes is a query result, and nothing expresses that one depends on
the other.

## 3. Two principles

**P1. Store what a coding *quotes*, not where it *sits*.** Position is derived.

**P2. Say what you depend on, so the log can protect you.** The causal machinery already
exists and codings simply never used it.

Everything below is these two, applied.

## 4. The anchor

### 4.0 It already exists — this completes it rather than inventing it

The first draft proposed a new host primitive. It is not new. **Core already has an
anchor**, and reading it settles most of the schema question:

```js
// memo-store.js
anchor = { kind, target, ref? }
export const cellTarget = (dsId, column, rid) => `ds:${dsId}/cell:${column}:${rid}`;
```

Its design notes say three things that matter here:

- a memo points at something **by op-log target** — "already the universal address of
  everything in the system"; no new addressing scheme was needed;
- `cellTarget` is **byte-identical to what `setCell` writes**, and the address "is valid
  whether or not anything was ever written there";
- **`ref` exists for a sub-address the target cannot express** — and the case that
  motivated it (a spreadsheet cell) turned out not to need it, because a cell *is* a
  target.

A **span within a cell** is precisely the sub-address a target cannot express: exactly
what `ref` was reserved for and has never been used for. So the primitive's first client
is core's own memos, and CAQDAS is its second — which is how "all plugins are equal"
should be satisfied: structurally, not by assertion. It also means the orphan semantics
are already designed and need no second opinion (an anchor that is binned leaves its
memo alive and flagged; purge is the point of no return).

### 4.1 The schema, generalised

```js
anchor = {
  kind:   'cell',                                  // display hint, never identity
  target: 'ds:7/cell:transcript:100000003',        // any op-log target, any tier

  // The sub-address, in `ref`. A LIST, most-robust first: each selector describes the
  // same region a different way, and resolution walks the chain (§5).
  ref: {
    selectors: [
      { kind: 'text-quote',    exact: 'we had to wait', prefix: 'she said ', suffix: ' before' },
      { kind: 'text-position', start: 412, end: 438 },
    ],
    // Integrity: what the target held when this was written. Modality-independent —
    // an asset hash for media (exact), omitted for text (the quote serves).
    expects: 'asset:b1946ac9…',
  },
}
```

Four deliberate changes from the first draft, each because a host primitive cannot be
shaped around one plugin:

1. **No `quote`/`hint` top-level keys.** They were text-specific fields wearing a general
   name. A selector *list* subsumes both, and the "cache" is no longer a special case —
   it is simply the less robust selector, later in the chain.
2. **`target` is any op-log target, not a cell.** `ds:3`, `analysis:<runId>`,
   `item:builtin\0boundarySets\0<id>`, `asset:…`. Anchoring is not a data-grid feature.
3. **`ref` must become structured.** Today it is `String(raw.ref)` (memo-store.js), and
   its one caller passes `'segment'`/`'code'` as a display hint — a misuse of the field's
   documented purpose. That hint belongs in `kind`; `ref` should carry the sub-address it
   was reserved for. Note `sameAnchor` already compares on `target` + `ref`, so two notes
   on different spans of one cell are already distinct anchors: the identity semantics
   are right before we start.
4. **`expects` replaces media-only `of`.** Integrity is not a media concept.

Declared on a collection the way `assetRefs`/`rowRefs` are, so the host can find them
without reading a schema:

```js
{ id: 'segments', label: 'Codings', anchorRefs: ['anchor'], … }
```

(`rowRefs` overlaps — an anchor at `ds:7/cell:c:R` encodes the rid too. Leave both; note
the redundancy rather than collapsing two mechanisms mid-design.)

### 4.2 Who resolves a selector — the D1 line, held

The host owns the **envelope** and a small set of **standard selector kinds**:
`text-quote`, `text-position`, `time-span`, `rect`, `row-set`. These are general media
and data selectors, not any plugin's schema, so implementing them host-side does not
breach "the host never learns the schema" (#152 D1) — the same way `labelField` names a
field without describing it.

A plugin may use a **private selector kind**. The host stores it opaquely, cannot
resolve it, and says so — an unresolvable selector degrades to "shown as recorded",
never to a guess. What the host must *not* do is accept plugin-shipped resolvers, for
exactly the reason #152 D1 rejected plugin-shipped folds: they could only run while that
plugin is activated, so staleness for a deactivated plugin's records would become
unanswerable. Same principle as [[output-outlives-its-maker]] — the artefact outlives
the code that made it.

### 4.3 What this buys other plugins

Not hypothetical — each is an existing surface with no way to express a sub-address:

- **Memos on a span** — annotate a passage without coding it. Falls out for free, and is
  the clearest proof the primitive is not CAQDAS-shaped.
- **Spatial** — a feature within a boundary set (`item:…\0boundarySets\0<id>` + a feature
  selector), rather than "the layer".
- **Run R script / do-file** — a note or a flag on a line range of a script.
- **Row sets** — "these 40 cases are the outliers" as a first-class, referenceable thing
  instead of a filter someone has to remember.
- **Analysis output** — a comment on one cell of a results table.

## 4a. Modalities — one envelope, four selectors

The plugin codes text, image regions, audio/video time spans, and keyframed video
tracks. Everything above the selector is **modality-independent**: the envelope,
resolution (§5), the edit vocabulary (§6), `reads[]` (§7), notes surviving, and the
whole of codebooks — composition, order and portability (§8, §9) — because a code does
not care what it was applied to.

What varies is one field. Generalise `quote` to a **selector**, and the shape the design
converged on is the W3C Web Annotation Model's (`TextQuoteSelector`,
`TextPositionSelector`, `FragmentSelector`, media fragments) — worth adopting the
vocabulary deliberately, both as evidence the shape is right and because the plugin
already speaks REFI-QDA/QDPX, whose media selectors map onto the same idea.

| Modality | Stored today | Selector | Identity available |
|---|---|---|---|
| text | `{start, end}` + `text` | quote `{exact, prefix, suffix}` | the text itself (fuzzy) |
| image region | `{region:{x,y,w,h}}` 0..1 | normalised rect | **asset id (a content hash)** |
| audio / video span | `{tStart, tEnd}` | time fragment | **asset id** |
| video track | `{keys:[{t,x,y,w,h}], tStart, tEnd}` | keyframed rect over time | **asset id** |

### Media is MORE fragile than text, not less

The earlier drafts of this document twice scoped media out as "normalised, so text edits
cannot touch them". That is true and beside the point. Read `loadDocs`: a media document
is *a cell whose value is a JSON array of `asset:` refs* — the same cell address as a
text document, except the cell holds a **pointer** rather than the content. So the same
`setCell` that rots a text coding can repoint a media document at entirely different
bytes.

And the failure is worse, because **no media segment records what it was coded against**.
Its `text` field is a human label (`"0:12–0:45"`), not content identity. So:

- Replace a recording with a re-encoded or trimmed copy and every time span still
  *looks* valid — `4:32` is a perfectly good coordinate in the new file, pointing at
  different content. Text at least carries a snapshot that can be compared; media
  carries nothing, so the error is not merely silent but **unverifiable**.

### …and the fix is cheaper for media than for text

Asset ids are **content hashes**. Recording one in the anchor gives media an *exact*
content identity — no fuzzy matching, no thresholds, no ambiguity tier:

```js
anchor.target   = 'ds:7/cell:recording:100000003'   // same as text
anchor.selector = { kind: 'timespan', tStart: 272, tEnd: 305 }
anchor.of       = 'asset:b1946ac9…'                 // exact content identity
```

Resolution for media is then two lines: `of` matches the cell's current ref ⇒ `exact`;
it does not ⇒ `drifted`, coding preserved and flagged, user decides. Cheap, honest, and
strictly better detection than text can manage. A duration check (coded span extends
past the new asset's length) is a free extra certainty.

**Latent gap while we are here:** `refs` is a list ("list-shaped even for a single
clip") but a segment records no ref index and `renderMedia` always loads `refs[0]`. A
multi-clip row therefore cannot express which clip a coding belongs to. `of` fixes this
by construction — it names the asset rather than a position in a list.

## 5. Resolution — a pure function, and a view

```
resolve(anchor, text) → { start, end, confidence }
```

| Order tried | Result |
|---|---|
| `exact` sits at `hint` | `exact` — nothing moved |
| exactly one occurrence of `exact` elsewhere | `moved` — re-anchor silently |
| several occurrences, one matching `prefix`/`suffix` | `moved` |
| several, none disambiguated | `ambiguous` — nearest to `hint`, flagged |
| fuzzy match over threshold | `drifted` — flagged for review |
| nothing | `orphaned` — keep the coding, its code and its notes; offer manual re-anchor |

Two rules that are the whole discipline:

**R1 — resolution NEVER writes.** It is a pure function of `(anchor, text)`, computed at
render. The plugin holds a hard-won rule that mounting a workspace must never write
state, and that opening the Coding tab and closing it must leave no trace. Auto-repair
on read would append a put per drifted segment because someone *looked* — filling
History with edits nobody made, and in a shared project having every peer write its own
repair. `hint` is a cache; recomputing a cache is not an edit.

**R2 — a coding is never deleted to resolve an anchor.** An orphan keeps its code, its
quote and its notes, and becomes a visible task the user can act on. Losing an analytic
judgement because a transcript was re-imported is not an acceptable failure mode.

Writes happen only on user intent: adjusting a coding, or an explicit *Repair drifted
codings* action that shows what it will do first.

## 6. Operations — the vocabulary, and the death of the array diff

Today the UI mutates arrays and a debounced `syncState` diffs the whole collection
against a snapshot. That is blob-thinking on record storage, and it costs three things
at once: the log records *states* rather than *intents*, every write is a whole-record
put (so unrelated concurrent edits collide), and the diff is O(all segments) per save.

Replace it with narrow, intentional writes:

| Operation | Writes | Was |
|---|---|---|
| `reanchor(segId, anchor)` | `{anchor}` | delete + re-create |
| `recode(segId, codeId)` | `{codeId}` | delete + re-create |
| `annotate(segId, …)` | memo record | (unchanged) |
| `removeCoding(segId)` | `removeItem` + cascade §8 | leaked its notes |

No new op types — each is a `putItem` with narrow fields. The gain is that `putItem`
shallow-merges, so one coder adjusting a boundary and another changing the code now
**both survive** instead of one silently losing.

**Notes survive because identity survives.** That is the whole of it: there is no
separate mechanism for note preservation, only the refusal to implement an edit as a
delete plus a create.

## 7. What the log gives back, once an anchor declares `reads[]`

An op's `reads[]` is the causal constraint, and item ops currently append with **no reads
at all**. Because `anchor.target` *is* the `setCell` target, declaring the dependency is
a one-line change:

```js
reads: [anchor.target]   // 'ds:7/cell:transcript:100000003'
```

**Correction to the first draft.** It claimed this makes reordering and merge hazards
surface "using machinery already written and tested". Reading `unresolvedReads()` says
otherwise, in two ways, and both need building:

1. **Exact matching produces a false-positive storm.** The function matches read targets
   to writer targets *exactly*, and its own NB says prefix/relational matching — "a read
   of `ds:2/var:income` satisfied by the `load` that created the dataset" — is a
   deliberate later refinement. A coding on a cell nobody ever edited (its value came in
   with the source load) has no exact writer, so **every such coding reports as
   unresolved on every merge**. Anchors are exactly the use case that motivates building
   the ancestor rule: a read is satisfied by a writer at or above it in the address path.
2. **"Unresolved" is the wrong question for drift.** It asks *is a writer missing before
   me*. Drift asks *does a writer of a target I read appear after me* — and once the
   ancestor rule exists, a load always satisfies the read, so the reorder signal is
   drowned rather than raised. That is a **new projection** over the same data
   (`reads[]` + op order). Small, but it is new code, not a free ride.

What `reads[]` genuinely gives, immediately and for nothing, is the **declaration** —
without it neither query is possible at all, and the dependency is invisible to every
tier. With it:

- **Reordering data steps** in Syntax mode past a coding becomes *answerable*.
- **Retracting** a `setCell` a coding depends on becomes traceable.
- **Merging** a peer's text edit against local codings can be reported.

The column-and-row granularity is right: an op touching a *different* cell is no threat
and produces no noise.

## 8. Containment and dependency — two relations, never one

- **Composition** — codes compose into a codebook. They travel with it and cascade with
  it. Declared `parent: { collection: 'codebooks', field: 'codebookId' }`.
- **Dependency** — a coding depends on a code; a note depends on a coding. Cascades on
  delete, **never travels**.

Conflating them is not a tidiness question. A shared codebook that carried its codings
would carry passages of real participant data into an object whose entire purpose is to
be handed to other people. Two barriers: only a declared `parent` composes, and a
dataset-scoped child never travels into a project-scoped block.

The host already **detects** orphaned notes (`memoStore.orphans(memoAnchorExists)`) and
surfaces them in the sidebar; what is missing is the cascade on delete. The detector
stays as the backstop.

## 9. Order

"Codebook order = layer order" decides which code's colour wins where highlights
overlap — yet order is only the incidental order records come back in, and the item tier
has no reorder op.

Give each code a **fractional sort key** (a string/float ordered between its neighbours).
Inserting between two codes writes one field on one record, which the per-field merge
already handles: two peers inserting concurrently get different keys and both survive,
where a reorder op over an array would have to be merged wholesale. It also survives the
promote/add round-trip in §8 without further work.

## 10. Re-home falls out (#151's remaining half)

Moving codings from dataset A to B is unsolved today because segments anchor on
`__ct_rid` and a re-exported file re-bakes those ids. Under this design a re-home is:
rewrite `anchor.target`'s dataset segment, then resolve by `quote` — content-first
matching is *exactly* the match-by-key fallback that entry asked for, and it works
precisely when row ids do not. `anchorRefs` lets the host do it generically, the way
`rowRefs` already declares remappable row ids.

## 11. No migration — owner's call (2026-08-19)

**Saved projects and saved library blocks may break. Build the new shapes correctly and
do not carry the old ones.** CrossTab is pre-release and says so on its front door; the
cost of a back-compat path here is a permanent second code path through the most
delicate logic in the system, paid forever to preserve data from a design we have just
established was wrong.

Concretely, all of this is **deleted from the plan**, not deferred:

- reading legacy segments `{doc, start, end, text}` and synthesising an anchor;
- backfilling `prefix`/`suffix` for anchors that never had them;
- a record-block loader that accepts the old fields-only shape alongside ops.

Old codings and old blocks are expected to stop working. Write the new code as if the
old shapes never existed, which is also what keeps `resolve()` a clean pure function
instead of one with a legacy branch.

### One thing that looks like migration and is not

Dropping legacy support does **not** dispose of Risk A (§13a). The
`String(raw.ref)` / `String(a.ref ?? '')` collapse in `normalizeAnchor` / `sameAnchor` is
a **live correctness bug in the new code**: pass a selector object through today's core
and every span anchor on one cell compares equal to every other, silently. That must be
fixed whether or not anything legacy is honoured. What the decision *does* remove is only
the "keep accepting a string ref" half — and with it, CAQDAS's current
`ref: anchorKind` caller must move to `kind` in the same change rather than being left
working by accident.

## 12. Sequencing — SHIPPED (2026-08-19)

All four steps are built, with tests. What landed, and the three things worth knowing:

- **`core/anchors.js`** is the primitive: selector normalisation, `resolveAnchor()` with
  the confidence ladder, and `textRef`/`mediaRef` builders. Pure and exported, so the
  risky half of this design is covered by `npm test` and only the iframe chrome needs a
  human.
- **Core's memo anchor now takes structured refs**, so notes-on-a-passage work; a plain
  string ref still does.
- **`anchorRefs` / `parent` / `onConcurrentEdit`** join `assetRefs`/`rowRefs` as things a
  collection declares once and every generic host behaviour reads.
- **`reads[]` is DERIVED** from `anchorRefs` in the host's item service — a plugin never
  writes one. Any plugin that anchors into data gets drift detection on the same terms.
- **`readAncestors` + `staleReaders`** in op-log, the two pieces §7 says did not exist.
- **CAQDAS**: anchors on every modality, resolve-at-render with an amber banner,
  re-anchor/recode, note cascade, narrow writes, fractional code order, QDPX both ways.
- **Record blocks carry their composed children and keep record ids**, so a codebook is
  portable and a later pull has identity to match on.

**Verified in the browser** (localhost dev server, demo-qual, 2026-08-19), not only in
node — the tests cover the pure half, so the wiring needed its own check:

| Checked | Result |
|---|---|
| `resolveAnchor` through a real `import()` | exact / moved / orphaned / media-swap all correct |
| **the original bug**: code a passage, then `setCell` text in front of it | coding follows; still covers exactly its own words |
| the op's derived `reads[]` | `ds:<id>/cell:response:<rid>` — the real cell address |
| `staleReaders` over the real project log | reports that one coding, names the `setCell` that did it |
| `unresolvedReads` over the real log | **zero** false-positive dangling reports |
| switching into the Coding tab | writes **zero** ops — mount-never-writes holds, though resolution now runs on every document load |
| console | no plugin or anchor errors |

Three honest notes:

1. **The save-cost prediction was wrong** — 1.4×, not ~0. See §13's measurements.
2. **`resolveAnchor` takes a `ref`, not an anchor.** Passing the whole anchor makes every
   coding silently `unresolvable`; a test caught it, and it is the kind of mistake this
   API shape invites. Worth a second look if resolution ever goes quiet.
3. **Per the owner's call there is no migration**: old codings and old record blocks stop
   working rather than being carried (§11).

The original plan, for reference. Each step was useful alone and none blocked the next.

1. **Tell the truth** — `resolve()` at render, staleness surfaced, memo cascade on
   delete, `labelField: 'text'` on segments so History says *which* coding.
2. **Edit vocabulary** — narrow `reanchor`/`recode` writes; retire the array diff.
   Kills #165 and the collide-on-every-field bug. Modality-independent: adjusting a time
   span is the same operation as adjusting a text span.
3. **Anchors** — the envelope, `anchorRefs`, migration, `reads[]`. Do the **media `of`
   field first**: it is a hash comparison against work already done (§4a), where text
   needs the quote/fuzzy ladder. The cheap half also buys the more dangerous fix.
4. **Composition + order** — `parent`, cascade, sort keys, codebook promote (#163).
   Entirely modality-independent; a codebook does not know what it codes.

## 13. Open — owner's calls

- **~~Copy vs link for a shared codebook.~~ Badly posed — corrected by the owner.**
  There is no dichotomy: datasets already do **both**, and that model is the precedent to
  follow rather than a fork to choose. `addBlockToProject` takes a **copy**; `libraryLink
  = {id, version, baseLen}` records provenance and a **pinned version**; the sidebar shows
  `v3` and switches to a clickable `↑v5` only when the block advances; `pullLatest`
  re-homes the block's recipe and **re-applies local changes on top**. A block changing
  never forces anything on a project — the update is offered, not applied.

  So a codebook should be a copy with a pinned link and an opt-in pull, same as a
  dataset. What is genuinely open is the three things that **do not transfer**, none of
  which the dataset model ever had to solve:

  1. **Id re-minting defeats a later pull.** `#addRecordBlock` deliberately re-mints
     record ids so a copy is self-contained and nothing dangles if the library entry is
     deleted. Datasets do not care — a pull replays the whole recipe. A codebook pull
     must match *my* code to *the block's* code, so each copied record needs a
     provenance field (`origin: {blockId, recordId}`) that datasets never needed. The
     re-mint that makes the copy safe is exactly what makes the pull impossible without
     it.
  2. **`baseLen` is recipe-shaped; a codebook block is a snapshot.** Two different
     merges were conflated in the first draft, and they need separating:

     - **Peer-to-peer collaboration merge is already solved, and needs no codebook
       merger.** Two peers share an op lineage, so the item tier unions ops by id and
       resolves same-record collisions per field by HLC. Ops make this easy exactly as
       one would hope.
     - **A library pull is not that**, because *there is no shared lineage to merge
       along*. A **dataset** block stores `ds.exportState()` — an op recipe — which is
       why `pullLatest` can replay it and slice local changes off the end. A **record**
       block stores `{name, savedAt, record: {owner, collection, fields}, assets}`: a
       fields snapshot, no ops. And `#addRecordBlock` re-mints every id on add. So a
       codebook copy and its block share no op ids, no ancestor, and no identity.

     **Content matching is not the way out.** Unioning codes whose names are
     byte-identical is wrong in *both* directions:

     - *It splits what is the same.* Block v1 ships code X "happy". I add it, work a
       term, rename it "positive affect" across 200 codings; upstream renames X to
       "joy". Content matching sees two unrelated codes and creates both — the codebook
       now carries a duplicate construct, and every later analysis splits across it.
       Renaming is not an edge case here: rename/recolour/retheme are the codebook
       manager's headline actions.
     - *It fuses what is different.* A code is `{name, color, group, memo, …}`, and the
       memo **is the dictionary definition**. Two researchers' "Resistance" with
       different definitions are different constructs; pooling their codings is a
       validity error, not a data glitch — and it is undetectable afterwards. This is
       the same silent-discard the per-coder segment design exists to prevent.

     **DECIDED: a record block carries its ops**, exactly as a dataset block already
     does. A pull then collapses into the peer merge that is already solved, and the
     `origin: {blockId, recordId}` stamp is not needed — it was only ever a way to
     reconstruct by hand the identity that ops preserve for free.

     Three consequences, one of them a genuine bonus:

     - **Two projects that adopt the same codebook now merge cleanly.** They share the
       block's op ids, so `sharedAncestor` (an id-set intersection) recognises the
       codebook as common ancestry instead of seeing two unrelated sets of codes. Under
       re-minting, two teams adopting one codebook and later collaborating would have
       produced a duplicate of every code. This falls out of the decision and is worth
       more than the pull it was chosen for.
     - **The self-containment rationale still holds.** `#addRecordBlock` re-mints "so the
       copy is self-contained and nothing dangles if the library entry is deleted" — with
       ops the records live in your log just the same, so nothing dangles either way.
     - **Adding the same block twice stops producing two copies**, because the ops are
       already present and immutable. That is the correct default (adding one codebook
       twice should not double it); wanting a divergent copy is a *duplicate codebook*
       action inside the project, not a second add. This is the only thing re-minting was
       genuinely buying.

     Two implementation notes: record blocks are **generic**, so this changes the path
     `builtin-spatial`'s boundary sets already use — they gain pull-updates too, but
     blocks saved under the old shape have no ops, so the loader must accept both. And
     replayed ops carry their originating HLC stamps, which is right (the block's history
     *is* older) but means a locally-authored code can sort before an adopted one.

     Content matching survives only as the honest fallback where identity genuinely does
     not exist: **CSV codebook import**, which has no ids by construction.
  3. **A pull can orphan codings — no dataset analogue.** If the block dropped a code I
     have applied 200 times, the pull must say so and let me decide; silently orphaning
     200 codings is the worst outcome available. §8's dependency cascade is what gates
     this, which is another reason it precedes portability in the sequencing.
**All three settled by the owner, 2026-08-19.** Recorded here with what each one costs.

**Concurrent re-anchor → surface it in the conflict UI.** Note where the work actually
is: this is not a dialog hookup. Core-owned items merge through `threeWayLog` and *do*
surface a same-record add/add conflict — but **plugin-owned items take
`collab-sync.mergeProjects`'s per-owner branch, union every op by id, and never reach a
merger at all** (item-store.js merge notes), which is exactly why a boundary
disagreement resolves silently today. Surfacing it means teaching that branch to detect
concurrent same-record, same-field writes.

And that must not be made universal, or it changes behaviour for every existing plugin —
`builtin-spatial` merges LWW deliberately, and turning its polygon edits into conflict
prompts would be a regression. So it wants to be **declared per collection**, in the same
place everything else about a collection is declared:

```js
{ id: 'segments', …, onConcurrentEdit: 'surface' }   // default stays 'lww'
```

**Codings in Syntax → one rolled-up "coding session" line; the log stays fine-grained.**
Presentation aggregation only: every coding remains its own op, so per-coding undo/redo
inside the plugin is untouched. Two things to get right:

- *Session boundaries need a rule.* Proposal: a contiguous run of one author's coding ops
  on one document, broken by a time gap or by an intervening op of another kind. History
  keeps showing them individually (`itemHistory` already does) — two views at two
  granularities is the point, not an inconsistency.
- *A rollup is not lossless, and the do-file editor is.* Syntax mode round-trips the
  timeline as editable text; a line standing for 40 codings cannot be edited back into
  them. So the session line must be a **marker that `Run` ignores** — it shows what
  happened and where in the timeline, and deleting it does nothing. Codings are edited in
  the Coding tab, which is the only place that can express them. Anything else would
  quietly make the do-file lossy, or make deleting a line delete a term's coding.
  **DEFERRED past this rebuild** (owner, 2026-08-19): scripting codings does not really
  make sense in the first place, so the Syntax view may want a broader adjustment than a
  marker line. Nothing else here depends on it — the log stays fine-grained regardless,
  which is the part that matters.

**Scale → `scripts/log-stress.mjs`, and the BEFORE baseline is taken.** A benchmark, not
a `npm test` assertion (timing tests are flaky and would slow the suite). Run
`node scripts/log-stress.mjs [sizes…]`. Measured on today's code, node 24, desktop:

```
   500 codings │ append   9.5ms │ fold  1.2ms │ refold  1.2ms │ diff   2.6ms │ merge  2.6ms │ log   236KB
  2000 codings │ append  10.5ms │ fold  3.0ms │ refold  1.7ms │ diff   7.9ms │ merge  4.7ms │ log   946KB
 10000 codings │ append  35.9ms │ fold 14.5ms │ refold  8.3ms │ diff  48.9ms │ merge 38.3ms │ log  4734KB
 25000 codings │ append  48.4ms │ fold 37.8ms │ refold 26.2ms │ diff 105.8ms │ merge 91.5ms │ log 11852KB
```

**Three readings, none of them the one that was feared.**

1. **Nothing is super-linear.** Flat at ~1.5µs/coding to fold from 2k to 25k. The spammy
   log is not a scaling trap; the explicit-ops decision is vindicated on performance as
   well as on principle.
2. **The single biggest cost is the one step 2 addresses — but not to zero.** Saving
   *one boundary nudge* cost 106ms at 25k codings, nearly 3× the whole fold, because
   `syncState` re-cloned every record to rebuild its shadow. **Measured after the
   rebuild: 103ms → 75ms, about 1.4×.** The prediction above ("should go to ~0") was
   wrong and is left standing as written: removing the wholesale re-clone removed the
   *extra* cost, but the O(N) scan remains, because the plugin still diffs its in-memory
   array on save. Driving it to ~0 needs writes issued at each mutation site rather than
   derived by diffing — deliberately not done, since it means rewriting ~40 call sites
   to save 75ms on a 25,000-coding corpus. The correctness half of step 2 (narrow ops, so
   two coders' edits stop colliding) landed in full and was always the point.
3. **The real ceiling is bytes, not time: 485 bytes per coding, flat.** A 25,000-coding
   project carries an **11.8 MB** log. Op envelope plus a full author stamp
   (`authorId`/`initials`/`name`/`color`) repeated on every op is most of it. Worth a
   look during the rebuild — not by compacting the log (that trade was already refused),
   but by not repeating what does not vary.

**Caveat, stated because "every device" is the promise:** desktop node on a fast
machine. A tablet or a low-end Chromebook can run 3–5× slower, which puts a 25k-coding
project at roughly 150ms per refresh and half a second per save *before* the step 2 fix.

Re-run the same script after the rebuild for the after-number.

## 13a. Readiness — what is actually settled

**Ready to build now, nothing outstanding:** steps 1 and 2. Resolution-as-a-view,
staleness reporting, the memo cascade, `labelField`, and the narrow-write edit
vocabulary are fully specified and depend on no open question. They are also where the
user-visible damage is.

**Ready, with a named cost:** step 3. Two pieces of *new* log-layer code, neither free
and both small: the **ancestor rule** for read-target matching, and the **drift
projection** ("does a writer of a target I read appear after me"). Budget them
explicitly rather than discovering them.

**Ready:** step 4. The lineage question is **decided** — a record block carries its ops
(§13.2) — and per §11 the loader carries the new shape only; blocks saved under the old
fields-only shape stop loading. It does change the *generic* record-block path that
`builtin-spatial`'s boundary sets use, so re-save any block worth keeping. No open design
question remains here.

**Nothing is open.** The last three were settled by the owner on 2026-08-19 (§13):
conflict-UI surfacing for concurrent re-anchors — declared per collection so existing
plugins keep LWW; a rolled-up, `Run`-ignored "coding session" marker in Syntax with the
log staying fine-grained; and a `log performance` stress harness after the rebuild.

### Two risks that were not on the open-questions list

**A. `ref` must become structured before anything writes one, or it fails silently.**
`normalizeAnchor` does `out.ref = String(raw.ref)` and `sameAnchor` compares
`String(a.ref ?? '')`. Pass a selector object through that today and it stringifies to
`"[object Object]"` — so **every span anchor on one cell compares equal to every other**,
memos merge into one thread, and nothing throws. This survives the no-migration decision
(§11) untouched: it is a live correctness bug in the *new* code, not a legacy concern.
Fix `normalizeAnchor`/`sameAnchor` first, and move CAQDAS's `ref: anchorKind` caller
(index.js:2300) to `kind` in the same change so nothing is left working by accident.

**B. The UI is the least testable code in the project — but the pattern is proven.**
The CAQDAS interface lives in a sandboxed opaque-origin iframe nothing outside can
drive, which is why #151 shipped needing human verification. The mitigation is already
established practice here: `test/caqdas-codebooks.test.mjs`, `caqdas-merge.test.mjs`,
`caqdas-codebook-manager.test.mjs` and `caqdas-qdpx-import.test.mjs` all test exported
pure functions in node. So **`resolve()`, selector matching, and the pull merge must be
pure exported modules**, not closures inside `mount()` — that is what keeps the risky
half of this design covered by `npm test` and leaves only the iframe chrome for
hand-verification.

## 14. Deliberately not done

- **Locking coded documents** (NVivo's historical answer). Our documents are dataset
  cells and the dataset is editable by design; forbidding a typo fix to protect a
  highlight is a guard standing in for a missing capability. We reconcile instead.
- **Mapping offsets at edit time.** A diff-and-remap hook on `setCell` fixes one of the
  ways text changes — it also changes by re-import, swap-in, transform, merge and
  History replay. Read-time resolution is indifferent to *how* the text moved, which is
  what makes it a foundation rather than a patch.
- **Hierarchical codes.** `group` already gives a codebook flat themes. Revisit on
  request, not on speculation.
- ~~**Media anchors.**~~ **Withdrawn — see §4a.** This was listed as out of scope twice
  on the reasoning that normalised regions and time spans cannot be touched by a text
  edit. True, and beside the point: a media document is a cell holding asset *refs*, so
  the same `setCell` repoints it at different bytes, and media records no content
  identity at all. It is the more fragile modality and it is in scope.

---

## What the review changed

Three corrections, each found by pushing the design at something rather than by
re-reading it. Kept because each was invisible until the specific question was asked.

1. **"Reconcile at read" contradicted "make every re-anchor an explicit op."** Automatic
   reconciliation that writes turns opening a tab into an edit — against a
   mount-never-writes rule the plugin had already learned the hard way. R1 resolves it:
   resolution is a view; only user intent writes.
2. **Media was scoped out twice, and is the more fragile modality** (§4a). A media
   document is a cell holding asset *refs*, so the same `setCell` repoints it at
   different bytes — and unlike text it records no content identity at all, making the
   error unverifiable rather than merely silent.
3. **The anchor was not a new primitive, and `reads[]` was overclaimed** (§4.0, §7).
   Core's memo anchor is the same thing, with `ref` already reserved for exactly this
   sub-address case; and `unresolvedReads` needs both an ancestor rule and a new
   drift projection before it reports what the draft said it already reported.

The pattern worth noting: every correction came from asking "does this hold for someone
other than CAQDAS?" — the modality question, the all-plugins-are-equal question, and the
does-the-log-really-do-that question. None came from reviewing the design on its own
terms.
