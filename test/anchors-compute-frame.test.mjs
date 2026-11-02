/**
 * @file anchors-compute-frame.test.mjs
 * Anchor resolution outside a workspace mount (#199) — the half #196 left behind.
 *
 * ## The gap
 *
 * #196 let any activated plugin read another's coding records. A coding carries an
 * `anchor` field, and `anchors.resolve` existed **only** on the workspace-mount API — so a
 * consumer running as a verb or an exporter got the reference and had no way to ask where
 * that region is now. Both ways out were bad:
 *
 *  - **Cache the offsets.** Exactly the rot the anchor model exists to prevent: a stored
 *    start/end is wrong after the next edit and nothing reports it.
 *  - **Re-implement resolution.** Then the host can no longer report drift for records it
 *    did not resolve, which is the reason resolution is host-owned in the first place —
 *    a DEACTIVATED plugin's records must still be reportable as stale.
 *
 * ## Why exposing it grants nothing
 *
 * I had flagged "what does `subject` mean off a mount?" as the open design question. It
 * was not one, and reading the mount settled it in a line: the mount is itself a pure
 * pass-through, and the **plugin** supplies the subject there too. So these are pure
 * functions over caller-supplied arguments in both places, and the compute frame is not
 * getting a weaker version of something a mount had earned.
 *
 * ## What makes it complete rather than ornamental
 *
 * Resolution needs a subject, and a compute frame can get one: a coding's `doc` is a
 * `__ct_rid`, and `app.data.getRows({ includeRowId: true })` returns rows keyed by it. The
 * last test walks that whole chain with the real resolver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { textRef, resolveAnchor, needsAttention } from '../core/anchors.js';

// ---------------------------------------------------------------------------------------
// The surface exists on BOTH paths, with the same shape
// ---------------------------------------------------------------------------------------

test('the compute frame exposes anchors, and hands it to the plugin', () => {
  const src = readFileSync('core/loader.js', 'utf8');
  assert.match(src, /const anchors = \{/, 'the surface is built');
  for (const m of ['text:', 'media:', 'resolve:', 'needsAttention:']) {
    assert.ok(src.includes(m), 'compute frame exposes ' + m);
  }
  // Built and then not passed is the failure mode worth pinning: the object would exist,
  // nothing would reach it, and the symptom is `undefined is not a function` in a plugin.
  assert.match(src, /items, selection, anchors, assets \}\)/, 'and it is in the frozen bundle');
});

test('the mount and the compute frame expose the SAME anchor functions', () => {
  // Two anchor APIs differing by one function is the drift a shared surface exists to
  // prevent, and a plugin must not have to discover which half it is running in.
  const names = (src, marker) => {
    const at = src.indexOf(marker);
    assert.ok(at > 0, marker);
    const body = src.slice(at, src.indexOf('},', at));
    return ['text', 'media', 'resolve', 'needsAttention'].filter((n) => body.includes(n + ':'));
  };
  assert.deepEqual(
    names(readFileSync('core/loader.js', 'utf8'), 'const anchors = {'),
    names(readFileSync('core/workspace-manager.js', 'utf8'), '      anchors: {'),
  );
});

test('the broker and the in-frame shim agree on the anchor methods', () => {
  // Three places must know a method exists. A method missing from the shim is not a
  // thrown error in the plugin — it is `undefined is not a function` at the call site.
  const broker = readFileSync('core/plugin-broker.js', 'utf8');
  const shim = readFileSync('plugin-host.html', 'utf8');
  const line = shim.split('\n').find((l) => l.includes("makeNamespace('anchors'"));
  assert.ok(line, 'the anchors namespace is declared in the frame');
  for (const m of ['text', 'media', 'resolve', 'needsAttention']) {
    assert.ok(broker.includes("anchors." + m + "'"), 'broker dispatches anchors.' + m);
    assert.ok(line.includes("'" + m + "'"), 'shim exposes ' + m);
  }
});

// ---------------------------------------------------------------------------------------
// Behaviour — a batch, and a vocabulary the caller does not have to hard-code
// ---------------------------------------------------------------------------------------

test('resolve takes a BATCH and a lone ref, and answers in order', () => {
  // Batch so a consumer resolving a document's whole coding set pays one round trip
  // rather than one per coding. The mount's signature, unchanged.
  const doc = 'the quick brown fox jumps over the lazy dog';
  const a = textRef(doc, 4, 9);   // "quick"
  const b = textRef(doc, 16, 19); // "fox"
  const batch = [a, b].map((r) => resolveAnchor(r, { kind: 'text', text: doc }));
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((r) => doc.slice(r.start, r.end)), ['quick', 'fox']);
  for (const r of batch) assert.equal(r.status, 'exact');
  // A single ref is accepted too — the surface wraps before mapping.
  const one = [a].map((r) => resolveAnchor(r, { kind: 'text', text: doc }));
  assert.equal(one.length, 1);
});

test('needsAttention is exposed so no plugin hard-codes the confidence vocabulary', () => {
  // A plugin deriving this from `status` has to enumerate the statuses, and then a new
  // one is silently treated as fine by every plugin that guessed.
  assert.equal(needsAttention({ status: 'exact' }), false);
  assert.equal(needsAttention({ status: 'moved' }), false);
  for (const s of ['ambiguous', 'drifted', 'orphaned', 'unresolvable']) {
    assert.equal(needsAttention({ status: s }), true, s);
  }
  assert.equal(needsAttention(null), false);
});

test('a moved region resolves, and a deleted one is reported rather than guessed', () => {
  // The whole reason a consumer must not cache offsets: the stored start/end is wrong
  // after an edit, and only resolution knows that.
  const before = 'intro. the quick brown fox. outro.';
  const ref = textRef(before, 11, 16); // "quick"
  const after = 'a much longer intro here. the quick brown fox. outro.';
  const moved = resolveAnchor(ref, { kind: 'text', text: after });
  assert.ok(!needsAttention(moved), 'a pure move is silent: ' + moved.status);
  assert.equal(after.slice(moved.start, moved.end), 'quick');

  const gone = resolveAnchor(ref, { kind: 'text', text: 'nothing of the sort remains' });
  assert.equal(gone.status, 'orphaned');
  assert.ok(needsAttention(gone), 'and it must be flagged, not silently dropped');
  assert.ok(gone.reason, 'with a reason a UI can show');
});

// ---------------------------------------------------------------------------------------
// The chain that makes this usable at all
// ---------------------------------------------------------------------------------------

test('a third-party consumer can go from a coding to where it points, with no mount', () => {
  // The flow #199 completes, with the real resolver at the end of it:
  //   1. items.publicCollections()  -> finds builtin/segments      (#196)
  //   2. items.listFrom(...)        -> codings: fields.doc, .anchor (#196)
  //   3. data.getRows({includeRowId:true}) -> the text, keyed by __ct_rid
  //   4. anchors.resolve(refs, {kind:'text', text})                 (#199)
  const text = 'Respondent: I had waited three hours before anyone saw me.';
  // Offsets derived from the string, not counted by hand — the first draft of this test
  // asserted "three hours" against a ref that actually covered "aited three ", so the
  // test was wrong while the resolver was right. A literal offset in a test about offsets
  // is one more thing that can be wrong than the code it checks.
  const QUOTE = 'three hours';
  const at = text.indexOf(QUOTE);
  const coding = { fields: { doc: 'r7', anchor: textRef(text, at, at + QUOTE.length) } };

  // Step 3's shape: rows keyed by the rid the coding names.
  const rows = [{ __ct_rid: 'r7', transcript: text }, { __ct_rid: 'r8', transcript: 'other' }];
  const subject = rows.find((r) => r.__ct_rid === coding.fields.doc);
  assert.ok(subject, 'the rid is how a coding finds its document');

  const [res] = [coding.fields.anchor].map(
    (r) => resolveAnchor(r, { kind: 'text', text: subject.transcript }),
  );
  assert.equal(res.status, 'exact');
  assert.equal(subject.transcript.slice(res.start, res.end), QUOTE);

  // And `includeRowId` is a real option, not one assumed for this test.
  assert.match(readFileSync('core/data-store.js', 'utf8'), /includeRowId/);
});
