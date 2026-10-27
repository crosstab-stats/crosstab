/**
 * @file transcribe-pool.js
 * How many transcriptions run at once — measured, adaptive, and per device.
 *
 * ## Why this exists
 *
 * The first version refused a second job outright, on the grounds that "two models and an
 * hour of audio in parallel is how a phone runs out of memory". The owner rejected that,
 * correctly, on three counts: **it was never measured**, **transcribing several interviews
 * is an ordinary need**, and **one weak device should not set the ceiling for every
 * device**.
 *
 * So it was measured (`spike/transcribe-pressure.html`, desktop Chrome, 2026-10-27):
 *
 *  - One worker with `whisper-tiny` q8 loaded costs **219 MB** — the weights are 39 MB, so
 *    the ONNX runtime's arenas are about 5.6× the model.
 *  - It is **perfectly linear**: 219.0, 218.8, 218.8, 218.5 MB for workers one to four.
 *    Separate memory spaces share nothing, so N workers really do cost N times one.
 *  - `terminate()` **reclaims promptly and completely** — 876 MB back to the 0.9 MB
 *    baseline. Spawning per job is therefore fine; the pool reuses workers to skip the
 *    ~1 s model reload, not to avoid a leak.
 *
 * ## Why it adapts rather than reading a number
 *
 * The honest finding from the same spike is that **a device may not tell you anything**.
 * `navigator.deviceMemory` is Chromium-only and `performance.measureUserAgentSpecificMemory`
 * needs cross-origin isolation — on iOS Safari, where a good deal of this will run, there
 * is no memory gauge at all. A policy that depends on reading one would silently fall back
 * to a guess on exactly the devices where the guess matters most.
 *
 * So the pool starts from whatever the device WILL say, then **adapts on evidence**: a
 * worker that dies is a real signal available everywhere, and it costs one requeued job to
 * learn from. That is the mechanism that makes "a new phone gets two, an old phone one, an
 * iPad four, a desktop ten" happen without anyone maintaining a table of devices.
 */

/** Measured: one loaded `whisper-tiny` q8 worker, desktop Chrome, 2026-10-27. The bigger
 * models are scaled from their download, since the arena cost is mostly fixed. */
const WORKER_MB = Object.freeze({ tiny: 219, base: 253, small: 418 });

/** Of the memory a device admits to, how much this feature may use. A quarter leaves the
 * browser, the page, DuckDB and WebR room — CrossTab is not alone in this tab. */
const BUDGET_FRACTION = 0.25;

/** Without a gauge, what a core count is worth. Transcription is CPU-bound, so more
 * workers than cores buys nothing — and ORT already threads inside each worker, so the
 * cores are shared rather than owned. Half, floored at one, capped where memory on an
 * unknown device stops being a guess and starts being a gamble. */
const BLIND_CAP = 3;

/**
 * What this device is willing to say about itself.
 *
 * Exported because the UI should be able to show it: "running 2 at a time" is an
 * explicable number, and a user who disagrees can change it.
 */
export function deviceCapacity({ size = 'tiny' } = {}) {
  const cores = Number(navigator?.hardwareConcurrency) || 2;
  const gb = Number(navigator?.deviceMemory) || 0;
  const perWorker = WORKER_MB[size] ?? WORKER_MB.tiny;

  if (gb > 0) {
    const budgetMb = gb * 1024 * BUDGET_FRACTION;
    const byMemory = Math.floor(budgetMb / perWorker);
    return {
      concurrency: Math.max(1, Math.min(byMemory, cores, 10)),
      basis: `${gb} GB reported, ~${perWorker} MB per worker`,
      measured: true,
    };
  }
  // No gauge — iOS Safari, and anywhere else that declines to answer. Be modest and let
  // the adaptation do the rest; a device that copes will not be punished for long.
  return {
    concurrency: Math.max(1, Math.min(Math.floor(cores / 2), BLIND_CAP)),
    basis: `${cores} cores, no memory reading available`,
    measured: false,
  };
}

/**
 * A queue that runs up to `concurrency` jobs at once and shrinks when the device objects.
 *
 * `run(fn)` takes a function returning a promise — the pool does not know or care that it
 * is transcription, which keeps the policy testable without a 39 MB download.
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency]  overrides the device reading
 * @param {(info: object) => void} [opts.onChange]  called when the limit adapts, so the UI
 *   can say what happened rather than appearing to slow down for no reason
 */
export function createPool({ concurrency, onChange = null, size = 'tiny' } = {}) {
  const cap = deviceCapacity({ size });
  let limit = Math.max(1, concurrency || cap.concurrency);
  let running = 0;
  const queue = [];

  const pump = () => {
    while (running < limit && queue.length) {
      const job = queue.shift();
      running += 1;
      job.start();
    }
  };

  /**
   * A job died. If it looks like the device running out rather than the audio being bad,
   * shrink and retry it — once. A second failure at a lower limit is about the job.
   */
  const shrink = (reason) => {
    if (limit <= 1) return false;
    limit -= 1;
    onChange?.({ limit, reason, adapted: true });
    return true;
  };

  return {
    get limit() { return limit; },
    get running() { return running; },
    get pending() { return queue.length; },
    get basis() { return cap.basis; },
    /** The user's call beats ours — the whole point is that devices differ. */
    setLimit(n) {
      limit = Math.max(1, Math.floor(n) || 1);
      onChange?.({ limit, reason: 'set by you', adapted: false });
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
              (value) => { running -= 1; resolve(value); pump(); },
              (err) => {
                running -= 1;
                // An out-of-memory shows up as the worker dying, not as a typed error —
                // there is no portable OOM exception in a browser. A terminated worker is
                // the signal, and it is available on every device including the ones that
                // will not report memory at all.
                const died = /worker failed|terminated|out of memory|allocation/i.test(String(err?.message ?? ''));
                if (died && attempts === 1 && shrink('a worker ran out of room')) {
                  queue.unshift({ start: attempt }); // retry first, at the lower limit
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
