/**
 * Headless tests for the Hybrid Logical Clock (core/hlc.js). A controllable physical
 * clock makes every case deterministic, including the dangerous ones (same-ms bursts,
 * backward clock steps, two peers exchanging stamps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HLC, HLC_ZERO, hlcTick, hlcReceive, hlcCompare, hlcEncode, hlcDecode } from '../core/hlc.js';

test('tick advances counter within the same millisecond, resets when wall moves', () => {
  let a = hlcTick(HLC_ZERO, 1000);
  assert.deepEqual(a, { wall: 1000, counter: 0 });
  a = hlcTick(a, 1000); assert.deepEqual(a, { wall: 1000, counter: 1 }); // same ms → counter++
  a = hlcTick(a, 1000); assert.deepEqual(a, { wall: 1000, counter: 2 });
  a = hlcTick(a, 1005); assert.deepEqual(a, { wall: 1005, counter: 0 }); // ms advanced → reset
});

test('tick is monotonic across a BACKWARD physical clock step (the wall never regresses)', () => {
  let a = hlcTick(HLC_ZERO, 2000);
  a = hlcTick(a, 1500); // clock jumped backward (NTP/DST)
  assert.equal(a.wall, 2000, 'wall holds, never goes back');
  assert.equal(a.counter, 1, 'counter absorbs the stall');
  // The new stamp still strictly follows the previous one.
  assert.ok(hlcCompare({ wall: 2000, counter: 0 }, a) < 0);
});

test('receive jumps past a remote stamp so causality holds', () => {
  // Local clock is behind; a remote op from "the future" arrives.
  const local = { wall: 1000, counter: 0 };
  const remote = { wall: 5000, counter: 3 };
  const next = hlcReceive(local, remote, 1001);
  assert.equal(next.wall, 5000);       // adopt the remote's later wall
  assert.equal(next.counter, 4);       // strictly after the remote event
  assert.ok(hlcCompare(remote, next) < 0, 'the received stamp follows the remote op');
  assert.ok(hlcCompare(local, next) < 0, 'and follows the prior local op');
});

test('receive with equal walls takes max(counter)+1', () => {
  const next = hlcReceive({ wall: 1000, counter: 2 }, { wall: 1000, counter: 5 }, 1000);
  assert.deepEqual(next, { wall: 1000, counter: 6 });
});

test('compare gives a total order consistent with causality', () => {
  const stamps = [
    { wall: 1000, counter: 5 },
    { wall: 1000, counter: 0 },
    { wall: 999, counter: 9 },
    { wall: 1001, counter: 0 },
  ];
  const sorted = [...stamps].sort(hlcCompare);
  assert.deepEqual(sorted, [
    { wall: 999, counter: 9 },
    { wall: 1000, counter: 0 },
    { wall: 1000, counter: 5 },
    { wall: 1001, counter: 0 },
  ]);
});

test('encode is fixed-width so STRING order equals stamp order', () => {
  const a = hlcEncode({ wall: 999, counter: 9 });
  const b = hlcEncode({ wall: 1000, counter: 0 });
  const c = hlcEncode({ wall: 1000, counter: 5 });
  assert.ok(a < b && b < c, 'lexicographic order matches temporal order');
  assert.equal(a.length, b.length, 'fixed width');
});

test('encode/decode round-trips; decode of garbage is the zero stamp (sorts first, no throw)', () => {
  const s = { wall: 1_700_000_000_123, counter: 42 };
  assert.deepEqual(hlcDecode(hlcEncode(s)), s);
  assert.deepEqual(hlcDecode('not-a-stamp'), HLC_ZERO);
  assert.deepEqual(hlcDecode(null), HLC_ZERO);
});

test('HLC class: tick/receive advance internal state; now() is injectable', () => {
  let clock = 1000;
  const a = new HLC({ now: () => clock });
  assert.deepEqual(a.tick(), { wall: 1000, counter: 0 });
  assert.deepEqual(a.tick(), { wall: 1000, counter: 1 });
  clock = 1002;
  assert.deepEqual(a.tick(), { wall: 1002, counter: 0 });
  assert.deepEqual(a.current, { wall: 1002, counter: 0 }, 'current does not advance');
});

test('HLC class: two peers stay causally ordered through an exchange', () => {
  let ca = 1000; let cb = 1000;
  const A = new HLC({ now: () => ca });
  const B = new HLC({ now: () => cb });
  const a1 = A.tick();            // A does something at t=1000
  cb = 900;                        // B's clock lags behind A's
  const b1 = B.receive(a1);        // B hears A's op
  assert.ok(hlcCompare(a1, b1) < 0, "B's next stamp follows A's op despite B's slow clock");
  const b2 = B.tick();
  assert.ok(hlcCompare(b1, b2) < 0);
});
