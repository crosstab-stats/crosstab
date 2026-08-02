/**
 * @file hlc.js
 * Hybrid Logical Clock — the timestamp every operation in the unified log carries
 * (see docs/ARCHITECTURE-unified-log.md §5). One value that is BOTH "when" and
 * "order", so we never grow a second timestamp field that can disagree with the first.
 *
 * ## Why not the simpler options
 *
 *  - A **Lamport** clock guarantees causal order but is *timeless* — a counter of
 *    5000 says nothing about when. Useless for an audit trail / memoing / "who did
 *    what when", which this app treats as first-class.
 *  - A **naive wall clock** gives real time but is *dangerous*: two collaborators'
 *    clocks disagree, and a backward step (NTP correction, DST bug) sorts ops wrong.
 *  - An **HLC** carries `{wall, counter}`: it stays within a bounded skew of real
 *    time, preserves causal order, and is **monotonic even when the machine clock
 *    jumps backward** (the `wall` never goes back; the `counter` absorbs the stall).
 *
 * A stamp is `{ wall, counter }` — `wall` is ms since the epoch (human time),
 * `counter` disambiguates events within the same millisecond and absorbs backward
 * clock steps. Total order is `(wall, counter)` lexicographically; that order is also
 * consistent with causality (if A happened-before B, then A < B).
 *
 * The pure functions ({@link hlcTick}/{@link hlcReceive}/{@link hlcCompare}/
 * {@link hlcEncode}) are the algorithm; {@link HLC} is a thin stateful holder for one
 * peer. The physical clock is injectable so the whole thing is deterministic in tests.
 *
 * @typedef {{ wall: number, counter: number }} HlcStamp
 */

/** The zero stamp — before any event. */
export const HLC_ZERO = Object.freeze({ wall: 0, counter: 0 });

/**
 * Advance the clock for a **local** event and return the new stamp. The `wall` never
 * regresses (a backward physical clock is absorbed by bumping `counter` instead).
 * Pure: does not mutate `prev`.
 * @param {HlcStamp} prev      the clock's current stamp
 * @param {number} physical    the physical clock reading now (ms since epoch)
 * @returns {HlcStamp}
 */
export function hlcTick(prev, physical) {
  const wall = Math.max(prev.wall, physical);
  const counter = wall === prev.wall ? prev.counter + 1 : 0;
  return { wall, counter };
}

/**
 * Advance the clock on **receiving** a remote stamp and return the new stamp — the
 * local clock jumps forward past anything it has now heard of, so the returned stamp
 * strictly follows both the previous local event and the received one (causality).
 * Pure: does not mutate `prev` or `remote`.
 * @param {HlcStamp} prev      the clock's current stamp
 * @param {HlcStamp} remote    the incoming op's stamp
 * @param {number} physical    the physical clock reading now (ms since epoch)
 * @returns {HlcStamp}
 */
export function hlcReceive(prev, remote, physical) {
  const wall = Math.max(prev.wall, remote.wall, physical);
  let counter;
  if (wall === prev.wall && wall === remote.wall) counter = Math.max(prev.counter, remote.counter) + 1;
  else if (wall === prev.wall) counter = prev.counter + 1;
  else if (wall === remote.wall) counter = remote.counter + 1;
  else counter = 0;
  return { wall, counter };
}

/**
 * Total order over stamps: negative if `a` precedes `b`, positive if it follows, 0 if
 * equal. Consistent with causality. Suitable as an `Array#sort` comparator.
 * @param {HlcStamp} a @param {HlcStamp} b @returns {number}
 */
export function hlcCompare(a, b) {
  return a.wall - b.wall || a.counter - b.counter;
}

/** Fixed-width `wall` (ms) — 15 digits covers dates well past the year 5000, so the
 * encoding stays lexicographically sortable for the life of any project. */
const WALL_WIDTH = 15;
/** Fixed-width `counter` — 1e6 events in a single millisecond is unreachable here. */
const COUNTER_WIDTH = 6;

/**
 * A **lexicographically sortable** string form of a stamp — so ops can be ordered by
 * plain string compare on their encoded HLC (e.g. a sort key, a map key). Padded to
 * fixed width so string order equals {@link hlcCompare} order.
 * @param {HlcStamp} s @returns {string} e.g. "000001700000000123:000004"
 */
export function hlcEncode(s) {
  return `${String(s.wall).padStart(WALL_WIDTH, '0')}:${String(s.counter).padStart(COUNTER_WIDTH, '0')}`;
}

/**
 * Parse a stamp back from {@link hlcEncode}. Returns {@link HLC_ZERO} for a malformed
 * input rather than throwing (a corrupt stamp should sort first, not crash a load).
 * @param {string} str @returns {HlcStamp}
 */
export function hlcDecode(str) {
  const m = /^(\d+):(\d+)$/.exec(String(str ?? ''));
  if (!m) return { ...HLC_ZERO };
  return { wall: Number(m[1]), counter: Number(m[2]) };
}

/**
 * A single peer's Hybrid Logical Clock. Call {@link HLC#tick} to stamp a local op and
 * {@link HLC#receive} when an op arrives from a peer; both advance the internal state
 * and return the fresh stamp.
 */
export class HLC {
  /** @type {HlcStamp} */
  #state;
  /** @type {() => number} */
  #now;

  /**
   * @param {object} [opts]
   * @param {HlcStamp} [opts.initial]  starting stamp (default: zero)
   * @param {() => number} [opts.now]  physical clock source (default: `Date.now`);
   *   injectable so tests are deterministic.
   */
  constructor({ initial = HLC_ZERO, now = () => Date.now() } = {}) {
    this.#state = { ...initial };
    this.#now = now;
  }

  /** The current stamp without advancing. */
  get current() {
    return { ...this.#state };
  }

  /** Stamp a new **local** operation (advances the clock). @returns {HlcStamp} */
  tick() {
    this.#state = hlcTick(this.#state, this.#now());
    return { ...this.#state };
  }

  /** Fold in a **remote** op's stamp (advances the clock past it). @returns {HlcStamp} */
  receive(remote) {
    this.#state = hlcReceive(this.#state, remote, this.#now());
    return { ...this.#state };
  }
}
