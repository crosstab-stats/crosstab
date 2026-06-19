/**
 * @file library.js
 * The **building-block dataset library** — tier 2 of the two-tier model.
 *
 * A building block is a canonical, reusable dataset saved to OPFS
 * ({@link DatasetStore}): a cleaned GSS extract, a FRED series, a derived set.
 * Unlike a *project* (the living, autosaved working set — see
 * {@link ProjectSync}), the library is **explicit-save only**: you choose to
 * "Save dataset to library", and you "Add dataset from library" to pull a
 * **copy** into the current project. Because it's a copy, editing it in a project
 * never mutates the shared building block, and the project autosaves the copy.
 *
 * (There is intentionally no per-dataset autosave/binding here anymore — that
 * moved up to the project tier.)
 */

/** Bus event: the building-block library changed (block saved/deleted) — the
 * sidebar's Building Blocks zone re-renders on this. */
export const LIBRARY_CHANGED = 'library:changed';

export class DatasetLibrary {
  #store;
  #data;
  #ui;
  #menus;
  #results;
  #bus;

  /**
   * @param {Object} deps
   * @param {import('./dataset-store.js').DatasetStore} deps.datasetStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.data
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function, appendText: Function}} deps.results
   * @param {import('./event-bus.js').EventBus} deps.bus
   */
  constructor({ datasetStore, data, ui, menus, results, bus }) {
    this.#store = datasetStore;
    this.#data = data;
    this.#ui = ui;
    this.#menus = menus;
    this.#results = results;
    this.#bus = bus;
  }

  /** List building blocks (for the sidebar). */
  list() {
    return this.#store.list();
  }

  activate() {
    if (!this.#store.available) return; // no OPFS → no library
    this.#menus.register({
      id: 'core:lib-save',
      path: ['File'],
      label: 'Save dataset to library…',
      order: 20,
      command: () => void this.saveToLibrary(),
    });
    this.#menus.register({
      id: 'core:lib-add',
      path: ['File'],
      label: 'Add dataset from library…',
      order: 21,
      command: () => void this.addFromLibrary(),
    });
  }

  /** Save the active dataset to the building-block library. If it's the working
   * copy of an existing block (has a `libraryOrigin`), this UPDATES that block;
   * otherwise it creates a new one. Either way it's an explicit, intentional push
   * — no autosave to the library (the project owns autosave). */
  async saveToLibrary() {
    const ds = this.#data.active;
    if (!ds || ds.rowCount === 0) {
      this.#results.appendError('Save to library: no data is loaded.');
      return;
    }
    // Does this dataset already correspond to a still-existing block?
    let existing = null;
    if (ds.libraryLink) {
      try {
        existing = (await this.#store.list()).find((e) => e.id === ds.libraryLink.id) ?? null;
      } catch {
        existing = null;
      }
    }
    const form = await this.#ui.showForm({
      title: existing ? 'Update building block' : 'Save dataset to library',
      hint: existing
        ? `Update the existing building block “${existing.name}” (→ v${(existing.version || 1) + 1}).`
        : 'Make this dataset a reusable building block you can add to any project.',
      fields: [{ name: 'name', label: 'Name', value: existing?.name ?? ds.name }],
      okLabel: existing ? 'Update' : 'Save',
    });
    const name = form?.name?.trim();
    if (!name) return;
    try {
      const state = await ds.exportState({ includeParquet: true });
      const { id, version } = await this.#store.save(
        { id: existing?.id, name, savedAt: Date.now(), state },
        { writeSources: true },
      );
      // The whole current state is now the block, so there's no local overlay:
      // baseLen = all transforms.
      ds.libraryLink = { id, version, baseLen: (state.transforms || []).length };
      this.#bus?.emit(LIBRARY_CHANGED);
      this.#results.appendText(
        existing ? `Updated **${name}** in the library (v${version}).` : `Saved **${name}** to the library (v${version}).`,
      );
    } catch (err) {
      console.error('[library] save failed', err);
      this.#results.appendError(`Save to library failed: ${err.message}`);
    }
  }

  /**
   * Promote a dataset to a NEW building block (v1) and link the dataset to it —
   * the drag-to-Building-Blocks gesture. The dataset keeps its (cached) copy and
   * is now marked "linked to v1".
   *
   * @param {number} datasetId
   */
  async promoteToBlock(datasetId) {
    const ds = this.#data.get(datasetId);
    if (!ds || ds.rowCount === 0) return;
    try {
      const state = await ds.exportState({ includeParquet: true });
      const { id, version } = await this.#store.save(
        { name: ds.name, savedAt: Date.now(), state },
        { writeSources: true },
      );
      ds.libraryLink = { id, version, baseLen: (state.transforms || []).length };
      this.#bus?.emit(LIBRARY_CHANGED);
      this.#data.touch?.(); // refresh the sidebar's "linked" badge
      this.#results.appendText(`Promoted **${ds.name}** to a building block (v${version}).`);
    } catch (err) {
      console.error('[library] promote failed', err);
      this.#results.appendError(`Promote to building block failed: ${err.message}`);
    }
  }

  /** Add a copy of a building block into the current project, linked to its
   * current version. Public entry point for the sidebar / drag. */
  async addBlockToProject(id) {
    await this.#add(id);
  }

  /** Delete a building block from the library. */
  async deleteBlock(id) {
    await this.#delete(id);
  }

  /**
   * Pull a linked dataset up to its building block's latest version: fetch the
   * new block data and **re-apply the dataset's local transforms** (those it
   * added after linking) on top — the feature-3 propagation. The dataset opts in
   * (pull, not push); other linked projects update only when they choose.
   *
   * Best-effort reconciliation: a local transform that now references a missing
   * variable simply no-ops (everything stays saved + undoable). Local *source*
   * additions to a linked dataset are not preserved (the block's sources replace
   * them) — linked datasets are expected to diverge via transforms.
   *
   * @param {number} datasetId
   */
  async pullLatest(datasetId) {
    const ds = this.#data.get(datasetId);
    if (!ds?.libraryLink) return;
    const { id, baseLen = 0 } = ds.libraryLink;
    try {
      const loaded = await this.#store.load(id); // { name, version, state:{sources, transforms} }
      const cur = ds.getTransforms();
      const local = cur.slice(Math.min(baseLen, cur.length)); // edits made after linking
      const base = loaded.state.transforms || [];
      await ds.restoreState({ sources: loaded.state.sources, transforms: [...base, ...local] });
      ds.libraryLink = { id, version: loaded.version, baseLen: base.length };
      this.#data.touch?.();
      this.#results.appendText(
        `Pulled **${ds.name}** to v${loaded.version}` +
          (local.length ? ` (re-applied ${local.length} local change${local.length === 1 ? '' : 's'}).` : '.'),
      );
    } catch (err) {
      console.error('[library] pull failed', err);
      this.#results.appendError(`Pull update failed: ${err.message}`);
    }
  }

  /** Browse building blocks and add a copy of one into the current project. */
  async addFromLibrary() {
    let entries;
    try {
      entries = await this.#store.list();
    } catch (err) {
      this.#results.appendError(`Library failed: ${err.message}`);
      return;
    }
    this.#showBrowseModal(entries);
  }

  /** Add a copy of a building block into the current project (as a new active
   * dataset). */
  async #add(id) {
    try {
      const { name, version, state } = await this.#store.load(id);
      const ds = this.#data.add(name, { activate: true });
      await ds.restoreState(state);
      // Linked @ this version; the block's transforms are the base, no overlay yet.
      ds.libraryLink = { id, version, baseLen: (state.transforms || []).length };
      this.#data.touch?.(); // refresh the "linked" badge
    } catch (err) {
      console.error('[library] add failed', err);
      this.#results.appendError(`Add from library failed: ${err.message}`);
    }
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
      this.#bus?.emit(LIBRARY_CHANGED);
    } catch (err) {
      this.#results.appendError(`Delete failed: ${err.message}`);
    }
  }

  // --- browse modal ----------------------------------------------------------

  #showBrowseModal(entries) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = 'Add dataset from library';
    form.append(h2);

    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = 'No building blocks yet. Use File ▸ Save dataset to library.';
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
    meta.textContent = `${entry.rowCount.toLocaleString()} rows · ${entry.varCount} vars${
      entry.sourceCount > 1 ? ` · ${entry.sourceCount} sources` : ''
    }${when ? ` · ${when}` : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'ct-lib__actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ct-dialog__primary';
    add.textContent = 'Add';
    add.addEventListener('click', () => {
      dialog.close('cancel');
      void this.#add(entry.id);
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
    actions.append(add, del);
    li.append(info, actions);
    return li;
  }
}
