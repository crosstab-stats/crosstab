/**
 * @file caqdas-qdpx-import.test.mjs
 * A REFI-QDA import must arrive with its codebook, not just its documents.
 *
 * The bug: #152 moved codes and segments out of the workspace blob into item records,
 * and `normalize()` began hard-resetting `codes: []` on load. `parseQdpx` was written
 * before that and still put imported codes at the top level of the blob, so every code
 * was silently discarded — while `pendingImport.codings`, which normalize DOES pass
 * through, survived and referenced codeIds that no longer existed. You imported a coded
 * project and got documents plus a pile of codings labelled "(code)".
 *
 * QDPX is the qualitative interchange standard. Losing the codebook on import is the
 * one thing it exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveImportedCodings, qdpxCodeTree } = await import('../plugins/builtin-caqdas/index.js');
const SRC = await (await import('node:fs/promises'))
  .readFile(new URL('../plugins/builtin-caqdas/index.js', import.meta.url), 'utf8');

const DOCS = [
  { rid: 'r1', kind: 'text', text: 'the quick brown fox jumps' },
  { rid: 'r2', kind: 'text', text: 'second document here' },
  { rid: 'r3', kind: 'image' },
];
const CODES = [
  { id: 'c_a', name: 'Trust', color: '#0072B2', group: 'Relational', memo: '' },
  { id: 'c_b', name: 'Delay', color: '#E69F00', group: '', memo: '' },
];

test('imported codes come back — the whole bug', async () => {
  const { codes } = await resolveImportedCodings({ codes: CODES, codings: [] }, DOCS);
  assert.equal(codes.length, 2);
  assert.deepEqual(codes.map((c) => c.name), ['Trust', 'Delay']);
  // Colour and theme ride along; a codebook that arrives colourless is half a codebook.
  assert.equal(codes[0].color, '#0072B2');
  assert.equal(codes[0].group, 'Relational');
});

test('codings resolve row INDEX to row id', async () => {
  // At import time no dataset exists, so no __ct_rid values do either — codings can
  // only address documents positionally until the mount binds them.
  const { segments } = await resolveImportedCodings({
    codes: CODES,
    codings: [{ row: 0, codeId: 'c_a', type: 'text', data: { start: 4, end: 9 } }],
  }, DOCS);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].doc, 'r1', 'row 0 became r1');
  assert.equal(segments[0].quote, 'quick', 'the span text is sliced from the document');
  // An import arrives as raw offsets into a foreign document — the fragile shape #166
  // replaced — so it is converted at the boundary into a position anchor that reports
  // itself as unverifiable, rather than one that silently claims to be exact.
  assert.deepEqual(segments[0].anchor?.ref?.selectors ?? segments[0].anchorRefFallback,
    undefined, 'no host builders passed ⇒ no wrapped anchor');
});

test('all three selector kinds survive the trip', async () => {
  const { segments } = await resolveImportedCodings({
    codes: CODES,
    codings: [
      { row: 0, codeId: 'c_a', type: 'text', data: { start: 0, end: 3 } },
      { row: 2, codeId: 'c_b', type: 'region', data: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
      { row: 1, codeId: 'c_a', type: 'time', data: { tStart: 1.5, tEnd: 9.25 } },
    ],
  }, DOCS);
  assert.equal(segments.length, 3);
  assert.ok(segments[1].region, 'image region kept');
  assert.equal(segments[2].tStart, 1.5, 'time span kept');
  assert.ok(segments[1].quote && segments[2].quote, 'each carries a human label for retrieve/export');
});

test('a coding whose code did not survive is DROPPED, not left dangling', async () => {
  // A segment pointing at a missing code renders as "(code)" and cannot be repaired by
  // hand. Better to drop it and say so than to keep a reference that lies.
  const r = await resolveImportedCodings({
    codes: CODES,
    codings: [
      { row: 0, codeId: 'c_a', type: 'text', data: { start: 0, end: 3 } },
      { row: 0, codeId: 'c_GONE', type: 'text', data: { start: 4, end: 9 } },
    ],
  }, DOCS);
  assert.equal(r.segments.length, 1);
  assert.equal(r.dropped, 1, 'the loss is counted so it can be reported');
  assert.ok(r.segments.every((sg) => sg.codeId === 'c_a'));
});

test('a coding pointing past the end of the documents is dropped', async () => {
  const r = await resolveImportedCodings({
    codes: CODES,
    codings: [{ row: 99, codeId: 'c_a', type: 'text', data: { start: 0, end: 3 } }],
  }, DOCS);
  assert.equal(r.segments.length, 0);
  assert.equal(r.dropped, 1);
});

test('re-running cannot duplicate codes that already exist', async () => {
  // resolvePendingImport runs at mount; a remount with the flag still set must not
  // double the codebook.
  const { codes } = await resolveImportedCodings({ codes: CODES, codings: [] }, DOCS, new Set(['c_a']));
  assert.deepEqual(codes.map((c) => c.id), ['c_b']);
});

test('an import with codes but no codings still yields the codebook', async () => {
  // The old guard returned early unless `codings` was an array, so importing a bare
  // codebook threw everything away.
  const { codes, segments } = await resolveImportedCodings({ codes: CODES }, DOCS);
  assert.equal(codes.length, 2);
  assert.equal(segments.length, 0);
});

test('junk in, nothing out — never a throw', async () => {
  for (const bad of [null, undefined, {}, { codes: 'nope', codings: 'nope' }, { codings: [null, {}] }]) {
    await assert.doesNotReject(() => resolveImportedCodings(bad, DOCS));
  }
  assert.deepEqual(await resolveImportedCodings(null, DOCS), { codes: [], segments: [], dropped: 0 });
  // A code with no id cannot be referenced by any coding, so it is not a code.
  assert.deepEqual((await resolveImportedCodings({ codes: [{ name: 'x' }] }, DOCS)).codes, []);
});

// =============================================================================
// Themes survive the round trip (found 2026-10-21, by running it)
// =============================================================================
// The export had never been confirmed against its own importer. Doing it found that a
// code's THEME went nowhere: "Barriers" and "Facilitators" appeared nowhere in the XML,
// and a re-imported code came back with `group: ''`. So the codebook's organisation
// survived neither a hand-off to NVivo nor a round trip through our own file.
//
// QDA-XML has the place for it already — hierarchy is nested `<Code>`, and a parent
// marked `isCodable="false"` is an organiser rather than something you apply, which is
// what NVivo and ATLAS.ti write for a folder-like code. Nothing new was invented.

const guids = (codes) => new Map(codes.map((c, i) => [c.id, `guid-${i}`]));
const tree = (codes) => qdpxCodeTree(codes, guids(codes));

test('a theme becomes a parent code holding its members', () => {
  const xml = tree([
    { id: 'a', name: 'Cost', group: 'Barriers', color: '#e74c3c' },
    { id: 'b', name: 'Transport', group: 'Barriers', color: '#d35400' },
  ]);
  assert.match(xml, /<Code [^>]*name="Barriers" isCodable="false">/);
  assert.match(xml, /name="Barriers" isCodable="false">\s*<Code [^>]*name="Cost"/);
  assert.equal((xml.match(/<\/Code>/g) || []).length, 1, 'one wrapper, closed once');
  assert.ok(xml.indexOf('Transport') > xml.indexOf('Cost'), 'both members inside it');
});

test('an organiser is marked NOT codable; its members are', () => {
  // The distinction the format uses, and the one a reader needs: a theme is not a code
  // anyone coded with, so nothing may point at it as though it were.
  const xml = tree([{ id: 'a', name: 'Cost', group: 'Barriers' }]);
  assert.match(xml, /name="Barriers" isCodable="false"/);
  assert.match(xml, /name="Cost" isCodable="true"/);
});

test('an un-themed code stays at the top level', () => {
  // Where it is in the codebook. Inventing an "Ungrouped" parent would put a theme in
  // the recipient's codebook that the author never wrote.
  const xml = tree([
    { id: 'a', name: 'Cost', group: 'Barriers' },
    { id: 'b', name: 'Loose', group: '' },
    { id: 'c', name: 'Also loose' },
  ]);
  assert.match(xml, /<Code [^>]*name="Loose" isCodable="true"\/>/);
  assert.match(xml, /<Code [^>]*name="Also loose" isCodable="true"\/>/);
  assert.equal((xml.match(/isCodable="false"/g) || []).length, 1);
});

test('whitespace is not a theme', () => {
  const xml = tree([{ id: 'a', name: 'Cost', group: '   ' }]);
  assert.doesNotMatch(xml, /isCodable="false"/);
});

test('colours ride along, and a code without one gets no attribute', () => {
  const xml = tree([
    { id: 'a', name: 'Cost', group: 'Barriers', color: '#e74c3c' },
    { id: 'b', name: 'Bare', group: '' },
  ]);
  assert.match(xml, /name="Cost" isCodable="true" color="#e74c3c"/);
  assert.match(xml, /name="Bare" isCodable="true"\/>/);
});

test('a code name that is XML is escaped, inside a theme and out', () => {
  // A code is user-typed and can hold anything; an unescaped `&` makes the file
  // unparseable and the export silently useless.
  const xml = tree([{ id: 'a', name: 'Cost & "value" <here>', group: 'R&D' }]);
  assert.match(xml, /name="R&amp;D"/);
  assert.match(xml, /name="Cost &amp; &quot;value&quot; &lt;here&gt;"/);
  assert.doesNotMatch(xml, /name="[^"]*&(?!amp;|quot;|lt;|gt;|apos;)/);
});

// =============================================================================
// Reading the nesting back
// =============================================================================

test('the importer reads a parent code as the child’s theme', () => {
  const parse = SRC.slice(SRC.indexOf('// Codes: guid → a fresh caqdas code.'),
    SRC.indexOf('const names = []'));
  assert.match(parse, /parent\.tagName === 'Code'/, 'the parent element is the theme');
  assert.match(parse, /isCodable/, 'and an organiser is told apart from a code');
  // An organiser still has to be in the guid map, or a CodeRef pointing at one resolves
  // to nothing and the coding that used it is dropped without a word.
  assert.ok(parse.indexOf('codeIdByGuid.set(guid, id)') < parse.indexOf('if (!codable'),
    'the guid is mapped BEFORE an organiser is skipped');
});

// =============================================================================
// The project is not named after a column
// =============================================================================

test('the exported project is not named after the label column', () => {
  // It was: `<Project name="participant">`, which re-imported as a dataset called
  // "participant". The label column names the documents inside the project; it is not
  // the project.
  const exp = SRC.slice(SRC.indexOf('export async function exportQdpx'), SRC.length);
  const head = exp.slice(0, exp.indexOf('const zipBytes'));
  assert.doesNotMatch(head, /<Project[^`]*labelColumn/);
  assert.match(head, /name="\$\{xesc\(QDPX_PROJECT\)\}"/);
  // One constant for the name in the XML and the name on disk, so they cannot disagree.
  assert.match(exp, /filename: QDPX_FILE/);
});
