/**
 * @file project-health.js
 * "Something is off with this project" — said in a way that distinguishes *wait* from
 * *act*, because for a folder project those are opposite advice.
 *
 * ## Why one message would be wrong
 *
 * A project's `project.json` and its Parquet are the two ends of one save, and a folder
 * sync client (OneDrive, Dropbox, Drive) delivers them in whatever order it likes. So on
 * a synced folder, "a file the log expects is not here" is **routine and self-healing** —
 * the right advice is to wait. In local OPFS nothing else writes to the folder, so the
 * same symptom means something actually went wrong, and waiting will not fix it.
 *
 * The data to tell them apart is already to hand: the backing kind, and whether the
 * trouble is absence (could still arrive) or damage (a present file that is not data —
 * nothing is going to repair that by itself). So this produces three honest states
 * instead of one ambiguous one.
 *
 * ## The costs of getting the tone wrong
 *
 * Too alarming and a user deletes and re-imports a project that was about to finish
 * syncing. Too casual and a genuinely corrupt project is left to rot behind a grey
 * notice. The split is the feature; the wording carries it.
 */

import { humanBytes } from './text.js';
import { el } from './plugin-stdlib.js';

/**
 * What the status bar should say about a project's files.
 *
 * Pure: the decision is a sentence a user acts on, and the inputs — a count, a backing
 * kind, a boolean — are exactly the sort of thing that is easy to get subtly wrong and
 * impossible to notice in a running app.
 *
 * @param {object} arg
 * @param {{ok: boolean, manifestUnreadable: boolean, missing: string[],
 *   unreferenced: string[], unreadable: string[]}|null} arg.integrity
 * @param {'opfs'|'folder'|null} arg.backing where the project lives. A folder is written
 *   by something other than this tab; OPFS is not.
 * @param {boolean} [arg.live] a co-authoring session is running, so a peer can supply
 *   bytes this copy lacks.
 * @returns {{level: 'ok'|'waiting'|'damaged', short: string, title: string,
 *   detail: string, canWait: boolean}}
 */
export function projectHealth({ integrity, backing = null, live = false }) {
  const ok = {
    level: 'ok', short: '', title: 'Project files are complete', canWait: false,
    detail: 'Every file this project’s history refers to is present and readable.',
  };
  if (!integrity || integrity.ok) return ok;

  const synced = backing === 'folder';
  const missing = integrity.missing?.length ?? 0;
  const torn = integrity.unreadable?.length ?? 0;
  const spare = integrity.unreferenced?.length ?? 0;

  // Damage first: a present-but-unreadable file, or a manifest that will not parse, is
  // not something a sync client is going to finish delivering.
  if (integrity.manifestUnreadable) {
    return {
      level: 'damaged',
      short: 'Project file unreadable',
      title: 'This project’s index cannot be read',
      canWait: synced,
      detail: synced
        ? 'The project’s own index file (`project.json`) is present but will not parse. '
          + 'On a synced folder this can mean the file is still being written — wait a '
          + 'moment and reopen. If it persists, the file is damaged, and the copy on another '
          + 'machine or in your sync provider’s version history is the way back.'
        : 'The project’s own index file (`project.json`) is present but will not parse. '
          + 'Nothing else writes to local storage, so this is damage rather than a sync in '
          + 'progress — a save interrupted part-way, or storage corruption.',
    };
  }
  if (torn) {
    return {
      level: 'damaged',
      short: `${torn} damaged file${torn === 1 ? '' : 's'}`,
      title: `${torn} data file${torn === 1 ? ' is' : 's are'} present but unreadable`,
      canWait: synced,
      detail: `${torn} file${torn === 1 ? '' : 's'} the history refers to ${torn === 1 ? 'is' : 'are'} `
        + 'here but empty or truncated — the signature of a write that was interrupted. '
        + (synced
          ? 'A sync client can show a file before it has finished copying it, so this may still '
            + 'resolve itself; if it does not, the bytes are gone and the options below apply.'
          : 'Waiting will not help: nothing else writes here, so these will not repair '
            + 'themselves.'),
    };
  }

  // Absence: on a synced folder this is the normal transient state.
  if (missing) {
    return {
      level: synced ? 'waiting' : 'damaged',
      short: synced
        ? `Waiting for ${missing} file${missing === 1 ? '' : 's'}`
        : `${missing} file${missing === 1 ? '' : 's'} missing`,
      title: synced
        ? `Waiting for ${missing} data file${missing === 1 ? '' : 's'}`
        : `${missing} data file${missing === 1 ? ' is' : 's are'} missing`,
      canWait: synced || live,
      detail: synced
        ? 'A project’s index and its data files are written together but sync separately, '
          + 'and the index is much the smaller of the two — so arriving first is normal. '
          + 'Any dataset built from a file that has not landed will look short or empty until '
          + 'it does. This usually clears on its own.'
        : 'The history refers to data files that are not in this project. Nothing else writes '
          + 'to local storage, so they did not fail to arrive — they have gone. A dataset '
          + 'built from one will look short or empty.'
        + (live ? ' A peer in this session may still have them.' : ''),
    };
  }

  // Only unreferenced files left. Harmless on its own, and worth saying quietly.
  return {
    level: synced ? 'waiting' : 'damaged',
    short: `${spare} unexpected file${spare === 1 ? '' : 's'}`,
    title: `${spare} data file${spare === 1 ? '' : 's'} nothing refers to`,
    canWait: synced,
    detail: synced
      ? 'These arrived in the folder but nothing in this project’s history mentions them. '
        + 'That is the other half of the same race: a collaborator’s data file reaching you '
        + 'before the index that explains it. They are left alone — until that index '
        + 'arrives, this may be the only copy.'
      : 'Data files are present that nothing in this project’s history mentions. They are '
        + 'left alone rather than deleted, because a file nobody can account for is not the '
        + 'same as a file nobody needs.',
  };
}

/**
 * The recovery routes for a project in trouble, each with whether it can actually be
 * taken right now and WHY NOT when it cannot.
 *
 * Offered-but-disabled rather than hidden, deliberately. The reason an option is
 * unavailable is the most useful thing on the screen: "rebuild" being greyed out with
 * *"this project was opened without that file, so there is no copy in memory"* tells the
 * user what state they are in, where a missing button tells them nothing and reads as a
 * feature that is broken.
 *
 * @param {object} arg
 * @param {ReturnType<projectHealth>} arg.health
 * @param {{missing: string[], unreferenced: string[], unreadable: string[]}} arg.integrity
 * @param {Set<string>|string[]} [arg.rebuildable] file names whose rows are materialised
 *   in this session and so can be written back out of memory.
 * @param {boolean} [arg.live]
 * @param {number} [arg.spareBytes] what compaction of the unreferenced files would free.
 * @returns {Array<{id: string, label: string, enabled: boolean, why: string}>}
 */
export function recoveryOptions({
  health, integrity, rebuildable = [], live = false, spareBytes = 0,
}) {
  const can = rebuildable instanceof Set ? rebuildable : new Set(rebuildable);
  const broken = [...(integrity?.missing ?? []), ...(integrity?.unreadable ?? [])];
  const fixable = broken.filter((f) => can.has(f));
  const out = [];

  out.push({
    id: 'recheck',
    label: 'Check again',
    enabled: true,
    why: health.canWait
      ? 'Re-reads the project’s files. If a sync is still running, this is the thing to try first.'
      : 'Re-reads the project’s files.',
  });

  out.push({
    id: 'rebuild',
    label: fixable.length
      ? `Rewrite ${fixable.length} file${fixable.length === 1 ? '' : 's'} from this session`
      : 'Rewrite files from this session',
    enabled: fixable.length > 0,
    why: fixable.length
      // "1 of the 1 affected file" is correct and unreadable. The comparison only earns
      // its place when some of them cannot be fixed.
      ? (fixable.length === broken.length
        ? `This session still holds the rows for ${broken.length === 1 ? 'it' : 'all of them'}, `
        : `This session still holds the rows for ${fixable.length} of the ${broken.length} `
          + 'affected files, ')
        + 'so they can be written back out of memory. Useful when a file was damaged or '
        + 'removed after the project was opened. On a synced folder the sync client may '
        + 'record this as a conflicting change.'
      : broken.length
        ? 'This project was opened without those files, so there is no copy of their rows in '
          + 'memory to write back. This only helps when a file went missing AFTER it was loaded.'
        : 'Nothing is missing or damaged.',
  });

  out.push({
    id: 'peer',
    label: 'Ask a collaborator for the missing files',
    enabled: live && broken.length > 0,
    why: live
      ? 'A live session is running, so a peer who holds these files can send them.'
      : 'Nobody else is connected. Go live from the sharing menu and a peer who has the '
        + 'files can supply them.',
  });

  out.push({
    id: 'discard',
    label: spareBytes ? `Delete the unexpected files (frees ${humanBytes(spareBytes)})` : 'Delete the unexpected files',
    enabled: (integrity?.unreferenced?.length ?? 0) > 0,
    why: (integrity?.unreferenced?.length ?? 0) > 0
      ? 'Only do this once you are sure nothing is still syncing. Until the index that '
        + 'explains them arrives, these files may be a collaborator’s only copy.'
      : 'There are no unexpected files in this project.',
  });

  return out;
}

/**
 * The project-health dialog: what is wrong, why it probably happened, and what can be
 * done about it.
 *
 * Every route is SHOWN, with the unavailable ones disabled and carrying their reason —
 * see {@link recoveryOptions}. A greyed "rewrite from this session" that explains it has
 * no copy in memory tells the user what state they are in; a hidden one tells them
 * nothing and reads as a feature that is broken.
 *
 * @returns {Promise<string|null>} the chosen action id
 */
export function showProjectHealth({ health, integrity, options }) {
  return new Promise((resolve) => {
    let chosen = null;
    const d = document.createElement('dialog');
    d.className = 'ct-dialog';
    const form = el('div', { class: 'ct-dialog__form' });
    form.append(el('h2', { class: 'ct-dialog__title', text: health.title }));
    form.append(el('p', { class: 'ct-dialog__hint', text: health.detail }));

    // The files themselves, because "2 files" is not actionable and a name is: it is
    // what you look for in the sync client's own progress list.
    const named = [
      ['Missing', integrity?.missing ?? []],
      ['Damaged', integrity?.unreadable ?? []],
      ['Unexpected', integrity?.unreferenced ?? []],
    ].filter(([, list]) => list.length);
    for (const [label, list] of named) {
      const box = el('div', { class: 'ct-health__files' });
      box.append(el('strong', { text: `${label} (${list.length})` }));
      const ul = el('ul');
      // Capped: a project with four hundred broken files needs the count and a sample,
      // not four hundred rows nobody will read.
      for (const f of list.slice(0, 8)) ul.append(el('li', { text: f }));
      if (list.length > 8) ul.append(el('li', { text: `…and ${list.length - 8} more` }));
      box.append(ul);
      form.append(box);
    }

    for (const opt of options) {
      const wrap = el('div', { class: 'ct-share__action' });
      wrap.append(el('p', { class: 'ct-dialog__hint', text: opt.why }));
      const b = el('button', { text: opt.label });
      b.type = 'button';
      b.disabled = !opt.enabled;
      b.addEventListener('click', () => { chosen = opt.id; d.close(); });
      wrap.append(b);
      form.append(wrap);
    }

    const menu = el('menu', { class: 'ct-dialog__buttons' });
    const close = el('button', { text: 'Close' });
    close.type = 'button';
    close.addEventListener('click', () => d.close());
    menu.append(close);
    form.append(menu);
    d.append(form);
    d.addEventListener('close', () => { d.remove(); resolve(chosen); });
    document.body.append(d);
    d.showModal();
  });
}
