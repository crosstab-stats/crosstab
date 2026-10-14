/**
 * @file timeline.js
 * The **timeline**: one ordered, numbered list of what the user did, and the single
 * place that decides what that order is.
 *
 * ## Why this module exists
 *
 * A project's history lives in the one true log as three tiers - the data pipeline
 * (`ds:<id>/...`), the analysis runs (`analysis:<runId>`), and the item records
 * (`item:...`). Reading them back as ONE list is the thing every user-facing view of
 * history needs, and until this module it was done four separate times: the History
 * panel, `crosstab-syntax`'s `bodyLines`, its per-dataset `serializeProject`, and the
 * Syntax gutter. Four copies of one rule is four chances to disagree, and they did -
 * the panel and the semantics drifted apart badly enough that reordering an analysis
 * moved it two rows and left the list describing something the data did not do.
 *
 * Worse, the copies interleaved on TWO different coordinate systems at once: a data row
 * was numbered by its index among *all* applied steps (loads included), while an
 * analysis was placed by `at`, a count of *transforms only*. Two axes, reconciled by
 * hand, is the root of every History defect the owner reported (#191).
 *
 * So: one producer, several readers. A row's name is part of that - the Edit menu needs
 * the same words the History panel uses in order to say what Undo would undo - which is
 * why {@link describeStep} lives here rather than inside the view that draws it.
 */

import { stripEllipsis } from './text.js';
import { readAncestors } from './op-log.js';

/**
 * Op types that count as a data **transform** for positioning.
 *
 * There were THREE of these sets, and they disagreed - which is a bug, not untidiness.
 * `crosstab-syntax` counted nine types, the History panel counted five (no `dropVars`,
 * `keepVars`, `renameVar` or `setWeight`), and `data-store`'s `DATA_OPS` counted eight.
 * An analysis's position was GENERATED with one of them (`getTransforms().length`),
 * DRAWN with another and SERIALISED with a third, so after a drop or a weight the three
 * views of one history disagreed about where an analysis belonged - and the script a Run
 * replayed put it somewhere the panel never showed it.
 *
 * `setWeight` is in the list on purpose: weighting changes what the next Frequencies
 * reports, which is exactly what "the data this analysis describes" means.
 */
export const TRANSFORM_TYPES = new Set([
  'setVariable', 'setCell', 'computeVar', 'recodeVar', 'filterCases',
  'dropVars', 'keepVars', 'renameVar', 'setWeight',
]);

/** Ops that bring data in rather than change it. They replace the whole dataset, so for
 * anchor matching they count as a write to the aggregate root (see {@link attachRecords}). */
const SOURCE_OP_TYPES = new Set(['load', 'append', 'join']);

/** The id a timeline row is addressed by: an op id for a data step, the runId for an
 * analysis. One id space, so a single `reorder` payload can name any row. */
const rowId = (r) => (r.kind === 'data' ? r.step.id : r.entry.runId);

/**
 * Interleave analyses into the data steps by their RECORDED `at` - the seed order.
 *
 * This is the rule the four old copies implemented, kept in exactly one place and used
 * for exactly one purpose: to establish an initial order for a project that has never
 * been reordered. Once the user moves anything, an explicit order op supersedes it and
 * `at` stops being an input at all (it is then derived - see {@link buildTimeline}).
 */
function seedOrder(steps, analyses) {
  const byAt = new Map();
  analyses.forEach((entry, srcIndex) => {
    const k = Number.isFinite(entry.at) ? entry.at : Infinity;
    if (!byAt.has(k)) byAt.set(k, []);
    byAt.get(k).push({ kind: 'analysis', entry, srcIndex });
  });
  const seq = [];
  const flush = (k) => { for (const r of byAt.get(k) || []) seq.push(r); byAt.delete(k); };
  let flushedZero = false;
  const flushZero = () => { if (!flushedZero) { flush(0); flushedZero = true; } };

  let transforms = 0;
  steps.forEach((step, srcIndex) => {
    const isTransform = TRANSFORM_TYPES.has(step.type);
    // Analyses run before any transform sit after the SOURCES, not above them: an
    // analysis of freshly imported data describes the import, and nothing can precede it.
    if (isTransform) flushZero();
    seq.push({ kind: 'data', step, srcIndex });
    if (isTransform) { transforms += 1; flush(transforms); }
  });
  flushZero(); // (a dataset with no transforms at all)
  // Anything positioned past the last transform, or never positioned, goes at the end.
  for (const k of [...byAt.keys()].sort((a, b) => a - b)) flush(k);
  return seq;
}

/** Apply an explicit order, stably: rows it does not name keep their seed order AFTER
 * the ones it does. Same rule as the data fold's `reorder`, for the same reasons - an
 * order written before a row existed still means what it said, and a stale id for a
 * removed row is simply ignored. */
function applyOrder(seq, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return seq
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ra = rank.has(rowId(a.r)) ? rank.get(rowId(a.r)) : Number.POSITIVE_INFINITY;
      const rb = rank.has(rowId(b.r)) ? rank.get(rowId(b.r)) : Number.POSITIVE_INFINITY;
      return (ra - rb) || (a.i - b.i);
    })
    .map(({ r }) => r);
}

/**
 * Place each record under the timeline row it annotates.
 *
 * A record is not a step — nothing re-runs a memo to reproduce the data — so it gets no
 * number and is not a cursor position. What it does have is an ANCHOR, which is an op-log
 * target, and the row that wrote (or contains) that target is the row it belongs to.
 *
 * The match is by address path, so `ds:3/cell:age:17` is satisfied by the step that edited
 * that very cell if there is one, and otherwise by the import that brought the column in.
 * The LAST matching live row wins: a note about a cell belongs under the most recent step
 * that touched it, which is the one a rewind past it would undo.
 *
 * This is what makes the owner's case work — a memo on a chart travels with the chart,
 * instead of being orphaned when the chart is withdrawn or silently dropped by the redo
 * that brings the chart back.
 *
 * @param {object[]} rows @param {object[]} records
 * @returns {object[]} rows with each record spliced in after its parent; unanchored
 *   records (a project note) come last, in their own group, parented to nothing.
 */
function attachRecords(rows, records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return rows;

  // Address -> the last row that wrote it, so a later edit to a cell wins over the import.
  const writers = new Map();
  for (const row of rows) {
    if (row.kind === 'analysis') { writers.set(`analysis:${row.id}`, row); continue; }
    if (row.kind !== 'data' || !row.step?.target) continue;
    writers.set(row.step.target, row);
    // A SOURCE op replaces the whole aggregate, yet its address (`ds:3/source:<tok>`) is a
    // SIBLING of the cells it brought in rather than an ancestor of them — the exact case
    // `staleReaders` documents and solves by promoting such a write to its aggregate root.
    // Without the same promotion here, a note on a cell nobody has edited since the import
    // has no writer to hang off and would be filed as "not about a step", which is untrue:
    // it is about data the import created.
    if (SOURCE_OP_TYPES.has(row.step.type)) {
      const anc = readAncestors(row.step.target);
      const root = anc[anc.length - 1];
      if (root) writers.set(root, row);
    }
  }
  const parentOf = (target) => {
    for (const addr of readAncestors(target || '')) {
      const hit = writers.get(addr);
      if (hit) return hit;
    }
    return null;
  };

  const under = new Map(); // parent row id -> records
  const loose = [];
  for (const rec of list) {
    const parent = parentOf(rec.anchorTarget);
    if (!parent) { loose.push({ ...rec, parentId: null }); continue; }
    const key = parent.kind === 'start' ? 'start' : parent.id;
    if (!under.has(key)) under.set(key, []);
    under.get(key).push({ ...rec, parentId: parent.id });
  }

  const out = [];
  for (const row of rows) {
    out.push(row);
    const mine = under.get(row.id);
    if (!mine) continue;
    for (const rec of mine) out.push({ ...rec, kind: 'record', n: null, live: row.live });
  }
  for (const rec of loose) out.push({ ...rec, kind: 'record', n: null, live: true });
  return out;
}

/**
 * The timeline: one ordered, numbered list of rows covering the data pipeline and the
 * analyses run against it.
 *
 * **The number IS the cursor.** Row `n` means "the recipe up to and including this row",
 * so clicking it and rewinding to it are the same coordinate. The old panel secretly used
 * two: a data row was numbered by its index among all applied steps (loads included)
 * while an analysis was placed by `at`, a count of transforms only. Everything downstream
 * of that mismatch - arrows that moved two rows, a position that disagreed with the list,
 * a rewind that passed analyses by - came from reconciling the two by hand.
 *
 * **`at` is DERIVED**, never read back from the entry except to seed a never-reordered
 * project. An analysis's `at` is the number of transforms above it in this list, so the
 * order shown and the data an analysis describes cannot drift apart: there is one fact.
 * {@link staleAnalyses} reports the rows whose stored `at` no longer matches, which is
 * precisely the set a caller must re-run after a move.
 *
 * @param {{steps?: object[], future?: object[], analyses?: object[], order?: string[]|null}} input
 *   `steps` are the dataset's live data steps in fold order; `future` the undone ones;
 *   `analyses` the entries ALREADY scoped to this dataset; `records` the live annotations
 *   (each with an `anchorTarget`); `order` the latest applied timeline `reorder` payload.
 * @returns {{rows: object[], ids: string[]}}
 */
export function buildTimeline({
  steps = [], future = [], analyses = [], futureAnalyses = [], records = [], order = null,
} = {}) {
  const order_ = Array.isArray(order) && order.length ? order : null;
  const place = (seq) => (order_ ? applyOrder(seq, order_) : seq);
  // Applied rows first, then the ones below the cursor. The partition is what makes the
  // list linear: an undone row is always drawn after every applied one, which is also
  // where a redo now puts it back (see the retract-on-new-action discard).
  const liveSeq = place(seedOrder(steps, analyses));
  const aheadSeq = place(seedOrder(future, futureAnalyses));

  const rows = [];
  // Row 0 is a real cursor position, not decoration: rewinding to it is "before any data".
  rows.push({
    n: 0, kind: 'start', id: null, live: true, title: 'Start',
    detail: 'empty — before any data', dataCount: 0, at: 0,
  });

  let n = 0;
  let transforms = 0; // how many TRANSFORM_TYPES rows are above the row being built
  let dataCount = 0; // how many data steps are at or above it (the rewind coordinate)
  const emit = (seq, live) => {
    for (const r of seq) {
      n += 1;
      if (r.kind === 'data') {
        dataCount += 1;
        const { title, detail } = describeStep(r.step);
        rows.push({
          n, kind: 'data', id: r.step.id, live, type: r.step.type, step: r.step,
          stepIndex: r.srcIndex, title, detail, dataCount, at: transforms,
        });
        if (TRANSFORM_TYPES.has(r.step.type)) transforms += 1;
      } else {
        rows.push({
          n, kind: 'analysis', id: r.entry.runId, live, entry: r.entry, index: r.srcIndex,
          title: stripEllipsis(r.entry.label || 'Analysis'),
          detail: r.entry.pluginName || '',
          dataCount,
          at: transforms, // DERIVED: the transforms above this row, whatever the entry says
        });
      }
    }
  };
  emit(liveSeq, true);
  emit(aheadSeq, false);

  return { rows: attachRecords(rows, records), ids: liveSeq.map(rowId) };
}

/**
 * The live data steps ABOVE a row — the exact prefix to materialise so that row's
 * analysis sees the data it describes.
 *
 * Preferred over {@link prefixForAt} wherever the rows are to hand: `at` counts
 * transforms and therefore cannot say where an analysis sits among SOURCES that follow
 * one (an append after a compute). The rows can, because they ARE the order.
 */
export function stepsAbove(rows, id) {
  const out = [];
  for (const row of rows || []) {
    if (row.id === id) break;
    if (row.kind === 'data' && row.live !== false) out.push(row.step);
  }
  return out;
}

/** How many of these steps are transforms — an analysis's `at` if it ran after all of
 * them. One counter, one definition (see {@link TRANSFORM_TYPES}). */
export function transformCount(steps) {
  return (steps || []).filter((s) => TRANSFORM_TYPES.has(s.type)).length;
}

/**
 * The steps ABOVE an analysis recorded at position `at` — what has to be materialised to
 * reproduce the data it described.
 *
 * `at` counts transforms, so the prefix is every step up to and including the `at`-th one,
 * sources included. At `at = 0` that is the leading sources alone: an analysis of freshly
 * imported data describes the import.
 *
 * A caller holding the timeline rows should pass the prefix it can see exactly, rather
 * than this. `at` cannot express where an analysis sits among SOURCES that follow a
 * transform (an append after a compute), because it does not count them; the rows can.
 */
export function prefixForAt(steps, at) {
  const want = Math.max(0, Math.floor(Number(at) || 0));
  const out = [];
  let t = 0;
  for (const step of steps || []) {
    const isTransform = TRANSFORM_TYPES.has(step.type);
    if (isTransform && t >= want) break;
    out.push(step);
    if (isTransform) t += 1;
  }
  return out;
}

/**
 * The analyses whose stored `at` disagrees with where they now sit — the exact set a
 * caller must re-run, and nothing more.
 *
 * This is what makes a move honest without re-running the world: moving an analysis past
 * another analysis changes no derived `at`, so nothing recomputes, while moving it past a
 * transform changes one, so exactly that one analysis recomputes. The caller does not
 * decide which case it is - the numbers do.
 *
 * @param {object[]} rows from {@link buildTimeline}
 * @returns {Array<{runId: string, from: number, to: number, entry: object}>}
 */
export function staleAnalyses(rows) {
  const out = [];
  for (const row of rows) {
    if (row.kind !== 'analysis' || row.live === false) continue;
    const stored = Number.isFinite(row.entry?.at) ? row.entry.at : null;
    if (stored !== row.at) out.push({ runId: row.id, from: stored, to: row.at, entry: row.entry });
  }
  return out;
}

/** The runIds in timeline order — what the Output pane is sorted by, so the sections
 * read in the same order the History panel lists them. */
export function analysisOrder(rows) {
  return rows.filter((r) => r.kind === 'analysis' && r.live !== false).map((r) => r.id);
}

/** Human-readable title + detail for any operation-log entry — data loads
 * (load/append/join) and data transforms alike. */
export function describeStep(t) {
  if (t && t.type === 'load') {
    return { title: 'Imported data', detail: t.src?.label || 'the original data' };
  }
  if (t && t.type === 'append') {
    return { title: 'Appended rows', detail: t.src?.label || 'more data' };
  }
  if (t && t.type === 'join') {
    const key = t.joinKey ? `${t.joinKey.left} ↔ ${t.joinKey.right}` : 'a key';
    return { title: `Joined ${t.src?.label || 'data'}`, detail: `on ${key}` };
  }
  if (t && t.type === 'setCell') {
    return {
      title: `Edited cell · ${t.column}`,
      detail: `row ${t.row + 1} = ${t.value == null || t.value === '' ? '(blank)' : t.value}`,
    };
  }
  if (t && t.type === 'computeVar') {
    return { title: `Computed ${t.name}`, detail: t.expr };
  }
  if (t && t.type === 'recodeVar') {
    const n = (t.rules || []).length;
    return { title: `Recoded ${t.source} → ${t.name}`, detail: `${n} rule${n === 1 ? '' : 's'}` };
  }
  if (t && t.type === 'filterCases') {
    return { title: 'Selected cases', detail: t.label || t.expr || '' };
  }
  if (t && t.type === 'dropVars') {
    const n = (t.names || []).length;
    return { title: `Dropped ${n} variable${n === 1 ? '' : 's'}`, detail: (t.names || []).join(', ') };
  }
  if (t && t.type === 'keepVars') {
    const n = (t.names || []).length;
    return { title: `Kept ${n} variable${n === 1 ? '' : 's'}`, detail: (t.names || []).join(', ') };
  }
  // STRUCTURAL ops never appear as timeline rows — the fold consumes them — but they do
  // reach the Edit menu, because reordering or deleting a step is an undoable action like
  // any other. Without a name here, Undo read "Undo: reorder": the raw op type, which is
  // the one place a user should never be shown one.
  if (t && t.type === 'reorder') {
    return { title: 'Reordered the history', detail: '' };
  }
  if (t && t.type === 'retract') {
    return { title: 'Removed a step', detail: '' };
  }
  if (t && t.type === 'setWeight') {
    // A weight is a transform (see TRANSFORM_TYPES), so it gets a row — and a row with
    // no describer here falls through to printing its raw op type, which is how History
    // came to show a step called 'setWeight'.
    return t.name
      ? { title: 'Weighted cases', detail: 'by ' + t.name }
      : { title: 'Weighting off', detail: 'cases count once each' };
  }
  if (t && t.type === 'renameVar') {
    return { title: `Renamed ${t.from} → ${t.to}`, detail: '' };
  }
  if (!t || t.type !== 'setVariable') return { title: t?.type || 'Change', detail: '' };
  const p = t.patch || {};
  const bits = [];
  if ('type' in p) bits.push(`type → ${p.type}`);
  if ('label' in p) bits.push(p.label ? `label “${p.label}”` : 'cleared label');
  if ('measurementLevel' in p) bits.push(p.measurementLevel ? `measure → ${p.measurementLevel}` : 'cleared measure');
  if ('missingValues' in p) {
    const m = p.missingValues;
    bits.push(m && m.length ? `missing: ${m.join(', ')}` : 'cleared missing');
  }
  if ('valueLabels' in p) {
    const k = p.valueLabels ? Object.keys(p.valueLabels).length : 0;
    bits.push(k ? `${k} value label${k === 1 ? '' : 's'}` : 'cleared value labels');
  }
  return { title: `Edited ${t.name}`, detail: bits.join(' · ') };
}
