/**
 * @file turn-settings.js
 * The TURN relay editor (#209) — the one secret setting, and the one that had no way in.
 *
 * ## Why this exists
 *
 * The Settings screen (#198) was built partly BECAUSE `collab.relays` and `collab.turn`
 * had no UI at all — `setRelayUrls` and `setTurnConfig` had no caller outside
 * `live-sync.js`, so two declared settings were reachable only from a browser console. The
 * relay list got a text box. TURN got status and a Clear button, and I wrote at the time
 * that an add-form was "worth building when something asks for it".
 *
 * Something asked: the owner pointed at a row reading *"Not configured"* with nothing
 * beside it. A row that can only ever report a state and never change it is a guard around
 * a state that should not exist — and in this case it left the console as the only way to
 * configure a relay, which is the exact gap the screen was supposed to close.
 *
 * ## It writes but never reads the credential back
 *
 * `listSettings` refuses to return a secret's value, and this dialog does not go around
 * that: the fields start EMPTY every time, and saving replaces the stored entry rather
 * than editing it in place. That is not a limitation to apologise for — a settings screen
 * that redisplayed a stored password would have made the registry's care pointless, and
 * "type it again" is the normal cost of never printing it.
 *
 * What the dialog does read is `getTurnConfig()`'s non-secret shape: how many servers are
 * stored and their URLs, which are not credentials. A reader needs to know WHICH relay is
 * configured to know whether to replace it.
 *
 * ## Shape
 *
 * `buildIceServers` accepts `{urls, username, credential}` or an array of them, and
 * ignores an entry with no `urls`. The editor stores an array for the same reason: an
 * institution with a TCP and a UDP endpoint is one setting, not two.
 */

import { getTurnConfig, setTurnConfig } from './live-sync.js';
import { el } from './plugin-stdlib.js';

/** How a stored entry is described without printing anything secret. */
export function describeTurn(cfg) {
  const list = Array.isArray(cfg) ? cfg : cfg ? [cfg] : [];
  const urls = list.map((t) => t?.urls).filter(Boolean);
  if (!urls.length) return 'Not configured';
  return urls.length === 1 ? String(urls[0]) : `${urls.length} servers`;
}

/**
 * Validate what was typed, returning `{ entry }` or `{ error }`.
 *
 * Pure, and exported so the rules are testable without a DOM — the shape of a TURN URL is
 * the sort of thing that is easy to get subtly wrong and tedious to check by hand.
 */
export function parseTurnInput({ urls, username, credential }) {
  const u = String(urls || '').trim();
  if (!u) return { error: 'Enter the server URL.' };
  // `turn:` and `turns:` only. A `stun:` URL is not a relay — it reports your address and
  // cannot carry traffic — so accepting one here would store something that silently does
  // not do the job this setting exists for.
  if (!/^turns?:/i.test(u)) {
    return { error: 'A relay URL starts with turn: or turns: — stun: is address discovery, not a relay.' };
  }
  const name = String(username || '').trim();
  const cred = String(credential || '');
  // Both or neither: a TURN server that wants credentials and is given half of a pair
  // fails at connection time, on someone else's machine, with no hint of why.
  if (!!name !== !!cred) {
    return { error: 'A username and a credential go together — give both, or neither for an open relay.' };
  }
  const entry = { urls: u };
  if (name) { entry.username = name; entry.credential = cred; }
  return { entry };
}

/**
 * Show the TURN editor.
 *
 * @returns {Promise<boolean>} whether the stored config changed
 */
export function showTurnSettings() {
  return new Promise((resolve) => {
    const existing = (() => {
      try { return getTurnConfig(); } catch { return null; }
    })();
    const current = Array.isArray(existing) ? existing : existing ? [existing] : [];

    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = el('form', { class: 'ct-dialog__form' });
    form.method = 'dialog';
    form.append(el('h2', { class: 'ct-dialog__title', text: 'TURN server' }));
    form.append(el('p', {
      class: 'ct-dialog__hint',
      text: 'A relay for collaborators who cannot connect directly to each other. Most '
        + 'pairs never need one; a hard NAT or a locked-down campus network does. Yours or '
        + 'your institution’s — CrossTab hosts none.',
    }));

    if (current.length) {
      form.append(el('p', {
        class: 'ct-dialog__hint',
        text: `Currently: ${describeTurn(current)}. Saving replaces it.`,
      }));
    }

    const field = (label, type, hint) => {
      const lab = el('label', { class: 'ct-field' });
      lab.append(document.createTextNode(label));
      const input = document.createElement('input');
      input.type = type;
      input.autocomplete = 'off';
      input.style.cssText = 'width:100%; margin-top:4px;';
      lab.append(input);
      if (hint) lab.append(el('span', { class: 'ct-settings__hint', text: hint }));
      form.append(lab);
      return input;
    };

    const urls = field('Server URL', 'text', 'turn:relay.example.edu:3478 — or turns: for TLS.');
    const username = field('Username', 'text', 'Leave both credential fields empty for an open relay.');
    // `password` so a shoulder-surfer does not read it, and EMPTY on open: the stored
    // credential is never redisplayed, here or anywhere.
    const credential = field('Credential', 'password');

    const err = el('p', { class: 'ct-dialog__hint ct-settings__error' });
    form.append(err);

    const menu = el('menu', { class: 'ct-dialog__buttons' });
    const cancel = el('button', { text: 'Cancel' });
    cancel.value = 'cancel';
    cancel.type = 'submit';
    const clear = el('button', { text: 'Remove relay' });
    clear.type = 'button';
    clear.hidden = !current.length;
    const save = el('button', { text: 'Save relay', class: 'ct-dialog__primary' });
    save.type = 'button';
    menu.append(cancel, clear, save);
    form.append(menu);

    let changed = false;
    const close = () => { dialog.close(); };

    clear.addEventListener('click', () => {
      setTurnConfig(null);
      changed = true;
      close();
    });

    save.addEventListener('click', () => {
      const { entry, error } = parseTurnInput({
        urls: urls.value, username: username.value, credential: credential.value,
      });
      if (error) {
        // Named in the dialog rather than thrown or swallowed: the user is holding the
        // information needed to fix it right now.
        err.textContent = error;
        urls.focus();
        return;
      }
      setTurnConfig([entry]);
      changed = true;
      close();
    });

    dialog.append(form);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(changed); });
    document.body.append(dialog);
    dialog.showModal();
    urls.focus();
  });
}
