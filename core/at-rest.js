/**
 * @file at-rest.js
 * At-rest encryption **policy** + the passphrase-provider seam (#144) — the small
 * shared layer that decides *when* to encrypt and *how to obtain the passphrase*,
 * sitting above the reusable crypto ({@link module:core/crypto-envelope}).
 *
 * ## The two sides of one coin
 *
 * Encryption is default posture by **target**:
 *  - `export` — a file leaving for someone else → **default ON (opt-out)**.
 *  - `folder` — a project in a picked folder the OS mirrors to a cloud provider →
 *    **default ON (opt-out)**: it left our origin-private storage.
 *  - `local` — an OPFS project that never leaves the browser origin → **default OFF
 *    (opt-in)**: FDE/OS is the primary at-rest answer there; this is the extra layer.
 *
 * The mechanism is shared (PBKDF2 → AES-GCM); only the default differs, so "opt-out
 * for what leaves" and "opt-in for local" are the same code with a different flag.
 * Users can flip any default (persisted).
 *
 * ## Passphrase provider
 *
 * The passphrase PROMPT is UI, so it's injected: the app registers a provider once
 * (`setPassphraseProvider`) and every path asks via `passphraseFor(purpose)`. With no
 * provider (e.g. headless, or before the UI wires it), `passphraseFor` returns null
 * and callers fall back to plaintext — so nothing breaks; encryption simply engages
 * once the prompt is available. The derived key/passphrase is never persisted (see
 * crypto-envelope); a forgotten passphrase is unrecoverable.
 */

import { defineSetting } from './settings.js';

/** Default posture per target. Opt-out for anything leaving origin-private storage;
 * opt-in for storage that stays in the browser origin. */
const DEFAULTS = Object.freeze({ export: true, folder: true, local: false });

/**
 * The policy as a declared setting, so a Settings screen can find it (the key is
 * unchanged).
 *
 * `coerce` is where the merge lives: what is STORED may be a partial — `{local: true}`
 * and nothing else — and the effective policy is always that read over the defaults. Put
 * differently, a target the user has never ruled on keeps following the default even
 * after the defaults change, which is the behaviour a stored full snapshot would have
 * quietly frozen.
 *
 * The fallback is a thunk because callers have always received a fresh, mutable object;
 * handing back the frozen DEFAULTS instead would turn a stray write into a silent no-op.
 */
const policySetting = defineSetting({
  id: 'privacy.encryption',
  key: 'crosstab.encryption-policy',
  json: true,
  coerce: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...DEFAULTS, ...v } : undefined),
  fallback: () => ({ ...DEFAULTS }),
  label: 'Encrypt at rest',
  group: 'Privacy',
  hint: 'Which targets are encrypted: exports and synced folders by default, local storage on request.',
});

/** The default encryption posture for a target (ignoring user overrides). */
export function defaultEncrypt(target) {
  return DEFAULTS[target] ?? false;
}

/** The effective policy = defaults with any persisted user overrides applied. */
export function getEncryptionPolicy() {
  return policySetting.get();
}

/** Persist an override patch (e.g. `{ local: true }` to opt local storage in, or
 * `{ export: false }` to opt exports out). Returns the effective policy. */
export function setEncryptionPolicy(patch) {
  const next = { ...getEncryptionPolicy(), ...(patch || {}) };
  policySetting.set(next);
  return next;
}

/** Whether a given target should be encrypted under the effective policy. */
export function shouldEncrypt(target) {
  return !!getEncryptionPolicy()[target];
}

// --- passphrase provider (the UI prompt, injected) -------------------------

let _provider = null;

/**
 * A distinct third outcome for "set" prompts that offer BOTH "protect" and "leave
 * unprotected": the user wants to abort the whole operation, not just skip
 * encryption. A provider returns this (instead of a passphrase or `null`) so the
 * caller can tell "move the project unprotected" (`null`) apart from "cancel the
 * move entirely" (`PASSPHRASE_ABORT`). Two-button prompts never return it.
 */
export const PASSPHRASE_ABORT = Symbol('passphrase:abort');

/**
 * Register the passphrase prompt. `fn(purpose, opts)` → Promise<string|null|typeof
 * PASSPHRASE_ABORT> (null = declined → caller falls back to plaintext;
 * PASSPHRASE_ABORT = cancel the whole operation).
 * `purpose` is e.g. `'export'` | `'open-export'` | `'folder'` so the prompt can
 * tailor its copy (and warn "unrecoverable" when SETTING one).
 */
export function setPassphraseProvider(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

/** Ask for a passphrase for `purpose`, or null if no provider is registered. */
export function passphraseFor(purpose, opts) {
  return _provider ? _provider(purpose, opts) : Promise.resolve(null);
}

/** @returns {boolean} Whether a passphrase prompt is available. */
export function hasPassphraseProvider() {
  return _provider != null;
}
