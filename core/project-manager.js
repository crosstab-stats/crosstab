/**
 * @file project-manager.js
 * One modal for every project verb (#173), replacing a File menu that grew by two items
 * per storage backend.
 *
 * ## Why a modal rather than more menu items
 *
 * The File menu carried 24 entries because every (verb x location) pair was its own line:
 * "Open from Dropbox…", "Move project to a folder…", and so on. Each new backend added
 * two more. Here **location is a dimension inside a verb** — the left rail — so adding
 * Graph or Drive puts one row in one list and changes nothing else.
 *
 * It also fixes a label that could not be correct. "Move project to Dropbox…" is a MOVE
 * when the source is local and a COPY when it is not, because a folder or cloud location
 * belongs to the user and its files are left in place. A menu label cannot know which. A
 * dialog can, and says so on its own button.
 *
 * ## Tabs
 *
 *  - **Recents** — the merged index, most-recently-opened first. Location is a detail on
 *    the row, not a section: a project is a project wherever it sits.
 *  - **Open** — the same index, grouped by where things live, plus "somewhere new".
 *  - **Store in** — where the OPEN project should live. This is the old "Move project
 *    to…" family, and the button says *Move here* or *Copy here* depending on whether the
 *    source is ours to remove.
 *  - **Manage** — rename, duplicate, close, and the destructive pair. Deliberately not in
 *    the sidebar, where delete sat one hover from the row that opens the thing.
 *
 * There is no **Save** tab, because there is no save: everything autosaves. What used to
 * be "Save project…" was naming (now rename) and what used to be "Save project as…" was
 * duplicating — a label that handed people a fork when they wanted a backup.
 */

import { debug } from './debug.js';

/** Tabs, in order. `verb` is what the tab does to the row you click. */
export const TABS = Object.freeze([
  { id: 'recents', label: 'Recents' },
  { id: 'open', label: 'Open' },
  { id: 'store', label: 'Store in' },
  { id: 'manage', label: 'Manage' },
]);

/**
 * What can be done to one row of the index, as data.
 *
 * Extracted so the rules are testable without a DOM: which verbs apply to a project is a
 * decision, and it is the kind that quietly rots when it lives inside a render function.
 *
 * @param {object} row  from `ProjectSync#listAllProjects`
 * @returns {Array<{id: string, label: string, danger?: boolean}>}
 */
export function projectActions(row) {
  const out = [];
  if (row.isOpen) {
    // The open project cannot be opened again, and must not be deleted from under itself.
    out.push({ id: 'close', label: 'Close' });
    if (row.kind === 'opfs') out.push({ id: 'rename', label: 'Rename' });
    return out;
  }
  out.push({ id: 'open', label: 'Open' });
  // Renaming a remembered location would rename the entry, not the project inside it —
  // two names for one thing, and the one you can see is the one that lies. The project's
  // own name is edited by opening it.
  if (row.kind === 'opfs') out.push({ id: 'rename', label: 'Rename' });
  out.push({ id: 'forget', label: row.kind === 'opfs' ? 'Delete…' : 'Remove…', danger: true });
  return out;
}

/**
 * What removing a row actually offers.
 *
 * Local storage is the app's own, so "remove" there can only mean delete. A folder or
 * cloud location is the user's: the entry can be dropped while the files stay, which is
 * usually what someone wants when tidying a list.
 *
 * The file-deleting checkbox defaults **off everywhere**, including local storage — the
 * owner's call, so that removing files is always an explicit affirmative act rather than
 * something that happens because a default was left alone.
 */
export function removalOffer(row) {
  // Local storage has no forget-but-keep: the list IS the storage, so a checkbox there
  // would do nothing when left unchecked — which is worse than no checkbox, because it
  // implies a choice that does not exist. The confirmation says plainly what will happen
  // instead.
  if (row.kind === 'opfs') {
    return {
      title: `Delete “${row.name}”?`,
      body: 'This project lives in this browser, so removing it from the list deletes it '
        + 'and its data. This cannot be undone.',
      fileLabel: null,
      fileDefault: false,
      confirmLabel: 'Delete',
    };
  }
  return {
    title: `Remove “${row.name}” from the list?`,
    body: 'The list entry goes; the files stay where they are unless you say otherwise. '
      + 'That location is yours rather than the app’s.',
    fileLabel: 'Also delete the project files there',
    // OFF everywhere, on the owner's call: removing files should be an affirmative act,
    // never something that happens because a default was left alone.
    fileDefault: false,
    confirmLabel: 'Remove',
  };
}

/** The button a "store in" destination should show, given where the project is now. */
export function storeVerb(currentKind) {
  // Moving OFF local storage removes the local copy, because it is ours to remove.
  // Moving off a folder or a cloud location leaves that copy in place, because it is not.
  return currentKind === 'opfs' || currentKind == null
    ? { label: 'Move here', note: 'The copy in this browser will be removed.' }
    : { label: 'Copy here', note: 'The current copy stays where it is and stops receiving changes.' };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * Open the project manager.
 *
 * @param {object} opts
 * @param {string} [opts.tab]  which tab to land on
 * @param {object} opts.projects  ProjectSync
 * @param {(entry: object) => object|null} opts.makeBackend
 * @param {Array<object>} opts.providers  where new locations come from — see app.js
 * @param {{appendText: Function, appendError: Function}} opts.results
 * @param {Array<{label: string, run: Function}>} [opts.exporters]
 * @returns {Promise<void>} resolves when the dialog closes
 */
export function openProjectManager({ tab = 'recents', projects, makeBackend, providers = [], results, exporters = [] }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide ctpm';
    const tabBar = el('div', 'ctpm__tabs');
    const body = el('div', 'ctpm__body');
    const close = el('button', 'ct-dialog__primary', 'Done');
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    // The shared containers, not hand-rolled equivalents. `.ct-dialog__form` carries the
    // padding every other dialog has — appending straight to the <dialog>, which is
    // `padding: 0`, left this one flush against its own border. And `.ct-dialog__buttons`
    // is what makes a primary button look primary: the accent colour and the sizing are
    // both defined as `.ct-dialog__buttons .ct-dialog__primary`, so outside that container
    // the class does nothing and you get a raw browser button, left-aligned.
    const shell = el('div', 'ct-dialog__form ctpm__shell');
    const footer = el('menu', 'ct-dialog__buttons ctpm__footer');
    footer.append(close);

    let active = TABS.some((t) => t.id === tab) ? tab : 'recents';

    /** Re-render the open tab. Every action ends here, so the list is never stale. */
    const render = async () => {
      tabBar.replaceChildren();
      for (const t of TABS) {
        const b = el('button', `ctpm__tab${t.id === active ? ' is-active' : ''}`, t.label);
        b.type = 'button';
        b.addEventListener('click', () => { active = t.id; void render(); });
        tabBar.append(b);
      }
      if (exporters.length) {
        const b = el('button', `ctpm__tab${active === 'export' ? ' is-active' : ''}`, 'Export');
        b.type = 'button';
        b.addEventListener('click', () => { active = 'export'; void render(); });
        tabBar.append(b);
      }
      body.replaceChildren(el('div', 'ctpm__loading', 'Loading…'));
      let rows = [];
      try {
        rows = await projects.listAllProjects();
      } catch (err) {
        debug('project', 'manager list failed', err);
      }
      body.replaceChildren();
      if (active === 'recents') renderList(rows, { verb: 'open' });
      else if (active === 'open') renderRail(rows, { mode: 'open' });
      else if (active === 'store') renderRail(rows, { mode: 'store' });
      else if (active === 'manage') renderList(rows, { verb: 'manage' });
      else renderExport();
    };

    /** Where a row lives, for the detail column. */
    const describeRow = (row) => (row.kind === 'opfs'
      ? { glyph: '', detail: 'This browser' }
      : (makeBackend?.(row.entry)?.describe() ?? { glyph: '📍', detail: 'cannot reconnect' }));

    const act = async (id, row) => {
      try {
        if (id === 'open') {
          dialog.close();
          if (row.kind === 'opfs') await projects.openProject(row.projectId);
          else {
            const backend = makeBackend?.(row.entry);
            if (backend) await projects.openLocation(backend);
            else results.appendError('That entry is missing what it needs to reconnect.');
          }
          return;
        }
        if (id === 'close') { dialog.close(); await projects.closeProject(); return; }
        if (id === 'rename') {
          const next = prompt('Rename project', row.name);
          if (next && next.trim()) await projects.renameProject(row.projectId, next.trim());
          await render();
          return;
        }
        if (id === 'forget') { await confirmRemoval(row); await render(); }
      } catch (err) {
        results.appendError(`That didn’t work: ${err.message}`);
      }
    };

    /** The destructive path, with its own dialog so the checkbox has somewhere to live. */
    const confirmRemoval = (row) => new Promise((done) => {
      const offer = removalOffer(row);
      const d = document.createElement('dialog');
      d.className = 'ct-dialog';
      d.innerHTML = `
        <form method="dialog" class="ct-dialog__form">
          <h2 class="ct-dialog__title"></h2>
          <p class="ct-dialog__hint"></p>
          ${offer.fileLabel ? '<p><label><input type="checkbox" name="files"> <span></span></label></p>' : ''}
          <menu class="ct-dialog__buttons">
            <button value="cancel" type="submit">Cancel</button>
            <button value="ok" type="submit" class="ct-dialog__primary"></button>
          </menu>
        </form>`;
      d.querySelector('.ct-dialog__title').textContent = offer.title;
      d.querySelector('.ct-dialog__hint').textContent = offer.body;
      d.querySelector('.ct-dialog__primary').textContent = offer.confirmLabel;
      if (offer.fileLabel) {
        d.querySelector('label span').textContent = offer.fileLabel;
        d.querySelector('[name=files]').checked = offer.fileDefault;
      }
      d.addEventListener('close', async () => {
        const alsoFiles = d.querySelector('[name=files]')?.checked;
        const go = d.returnValue === 'ok';
        d.remove();
        if (!go) { done(); return; }
        try {
          if (row.kind === 'opfs') {
            await projects.deleteProject(row.projectId);
          } else {
            if (alsoFiles) await projects.deleteRemoteFiles?.(makeBackend?.(row.entry));
            await projects.forgetFolderProject(row.locationId);
          }
        } catch (err) {
          results.appendError(`Could not remove that: ${err.message}`);
        }
        done();
      });
      document.body.append(d);
      d.showModal();
    });

    /** A flat list of projects — Recents and Manage differ only in which verbs show. */
    function renderList(rows, { verb }) {
      const list = el('div', 'ctpm__list');
      // The open project is SHOWN, marked, in every tab. Filtering it out made the list
      // look like it had forgotten the thing you are working on, and made rows jump
      // position depending on what happened to be open.
      const shown = verb === 'manage' ? rows : rows.slice(0, 8);
      if (!shown.length) {
        body.append(el('div', 'ctpm__empty', 'No projects yet. Open one, or start a new one.'));
        return;
      }
      for (const row of shown) {
        const what = describeRow(row);
        const item = el('div', `ctpm__row${row.isOpen ? ' is-open' : ''}`);
        const main = el('button', 'ctpm__rowmain');
        main.type = 'button';
        main.append(el('span', 'ctpm__name', `${what.glyph ? `${what.glyph} ` : ''}${row.name}`));
        main.append(el('span', 'ctpm__where', row.isOpen ? 'Open now' : what.detail));
        // Clicking the open project's NAME used to close it — a destructive-ish action on
        // the one target nobody aims at deliberately. The row is inert; Close is a button.
        if (row.isOpen) main.disabled = true;
        else main.addEventListener('click', () => void act('open', row));
        item.append(main);
        if (verb === 'manage') {
          const acts = el('div', 'ctpm__acts');
          for (const a of projectActions(row)) {
            const b = el('button', `ctpm__act${a.danger ? ' is-danger' : ''}`, a.label);
            b.type = 'button';
            b.addEventListener('click', () => void act(a.id, row));
            acts.append(b);
          }
          item.append(acts);
        }
        list.append(item);
      }
      body.append(list);
    }

    /** Open / Store in: providers down the left, their projects or destinations right. */
    function renderRail(rows, { mode }) {
      const wrap = el('div', 'ctpm__split');
      const rail = el('div', 'ctpm__rail');
      const pane = el('div', 'ctpm__pane');
      let chosen = providers[0]?.kind ?? 'opfs';

      const paint = () => {
        pane.replaceChildren();
        const provider = providers.find((p) => p.kind === chosen);
        if (!provider) return;
        if (mode === 'store') {
          const verb = storeVerb(projects.describeLocation?.()?.kind ?? 'opfs');
          pane.append(el('p', 'ctpm__hint', verb.note));
          const go = el('button', 'ct-dialog__primary', `${verb.label} — ${provider.label}`);
          go.type = 'button';
          go.addEventListener('click', async () => {
            const backend = await provider.chooseDestination?.();
            if (!backend) return;
            dialog.close();
            await projects.moveTo(backend);
          });
          pane.append(go);
          return;
        }
        // Open: this provider's known projects, then a way to reach a new one.
        const mine = rows.filter((r) => r.kind === provider.kind);
        for (const row of mine) {
          const b = el('button', 'ctpm__rowmain');
          b.type = 'button';
          b.append(el('span', 'ctpm__name', row.name));
          if (row.isOpen) {
            // Present but inert, for the same reason as the list: a complete picture beats
            // a shorter one, and there is nothing to do to the project you are in.
            b.append(el('span', 'ctpm__where', 'Open now'));
            b.disabled = true;
          } else {
            b.addEventListener('click', () => void act('open', row));
          }
          pane.append(b);
        }
        if (!mine.length) pane.append(el('p', 'ctpm__hint', `No projects known here yet.`));
        if (provider.chooseExisting) {
          const add = el('button', 'proj__add', provider.newLabel ?? 'Somewhere else…');
          add.type = 'button';
          add.addEventListener('click', async () => {
            const backend = await provider.chooseExisting();
            if (!backend) return;
            dialog.close();
            await projects.openLocation(backend);
          });
          pane.append(add);
        }
      };

      for (const p of providers) {
        const b = el('button', `ctpm__railitem${p.kind === chosen ? ' is-active' : ''}`, `${p.glyph} ${p.label}`);
        b.type = 'button';
        b.addEventListener('click', () => {
          chosen = p.kind;
          rail.querySelectorAll('.ctpm__railitem').forEach((x) => x.classList.toggle('is-active', x === b));
          paint();
        });
        rail.append(b);
      }
      wrap.append(rail, pane);
      body.append(wrap);
      paint();
    }

    function renderExport() {
      body.append(el('p', 'ctpm__hint',
        'Export writes a copy in another program’s format. It is one-way — an exported file '
        + 'cannot be reopened as a project. To move the project itself, use Store in.'));
      for (const x of exporters) {
        const b = el('button', 'proj__add', x.label);
        b.type = 'button';
        b.addEventListener('click', () => { dialog.close(); void x.run(); });
        body.append(b);
      }
    }

    shell.append(tabBar, body, footer);
    dialog.append(shell);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
    document.body.append(dialog);
    dialog.showModal();
    void render();
  });
}
