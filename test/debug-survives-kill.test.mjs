/**
 * @file debug-survives-kill.test.mjs
 * The log that outlives the page that wrote it.
 *
 * ## What happened
 *
 * Importing a CSV on an iPhone relaunched the PWA — iOS killed the web view for memory.
 * That is not a JS error: no handler runs, `lastError` stays null, and the ring buffer
 * dies with the process. The log exported from the next launch was empty. Every
 * diagnostic built this session assumes the page survives long enough to export it, and
 * the one crash that most needed evidence is precisely the one that destroys it.
 *
 * So the tail is mirrored to localStorage as it is written, and the next launch carries
 * it in the export as `previousSession`.
 *
 * ## Why this reads oddly
 *
 * `debug.js` registers a setting at module scope, so importing it twice throws on the
 * duplicate id — a reload cannot be simulated by re-importing. Instead localStorage is
 * SEEDED before the single import, which is exactly the state a fresh page load finds,
 * and the write path is exercised afterwards against the same module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'test' }, configurable: true,
});
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
globalThis.fetch = async () => ({ headers: { get: () => null } });

const KEY = 'crosstab_debug_tail';
const store = new Map();
let failWrites = false;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('quota exceeded');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  },
  configurable: true,
});

// The evidence a killed session left behind — seeded BEFORE the import, because that is
// when a real page load reads it.
store.set(KEY, JSON.stringify({
  at: '2026-11-18T23:20:00.000Z',
  tail: [
    { time: '2026-11-18T23:19:58.000Z', tag: 'codec', message: ['begin', { columns: 3379 }] },
    { time: '2026-11-18T23:19:59.000Z', tag: 'import', message: ['route', { wide: false }] },
  ],
}));

const d = await import('../core/debug.js');

let written = null;
globalThis.Blob = class { constructor(parts) { written = parts.join(''); } };
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
Object.defineProperty(globalThis, 'document', {
  value: { createElement: () => ({ click() {} }) }, configurable: true,
});

// =============================================================================
// Reading what the dead session left
// =============================================================================

test('the previous page load is picked up at start-up', () => {
  const prev = d.previousSession();
  assert.ok(prev, 'found');
  assert.equal(prev.tail.length, 2);
  assert.deepEqual(prev.tail.map((e) => e.tag), ['codec', 'import']);
});

test('a saved log carries it even when THIS session logged nothing', async () => {
  // Exactly the iPhone case: the app relaunches, you export straight away, and this
  // session's buffer is empty. Without `previousSession` the file says nothing at all.
  await d.saveLog();
  const payload = JSON.parse(written);
  assert.deepEqual(payload.entries, [], 'this session really did log nothing');
  assert.ok(payload.previousSession, 'and the export still has evidence');
  assert.deepEqual(payload.previousSession.tail.map((e) => e.tag), ['codec', 'import']);
});

// =============================================================================
// Writing, so the NEXT load has something
// =============================================================================

test('the tail is mirrored without anyone asking', () => {
  d.setDebug(true);
  d.debug('import', 'route', { wide: true });
  d.debug('codec', 'begin', { columns: 3379 });
  d.flushDebugTail(); // the mirror is throttled; this is what `pagehide` calls
  const saved = JSON.parse(store.get(KEY));
  assert.ok(saved.at, 'stamped');
  const tags = saved.tail.map((e) => e.tag);
  assert.ok(tags.includes('import') && tags.includes('codec'), `got ${JSON.stringify(tags)}`);
});

test('the tail is bounded, so it cannot grow into the quota', () => {
  for (let i = 0; i < 400; i++) d.debug('spam', `line ${i}`);
  d.flushDebugTail();
  const saved = JSON.parse(store.get(KEY));
  assert.ok(saved.tail.length <= 80, `kept ${saved.tail.length}`);
  // And it is the TAIL — the last moments before a kill, not the first.
  assert.match(JSON.stringify(saved.tail[saved.tail.length - 1]), /line 399/);
});

test('a failed write cannot break the app it is diagnosing', () => {
  failWrites = true;
  try {
    assert.doesNotThrow(() => d.debug('x', 'y'), 'a full quota must not reach the caller');
    assert.doesNotThrow(() => d.flushDebugTail());
  } finally {
    failWrites = false;
  }
});

test('logging off writes nothing at all', () => {
  store.delete(KEY);
  d.setDebug(false);
  d.debug('import', 'should not appear');
  assert.equal(store.get(KEY), undefined, 'the gate still governs everything');
});
