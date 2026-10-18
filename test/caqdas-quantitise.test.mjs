/**
 * @file caqdas-quantitise.test.mjs
 * Coded data as a dataset — shape A of the quantitising plan: one row per document, one
 * column per code.
 *
 * This is the bridge from the coding workspace to the statistics menu, and it is a
 * dataset rather than a cross-plugin call for three reasons recorded in TODO.md: a
 * document already IS a dataset row (so the respondent attributes sit beside it), only
 * built-in plugins can read the coding records at all, and the five judgements the
 * conversion makes have to land in the log where they can be audited.
 *
 * **What these tests are really protecting is the honesty of the output**, not the
 * arithmetic. Counting codings is easy; counting them in a way a reader can interpret is
 * where this goes wrong. So the assertions below are mostly about the choices:
 * prevalence is the default because a raw count measures how much someone talked, an
 * empty row is not a participant who stayed silent, a code nobody used still gets a
 * column, and everything dropped is counted rather than quietly skipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { quantitiseCodings, codingTable } = await import('../plugins/builtin-caqdas/index.js');
const { coderName } = await import('../core/plugin-stdlib.js');

// --- a small coded project ---------------------------------------------------
// Three documents, one of them empty; two codes under one theme and one under another;
// two coders, one of whom is unstamped (imported codings deliberately are).

const BOOK = 'b1';
const CODES = [
  { id: 'c1', name: 'Cost', group: 'Barriers', codebookId: BOOK, sort: 1 },
  { id: 'c2', name: 'Transport', group: 'Barriers', codebookId: BOOK, sort: 2 },
  { id: 'c3', name: 'Trust in staff', group: 'Facilitators', codebookId: BOOK, sort: 3 },
  { id: 'c9', name: 'Old scheme', group: '', codebookId: 'b-other', sort: 1 },
];

const DOCS = [
  { rid: 'r1', label: 'P01', chars: 400, isDoc: true },
  { rid: 'r2', label: 'P02', chars: 350, isDoc: true },
  { rid: 'r3', label: 'P03', chars: 0, isDoc: false }, // nothing to code
];

const ANA = { author: { authorId: 'u1', name: 'Ana', initials: 'AB' } };
const BEN = { author: { authorId: 'u2', name: 'Ben', initials: 'BC' } };

/** A coding, with a text-quote anchor so `coded_chars` has something to measure. */
const seg = (doc, codeId, exact, who = {}) => ({
  id: `s_${doc}_${codeId}_${exact.length}`,
  doc,
  codeId,
  anchor: { kind: 'cell', target: `ds:1/cell:text:${doc}`, ref: { selectors: [{ kind: 'text-quote', exact }] } },
  quote: exact.slice(0, 80),
  ...who,
});

const SEGS = [
  seg('r1', 'c1', 'it was the money, in the end', ANA),
  seg('r1', 'c1', 'could not afford the bus fare either', BEN),
  seg('r1', 'c3', 'the nurse knew my name', ANA),
  seg('r2', 'c1', 'too expensive', BEN),
];

const run = (opts = {}) => quantitiseCodings({
  docs: DOCS, segments: SEGS, codes: CODES, bookId: BOOK, ...opts,
});

const colOf = (out, label) => out.columns[out.report.items.find((i) => i.label.endsWith(label)).name];
const varOf = (out, label) => out.variables.find((v) => v.name
  === out.report.items.find((i) => i.label.endsWith(label)).name);

// =============================================================================
// The unit, and who is in the table
// =============================================================================

test('one row per document, and an empty row is not a silent participant', () => {
  // Counting a blank row would deflate every prevalence on the table — it reads as
  // "P03 was asked and did not mention cost", which is not what happened.
  const out = run();
  assert.deepEqual(out.columns.document, ['P01', 'P02']);
  assert.equal(out.report.nRows, 2);
  assert.equal(out.report.nDocs, 3, 'the excluded row is still reported');
});

test('the source row id travels, because nothing else records it', () => {
  // It is the only link from a quantitised row back to the document it summarises, and
  // the only way to join more attributes on later.
  assert.deepEqual(run().columns.doc_rid, ['r1', 'r2']);
});

// =============================================================================
// Presence vs count — the judgement this whole feature turns on
// =============================================================================

test('presence is the default, and it is 0/1 not a count', () => {
  // P01 was coded Cost TWICE. Presence says once: what papers report is "8 of 12
  // participants raised cost", and a raw count would say P01 cares twice as much as P02
  // when it may only mean P01 talked longer.
  const out = run();
  assert.deepEqual(colOf(out, 'Cost'), [1, 1]);
  assert.deepEqual(colOf(out, 'Trust in staff'), [1, 0]);
});

test('counts are available and are real counts', () => {
  const out = run({ values: 'count' });
  assert.deepEqual(colOf(out, 'Cost'), [2, 1]);
});

test('a presence column is a FACTOR with labelled levels', () => {
  // This is the property that makes the dataset usable: Crosstabs accepts only
  // factor/string variables, and a code × attribute crosstab is the headline reason
  // anyone presses this button. A numeric 0/1 would not be offered at all.
  const v = varOf(run(), 'Cost');
  assert.equal(v.type, 'factor');
  assert.equal(v.measurementLevel, 'nominal');
  assert.deepEqual(v.valueLabels, { 0: 'Absent', 1: 'Present' });
  // A count is the other thing entirely and must not claim to be categorical.
  const c = varOf(run({ values: 'count' }), 'Cost');
  assert.equal(c.type, 'numeric');
  assert.equal(c.measurementLevel, 'scale');
  assert.equal(c.valueLabels, undefined);
});

test('a code nobody used still gets a column of zeros', () => {
  // Otherwise the dataset changes SHAPE as coding proceeds, and two exports from the
  // same project are not comparable — the absence of a theme is a finding.
  const out = run();
  assert.deepEqual(colOf(out, 'Transport'), [0, 0]);
  assert.equal(out.report.items.find((i) => i.label.endsWith('Transport')).total, 0);
});

// =============================================================================
// Rollup, coders, scope
// =============================================================================

test('rolling up by theme merges the codes under it', () => {
  // Cost + Transport are both Barriers, and P02 raised only Cost — so Barriers is
  // present for both documents, once each.
  const out = run({ rollup: 'theme' });
  const labels = out.report.items.map((i) => i.label);
  assert.deepEqual(labels, ['Barriers', 'Facilitators']);
  assert.deepEqual(colOf(out, 'Barriers'), [1, 1]);
  assert.deepEqual(colOf(out, 'Facilitators'), [1, 0]);
  // P01's two Cost codings roll up; its third coding is a Facilitator, not a Barrier.
  assert.deepEqual(colOf(run({ rollup: 'theme', values: 'count' }), 'Barriers'), [2, 1]);
});

test('a code with no theme lands in a named bucket, not in a blank column', () => {
  const codes = [...CODES, { id: 'c4', name: 'Loose', group: '', codebookId: BOOK, sort: 4 }];
  const out = quantitiseCodings({ docs: DOCS, segments: SEGS, codes, bookId: BOOK, rollup: 'theme' });
  assert.ok(out.report.items.some((i) => i.label === 'Unthemed'));
});

test('a column per coder, with the unstamped ones named rather than dropped', () => {
  // Imported codings carry no author on purpose, and "someone coded this" is different
  // information from "nobody did".
  const segs = [...SEGS, seg('r2', 'c3', 'they listened')];
  const out = quantitiseCodings({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK, coders: 'coder' });
  assert.deepEqual(out.report.coders, ['Ana', 'Ben', 'Unattributed']);
  assert.deepEqual(colOf(out, '— Ana'), [1, 0], 'Ana coded Cost in P01 only');
  assert.deepEqual(colOf(out, 'Cost — Ben'), [1, 1]);
  // Every code gets every coder's column, so the matrix is rectangular — that is what
  // Inter-rater agreement needs from a set of rater columns.
  assert.equal(out.report.items.length, 3 * 3);
});

test('pooling two coders on one passage is ONE presence and TWO codings', () => {
  // The double-count is real and is why the result says which it did.
  assert.deepEqual(colOf(run(), 'Cost'), [1, 1]);
  assert.equal(run().report.items.find((i) => i.label.endsWith('Cost')).total, 3);
});

test('scope leaves other codebooks out, and says how many it left', () => {
  const segs = [...SEGS, seg('r1', 'c9', 'from the old study', ANA)];
  const scoped = quantitiseCodings({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.equal(scoped.report.outOfScope, 1);
  assert.ok(!scoped.report.items.some((i) => i.label.includes('Old scheme')));
  const all = quantitiseCodings({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK, scope: 'all' });
  assert.equal(all.report.outOfScope, 0);
  assert.ok(all.report.items.some((i) => i.label.includes('Old scheme')));
});

// =============================================================================
// What gets dropped is counted
// =============================================================================

test('a coding on a deleted code is dropped and counted', () => {
  const segs = [...SEGS, seg('r1', 'GONE', 'orphan')];
  const out = quantitiseCodings({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.equal(out.report.unknownCode, 1);
  assert.equal(out.report.nUsed, SEGS.length);
});

test('a coding pointing at an unloaded row is dropped and counted', () => {
  // The workspace loads at most MAX_DOCS rows; a coding beyond that has no row to sit
  // on, and silently losing it would misreport every prevalence.
  const segs = [...SEGS, seg('r9999', 'c1', 'beyond the cap')];
  const out = quantitiseCodings({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.equal(out.report.offDoc, 1);
});

test('a drifted coding still counts for its document', () => {
  // Nothing here looks at resolution status, and that is the design: `doc` is a row id,
  // not a position, so a quote that no longer matches the edited text still belongs to
  // the same participant. Only shape B's offsets need the anchor resolved.
  const drifted = { id: 'sx', doc: 'r2', codeId: 'c3', anchor: { kind: 'cell', target: 'ds:1/cell:text:r2', ref: { selectors: [{ kind: 'text-quote', exact: 'text that has since been rewritten' }] } } };
  const out = quantitiseCodings({ docs: DOCS, segments: [...SEGS, drifted], codes: CODES, bookId: BOOK });
  assert.deepEqual(colOf(out, 'Trust in staff'), [1, 1]);
});

// =============================================================================
// Denominators and carried attributes
// =============================================================================

test('the denominators ride along, because nothing downstream can ask for them', () => {
  // `builtin-countmodels` has no offset/exposure input, so "mentions per 1000 words"
  // is only possible if the exposure is a column.
  const out = run();
  assert.deepEqual(out.columns.n_segments, [3, 1]);
  assert.deepEqual(out.columns.doc_chars, [400, 350]);
  assert.deepEqual(out.columns.coded_chars, [
    'it was the money, in the end'.length
    + 'could not afford the bus fare either'.length
    + 'the nurse knew my name'.length,
    'too expensive'.length,
  ]);
});

test('coded length comes from the anchor, not the 80-char display quote', () => {
  // `fields.quote` is truncated for the sidebar; the full text is in the persisted
  // text-quote selector, which is also why this needs no anchor resolution.
  const long = 'x'.repeat(200);
  const out = quantitiseCodings({
    docs: [DOCS[0]], segments: [seg('r1', 'c1', long)], codes: CODES, bookId: BOOK,
  });
  assert.deepEqual(out.columns.coded_chars, [200]);
});

test('a region or time coding contributes no characters rather than seconds', () => {
  // Mixing units in one column would be worse than a zero.
  const timed = { id: 'st', doc: 'r1', codeId: 'c1', tStart: 12, tEnd: 30, anchor: { kind: 'cell', target: 'ds:1/cell:text:r1', ref: { selectors: [{ kind: 'time-span', tStart: 12, tEnd: 30 }] } } };
  const out = quantitiseCodings({ docs: [DOCS[0]], segments: [timed], codes: CODES, bookId: BOOK });
  assert.deepEqual(out.columns.coded_chars, [0]);
  assert.deepEqual(out.columns.n_segments, [1], 'it is still a coding');
});

test('carried attributes keep their metadata, in the document’s own row order', () => {
  // They are the whole point: a code × attribute crosstab needs the attribute to still
  // have its value labels, or the table reads "1" and "2".
  const attrs = [{
    meta: { name: 'site', type: 'factor', label: 'Location', valueLabels: { 1: 'Clinic', 2: 'Call centre' }, measurementLevel: 'nominal' },
    values: [2, 1, 9],
  }];
  const out = quantitiseCodings({ docs: DOCS, segments: SEGS, codes: CODES, bookId: BOOK, attrs });
  assert.deepEqual(out.columns.site, [2, 1], 'the excluded row is excluded here too');
  const v = out.variables.find((x) => x.name === 'site');
  assert.deepEqual(v.valueLabels, { 1: 'Clinic', 2: 'Call centre' });
  assert.equal(v.label, 'Location');
});

// =============================================================================
// Names
// =============================================================================

test('the variable name is the code name, which the syntax language can quote', () => {
  // No slug scheme: `Trust in staff` is legal as a name (the writer backtick-quotes
  // anything that is not a bare identifier), and a readable column beats a round-trip
  // of its own.
  assert.ok(Object.keys(run().columns).includes('Trust in staff'));
});

test('two codes with the same name get distinct columns', () => {
  const codes = [...CODES, { id: 'cdup', name: 'Cost', group: 'Facilitators', codebookId: BOOK, sort: 9 }];
  const out = quantitiseCodings({ docs: DOCS, segments: SEGS, codes, bookId: BOOK });
  const names = out.report.items.map((i) => i.name);
  assert.equal(new Set(names).size, names.length, `collision in ${names.join(', ')}`);
});

test('a code named like a carried attribute does not overwrite it', () => {
  const attrs = [{ meta: { name: 'Cost', type: 'numeric', label: 'Cost in pounds' }, values: [10, 20, 30] }];
  const out = quantitiseCodings({ docs: DOCS, segments: SEGS, codes: CODES, bookId: BOOK, attrs });
  assert.deepEqual(out.columns.Cost, [10, 20], 'the attribute keeps the plain name');
  assert.deepEqual(colOf(out, 'Cost'), [1, 1], 'and the code still has a column');
});

test('a control character in a code name does not reach a variable name', () => {
  // Names are user-typed and a pasted codebook can carry anything; `cleanName` is the
  // bound that stops a newline or a NUL becoming a column header.
  const codes = [{ id: 'cx', name: ['Cost', 'and', 'fees'].join(String.fromCharCode(10)), group: '', codebookId: BOOK }];
  const out = quantitiseCodings({ docs: DOCS, segments: [], codes, bookId: BOOK });
  const [name] = out.report.items.map((i) => i.name);
  assert.doesNotMatch(name, /\p{Cc}/u, `control char survived in ${JSON.stringify(name)}`);
  assert.equal(name, 'Cost and fees', 'and the words either side do not weld together');
});

// =============================================================================
// One coder resolver, shared with agreement
// =============================================================================

test('coderName reads both places a stamp can sit', () => {
  // `items.list` puts the creating author on the envelope; a plugin stamping its own
  // live objects puts it in the fields. A caller should not have to know which.
  assert.equal(coderName({ author: { name: 'Ana' } }), 'Ana');
  assert.equal(coderName({ fields: { author: { name: 'Ben' } } }), 'Ben');
  assert.equal(coderName({ author: { authorId: 'u3' } }), 'u3', 'identity over display');
  assert.equal(coderName({ author: { initials: 'CD', authorId: 'u4' } }), 'CD');
  assert.equal(coderName({}), null, 'unstamped is a state, not an error');
});

test('builtin-agreement uses that one, not a private copy', async () => {
  // The two plugins report on the SAME people — a coder who is "RB" in one and
  // "Rebecca B" in the other reads as two coders.
  const src = await readFile(new URL('../plugins/builtin-agreement/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /function coderOf/);
  assert.match(src, /coderName: coderOf/);
});

// =============================================================================
// Shape B — one row per coding
// =============================================================================
// The unit changes and so does what a row can carry: who coded it, what modality it is,
// where it sits, how long it is, its own text, and where it comes in the document. The
// positions are the interesting part, because they are resolved rather than stored.

/** A media coding: a time span, which has no text and no character offsets. */
const timeSeg = (doc, codeId, tStart, tEnd, who = {}) => ({
  id: `t_${doc}_${codeId}`,
  doc,
  codeId,
  tStart,
  tEnd,
  anchor: { kind: 'cell', target: `ds:1/cell:text:${doc}`, ref: { selectors: [{ kind: 'time-span', tStart, tEnd }] } },
  ...who,
});

/** A coding with a resolved position, as `resolveAllDocs` leaves it in the session. */
const placed = (s0, start, end, status = 'exact') => ({ ...s0, start, end, status });

const tableOf = (opts = {}) => codingTable({
  docs: DOCS, segments: SEGS, codes: CODES, bookId: BOOK, labelColumn: 'participant', ...opts,
});

test('one row per coding, not per document', () => {
  const out = tableOf();
  assert.equal(out.report.nRows, 4);
  assert.deepEqual(out.columns.document, ['P01', 'P01', 'P01', 'P02']);
  assert.deepEqual(out.columns.code, ['Cost', 'Cost', 'Trust in staff', 'Cost']);
});

test('the full coded text travels, and its length with it', () => {
  // From the anchor's quote selector, so a passage longer than the 80-character display
  // quote is not silently shortened on the way into a text-analytics corpus.
  const long = 'y'.repeat(300);
  const out = codingTable({ docs: [DOCS[0]], segments: [seg('r1', 'c1', long)], codes: CODES, bookId: BOOK });
  assert.equal(out.columns.text[0], long);
  assert.deepEqual(out.columns.chars, [300]);
});

test('code and theme are categorical, so Crosstabs will offer them', () => {
  // Strings rather than factors: a codebook is an open set that grows while you work,
  // and Crosstabs takes string as happily as factor.
  const v = (n) => tableOf().variables.find((x) => x.name === n);
  assert.equal(v('code').type, 'string');
  assert.equal(v('code').measurementLevel, 'nominal');
  assert.equal(v('theme').type, 'string');
});

test('rows run in document order, then by position within the document', () => {
  // `seq` is meaningless otherwise, and sequence analysis is the reason it exists.
  const segs = [
    placed(seg('r2', 'c1', 'later in P02'), 50, 62),
    placed(seg('r1', 'c3', 'second in P01'), 30, 43),
    placed(seg('r2', 'c3', 'earlier in P02'), 5, 19),
    placed(seg('r1', 'c1', 'first in P01'), 0, 12),
  ];
  const out = codingTable({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.deepEqual(out.columns.text, ['first in P01', 'second in P01', 'earlier in P02', 'later in P02']);
  assert.deepEqual(out.columns.seq, [1, 2, 1, 2], 'seq restarts at each document');
  assert.deepEqual(out.columns.char_start, [0, 30, 5, 50]);
});

test('an unresolved coding sorts last within its document, not first', () => {
  // It has no position, which is not evidence that it came at the start.
  const segs = [
    seg('r1', 'c1', 'no position at all'),
    placed(seg('r1', 'c3', 'at the end of the document'), 500, 526),
  ];
  const out = codingTable({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.deepEqual(out.columns.char_start, [500, null]);
  assert.deepEqual(out.columns.seq, [1, 2]);
});

test('an unresolved position is null and says so, rather than being guessed', () => {
  const out = tableOf();
  assert.deepEqual(out.columns.char_start, [null, null, null, null]);
  assert.deepEqual(out.columns.status, ['unresolved', 'unresolved', 'unresolved', 'unresolved']);
  assert.equal(out.report.nResolved, 0);
  // And a resolved one carries both the offsets and the status the workspace gave it.
  const one = codingTable({ docs: DOCS, segments: [placed(seg('r1', 'c1', 'moved along'), 12, 23, 'moved')], codes: CODES, bookId: BOOK });
  assert.deepEqual(one.columns.char_start, [12]);
  assert.deepEqual(one.columns.char_end, [23]);
  assert.deepEqual(one.columns.status, ['moved']);
  assert.equal(one.report.nResolved, 1);
});

test('modality comes from the selector, and times from a media coding', () => {
  // A real document is text OR media, never both; this one mixes them to cover both
  // columns in one pass, and the text coding is given a position so the order is defined.
  const segs = [placed(seg('r1', 'c1', 'spoken aloud'), 0, 12), timeSeg('r1', 'c3', 12.5, 30)];
  const out = codingTable({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.deepEqual(out.columns.modality, ['Text', 'Time span']);
  assert.deepEqual(out.columns.t_start, [null, 12.5]);
  assert.deepEqual(out.columns.t_end, [null, 30]);
  assert.deepEqual(out.columns.text, ['spoken aloud', ''], 'a time span quotes no text');
  assert.deepEqual(out.report.modalities, { Text: 1, 'Time span': 1 });
});

test('every modality the plugin can write is named', () => {
  // Four creation sites, one per modality — an unnamed one would read as a data error.
  const kinds = [
    ['text-quote', 'Text'],
    ['rect', 'Image region'],
    ['time-span', 'Time span'],
    ['rect-track', 'Region over time'],
  ];
  for (const [kind, label] of kinds) {
    const out = codingTable({
      docs: [DOCS[0]], codes: CODES, bookId: BOOK,
      segments: [{ id: 'x', doc: 'r1', codeId: 'c1', anchor: { ref: { selectors: [{ kind, exact: 'q' }] } } }],
    });
    assert.deepEqual(out.columns.modality, [label], kind);
  }
});

test('the coder is a column, with the unstamped named rather than blank', () => {
  const out = codingTable({ docs: DOCS, segments: [...SEGS, seg('r2', 'c3', 'imported')], codes: CODES, bookId: BOOK });
  assert.deepEqual(out.columns.coder, ['Ana', 'Ben', 'Ana', 'Ben', 'Unattributed']);
  assert.deepEqual(out.report.coders, ['Ana', 'Ben', 'Unattributed']);
});

test('a document attribute repeats down that document’s codings', () => {
  // The repetition IS the feature: it is what lets `code` be crosstabbed against `site`.
  // And the values must align by ROW ID, not by position — `attrs` are aligned to the
  // original doc list, which still holds the empty row this table drops. Aligning by
  // position would hand P02's codings P03's attributes.
  const attrs = [{
    meta: { name: 'site', type: 'factor', label: 'Location', valueLabels: { 1: 'Clinic', 2: 'Call centre' }, measurementLevel: 'nominal' },
    values: [1, 2, 9],
  }];
  const out = tableOf({ attrs });
  assert.deepEqual(out.columns.site, [1, 1, 1, 2]);
  assert.deepEqual(out.variables.find((v) => v.name === 'site').valueLabels, { 1: 'Clinic', 2: 'Call centre' });
});

test('an attribute named like a built-in column does not overwrite it', () => {
  const attrs = [{ meta: { name: 'code', type: 'string', label: 'Site code' }, values: ['A', 'B', 'C'] }];
  const out = tableOf({ attrs });
  assert.deepEqual(out.columns.code, ['Cost', 'Cost', 'Trust in staff', 'Cost'], 'the coding’s code survives');
  assert.ok(out.columns.code_2, 'and the attribute gets a name of its own');
});

test('scope and the dropped codings are reported here too', () => {
  const segs = [...SEGS, seg('r1', 'c9', 'other book'), seg('r1', 'GONE', 'deleted code'), seg('r9999', 'c1', 'past the cap')];
  const out = codingTable({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK });
  assert.equal(out.report.nRows, 4);
  assert.equal(out.report.outOfScope, 1);
  assert.equal(out.report.unknownCode, 1);
  assert.equal(out.report.offDoc, 1);
  assert.equal(out.report.nCodings, 7, 'and what it started from');
  const all = codingTable({ docs: DOCS, segments: segs, codes: CODES, bookId: BOOK, scope: 'all' });
  assert.equal(all.report.nRows, 5);
});

test('an empty table is empty rather than one blank row', () => {
  const out = codingTable({ docs: DOCS, segments: [], codes: CODES, bookId: BOOK });
  assert.equal(out.report.nRows, 0);
  assert.deepEqual(out.columns.code, []);
  assert.ok(out.variables.length, 'the columns are still declared');
});
