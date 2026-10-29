/**
 * @file transcribe-pool.js
 * How many transcriptions run at once — discovered by trying, not calculated.
 *
 * ## What the previous version got wrong
 *
 * It divided a quarter of `navigator.deviceMemory` by a measured 219 MB per worker. That
 * arithmetic is wrong twice over, and both errors were found by measuring:
 *
 *  - **It predicts the wrong number.** On a 16-core desktop with 32 GB it offered ten
 *    workers. Measured on real speech, throughput peaks at **1.64x around four workers and
 *    never improves again** — so six of those ten were 219 MB each buying nothing. The
 *    *blind* branch (`cores / 2`) was closer to the truth than the one with data.
 *  - **It cannot see the thing that actually fails.** iOS reports no memory at all, and a
 *    phone with 238 MB-weight `small` workers crashed the tab on the second one while the
 *    same model ran three deep on a desktop. No formula over reported memory predicts that,
 *    because the cost depends on the model's arenas, not on a number the device publishes.
 *
 * ## What it does instead
 *
 * Start with **one** worker, which every device can manage. Whenever there is work waiting
 * and nothing has failed yet, allow one more. A worker that dies taking its job with it is
 * the signal to stop and step back down — that signal exists on every device, including the
 * ones that report nothing.
 *
 * The ceiling is a sanity bound rather than a prediction: measured on real speech, two
 * workers give ~1.4x and three ~1.7x, and past four nothing moves even with sixteen cores
 * available. There is no point probing into a region with no reward.
 *
 * Worth knowing when reading the numbers above: **worker count does not change the
 * transcript.** The same audio through one worker and through three produced identical
 * output, word for word, on two different browser engines. Concurrency buys wall-clock on a
 * batch of files and nothing else.
 */

/** Past this, measurement shows no further throughput on any device tried. */
export const MAX_WORKERS = 4;

/**
 * How many times one piece of work may be attempted when the DEVICE is what refused.
 *
 * Only device-limit failures are retried — a job that threw because the audio is broken
 * will throw again, and retrying it just wastes the user's battery.
 */
export const MAX_ATTEMPTS = 3;

/**
 * How long to wait before re-attempting after the device ran out.
 *
 * Immediately re-running is the same attempt with a different name: whatever was holding
 * the memory has not finished letting go of it. Long enough to matter, short enough that
 * a recoverable stumble does not look like a stall.
 */
export const RETRY_PAUSE_MS = 2000;

/**
 * The most workers worth *attempting* on this device.
 *
 * Not a prediction of what will fit — the probe discovers that. This only avoids climbing
 * into a region measurement says is empty: transcription is CPU-bound and the ONNX runtime
 * already threads inside each worker, so more workers than half the cores buys contention.
 */
export function workerCeiling({ max = MAX_WORKERS } = {}) {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(max, Math.floor(cores / 2) || 1));
}

/** A failure that means the DEVICE said no, as opposed to the job being bad. */
function looksLikeDeviceLimit(err) {
  return /worker failed|terminated|out of memory|allocation|load failed|Failed to (fetch|construct)/i
    .test(String(err?.message ?? ''));
}

/**
 * A queue that starts at one worker and grows only as far as the device allows.
 *
 * `run(fn)` takes a function returning a promise; the pool neither knows nor cares that it
 * is transcription, which is what makes the policy testable without downloading a model.
 *
 * @param {object} [opts]
 * @param {number} [opts.max]  hard ceiling on attempts
 * @param {number} [opts.start]  how many to begin with (one, unless a caller insists)
 * @param {(info: object) => void} [opts.onChange]  called whenever the limit moves, so the
 *   UI can say what happened rather than appearing to slow down for no reason
 */
export function createPool({
  max = MAX_WORKERS, start = 1, onChange = null, retryPauseMs = RETRY_PAUSE_MS,
} = {}) {
  const ceiling = Math.max(1, Math.min(workerCeiling({ max }), max));
  let limit = Math.max(1, Math.min(start, ceiling));
  let probing = limit < ceiling;      // until the device refuses, or we reach the ceiling
  let reached = limit;                // the most that ever ran at once
  let running = 0;
  let paused = false;
  const queue = [];

  const announce = (reason, adapted) => onChange?.({
    limit, ceiling, probing, reason, adapted,
  });

  const pump = () => {
    // A real pause, and only because the work is segmented. There is no cooperative yield
    // inside a model call, so a running segment always finishes — but the NEXT one does not
    // start, which for a queue of interviews means stopping within a couple of minutes
    // rather than at the end of the batch.
    if (paused) return;
    while (running < limit && queue.length) {
      const job = queue.shift();
      running += 1;
      reached = Math.max(reached, running);
      job.start();
    }
  };

  /**
   * One more, if there is anything for it to do.
   *
   * Only ever after a job has SUCCEEDED, and only while work is waiting: growing into an
   * empty queue costs a worker's memory to achieve nothing, and growing after a failure is
   * how you discover the same limit twice.
   */
  const grow = () => {
    if (!probing || limit >= ceiling || !queue.length) return;
    limit += 1;
    if (limit >= ceiling) probing = false;
    announce(`trying ${limit} at once`, true);
    pump();
  };

  /** The device refused. Step back and stop asking. */
  const backOff = (reason) => {
    probing = false;
    if (limit <= 1) {
      announce(`${reason} — already at one, nothing left to give up`, true);
      return false;
    }
    limit -= 1;
    announce(`${reason} — backing off to ${limit}`, true);
    return true;
  };

  return {
    get limit() { return limit; },
    get ceiling() { return ceiling; },
    get running() { return running; },
    get pending() { return queue.length; },
    get probing() { return probing; },
    get reached() { return reached; },

    /** Why this many, in words a person can read. */
    get basis() {
      const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
      if (probing) return `${limit} at once, trying for more (${cores} cores, up to ${ceiling})`;
      if (limit < ceiling) return `${limit} at once — this device would not take more`;
      return `${limit} at once (${cores} cores)`;
    },

    get paused() { return paused; },
    /** Stop starting new work. Anything already running finishes — see `pump`. */
    pause() {
      if (paused) return;
      paused = true;
      announce('paused', false);
    },
    resume() {
      if (!paused) return;
      paused = false;
      announce('resumed', false);
      pump();
    },

    /** The user's call beats ours; devices differ more than any rule about them. */
    setLimit(n) {
      limit = Math.max(1, Math.floor(n) || 1);
      probing = false;
      announce('set by you', false);
      pump();
    },

    run(fn) {
      return new Promise((resolve, reject) => {
        let attempts = 0;
        const attempt = () => {
          attempts += 1;
          Promise.resolve()
            .then(fn)
            .then(
              (value) => {
                running -= 1;
                resolve(value);
                // Succeeded, so this many demonstrably fits. Ask for one more.
                grow();
                pump();
              },
              (err) => {
                running -= 1;
                // There is no portable out-of-memory exception in a browser: the signal is
                // a worker dying. Step back whatever happens next — one refusal is enough
                // to stop asking for more.
                const deviceLimit = looksLikeDeviceLimit(err);
                if (deviceLimit) backOff('a worker died');
                // Retry EVEN WHEN ALREADY AT ONE. The old condition made the retry
                // conditional on `backOff` having something left to give up, so a failure
                // at one worker got no second attempt at all — and that is the case most
                // worth retrying, because the memory that was not there a moment ago
                // usually is once the worker competing for it has finished. The pause is
                // what makes it a different attempt rather than the same one again: the
                // browser needs a moment to actually release what it just reclaimed.
                if (deviceLimit && attempts < MAX_ATTEMPTS) {
                  queue.unshift({ start: () => { setTimeout(attempt, retryPauseMs); } });
                  pump();
                  return;
                }
                reject(err);
                pump();
              },
            );
        };
        queue.push({ start: attempt });
        pump();
      });
    },
  };
}
