/**
 * @file rename-over.test.mjs
 * Temp-then-rename across engines that disagree about `move()` (owner's iPhone, 2026-10-07).
 *
 * The symptom was **"Save project failed: Not enough arguments"** in the installed app, and
 * the cause was a feature check that cannot see what it is checking for: the driver asked
 * `typeof handle.move === 'function'` and WebKit says yes while implementing only the
 * two-argument `move(destinationDirectory, name)` form. A one-argument rename then throws a
 * TypeError from a branch that had already concluded the API was available.
 *
 * So the rule under test is: **probe by attempt, not by existence** — short form, then the
 * spec's long form, then admit defeat so the caller can write in place. Every engine shape
 * below is one real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __renameOverForTests as renameOver } from '../core/storage-driver.js';

/** A file handle whose `move` accepts exactly `arity` arguments, like a real engine's. */
function handle({ arity, calls }) {
  return {
    move(...args) {
      calls.push(args.length);
      if (args.length < arity) {
        // WebKit's wording, and the exact string the owner saw.
        return Promise.reject(new TypeError('Not enough arguments'));
      }
      return Promise.resolve();
    },
  };
}
const DIR = { name: 'dir' };

test('Chromium: the one-argument rename is used and nothing else is tried', async () => {
  const calls = [];
  assert.equal(await renameOver(DIR, handle({ arity: 1, calls }), 'project.json'), true);
  assert.deepEqual(calls, [1]);
});

test('WEBKIT, THE REPORTED BUG: one argument throws, so the two-argument form is used', async () => {
  // Before this, the TypeError escaped as "Save project failed: Not enough arguments" and
  // the project was simply not saved.
  const calls = [];
  assert.equal(await renameOver(DIR, handle({ arity: 2, calls }), 'project.json'), true);
  assert.deepEqual(calls, [1, 2], 'tries short, then long');
});

test('an engine with no move at all is reported, not attempted', async () => {
  assert.equal(await renameOver(DIR, {}, 'x'), false);
  assert.equal(await renameOver(DIR, { move: null }, 'x'), false);
});

test('move in name only falls back rather than throwing', async () => {
  // Neither arity works: the caller writes in place instead, which is slower and
  // non-atomic but SAVES THE FILE — the outcome that matters.
  const calls = [];
  assert.equal(await renameOver(DIR, handle({ arity: 3, calls }), 'x'), false);
  assert.deepEqual(calls, [1, 2]);
});

test('a REAL failure is surfaced, not swallowed as "unsupported"', async () => {
  // The distinction the fallback depends on: a TypeError means "this engine spells it
  // differently", anything else means the write genuinely failed — a blocked extension, no
  // quota, a vanished directory. Treating those as "unsupported" would retry into a direct
  // write that fails the same way, and report the second error instead of the first.
  const notAllowed = { move: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) };
  await assert.rejects(() => renameOver(DIR, notAllowed, 'x.exe'), { name: 'NotAllowedError' });
  const quota = { move: () => Promise.reject(new DOMException('full', 'QuotaExceededError')) };
  await assert.rejects(() => renameOver(DIR, quota, 'x'), { name: 'QuotaExceededError' });
});

test('a real failure on the SECOND attempt is surfaced too', async () => {
  let n = 0;
  const flaky = {
    move: (...args) => {
      n += 1;
      return args.length === 1
        ? Promise.reject(new TypeError('Not enough arguments'))
        : Promise.reject(new DOMException('full', 'QuotaExceededError'));
    },
  };
  await assert.rejects(() => renameOver(DIR, flaky, 'x'), { name: 'QuotaExceededError' });
  assert.equal(n, 2);
});
