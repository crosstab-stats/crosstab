/**
 * @file passphrase-ui.js
 * The passphrase prompt (#144) — the one UI piece the at-rest encryption needs. Two
 * modes over one dialog:
 *
 *  - **enter** — unlock existing ciphertext (open an encrypted project or a received
 *    `.enc` export): a single field; a wrong one fails at the crypto layer.
 *  - **set** — choose a passphrase to protect something leaving (an export, or turning
 *    on encryption): passphrase + confirm, with an unmissable **"there is no
 *    recovery"** warning (no server, by design — a forgotten passphrase is permanent).
 *
 * DOM-only, matching the app's `ct-dialog` conventions. `installPassphraseUI()`
 * registers it as the {@link module:core/at-rest} provider, so export/import/folder
 * flows get their prompt; before that, those flows fall back to plaintext.
 */

import { setPassphraseProvider, PASSPHRASE_ABORT } from './at-rest.js';

/** Purposes that MEAN "choose a new passphrase" (set + confirm + warning). */
const SET_PURPOSES = new Set(['export', 'set', 'folder-new', 'local-new', 'enable', 'change-new']);

/**
 * Show the passphrase dialog. Resolves to the passphrase, or null if cancelled (the
 * caller then leaves the data plaintext / aborts the open).
 *
 * Pass `skipLabel` to turn a "set" prompt into a THREE-outcome dialog — used where
 * "leave it unprotected" and "cancel the whole operation" are genuinely different
 * (e.g. moving a project to a folder): the primary button returns the passphrase,
 * the skip button returns `null` (proceed unprotected), and Cancel/Escape return
 * {@link module:core/at-rest.PASSPHRASE_ABORT} (abort). Without `skipLabel` the
 * dialog keeps its two-button behaviour (Cancel → null), so existing callers are
 * unaffected.
 *
 * @param {object} [opts]
 * @param {'enter'|'set'} [opts.mode='enter']
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {string} [opts.okLabel]
 * @param {string} [opts.skipLabel]   secondary "proceed unprotected" button (→ null)
 * @param {string} [opts.cancelLabel] relabel the cancel button (e.g. "Cancel move")
 * @returns {Promise<string|null|symbol>}
 */
export function showPassphraseDialog({ mode = 'enter', title, message, okLabel, skipLabel, cancelLabel } = {}) {
  const isSet = mode === 'set';
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-passphrase';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';

    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = title || (isSet ? 'Set a passphrase' : 'Enter passphrase');
    form.append(h2);

    if (message) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = message;
      form.append(p);
    }

    const pass = document.createElement('input');
    pass.type = 'password';
    pass.className = 'ct-input ct-passphrase__field';
    pass.placeholder = 'Passphrase';
    pass.autocomplete = isSet ? 'new-password' : 'current-password';
    form.append(pass);

    let confirm = null;
    if (isSet) {
      confirm = document.createElement('input');
      confirm.type = 'password';
      confirm.className = 'ct-input ct-passphrase__field';
      confirm.placeholder = 'Confirm passphrase';
      confirm.autocomplete = 'new-password';
      form.append(confirm);

      const warn = document.createElement('p');
      warn.className = 'ct-dialog__warning';
      warn.textContent = '⚠ There is no recovery. If you forget this passphrase, the data cannot be opened by anyone — including you. Store it somewhere safe.';
      form.append(warn);
    }

    const err = document.createElement('p');
    err.className = 'ct-dialog__error';
    err.hidden = true;
    form.append(err);

    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = cancelLabel || 'Cancel';
    // Three-outcome mode: a distinct "proceed unprotected" button, so Cancel is
    // unambiguously "abort the whole operation" (the point of the button rename).
    let skip = null;
    if (skipLabel) {
      skip = document.createElement('button');
      skip.type = 'button';
      skip.textContent = skipLabel;
    }
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'ct-dialog__primary';
    ok.textContent = okLabel || (isSet ? 'Protect' : 'Unlock');
    menu.append(cancel);
    if (skip) menu.append(skip);
    menu.append(ok);
    form.append(menu);
    dialog.append(form);

    const valid = () => pass.value.length > 0 && (!isSet || pass.value === confirm.value);
    const refresh = () => {
      ok.disabled = !valid();
      if (isSet && confirm.value && pass.value !== confirm.value) {
        err.textContent = 'Passphrases don’t match.';
        err.hidden = false;
      } else {
        err.hidden = true;
      }
    };
    pass.addEventListener('input', refresh);
    confirm?.addEventListener('input', refresh);
    refresh();

    // In three-outcome mode, cancelling (button, Escape, or backdrop close) means
    // "abort the whole operation"; "proceed unprotected" is the explicit skip button.
    const cancelValue = skip ? PASSPHRASE_ABORT : null;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } dialog.close(); };
    cancel.addEventListener('click', () => finish(cancelValue));
    skip?.addEventListener('click', () => finish(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (valid()) finish(pass.value);
    });
    dialog.addEventListener('close', () => { if (!done) { done = true; resolve(cancelValue); } dialog.remove(); });

    document.body.append(dialog);
    dialog.showModal();
    pass.focus();
  });
}

/** Copy tailored to each purpose. */
function copyFor(purpose, opts = {}) {
  switch (purpose) {
    case 'export':
      return { title: 'Protect this export', message: `Set a passphrase to encrypt ${opts.filename ? `“${opts.filename}”` : 'this file'}. The person you send it to will need this passphrase to open it.` };
    case 'open-export':
    case 'import':
      return { title: 'Open encrypted file', message: 'This file is passphrase-protected. Enter the passphrase to open it.' };
    case 'folder':
    case 'unlock':
      return { title: 'Unlock project', message: 'This project is encrypted. Enter its passphrase to open it.' };
    case 'folder-new':
      // Three-outcome: this folder can sync to a cloud provider, so "protect" vs
      // "move unprotected" vs "cancel the move" are all distinct, meaningful choices.
      return {
        title: 'Protect this project?',
        message: 'This folder can sync to a cloud provider (OneDrive, Dropbox…). Set a passphrase to encrypt everything CrossTab writes here — or move it unprotected. It’s required to open the project on any machine and is never stored.',
        okLabel: 'Protect with passphrase',
        skipLabel: 'Move without protection',
        cancelLabel: 'Cancel move',
      };
    case 'local-new':
      return { title: 'Protect this project', message: 'Set a passphrase to encrypt this project’s data on this device. Each project has its own passphrase; it’s required to open the project and is never stored.' };
    case 'enable':
      return { title: 'Encrypt this project', message: 'Set a passphrase. It’s required to open the project on any machine and is never stored.' };
    // Rekeying asks twice: prove you know the current one, then set the new one. The
    // first is an ENTER prompt (no confirm field, no "cannot be recovered" warning —
    // that would be about a passphrase they already have); the second is a SET prompt.
    case 'change-current':
      return {
        title: 'Change passphrase',
        message: `Enter the CURRENT passphrase for ${opts.name ? `“${opts.name}”` : 'this project'}. Changing it re-encrypts every file in one pass — nothing is ever written unprotected.`,
        okLabel: 'Continue',
      };
    case 'change-new':
      return {
        title: 'Set the new passphrase',
        message: 'The old passphrase stops working once this finishes. Anyone sharing this project needs the new one — send it out of band. It isn’t stored anywhere and can’t be recovered.',
        okLabel: 'Change passphrase',
      };
    default:
      return {};
  }
}

/** The provider function {@link module:core/at-rest} calls. */
export function passphrasePrompt(purpose, opts = {}) {
  return showPassphraseDialog({ mode: SET_PURPOSES.has(purpose) ? 'set' : 'enter', ...copyFor(purpose, opts) });
}

/** Register the passphrase prompt as the at-rest provider (call once at startup). */
export function installPassphraseUI() {
  setPassphraseProvider(passphrasePrompt);
}
