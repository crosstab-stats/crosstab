/**
 * @file encryption-settings.js
 * The one dialog for at-rest encryption (#144, #181) — two tabs, two scopes.
 *
 * ## Why one dialog with tabs
 *
 * This used to be four File items: `Protect this project…`, `Change passphrase…`,
 * `Remove protection…` and `Encryption settings…`. Three of those are verbs on the OPEN
 * project and the fourth is an app-wide default, so the menu carried four lines
 * describing one subject — the same (verb × thing) multiplication #173 removed from the
 * project verbs. The tell was in the code: each verb opened with a guard whose entire
 * job was to say the state was wrong ("This project is already protected."). A guard
 * that only neutralises a state means the state should not be reachable, so the tab
 * reads the state and offers only the verbs that apply.
 *
 * The seam was already visible from the other side, too: this dialog used to end by
 * telling the reader to go and use **File ▸ Protect this project…** — a settings dialog
 * that had to send you back to the menu. That pointer is now a tab.
 *
 * It is deliberately NOT a tab on the project manager. The manager is where you open,
 * move, export and delete projects *including* this one; these act on this one project
 * only. The variant that would have justified a tab — every project listed with its own
 * encryption controls — is also close to unbuildable: protecting re-encrypts through the
 * ACTIVE store, so a list would have to open (and unlock) each project first.
 *
 * ## The two tabs are two scopes, and must not look interchangeable
 *
 * **This project** acts now, on the open project. **New projects** changes a default for
 * projects that do not exist yet and touches nothing already saved. They are named by
 * scope for that reason, and the defaults tab says outright what it does not do: the
 * failure to design out is someone flipping a default believing they have just protected
 * the project in front of them.
 *
 * The honest framing matters throughout: OPFS encryption protects a project's data at
 * rest on this device (against another account, an infostealer reading the profile, a
 * lost laptop) — but NOT a project that is open in an unlocked session, and a forgotten
 * passphrase is unrecoverable. Both tabs say so.
 */

import { getEncryptionPolicy, setEncryptionPolicy } from './at-rest.js';

/** Tabs, in order. The project is first because it is what a reader came to change. */
export const ENC_TABS = Object.freeze([
  { id: 'project', label: 'This project' },
  { id: 'defaults', label: 'New projects' },
]);

/**
 * What the project tab offers, given the open project's encryption state.
 *
 * Extracted as data so the rule is testable without a DOM — the same reason
 * `project-manager.js` extracted `projectActions`. An over-generous action list looks
 * exactly like a correct one until someone clicks it.
 *
 * @param {{scope: 'none'|'unsaved'|'local'|'folder', name?: string, protected?: boolean}|null} state
 * @returns {{status: string, detail: string, actions: Array<{id: string, label: string, danger?: boolean}>}}
 */
export function projectEncryptionOffer(state) {
  // Two states where there is nothing to act on. #158 made "no project open" a real
  // state rather than a faked blank project, and an open project with nothing in it has
  // never been saved, so there are no bytes to encrypt. Both are shown, not guarded.
  if (!state || state.scope === 'none') {
    return {
      status: 'No project is open.',
      detail: 'Open or start a project first — protection applies to a project’s stored data.',
      actions: [],
    };
  }
  if (state.scope === 'unsaved') {
    return {
      status: 'Nothing saved yet.',
      detail: 'Add some data first — an empty project has nothing to protect yet.',
      actions: [],
    };
  }
  const where = state.scope === 'folder'
    ? 'This project lives in a folder, so its passphrase is shared by everyone who opens that folder.'
    : 'This project is stored in this browser, so its passphrase protects it on this device.';
  if (state.protected) {
    return {
      status: `🔒 “${state.name}” is protected.`,
      detail: where,
      actions: [
        { id: 'change', label: 'Change passphrase…' },
        { id: 'remove', label: 'Remove protection…', danger: true },
      ],
    };
  }
  return {
    status: `🔓 “${state.name}” is not protected.`,
    detail: where,
    actions: [{ id: 'protect', label: 'Set a passphrase…' }],
  };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Show the encryption dialog.
 *
 * @param {object} [opts]
 * @param {object} [opts.projects] - ProjectSync: supplies `protectionState()` and the
 *   three verbs. Omitted (or absent state) and the project tab says so rather than
 *   pretending; the defaults tab still works, which is why it becomes the landing tab.
 * @param {string} [opts.tab] - which tab to land on; ignored when there is no project
 *   to act on, since landing on an empty tab is a worse first impression than landing
 *   on the one that works.
 * @returns {Promise<void>} resolves when the dialog closes
 */
export async function showEncryptionSettings({ projects = null, tab = 'project' } = {}) {
  let state = null;
  try {
    state = (await projects?.protectionState?.()) ?? null;
  } catch {
    state = null; // unreadable state reads as "nothing to act on", not as a crash
  }
  const actionable = !!state && state.scope !== 'none' && state.scope !== 'unsaved';
  let active = ENC_TABS.some((t) => t.id === tab) ? tab : 'project';
  if (!actionable) active = 'defaults';

  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-encset';
    const shell = el('div', 'ct-dialog__form');
    const tabBar = el('div', 'ctpm__tabs');
    const body = el('div', 'ct-encset__body');
    const footer = el('menu', 'ct-dialog__buttons');
    const done = el('button', 'ct-dialog__primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => dialog.close());
    footer.append(done);

    /** Run a project verb: close first, because each one prompts and reports for itself. */
    const run = (fn) => {
      dialog.close();
      void fn?.call(projects);
    };

    const renderProject = () => {
      const offer = projectEncryptionOffer(state);
      body.append(el('p', 'ct-encset__status', offer.status));
      body.append(el('p', 'ct-encset__sub', offer.detail));
      if (offer.actions.length) {
        const row = el('div', 'ct-encset__actions');
        for (const a of offer.actions) {
          const b = el('button', `proj__add${a.danger ? ' is-danger' : ''}`, a.label);
          b.type = 'button';
          b.addEventListener('click', () => {
            if (a.id === 'protect') run(projects.protectProject);
            else if (a.id === 'change') run(projects.changePassphrase);
            else if (a.id === 'remove') run(projects.unprotectProject);
          });
          row.append(b);
        }
        body.append(row);
      }
      body.append(el('p', 'ct-dialog__warning ct-encset__warn',
        '⚠ No recovery: a forgotten passphrase can’t be reset by anyone, and the project can’t be '
        + 'opened without it. Protection covers data at rest — it does not protect a project while '
        + 'it’s open in an unlocked session.'));
    };

    const renderDefaults = () => {
      const policy = getEncryptionPolicy();
      const label = el('label', 'ct-encset__row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'ct-encset__local';
      box.checked = !!policy.local;
      // Persist immediately on toggle — no separate save button for a single switch.
      box.addEventListener('change', () => setEncryptionPolicy({ local: box.checked }));
      const text = el('span');
      text.append(
        el('span', 'ct-encset__label', 'Encrypt new projects on this device by default'),
        el('span', 'ct-encset__sub',
          'When on, each new project asks you to set its own passphrase. The data is then stored '
          + 'encrypted in this browser. You’ll need the passphrase to open it.'),
      );
      label.append(box, text);
      body.append(label);
      // The scope disclaimer is the load-bearing sentence on this tab: it is the one
      // thing that stops the switch reading as "protect what I am looking at".
      body.append(el('p', 'ct-encset__scope',
        'This changes what happens to projects you make from now on. It does not protect, '
        + 'unprotect or alter any project that already exists — for those, use the “This project” tab.'));
      body.append(el('p', 'ct-encset__note',
        'Files you export and projects you move to a folder are encrypted by default already — you '
        + 'choose per file/folder whether to set a passphrase or leave it unprotected at that moment.'));
    };

    const render = () => {
      tabBar.replaceChildren();
      for (const t of ENC_TABS) {
        const b = el('button', `ctpm__tab${t.id === active ? ' is-active' : ''}`, t.label);
        b.type = 'button';
        b.addEventListener('click', () => { active = t.id; render(); });
        tabBar.append(b);
      }
      body.replaceChildren();
      if (active === 'project') renderProject();
      else renderDefaults();
    };

    shell.append(el('h2', 'ct-dialog__title', 'Encryption settings'), tabBar, body, footer);
    injectStyles();
    dialog.append(shell);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
    document.body.append(dialog);
    render();
    dialog.showModal();
  });
}

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
    .ct-encset__body { min-height: 9rem; }
    .ct-encset__row { display: flex; gap: .6rem; align-items: flex-start; margin: .4rem 0 .8rem; cursor: pointer; }
    .ct-encset__row input { margin-top: .2rem; }
    .ct-encset__label { display: block; font-weight: 600; }
    .ct-encset__sub { display: block; font-size: .85em; opacity: .8; margin-top: .15rem; }
    .ct-encset__status { font-weight: 600; margin: .2rem 0 .1rem; }
    .ct-encset__actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: .8rem 0; }
    .ct-encset__actions .is-danger { color: var(--ct-danger, #b3261e); }
    .ct-encset__scope, .ct-encset__note { font-size: .85em; opacity: .8; }
    .ct-encset__warn { margin-top: .9rem; }
  `;
  document.head.append(s);
}
