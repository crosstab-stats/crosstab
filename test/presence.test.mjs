/**
 * Headless tests for the presence roster (core/presence.js) + attachPresence glue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceRoom } from '../core/presence.js';
import { attachPresence } from '../core/live-sync.js';

test('a peer is present on join; its identity fills in when the beacon lands', () => {
  const changes = [];
  const room = new PresenceRoom({ self: { who: 'Me', mode: 'live' }, onChange: (r) => changes.push(r.length) });
  room.peerJoined('B');
  assert.equal(room.hasOthers, true);
  assert.deepEqual(room.others, [{ peerId: 'B' }]);      // known present, no identity yet
  room.beacon('B', { who: 'Jane', mode: 'live', since: 5 });
  assert.deepEqual(room.others, [{ peerId: 'B', who: 'Jane', mode: 'live', since: 5 }]);
  assert.deepEqual(changes, [1, 1]);                     // join + beacon each emitted
});

test('a beacon before join still registers the peer', () => {
  const room = new PresenceRoom({});
  room.beacon('C', { who: 'Sam' });                      // beacon can arrive first
  assert.deepEqual(room.others, [{ peerId: 'C', who: 'Sam' }]);
});

test('leaving removes a peer and clears hasOthers', () => {
  const room = new PresenceRoom({});
  room.peerJoined('B'); room.peerJoined('C');
  assert.equal(room.others.length, 2);
  room.peerLeft('B');
  assert.deepEqual(room.others.map((p) => p.peerId), ['C']);
  room.peerLeft('C');
  assert.equal(room.hasOthers, false);
});

test('duplicate joins / no-op leaves do not spam onChange', () => {
  let emits = 0;
  const room = new PresenceRoom({ onChange: () => { emits++; } });
  room.peerJoined('B');
  room.peerJoined('B');       // already present → no emit
  room.peerLeft('Z');         // not present → no emit
  assert.equal(emits, 1);
});

test('attachPresence wires join/leave/beacon and announces self', () => {
  const session = {
    announced: [], _join: null, _leave: null, _beacon: null,
    onPeerJoin(cb) { this._join = cb; },
    onPeerLeave(cb) { this._leave = cb; },
    onBeacon(cb) { this._beacon = cb; },
    announce(b) { this.announced.push(b); },
  };
  const room = attachPresence(session, { self: { who: 'Me', mode: 'live' } });
  assert.deepEqual(session.announced, [{ who: 'Me', mode: 'live' }]); // announced self on attach
  session._join('B');
  session._beacon({ who: 'Jane' }, 'B');
  assert.deepEqual(room.others, [{ peerId: 'B', who: 'Jane' }]);
  session._leave('B');
  assert.equal(room.hasOthers, false);
});
