/**
 * @file store-lock.test.mjs
 * Two stores over one root must share a write queue (found 2026-10-02).
 *
 * The catalog (`projects/catalog.json`) is rewritten by temp-then-rename. Two ProjectStore
 * instances exist in the app at once — the open project autosaves through its own, and the
 * project list reads through a second — and `#acquire` serialised each instance against
 * *itself* only. Copying a dataset to a new project while an autosave was in flight produced
 * **"A FileSystemHandle cannot be moved while it is locked"** and the copy was lost.
 *
 * Tested through the capability rather than the symptom: the queue follows whatever the
 * driver says it SHARES, which is the declared-not-inferred rule this driver layer exists to
 * keep (`kind` is a label; behaviour comes from capabilities).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesOf, DEFAULT_CAPABILITIES, OpfsDriver } from '../core/storage-driver.js';

test('OPFS declares sharedRoot — every store in the tab opens the same bytes', () => {
  // Not an inference from kind === 'opfs': the driver says so, which is what lets a
  // third-party driver opt in (or out) without lying about its name.
  assert.equal(capabilitiesOf(new OpfsDriver()).sharedRoot, true);
});

test('a driver that declares nothing is assumed NOT shared', () => {
  // The conservative answer is per-instance locking, which is what every handle- and
  // account-scoped driver wants: those are per-location, so a shared queue would serialise
  // two unrelated folders against each other for no reason.
  assert.equal(DEFAULT_CAPABILITIES.sharedRoot, false);
  assert.equal(capabilitiesOf(null).sharedRoot, false);
  assert.equal(capabilitiesOf({ capabilities: { flat: true } }).sharedRoot, false);
});

test('a driver can declare sharing without being OPFS', () => {
  assert.equal(capabilitiesOf({ kind: 'custom', capabilities: { sharedRoot: true } }).sharedRoot, true);
});

/**
 * The queue itself, as the store implements it: one chain per shared key, so a second
 * acquirer waits for the first to release. Modelled here because ProjectStore's `#acquire`
 * is private and needs OPFS to construct — the property under test is the ordering.
 */
test('two acquirers on one shared key run strictly in sequence', async () => {
  const tails = new Map();
  const acquire = (key) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    tails.set(key, mine);
    return prev.then(() => release);
  };
  const order = [];
  const a = acquire('shared').then(async (release) => {
    order.push('a:start');
    await new Promise((r) => setTimeout(r, 15));
    order.push('a:end');
    release();
  });
  const b = acquire('shared').then((release) => {
    order.push('b:start');
    order.push('b:end');
    release();
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'],
    'b must not start until a has released — interleaving is the bug');
});

test('different keys do NOT wait for each other', async () => {
  // Two separate folders are two separate roots; making them queue would turn an unrelated
  // save into a delay, and this is the reason the key is the storage and not a global.
  const tails = new Map();
  const acquire = (key) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    tails.set(key, mine);
    return prev.then(() => release);
  };
  const order = [];
  const slow = acquire('one').then(async (release) => {
    await new Promise((r) => setTimeout(r, 20));
    order.push('one');
    release();
  });
  const fast = acquire('two').then((release) => { order.push('two'); release(); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['two', 'one']);
});
