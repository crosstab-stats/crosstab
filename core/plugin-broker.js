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

  /** Host service bundle, retained for the per-invocation `webr.run` override. */
  #services;

  /** Inputs gathered by the host for the in-flight action; auto-injected into the
   * plugin's `webr.run` calls (so the plugin's R sees them bound by name). */
  #activeInputs = null;

  /** Deferred for an in-flight {@link PluginBroker#invoke}. */
  #invokePending = null;

  /** Deferred for the workspace mount handshake (#93). */
  #workspaceMounted = deferred();

  /** Host-stamped output attribution ("Name · origin") for this plugin, applied to
   * its workspace-driven results so they're traceable like menu analyses. */
  #attribution = null;

  /**
   * @param {Object} args
   * @param {HTMLIFrameElement} args.iframe - The plugin's sandboxed iframe.
   * @param {Object} args.services - Core service surfaces (data/results/webr/
   *   menus/ui) plus the event bus, used to build the dispatch table.
   * @param {(err: Error) => void} [args.onError]
   */
  constructor({ iframe, services, onError, attribution }) {
    this.#iframe = iframe;
    this.#onError = onError ?? ((e) => console.error('[plugin-broker]', e));
    this.#services = services;
    this.#attribution = attribution ?? null;
    this.#dispatch = buildDispatch(services);
    // Output bracketing for plugin-driven output (e.g. a workspace's own buttons):
    // the plugin supplies only the title; the host stamps the trustworthy
    // attribution, so a plugin can't mislabel its output.
    this.#dispatch['results.beginAnalysis'] = (title) => services.results.beginAnalysis(title, this.#attribution);
    this.#dispatch['results.endAnalysis'] = () => services.results.endAnalysis();
    // Declarative plugins call `webr.run(code)` with no injection args; the host
    // binds the action's gathered inputs into R for them (see #activeInputs).
    this.#dispatch['webr.run'] = (code, opts) =>
      this.#services.webr.run(code, this.#activeInputs ? { ...opts, injectInputs: this.#activeInputs } : opts);
    // Workspace plugins (#93): a `workspace` service scopes state.get/set to this
    // iframe's workspace id (the host store is the single source of truth).
    if (services.workspace) {
      this.#dispatch['state.get'] = () => services.workspace.getState();
      this.#dispatch['state.set'] = (value) => services.workspace.setState(value);
    }
    // Codec plugins (#98): the streaming format-codec surface — random source-byte
    // access + streaming ingest on read, output-byte emit on write, and
    // host-allowlisted dependency loading. Live only during a codec invocation.
    if (services.codec) {
      this.#dispatch['codec.size'] = () => services.codec.size();
      this.#dispatch['codec.read'] = (offset, length) => services.codec.read(offset, length);
      this.#dispatch['codec.begin'] = (variables, storageTypes) => services.codec.begin(variables, storageTypes);
      this.#dispatch['codec.batch'] = (columns) => services.codec.batch(columns);
      this.#dispatch['codec.writeChunk'] = (bytes) => services.codec.writeChunk(bytes);
      this.#dispatch['codec.loadAsset'] = (name) => services.codec.loadAsset(name);
    }
    this.#listener = (e) => this.#onMessage(e);
    window.addEventListener('message', this.#listener);
  }

  /** @returns {Promise<void>} Resolves when the iframe runtime is ready, or
   * rejects if it doesn't signal ready in time — so a stuck/dropped sandbox
   * handshake fails fast (and the loader can retry) instead of hanging forever. */
  whenReady() {
    return Promise.race([
      this.#ready.promise,
      new Promise((_resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('plugin sandbox did not become ready in time')),
          20000,
        );
        this.#ready.promise.then(() => clearTimeout(t), () => clearTimeout(t));
      }),
    ]);
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
  /**
   * Invoke a named export on the plugin (the declarative API's entry path:
   * `run`/`parse`/`export`). Plain-data args/return only — these functions take
   * gathered inputs and return data/bytes, never functions.
   *
   * @param {string} fn - Exported function name from the manifest.
   * @param {any[]} [args]
   * @returns {Promise<any>} The function's return value.
   */
  invoke(fn, args = []) {
    this.#invokePending = deferred();
    this.#post({ t: 'invoke', fn, args });
    return this.#invokePending.promise;
  }

  /** Bind the host-gathered inputs for the in-flight action (auto-injected into
   * the plugin's `webr.run`). Cleared with {@link PluginBroker#clearActiveInputs}. */
  setActiveInputs(inputs) {
    this.#activeInputs = inputs;
  }

  clearActiveInputs() {
    this.#activeInputs = null;
  }

  sendActivate(plugin) {
    this.#post({ t: 'activate', plugin });
    return this.#activated.promise;
  }

  /**
   * Tell the (visible) workspace iframe to render its UI (#93). Resolves when the
   * plugin's `workspace.mount(app, root)` returns.
   * @param {object} plugin - Identity passed as `app.plugin`.
   * @param {{id: string, title?: string}} workspace - The workspace being mounted.
   */
  sendMountWorkspace(plugin, workspace) {
    this.#post({ t: 'mountWorkspace', plugin, workspace });
    return this.#workspaceMounted.promise;
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
      case 'workspaceMounted':
        if (msg.ok) this.#workspaceMounted.resolve();
        else this.#workspaceMounted.reject(new Error(msg.error || 'workspace mount failed'));
        break;
      case 'invoked': {
        const p = this.#invokePending;
        this.#invokePending = null;
        if (!p) break;
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error || 'plugin function failed'));
        break;
      }
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
 * Declarative plugins don't register or subscribe to anything — the host wires
 * menus/importers/exporters from the manifest and owns the lifecycle. So the
 * exposed surface is only *runtime* verbs (read data, run R, write results,
 * prompt, fetch). `webr.run` is overridden in the constructor to inject the
 * action's gathered inputs.
 *
 * @param {Object} s
 * @param {object} s.data    - DataStore#api (reads + create)
 * @param {object} s.results - ResultsPane#api
 * @param {object} s.webr    - WebRManager (run/install/files)
 * @param {object} s.ui      - UiService#api
 * @param {object} s.web - Host network fetch (`web.get`)
 * @returns {Object<string, Function>}
 */
function buildDispatch({ data, results, webr, ui, web }) {
  return {
    'data.getDataFrame': (opts) => data.getDataFrame(opts),
    'data.getColumns': (opts) => data.getColumns(opts),
    'data.getRows': (opts) => data.getRows(opts),
    'data.getVariableMeta': (opts) => data.getVariableMeta(opts),
    'data.getSelectedVariables': () => data.getSelectedVariables(),
    'data.getRowCount': () => data.getRowCount(),
    'data.getTransforms': () => data.getTransforms(),
    'data.getHistory': () => data.getHistory(),
    'data.create': (dataset) => data.create(dataset),

    'results.appendTable': (d, opts) => results.appendTable(d, opts),
    'results.appendPlot': (s, opts) => results.appendPlot(s, opts),
    'results.updatePlot': (handle, s) => results.updatePlot(handle, s),
    'results.appendText': (m) => results.appendText(m),
    'results.appendError': (m) => results.appendError(m),
    'results.getModel': () => results.getModel(),
    'results.getStyles': () => results.getStyles(),
    'results.getPlotPng': (id) => results.getPlotPng(id),

    'webr.run': (code, opts) => webr.run(code, opts),
    'webr.installPackages': (pkgs) => webr.installPackages(pkgs),
    'webr.writeFile': (path, d) => webr.writeFile(path, d),
    'webr.readFile': (path) => webr.readFile(path),
    'webr.mountFile': (file, name) => webr.mountFile(file, name),
    'webr.unmount': (path) => webr.unmount(path),

    'ui.selectVariables': (opts) => ui.selectVariables(opts),
    'ui.selectFromList': (opts) => ui.selectFromList(opts),
    'ui.showForm': (opts) => ui.showForm(opts),

    'web.get': (url) => web.get(url),
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
