/**
 * Headless tests for the plugin lifecycle envelope's pure core (#154).
 * Run: `npm test`.
 *
 * The governing rule these exist to pin down: **a plugin is failed only when something
 * SAYS it failed — elapsed time never decides.** The old handshake violated it, and
 * reported busy boots as crashes. Several tests below are specifically about what must
 * NOT happen, because the previous design's bug was an over-eager failure, not a missing
 * feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle, PendingCalls, advisory, ORDER } from '../core/plugin-lifecycle.js';

// --- the state machine -------------------------------------------------------

test('starts at created and progresses forward', () => {
  const lc = new Lifecycle();
  assert.equal(lc.step, 'created');
  for (const step of ORDER.slice(1)) lc.advance(step);
  assert.equal(lc.step, 'live');
  assert.ok(lc.isLive);
});

test('reached() answers "at least this far"', () => {
  const lc = new Lifecycle();
  lc.advance('loaded');
  assert.ok(lc.reached('caged'));
  assert.ok(lc.reached('loaded'));
  assert.ok(!lc.reached('activated'));
});

test('going backwards is IGNORED, not an error', () => {
  // A late duplicate from a slow frame is normal chatter. Treating it as a fault is
  // exactly the intolerance this rewrite removes.
  const lc = new Lifecycle();
  lc.advance('activated');
  lc.advance('caged');
  assert.equal(lc.step, 'activated');
  assert.ok(!lc.isFailed);
});

test('an unknown step is a programming error and throws', () => {
  const lc = new Lifecycle();
  assert.throws(() => lc.advance('wat'), /unknown step/);
  assert.throws(() => lc.reached('wat'), /unknown step/);
});

test('NOTHING in the machine fails on its own — only an explicit fail() does', () => {
  const lc = new Lifecycle();
  lc.advance('caged');
  assert.ok(!lc.isFailed, 'sitting mid-handshake is not failure');
  lc.fail('loaded', 'import threw');
  assert.deepEqual(lc.failure, { step: 'loaded', reason: 'import threw' });
});

test('the FIRST failure wins — later noise cannot overwrite the cause', () => {
  const lc = new Lifecycle();
  lc.fail('loaded', 'syntax error in plugin');
  lc.fail('activated', 'frame went away');
  assert.equal(lc.failure.reason, 'syntax error in plugin');
});

test('a failed surface stops advancing', () => {
  const lc = new Lifecycle();
  lc.fail('caged', 'CSP blocked the script');
  lc.advance('loaded');
  assert.equal(lc.step, 'created');
});

test('reset() is the user-initiated retry: back to the start, failure cleared', () => {
  const lc = new Lifecycle();
  lc.advance('caged');
  lc.fail('loaded', 'boom');
  lc.reset();
  assert.equal(lc.step, 'created');
  assert.equal(lc.failure, null);
  lc.advance('caged');
  assert.equal(lc.step, 'caged');
});

test('dispose() is terminal — nothing lands after it', () => {
  const lc = new Lifecycle();
  lc.dispose();
  lc.advance('caged');
  lc.fail('caged', 'ignored');
  assert.equal(lc.step, 'created');
  assert.equal(lc.failure, null);
  assert.ok(lc.isDisposed);
  assert.ok(!lc.isLive);
});

test('onChange fires on transitions, and a throwing listener cannot break the machine', () => {
  const seen = [];
  const lc = new Lifecycle({ onChange: (s) => { seen.push(s.step); throw new Error('listener blew up'); } });
  lc.advance('caged');
  lc.advance('loaded');
  assert.deepEqual(seen, ['caged', 'loaded']);
  assert.equal(lc.step, 'loaded');
});

// --- the request registry ----------------------------------------------------

test('each call gets its own id and promise', async () => {
  const p = new PendingCalls();
  const a = p.open('load');
  const b = p.open('mount');
  assert.notEqual(a.rid, b.rid);
  assert.equal(p.size, 2);
  p.settle(b.rid, { ok: true, value: 'B' });
  assert.equal(await b.promise, 'B');
  assert.equal(p.size, 1);
});

test('CONCURRENT hooks both resolve — the bug the single ack slot had', async () => {
  // Previously one #lifecycleAck field held the pending deferred, so a second hook
  // overwrote the first and it never resolved. Reachable with a dataset switch during a
  // workspace refresh.
  const p = new PendingCalls();
  const first = p.open('datasetChanged');
  const second = p.open('workspaceRefresh');
  p.settle(second.rid, { ok: true, value: 2 });
  p.settle(first.rid, { ok: true, value: 1 });
  assert.deepEqual(await Promise.all([first.promise, second.promise]), [1, 2]);
});

test('a rejected call carries its error', async () => {
  const p = new PendingCalls();
  const c = p.open('activate');
  p.settle(c.rid, { ok: false, error: 'plugin threw during activate' });
  await assert.rejects(c.promise, /plugin threw during activate/);
});

test('unknown and duplicate settles are ignored rather than throwing', async () => {
  const p = new PendingCalls();
  const c = p.open('load');
  assert.equal(p.settle('nope#1', { ok: true }), false);
  assert.equal(p.settle(c.rid, { ok: true, value: 1 }), true);
  assert.equal(p.settle(c.rid, { ok: true, value: 2 }), false, 'a guest echoing twice is chatter');
  assert.equal(await c.promise, 1);
});

test('rejectAll is how a pending call ends WITHOUT a timeout', async () => {
  const p = new PendingCalls();
  const a = p.open('load');
  const b = p.open('mount');
  p.rejectAll('workspace disposed');
  await assert.rejects(a.promise, /workspace disposed/);
  await assert.rejects(b.promise, /workspace disposed/);
  assert.equal(p.size, 0);
});

// --- the advisory policy -----------------------------------------------------

test('advisory NEVER reports failure, however long it has been', () => {
  // The whole point: CrossTab waits for hours if the analysis needs it.
  for (const elapsedMs of [0, 30_000, 60_000, 3_600_000, 86_400_000]) {
    const a = advisory({ step: 'loaded', elapsedMs });
    assert.ok(['ok', 'slow', 'quiet'].includes(a.level), `level was ${a.level}`);
    assert.ok(!/fail|error|crash/i.test(a.message), `message implied failure: ${a.message}`);
  }
});

test('advisory escalates wording only: ok → slow', () => {
  assert.equal(advisory({ step: 'caged', elapsedMs: 1_000 }).level, 'ok');
  assert.equal(advisory({ step: 'caged', elapsedMs: 45_000 }).level, 'slow');
});

test('a stale heartbeat reads as quiet — distinguishable from busy, still not failed', () => {
  const busy = advisory({ step: 'loaded', elapsedMs: 120_000, lastAliveMs: 1_000 });
  assert.equal(busy.level, 'slow', 'heartbeats arriving ⇒ working, not wedged');
  const quiet = advisory({ step: 'loaded', elapsedMs: 120_000, lastAliveMs: 40_000 });
  assert.equal(quiet.level, 'quiet');
  assert.match(quiet.message, /may still finish/);
});

test('advisory names the step, so the UI says WHAT is slow', () => {
  assert.match(advisory({ step: 'caged', elapsedMs: 45_000 }).message, /loading the plugin/);
  assert.match(advisory({ step: 'activated', elapsedMs: 45_000 }).message, /opening the workspace/);
});
