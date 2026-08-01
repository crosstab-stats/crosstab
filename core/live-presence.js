/**
 * @file live-presence.js
 * The app-side coordinator for live **presence** (#148 step 5) — the first live-P2P
 * feature to go active. Given a project's signaling room (from `projects.activeRoom()`)
 * and this user's identity beacon, it joins the room over {@link LiveSession}, wires a
 * {@link PresenceRoom}, and reports the peer roster so the header can show who else is
 * editing.
 *
 * Presence is **explicit opt-in** (start/stop) — joining a public broker is a
 * deliberate act, not something that happens silently on folder-open. It carries only
 * the self-set identity beacon (initials/name/colour/authorId), never project data;
 * the room id is the unguessable SHA-256 topic and the secret encrypts the signaling
 * (see {@link module:core/live-invite}). Data co-authoring is a later layer on the
 * same session — this is just awareness.
 */

import { LiveSession, attachPresence } from './live-sync.js';

export class LivePresence {
  #session = null;
  #onRoster;

  /** @param {{ onRoster?: (roster: object[]) => void }} [opts] */
  constructor({ onRoster } = {}) {
    this.#onRoster = onRoster;
  }

  /** Whether a presence session is currently joined. */
  get live() {
    return !!this.#session;
  }

  /**
   * Join a room and start broadcasting this user's presence. Idempotent-ish: any
   * existing session is left first (so switching projects can't leave two rooms joined).
   * @param {{ roomId: string, secret: string, self: object }} arg  `self` = the identity beacon
   */
  async start({ roomId, secret, self }) {
    await this.stop();
    const session = new LiveSession({ roomId, secret, self });
    await session.join();
    // attachPresence announces us + folds join/leave/beacon into the roster.
    attachPresence(session, { self, onChange: (roster) => this.#onRoster?.(roster) });
    this.#session = session;
    this.#onRoster?.([]); // fresh room: no peers yet until they announce
  }

  /** Leave the room and clear the roster. Safe to call when not live. */
  async stop() {
    if (!this.#session) return;
    try { this.#session.leave(); } finally { this.#session = null; this.#onRoster?.([]); }
  }
}
