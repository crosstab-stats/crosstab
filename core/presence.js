/**
 * @file presence.js
 * The "who else is here?" roster for live collaboration (#143) — the awareness layer
 * that powers the *"Jane also has this open — start co-authoring?"* prompt.
 *
 * Pure state, no transport: it folds room join/leave events and presence beacons
 * (`{ who, mode, since }`) into a roster, so it's fully headlessly testable. The
 * transport ({@link LiveSession}) feeds it via {@link module:core/live-sync~attachPresence}.
 *
 * Presence is deliberately **separable from storage** (a design note in #143): "who
 * has project X open" rides the network keyed on project id, so it's answered once
 * and every storage mode (live, folder, cloud) can borrow it. A peer is known from
 * the moment it joins the room (even before its beacon arrives); its `who`/`mode`
 * fill in when the beacon lands.
 */

export class PresenceRoom {
  /** @type {{ who?: string, mode?: string, since?: number }} */
  #self;
  #peers = new Map(); // peerId → { peerId, who?, mode?, since? }
  #onChange;

  /**
   * @param {object} opts
   * @param {{ who?: string, mode?: string, since?: number }} [opts.self]  this peer's identity
   * @param {(roster: object[]) => void} [opts.onChange]  fired whenever the roster changes
   */
  constructor({ self = {}, onChange } = {}) {
    this.#self = self;
    this.#onChange = onChange;
  }

  /** A peer connected (from `onPeerJoin`) — present, beacon may not have arrived yet. */
  peerJoined(peerId) {
    if (!this.#peers.has(peerId)) {
      this.#peers.set(peerId, { peerId });
      this.#emit();
    }
  }

  /** A peer's presence beacon arrived — merge its identity in. */
  beacon(peerId, info) {
    this.#peers.set(peerId, { peerId, ...(this.#peers.get(peerId) || {}), ...(info || {}) });
    this.#emit();
  }

  /** A peer disconnected (from `onPeerLeave`). */
  peerLeft(peerId) {
    if (this.#peers.delete(peerId)) this.#emit();
  }

  /** This peer's own beacon payload (to broadcast on join). */
  get selfBeacon() {
    return { ...this.#self };
  }

  /** Everyone else currently present (excludes self — self isn't a room peer). */
  get others() {
    return [...this.#peers.values()];
  }

  /** True if anyone else is here — the trigger for the co-author prompt. */
  get hasOthers() {
    return this.#peers.size > 0;
  }

  #emit() {
    this.#onChange?.(this.others);
  }
}
