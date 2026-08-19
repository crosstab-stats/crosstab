/**
 * CAQDAS anchoring: the coding layer rebuilt on host anchors (#166).
 *
 * The UI lives in a sandboxed opaque-origin iframe nothing outside can drive, so the
 * discipline is that everything RISKY is a pure exported function tested here, leaving
 * only chrome for hand-verification. These are the pieces that decide whether a coding
 * points at the right words: what gets stored, what gets derived, and what a save writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistableSegment, quoteOf, docTarget, fieldDelta, resolveDocSegments,
} from '../plugins/builtin-caqdas/index.js';
import { textRef, mediaRef, resolveAnchor } from '../core/anchors.js';

const TEXT = 'She said we had to wait three hours before anyone came to help her mother.';
const spanOf = (needle, hay = TEXT) => [hay.indexOf(needle), hay.indexOf(needle) + needle.length];

/** The host bridge, as the plugin sees it — the same pure functions, one hop away. */
const app = {
  anchors: {
    text: async (t, a, b) => textRef(t, a, b),
    media: async (sel, id) => mediaRef(sel, id),
    resolve: async (refs, subject) => refs.map((r) => resolveAnchor(r, subject)),
  },
};

const codingFor = (needle, doc = { rid: 'r1', kind: 'text', text: TEXT }) => {
  const [lo, hi] = spanOf(needle, doc.text);
  const anchor = { kind: 'cell', target: docTarget(7, 'transcript', doc.rid), ref: textRef(doc.text, lo, hi) };
  return { id: `s_${needle}`, doc: doc.rid, codeId: 'c1', anchor, quote: quoteOf(anchor), start: lo, end: hi, status: 'exact' };
};

// --- what is stored vs what is derived --------------------------------------

test('a stored coding carries the REFERENCE, never the position', () => {
  const stored = persistableSegment(codingFor('wait'));
  assert.ok(stored.anchor, 'the anchor is what persists');
  assert.equal(stored.quote, 'wait');
  for (const derived of ['start', 'end', 'status', 'reason', 'id']) {
    assert.ok(!(derived in stored), `${derived} must not be stored — it is derived per session`);
  }
});

test('the target is byte-identical to what setCell writes — that is what makes reads[] free', () => {
  assert.equal(docTarget(7, 'transcript', '100000003'), 'ds:7/cell:transcript:100000003');
});

test('quoteOf reads the label off the anchor, so the two cannot disagree', () => {
  const anchor = { ref: textRef(TEXT, ...spanOf('three hours')) };
  assert.equal(quoteOf(anchor), 'three hours');
  assert.equal(quoteOf(null, 'fallback'), 'fallback');
  const long = { ref: textRef('x'.repeat(200), 0, 200) };
  assert.ok(quoteOf(long).length <= 80, 'a label is truncated, the anchor is not');
});

// --- resolution at render ----------------------------------------------------

test('unchanged text: every coding resolves exact and nothing is reported', async () => {
  const segs = [codingFor('wait'), codingFor('mother')];
  const report = await resolveDocSegments(app, { rid: 'r1', kind: 'text', text: TEXT }, segs);
  assert.deepEqual(report, { drifted: 0, orphaned: 0 });
  assert.equal(segs[0].status, 'exact');
  assert.equal(TEXT.slice(segs[0].start, segs[0].end), 'wait');
});

test('THE BUG: editing the cell moves the text, and the codings follow it', async () => {
  const segs = [codingFor('wait'), codingFor('mother')];
  const edited = TEXT.replace('She said', 'Her daughter told me, at length,');
  const report = await resolveDocSegments(app, { rid: 'r1', kind: 'text', text: edited }, segs);
  assert.deepEqual(report, { drifted: 0, orphaned: 0 }, 'a clean move needs no warning');
  for (const s of segs) {
    assert.equal(s.status, 'moved');
    assert.equal(edited.slice(s.start, s.end), s.quote, 'still covering its own words');
  }
});

test('a coding whose text is GONE keeps everything but its position', async () => {
  const seg = codingFor('wait');
  const report = await resolveDocSegments(app, { rid: 'r1', kind: 'text', text: 'Nothing like it.' }, [seg]);
  assert.deepEqual(report, { drifted: 0, orphaned: 1 });
  assert.equal(seg.status, 'orphaned');
  assert.equal(seg.start, null, 'no position — so nothing can draw it in the wrong place');
  assert.equal(seg.codeId, 'c1', 'the code survives');
  assert.equal(seg.quote, 'wait', 'and so does what it said');
  assert.ok(seg.reason, 'and it can say why');
});

test('an edited passage degrades to drifted and is counted for the banner', async () => {
  const seg = codingFor('we had to wait three hours before');
  const report = await resolveDocSegments(app, { rid: 'r1', kind: 'text', text: TEXT.replace('three', 'nearly three') }, [seg]);
  assert.equal(report.drifted, 1);
  assert.equal(seg.status, 'drifted');
});

test('a REPLACED media file is caught — the modality that could not detect this at all', async () => {
  const seg = {
    id: 's1', doc: 'r9', codeId: 'c1', tStart: 272, tEnd: 305, quote: '4:32–5:05',
    anchor: { kind: 'cell', target: docTarget(7, 'clip', 'r9'), ref: mediaRef({ kind: 'time-span', tStart: 272, tEnd: 305 }, 'asset:abc') },
  };
  const same = await resolveDocSegments(app, { rid: 'r9', kind: 'media', refs: ['asset:abc'] }, [seg]);
  assert.deepEqual(same, { drifted: 0, orphaned: 0 });

  const swapped = await resolveDocSegments(app, { rid: 'r9', kind: 'media', refs: ['asset:zzz'] }, [seg]);
  assert.equal(swapped.drifted, 1);
  assert.match(seg.reason, /replaced/);
});

test('resolution reports; it never repairs — the stored anchor is untouched', async () => {
  const seg = codingFor('wait');
  const before = JSON.stringify(seg.anchor);
  await resolveDocSegments(app, { rid: 'r1', kind: 'text', text: 'something else' }, [seg]);
  assert.equal(JSON.stringify(seg.anchor), before,
    'a drifted coding keeps its reference — only a user action rewrites one');
});

test('a resolve failure degrades to a quiet no-op rather than losing the document', async () => {
  const broken = { anchors: { resolve: async () => { throw new Error('bridge down'); } } };
  const seg = codingFor('wait');
  assert.deepEqual(await resolveDocSegments(broken, { rid: 'r1', kind: 'text', text: TEXT }, [seg]),
    { drifted: 0, orphaned: 0 });
});

// --- narrow writes -----------------------------------------------------------

test('a save writes ONLY the fields that changed', () => {
  const prev = { id: 's1', doc: 'r1', codeId: 'c1', quote: 'wait', anchor: { a: 1 } };
  const next = { ...prev, codeId: 'c2' };
  assert.deepEqual(fieldDelta(prev, next), { codeId: 'c2' },
    'putItem field-merges, so a recode must not collide with a concurrent re-anchor');
});

test('an unchanged record produces no op at all', () => {
  const rec = { id: 's1', doc: 'r1', codeId: 'c1' };
  assert.equal(fieldDelta(rec, { ...rec }), null);
});

test('a new record writes every field', () => {
  assert.deepEqual(fieldDelta(undefined, { id: 's1', doc: 'r1', codeId: 'c1' }), { doc: 'r1', codeId: 'c1' });
});

test('a field that went away is written as null — the merge cannot infer absence', () => {
  assert.deepEqual(fieldDelta({ id: 's1', memo: 'x', doc: 'r1' }, { id: 's1', doc: 'r1' }), { memo: null });
});

test('two coders touching different fields of one coding do not collide', () => {
  const base = { id: 's1', codeId: 'c1', anchor: { ref: 1 }, quote: 'wait' };
  const boundaryEdit = fieldDelta(base, { ...base, anchor: { ref: 2 }, quote: 'wait three' });
  const codeChange = fieldDelta(base, { ...base, codeId: 'c9' });
  assert.deepEqual(Object.keys(codeChange), ['codeId']);
  assert.ok(!('codeId' in boundaryEdit), 'the two deltas are disjoint, so the fold keeps both');
});
