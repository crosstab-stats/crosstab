/**
 * @file dialog-keys.js
 * Make the Enter key activate a dialog's **primary (blue) button**.
 *
 * Our dialogs are `<form method="dialog">`. Pressing Enter in a field performs
 * the form's *implicit submission*, which activates the **first submit button in
 * tree order** — and we conventionally place "Cancel" first, so Enter would
 * cancel (and on a plain text prompt, "nothing happens"). That's the opposite of
 * what a blue affirmative button signals.
 *
 * Fix: leave the `.ct-dialog__primary` button as the form's *only* submit button
 * and demote the others to plain `type="button"` (wired to close the dialog with
 * their own value). Implicit submission then has exactly one target — the primary
 * — so Enter maps to the blue button. Clicking still works for every button.
 *
 * Which button is primary is the per-dialog lever: mark the affirmative for a
 * normal prompt, or the *safe* choice for a risky one (e.g. "Block" on the
 * network-consent dialog), so an accidental Enter can't do something dangerous.
 *
 * This is installed app-wide by wrapping {@link HTMLDialogElement.showModal}
 * (see {@link installDialogKeybindings}), so every current and future dialog gets
 * the behaviour without each call site opting in.
 */

/**
 * Make `dialog`'s `.ct-dialog__primary` button the Enter default by demoting its
 * sibling submit buttons. No-op (Enter left native) if the dialog has no primary
 * button. Idempotent.
 *
 * @param {HTMLDialogElement} dialog
 */
export function enterTriggersPrimary(dialog) {
  if (!(dialog instanceof HTMLDialogElement) || dialog.dataset.ctKeysWired) return;
  const form = dialog.querySelector('form');
  const primary = form?.querySelector('button.ct-dialog__primary');
  if (!form || !primary) return; // no primary → don't touch this dialog's keys
  dialog.dataset.ctKeysWired = '1';
  for (const btn of form.querySelectorAll('button[type="submit"]')) {
    if (btn === primary) continue;
    btn.type = 'button';
    btn.addEventListener('click', () => dialog.close(btn.value));
  }
}

/**
 * Install {@link enterTriggersPrimary} for every modal dialog, app-wide, by
 * wrapping `showModal`. Call once at boot. Idempotent.
 */
export function installDialogKeybindings() {
  const proto = HTMLDialogElement.prototype;
  if (proto.__ctKeysPatched) return;
  proto.__ctKeysPatched = true;
  const original = proto.showModal;
  proto.showModal = function (...args) {
    try {
      enterTriggersPrimary(this);
    } catch {
      /* never let key-wiring stop a dialog from opening */
    }
    return original.apply(this, args);
  };
}
