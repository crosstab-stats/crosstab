/**
 * @file storage-pressure.js
 * What to do when the browser is running out of room — and who decides.
 *
 * ## Why this exists at all
 *
 * Saving used to reclaim space as a side effect: every save deleted the bytes of any
 * source op its manifest did not reference. That is the wrong moment to make a space
 * decision, and it is where every bug in that area came from, including one that deleted
 * a peer's half-synced data (2026-10-21). So a save now frees nothing, and the bytes of a
 * retracted or superseded source are kept — which deepens undo and makes a peer's
 * revival of a retracted op work locally.
 *
 * That trade has one cost, and this file is it: nothing shrinks on its own, so a long
 * session of large re-imports grows until a write fails. OPFS does not degrade when it
 * runs out — `write` throws `QuotaExceededError` — and the write that throws is the one
 * saving your work. A guard is therefore not optional garnish; it is what makes "keep
 * everything by default" safe.
 *
 * ## It offers, it does not act
 *
 * Two routes, because they cost different things and only the user knows which they can
 * afford:
 *
 *  - **Compact this project** — frees the bytes this project's own log says are dead.
 *    The cost is undo depth: the generation a `replace` superseded is kept precisely so
 *    one Ctrl+Z brings it back, and compacting trades that for space. Says so.
 *  - **Manage projects** — other projects are usually where the room actually is, and
 *    deleting one you have finished with costs nothing in the one you are working on.
 *
 * Neither happens without being chosen. A tool that silently deleted data to keep itself
 * running would be solving its problem with the user's.
 */

import { el } from './plugin-stdlib.js';

/** Below this share of free space, start offering. ~15% is late enough not to nag and
 * early enough that a few more saves still fit. */
export const PRESSURE_FRACTION = 0.85;

/**
 * Should we say something, and how urgently?
 *
 * Pure, so the policy can be tested without a browser — the arithmetic around a quota is
 * exactly the sort of thing that is wrong by a factor of 1024 and never noticed.
 *
 * `failed` is set when a write has ALREADY thrown. That outranks any estimate: the
 * estimate is approximate by design (browsers round it to resist fingerprinting), so a
 * real failure is the only reliable signal there is, and it must not be second-guessed
 * by a number that says there was room.
 *
 * @param {{usage: number, quota: number, freeBytes: number, usedFraction: number}|null} est
 * @param {{failed?: boolean, needBytes?: number}} [ctx]
 * @returns {{level: 'none'|'warn'|'critical', reason: string}}
 */
export function pressureLevel(est, { failed = false, needBytes = 0 } = {}) {
  if (failed) {
    return { level: 'critical', reason: 'a save has already failed for want of space' };
  }
  // No estimate means NO INFORMATION, which is not the same as plenty of room — but it
  // is also no basis for interrupting someone. Stay quiet and let a real failure speak.
  if (!est) return { level: 'none', reason: 'the browser does not report storage usage' };
  if (needBytes > 0 && est.freeBytes < needBytes) {
    return { level: 'critical', reason: 'the next write is larger than the room left' };
  }
  if (est.usedFraction >= PRESSURE_FRACTION) {
    return { level: 'warn', reason: 'storage is nearly full' };
  }
  return { level: 'none', reason: 'there is room' };
}

/**
 * Is this the browser saying "no room", rather than any other failure?
 *
 * Checked by NAME and by legacy code, not with `instanceof`: the error can cross a realm
 * boundary (a worker, the sandboxed plugin frame), and `instanceof DOMException` is false
 * on the other side of one. Getting this wrong in the permissive direction would offer to
 * delete data because a file was locked.
 */
export function isQuotaError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_FILE_NO_DEVICE_SPACE'   // Firefox
    || err.code === 22                            // legacy DOMException.QUOTA_EXCEEDED_ERR
    || err.code === 1014;                         // legacy Firefox
}

/** Bytes as a person reads them. */
export function humanBytes(n) {
  // Clamped: a negative size is nonsense, and `freeBytes` is computed from an estimate
  // that can report usage above quota on some engines — printing "-5 B free" would make
  // the one dialog that has to be trusted look broken.
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * What the dialog says, given the numbers. Pure, because the wording IS the feature
 * here: this is the one moment the user is asked to trade something away, and a sentence
 * that overstates what compaction costs — or understates it — is the whole harm.
 *
 * @param {{level: string}} pressure
 * @param {{usage: number, quota: number, freeBytes: number}|null} est
 * @param {{files: string[], bytes: number}|null} plan what compaction would free here
 */
export function pressureOffer(pressure, est, plan) {
  const critical = pressure.level === 'critical';
  const room = est
    ? `${humanBytes(est.usage)} of ${humanBytes(est.quota)} used — about `
      + `${humanBytes(est.freeBytes)} free.`
    : 'This browser does not report how much room is left.';
  const n = plan?.files?.length ?? 0;
  return {
    title: critical ? 'Out of space' : 'Storage is nearly full',
    status: critical
      ? `A save could not finish because this browser is out of room. ${room}`
      : `${room} Saving will start to fail when it runs out.`,
    compactLabel: n ? `Compact this project (frees ${humanBytes(plan.bytes)})` : 'Nothing to compact here',
    canCompact: n > 0,
    compactBody: n
      ? `${n} data file${n === 1 ? '' : 's'} in this project belong${n === 1 ? 's' : ''} to steps `
        + 'that have been undone or replaced. The log keeps the record of them either way; '
        + 'this frees the bytes. **It costs undo depth** — a replaced import can currently '
        + 'be brought back with Ctrl+Z, and after this it cannot.'
      : 'Every data file in this project belongs to a step that is still in use, so there '
        + 'is nothing here to free. The room will have to come from somewhere else.',
    manageBody:
      'Other projects are usually where the room is, and deleting one you have finished '
      + 'with costs nothing in this one. The manager shows what each is using.',
  };
}

/**
 * Offer the two routes. Resolves with what the user chose, having done nothing itself.
 *
 * @param {object} deps
 * @param {{level: string, reason: string}} deps.pressure
 * @param {object|null} deps.estimate
 * @param {{files: string[], bytes: number}|null} deps.plan
 * @returns {Promise<'compact'|'manage'|null>}
 */
export function showStoragePressure({ pressure, estimate, plan }) {
  const copy = pressureOffer(pressure, estimate, plan);
  return new Promise((resolve) => {
    let choice = null;
    const d = document.createElement('dialog');
    d.className = 'ct-dialog';
    const form = el('div', { class: 'ct-dialog__form' });
    form.append(el('h2', { class: 'ct-dialog__title', text: copy.title }));
    form.append(el('p', { class: 'ct-dialog__hint', text: copy.status }));

    const compactWrap = el('div', { class: 'ct-share__action' });
    compactWrap.append(el('p', { class: 'ct-dialog__hint', text: stripEmphasis(copy.compactBody) }));
    const compact = el('button', { class: copy.canCompact ? 'ct-dialog__primary' : '', text: copy.compactLabel });
    compact.type = 'button';
    compact.disabled = !copy.canCompact;
    compact.addEventListener('click', () => { choice = 'compact'; d.close(); });
    compactWrap.append(compact);
    form.append(compactWrap);

    const manageWrap = el('div', { class: 'ct-share__action' });
    manageWrap.append(el('p', { class: 'ct-dialog__hint', text: copy.manageBody }));
    const manage = el('button', { text: 'Manage projects…' });
    manage.type = 'button';
    manage.addEventListener('click', () => { choice = 'manage'; d.close(); });
    manageWrap.append(manage);
    form.append(manageWrap);

    const menu = el('menu', { class: 'ct-dialog__buttons' });
    const later = el('button', { text: 'Not now' });
    later.type = 'button';
    later.addEventListener('click', () => d.close());
    menu.append(later);
    form.append(menu);

    d.append(form);
    d.addEventListener('close', () => { d.remove(); resolve(choice); });
    document.body.append(d);
    d.showModal();
  });
}

/** The copy carries `**bold**` for the TODO and the tests; a dialog shows plain text. */
function stripEmphasis(s) {
  return String(s ?? '').replace(/\*\*/g, '');
}
