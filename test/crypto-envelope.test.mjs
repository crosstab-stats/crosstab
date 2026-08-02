/**
 * Headless tests for the passphrase encryption kernel (core/crypto-envelope.js).
 * Uses Node's native WebCrypto (same API as the browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey, encryptWithKey, decryptWithKey, decryptText, isEnveloped, newSalt, MAGIC,
  encryptSelfContained, decryptSelfContained, isSelfContained } from '../core/crypto-envelope.js';

const te = new TextEncoder();

test('round-trips text and bytes', async () => {
  const salt = newSalt();
  const key = await deriveKey('correct horse battery staple', salt);
  const env = await encryptWithKey(key, 'the quick brown fox');
  assert.ok(isEnveloped(env));
  assert.equal(await decryptText(key, env), 'the quick brown fox');

  const bytes = new Uint8Array([1, 2, 3, 250, 0, 128]);
  assert.deepEqual([...(await decryptWithKey(key, await encryptWithKey(key, bytes)))], [...bytes]);
});

test('same passphrase + salt derives an interoperable key (survives a reload)', async () => {
  const salt = newSalt();
  const env = await encryptWithKey(await deriveKey('pw', salt), 'shared');
  const keyAgain = await deriveKey('pw', salt); // e.g. next session, same passphrase + stored salt
  assert.equal(await decryptText(keyAgain, env), 'shared');
});

test('wrong passphrase fails loudly (no silent garbage)', async () => {
  const salt = newSalt();
  const env = await encryptWithKey(await deriveKey('right', salt), 'secret');
  const wrongKey = await deriveKey('wrong', salt);
  await assert.rejects(() => decryptText(wrongKey, env), /wrong passphrase or corrupted/);
});

test('a different salt is a different key', async () => {
  const env = await encryptWithKey(await deriveKey('pw', newSalt()), 'x');
  const otherKey = await deriveKey('pw', newSalt());
  await assert.rejects(() => decryptWithKey(otherKey, env));
});

test('tampering is detected (AES-GCM authentication)', async () => {
  const key = await deriveKey('pw', newSalt());
  const env = await encryptWithKey(key, 'important');
  env[env.length - 1] ^= 0xff; // flip a ciphertext byte
  await assert.rejects(() => decryptWithKey(key, env));
});

test('a fresh IV per write → same plaintext encrypts to different bytes', async () => {
  const key = await deriveKey('pw', newSalt());
  const a = await encryptWithKey(key, 'dup');
  const b = await encryptWithKey(key, 'dup');
  assert.notDeepEqual([...a], [...b]);
  // …but both still decrypt.
  assert.equal(await decryptText(key, a), 'dup');
  assert.equal(await decryptText(key, b), 'dup');
});

test('isEnveloped distinguishes ciphertext from plaintext JSON / Parquet', async () => {
  const key = await deriveKey('pw', newSalt());
  assert.ok(isEnveloped(await encryptWithKey(key, '{}')));
  assert.ok(!isEnveloped(te.encode('{"name":"P"}')));       // JSON manifest
  assert.ok(!isEnveloped(te.encode('PAR1')));                // Parquet magic
  assert.ok(!isEnveloped(new Uint8Array([MAGIC[0], MAGIC[1]]))); // too short
});

// --- self-contained (export) envelope --------------------------------------

test('self-contained envelope round-trips from passphrase alone (no sidecar)', async () => {
  const env = await encryptSelfContained('export-pw', 'sensitive export bytes');
  assert.ok(isSelfContained(env));
  assert.ok(!isEnveloped(env));                              // distinct from the keyed envelope
  assert.equal(new TextDecoder().decode(await decryptSelfContained('export-pw', env)), 'sensitive export bytes');
});

test('self-contained: wrong passphrase fails; each export has a unique salt/iv', async () => {
  const a = await encryptSelfContained('pw', 'x');
  const b = await encryptSelfContained('pw', 'x');
  assert.notDeepEqual([...a], [...b]);                       // fresh salt + iv per export
  await assert.rejects(() => decryptSelfContained('nope', a), /wrong passphrase or corrupted/);
});

test('self-contained handles ArrayBuffer/Uint8Array payloads (Parquet/xlsx exports)', async () => {
  const bytes = new Uint8Array([80, 65, 82, 49, 0, 255, 7]);
  const env = await encryptSelfContained('pw', bytes.buffer);
  assert.deepEqual([...(await decryptSelfContained('pw', env))], [...bytes]);
});
