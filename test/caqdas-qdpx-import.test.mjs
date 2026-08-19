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

const { resolveImportedCodings } = await import('../plugins/builtin-caqdas/index.js');

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
