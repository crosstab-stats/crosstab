/**
 * @file plugin-broker.js
 * Host (engine) side of the plugin RPC. One broker instance brokers for exactly
 * one plugin iframe.
 *
 * Every plugin runs in a sandboxed iframe and reaches the engine ONLY through
 * `postMessage`. The broker is the engine-side endpoint: it receives method
 * calls from the iframe, dispatches them to the real core services, and posts
 * results back. It also marshals the two things that cannot be cloned across a
 * `postMessage` boundary:
 *
 *  - **Callbacks** (a plugin passing a function, e.g. a menu `command` or an
 *    event handler). The iframe replaces the function with a marker `{__cb:id}`;
 *    the broker revives it into a host function that, when the engine calls it,
 *    posts `{t:'cb', cbId}` back so the iframe can invoke the real function.
 *  - **Disposers** (a service method returning an unsubscribe function, e.g.
 *    from `menus.register` or `events.on`). The broker stores the function under
 *    a handle id and returns `{__handle:id}`; the iframe turns that back into a
 *    function that calls the `__dispose` method.
 *
 * ## Wire protocol (PROTOCOL_VERSION 1)
 * iframe → host:
 *   {t:'ready'}                         runtime booted
 *   {t:'manifest', ok, manifest, error} plugin module imported (not yet active)
 *   {t:'activated', ok, error}          activate() returned
 *   {t:'call', id, method, args}        RPC request; args may hold {__cb:n}
 * host → iframe:
 *   {t:'load', code}                    plugin source to import
 *   {t:'activate', plugin}             call activate(app)
 *   {t:'result', id, ok, value, error}  RPC response; value may hold {__handle:n}
 *   {t:'cb', cbId, args}                invoke a plugin-side callback
 *
 * All messages are tagged `__crosstab: PROTOCOL_VERSION`. Because the iframe is
 * sandboxed to an opaque origin, messages arrive with `origin === "null"`; we
 * therefore authenticate by matching the message `source` against this broker's
 * iframe window, and post back with target origin `"*"`.
 */

/** Bumped on any breaking change to the wire protocol above. */
export const PROTOCOL_VERSION = 1;

export class PluginBroker {
  /** @type {HTMLIFrameElement} */
  #iframe;

  /** Method dispatch table: `"namespace.method"` → async handler. */
  #dispatch;

  /** Reports a fatal broker/plugin error to the engine. @type {(err: Error) => void} */
  #onError;

  /** Disposer functions returned by service calls, keyed by handle id. */
  #handles = new Map();

  /** Next handle id for marshalled disposers. */
  #nextHandle = 1;

  /** Resolvers for the load handshake. */
  #ready = deferred();
  #manifestReady = deferred();
  #activated = deferred();

  /** Bound message listener, retained so it can be removed on dispose. */
  #listener;

  /**
   * @param {Object} args
   * @param {HTMLIFrameElement} args.iframe - The plugin's sandboxed iframe.
   * @param {Object} args.services - Core service surfaces (data/results/webr/
   *   menus/ui) plus the event bus, used to build the dispatch table.
   * @param {(err: Error) => void} [args.onError]
   */
  constructor({ iframe, services, onError }) {
    this.#iframe = iframe;
    this.#onError = onError ?? ((e) => console.error('[plugin-broker]', e));
    this.#dispatch = buildDispatch(services);
    this.#listener = (e) => this.#onMessage(e);
    window.addEventListener('message', this.#listener);
  }

  /** @returns {Promise<void>} Resolves when the iframe runtime is ready. */
  whenReady() {
    return this.#ready.promise;
  }

  /**
   * Send the plugin source for the iframe to import. Resolves with the manifest
   * the plugin module exported (the plugin is NOT activated yet, so the host can
   * version-check and pre-install packages first).
   *
   * @param {string} code - Plugin entry-module source text.
   * @returns {Promise<import('./loader.js').PluginManifest>}
   */
  sendLoad(code) {
    this.#post({ t: 'load', code });
    return this.#manifestReady.promise;
  }

  /**
   * Tell the iframe to call the plugin's `activate(app)`.
   *
   * @param {object} plugin - Plugin identity passed through as `app.plugin`.
   * @returns {Promise<void>} Resolves when `activate` returns.
   */
  sendActivate(plugin) {
    this.#post({ t: 'activate', plugin });
    return this.#activated.promise;
  }

  /**
   * Tear down: run every outstanding disposer (menu items, subscriptions) and
   * stop listening. The caller is responsible for removing the iframe element,
   * which destroys the plugin's heap.
   */
  dispose() {
    window.removeEventListener('message', this.#listener);
    for (const dispose of this.#handles.values()) {
      try {
        dispose();
      } catch (err) {
        console.error('[plugin-broker] disposer threw', err);
      }
    }
    this.#handles.clear();
  }

  // --- internals -------------------------------------------------------------

  #post(message) {
    // Opaque-origin iframe: target origin must be "*"; authentication is by the
    // source check on the receiving side, not by origin string.
    this.#iframe.contentWindow?.postMessage({ __crosstab: PROTOCOL_VERSION, ...message }, '*');
  }

  #onMessage(event) {
    // Authenticate by window identity (origin is "null" for sandboxed frames).
    if (event.source !== this.#iframe.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.__crosstab !== PROTOCOL_VERSION) return;

    switch (msg.t) {
      case 'ready':
        this.#ready.resolve();
        break;
      case 'manifest':
        if (msg.ok) this.#manifestReady.resolve(msg.manifest);
        else this.#manifestReady.reject(new Error(msg.error || 'plugin import failed'));
        break;
      case 'activated':
        if (msg.ok) this.#activated.resolve();
        else this.#activated.reject(new Error(msg.error || 'activate() failed'));
        break;
      case 'call':
        this.#handleCall(msg);
        break;
      default:
        break;
    }
  }

  /** Dispatch one RPC call and post the result (or error) back. */
  async #handleCall(msg) {
    const { id, method, args } = msg;
    try {
      const handler = this.#dispatch[method] ?? this.#builtinMethod(method);
      if (!handler) throw new Error(`unknown method "${method}"`);
      const revived = this.#reviveArgs(args ?? []);
      const result = await handler(...revived);
      this.#post({ t: 'result', id, ok: true, value: this.#marshalReturn(result) });
    } catch (err) {
      this.#post({ t: 'result', id, ok: false, error: String(err?.message ?? err) });
    }
  }

  /** Methods the broker implements itself rather than delegating to a service. */
  #builtinMethod(method) {
    if (method === '__dispose') {
      return (handleId) => {
        const dispose = this.#handles.get(handleId);
        if (dispose) {
          this.#handles.delete(handleId);
          dispose();
        }
      };
    }
    return null;
  }

  /** Replace `{__cb:id}` markers in args with host functions that call back. */
  #reviveArgs(args) {
    const revive = (v) => {
      if (Array.isArray(v)) return v.map(revive);
      // Binary payloads (Parquet `Uint8Array`) and File/Blob handles (an upload
      // an importer mounts) arrive intact via structured clone; don't walk them.
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Blob) return v;
      if (v && typeof v === 'object') {
        if (typeof v.__cb === 'number') return this.#makeCallback(v.__cb);
        const out = {};
        for (const k of Object.keys(v)) out[k] = revive(v[k]);
        return out;
      }
      return v;
    };
    return args.map(revive);
  }

  /** A host function that forwards an engine-side invocation to the iframe. */
  #makeCallback(cbId) {
    return (...cbArgs) => {
      try {
        this.#post({ t: 'cb', cbId, args: cbArgs });
      } catch (err) {
        // Most commonly: an event payload that is not structured-cloneable.
        this.#onError(new Error(`callback payload not transferable: ${err.message}`));
      }
    };
  }

  /** If a service returned a disposer function, store it behind a handle. */
  #marshalReturn(result) {
    if (typeof result === 'function') {
      const id = this.#nextHandle++;
      this.#handles.set(id, result);
      return { __handle: id };
    }
    return result;
  }
}

/**
 * Build the `"namespace.method"` → handler table from the core services. Listing
 * methods explicitly (rather than reflecting) keeps the exposed surface a
 * reviewed allowlist: a plugin can only reach what is named here.
 *
 * @param {Object} s
 * @param {object} s.data    - DataStore#api (read-only)
 * @param {object} s.transform - DataStore#transformApi (writes)
 * @param {object} s.results - ResultsPane#api
 * @param {object} s.webr    - { run, installPackages }
 * @param {object} s.menus   - MenuShell#api
 * @param {object} s.ui      - UiService#api
 * @param {object} s.importers - ImportService#api
 * @param {object} s.exporters - ExportService#api (data export)
 * @param {object} s.outputExporters - OutputExportService#api (output/report export)
 * @param {object} s.web - Host network fetch (`web.get`)
 * @param {import('./event-bus.js').EventBus} s.bus
 * @returns {Object<string, Function>}
 */
function buildDispatch({ data, transform, results, webr, menus, ui, importers, exporters, outputExporters, web, bus }) {
  return {
    'data.getDataFrame': (opts) => data.getDataFrame(opts),
    'data.getColumns': (opts) => data.getColumns(opts),
    'data.getVariableMeta': (opts) => data.getVariableMeta(opts),
    'data.getSelectedVariables': () => data.getSelectedVariables(),
    'data.getRowCount': () => data.getRowCount(),
    'data.getTransforms': () => data.getTransforms(),
    'data.getHistory': () => data.getHistory(),
    'data.create': (dataset) => data.create(dataset),
    'data.onDataChanged': (fn) => data.onDataChanged(fn),
    'data.onSelectionChanged': (fn) => data.onSelectionChanged(fn),

    'transform.updateVariable': (name, patch) => transform.updateVariable(name, patch),

    'results.beginSection': (t) => results.beginSection(t),
    'results.appendTable': (h) => results.appendTable(h),
    'results.appendPlot': (s, opts) => results.appendPlot(s, opts),
    'results.updatePlot': (handle, s) => results.updatePlot(handle, s),
    'results.appendText': (m) => results.appendText(m),
    'results.appendError': (m) => results.appendError(m),
    'results.clear': () => results.clear(),
    'results.getModel': () => results.getModel(),
    'results.getStyles': () => results.getStyles(),
    'results.getPlotPng': (id) => results.getPlotPng(id),

    'webr.run': (code, opts) => webr.run(code, opts),
    'webr.installPackages': (pkgs) => webr.installPackages(pkgs),
    'webr.writeFile': (path, data) => webr.writeFile(path, data),
    'webr.readFile': (path) => webr.readFile(path),
    'webr.mountFile': (file, name) => webr.mountFile(file, name),
    'webr.unmount': (path) => webr.unmount(path),

    'menus.register': (item) => menus.register(item),

    'ui.selectVariables': (opts) => ui.selectVariables(opts),
    'ui.selectFromList': (opts) => ui.selectFromList(opts),
    'ui.showForm': (opts) => ui.showForm(opts),

    'importers.register': (spec) => importers.register(spec),
    'importers.deliver': (ticket, dataset) => importers.deliver(ticket, dataset),

    'exporters.register': (spec) => exporters.register(spec),
    'exporters.deliver': (ticket, payload) => exporters.deliver(ticket, payload),

    'outputExporters.register': (spec) => outputExporters.register(spec),
    'outputExporters.deliver': (ticket, payload) => outputExporters.deliver(ticket, payload),

    'web.get': (url) => web.get(url),

    'events.on': (name, fn) => bus.on(name, fn),
    'events.emit': (name, payload) => bus.emit(name, payload),
  };
}

/** A promise plus its resolve/reject, for the handshake steps. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
