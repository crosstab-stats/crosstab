/**
 * @file import-service.js
 * File import as an extension point (`app.importers`).
 *
 * Importers are just plugins. The official CSV / SPSS-Stata-SAS importers
 * register through the exact same call a third party would use for their own
 * file format — there is no privileged importer, same as there is no privileged
 * analysis. What the *engine* owns is only what the security model forces it to:
 *
 *  - The **File ▸ Import** menu entries (a plugin can't draw host UI).
 *  - The **file picker** — opened synchronously on the user's menu click so the
 *    browser's user-activation requirement for file dialogs is satisfied. (A
 *    plugin-driven picker would lose activation across the postMessage hops.)
 *  - The **commit** into the dataset (`DataStore.loadDataset`). A plugin only
 *    ever *describes* the parsed data; the engine commits it, and only as part
 *    of a user-initiated import — so no plugin can replace your data unprompted.
 *
 * ## Flow
 * 1. A plugin calls `app.importers.register({ label, extensions, parse })`.
 *    `parse` is a plugin-side callback (marshalled by the broker).
 * 2. The engine adds a `File ▸ Import ▸ <label>…` menu item.
 * 3. On click (user activation live) the engine opens the picker, reads the
 *    chosen file's bytes, mints a `ticket`, and invokes `parse({ ticket, name,
 *    bytes })` (a one-way callback into the iframe).
 * 4. The plugin parses and calls `app.importers.deliver(ticket, dataset)` — an
 *    RPC back to the engine — with `{ variables, columns }` or
 *    `{ variables, parquet }` (the dual contract).
 * 5. The engine resolves that ticket and commits via `DataStore.loadDataset`.
 *
 * This rides entirely on the existing protocol (one-way callbacks + plugin→host
 * RPC); no wire-protocol change was needed.
 */

/**
 * @typedef {Object} ImporterSpec
 * @property {string} label - Menu label, e.g. `'CSV…'` or `'SPSS / Stata / SAS…'`.
 * @property {string[]} extensions - File extensions handled, with the dot, e.g.
 *   `['.csv']` or `['.sav', '.dta', '.sas7bdat']`. Used for the picker filter.
 * @property {(req: {ticket: number, name: string, bytes: ArrayBuffer}) => void} parse
 *   - Plugin callback that parses the bytes and calls `importers.deliver`.
 * @property {string} [id] - Stable id (defaults to `label`).
 * @property {number} [order] - Sort weight within File ▸ Import.
 */

export class ImportService {
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** @type {import('./data-store.js').DataStore} */
  #data;
  /** ResultsPane#api, for surfacing import errors. @type {{appendError: Function}} */
  #results;
  /** @type {import('./event-bus.js').EventBus} */
  #bus;

  /** id → spec. @type {Map<string, ImporterSpec>} */
  #importers = new Map();

  /** ticket → deferred for an in-flight import. @type {Map<number, {resolve: Function, reject: Function}>} */
  #pending = new Map();

  /** Monotonic ticket id. */
  #nextTicket = 1;

  /**
   * @param {Object} deps
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./data-store.js').DataStore} deps.data
   * @param {{appendError: Function}} deps.results - ResultsPane#api.
   * @param {import('./event-bus.js').EventBus} deps.bus
   */
  constructor({ menus, data, results, bus }) {
    this.#menus = menus;
    this.#data = data;
    this.#results = results;
    this.#bus = bus;
  }

  /**
   * Register a file importer. Adds a `File ▸ Import ▸ <label>` menu item and
   * returns a disposer that removes it (the loader runs it on plugin unload).
   *
   * @param {ImporterSpec} spec
   * @returns {() => void}
   */
  register(spec) {
    if (!spec || typeof spec.parse !== 'function') {
      throw new TypeError('importers.register: `parse` must be a function');
    }
    if (!Array.isArray(spec.extensions) || spec.extensions.length === 0) {
      throw new TypeError('importers.register: `extensions` must be a non-empty array');
    }
    const id = spec.id ?? spec.label;
    this.#importers.set(id, spec);
    const disposeMenu = this.#menus.register({
      id: `importer:${id}`,
      path: ['File', 'Import'],
      label: spec.label,
      order: spec.order ?? 100,
      command: () => {
        // Fire-and-forget: the menu shell doesn't await commands. Errors are
        // reported to the results pane inside #runImport.
        void this.#runImport(id);
      },
    });
    return () => {
      this.#importers.delete(id);
      disposeMenu();
    };
  }

  /**
   * Receive parsed data from a plugin for a previously issued ticket. Resolves
   * the matching in-flight import.
   *
   * @param {number} ticket
   * @param {{variables: object[], columns?: object, parquet?: Uint8Array}} dataset
   */
  deliver(ticket, dataset) {
    const pending = this.#pending.get(ticket);
    if (!pending) throw new Error(`importers.deliver: unknown or expired ticket ${ticket}`);
    pending.resolve(dataset);
  }

  /**
   * The object exposed to plugins as `app.importers`.
   * @returns {Readonly<{ register: (spec: ImporterSpec) => (() => void), deliver: (ticket: number, dataset: object) => void }>}
   */
  get api() {
    return Object.freeze({
      register: (spec) => this.register(spec),
      deliver: (ticket, dataset) => this.deliver(ticket, dataset),
    });
  }

  // --- internals -------------------------------------------------------------

  /** Run one import: pick a file, hand bytes to the plugin, commit the result. */
  async #runImport(id) {
    const spec = this.#importers.get(id);
    if (!spec) return;

    let file;
    try {
      file = await pickFile(spec.extensions);
    } catch (err) {
      this.#results.appendError(`Import: could not open file picker: ${err.message}`);
      return;
    }
    if (!file) return; // user cancelled

    const ticket = this.#nextTicket++;
    const done = new Promise((resolve, reject) => {
      this.#pending.set(ticket, { resolve, reject });
    });
    try {
      const bytes = await file.arrayBuffer();
      spec.parse({ ticket, name: file.name, bytes });
      const dataset = await done;
      if (!dataset || !Array.isArray(dataset.variables)) {
        throw new Error('importer returned no dataset');
      }
      await this.#data.loadDataset(dataset);
      this.#bus.emit('import:finished', {
        importer: id,
        name: file.name,
        rowCount: this.#data.rowCount,
      });
    } catch (err) {
      this.#results.appendError(`Import of "${file.name}" failed: ${err.message}`);
      console.error('[import]', err);
    } finally {
      this.#pending.delete(ticket);
    }
  }
}

/**
 * Open a host file picker and resolve with the chosen `File`, or `null` if the
 * user cancels. Must be called within a user gesture (we are — straight off the
 * menu click) so the browser allows the dialog.
 *
 * @param {string[]} extensions - Accept filter, e.g. `['.csv']`.
 * @returns {Promise<File|null>}
 */
function pickFile(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // `cancel` fires when the dialog is dismissed (recent browsers). Harmless
    // where unsupported — change still resolves the happy path.
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}
