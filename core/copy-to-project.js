/**
 * @file copy-to-project.js
 * **Copy a thing into another project** — a dataset, or a plugin record (a codebook, a map
 * layer). Originally dataset-only — the replacement for the building-block library,
 * which was removed on 2026-10-02.
 *
 * ## Why this shape
 *
 * The library let you save a cleaned dataset as a reusable artefact and add copies of it to
 * other projects. It was removed because it could not do the job that motivated it — a block
 * is addressable only by a locally-minted UUID, so *"here is the cleaned extract for the
 * course"* was never reachable — while costing a second store, a version counter with nothing
 * behind it, and bytes held twice on the machine.
 *
 * The owner's replacement, which is the better shape for the same need:
 *
 *   *"How about as a compromise we leave behind a 'copy dataset to a new project' function?
 *   It could scan the log for any modifications on that dataset, then copy the original source
 *   plus the relevant log actions to a new project. This would give the ability to prep a
 *   dataset for distribution to students, but the cleaned data would still be in the form of
 *   'original source data + actions taken to clean it' which reproducibility likes (and which
 *   building blocks lacked)."*
 *
 * That is exactly what the one-true-log already holds. A dataset's ops ARE "the original
 * source plus what was done to it": the `load` carries the immutable Parquet, and every
 * recode, filter, compute and rename after it is a separate op. So this needs no new storage
 * format and no artefact type — it is a **slice of the log**, written as a project.
 *
 * ## What travels, and what deliberately does not
 *
 * Everything keyed to the dataset: its `coll/ds:<id>` entry (so the new project knows the
 * dataset exists and what it is called) and every `ds:<id>/…` op, including superseded and
 * undone ones. The retracted ops are kept on purpose — the liveness fold hides them, so the
 * data is identical either way, and a recipient who opens History sees the real sequence
 * rather than a tidied one. A spammy full log beats compaction.
 *
 * Nothing else: no analyses, no output, no codings or map layers, no plugin set, no sharing
 * or co-authoring identity, no project name ops. Those belong to the project you are working
 * in, not to the dataset, and a copy prepared for someone else should not smuggle them.
 *
 * ## New project, or an existing one
 *
 * The owner extended it the day after:
 *
 *   *"What about extending the ‘copy dataset’ we just built to allow copying into an existing
 *   project? It fully replaces the ‘add building block to an existing project’ functionality we
 *   no longer have. Also, once ‘copy X to existing project’ exists it can be generalized to
 *   ‘copy codebook to existing/new’ or ‘copy spatial boundaries to existing/new’."*
 *
 * Copying INTO a project is the same slice, unioned into that project’s log by op id — which
 * is what receiving a co-author’s ops already does, so it needs no new merge semantics and is
 * idempotent for free. See {@link unionById}.
 *
 * Pure: no DOM, no store, no async. `ProjectSync#copyDatasetToProject` /
 * `#copyDatasetIntoProject` apply it.
 */

import { liveOps, opIds, orderByHlc, STRUCTURAL_OPS } from './op-log.js';
import { assetRefDecls, childrenOf, childTravels } from './collections.js';
import { refsIn } from './asset-refs.js';
import { pluginTarget } from './plugin-state.js';

/**
 * Does this op belong to dataset `id`?
 *
 * Matched on the target, which is the only thing that says so. The trailing `/` matters:
 * without it `ds:1/` would claim `ds:12/`'s ops, and the copy would carry a second dataset's
 * transforms into a project that has no such dataset.
 *
 * @param {{target?: string}} op
 * @param {number|string} id
 */
export function belongsTo(op, id) {
  const t = typeof op?.target === 'string' ? op.target : '';
  return t === `coll/ds:${id}` || t.startsWith(`ds:${id}/`);
}

/**
 * The slice of a project's log that constitutes ONE dataset, in log order.
 *
 * @param {object[]} log the project's flat one-true-log
 * @param {number|string} id dataset id
 * @returns {object[]}
 */
export function datasetSlice(log, id) {
  return (log ?? []).filter((op) => belongsTo(op, id));
}

/**
 * What the slice contains, for the confirmation the user sees before it is written.
 *
 * `sources` counts ops that carry bytes (what the copy will weigh); `steps` counts the
 * transforms — "the actions taken to clean it", which is the thing being handed over and the
 * reason this is better than a binary artefact. `retracted` is reported separately rather
 * than hidden, because a count that silently included undone work would misdescribe it.
 *
 * @param {object[]} slice from {@link datasetSlice}
 * @returns {{ops: number, sources: number, steps: number, retracted: number, missingBytes: string[]}}
 */
export function describeSlice(slice) {
  // The shared liveness fold decides what survives, rather than a second reading of
  // undo/retract semantics that would drift from it. It needs HLC order, and a slice
  // arrives in the log's tier order, so sort a copy for the fold only.
  const live = new Set(liveOps(orderByHlc([...(slice ?? [])])).map((op) => op.id));
  const content = (slice ?? []).filter(
    (op) => !STRUCTURAL_OPS.has(op.type) && !String(op.target ?? '').startsWith('coll/'),
  );
  let sources = 0;
  let steps = 0;
  const missingBytes = [];
  for (const op of content) {
    if (!live.has(op.id)) continue; // superseded or undone — counted below, not carried
    if (op.payload?.src) {
      sources += 1;
      // A live source with no bytes cannot be copied: the new project would hold a `load`
      // pointing at a file nobody wrote. Happens when a co-author's op arrived ahead of
      // its Parquet. Named so the caller can refuse instead of writing a broken project.
      if (!op.payload.src.parquet && !op.payload.src.file) {
        missingBytes.push(op.payload.src.label || op.id);
      }
    } else {
      steps += 1;
    }
  }
  return {
    ops: slice?.length ?? 0,
    sources,
    steps,
    retracted: content.length - content.filter((op) => live.has(op.id)).length,
    missingBytes,
  };
}

/**
 * Build the bundle for a new project holding just dataset `id`.
 *
 * Op ids, HLC stamps and the dataset id are all **preserved, not re-minted** — the same
 * decision #166 made for record blocks, and for the same reason: op identity is the merge
 * key, so a copy that keeps it can later be recognised as shared ancestry instead of
 * duplicating everything. It also means the Parquet sidecar names (`src_<opId>.parquet`)
 * match what the source project already wrote.
 *
 * @param {object} bundle a full snapshot (`{log, activeId, …}`)
 * @param {number|string} id the dataset to copy
 * @returns {{log: object[], activeId: number|string, activePlugins: null, output: never[],
 *            analysisLog: never[], collabId: null, collabSecret: null}}
 */
export function copyBundle(bundle, id) {
  const log = datasetSlice(bundle?.log, id);
  return {
    log,
    activeId: id,
    // Explicit nulls/empties rather than omissions: a reader that sees `undefined` keeps
    // whatever it had, and this project is meant to start with none of it.
    activePlugins: null,
    output: [],
    analysisLog: [],
    // A copy is not the same co-authoring room. Leaving these null lets the new project mint
    // its own identity the first time it needs one; carrying them over would silently put two
    // different projects in one room.
    collabId: null,
    collabSecret: null,
  };
}

/**
 * Union `incoming` ops into an existing project's `log`, by op id.
 *
 * This is the whole of "copy into an existing project", and it is safe for the same reason
 * co-authoring is: the log is merged by op identity, so adding ops that the destination has
 * never seen is exactly what receiving a peer's work already does. Two consequences worth
 * stating, because they are properties rather than luck:
 *
 *  - **Idempotent.** Copying the same dataset into the same project twice changes nothing
 *    the second time — the ids are already there. (`#addRecordBlock` had to argue for this
 *    behaviour; here it falls out of the merge key.)
 *  - **Order-independent.** Ops carry HLC stamps, so where they land in the array does not
 *    decide anything; every reader folds in HLC order. Appending keeps the diff readable.
 *
 * A dataset id collision would be the one real hazard — two different datasets merged into
 * one — and it cannot happen by accident: `newDatasetId()` is 48 bits of CSPRNG precisely so
 * that two peers minting concurrently never collide. {@link datasetIdTaken} covers the
 * deliberate case anyway, because "cannot happen" is not a thing to find out by writing.
 *
 * @param {object[]} log the destination's log
 * @param {object[]} incoming the slice to add
 * @returns {object[]} a new array; the destination's own ops keep their positions
 */
export function unionById(log, incoming) {
  const have = new Set(opIds(log ?? []));
  return [...(log ?? []), ...(incoming ?? []).filter((op) => !have.has(op.id))];
}

/**
 * Does `log` already describe a dataset with this id *other than* via the ops we are about
 * to add? A true here means the copy would merge two different datasets into one, so the
 * caller refuses rather than writing something unopenable.
 *
 * @param {object[]} log the destination's log
 * @param {object[]} incoming the slice to add
 * @param {number|string} id
 */
export function datasetIdTaken(log, incoming, id) {
  const mine = new Set(opIds(incoming ?? []));
  return (log ?? []).some((op) => belongsTo(op, id) && !mine.has(op.id));
}

/**
 * Which projects can receive a copy, as `showForm` select options.
 *
 * Two exclusions, both deliberate:
 *  - **the open project** — copying a dataset into the project you are in is *duplicate
 *    within this project*, a different verb with a different name, and offering it here
 *    would make one control mean two things;
 *  - **anything not in local storage** — a folder or remote project needs its backend
 *    connected (and sometimes a user gesture) before anything can be written to it, which
 *    is a separate piece of work. Named in the UI rather than silently missing.
 *
 * @param {Array<{key: string, name: string, kind: string, projectId: ?string, isOpen: boolean}>} rows
 *   from `listAllProjects()`
 * @returns {{options: Array<{value: string, label: string}>, elsewhere: number}}
 *   `elsewhere` counts the non-local projects left out, so the form can say so.
 */
export function copyTargets(rows, { stamp = defaultStamp } = {}) {
  const offered = [];
  let elsewhere = 0;
  for (const r of rows ?? []) {
    if (r.kind !== 'opfs' || !r.projectId) {
      elsewhere += 1;
      continue;
    }
    if (r.isOpen) continue; // the project you are in — see above
    offered.push(r);
  }
  // Projects are not forced to have distinct names, and "Untitled project" happens four times
  // over in a dev session. In a DESTINATION picker that is not cosmetic: identical options are
  // unchoosable, and picking the wrong one writes into the wrong project. So duplicates — and
  // only duplicates — carry what tells them apart.
  const counts = new Map();
  for (const r of offered) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  const options = offered.map((r) => ({
    value: r.projectId,
    label: counts.get(r.name) > 1
      ? `${r.name} — ${datasetsPhrase(r.datasetCount)}, ${stamp(r)}`
      : r.name,
  }));
  return { options, elsewhere };
}

/** "2 datasets" / "1 dataset", or an honest shrug when the catalog has no count. */
function datasetsPhrase(n) {
  const count = Number(n);
  return Number.isFinite(count) && count > 0
    ? `${count} dataset${count === 1 ? '' : 's'}`
    : 'unknown size';
}

/**
 * When a project was last touched, as a short local string. Injectable so the labelling rule
 * above can be tested without depending on the test machine's locale or timezone.
 */
function defaultStamp(row) {
  const t = Number(row?.lastOpenedAt || row?.savedAt);
  if (!Number.isFinite(t) || t <= 0) return 'never opened';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return String(t);
  }
}

// --- plugin records: a codebook, a map layer, anything declared portable --------------

/**
 * Which of a record's children may travel with it, and how many were held back.
 *
 * Two declared rules do the work, and both are the plugin author's to make, not ours:
 *
 *  - **composition** — `childrenOf` gives only the collections that are PART of the
 *    parent. CAQDAS codes compose into a codebook; codings merely depend on a code, so
 *    they are not children here and never travel. That is the privacy boundary, and it is
 *    load-bearing: codings are passages of real participant data.
 *  - **scope** — `childTravels` refuses anything bound to a DATASET even if the
 *    declaration says otherwise, because such a record points at rows the recipient does
 *    not have. A mis-declared `parent` therefore stays harmless.
 *
 * Withheld children are COUNTED and returned, never silently dropped: "your codebook went
 * without 142 codings" is a thing the sender should be told, because the alternative is
 * them assuming it did travel.
 *
 * @param {Array<object>} decls normalised collection declarations (with `owner`)
 * @param {{owner: string, collection: string, id: string}} ref the parent record
 * @param {(collection: string) => Array<object>} listChildren records of a child collection
 * @returns {{take: Array<{collection: string, rec: object}>, withheld: number}}
 */
export function travellingChildren(decls, ref, listChildren) {
  const take = [];
  let withheld = 0;
  for (const kid of childrenOf(decls, ref.owner, ref.collection)) {
    for (const rec of listChildren(kid.id) ?? []) {
      // A child belongs to THIS parent only if its declared parent field says so.
      if (String(rec?.fields?.[kid.parent.field] ?? '') !== String(ref.id)) continue;
      if (!childTravels(kid, rec)) {
        withheld += 1;
        continue;
      }
      take.push({ collection: kid.id, rec });
    }
  }
  return { take, withheld };
}

/**
 * Every asset id a set of records points at, via the fields their collections DECLARE as
 * asset refs. Declared rather than scanned: the host cannot read a plugin's schema, but it
 * knows which fields hold refs, so it gathers exactly those bytes and nothing else.
 *
 * @param {Array<{collection: string, rec: object}>} records
 * @param {Array<object>} decls
 * @param {string} owner
 * @returns {string[]} unique asset ids
 */
export function assetIdsOf(records, decls, owner) {
  const byCollection = new Map();
  for (const d of assetRefDecls(decls ?? [])) {
    if (d.owner !== owner) continue;
    if (!byCollection.has(d.collection)) byCollection.set(d.collection, []);
    byCollection.get(d.collection).push(d.field);
  }
  const out = new Set();
  for (const { collection, rec } of records ?? []) {
    for (const field of byCollection.get(collection) ?? []) {
      for (const id of refsIn(rec?.fields?.[field])) out.add(id);
    }
  }
  return [...out];
}

/**
 * The ops that constitute a record copy: every `item:` op addressing one of `targets`, plus
 * the `addAsset` ops for the assets those records reference.
 *
 * Sliced by EXACT target rather than by prefix, which is the difference from the dataset
 * case: a dataset owns an address space (`ds:7/…`), while a record is one address and its
 * children are addresses elsewhere in the same tier. A prefix match would take the whole
 * collection.
 *
 * @param {object[]} log the project's one-true-log
 * @param {Iterable<string>} targets item targets to take
 * @param {Iterable<string>} assetIds asset ids whose `addAsset` ops to take
 */
export function recordSlice(log, targets, assetIds) {
  const want = new Set(targets);
  const assets = new Set([...(assetIds ?? [])].map((id) => `asset:${id}`));
  return (log ?? []).filter((op) => want.has(op.target) || assets.has(op.target));
}

/**
 * The op SPEC that tells the destination which plugin owns what it just received.
 *
 * Without it a copied codebook is rows in a tier nothing reads: the records are there, and
 * the destination has no idea it needs `builtin-caqdas` to show them. Recording it as a
 * plugin-activation op means the existing machinery does the rest — `applyProjectPlugins`
 * switches the plugin on when the project opens, and when it is not installed at all the
 * missing-plugin path (#102) remembers the association until it is.
 *
 * A SPEC, not an op: the caller's log stamps it with an id and an HLC, because a minted op
 * needs a clock and this module has none.
 *
 * @param {string} pluginKeyOrId  load key preferred; a manifest id also resolves (#157)
 * @returns {?{target: string, owner: string, type: string, payload: object}}
 */
export function ownerPluginOp(pluginKeyOrId) {
  if (!pluginKeyOrId) return null;
  return {
    target: pluginTarget(pluginKeyOrId),
    owner: 'core',
    type: 'activatePlugin',
    payload: { key: pluginKeyOrId },
  };
}

/**
 * What a record copy will carry, for the confirmation the user sees. `withheld` is the
 * number the privacy boundary held back — stated, because silence would read as "all of it
 * came".
 */
export function describeRecord({ children, assetIds, withheld }) {
  return {
    children: children?.length ?? 0,
    assets: assetIds?.length ?? 0,
    withheld: withheld ?? 0,
  };
}

/**
 * A default name for the copy. The dataset's own name, because that is what the recipient
 * is being handed; the user can rename the project in the sidebar.
 *
 * @param {string} datasetName
 * @param {string[]} taken existing project names
 */
export function copyName(datasetName, taken = []) {
  const base = String(datasetName || 'Dataset').trim() || 'Dataset';
  const used = new Set(taken.map((n) => String(n).trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/**
 * A duplicate's name: "X (copy)", then "X (copy 2)" and so on. Separate from
 * {@link copyName} because the suffixes mean different things — that one de-duplicates a
 * PROJECT name against other projects, this one says outright that a dataset is a copy of
 * the one beside it, which is the only way to tell them apart in a sidebar list.
 *
 * @param {string} name the source dataset's name
 * @param {string[]} taken names already in this project
 */
export function duplicateName(name, taken = []) {
  const base = `${String(name || 'Dataset').trim() || 'Dataset'} (copy)`;
  const used = new Set((taken ?? []).map((n) => String(n).trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${String(name).trim()} (copy ${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
