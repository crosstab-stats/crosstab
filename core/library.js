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

export class DatasetLibrary {
  #store;
  #data;
  #ui;
  #menus;
  #results;

  /**
   * @param {Object} deps
   * @param {import('./dataset-store.js').DatasetStore} deps.datasetStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.data
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {{appendError: Function, appendText: Function}} deps.results
   */
  constructor({ datasetStore, data, ui, menus, results }) {
    this.#store = datasetStore;
    this.#data = data;
    this.#ui = ui;
    this.#menus = menus;
    this.#results = results;
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

  /** Save the active dataset as a new reusable building block (a one-shot copy —
   * no binding; the project keeps autosaving the working copy). */
  async saveToLibrary() {
    const ds = this.#data.active;
    if (!ds || ds.rowCount === 0) {
      this.#results.appendError('Save to library: no data is loaded.');
      return;
    }
    const form = await this.#ui.showForm({
      title: 'Save dataset to library',
      hint: 'Make this dataset a reusable building block you can add to any project.',
      fields: [{ name: 'name', label: 'Name', value: ds.name }],
      okLabel: 'Save',
    });
    const name = form?.name?.trim();
    if (!name) return;
    try {
      const state = await ds.exportState({ includeParquet: true });
      await this.#store.save({ name, savedAt: Date.now(), state }, { writeSources: true });
      this.#results.appendText(`Saved **${name}** to the dataset library.`);
    } catch (err) {
      console.error('[library] save failed', err);
      this.#results.appendError(`Save to library failed: ${err.message}`);
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
      const { name, state } = await this.#store.load(id);
      const ds = this.#data.add(name, { activate: true });
      await ds.restoreState(state);
    } catch (err) {
      console.error('[library] add failed', err);
      this.#results.appendError(`Add from library failed: ${err.message}`);
    }
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
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
