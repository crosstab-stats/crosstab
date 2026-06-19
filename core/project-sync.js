/**
 * @file project-sync.js
 * Ties the {@link ProjectStore} (OPFS) to the live {@link DatasetManager}: the
 * File-menu project commands, the current-project binding, and **autosave**.
 *
 * A project is a *living document*. Once it has a name (first save), every change
 * to any open dataset — a transform, an appended/joined source, a derived dataset,
 * a dataset added/removed, the active switch — schedules a debounced save of the
 * whole project. Autosave is cheap: only datasets whose *sources* changed get
 * their Parquet rewritten (tracked in `#sourcesDirty`); everything else just
 * updates `project.json` (see {@link ProjectStore#save} `writeSourcesFor`).
 *
 * Because the project holds independent copies of its datasets, autosaving them
 * is safe — it never touches the shared building-block library.
 */

import { CoreEvents } from './event-bus.js';
import { DATASETS_CHANGED } from './dataset-manager.js';

const DEBOUNCE_MS = 800;

export class ProjectSync {
  #store;
  #datasets;
  #ui;
  #menus;
  #bus;
  #results;
  #statusEl;

  /** Current project: `{ id, name }` once saved/opened, else `null`. */
  #binding = null;
  /** Dataset ids whose Parquet sources changed since the last save. */
  #sourcesDirty = new Set();
  /** True while loading a project, to suppress autosave during reconstruction. */
  #loading = false;

  #timer = null;
  #saving = false;
  #dirtyAgain = false;

  /**
   * @param {Object} deps
   * @param {import('./project-store.js').ProjectStore} deps.projectStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {{appendError: Function}} deps.results
   * @param {HTMLElement} deps.statusEl
   */
  constructor({ projectStore, datasets, ui, menus, bus, results, statusEl }) {
    this.#store = projectStore;
    this.#datasets = datasets;
    this.#ui = ui;
    this.#menus = menus;
    this.#bus = bus;
    this.#results = results;
    this.#statusEl = statusEl;
  }

  activate() {
    if (!this.#store.available) {
      this.#setStatus('Projects unavailable (no OPFS)');
      return;
    }
    this.#menus.register({ id: 'core:proj-new', path: ['File'], label: 'New project', order: 1, command: () => void this.newProject() });
    this.#menus.register({ id: 'core:proj-open', path: ['File'], label: 'Open project…', order: 2, command: () => void this.openProject() });
    this.#menus.register({ id: 'core:proj-save', path: ['File'], label: 'Save project…', order: 3, command: () => void this.saveInteractive() });
    this.#menus.register({ id: 'core:proj-saveas', path: ['File'], label: 'Save project as…', order: 4, command: () => void this.saveAs() });
    this.#bus.on(CoreEvents.DATA_CHANGED, (s) => this.#onChange(s));
    this.#bus.on(DATASETS_CHANGED, () => this.#onChange(null));
    this.#setStatus();
  }

  // --- save -----------------------------------------------------------------

  /** "Save project…": prompt for a name if unsaved, else force a full save. */
  async saveInteractive() {
    if (this.#binding) {
      await this.#fullSave(this.#binding.id, this.#binding.name);
      return;
    }
    const name = await this.#promptName('Save project', 'My project');
    if (name) await this.#fullSave(null, name);
  }

  /** "Save project as…": always a new project entry, bound to the copy. */
  async saveAs() {
    const base = this.#binding?.name ? `${this.#binding.name} copy` : 'My project';
    const name = await this.#promptName('Save project as', base);
    if (name) await this.#fullSave(null, name);
  }

  /** Write the whole project (all datasets' sources + logs) and (re)bind. */
  async #fullSave(id, name) {
    this.#setStatus('saving', name);
    try {
      const bundle = await this.#snapshot(true); // all sources
      const savedId = await this.#store.save({ id, name, savedAt: Date.now(), bundle });
      this.#binding = { id: savedId, name };
      this.#sourcesDirty.clear();
      this.#setStatus('saved');
    } catch (err) {
      console.error('[project] save failed', err);
      this.#results.appendError(`Save project failed: ${err.message}`);
      this.#setStatus('error');
    }
  }

  // --- autosave -------------------------------------------------------------

  #onChange(summary) {
    if (this.#loading) return;
    // A source-changing edit means that dataset's Parquet must be rewritten.
    if (summary && ['replace', 'append', 'join', 'restore'].includes(summary.reason)) {
      if (summary.datasetId != null) this.#sourcesDirty.add(summary.datasetId);
    }
    if (this.#binding) this.#schedule();
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
      this.#dirtyAgain = true;
      return;
    }
    this.#saving = true;
    const dirty = this.#sourcesDirty;
    this.#sourcesDirty = new Set();
    try {
      const bundle = await this.#snapshot(false, dirty);
      await this.#store.save(
        { id: this.#binding.id, name: this.#binding.name, savedAt: Date.now(), bundle },
        { writeSourcesFor: dirty },
      );
      this.#setStatus('saved');
    } catch (err) {
      console.error('[project] autosave failed', err);
      // Keep the dirty set so the next attempt re-tries those sources.
      for (const id of dirty) this.#sourcesDirty.add(id);
      this.#setStatus('error');
    } finally {
      this.#saving = false;
    }
    if (this.#dirtyAgain) {
      this.#dirtyAgain = false;
      this.#schedule();
    }
  }

  /** Snapshot all open datasets. With `all`, every dataset's Parquet is included;
   * otherwise only those in `dirty` (the rest save metadata-only). */
  async #snapshot(all, dirty = new Set()) {
    const datasets = [];
    for (const ds of this.#datasets.all()) {
      const state = await ds.exportState({ includeParquet: all || dirty.has(ds.id) });
      datasets.push({ id: ds.id, name: ds.name, state });
    }
    return { activeId: this.#datasets.activeId, datasets };
  }

  // --- new / open -----------------------------------------------------------

  /** Start a fresh project: one empty dataset, unbound. */
  async newProject() {
    this.#loading = true;
    try {
      await this.#datasets.loadBundle({
        activeId: 1,
        datasets: [{ id: 1, name: 'Dataset 1', state: { sources: [], transforms: [] } }],
      });
    } finally {
      this.#loading = false;
    }
    this.#binding = null;
    this.#sourcesDirty.clear();
    this.#setStatus();
  }

  /** Show the project browser, or open one directly by id. */
  async openProject(id) {
    if (id == null) {
      let entries;
      try {
        entries = await this.#store.list();
      } catch (err) {
        this.#results.appendError(`Open project failed: ${err.message}`);
        return;
      }
      this.#showBrowseModal(entries);
      return;
    }
    this.#setStatus('loading');
    this.#loading = true;
    try {
      const { name, bundle } = await this.#store.load(id);
      await this.#datasets.loadBundle(bundle);
      this.#binding = { id, name };
      this.#sourcesDirty.clear();
      this.#setStatus('saved');
    } catch (err) {
      console.error('[project] load failed', err);
      this.#results.appendError(`Open project failed: ${err.message}`);
      this.#setStatus('error');
    } finally {
      this.#loading = false;
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

  async #promptName(title, suggested) {
    const form = await this.#ui.showForm({
      title,
      fields: [{ name: 'name', label: 'Project name', value: suggested }],
      okLabel: 'Save',
    });
    return form?.name?.trim() || null;
  }

  #showBrowseModal(entries) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = 'Open project';
    form.append(h2);

    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = 'No saved projects yet. Use File ▸ Save project.';
      form.append(p);
    } else {
      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars ct-lib__list';
      for (const e of entries) list.append(this.#entryRow(e, dialog));
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
    meta.textContent = `${entry.datasetCount} dataset${entry.datasetCount === 1 ? '' : 's'}${when ? ` · ${when}` : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'ct-lib__actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ct-dialog__primary';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      dialog.close('cancel');
      void this.openProject(entry.id);
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

  #setStatus(state, nameOverride) {
    if (!this.#statusEl) return;
    const name = nameOverride ?? this.#binding?.name;
    let text;
    if (state === 'saving') text = `Project: ${name ?? '…'} — saving…`;
    else if (state === 'loading') text = 'Project: loading…';
    else if (state === 'error') text = `Project: ${name ?? ''} — save failed`;
    else if (this.#binding) text = `Project: ${this.#binding.name} — saved ✓`;
    else if (typeof state === 'string' && state !== 'saved') text = state;
    else text = 'Unsaved project';
    this.#statusEl.textContent = text;
  }
}
