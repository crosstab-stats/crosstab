/**
 * @file crypto-envelope.js
 * The passphrase-based encryption kernel (#143/#144) — the one crypto primitive the
 * whole project shares: folder/cloud sync at rest, and (later) live-transport
 * signaling and encrypted exports.
 *
 * ## Why this lives in the kernel
 *
 * Core encrypts **before** handing bytes to a storage driver and decrypts **after**
 * reading them back, so a driver (a local folder mirrored to OneDrive/Dropbox, or a
 * future untrusted cloud-API plugin) only ever touches **ciphertext**. That's what
 * makes the whole storage-driver ecosystem safe to open up: a malicious or
 * compromised provider can withhold or corrupt bytes, but can't read your data
 * (residual: it still sees file sizes, paths, and timing — stated plainly, no
 * theatre).
 *
 * ## Design
 *
 *  - **KDF:** PBKDF2-HMAC-SHA-256, high iteration count. Argon2id/scrypt would be
 *    stronger against GPU cracking, but both mean **vendoring a crypto lib** — the
 *    lifelong pin/CVE burden the project rejects — whereas PBKDF2 is native WebCrypto
 *    (works identically in the browser and in Node's test runner). The iteration
 *    count is stored per-project so it can be raised later without breaking old data.
 *  - **Cipher:** AES-256-GCM (authenticated) with a fresh 12-byte IV per write, so
 *    tampering or a wrong passphrase fails loudly (GCM auth) rather than silently
 *    returning garbage.
 *  - **Master key, derived once.** The expensive PBKDF2 runs once per session from
 *    the passphrase + a per-project **salt** (public, stored beside the data). Every
 *    file is then AES-GCM'd with that in-memory key + a random IV — no per-file KDF,
 *    so encrypting hundreds of Parquet parts stays cheap. The key is never persisted;
 *    a forgotten passphrase is unrecoverable (the UX must say so unmistakably).
 *
 * File envelope layout: `MAGIC(4) ‖ iv(12) ‖ AES-GCM(ciphertext‖tag)`. The magic
 * prefix lets {@link isEnveloped} tell ciphertext from plaintext JSON/Parquet, so a
 * store can read mixed/legacy content and migrate in place.
 */

/** `C T E \x01` — envelope marker. The 0x01 keeps it distinct from JSON (`{`),
 * Parquet (`PAR1`), and other text so {@link isEnveloped} never false-positives. */
export const MAGIC = new Uint8Array([0x43, 0x54, 0x45, 0x01]);
const IV_LEN = 12;

/** OWASP-tier default for PBKDF2-HMAC-SHA-256; stored per project so it can rise. */
export const DEFAULT_ITERATIONS = 310000;

const te = new TextEncoder();
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto unavailable (needs a secure context / modern runtime)');
  return s;
};

/** A fresh 16-byte project salt (public — not a secret; it just de-duplicates the
 * derived key across projects/users sharing a passphrase). */
export function newSalt() {
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Derive the AES-GCM master key from a passphrase + project salt. Expensive by
 * design (PBKDF2 iterations) — call once per session and hold the returned key in
 * memory; never persist it.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {number} [iterations]
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  if (!passphrase) throw new Error('deriveKey: empty passphrase');
  const base = await subtle().importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** @returns {boolean} Whether `bytes` is one of our encryption envelopes. */
export function isEnveloped(bytes) {
  if (!bytes || bytes.length < MAGIC.length + IV_LEN) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Encrypt bytes (or a string) with a derived key → a self-describing envelope.
 * @param {CryptoKey} key
 * @param {Uint8Array|string} data
 * @returns {Promise<Uint8Array>}
 */
export async function encryptWithKey(key, data) {
  const plain = typeof data === 'string' ? te.encode(data) : data;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_LEN);
  return out;
}

/**
 * Decrypt an envelope with a derived key. Throws if the passphrase is wrong or the
 * bytes were tampered with (AES-GCM authentication), or if `env` isn't an envelope.
 * @param {CryptoKey} key
 * @param {Uint8Array} env
 * @returns {Promise<Uint8Array>}
 */
export async function decryptWithKey(key, env) {
  if (!isEnveloped(env)) throw new Error('decrypt: not an encrypted envelope');
  const iv = env.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const ct = env.subarray(MAGIC.length + IV_LEN);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, key, ct));
  } catch {
    throw new Error('decrypt failed — wrong passphrase or corrupted data');
  }
}

/** Decode an envelope's plaintext as UTF-8 text (for JSON manifests). */
export async function decryptText(key, env) {
  return new TextDecoder().decode(await decryptWithKey(key, env));
}
