/**
 * @file dataset-copy.js
 * **Copy one dataset into a new project** — the replacement for the building-block library,
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
 * Pure: no DOM, no store, no async. {@link ProjectSync#copyDatasetToProject} applies it.
 */

import { liveOps, orderByHlc, STRUCTURAL_OPS } from './op-log.js';

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
