/**
 * @file plugin-lifecycle.js
 * The pure core of the plugin lifecycle envelope (#154): the state machine, the
 * request registry, and the advisory policy. No DOM, no postMessage, no timers — so the
 * rules that decide "is this plugin broken?" are testable without a browser, which the
 * old timeout-driven handshake never was.
 *
 * See `docs/ARCHITECTURE-plugin-lifecycle.md` for the design and the measurements it was
 * built on. The single governing rule:
 *
 *   **A plugin is failed only when something SAYS it failed. Elapsed time never decides.**
 *
 * The old handshake violated this — a deadline could not tell a broken frame from a slow
 * one, so it reported busy boots as crashes and destroyed healthy workspaces.
 */

/** Forward-only progression. `live` is the terminal healthy state. */
export const ORDER = Object.freeze(['created', 'caged', 'loaded', 'activated', 'mounted', 'live']);

const RANK = new Map(ORDER.map((s, i) => [s, i]));

/**
 * One surface's lifecycle. Advances forward only; fails only when told.
 */
export class Lifecycle {
  #step = 'created';
  #failure = null;
  #disposed = false;
  #onChange;

  /** @param {{onChange?: (state: object) => void}} [opts] */
  constructor({ onChange } = {}) {
    this.#onChange = onChange ?? null;
  }

  get step() { return this.#step; }
  get failure() { return this.#failure; }
  get isFailed() { return this.#failure !== null; }
  get isLive() { return this.#step === 'live' && !this.#failure && !this.#disposed; }
  get isDisposed() { return this.#disposed; }

  /** Has the surface got at least as far as `step`? */
  reached(step) {
    const want = RANK.get(step);
    if (want === undefined) throw new Error(`Lifecycle: unknown step "${step}"`);
    return RANK.get(this.#step) >= want;
  }

  /**
   * Record forward progress. Going backwards is IGNORED rather than throwing: a late
   * duplicate message from a slow frame is normal, and must not be treated as a fault —
   * being tolerant of out-of-order chatter is the point of this rewrite.
   */
  advance(step) {
    if (this.#disposed || this.#failure) return this.#step;
    const next = RANK.get(step);
    if (next === undefined) throw new Error(`Lifecycle: unknown step "${step}"`);
    if (next > RANK.get(this.#step)) {
      this.#step = step;
      this.#emit();
    }
    return this.#step;
  }

  /**
   * Fail, explicitly. First failure wins — later ones are noise from a frame already
   * coming apart, and overwriting would lose the message that explains the cause.
   */
  fail(step, reason) {
    if (this.#disposed || this.#failure) return this.#failure;
    this.#failure = { step: step ?? this.#step, reason: String(reason ?? 'unknown') };
    this.#emit();
    return this.#failure;
  }

  /** User-initiated restart: back to the beginning, failure cleared. */
  reset() {
    if (this.#disposed) return;
    this.#step = 'created';
    this.#failure = null;
    this.#emit();
  }

  /** Terminal. A disposed lifecycle ignores everything after. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#emit();
  }

  toJSON() {
    return { step: this.#step, failure: this.#failure, disposed: this.#disposed };
  }

  #emit() {
    try { this.#onChange?.(this.toJSON()); } catch { /* a listener must not break the machine */ }
  }
}

/**
 * Outstanding host→guest calls, keyed by request id.
 *
 * Replaces a single shared `#lifecycleAck` slot, where two hooks in flight meant the
 * first was overwritten and never resolved — reachable with a dataset switch during a
 * refresh. Every call gets its own id and its own promise.
 *
 * Deliberately has NO timeout. A pending call is settled by an answer, by an explicit
 * failure, or by disposal — never by a clock.
 */
export class PendingCalls {
  #map = new Map();
  #seq = 0;

  get size() { return this.#map.size; }

  /** Reserve a request id. @returns {{rid: string, promise: Promise<any>}} */
  open(type = 'call') {
    const rid = `${type}#${++this.#seq}`;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.#map.set(rid, { resolve, reject, type });
    return { rid, promise };
  }

  /** Settle a call by id. Unknown or duplicate ids are ignored — a guest echoing twice
   * is chatter, not a fault. @returns {boolean} whether it settled anything. */
  settle(rid, { ok = true, value, error } = {}) {
    const entry = this.#map.get(rid);
    if (!entry) return false;
    this.#map.delete(rid);
    if (ok) entry.resolve(value);
    else entry.reject(error instanceof Error ? error : new Error(String(error ?? 'plugin call failed')));
    return true;
  }

  /** Reject everything outstanding — the frame died or was disposed. This is how a
   * pending call ends without a timeout. */
  rejectAll(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason ?? 'plugin surface disposed'));
    for (const [, entry] of this.#map) entry.reject(err);
    this.#map.clear();
  }
}

/**
 * What the UI should say about a surface that has not reached `live` yet.
 *
 * The ONLY consumer of elapsed time in the whole envelope, and it may only choose
 * wording. It never returns a failed verdict, because being slow is not being broken —
 * a plugin may legitimately take hours if that is what the analysis needs.
 *
 * `lastAliveMs` is the age of the most recent heartbeat. The cage document stays
 * responsive while the plugin's own code is busy, so a missing heartbeat distinguishes
 * "wedged" from "working hard" — and even then it only changes the wording.
 *
 * @param {{step: string, elapsedMs: number, lastAliveMs?: number|null,
 *          slowAfterMs?: number, quietAfterMs?: number}} arg
 * @returns {{level: 'ok'|'slow'|'quiet', message: string}}
 */
export function advisory({ step, elapsedMs, lastAliveMs = null, slowAfterMs = 30_000, quietAfterMs = 15_000 }) {
  const where = STEP_WORDING[step] ?? step;
  if (lastAliveMs != null && lastAliveMs > quietAfterMs) {
    return {
      level: 'quiet',
      message: `Still ${where} — no response for ${Math.round(lastAliveMs / 1000)}s. It may still finish.`,
    };
  }
  if (elapsedMs > slowAfterMs) {
    return { level: 'slow', message: `Still ${where} — taking longer than usual (${Math.round(elapsedMs / 1000)}s).` };
  }
  return { level: 'ok', message: `${where[0].toUpperCase()}${where.slice(1)}…` };
}

const STEP_WORDING = {
  created: 'starting',
  caged: 'loading the plugin',
  loaded: 'activating',
  activated: 'opening the workspace',
  mounted: 'finishing up',
  live: 'ready',
};
