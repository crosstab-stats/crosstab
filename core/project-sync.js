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

/** Bus event: the current project's name/binding changed (drives the sidebar header). */
export const PROJECT_CHANGED = 'project:changed';

export class ProjectSync {
  #store;
  #datasets;
  #ui;
  #menus;
  #bus;
  #results;
  #statusEl;
  /** () => string[]|null : load keys of the plugins active right now (persisted
   * with the project). Null ⇒ feature unavailable ⇒ don't record. */
  #getActivePlugins;
  /** (keys: string[]) => Promise : drive the active plugin set to a project's
   * saved list when opening it. */
  #applyActivePlugins;
  /** () => object : snapshot all plugin workspace blobs to persist with the
   * project (#93). Null ⇒ feature unavailable. */
  #getWorkspaces;
  /** (obj) => void : restore a project's workspace blobs on open. */
  #applyWorkspaces;
  /** () => object[] : snapshot the Output tab's result model (#103). */
  #getOutput;
  /** (model) => void : restore (or clear) the Output tab on open/switch. */
  #applyOutput;
  /** () => string[] : every installed plugin's identifiers (key + manifest id), so
   * a recorded plugin can be told apart from one this install simply doesn't have. */
  #pluginIdentities;
  /** Plugin identifiers recorded in the open project that AREN'T installed here —
   * carried forward verbatim on every save so the association survives until the
   * plugin is added and resolves (#102). Empty for a fully-resolved project. */
  #unresolvedPlugins = [];

  /** Current project: `{ id, name }` once saved/opened, else `null`. */
  #binding = null;
  /** Dataset ids whose Parquet sources changed since the last save. */
  #sourcesDirty = new Set();
  /** True while loading a project, to suppress autosave during reconstruction. */
  #loading = false;
  /** Once true, the first change with no project auto-starts an Untitled one. Set
   * after boot so the seed load doesn't spawn a project. */
  #armed = false;
  /** Guard against re-entrant auto-create from a burst of changes. */
  #creating = false;
  /** True if any change arrived *during* the initial auto-create (when there's no
   * binding yet to schedule against) — triggers a catch-up save once it's done, so
   * a rapid burst right after the first edit is never lost. */
  #changedWhileCreating = false;

  #timer = null;
  #saving = false;
  #dirtyAgain = false;
  /** Unsaved changes exist since the last successful save. Drives #settle so a
   * change made just before switching projects (e.g. toggling a plugin) is
   * flushed to the current binding rather than dropped. */
  #dirty = false;

  /**
   * @param {Object} deps
   * @param {import('./project-store.js').ProjectStore} deps.projectStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {{appendError: Function}} deps.results
   * @param {HTMLElement} deps.statusEl
   * @param {() => (string[]|null)} [deps.getActivePlugins] - Snapshot the active
   *   plugin keys to persist with the project (null ⇒ don't record).
   * @param {(keys: string[]) => Promise<void>} [deps.applyActivePlugins] - Restore
   *   a project's saved plugin set on open.
   */
  constructor({ projectStore, datasets, ui, menus, bus, results, statusEl, getActivePlugins, applyActivePlugins, getWorkspaces, applyWorkspaces, getOutput, applyOutput, pluginIdentities }) {
    this.#store = projectStore;
    this.#datasets = datasets;
    this.#ui = ui;
    this.#menus = menus;
    this.#bus = bus;
    this.#results = results;
    this.#statusEl = statusEl;
    this.#getActivePlugins = getActivePlugins ?? null;
    this.#applyActivePlugins = applyActivePlugins ?? null;
    this.#getWorkspaces = getWorkspaces ?? null;
    this.#applyWorkspaces = applyWorkspaces ?? null;
    this.#getOutput = getOutput ?? null;
    this.#applyOutput = applyOutput ?? null;
    this.#pluginIdentities = pluginIdentities ?? null;
  }

  /** The recorded plugin identifiers this install can't resolve to an installed
   * plugin (matched by key OR manifest id) — the ones to carry forward on save so
   * the association isn't lost (#102). */
  #computeUnresolved(recorded) {
    if (!Array.isArray(recorded) || !recorded.length) return [];
    const have = new Set(this.#pluginIdentities ? this.#pluginIdentities() : []);
    return recorded.filter((x) => x && !have.has(x));
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
    this.#bus.on(CoreEvents.PLUGINS_CHANGED, () => this.#onPluginsChanged());
    this.#bus.on(CoreEvents.WORKSPACE_CHANGED, () => this.#onChange(null));
    this.#bus.on('output:written', () => this.#onChange(null));
    this.#setStatus();
    this.#emitProject();
  }

  /** Broadcast the current project name so the sidebar header can show it. */
  #emitProject() {
    this.#bus.emit(PROJECT_CHANGED, { name: this.#binding?.name ?? null });
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
      this.#dirty = false;
      this.#setStatus('saved');
      this.#emitProject();
    } catch (err) {
      console.error('[project] save failed', err);
      this.#results.appendError(`Save project failed: ${err.message}`);
      this.#setStatus('error');
    }
  }

  // --- autosave -------------------------------------------------------------

  /** A plugin was enabled/disabled (or a set applied). Persist it — but only into
   * an *existing* project. A plugin toggle alone must not birth an Untitled project
   * (and the launcher applies sets before any binding exists), so unbound = ignore;
   * the set is captured by activeKeys() at the next real save / on open anyway. */
  #onPluginsChanged() {
    if (this.#loading || !this.#binding) return;
    this.#dirty = true;
    this.#schedule();
  }

  #onChange(summary) {
    if (this.#loading) return;
    this.#dirty = true;
    // A source-changing op means that dataset's Parquet must be rewritten. With the
    // universal log, undo/redo/rewind can also add or drop a source op, so they
    // mark sources dirty too (keeps the saved Parquet set in step with the log).
    if (summary && ['replace', 'append', 'join', 'restore', 'undo', 'redo', 'rewind'].includes(summary.reason)) {
      if (summary.datasetId != null) this.#sourcesDirty.add(summary.datasetId);
    }
    if (this.#binding) {
      this.#schedule();
      return;
    }
    // No project yet: the first real change auto-starts an autosaving "Untitled
    // project" so work is never lost. (Armed after boot, so the seed doesn't.)
    if (!this.#armed) return;
    if (this.#creating) {
      // A change landed mid-create — it can't schedule yet (no binding); remember
      // so #autoCreate does a catch-up save once the project exists.
      this.#changedWhileCreating = true;
      return;
    }
    this.#creating = true;
    void this.#autoCreate();
  }

  /** Enable auto-creating an Untitled project on the next change. Called once the
   * app has booted, so the demo-seed load doesn't spawn one. */
  arm() {
    this.#armed = true;
  }

  /**
   * Run a launcher data-seed load (Demo / Blank) without it counting as a user
   * change that auto-creates a project — the same exemption the boot seed gets by
   * load order. Without this, *re-opening* the launcher and picking a demo (which
   * happens after boot has armed auto-create) would spawn an "Untitled project"
   * from merely loading regenerable demo data, with no work done. The session is
   * left armed afterwards, so the user's first real change still autosaves — the
   * "everything you do is saved" promise is untouched; only loading throwaway demo
   * data is exempt.
   *
   * @param {() => Promise<void>} fn - performs the data load (newProject + load).
   */
  async loadingSeed(fn) {
    const prevArmed = this.#armed;
    this.#armed = false;
    try {
      return await fn();
    } finally {
      this.#armed = prevArmed;
    }
  }

  async #autoCreate() {
    try {
      await this.#fullSave(null, 'Untitled project');
    } finally {
      this.#creating = false;
    }
    // Catch up on any changes that arrived during creation: #fullSave snapshotted
    // (and cleared the dirty set) at an earlier point, so re-save the now-final
    // state in full. Loop in case more changes land during the catch-up.
    while (this.#changedWhileCreating && this.#binding) {
      this.#changedWhileCreating = false;
      await this.#fullSave(this.#binding.id, this.#binding.name);
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
      this.#dirty = false;
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

  /** Before switching projects: flush any unsaved change to the CURRENT binding,
   * then quiesce. Replaces a plain "cancel" — cancelling dropped a change made
   * just before the switch (e.g. a plugin toggle whose debounced save hadn't
   * fired). Safe against the mid-switch clobber a cancel guarded: it always writes
   * to the current binding's own id and awaits in-flight saves first, so by the
   * time the caller loads the next project nothing is pending or racing. */
  async #settle() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#dirtyAgain = false;
    // Let any in-flight autosave finish (it targets the current binding).
    while (this.#saving) await new Promise((r) => setTimeout(r, 20));
    if (this.#dirty && this.#binding) {
      const dirty = this.#sourcesDirty;
      this.#sourcesDirty = new Set();
      try {
        const bundle = await this.#snapshot(false, dirty);
        await this.#store.save(
          { id: this.#binding.id, name: this.#binding.name, savedAt: Date.now(), bundle },
          { writeSourcesFor: dirty },
        );
        this.#dirty = false;
      } catch (err) {
        console.error('[project] settle save failed', err);
      }
    }
    // A change could have landed during the awaits above — drop its timer so it
    // can't fire against the next project after the switch.
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#dirtyAgain = false;
  }

  /** Snapshot all open datasets. With `all`, every dataset's Parquet is included;
   * otherwise only those in `dirty` (the rest save metadata-only). */
  async #snapshot(all, dirty = new Set()) {
    const datasets = [];
    for (const ds of this.#datasets.all()) {
      const state = await ds.exportState({ includeParquet: all || dirty.has(ds.id) });
      datasets.push({ id: ds.id, name: ds.name, libraryLink: ds.libraryLink ?? null, state });
    }
    // Record the active plugin set alongside the data, so reopening restores the
    // analyses too. Null when the feature isn't wired (keeps old saves untouched).
    // Carry forward any recorded plugins this install can't resolve (not installed
    // here) so the association survives until the plugin is added (#102).
    let activePlugins = this.#getActivePlugins ? this.#getActivePlugins() : null;
    if (activePlugins && this.#unresolvedPlugins.length) {
      activePlugins = [...new Set([...activePlugins, ...this.#unresolvedPlugins])];
    }
    const workspaces = this.#getWorkspaces ? this.#getWorkspaces() : undefined;
    const output = this.#getOutput ? this.#getOutput() : undefined;
    return { activeId: this.#datasets.activeId, activePlugins, workspaces, output, datasets };
  }

  // --- new / open -----------------------------------------------------------

  /** Start a fresh project: one empty dataset, unbound. */
  async newProject() {
    await this.#settle();
    this.#loading = true;
    try {
      await this.#datasets.loadBundle({
        activeId: 1,
        datasets: [{ id: 1, name: 'Dataset 1', state: { sources: [], transforms: [] } }],
      });
      this.#applyWorkspaces?.({}); // a fresh project has no workspace state
      this.#applyOutput?.([]); // …and no output (clears stale output on switch)
    } finally {
      this.#loading = false;
    }
    this.#binding = null;
    this.#sourcesDirty.clear();
    this.#dirty = false;
    this.#unresolvedPlugins = []; // a fresh project carries no unresolved plugins
    this.#setStatus();
    this.#emitProject();
  }

  /**
   * Show the project browser, or open one directly by id.
   * @param {string} [id]
   * @param {{applyPlugins?: boolean}} [opts] - When opening by id, also restore the
   *   project's saved plugin set (default true). The launcher passes false: its
   *   picker has already applied the (possibly tweaked) selection.
   */
  async openProject(id, { applyPlugins = true } = {}) {
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
    await this.#settle();
    this.#setStatus('loading');
    this.#loading = true;
    let projName = null;
    try {
      const { name, bundle } = await this.#store.load(id);
      projName = name;
      await this.#datasets.loadBundle(bundle);
      // Restore plugin workspace blobs BEFORE plugins load, so a workspace's
      // mount() sees its saved state via state.get(). Absent ⇒ empty.
      this.#applyWorkspaces?.(bundle.workspaces || {});
      this.#applyOutput?.(bundle.output || []); // restore the Output tab (or clear)
      // Restore the project's analysis set (unless the caller already applied one,
      // e.g. the launcher). Only when the save recorded it — old saves leave the
      // current plugins as-is.
      if (applyPlugins && Array.isArray(bundle.activePlugins) && this.#applyActivePlugins) {
        try {
          await this.#applyActivePlugins(bundle.activePlugins);
        } catch (err) {
          console.warn('[project] restoring plugin set failed', err);
        }
      }
      // Remember any recorded plugins not installed here, so a later save doesn't
      // forget them (they reactivate once the plugin is added — #102).
      this.#unresolvedPlugins = this.#computeUnresolved(bundle.activePlugins);
      this.#binding = { id, name };
      this.#sourcesDirty.clear();
      this.#dirty = false;
      this.#setStatus('saved');
      this.#emitProject();
    } catch (err) {
      console.error('[project] load failed', err);
      this.#results.appendError(
        `Couldn't open ${projName ? `"${projName}"` : 'the project'} — its data may be damaged (${err.message}). ` +
          `Starting a fresh project instead; the damaged one is left untouched so you can delete or re-import it.`,
      );
      // The failed load left the dataset half-torn-down and the binding still
      // pointing at whatever was open before. Detach the binding and clear dirty
      // FIRST so the recovery can't autosave this broken state over any project,
      // then load a clean blank. (#loading is still true → no autosave fires.)
      this.#binding = null;
      this.#dirty = false;
      this.#sourcesDirty.clear();
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      try {
        await this.#datasets.loadBundle({
          activeId: 1,
          datasets: [{ id: 1, name: 'Dataset 1', state: { sources: [], transforms: [] } }],
        });
        this.#applyWorkspaces?.({});
        this.#applyOutput?.([]);
      } catch (e2) {
        console.error('[project] recovery load failed', e2);
      }
      this.#setStatus();
      this.#emitProject();
    } finally {
      this.#loading = false;
    }
  }

  /**
   * Open an external `.crosstab` bundle as a NEW project — never overwrites the
   * currently-open one (cancels its pending save, loads the bundle's datasets,
   * then saves a fresh project named per the bundle). Same clobber-safety as
   * {@link ProjectSync#openProject}.
   * @param {{name: string, bundle: object}} arg
   */
  async openBundle({ name, bundle }) {
    await this.#settle();
    this.#setStatus('loading');
    this.#loading = true;
    try {
      await this.#datasets.loadBundle(bundle);
    } catch (err) {
      this.#loading = false;
      this.#results.appendError(`Open bundle failed: ${err.message}`);
      this.#setStatus('error');
      throw err;
    }
    this.#applyWorkspaces?.(bundle.workspaces || {});
    this.#applyOutput?.(bundle.output || []);
    // Restore the bundle's recorded analysis set (#102), so opening a shared bundle
    // brings back the same analyses. applyActiveSet skips any the recipient doesn't
    // have (those are surfaced to the user by the import handler's warning dialog).
    if (Array.isArray(bundle.activePlugins) && this.#applyActivePlugins) {
      try {
        await this.#applyActivePlugins(bundle.activePlugins);
      } catch (err) {
        console.warn('[project] restoring bundle plugin set failed', err);
      }
    }
    // Carry forward bundle plugins not installed here (the import handler also warns
    // about them) so they're remembered, not dropped, on the project's first save.
    this.#unresolvedPlugins = this.#computeUnresolved(bundle.activePlugins);
    this.#loading = false;
    // It's a brand-new project; never bound to (and so never overwriting) the one
    // that was open. Persist + name it from the bundle.
    this.#binding = null;
    this.#sourcesDirty.clear();
    await this.#fullSave(null, name || 'Imported project');
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
      if (this.#binding?.id === id) {
        this.#binding = null;
        this.#setStatus();
        this.#emitProject();
      }
    } catch (err) {
      this.#results.appendError(`Delete failed: ${err.message}`);
    }
  }

  // --- sidebar surface -------------------------------------------------------

  /** Id of the current project, or null if unsaved. */
  get activeId() {
    return this.#binding?.id ?? null;
  }

  /** Name of the current project, or null if unsaved (e.g. for a report title). */
  get activeName() {
    return this.#binding?.name ?? null;
  }

  /** Summaries of all saved projects (for the sidebar's Projects zone). */
  listProjects() {
    return this.#store.list();
  }

  /** Rename the *active* project. If it has never been saved (no binding), this
   * names and saves it for the first time — so the sidebar's ✎ is always an inline
   * rename, never the Save modal, matching every other pencil in the sidebar. */
  async renameActive(name) {
    name = String(name).trim();
    if (!name) return;
    if (this.#binding) await this.renameProject(this.#binding.id, name);
    else await this.#fullSave(null, name);
  }

  /** Rename a project. The active project renames in place (and re-saves);
   * another project is renamed on disk. */
  async renameProject(id, name) {
    name = String(name).trim();
    if (!name) return;
    try {
      if (id === this.#binding?.id) {
        this.#binding.name = name;
        await this.#store.rename(id, name);
        this.#emitProject();
        this.#setStatus('saved');
      } else if (id) {
        await this.#store.rename(id, name);
        this.#emitProject(); // refresh the sidebar list
      }
    } catch (err) {
      this.#results.appendError(`Rename project failed: ${err.message}`);
    }
  }

  /** Delete a project. Deleting the active one drops you into a fresh Untitled
   * project (one empty dataset, autosaves on first edit). */
  async deleteProject(id) {
    const wasActive = id === this.#binding?.id;
    await this.#delete(id);
    if (wasActive) await this.newProject();
    else this.#emitProject(); // refresh the list
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
