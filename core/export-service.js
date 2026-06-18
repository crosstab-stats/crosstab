/**
 * @file export-service.js
 * Data export as an extension point (`app.exporters`) — the mirror image of
 * {@link import-service.js}.
 *
 * Exporters are just plugins, the same as importers and analyses. The built-in
 * CSV exporter registers through the exact call a third party would use to teach
 * CrossTab a new output format. What the *engine* owns is only what the security
 * model and the browser force it to:
 *
 *  - The **File ▸ Export** menu entries (a plugin can't draw host UI).
 *  - The **download** itself (a sandboxed iframe can't trigger a host download;
 *    the host turns the returned bytes into a Blob and clicks an `<a download>`).
 *
 * ## Flow
 * 1. A plugin calls `app.exporters.register({ label, extensions, export })`.
 * 2. The engine adds a `File ▸ Export ▸ <label>…` menu item.
 * 3. On click the engine mints a `ticket` and invokes `export({ ticket })` (a
 *    one-way callback into the iframe). The plugin reads the current data through
 *    `app.data` (which returns the derived, transformed view — so recodes are
 *    baked in and sources stay immutable), formats it, and calls
 *    `app.exporters.deliver(ticket, { filename, mimeType, data })`.
 * 4. The engine resolves the ticket and downloads the bytes.
 *
 * Like import, this rides entirely on the existing protocol (one-way callbacks +
 * plugin→host RPC); no wire-protocol change was needed.
 */

/**
 * @typedef {Object} ExporterSpec
 * @property {string} label - Menu label, e.g. `'CSV…'`.
 * @property {(req: {ticket: number}) => void} export - Plugin callback that reads
 *   the data (via `app.data`), formats it, and calls `exporters.deliver` with the
 *   result (or `null` to abort). Return value is ignored.
 * @property {string[]} [extensions] - File extensions produced, with the dot,
 *   e.g. `['.csv']`. Informational (the filename comes from the payload).
 * @property {string} [id] - Stable id (defaults to `label`).
 * @property {number} [order] - Sort weight within File ▸ Export.
 */

/**
 * @typedef {Object} ExportPayload
 * @property {string} filename - Suggested download filename, e.g. `'data.csv'`.
 * @property {string} mimeType - MIME type, e.g. `'text/csv;charset=utf-8'`.
 * @property {string|Uint8Array|ArrayBuffer} data - The file contents.
 */

export class ExportService {
  /** @type {import('./menu-shell.js').MenuShell} */
  #menus;
  /** @type {import('./data-store.js').DataStore} */
  #data;
  /** ResultsPane#api, for surfacing export errors. @type {{appendError: Function}} */
  #results;
  /** @type {import('./event-bus.js').EventBus} */
  #bus;

  /** id → spec. @type {Map<string, ExporterSpec>} */
  #exporters = new Map();

  /** ticket → deferred for an in-flight export. @type {Map<number, {resolve: Function, reject: Function}>} */
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
   * Register an exporter. Adds a `File ▸ Export ▸ <label>` menu item and returns
   * a disposer that removes it (the loader runs it on plugin unload).
   *
   * @param {ExporterSpec} spec
   * @returns {() => void}
   */
  register(spec) {
    if (!spec || typeof spec.export !== 'function') {
      throw new TypeError('exporters.register: `export` must be a function');
    }
    const id = spec.id ?? spec.label;
    this.#exporters.set(id, spec);
    const disposeMenu = this.#menus.register({
      id: `exporter:${id}`,
      path: ['File', 'Export'],
      label: spec.label,
      order: spec.order ?? 100,
      command: () => {
        void this.#runExport(id);
      },
    });
    return () => {
      this.#exporters.delete(id);
      disposeMenu();
    };
  }

  /**
   * Receive formatted bytes from a plugin for a previously issued ticket.
   *
   * @param {number} ticket
   * @param {ExportPayload|null} payload - The file to download, or `null` to abort.
   */
  deliver(ticket, payload) {
    const pending = this.#pending.get(ticket);
    if (!pending) throw new Error(`exporters.deliver: unknown or expired ticket ${ticket}`);
    pending.resolve(payload);
  }

  /**
   * The object exposed to plugins as `app.exporters`.
   * @returns {Readonly<{ register: (spec: ExporterSpec) => (() => void), deliver: (ticket: number, payload: object) => void }>}
   */
  get api() {
    return Object.freeze({
      register: (spec) => this.register(spec),
      deliver: (ticket, payload) => this.deliver(ticket, payload),
    });
  }

  // --- internals -------------------------------------------------------------

  /** Run an export: hand the plugin a ticket, await its bytes, download them. */
  async #runExport(id) {
    const spec = this.#exporters.get(id);
    if (!spec) return;
    if (this.#data.rowCount === 0) {
      this.#results.appendError('Export: no data is loaded.');
      return;
    }

    let payload;
    try {
      payload = await this.#awaitTicket((ticket) => spec.export({ ticket }));
    } catch (err) {
      this.#results.appendError(`Export failed: ${err.message}`);
      console.error('[export]', err);
      return;
    }
    // null = the plugin aborted (and reported its own error).
    if (!payload || payload.data == null) return;

    try {
      downloadFile(payload.filename || 'export', payload.mimeType || 'application/octet-stream', payload.data);
    } catch (err) {
      this.#results.appendError(`Export failed: ${err.message}`);
      console.error('[export]', err);
      return;
    }
    this.#bus.emit('export:finished', { exporter: id, filename: payload.filename });
  }

  /**
   * Mint a ticket, run `invoke(ticket)` (which kicks off the plugin's export),
   * and resolve with whatever the plugin `deliver`s for that ticket.
   * @param {(ticket: number) => void} invoke
   * @returns {Promise<ExportPayload|null>}
   */
  #awaitTicket(invoke) {
    const ticket = this.#nextTicket++;
    const done = new Promise((resolve, reject) => {
      this.#pending.set(ticket, { resolve, reject });
    });
    invoke(ticket);
    return done.finally(() => this.#pending.delete(ticket));
  }
}

/**
 * Trigger a browser download of `data` as `filename`. Host-side only — a Blob
 * URL clicked through a transient `<a download>`, then revoked.
 *
 * @param {string} filename
 * @param {string} mimeType
 * @param {string|Uint8Array|ArrayBuffer} data
 */
function downloadFile(filename, mimeType, data) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
