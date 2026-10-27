/**
 * @file transcribe-pool.test.mjs
 * How many transcriptions run at once — the policy, without downloading a model.
 *
 * ## What this replaced, and why
 *
 * The first version of the service threw on a second job, justified in a commit message by
 * "two models and an hour of audio in parallel is how a phone runs out of memory". That
 * was never measured, batch-transcribing interviews is an ordinary need, and one weak
 * device should not cap every device. All three objections were right.
 *
 * ## What the measurement says (spike/transcribe-pressure.html, 2026-10-27)
 *
 *  - One loaded `whisper-tiny` q8 worker costs **219 MB** — a 39 MB model, so the ONNX
 *    arenas are ~5.6× the weights.
 *  - Cost is **linear**: 219.0 / 218.8 / 218.8 / 218.5 MB for workers 1–4. Nothing shared.
 *  - `terminate()` **fully reclaims** (876 MB → 0.9 MB baseline), so per-job workers are
 *    fine and reuse is about skipping a ~1 s reload, not about leaks.
 *  - **A device may refuse to say anything.** `navigator.deviceMemory` is Chromium-only
 *    and `measureUserAgentSpecificMemory` needs cross-origin isolation, so on iOS Safari
 *    there is no gauge — which is why the pool adapts on evidence instead of reading one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, deviceCapacity } from '../core/transcribe-pool.js';

/** A job that resolves when told, so concurrency is observable rather than timed. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const withNavigator = async (nav, fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator');
  const prev = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try { return await fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', { value: prev, configurable: true, writable: true });
    else delete globalThis.navigator;
  }
};

// =============================================================================
// Capacity — what a device is willing to say
// =============================================================================

test('a device that reports memory gets a memory-based limit', async () => {
  // 32 GB at a 25% budget is 8192 MB; at 219 MB each that is 37 workers, capped by cores.
  await withNavigator({ deviceMemory: 32, hardwareConcurrency: 16 }, () => {
    const c = deviceCapacity({ size: 'tiny' });
    assert.equal(c.measured, true);
    assert.equal(c.concurrency, 10, 'capped at 10, not 16 or 37');
    assert.match(c.basis, /32 GB/);
  });
});

test('a small device gets a small limit, from the same arithmetic', async () => {
  // 2 GB → 512 MB budget → two workers at 219 MB. Not a special case, just the sum.
  await withNavigator({ deviceMemory: 2, hardwareConcurrency: 4 }, () => {
    assert.equal(deviceCapacity({ size: 'tiny' }).concurrency, 2);
  });
  // And a bigger model means fewer of them, which is the point of pricing per size.
  await withNavigator({ deviceMemory: 2, hardwareConcurrency: 4 }, () => {
    assert.equal(deviceCapacity({ size: 'small' }).concurrency, 1);
  });
});

test('cores cap the limit even when memory is plentiful', async () => {
  // Transcription is CPU-bound and ORT already threads inside each worker, so more
  // workers than cores buys contention.
  await withNavigator({ deviceMemory: 64, hardwareConcurrency: 4 }, () => {
    assert.equal(deviceCapacity({ size: 'tiny' }).concurrency, 4);
  });
});

test('NO memory reading is the iOS case, and it is handled honestly', async () => {
  // Safari reports neither deviceMemory nor measureUserAgentSpecificMemory. The pool must
  // not silently pretend to have measured something.
  await withNavigator({ hardwareConcurrency: 8 }, () => {
    const c = deviceCapacity({ size: 'tiny' });
    assert.equal(c.measured, false, 'and it SAYS it did not measure');
    assert.equal(c.concurrency, 3, 'half the cores, capped while blind');
    assert.match(c.basis, /no memory reading/);
  });
  await withNavigator({ hardwareConcurrency: 2 }, () => {
    assert.equal(deviceCapacity({}).concurrency, 1);
  });
});

test('a device that says nothing at all still gets a working answer', async () => {
  await withNavigator({}, () => {
    assert.equal(deviceCapacity({}).concurrency, 1);
  });
});

// =============================================================================
// The queue
// =============================================================================

test('it runs up to the limit at once and queues the rest', async () => {
  const pool = createPool({ concurrency: 2 });
  const jobs = [deferred(), deferred(), deferred()];
  let started = 0;
  const started1 = [];
  const results = jobs.map((j, i) => pool.run(() => { started += 1; started1.push(i); return j.promise; }));

  await Promise.resolve();
  assert.equal(started, 2, 'two running');
  assert.equal(pool.pending, 1, 'one waiting');

  jobs[0].resolve('a');
  await results[0];
  // One more tick: `resolve(value)` queues this await's continuation BEFORE `pump()`
  // queues the next job's start, so the queued job has not run its body yet here.
  await Promise.resolve();
  assert.equal(started, 3, 'the third starts when a slot frees');

  jobs[1].resolve('b');
  jobs[2].resolve('c');
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
  assert.equal(pool.running, 0);
});

test('a dead worker shrinks the limit and retries the job once', async () => {
  // There is no portable out-of-memory exception in a browser — the signal is the worker
  // dying. That signal exists on every device, including the ones that will not report
  // memory, which is what makes this the mechanism rather than a gauge.
  const changes = [];
  const pool = createPool({ concurrency: 3, onChange: (i) => changes.push(i) });
  let attempt = 0;
  const value = await pool.run(() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error('worker failed to load'));
    return Promise.resolve('second time lucky');
  });
  assert.equal(value, 'second time lucky');
  assert.equal(attempt, 2, 'retried once');
  assert.equal(pool.limit, 2, 'and the limit came down');
  assert.deepEqual(changes.map((c) => c.adapted), [true]);
  assert.match(changes[0].reason, /ran out of room/);
});

test('a job that keeps failing is the job’s fault, not the device’s', async () => {
  // Shrinking forever on a corrupt file would end with a limit of 1 and the same error.
  const pool = createPool({ concurrency: 3 });
  await assert.rejects(
    pool.run(() => Promise.reject(new Error('worker failed to load'))),
    /worker failed to load/,
  );
  assert.equal(pool.limit, 2, 'shrank once, then believed the job');
});

test('an ordinary error does not shrink anything', async () => {
  // A cancelled job or an undecodable file says nothing about memory.
  const pool = createPool({ concurrency: 3 });
  await assert.rejects(pool.run(() => Promise.reject(new Error('Transcription cancelled.'))), /cancelled/);
  assert.equal(pool.limit, 3);
});

test('the limit never goes below one', async () => {
  const pool = createPool({ concurrency: 1 });
  await assert.rejects(pool.run(() => Promise.reject(new Error('worker failed to load'))), /worker failed/);
  assert.equal(pool.limit, 1, 'nothing left to give up');
});

test('the user outranks the device reading', async () => {
  // The whole premise is that devices differ, so a person who knows their machine beats
  // our arithmetic about it.
  const changes = [];
  const pool = createPool({ concurrency: 2, onChange: (i) => changes.push(i) });
  pool.setLimit(6);
  assert.equal(pool.limit, 6);
  assert.equal(changes.at(-1).adapted, false, 'reported as a choice, not an adaptation');
  pool.setLimit(0);
  assert.equal(pool.limit, 1, 'but not to zero');
});

test('raising the limit immediately starts waiting work', async () => {
  const pool = createPool({ concurrency: 1 });
  const jobs = [deferred(), deferred()];
  let started = 0;
  jobs.forEach((j) => pool.run(() => { started += 1; return j.promise; }));
  await Promise.resolve();
  assert.equal(started, 1);
  pool.setLimit(2);
  await Promise.resolve();
  assert.equal(started, 2, 'the queued one goes now, not on the next completion');
  jobs.forEach((j) => j.resolve(null));
});

test('the basis is explicable, because the UI has to show it', () => {
  const pool = createPool({ concurrency: 2 });
  assert.ok(pool.basis && /cores|GB/.test(pool.basis),
    '"running 2 at a time" needs a because');
});
