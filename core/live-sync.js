/**
 * @file live-sync.js
 * Live P2P collaboration transport (#143) — a thin wrapper over **Trystero** (MQTT
 * strategy): serverless WebRTC rendezvous over public MQTT brokers, then a direct,
 * **ordered + reliable** data channel (exactly what an op-log wants — not the lossy
 * mode a game uses). It reuses the presence room as the live-sync handshake and the
 * invite link ({@link module:core/live-invite}) as the key.
 *
 * ## TURN — bring your own
 *
 * We run **no** infrastructure — not even TURN. But two faculty behind university
 * symmetric NATs often can't connect on STUN alone, so a **relay** is sometimes
 * required. The answer: let the user (or their institution) point at a TURN server
 * they run. {@link setTurnConfig} persists it; {@link buildIceServers} threads it
 * into the WebRTC config. Default is public STUN only (address discovery, not relay,
 * nothing we host); with no reachable relay a hard-NAT pair simply fails to connect,
 * and the UI must say so (detected ≠ connectable).
 *
 * ## Verification boundary
 *
 * `buildIceServers` + the config plumbing are pure and tested. The actual peer
 * connection needs a reachable broker + two real peers on two networks, so it can't
 * be exercised headlessly or in one automated tab — that's a real multi-machine test
 * (like the OS folder picker). This module is structured + import-smoke-tested; live
 * behavior is user-gated.
 */

import { getAssets } from './assets.js';
import { LiveDoc } from './live-protocol.js';
import { PresenceRoom } from './presence.js';

/** Public STUN for address discovery (not a relay; nothing we host). The user can
 * override or extend via {@link setTurnConfig}. */
export const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const TURN_KEY = 'crosstab.turn';

/**
 * Assemble the WebRTC `iceServers` list: default STUN plus any user/institution TURN
 * servers. A TURN entry is `{ urls, username?, credential? }` (or an array of them).
 * Pure — no I/O.
 * @param {null | object | object[]} turn
 * @returns {RTCIceServer[]}
 */
export function buildIceServers(turn) {
  const servers = [...DEFAULT_ICE];
  const list = Array.isArray(turn) ? turn : turn ? [turn] : [];
  for (const t of list) {
    if (!t || !t.urls) continue;
    const s = { urls: t.urls };
    if (t.username) s.username = t.username;
    if (t.credential) s.credential = t.credential;
    servers.push(s);
  }
  return servers;
}

/** Read the persisted TURN config (an institution's relay), or null. */
export function getTurnConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(TURN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with null) the user/institution TURN config. */
export function setTurnConfig(cfg) {
  try {
    if (cfg) globalThis.localStorage?.setItem(TURN_KEY, JSON.stringify(cfg));
    else globalThis.localStorage?.removeItem(TURN_KEY);
  } catch { /* storage unavailable — non-fatal */ }
}

let _trystero = null;
/** Lazily import the pinned Trystero (MQTT) build — only when live collab starts. */
async function loadTrystero() {
  if (!_trystero) _trystero = await import(/* @vite-ignore */ getAssets().trysteroUrl);
  return _trystero;
}

/**
 * One live collaboration session over a Trystero room. Wraps rendezvous, presence,
 * and two typed channels: a **presence beacon** (`{ who, mode, since }`) and the
 * **op-log** channel (ordered/reliable). The op-log wire protocol (snapshot-then-tail
 * late-join, gap detection) layers on top via {@link LiveSession#onOps} / send* —
 * convergence itself is the mergeable op-log (#143), not this transport.
 */
export class LiveSession {
  #room = null;
  #sendOps = null;
  #sendBeacon = null;
  #handlers = { peerJoin: [], peerLeave: [], ops: [], beacon: [] };
  #opts;

  /**
   * @param {object} opts
   * @param {string} opts.roomId   from the invite / {@link deriveRoomId}
   * @param {string} opts.secret   invite secret → Trystero `password` (encrypts signaling)
   * @param {string} [opts.appId]  Trystero app namespace
   * @param {null|object|object[]} [opts.turn]  TURN config; defaults to the persisted one
   * @param {object} [opts.self]   this peer's beacon identity `{ who, mode }`
   */
  constructor(opts) {
    this.#opts = opts;
  }

  /** Join the room: rendezvous + wire up presence and channels. Idempotent. */
  async join() {
    if (this.#room) return;
    const { joinRoom } = await loadTrystero();
    const turn = this.#opts.turn !== undefined ? this.#opts.turn : getTurnConfig();
    this.#room = joinRoom(
      { appId: this.#opts.appId || 'crosstab-collab', password: this.#opts.secret, rtcConfig: { iceServers: buildIceServers(turn) } },
      this.#opts.roomId,
    );

    const [sendOps, getOps] = this.#room.makeAction('ops');
    const [sendBeacon, getBeacon] = this.#room.makeAction('beacon');
    this.#sendOps = sendOps;
    this.#sendBeacon = sendBeacon;
    getOps((data, peerId) => this.#emit('ops', data, peerId));
    getBeacon((data, peerId) => this.#emit('beacon', data, peerId));

    this.#room.onPeerJoin((peerId) => {
      this.#emit('peerJoin', peerId);
      // Greet a newcomer with who we are (presence).
      if (this.#opts.self) this.#sendBeacon({ ...this.#opts.self, since: this.#opts.self.since }, peerId);
    });
    this.#room.onPeerLeave((peerId) => this.#emit('peerLeave', peerId));
  }

  onPeerJoin(cb) { this.#handlers.peerJoin.push(cb); return this; }
  onPeerLeave(cb) { this.#handlers.peerLeave.push(cb); return this; }
  /** Op-log messages from a peer: `(data, peerId) => …`. */
  onOps(cb) { this.#handlers.ops.push(cb); return this; }
  /** Presence beacons from a peer: `({who,mode,since}, peerId) => …`. */
  onBeacon(cb) { this.#handlers.beacon.push(cb); return this; }

  /** Send op-log data to all peers (or one, if `peerId` given). */
  sendOps(data, peerId) { this.#sendOps?.(data, peerId); }
  /** Broadcast this peer's presence beacon. */
  announce(beacon) { this.#sendBeacon?.(beacon); }

  /** Peer ids currently connected. */
  get peers() { return this.#room ? Object.keys(this.#room.getPeers()) : []; }

  /** Leave + tear down. */
  leave() {
    try { this.#room?.leave(); } finally { this.#room = null; this.#sendOps = null; this.#sendBeacon = null; }
  }

  #emit(kind, ...args) {
    for (const cb of this.#handlers[kind]) { try { cb(...args); } catch (e) { console.error('[live-sync] handler error', e); } }
  }
}

/**
 * Wire a {@link module:core/live-protocol~LiveDoc} onto a {@link LiveSession}: the
 * session's op-log channel becomes the doc's transport (send out, receive in) and a
 * peer leaving is forwarded. Returns the LiveDoc; call `doc.hello()` after
 * `session.join()`. Kept out of LiveDoc so the protocol stays transport-agnostic and
 * headlessly testable; this is the one place they meet.
 *
 * @param {LiveSession} session
 * @param {object} docOpts  everything {@link LiveDoc} takes except `send`
 * @returns {LiveDoc}
 */
export function attachLiveDoc(session, docOpts) {
  const doc = new LiveDoc({ ...docOpts, send: (m) => session.sendOps(m) });
  session.onOps((m, peerId) => doc.receive(m, peerId));
  session.onPeerLeave((peerId) => doc.peerLeft(peerId));
  return doc;
}

/**
 * Wire a {@link module:core/presence~PresenceRoom} onto a {@link LiveSession}: room
 * join/leave and beacon messages feed the roster, and this peer announces itself so
 * others see it. Returns the PresenceRoom (read `.others` / `.hasOthers`, or use
 * `onChange`). Call after `session.join()`.
 *
 * @param {LiveSession} session
 * @param {{ self?: object, onChange?: (roster: object[]) => void }} opts
 * @returns {PresenceRoom}
 */
export function attachPresence(session, { self = {}, onChange } = {}) {
  const room = new PresenceRoom({ self, onChange });
  session.onPeerJoin((peerId) => room.peerJoined(peerId));
  session.onPeerLeave((peerId) => room.peerLeft(peerId));
  session.onBeacon((info, peerId) => room.beacon(peerId, info));
  session.announce(room.selfBeacon); // let everyone already here learn who we are
  return room;
}
