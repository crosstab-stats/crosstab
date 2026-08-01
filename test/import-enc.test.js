import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSelfContained, decryptSelfContained, isSelfContained } from '../core/crypto-envelope.js';

// These lock the contract the encrypted-export import path (#144) relies on: an
// exported `.enc` file is detected, round-trips, fails closed on a wrong passphrase,
// and its inner format is recoverable from the filename.

test('a 64-byte prefix is enough to detect the envelope (the looksEncrypted path)', async () => {
  const csv = new TextEncoder().encode('a,b\n1,2\n3,4\n');
  const enc = await encryptSelfContained('pw', csv);
  assert.ok(isSelfContained(enc), 'full envelope detected');
  assert.ok(isSelfContained(enc.slice(0, 64)), 'prefix detected — why looksEncrypted slices 64');
  assert.ok(!isSelfContained(enc.slice(0, 8)), 'too-short prefix rejected by the header-length guard');
});

test('an encrypted export round-trips back to the original bytes', async () => {
  const orig = new TextEncoder().encode('x,y\n5,6\n');
  const enc = await encryptSelfContained('secret', orig);
  const back = await decryptSelfContained('secret', enc);
  assert.deepEqual(Array.from(back), Array.from(orig));
});

test('a wrong passphrase fails closed (ciphertext never reaches a parser)', async () => {
  const enc = await encryptSelfContained('right', new TextEncoder().encode('data'));
  await assert.rejects(() => decryptSelfContained('wrong', enc));
});

test('plaintext is not mistaken for an envelope', () => {
  const csv = new TextEncoder().encode('id,score\n1,99\n2,88\n');
  assert.ok(!isSelfContained(csv));
});

test('inner filename recovery strips only the .enc suffix', () => {
  // Mirrors #decryptAndDispatch: `<original>.enc` → `<original>` (case-insensitive),
  // with a fallback for a degenerate name.
  const strip = (n) => n.replace(/\.enc$/i, '') || 'data';
  assert.equal(strip('study.csv.enc'), 'study.csv');
  assert.equal(strip('data.parquet.ENC'), 'data.parquet');
  assert.equal(strip('archive.zip.enc'), 'archive.zip');
  assert.equal(strip('.enc'), 'data');
});
