/**
 * Headless tests for the anchor primitive (core/anchors.js, #166).
 * Run: `npm test`.
 *
 * The whole design rests on `resolveAnchor` being a pure function that never lies: it may
 * say "I do not know", but it must not report a confident position for a region that has
 * moved or gone. Each ladder rung is pinned here, because the failure they replace was
 * silent and the replacement must not be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSelector, normalizeRef, selectorOf, textRef, mediaRef,
  resolveAnchor, needsAttention, CONTEXT_CHARS,
} from '../core/anchors.js';

const TEXT = 'She said we had to wait three hours before anyone came to help her mother.';

// --- normalisation -----------------------------------------------------------

test('a malformed selector is dropped, not thrown', () => {
  assert.equal(normalizeSelector({ kind: 'text-quote' }), null);        // no exact
  assert.equal(normalizeSelector({ kind: 'text-position', start: 1 }), null); // no end
  assert.equal(normalizeSelector({ kind: '' }), null);
  assert.equal(normalizeSelector(null), null);
});

test('an unknown (plugin-private) selector kind is preserved verbatim, never discarded', () => {
  const sel = normalizeSelector({ kind: 'my-plugin/waveform', band: 3, note: 'x' });
  assert.deepEqual(sel, { kind: 'my-plugin/waveform', band: 3, note: 'x' });
});

test('a private selector resolves as unresolvable rather than being guessed at', () => {
  const ref = normalizeRef({ selectors: [{ kind: 'my-plugin/waveform', band: 3 }] });
  const res = resolveAnchor(ref, { kind: 'text', text: TEXT });
  assert.equal(res.status, 'unresolvable');
  assert.ok(needsAttention(res));
});

test('text-position is clamped so end can never precede start', () => {
  assert.deepEqual(normalizeSelector({ kind: 'text-position', start: 10, end: 4 }),
    { kind: 'text-position', start: 10, end: 10 });
});

test('normalizeRef accepts a bare selector, an array, or a full ref', () => {
  const one = { kind: 'text-quote', exact: 'wait' };
  assert.equal(normalizeRef(one).selectors.length, 1);
  assert.equal(normalizeRef([one, { kind: 'text-position', start: 0, end: 4 }]).selectors.length, 2);
  assert.equal(normalizeRef({ selectors: [one], expects: 'asset:abc' }).expects, 'asset:abc');
  assert.equal(normalizeRef({ selectors: [] }), null);
  assert.equal(normalizeRef(null), null);
});

const at = (needle, hay = TEXT) => hay.indexOf(needle);
const spanOf = (needle, hay = TEXT) => [hay.indexOf(needle), hay.indexOf(needle) + needle.length];

test('textRef records the quote FIRST and the position second (truth before cache)', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  assert.equal(ref.selectors[0].kind, 'text-quote');
  assert.equal(ref.selectors[0].exact, 'wait');
  assert.equal(ref.selectors[1].kind, 'text-position');
  assert.ok(ref.selectors[0].prefix.length <= CONTEXT_CHARS);
  assert.equal(textRef(TEXT, 5, 5), null); // empty span selects nothing
});

// --- the text ladder ---------------------------------------------------------

test('unchanged text resolves exact, at the cached position', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  const res = resolveAnchor(ref, { kind: 'text', text: TEXT });
  assert.equal(res.status, 'exact');
  assert.equal(TEXT.slice(res.start, res.end), 'wait');
  assert.ok(!needsAttention(res));
});

test('an edit BEFORE the span moves it, and the anchor follows', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  const edited = TEXT.replace('She said', 'Her daughter said, and I quote,');
  const res = resolveAnchor(ref, { kind: 'text', text: edited });
  assert.equal(res.status, 'moved');
  assert.equal(edited.slice(res.start, res.end), 'wait');
});

test('an edit AFTER the span leaves it exactly where it was', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  const res = resolveAnchor(ref, { kind: 'text', text: `${TEXT} She was upset.` });
  assert.equal(res.status, 'exact');
});

test('repeated text is disambiguated by prefix/suffix, not by luck', () => {
  const doc = 'yes I agree. no. yes I agree. maybe. yes I agree.';
  const second = doc.indexOf('yes I agree', doc.indexOf('yes I agree') + 1);
  const ref = textRef(doc, second, second + 'yes I agree'.length);
  const res = resolveAnchor(ref, { kind: 'text', text: doc });
  assert.equal(res.status, 'exact');
  assert.equal(res.start, second);

  // Now shift everything right; only the context can tell the three apart.
  const shifted = `Interviewer: ${doc}`;
  const res2 = resolveAnchor(ref, { kind: 'text', text: shifted });
  assert.equal(res2.status, 'moved');
  assert.equal(res2.start, second + 'Interviewer: '.length);
});

test('a repeat sitting exactly where it was cached is EXACT — nothing moved', () => {
  const doc = 'yes. yes. yes. yes.';
  const ref = normalizeRef({
    selectors: [{ kind: 'text-quote', exact: 'yes' }, { kind: 'text-position', start: 10, end: 13 }],
  });
  assert.equal(doc.slice(10, 13), 'yes');
  assert.equal(resolveAnchor(ref, { kind: 'text', text: doc }).status, 'exact');
});

test('genuinely ambiguous repeats report ambiguous and pick the nearest — never silently', () => {
  // No prefix/suffix recorded AND the hint is now stale: nothing can tell the four apart.
  const ref = normalizeRef({
    selectors: [{ kind: 'text-quote', exact: 'yes' }, { kind: 'text-position', start: 5, end: 8 }],
  });
  const res = resolveAnchor(ref, { kind: 'text', text: 'ok yes. yes. yes. yes.' });
  assert.equal(res.status, 'ambiguous');
  assert.match(res.reason, /appears 4 times/);
  assert.ok(needsAttention(res));
});

test('editing the coded text itself degrades to drifted with an approximate span', () => {
  const ref = textRef(TEXT, ...spanOf('we had to wait three hours before'));
  const edited = TEXT.replace('three hours', 'nearly three hours');
  const res = resolveAnchor(ref, { kind: 'text', text: edited });
  assert.equal(res.status, 'drifted');
  assert.ok(res.start >= 0 && res.end > res.start);
  assert.ok(needsAttention(res));
});

test('text that is gone reports orphaned — and never a position', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  const res = resolveAnchor(ref, { kind: 'text', text: 'A completely different transcript.' });
  assert.equal(res.status, 'orphaned');
  assert.equal(res.start, undefined);
  assert.ok(needsAttention(res));
});

test('a position-only anchor is reported ambiguous — it cannot verify itself', () => {
  const ref = normalizeRef({ selectors: [{ kind: 'text-position', start: 4, end: 8 }] });
  const res = resolveAnchor(ref, { kind: 'text', text: TEXT });
  assert.equal(res.status, 'ambiguous');
  assert.match(res.reason, /cannot verify/);
});

test('a position-only anchor past the end of the text is orphaned, not clamped', () => {
  const ref = normalizeRef({ selectors: [{ kind: 'text-position', start: 500, end: 520 }] });
  assert.equal(resolveAnchor(ref, { kind: 'text', text: TEXT }).status, 'orphaned');
});

// --- media -------------------------------------------------------------------

test('media with a matching asset is exact — content-addressed bytes cannot have moved', () => {
  const ref = mediaRef({ kind: 'time-span', tStart: 272, tEnd: 305 }, 'asset:abc');
  const res = resolveAnchor(ref, { kind: 'media', assetId: 'asset:abc', duration: 600 });
  assert.equal(res.status, 'exact');
});

test('a REPLACED media file is caught exactly — the failure text could not detect', () => {
  const ref = mediaRef({ kind: 'time-span', tStart: 272, tEnd: 305 }, 'asset:abc');
  const res = resolveAnchor(ref, { kind: 'media', assetId: 'asset:zzz', duration: 600 });
  assert.equal(res.status, 'drifted');
  assert.match(res.reason, /replaced/);
});

test('a span running past the end of the media is orphaned (the trimmed-recording case)', () => {
  const ref = mediaRef({ kind: 'time-span', tStart: 272, tEnd: 305 }, 'asset:abc');
  const res = resolveAnchor(ref, { kind: 'media', assetId: 'asset:abc', duration: 120 });
  assert.equal(res.status, 'orphaned');
  assert.match(res.reason, /past the end/);
});

test('image and video-track selectors resolve through the same envelope', () => {
  const rect = mediaRef({ kind: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'asset:img');
  assert.equal(resolveAnchor(rect, { kind: 'media', assetId: 'asset:img' }).status, 'exact');

  const track = mediaRef({ kind: 'rect-track', keys: [{ t: 1, x: 0, y: 0, w: 0.5, h: 0.5 }] }, 'asset:vid');
  assert.equal(resolveAnchor(track, { kind: 'media', assetId: 'asset:vid' }).status, 'exact');
  assert.equal(selectorOf(track, 'rect-track').keys.length, 1);
});

// --- rows --------------------------------------------------------------------

test('a row-set anchor reports partial loss rather than pretending to be whole', () => {
  const ref = normalizeRef({ selectors: [{ kind: 'row-set', rids: ['1', '2', '3'] }] });
  assert.equal(resolveAnchor(ref, { kind: 'rows', rids: ['1', '2', '3', '9'] }).status, 'exact');
  const partial = resolveAnchor(ref, { kind: 'rows', rids: ['1', '3'] });
  assert.equal(partial.status, 'drifted');
  assert.match(partial.reason, /1 row\(s\) are gone/);
  assert.equal(resolveAnchor(ref, { kind: 'rows', rids: ['7'] }).status, 'orphaned');
});

// --- the invariant that matters ---------------------------------------------

test('resolveAnchor NEVER mutates the ref it is given', () => {
  const ref = textRef(TEXT, ...spanOf('wait'));
  const before = JSON.stringify(ref);
  resolveAnchor(ref, { kind: 'text', text: 'something else entirely' });
  resolveAnchor(ref, { kind: 'text', text: TEXT });
  assert.equal(JSON.stringify(ref), before);
});
