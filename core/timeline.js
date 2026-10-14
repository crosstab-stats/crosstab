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
