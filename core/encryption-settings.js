/**
 * @file encryption-settings.js
 * A tiny settings dialog for the at-rest encryption **policy** (#144). Deliberately
 * exposes only the one control the user should own: whether NEW projects stored in
 * the browser (OPFS) are encrypted by default. Exports and folder projects are
 * encrypted by default already and their opt-out is a per-operation choice (the
 * "Protect this export?" / "Move without protection" prompts), so they're shown as
 * read-only context here rather than global switches — one less way to accidentally
 * make sensitive data leave in the clear.
 *
 * The honest framing matters: OPFS encryption protects a project's data at rest on
 * this device (against another account, an infostealer reading the profile, a lost
 * laptop) — but NOT a project that's open in an unlocked session, and a forgotten
 * passphrase is unrecoverable. The dialog says so plainly.
 */

import { getEncryptionPolicy, setEncryptionPolicy } from './at-rest.js';

/** Show the encryption-settings dialog. Fire-and-forget (persists on toggle). */
export function showEncryptionSettings() {
  const policy = getEncryptionPolicy();
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog ct-encset';
  dialog.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">Encryption settings</h2>

      <label class="ct-encset__row">
        <input type="checkbox" class="ct-encset__local" />
        <span>
          <span class="ct-encset__label">Encrypt new projects on this device by default</span>
          <span class="ct-encset__sub">When on, each new project asks you to set its own passphrase.
            The data is then stored encrypted in this browser. You'll need the passphrase to open it.</span>
        </span>
      </label>

      <p class="ct-dialog__warning ct-encset__warn">⚠ No recovery: a forgotten passphrase can't be reset by
        anyone, and the project can't be opened without it. Protection covers data at rest — it does not
        protect a project while it's open in an unlocked session.</p>

      <p class="ct-encset__note">Files you <strong>export</strong> and projects you move to a
        <strong>folder</strong> are encrypted by default already — you choose per file/folder whether to set a
        passphrase or leave it unprotected at that moment.</p>

      <p class="ct-encset__tip">To protect (or unprotect) a project you've already made, use
        <strong>File ▸ Protect this project…</strong>.</p>

      <menu class="ct-dialog__buttons">
        <button value="ok" type="submit" class="ct-dialog__primary">Done</button>
      </menu>
    </form>`;

  const localBox = dialog.querySelector('.ct-encset__local');
  localBox.checked = !!policy.local;
  // Persist immediately on toggle — no separate save button for a single switch.
  localBox.addEventListener('change', () => setEncryptionPolicy({ local: localBox.checked }));

  injectStyles();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .ct-encset .ct-dialog__form { max-width: 460px; }
    .ct-encset__row { display: flex; gap: 10px; align-items: flex-start; margin: 4px 0 12px; cursor: pointer; }
    .ct-encset__row input { margin-top: 3px; flex: none; }
    .ct-encset__label { display: block; font-weight: 600; }
    .ct-encset__sub { display: block; font-size: 12.5px; color: #5a6570; margin-top: 3px; line-height: 1.45; }
    .ct-encset__warn { margin: 0 0 12px; }
    .ct-encset__note, .ct-encset__tip { font-size: 12.5px; color: #5a6570; line-height: 1.45; margin: 0 0 10px; }`;
  document.head.append(s);
}
