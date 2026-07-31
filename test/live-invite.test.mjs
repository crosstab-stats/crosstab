/**
 * Headless tests for the pure live-collaboration pieces (#143): rendezvous
 * addressing + invitation (live-invite.js) and TURN/ICE config (live-sync.js).
 * The Trystero rendezvous/WebRTC itself is network + multi-peer, so it's user-gated
 * (like the OS folder picker) — not covered here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoomId, newInviteSecret, createInviteLink, parseInviteLink } from '../core/live-invite.js';
import { buildIceServers, DEFAULT_ICE } from '../core/live-sync.js';

test('deriveRoomId is deterministic, opaque, and namespaced', async () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  const a = await deriveRoomId(uuid);
  const b = await deriveRoomId(uuid);
  assert.equal(a, b);                       // stable for a project (owner recomputes it)
  assert.match(a, /^[0-9a-f]{32}$/);        // 128-bit hex topic
  assert.notEqual(a, uuid);                 // never the raw id
  assert.notEqual(a, await deriveRoomId('11111111-2222-3333-4444-555555555556')); // per-project
});

test('invite secrets are high-entropy and unique', () => {
  const s1 = newInviteSecret();
  const s2 = newInviteSecret();
  assert.notEqual(s1, s2);
  assert.ok(s1.length >= 42);               // 256-bit base64url
  assert.match(s1, /^[A-Za-z0-9_-]+$/);     // URL-fragment safe (no +/=)
});

test('invite link round-trips through the URL fragment', async () => {
  const secret = newInviteSecret();
  const link = await createInviteLink({ baseUrl: 'https://crosstab-stats.github.io/crosstab/', projectUuid: 'abc-123', secret });
  assert.ok(link.includes('#collab='));
  assert.ok(!link.split('#')[0].includes('collab')); // secret is in the fragment, not the path/query
  const parsed = parseInviteLink(link);
  assert.equal(parsed.secret, secret);
  assert.equal(parsed.roomId, await deriveRoomId('abc-123'));
});

test('parseInviteLink rejects non-invite URLs', () => {
  assert.equal(parseInviteLink('https://example.com/'), null);
  assert.equal(parseInviteLink('https://example.com/#other=1'), null);
});

test('buildIceServers: default STUN only when no TURN', () => {
  assert.deepEqual(buildIceServers(null), DEFAULT_ICE);
  assert.deepEqual(buildIceServers(undefined), DEFAULT_ICE);
});

test('buildIceServers: appends an institution TURN server with credentials', () => {
  const servers = buildIceServers({ urls: 'turn:turn.university.edu:3478', username: 'faculty', credential: 'sekret' });
  assert.equal(servers.length, 2);
  assert.equal(servers[0].urls, DEFAULT_ICE[0].urls); // STUN still first
  assert.deepEqual(servers[1], { urls: 'turn:turn.university.edu:3478', username: 'faculty', credential: 'sekret' });
});

test('buildIceServers: accepts multiple TURN servers and skips malformed entries', () => {
  const servers = buildIceServers([
    { urls: 'turn:a.edu:3478', username: 'u', credential: 'c' },
    { nope: true },                          // no urls → skipped
    { urls: 'turns:b.edu:5349' },            // TLS TURN, no creds
  ]);
  assert.deepEqual(servers.map((s) => s.urls), [DEFAULT_ICE[0].urls, 'turn:a.edu:3478', 'turns:b.edu:5349']);
});
