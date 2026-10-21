/**
 * @file storage-pressure.test.mjs
 * The guard that makes "keep everything by default" safe.
 *
 * Saving used to reclaim space as a side effect, and that is where every bug in this
 * area came from — including one that deleted a peer's half-synced data. A save now
 * frees nothing, which deepens undo and makes a half-synced peer safe, and the cost of
 * that trade is that nothing shrinks on its own. OPFS does not degrade when it runs out:
 * `write` throws, and the write that throws is the one saving your work.
 *
 * So this decides when to say something and what to say. It is pure on purpose — quota
 * arithmetic is exactly the sort of thing that is wrong by a factor of 1024 and never
 * noticed, and the WORDING is the feature, because this is the one moment the user is
 * asked to trade something away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pressureLevel, pressureOffer, humanBytes, isQuotaError, PRESSURE_FRACTION,
} from '../core/storage-pressure.js';

const est = (usage, quota) => ({
  usage, quota, freeBytes: Math.max(0, quota - usage), usedFraction: usage / quota,
});
const GB = 1024 ** 3;

// =============================================================================
// When to speak
// =============================================================================

test('plenty of room says nothing', () => {
  assert.equal(pressureLevel(est(1 * GB, 10 * GB)).level, 'none');
});

test('nearly full warns', () => {
  assert.equal(pressureLevel(est(9 * GB, 10 * GB)).level, 'warn');
  assert.equal(pressureLevel(est(PRESSURE_FRACTION * 10 * GB, 10 * GB)).level, 'warn',
    'the threshold itself counts as pressure');
});

test('a save that has ALREADY failed outranks any reading', () => {
  // The estimate is approximate by design — browsers round it to resist fingerprinting
  // — so a real failure is the only reliable signal there is and must not be
  // second-guessed by a number that says there was room.
  const roomy = est(1 * GB, 10 * GB);
  assert.equal(pressureLevel(roomy, { failed: true }).level, 'critical');
  assert.equal(pressureLevel(null, { failed: true }).level, 'critical');
});

test('no estimate means no information, and no interruption', () => {
  // "The browser does not report usage" is not "plenty of room" — but it is also no
  // basis for interrupting someone. Stay quiet and let a real failure speak.
  const p = pressureLevel(null);
  assert.equal(p.level, 'none');
  assert.match(p.reason, /does not report/);
});

test('a write bigger than the space left is critical even below the threshold', () => {
  assert.equal(pressureLevel(est(1 * GB, 10 * GB), { needBytes: 20 * GB }).level, 'critical');
  assert.equal(pressureLevel(est(1 * GB, 10 * GB), { needBytes: 1 * GB }).level, 'none');
});

test('a nonsense estimate is treated as no estimate', () => {
  for (const bad of [{ usage: 1, quota: 0 }, { usage: 1 }, {}]) {
    const e = bad.quota ? est(bad.usage, bad.quota) : null;
    assert.equal(pressureLevel(e).level, 'none', JSON.stringify(bad));
  }
});

// =============================================================================
// Telling a quota failure from any other failure
// =============================================================================

test('a quota error is recognised across its several spellings', () => {
  assert.ok(isQuotaError({ name: 'QuotaExceededError' }));
  assert.ok(isQuotaError({ name: 'NS_ERROR_FILE_NO_DEVICE_SPACE' }), 'Firefox');
  assert.ok(isQuotaError({ code: 22 }), 'legacy DOMException');
  assert.ok(isQuotaError({ code: 1014 }), 'legacy Firefox');
});

test('any other failure is NOT a reason to offer to delete things', () => {
  // The permissive direction is the dangerous one: it would offer to free space because
  // a file was locked or an extension blocked a write.
  for (const no of [null, undefined, {}, new Error('boom'), { name: 'NotAllowedError' }, { code: 5 }]) {
    assert.equal(isQuotaError(no), false, JSON.stringify(no?.name ?? no?.code ?? String(no)));
  }
});

// =============================================================================
// What it says
// =============================================================================

const plan = (n, bytes) => ({ files: Array.from({ length: n }, (_, i) => `src_${i}.parquet`), bytes });

test('the offer names what compaction would free', () => {
  // Asking someone to authorise an unknown quantity is how you get a reflexive yes.
  const copy = pressureOffer({ level: 'warn' }, est(9 * GB, 10 * GB), plan(3, 512 * 1024 * 1024));
  assert.match(copy.compactLabel, /512 MB/);
  assert.equal(copy.canCompact, true);
  assert.match(copy.compactBody, /3 data files/);
});

test('the offer states the COST, not just the benefit', () => {
  // The bytes being freed are what a deep undo would have revived. A user who is not
  // told is a user who finds out by losing an undo.
  const copy = pressureOffer({ level: 'warn' }, est(9 * GB, 10 * GB), plan(2, 1024));
  assert.match(copy.compactBody, /costs undo depth/i);
  assert.match(copy.compactBody, /Ctrl\+Z/);
});

test('with nothing to compact it says so, and does not offer it', () => {
  // A button that cannot help must not look like the way out.
  const copy = pressureOffer({ level: 'critical' }, est(10 * GB, 10 * GB), plan(0, 0));
  assert.equal(copy.canCompact, false);
  assert.match(copy.compactBody, /nothing here to free/);
  assert.match(copy.compactBody, /somewhere else/);
});

test('the other route is always offered, and says why it is usually the better one', () => {
  // The owner's point: the room is normally in projects you have finished with, and
  // deleting one of those costs nothing in the project you are working in.
  const copy = pressureOffer({ level: 'warn' }, est(9 * GB, 10 * GB), plan(0, 0));
  assert.match(copy.manageBody, /[Oo]ther projects/);
  assert.match(copy.manageBody, /costs nothing in this one/);
});

test('an already-failed save is titled as the failure it is', () => {
  const warn = pressureOffer({ level: 'warn' }, est(9 * GB, 10 * GB), plan(1, 10));
  const crit = pressureOffer({ level: 'critical' }, est(10 * GB, 10 * GB), plan(1, 10));
  assert.match(warn.title, /nearly full/i);
  assert.match(crit.title, /[Oo]ut of space/);
  assert.match(crit.status, /could not finish/);
  assert.match(warn.status, /will start to fail/);
});

test('it reports the numbers when it has them, and says so when it does not', () => {
  const known = pressureOffer({ level: 'warn' }, est(9 * GB, 10 * GB), plan(0, 0));
  assert.match(known.status, /9\.0 GB of 10 GB used/);
  const unknown = pressureOffer({ level: 'critical' }, null, plan(0, 0));
  assert.match(unknown.status, /does not report how much room/);
});

// =============================================================================
// Bytes as a person reads them
// =============================================================================

test('sizes read the way a person expects', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(900), '900 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(1536), '1.5 KB');
  assert.equal(humanBytes(10 * 1024), '10 KB', 'two significant figures is enough past 10');
  assert.equal(humanBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(humanBytes(NaN), '0 B');
  assert.equal(humanBytes(-5), '0 B');
});

// =============================================================================
// The wiring, read from the source
// =============================================================================

test('a save frees nothing on its own', async () => {
  // The whole premise: if saving reclaimed space again, this guard would be solving a
  // problem that no longer exists while the old bug came back.
  const src = await (await import('node:fs/promises'))
    .readFile(new URL('../core/project-store.js', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('async save({ id, name, savedAt, bundle }'),
    src.indexOf('Load a project bundle'));
  assert.doesNotMatch(save, /#sweep\(/);
  assert.doesNotMatch(save, /compactProject\(/, 'and it does not compact behind your back either');
});

test('both routes are wired, and neither acts without being chosen', async () => {
  const src = await (await import('node:fs/promises'))
    .readFile(new URL('../core/project-sync.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async #checkStoragePressure'), src.indexOf('async #checkStoragePressure') + 2200);
  assert.match(fn, /dryRun: true/, 'it costs the plan before offering it');
  assert.match(fn, /choice === 'compact'/);
  assert.match(fn, /onNeedSpace/, 'and the manage route');
  // The compaction only happens inside the chosen branch.
  assert.ok(fn.indexOf("choice === 'compact'") < fn.indexOf('compactProject(id)'),
    'nothing is freed before a choice is made');
});
