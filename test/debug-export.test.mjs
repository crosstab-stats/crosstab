/**
 * @file debug-export.test.mjs
 * What Edit ▸ Debugging ▸ Save debug log… actually hands a maintainer.
 *
 * ## What happened
 *
 * A report off the owner's work desktop — a 67 MB CSV dying at 3.1 GiB, reproduced with
 * debug logging ON — arrived as this, in full:
 *
 *     {"exported":"…","userAgent":"…","entries":[{"tag":"debug","message":["logging enabled"]}]}
 *
 * One entry, and no way to tell which BUILD produced it. A day went into the stale
 * service worker theory before a separately-filed Help ▸ Report a bug… showed the build
 * was current and the fault was elsewhere. `collectDiagnostics` had carried the build
 * stamp and the last error all along; this export had neither, and nobody files two
 * reports.
 *
 * So these tests are about the header, not the entries: the two fields that decide where
 * a maintainer looks first must be in the file a reporter actually sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Node 24's `navigator` is getter-only, so defineProperty is the way to stand a fake in
// front of it (same reason as help-bug-report.test.mjs).
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (TestOS) Chrome/1.0' },
  configurable: true,
});
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true });
globalThis.fetch = async () => ({ headers: { get: () => 'Tue, 17 Nov 2026 19:31:00 GMT' } });

// A localStorage the settings registry can write to.
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  configurable: true,
});

/** Capture what `saveLog` would download, instead of downloading it. */
let written = null;
globalThis.Blob = class {
  constructor(parts) { written = parts.join(''); }
};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
Object.defineProperty(globalThis, 'document', {
  value: { createElement: () => ({ click() {} }) },
  configurable: true,
});

const { saveLog, setDebug, debug, recordError } = await import('../core/debug.js');

/** Run the export and return the parsed payload. */
async function exported() {
  written = null;
  await saveLog();
  assert.ok(written, 'something was written');
  return JSON.parse(written);
}

test('the export names the build that produced it', async () => {
  const p = await exported();
  assert.match(p.build, /Nov 17, 2026/, `got ${p.build}`);
});

test('"unknown" is reachable: an offline stamp read yields null', async () => {
  // Tested through the two pieces rather than through `saveLog`, deliberately.
  // `runningBuildStamp` memoises per page load and `debug.js` registers a setting at
  // module scope, so neither can be re-imported to observe the failure path — and a test
  // that reordered itself to get there would make the test above depend on running
  // second. What the fallback needs is that both pieces produce the falsy value that
  // `|| 'unknown'` turns into the string, so that is what is asserted.
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const bs = await import(`../core/build-stamp.js?nocache=${Math.random()}`);
    assert.equal(await bs.loadedBuildTime(), null, 'a failed fetch is null, not a throw');
    assert.equal(bs.formatBuildTime(null), null, 'and null formats to null');
  } finally {
    globalThis.fetch = real;
  }
});

test('a broken network does not break the export', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const p = await exported();
    assert.ok(p.exported, 'still a valid payload');
    assert.ok(typeof p.build === 'string', 'and still names a build, one way or the other');
  } finally {
    globalThis.fetch = real;
  }
});

test('the last error travels even when the buffer is empty', async () => {
  // The case that matters: debugging was off when it broke, so there are no entries —
  // and the failure is still sitting in the always-on slot.
  recordError(new Error('Out of Memory Error: failed to allocate'), 'unhandledrejection');
  const p = await exported();
  assert.equal(p.entries.length, 0, 'nothing buffered');
  assert.match(p.lastError.message, /Out of Memory/);
  assert.equal(p.lastError.where, 'unhandledrejection');
});

test('cross-origin isolation is reported, since it gates the fast path', async () => {
  const p = await exported();
  assert.equal(p.isolated, 'true');
});

test('buffered entries still come through once logging is on', async () => {
  setDebug(true);
  debug('import', 'route', { wide: false, columns: 3379 });
  const p = await exported();
  setDebug(false);
  const tags = p.entries.map((e) => e.tag);
  assert.ok(tags.includes('import'), `got ${JSON.stringify(tags)}`);
  const entry = p.entries.find((e) => e.tag === 'import');
  assert.deepEqual(entry.message[1], { wide: false, columns: 3379 });
  assert.ok(entry.time, 'and each entry is stamped');
});
