/**
 * Headless tests for the at-rest encryption policy + passphrase-provider seam
 * (core/at-rest.js). A tiny in-memory localStorage shim makes the persisted
 * overrides testable in Node.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage shim (must be set before importing the module under test uses it;
// the module reads globalThis.localStorage lazily per call, so setting it here is fine).
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
})();

const { defaultEncrypt, getEncryptionPolicy, setEncryptionPolicy, shouldEncrypt, setPassphraseProvider, passphraseFor, hasPassphraseProvider } = await import('../core/at-rest.js');

test('defaults: opt-out for what leaves storage, opt-in for local', () => {
  globalThis.localStorage.clear();
  assert.equal(defaultEncrypt('export'), true);   // leaving → default on
  assert.equal(defaultEncrypt('folder'), true);   // leaving (cloud folder) → default on
  assert.equal(defaultEncrypt('local'), false);   // stays in browser → opt-in
  assert.equal(defaultEncrypt('unknown'), false);
});

test('shouldEncrypt reflects defaults with persisted overrides', () => {
  globalThis.localStorage.clear();
  assert.equal(shouldEncrypt('export'), true);
  assert.equal(shouldEncrypt('local'), false);
  setEncryptionPolicy({ local: true, export: false }); // opt local IN, opt exports OUT
  assert.equal(shouldEncrypt('local'), true);
  assert.equal(shouldEncrypt('export'), false);
  assert.equal(shouldEncrypt('folder'), true);         // untouched default
  assert.deepEqual(getEncryptionPolicy(), { export: false, folder: true, local: true });
});

test('overrides persist across a fresh policy read', () => {
  globalThis.localStorage.clear();
  setEncryptionPolicy({ folder: false });
  assert.equal(getEncryptionPolicy().folder, false); // read back from storage
});

test('passphrase provider: null until registered, then used', async () => {
  setPassphraseProvider(null);
  assert.equal(hasPassphraseProvider(), false);
  assert.equal(await passphraseFor('export'), null); // no provider → plaintext fallback
  let seen = null;
  setPassphraseProvider(async (purpose) => { seen = purpose; return 'hunter2'; });
  assert.equal(hasPassphraseProvider(), true);
  assert.equal(await passphraseFor('export', { filename: 'x.csv' }), 'hunter2');
  assert.equal(seen, 'export');
  setPassphraseProvider(null); // reset for other tests
});
