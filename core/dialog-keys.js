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
 * ## Enter bleed-through across a dialog chain
 * When one dialog opens another in response to Enter (e.g. submitting the
 * Wikipedia import form fires a network request, which opens the consent dialog),
 * a *held* Enter — key-repeat, or simply not released yet — would land on the new
 * dialog and trigger its default button before the user even sees it. We guard
 * against that: if Enter is down at the moment a dialog opens, we swallow Enter on
 * that dialog until the key is released. A fresh Enter press still works.
 *
 * This is installed app-wide by wrapping {@link HTMLDialogElement.showModal}
 * (see {@link installDialogKeybindings}), so every current and future dialog gets
 * the behaviour without each call site opting in.
 */

/** Whether the Enter key is currently held — used to detect bleed-through. */
let enterHeld = false;
let trackerInstalled = false;

/** Track the global Enter key state (once). */
function installEnterTracker() {
  if (trackerInstalled) return;
  trackerInstalled = true;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterHeld = true;
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') enterHeld = false;
  }, true);
}

/**
 * Make `dialog`'s `.ct-dialog__primary` button the Enter default by demoting its
 * sibling submit buttons, and guard against Enter bleed-through if the dialog
 * opened while Enter was held. No-op (Enter left native) if the dialog has no
 * primary button. Idempotent.
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

  // Bleed-through guard: this dialog opened with Enter already down, so the same
  // keystroke (or its key-repeat) that opened it must not also answer it. Swallow
  // Enter — in the capture phase, before the form's implicit submission — until
  // the key is released; then restore normal behaviour.
  if (enterHeld) {
    const swallow = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const release = (e) => {
      if (e.key !== 'Enter') return;
      enterHeld = false;
      dialog.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', release, true);
    };
    dialog.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', release, true);
  }
}

/**
 * Install {@link enterTriggersPrimary} for every modal dialog, app-wide, by
 * wrapping `showModal`. Call once at boot. Idempotent.
 */
export function installDialogKeybindings() {
  installEnterTracker();
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
