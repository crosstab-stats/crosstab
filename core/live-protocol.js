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

import { mergeProjects } from './collab-sync.js';
import { manifestsEqual } from './folder-sync.js';
import { debug } from './debug.js';

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
  /** (owner, collection) => should a concurrent same-record edit be surfaced? (#166) */
  #surfaces = null;
  #mine;
  #peers = new Map(); // peerId → their latest manifest
  #send;
  #onChange;
  #onConflicts;
  #onPeers;
  #onResolved;
  #resolutions = null;
  #lastSwap = false; // whether the last surfaced conflicts were shown mine↔theirs-swapped
  #paused = false; // a simulated/real network partition: buffer both directions
  #active = new Set(); // peers actually co-authoring (we've heard a hello/state from them)

  constructor({ selfId, manifest, mergers = {}, surfaces = null, send, onChange, onConflicts, onPeers, onResolved }) {
    this.#selfId = selfId;
    this.#mine = manifest;
    this.#mergers = mergers;
    this.#surfaces = surfaces ?? null;
    this.#send = send;
    this.#onChange = onChange;
    this.#onConflicts = onConflicts;
    this.#onPeers = onPeers;
    this.#onResolved = onResolved;
  }

  /** The current (converged) manifest. */
  get manifest() {
    return this.#mine;
  }

  /** How many peers are actively co-authoring (we've heard from them) — 0 until a peer
   * joins the doc, so the UI can show "waiting" vs "co-authoring". */
  get activeCount() {
    return this.#active.size;
  }

  /** Pause/resume this doc as a partition: while paused it neither publishes nor applies
   * incoming (peer states are buffered). On resume it flushes its state + converges the
   * buffered peer states — so two peers editing while paused collide on resume (test the
   * conflict UI), and it also models a dropped connection reconnecting. */
  setPaused(on) {
    this.#paused = !!on;
    if (!on) { this.#publish(); this.#converge(); }
  }

  #notePeer(id) {
    if (id == null || this.#active.has(id)) return;
    this.#active.add(id);
    this.#onPeers?.(this.#active.size);
  }

  /** Announce presence + publish current state (call once on join). */
  hello() {
    debug('live', 'doc.hello', this.#selfId);
    this.#send({ t: 'hello', peerId: this.#selfId });
    this.#publish();
  }

  /** A local edit changed the project — publish it and re-converge. */
  localUpdate(manifest) {
    debug('live', 'doc.localUpdate');
    this.#mine = manifest;
    this.#publish(); // no-op while paused; flushed on resume
  }

  /** Feed an incoming protocol message (from peer `from`, e.g. Trystero peerId). */
  receive(msg, from) {
    if (!msg) return;
    if (msg.t === 'hello' || msg.t === 'state' || msg.t === 'resolve') debug('live', 'doc.receive', msg.t, 'from', from, 'knownPeers=', this.#peers.size);
    if (msg.t === 'hello') {
      this.#notePeer(from); // a peer has joined co-authoring
      this.#publish(); // greet the newcomer with our state
      return;
    }
    if (msg.t === 'state' && msg.manifest) {
      this.#notePeer(from ?? msg.peerId);
      this.#peers.set(from ?? msg.peerId, msg.manifest);
      if (!this.#paused) this.#converge(); // paused: buffer; resume converges it
      return;
    }
    // Conflict resolutions are SHARED: a peer resolving `income` in its favour must
    // tell the others, or they'd keep re-surfacing the same collision (their side
    // still holds the rejected edit). Keys are canonical, so they match on every peer.
    if (msg.t === 'resolve' && msg.resolutions) {
      this.#resolutions = { ...this.#resolutions, ...msg.resolutions };
      this.#onResolved?.(); // a peer resolved — close any stale conflict dialog we have open
      this.#converge();
    }
  }

  /** Apply user conflict choices (from the conflict UI) and broadcast them so peers
   * apply the same, then re-converge. The UI shows choices from the LOCAL user's
   * perspective; the stored/broadcast resolutions are CANONICAL (mine = lower peer),
   * so when we're the higher peer we translate mine↔theirs first (see #converge). */
  resolve(resolutions) {
    const canonical = this.#lastSwap ? swapChoices(resolutions) : resolutions;
    this.#resolutions = { ...this.#resolutions, ...canonical };
    this.#send({ t: 'resolve', resolutions: this.#resolutions });
    this.#converge();
  }

  /** Forget a departed peer (from `onPeerLeave`). */
  peerLeft(peerId) {
    this.#peers.delete(peerId);
    if (this.#active.delete(peerId)) this.#onPeers?.(this.#active.size);
  }

  #publish() {
    if (this.#paused) return; // partition: hold outgoing until resume
    this.#send({ t: 'state', peerId: this.#selfId, manifest: this.#mine });
  }

  #converge() {
    if (this.#paused) return; // partition: don't apply incoming until resume
    for (const [pid, theirs] of this.#peers) {
      // Canonical operand order: the lower peer id fills the "mine" slot, so both
      // peers compute the identical merge and converge to byte-identical state.
      const iAmLower = this.#selfId < pid;
      const lower = iAmLower ? this.#mine : theirs;
      const higher = iAmLower ? theirs : this.#mine;
      const { manifest: merged, conflicts } = mergeProjects(lower, higher, this.#mergers, this.#resolutions, { surfaces: this.#surfaces });
      const changed = !manifestsEqual(merged, this.#mine);
      debug('live', 'converge', { peer: pid, iAmLower, conflicts: conflicts.length, changed });

      if (conflicts.length && this.#onConflicts) {
        // Present from the LOCAL user's perspective: our own value is "mine". The merge
        // labels mine = the lower peer, so when we're the higher peer, swap for display
        // (and resolve() swaps the choice back to canonical before broadcasting).
        this.#lastSwap = !iAmLower;
        this.#onConflicts(iAmLower ? conflicts : conflicts.map(swapConflict));
        continue; // hold until resolve() supplies choices
      }
      // No base: mergeProjects derives the common ancestor from the shared op-id set,
      // so the canonical-order merge converges to byte-identical state and reaches a
      // fixpoint (re-merging merged↔merged returns it unchanged — every op is shared).
      if (changed) {
        this.#mine = merged;
        this.#onChange?.(merged);
        this.#publish(); // let peers converge onto the merged result
      }
    }
  }
}

/** Swap a conflict's two sides (for showing "mine" = the LOCAL user when we're the
 * higher peer, since the merge labels "mine" = the lower peer). */
function swapConflict(c) {
  return { ...c, mine: c.theirs, theirs: c.mine };
}

/** Swap resolution choices mine↔theirs (translate a LOCAL-perspective choice back to
 * the canonical mine = lower-peer form for storage/broadcast). */
function swapChoices(resolutions) {
  const out = {};
  for (const [k, v] of Object.entries(resolutions || {})) {
    out[k] = v === 'mine' ? 'theirs' : v === 'theirs' ? 'mine' : v;
  }
  return out;
}
