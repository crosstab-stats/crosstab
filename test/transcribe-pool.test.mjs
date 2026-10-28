/**
 * @file transcribe-pool.test.mjs
 * How many transcriptions run at once — the policy, without downloading a model.
 *
 * ## What this replaced, twice
 *
 * The first version refused a second job outright, on an unmeasured claim about phone
 * memory. The owner rejected that and was right.
 *
 * The second version divided a quarter of `navigator.deviceMemory` by a measured 219 MB
 * per worker. That was wrong too, and measurement said so:
 *
 *  - On a 16-core desktop with 32 GB it offered **ten** workers. Real speech peaks at
 *    **1.64x around four** and never improves — six of those ten bought nothing.
 *  - iOS reports no memory at all, and a phone crashed the tab on a SECOND `small` worker
 *    while the same model ran three deep on a desktop. No formula over published memory
 *    predicts that, because the cost is in the model's arenas.
 *
 * So the pool now starts at one, grows only while work is waiting and nothing has failed,
 * and steps back when a worker dies. These tests pin that behaviour.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, workerCeiling, MAX_WORKERS } from '../core/transcribe-pool.js';

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

const settle = () => new Promise((r) => { setTimeout(r, 0); });

// =============================================================================
// The ceiling is a sanity bound, not a prediction
// =============================================================================

test('the ceiling follows cores, capped where measurement stops rewarding', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, () => {
    // Sixteen cores could host eight by the halving rule, but real speech stopped
    // improving at four, so there is nothing to probe for beyond it.
    assert.equal(workerCeiling(), MAX_WORKERS);
  });
  await withNavigator({ hardwareConcurrency: 4 }, () => {
    assert.equal(workerCeiling(), 2);
  });
  await withNavigator({ hardwareConcurrency: 1 }, () => {
    assert.equal(workerCeiling(), 1);
  });
});

test('a device that says nothing still gets a working answer', async () => {
  await withNavigator({}, () => {
    assert.equal(workerCeiling(), 1);
  });
});

test('memory is not consulted at all any more', async () => {
  // The whole point: deviceMemory predicted ten where four was the answer, and iOS
  // publishes nothing. Two devices differing ONLY in reported memory must agree.
  const a = await withNavigator({ hardwareConcurrency: 8, deviceMemory: 64 }, () => workerCeiling());
  const b = await withNavigator({ hardwareConcurrency: 8 }, () => workerCeiling());
  assert.equal(a, b);
});

// =============================================================================
// Start at one, grow by trying
// =============================================================================

test('it starts at one worker whatever the device claims', async () => {
  await withNavigator({ hardwareConcurrency: 16, deviceMemory: 64 }, () => {
    const pool = createPool();
    assert.equal(pool.limit, 1, 'one is what every device can manage');
    assert.equal(pool.ceiling, MAX_WORKERS);
    assert.equal(pool.probing, true);
  });
});

test('it grows only after a success, and only with work waiting', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool();
    const jobs = [deferred(), deferred(), deferred()];
    let started = 0;
    const results = jobs.map((j) => pool.run(() => { started += 1; return j.promise; }));

    await settle();
    assert.equal(started, 1, 'one at a time until something proves it works');
    assert.equal(pool.pending, 2);

    jobs[0].resolve('a');
    await results[0];
    await settle();
    assert.equal(pool.limit, 2, 'a success with work waiting earns one more');
    assert.equal(started, 3, 'and both waiting jobs are now running');

    jobs[1].resolve('b');
    jobs[2].resolve('c');
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c']);
  });
});

test('it does NOT grow into an empty queue', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool();
    // A worker's memory to achieve nothing is the exact mistake the old arithmetic made.
    await pool.run(() => Promise.resolve('only job'));
    await settle();
    assert.equal(pool.limit, 1);
  });
});

test('it stops growing at the ceiling', async () => {
  await withNavigator({ hardwareConcurrency: 4 }, async () => {
    const pool = createPool();          // ceiling 2
    const jobs = [deferred(), deferred(), deferred(), deferred()];
    const results = jobs.map((j) => pool.run(() => j.promise));
    await settle();
    jobs[0].resolve(1);
    await results[0];
    await settle();
    assert.equal(pool.limit, 2);
    assert.equal(pool.probing, false, 'nothing left to probe for');
    jobs.slice(1).forEach((j) => j.resolve(1));
    await Promise.all(results);
    assert.equal(pool.limit, 2, 'and it does not creep past the ceiling');
  });
});

// =============================================================================
// Back off when the device refuses
// =============================================================================

test('a dead worker steps the limit back and retries the job once', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const changes = [];
    const pool = createPool({ start: 3, onChange: (i) => changes.push(i) });
    let attempt = 0;
    const value = await pool.run(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('worker failed to load'));
      return Promise.resolve('second time lucky');
    });
    assert.equal(value, 'second time lucky');
    assert.equal(attempt, 2, 'retried once');
    assert.equal(pool.limit, 2, 'at a lower limit');
    assert.equal(pool.probing, false, 'and it stops asking for more');
    assert.match(changes.at(-1).reason, /backing off/);
  });
});

test('once a worker has died it never grows again', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool({ start: 2 });
    await pool.run(() => Promise.reject(new Error('worker failed to load')))
      .then(() => {}, () => {});
    assert.equal(pool.probing, false);
    // Plenty of successful work with a full queue must not tempt it back up.
    const jobs = [deferred(), deferred()];
    const rs = jobs.map((j) => pool.run(() => j.promise));
    await settle();
    jobs[0].resolve(1);
    await rs[0];
    await settle();
    assert.equal(pool.limit, 1, 'the device already said no');
    jobs[1].resolve(1);
    await Promise.all(rs);
  });
});

test('a job that keeps failing is the job’s fault, not the device’s', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool({ start: 3 });
    await assert.rejects(
      pool.run(() => Promise.reject(new Error('worker failed to load'))),
      /worker failed to load/,
    );
    assert.ok(pool.limit >= 1, 'it does not shrink forever on a corrupt file');
  });
});

test('an ordinary error does not move the limit', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool({ start: 2 });
    await assert.rejects(
      pool.run(() => Promise.reject(new Error('Transcription cancelled.'))),
      /cancelled/,
    );
    assert.equal(pool.limit, 2, 'a cancelled job says nothing about memory');
    assert.equal(pool.probing, true);
  });
});

test('the limit never goes below one', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool();
    await assert.rejects(
      pool.run(() => Promise.reject(new Error('worker failed to load'))),
      /worker failed/,
    );
    assert.equal(pool.limit, 1);
  });
});

// =============================================================================
// The user, and the explanation
// =============================================================================

test('the user outranks the probe', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const changes = [];
    const pool = createPool({ onChange: (i) => changes.push(i) });
    pool.setLimit(3);
    assert.equal(pool.limit, 3);
    assert.equal(pool.probing, false, 'a deliberate choice ends the guessing');
    assert.equal(changes.at(-1).adapted, false, 'reported as a choice, not an adaptation');
    pool.setLimit(0);
    assert.equal(pool.limit, 1, 'but not to zero');
  });
});

test('raising the limit starts waiting work immediately', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool();
    const jobs = [deferred(), deferred()];
    let started = 0;
    jobs.forEach((j) => pool.run(() => { started += 1; return j.promise; }));
    await settle();
    assert.equal(started, 1);
    pool.setLimit(2);
    await settle();
    assert.equal(started, 2, 'not on the next completion');
    jobs.forEach((j) => j.resolve(null));
  });
});

test('the basis is explicable, because the UI has to show it', async () => {
  await withNavigator({ hardwareConcurrency: 8 }, async () => {
    const pool = createPool();
    assert.match(pool.basis, /cores/, '"running 1 at a time" needs a because');
    pool.setLimit(2);
    assert.match(pool.basis, /\d/);
  });
});

test('it reports the most it ever managed, which is what to remember', async () => {
  await withNavigator({ hardwareConcurrency: 16 }, async () => {
    const pool = createPool();
    const jobs = [deferred(), deferred(), deferred()];
    const rs = jobs.map((j) => pool.run(() => j.promise));
    await settle();
    jobs[0].resolve(1);
    await rs[0];
    await settle();
    assert.ok(pool.reached >= 2, `reached ${pool.reached}`);
    jobs.slice(1).forEach((j) => j.resolve(1));
    await Promise.all(rs);
  });
});
