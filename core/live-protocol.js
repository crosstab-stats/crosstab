/**
 * @file live-protocol.js
 * The live co-authoring convergence engine (#143) — what rides the Trystero data
 * channel to keep two peers' project state in step. Pure (no network): it takes a
 * `send` callback and `receive`s messages, so it's fully headlessly testable by
 * wiring two instances together in memory. The real transport ({@link LiveSession})
 * just pipes its op-log channel into `receive` and its `send` out.
 *
 * ## Convergence — the same three-way merge, run continuously
 *
 * Live-sync is folder-sync's merge on a faster clock. The one extra requirement is
 * **commutativity**: both peers must reach a *byte-identical* result, or they ping
 * state back and forth forever. The kernel's merge is deterministic in its operand
 * *positions* (mine vs theirs) but not symmetric across them (ordering favours the
 * "mine" slot). The fix here needs no kernel change: **canonicalise operand order by
 * peer id** — the lower id always fills the "mine" slot — so both peers feed the same
 * two manifests into the same positions and compute the identical merge. A fixpoint
 * follows: once both hold the merged manifest, re-merging `(base, merged, merged)`
 * returns it unchanged, so the exchange stops.
 *
 * ## Late join
 *
 * A joiner announces `hello`; peers reply with their current `state`; the joiner's
 * empty side merges (add-wins datasets/blobs) up to the full project. Snapshot and
 * tail are the same `state` message — no separate path.
 *
 * ## Boundaries (still to build)
 *
 *  - **Base-data gap-fill.** If a peer's merged manifest references Parquet it lacks
 *    (the other peer created a new dataset), it must request those bytes over the
 *    channel (content-hash index → "send this file"). Editing *shared* data (recodes,
 *    coding) needs no transfer; adding datasets does. Left as a follow-up.
 *  - **N>2 peers** converge by pairwise gossip rounds as messages flow; a formal
 *    proof / base-advancement for large rooms is deferred (the core case is two).
 */

import { mergeManifests } from './collab-sync.js';
import { manifestsEqual } from './folder-sync.js';

/**
 * A live, convergent view of one project shared over a channel.
 *
 * @param {object} opts
 * @param {string} opts.selfId    this peer's stable id (Trystero selfId)
 * @param {object} opts.manifest  this peer's current project manifest
 * @param {object|null} [opts.base]  common ancestor for the three-way merge (session
 *   start snapshot; null for a fresh joiner)
 * @param {Record<string,object>} [opts.mergers]  from `buildMergers`
 * @param {(msg: object) => void} opts.send  broadcast a protocol message to peers
 * @param {(manifest: object) => void} [opts.onChange]  merged state to apply locally
 * @param {(conflicts: object[]) => void} [opts.onConflicts]  genuine collisions to
 *   surface; the app resolves and calls {@link LiveDoc#resolve}
 */
export class LiveDoc {
  #selfId;
  #mergers;
  #base;
  #mine;
  #peers = new Map(); // peerId → their latest manifest
  #send;
  #onChange;
  #onConflicts;
  #resolutions = null;

  constructor({ selfId, manifest, base = null, mergers = {}, send, onChange, onConflicts }) {
    this.#selfId = selfId;
    this.#mine = manifest;
    this.#base = base;
    this.#mergers = mergers;
    this.#send = send;
    this.#onChange = onChange;
    this.#onConflicts = onConflicts;
  }

  /** The current (converged) manifest. */
  get manifest() {
    return this.#mine;
  }

  /** Announce presence + publish current state (call once on join). */
  hello() {
    this.#send({ t: 'hello', peerId: this.#selfId });
    this.#publish();
  }

  /** A local edit changed the project — publish it and re-converge. */
  localUpdate(manifest) {
    this.#mine = manifest;
    this.#publish();
  }

  /** Feed an incoming protocol message (from peer `from`, e.g. Trystero peerId). */
  receive(msg, from) {
    if (!msg) return;
    if (msg.t === 'hello') {
      this.#publish(); // greet the newcomer with our state
      return;
    }
    if (msg.t === 'state' && msg.manifest) {
      this.#peers.set(from ?? msg.peerId, msg.manifest);
      this.#converge();
      return;
    }
    // Conflict resolutions are SHARED: a peer resolving `income` in its favour must
    // tell the others, or they'd keep re-surfacing the same collision (their side
    // still holds the rejected edit). Keys are canonical, so they match on every peer.
    if (msg.t === 'resolve' && msg.resolutions) {
      this.#resolutions = { ...this.#resolutions, ...msg.resolutions };
      this.#converge();
    }
  }

  /** Apply user conflict choices (from the conflict UI), broadcast them so peers
   * apply the same, and re-converge. */
  resolve(resolutions) {
    this.#resolutions = { ...this.#resolutions, ...resolutions };
    this.#send({ t: 'resolve', resolutions: this.#resolutions });
    this.#converge();
  }

  /** Forget a departed peer (from `onPeerLeave`). */
  peerLeft(peerId) {
    this.#peers.delete(peerId);
  }

  #publish() {
    this.#send({ t: 'state', peerId: this.#selfId, manifest: this.#mine });
  }

  #converge() {
    for (const [pid, theirs] of this.#peers) {
      // Canonical operand order: the lower peer id fills the "mine" slot, so both
      // peers compute the identical merge and converge to byte-identical state.
      const iAmLower = this.#selfId < pid;
      const lower = iAmLower ? this.#mine : theirs;
      const higher = iAmLower ? theirs : this.#mine;
      const { manifest: merged, conflicts } = mergeManifests(this.#base, lower, higher, this.#mergers, this.#resolutions);

      if (conflicts.length && this.#onConflicts) {
        this.#onConflicts(conflicts); // hold until resolve() supplies choices
        continue;
      }
      if (!manifestsEqual(merged, this.#mine)) {
        this.#mine = merged;
        this.#onChange?.(merged);
        this.#publish(); // let peers converge onto the merged result
      }
    }
  }
}
