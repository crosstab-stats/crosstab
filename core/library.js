/**
 * @file library.js
 * Ties the dataset library ({@link DatasetStore}, OPFS) to the live engine: the
 * File-menu commands, the browse modal, the session→entry binding, and autosave.
 *
 * ## The "living document" model
 * Saving a dataset **binds** the session to that library entry. From then on it
 * autosaves: any change that reaches the transform log (an edit, an undo/redo, an
 * appended file) schedules a debounced save, so there is never "unsaved work"
 * after the first save. This is cheap because sources are immutable — a metadata
 * edit rewrites only the small `manifest.json` + catalog, not the Parquet
 * sources (`writeSources:false`); only an appended source writes new bytes.
 *
 * Loading entirely different data (an import `replace`) **unbinds** — that's a new
 * project, not an edit to the loaded one — until you save it. A `restore` (loading
 * from the library) is already saved, so it doesn't trigger an autosave.
 *
 * Host UI, not a plugin: OPFS is origin-scoped (a sandboxed plugin can't reach
 * the host's), and the browse modal needs host DOM — same rationale as the data
 * grid and the variable editor.
 */

import { CoreEvents } from './event-bus.js';

const DEBOUNCE_MS = 750;

export class LibrarySync {
  #store;
  #data;
  #ui;
  #menus;
  #bus;
  #results;
  #statusEl;

  /** Current binding: `{ id, name }` once saved/loaded, else `null`. */
  #binding = null;

  // Autosave bookkeeping.
  #timer = null;
  #saving = false;
  #dirtyAgain = false;
  #pendingWriteSources = false;

  /**
   * @param {Object} deps
   * @param {import('./dataset-store.js').DatasetStore} deps.datasetStore
   * @param {import('./data-store.js').DataStore} deps.data
   * @param {import('./ui-service.js').UiService} deps.ui - For name prompts (`showForm`).
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   * @param {HTMLElement} deps.statusEl - Footer span for the library status.
   */
  constructor({ datasetStore, data, ui, menus, bus, results, statusEl }) {
    this.#store = datasetStore;
    this.#data = data;
    this.#ui = ui;
    this.#menus = menus;
    this.#bus = bus;
    this.#results = results;
    this.#statusEl = statusEl;
  }

  /** Register the File-menu items, wire autosave, and paint the initial status. */
  activate() {
    if (!this.#store.available) {
      this.#setStatus('Library unavailable (no OPFS)');
      return;
    }
    this.#menus.register({
      id: 'core:lib-save',
      path: ['File'],
      label: 'Save to library…',
      order: 60,
      command: () => void this.saveInteractive(),
    });
    this.#menus.register({
      id: 'core:lib-copy',
      path: ['File'],
      label: 'Save as copy…',
      order: 61,
      command: () => void this.saveAsCopy(),
    });
    this.#menus.register({
      id: 'core:lib-open',
      path: ['File'],
      label: 'Open library…',
      order: 62,
      command: () => void this.openLibrary(),
    });
    this.#bus.on(CoreEvents.DATA_CHANGED, (s) => this.#onDataChanged(s));
    this.#setStatus();
  }

  // --- save -----------------------------------------------------------------

  /** "Save to library…": if unbound, prompt for a name and create the entry; if
   * already bound, just force an immediate (full) save. */
  async saveInteractive() {
    if (this.#binding) {
      await this.#fullSave(this.#binding.id, this.#binding.name);
      return;
    }
    const name = await this.#promptName('Save to library', await this.#suggestName());
    if (name) await this.#fullSave(null, name);
  }

  /** "Save as copy…": always create a new named entry and bind to the copy. */
  async saveAsCopy() {
    const base = this.#binding?.name ? `${this.#binding.name} copy` : await this.#suggestName();
    const name = await this.#promptName('Save as copy', base);
    if (name) await this.#fullSave(null, name);
  }

  /** Write the whole dataset (sources + log) and (re)bind to the entry. */
  async #fullSave(id, name) {
    if (this.#data.rowCount === 0) {
      this.#results.appendError('Save to library: no data is loaded.');
      return;
    }
    this.#setStatus('saving', name);
    try {
      const state = await this.#data.exportState({ includeParquet: true });
      const savedId = await this.#store.save(
        { id, name, savedAt: Date.now(), state },
        { writeSources: true },
      );
      this.#binding = { id: savedId, name };
      this.#setStatus('saved');
    } catch (err) {
      console.error('[library] save failed', err);
      this.#results.appendError(`Save to library failed: ${err.message}`);
      this.#setStatus('error');
    }
  }

  // --- autosave -------------------------------------------------------------

  #onDataChanged(summary) {
    const reason = summary?.reason;
    if (reason === 'replace') {
      // Different data loaded — this is no longer the saved project.
      if (this.#binding) {
        this.#binding = null;
        this.#setStatus();
      }
      return;
    }
    if (reason === 'restore' || !this.#binding) return;
    if (['transform', 'append', 'undo', 'redo'].includes(reason)) {
      // An appended file adds a new immutable source, so its bytes must be written;
      // metadata-only edits can reuse the existing Parquet (cheap path).
      if (reason === 'append') this.#pendingWriteSources = true;
      this.#schedule();
    }
  }

  #schedule() {
    this.#setStatus('saving');
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#flush(), DEBOUNCE_MS);
  }

  async #flush() {
    this.#timer = null;
    if (!this.#binding) return;
    if (this.#saving) {
      this.#dirtyAgain = true; // coalesce: re-run after the in-flight save
      return;
    }
    this.#saving = true;
    const writeSources = this.#pendingWriteSources;
    this.#pendingWriteSources = false;
    try {
      const state = await this.#data.exportState({ includeParquet: writeSources });
      await this.#store.save(
        { id: this.#binding.id, name: this.#binding.name, savedAt: Date.now(), state },
        { writeSources },
      );
      this.#setStatus('saved');
    } catch (err) {
      console.error('[library] autosave failed', err);
      this.#setStatus('error');
    } finally {
      this.#saving = false;
    }
    if (this.#dirtyAgain) {
      this.#dirtyAgain = false;
      this.#schedule();
    }
  }

  // --- open / browse --------------------------------------------------------

  /** Show the library modal: a list of saved datasets to open or delete. */
  async openLibrary() {
    let entries;
    try {
      entries = await this.#store.list();
    } catch (err) {
      this.#results.appendError(`Open library failed: ${err.message}`);
      return;
    }
    this.#showBrowseModal(entries);
  }

  /** Load an entry into the live engine and bind to it. */
  async #open(id) {
    this.#setStatus('loading');
    try {
      const { name, state } = await this.#store.load(id);
      await this.#data.restoreState(state);
      this.#binding = { id, name };
      this.#setStatus('saved');
    } catch (err) {
      console.error('[library] load failed', err);
      this.#results.appendError(`Open from library failed: ${err.message}`);
      this.#setStatus('error');
    }
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
      if (this.#binding?.id === id) {
        this.#binding = null;
        this.#setStatus();
      }
    } catch (err) {
      this.#results.appendError(`Delete failed: ${err.message}`);
    }
  }

  // --- UI helpers -----------------------------------------------------------

  /** A best-effort default name from the first source's provenance label. */
  async #suggestName() {
    try {
      const peek = await this.#data.exportState({ includeParquet: false });
      return peek.sources[0]?.label || 'Untitled dataset';
    } catch {
      return 'Untitled dataset';
    }
  }

  /** Prompt for an entry name; resolve to the trimmed name or null. */
  async #promptName(title, suggested) {
    const form = await this.#ui.showForm({
      title,
      fields: [{ name: 'name', label: 'Name', value: suggested }],
      okLabel: 'Save',
    });
    const name = form?.name?.trim();
    return name || null;
  }

  /** Build and show the browse modal (built with DOM nodes — names are user text). */
  #showBrowseModal(entries) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';

    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = 'Library';
    form.append(h2);

    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = 'No saved datasets yet. Use File ▸ Save to library.';
      form.append(p);
    } else {
      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars ct-lib__list';
      for (const e of entries) {
        list.append(this.#entryRow(e, dialog));
      }
      form.append(list);
    }

    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const close = document.createElement('button');
    close.type = 'submit';
    close.value = 'cancel';
    close.textContent = 'Close';
    menu.append(close);
    form.append(menu);

    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  /** One library entry row: name + summary, with Open and Delete actions. */
  #entryRow(entry, dialog) {
    const li = document.createElement('li');
    li.className = 'ct-lib__row';

    const info = document.createElement('div');
    info.className = 'ct-lib__info';
    const name = document.createElement('div');
    name.className = 'ct-lib__name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'ct-lib__meta';
    const when = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : '';
    meta.textContent = `${entry.rowCount.toLocaleString()} rows · ${entry.varCount} vars${
      entry.sourceCount > 1 ? ` · ${entry.sourceCount} sources` : ''
    }${when ? ` · ${when}` : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'ct-lib__actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ct-dialog__primary';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      dialog.close('cancel');
      void this.#open(entry.id);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ct-lib__delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      del.disabled = true;
      await this.#delete(entry.id);
      li.remove();
    });
    actions.append(open, del);

    li.append(info, actions);
    return li;
  }

  /**
   * Paint the footer status. With no argument, reflects the current binding.
   * @param {'saving'|'saved'|'loading'|'error'|string} [state]
   * @param {string} [nameOverride]
   */
  #setStatus(state, nameOverride) {
    if (!this.#statusEl) return;
    const name = nameOverride ?? this.#binding?.name;
    let text;
    if (state === 'saving') text = `Library: ${name ?? '…'} — saving…`;
    else if (state === 'loading') text = 'Library: loading…';
    else if (state === 'error') text = `Library: ${name ?? ''} — save failed`;
    else if (this.#binding) text = `Library: ${this.#binding.name} — saved ✓`;
    else if (typeof state === 'string' && !['saved'].includes(state)) text = state;
    else text = 'Not saved to library';
    this.#statusEl.textContent = text;
  }
}
