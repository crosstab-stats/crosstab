/**
 * @file sharing-settings.js
 * The one dialog for a project's sharing state — two separable actions, said plainly.
 *
 * ## Why this stopped being a `confirm()`
 *
 * File ▸ Sharing… was a two-branch `confirm()`: off → "allow again?", on → "stop
 * sharing?". That shape can only ever offer one verb, and the design note for this
 * feature is explicit that there are **two, and they must not be conflated**:
 *
 *  - **Stop sharing** REFUSES the room the links point at. Reversible — turn it back on
 *    and the same room resumes.
 *  - **Revoke invite links** rotates the project's collab identity, so the links
 *    themselves address a room that no longer exists. Irreversible.
 *
 * The old copy had to apologise for the gap in its own text — *"it does not revoke the
 * links themselves — it refuses the room they point at"* — which is a dialog telling the
 * reader about the button it does not have. Now it has it.
 *
 * ## What the wording has to get right
 *
 * Neither action takes anything back from someone who already has a copy, and saying so
 * is not hedging — a person revoking a link is usually doing it because they are worried
 * about exactly that, and letting them believe it undoes the sharing would be the one
 * genuinely harmful outcome here. Each action states its limit next to itself rather
 * than in a footnote.
 */

import { el } from './plugin-stdlib.js';

/**
 * What the dialog should say and offer, given the state. Pure, so the wording is
 * testable without a DOM — the wording IS the feature here.
 *
 * @param {{sharing: boolean, hasIdentity: boolean}} state
 * @returns {{status: string, toggleLabel: string, toggleBody: string,
 *            canRevoke: boolean, revokeNote: string}}
 */
export function sharingOffer({ sharing, hasIdentity }) {
  return {
    status: sharing
      ? 'Sharing is ON for this project.'
      : 'Sharing is OFF for this project.',
    toggleLabel: sharing ? 'Stop sharing' : 'Allow sharing',
    toggleBody: sharing
      ? 'It will refuse to go live, refuse invite links, and drop any session running '
        + 'now. The decision travels with the project, so people syncing it through a '
        + 'shared folder stop being able to join either. You can turn it back on.'
      : 'Going live and inviting people becomes possible again, and the same room '
        + 'resumes — existing invite links start working again, because stopping '
        + 'sharing refused them rather than revoking them.',
    // Nothing to revoke before the project has ever had an identity: the button would
    // rotate a secret nobody has been given.
    canRevoke: hasIdentity,
    revokeNote: hasIdentity
      ? 'Rotates this project’s room, so every invite link you have already sent stops '
        + 'working. This cannot be undone, and a new link will be a different room. '
        + 'People who sync this project through a shared folder are NOT locked out — '
        + 'they receive the new room with the next sync, because holding the folder is '
        + 'itself the credential.'
      : 'No invite link has been created for this project yet, so there is nothing to '
        + 'revoke.',
  };
}

/** The sentence shown after a revocation, which has to be honest about its limit. */
export const REVOKED_NOTE =
  '**Invite links revoked.** The links you sent now point at a room that no longer '
  + 'exists. This does not retract copies anyone already has, and folder co-holders '
  + 'rejoin automatically with the new room.';

/**
 * Open the sharing dialog.
 *
 * @param {{projects: object, results: object}} deps
 */
export function showSharingSettings({ projects, results }) {
  const render = () => {
    const offer = sharingOffer({
      sharing: !projects.sharingDisabled,
      hasIdentity: !!projects.hasCollabIdentity,
    });

    const d = document.createElement('dialog');
    d.className = 'ct-dialog';
    const form = el('div', { class: 'ct-dialog__form' });
    form.append(el('h2', { class: 'ct-dialog__title', text: 'Sharing' }));
    form.append(el('p', { class: 'ct-dialog__hint', text: offer.status }));

    // --- action 1: the reversible one -------------------------------------------
    const toggleWrap = el('div', { class: 'ct-share__action' });
    toggleWrap.append(el('p', { class: 'ct-dialog__hint', text: offer.toggleBody }));
    const toggle = el('button', { class: 'ct-dialog__primary', text: offer.toggleLabel });
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      const next = !!projects.sharingDisabled; // turning it ON when it was disabled
      projects.setSharing(next);
      d.close();
      results.appendText(next
        ? '**Sharing is on** for this project again.'
        : '**Sharing is off** for this project. It will not go live or issue an invite '
          + 'link until you turn sharing back on in File ▸ Sharing…\n\n'
          + 'This does not retract copies people already hold, and it does not revoke '
          + 'the links themselves — it refuses the room they point at.');
    });
    toggleWrap.append(toggle);
    form.append(toggleWrap);

    // --- action 2: the irreversible one -----------------------------------------
    const revokeWrap = el('div', { class: 'ct-share__action ct-share__action--danger' });
    revokeWrap.append(el('h3', { class: 'ct-share__subtitle', text: 'Invite links' }));
    revokeWrap.append(el('p', { class: 'ct-dialog__hint', text: offer.revokeNote }));
    if (offer.canRevoke) {
      const revoke = el('button', { text: 'Revoke invite links…' });
      revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        // A second ask, because this one cannot be taken back. The question names the
        // consequence rather than the verb — "are you sure?" tells the reader nothing
        // they did not already know when they pressed the button.
        if (!confirm(
          'Revoke every invite link for this project?\n\n'
          + 'Links you have already sent will stop working, and this cannot be undone. '
          + 'Anyone currently in a live session will be disconnected.\n\n'
          + 'People who sync this project through a shared folder are not affected — '
          + 'they will rejoin automatically.',
        )) return;
        d.close();
        const done = await projects.revokeInviteLinks();
        results.appendText(done ? REVOKED_NOTE : 'There were no invite links to revoke.');
      });
      revokeWrap.append(revoke);
    }
    form.append(revokeWrap);

    const menu = el('menu', { class: 'ct-dialog__buttons' });
    const close = el('button', { text: 'Close' });
    close.type = 'button';
    close.addEventListener('click', () => d.close());
    menu.append(close);
    form.append(menu);

    d.append(form);
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  };

  render();
}
