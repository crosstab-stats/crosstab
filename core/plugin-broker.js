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
 *   {t:'debug', on}                     debug logging turned on/off (additive:
 *                                       an older sandbox ignores it, so no version bump)
 *
 * All messages are tagged `__crosstab: PROTOCOL_VERSION`. Because the iframe is
 * sandboxed to an opaque origin, messages arrive with `origin === "null"`; we
 * therefore authenticate by matching the message `source` against this broker's
 * iframe window, and post back with target origin `"*"`.
 */

import { debug, isDebug, onDebugChange } from './debug.js';
import { formatVarRef, parseVarRef } from './var-ref.js';
import { PendingCalls } from './plugin-lifecycle.js';
import { currentAuthor } from './user-identity.js';

/** Bumped on any breaking change to the wire protocol above. */
export const PROTOCOL_VERSION = 1;

/**
 * What a value IS, without saying what it holds.
 *
 * Every RPC argument and return crosses this boundary, and they are the user's data —
 * variable names, cell values, search text, R source, file bytes. The debug log is
 * exported and attached to bug reports, so it records sizes and kinds only. A count is
 * almost always what a diagnosis needs anyway: "getColumns returned 3 columns" answers a
 * different question from "getColumns returned 3,379", and neither needs a value.
 *
 * @param {any} v
 * @param {number} [depth] - recursion guard; objects are summarised below the top level
 * @returns {any} a JSON-safe description
 */
function shapeOf(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return `str(${v.length})`;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return typeof v;
  if (typeof v === 'function') return 'fn';
  if (v instanceof ArrayBuffer) return `bytes(${v.byteLength})`;
  if (ArrayBuffer.isView(v)) return `${v.constructor?.name ?? 'view'}(${v.length})`;
  if (v instanceof Blob) return `blob(${v.size})`;
  if (v instanceof Date) return 'Date';
  if (Array.isArray(v)) {
    if (depth >= 2) return `array(${v.length})`;
    // The first element's shape stands for the rest: a batch of 10,000 identical rows
    // says everything in one entry, and listing them would be the flood this avoids.
    return v.length ? [`array(${v.length})`, shapeOf(v[0], depth + 1)] : 'array(0)';
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (depth >= 2) return `object(${keys.length} keys)`;
    const out = {};
    for (const k of keys.slice(0, 12)) out[k] = shapeOf(v[k], depth + 1);
    if (keys.length > 12) out['…'] = `${keys.length - 12} more`;
    return out;
  }
  return typeof v;
}

/**
 * A plugin's own log value: passed through when small, shaped when not.
 *
 * The counterpart to {@link shapeOf}, and the difference matters. `shapeOf` describes
 * values that merely CROSS this boundary — RPC arguments, which are the user's data — so
 * it never passes one through. This handles values a plugin deliberately chose to record,
 * where the shape is useless: a delimiter, a byte count, a route decision, a state name.
 *
 * The cap is a BACKSTOP, not a guarantee. A plugin that logs a column of values will have
 * the array summarised and a long string truncated, but nothing here can stop a determined
 * plugin putting one cell value in a short string. The discipline the host's own lines
 * follow — counts and kinds, never names or values — is the discipline a plugin should
 * follow too, and the log is exported into bug reports precisely so that matters.
 *
 * @param {any} v
 * @param {number} [depth]
 * @returns {any} JSON-safe
 */
function logShape(v, depth = 0) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'bigint') return `${v}`;
  if (t === 'string') return v.length <= 200 ? v : `str(${v.length})`;
  if (t === 'function') return 'fn';
  // Anything bulk or opaque is described rather than carried — the same call as `shapeOf`
  // makes, for the same reason.
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Blob || v instanceof Date) {
    return shapeOf(v);
  }
  if (Array.isArray(v)) {
    if (depth >= 1 || v.length > 16) return shapeOf(v, depth);
    return v.map((x) => logShape(x, depth + 1));
  }
  if (t === 'object') {
    const keys = Object.keys(v);
    if (depth >= 2 || keys.length > 16) return shapeOf(v, depth);
    const out = {};
    for (const k of keys) out[k] = logShape(v[k], depth + 1);
    return out;
  }
  return shapeOf(v, depth);
}

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
  /** Outstanding host→guest calls, keyed by request id (#154). Replaces a single
   * `#lifecycleAck` slot, where two hooks in flight meant the first never resolved. */
  #calls = new PendingCalls();
  /** Latest guest progress + liveness, for the ADVISORY ui only. Never fails anything. */
  #progress = { step: 'created', detail: null, at: 0 };
  #lastAlive = 0;
  /** Called on progress/alive/crashed so a surface can update its state machine. */
  #onSignal = null;
  #manifestReady = deferred();
  #activated = deferred();

  /** Bound message listener, retained so it can be removed on dispose. */
  #listener;

  /** Host service bundle, retained for the per-invocation `webr.run` override. */
  #services;

  /** Inputs gathered by the host for the in-flight action; auto-injected into the
   * plugin's `webr.run` calls (so the plugin's R sees them bound by name). */
  #activeInputs = null;

  /** Injection options for the in-flight action (e.g. `{ keepMissing }`), merged
   * into the auto-injected `webr.run` call. @type {object} */
  #activeInjectOpts = {};

  /** Deferred for an in-flight {@link PluginBroker#invoke}. */
  #invokePending = null;

  /** Deferred for the workspace mount handshake (#93). */
  #workspaceMounted = deferred();

  /** Deferred for an in-flight lifecycle hook (datasetChanged / deactivate). */

  /** Host-stamped output attribution ("Name · origin") for this plugin, applied to
   * its workspace-driven results so they're traceable like menu analyses. */
  #attribution = null;

  /** Whether host-side debug logging is active (forwarded to the iframe). */
  #debug = false;

  /** Late-bound source of the plugin's id, for the log's `plugin:<id>` tag.
   * @type {?() => ?string} */
  #pluginIdFn = null;

  /** Unsubscribes this broker from debug-gate changes. @type {?() => void} */
  #stopDebugWatch = null;

  /**
   * @param {Object} args
   * @param {HTMLIFrameElement} args.iframe - The plugin's sandboxed iframe.
   * @param {Object} args.services - Core service surfaces (data/results/webr/
   *   menus/ui) plus the event bus, used to build the dispatch table.
   * @param {(err: Error) => void} [args.onError]
   */
  constructor({ iframe, services, onError, attribution, pluginId }) {
    this.#iframe = iframe;
    this.#onError = onError ?? ((e) => console.error('[plugin-broker]', e));
    this.#services = services;
    this.#attribution = attribution ?? null;
    // A FUNCTION, not a value: the loader does not know the plugin's id when the broker
    // is built — it reads the id out of the manifest afterwards, into a holder it passes
    // here. Capturing a value at construction would tag every log line `unknown`.
    this.#pluginIdFn = typeof pluginId === 'function' ? pluginId : null;
    try { this.#debug = typeof localStorage !== 'undefined' && !!localStorage.getItem('crosstab_debug'); } catch { /* sandboxed */ }
    // Subscribed HERE rather than by the caller: a watcher holds a reference to this
    // broker, so whoever subscribes has to remember to unsubscribe on teardown — and the
    // first version left that disposer dangling in the loader. Owning it means `dispose`
    // cannot forget.
    this.#stopDebugWatch = onDebugChange((on) => this.setDebugGate(on));
    this.#dispatch = buildDispatch({ ...services, pluginId: () => this.#pluginId() });
    // Output bracketing for plugin-driven output (e.g. a workspace's own buttons):
    // the plugin supplies only the title; the host stamps the trustworthy
    // attribution, so a plugin can't mislabel its output.
    // Variable metadata for a CROSS-DATASET run (#179). A plugin looks up a variable's label,
    // value labels and designated missing codes by the reference it was handed — and the base
    // call only knows the active dataset, so a `Wave 2:income` input would arrive with no meta
    // at all: no label, no value labels, and its user-missing codes silently not folded to NA.
    // Appended rather than replacing, keyed by the qualified reference, and only for datasets
    // the in-flight inputs actually name, so nothing changes for a single-dataset run.
    this.#dispatch['data.getVariableMeta'] = (opts) =>
      this.#withQualifiedMeta(services.data.getVariableMeta(opts), services.data);
    // Same reason, for the plugins that read columns themselves rather than through the R
    // injection (aggregate, plots, and three others). A store keys columns by BARE name, so a
    // qualified reference would come back absent and the plugin would quietly work on nothing.
    this.#dispatch['data.getColumns'] = (opts) => this.#columnsAcross(opts, services.data);
    this.#dispatch['results.beginAnalysis'] = (title) => services.results.beginAnalysis(title, this.#attribution);
    this.#dispatch['results.endAnalysis'] = () => services.results.endAnalysis();
    // Declarative plugins call `webr.run(code)` with no injection args; the host
    // binds the action's gathered inputs into R for them (see #activeInputs).
    this.#dispatch['webr.run'] = (code, opts) =>
      this.#services.webr.run(
        code,
        this.#activeInputs ? { ...opts, injectInputs: this.#activeInputs, ...this.#activeInjectOpts } : opts,
      );
    // Workspace plugins (#93): a `workspace` service scopes state.get/set to this
    // iframe's workspace id (the host store is the single source of truth).
    if (services.workspace) {
      this.#dispatch['state.get'] = (slotId) => services.workspace.getState(slotId);
      this.#dispatch['state.set'] = (value, opts) => services.workspace.setState(value, opts);
      this.#dispatch['state.list'] = () => services.workspace.listSlots();
      this.#dispatch['state.delete'] = (slotId) => services.workspace.deleteSlot(slotId);
    }
    // Memos (#152): host-MEDIATED, unlike items. A plugin does not own a memos
    // collection — it writes into core's, so a note from the coding workspace and one
    // from the output panel are the same record answerable by one query.
    if (services.memos) {
      this.#dispatch['memos.add'] = (anchor, text) => services.memos.add(anchor, text);
      this.#dispatch['memos.list'] = (anchor) => services.memos.list(anchor);
      this.#dispatch['memos.setText'] = (id, text) => services.memos.setText(id, text);
      this.#dispatch['memos.remove'] = (id) => services.memos.remove(id);
    }
    // What the user has selected, per kind (#153). Read-only: a plugin reacts to the
    // selection, it does not set it.
    if (services.selection) {
      this.#dispatch['selection.get'] = (collection) => services.selection.get(collection);
      this.#dispatch['selection.dataset'] = () => services.selection.dataset();
    }
    // Item records (#152): the granular sibling of `state.*`. The plugin names a
    // collection and a record id; the host owns owner/scope and the fold.
    if (services.items) {
      this.#dispatch['items.put'] = (collection, id, fields) => services.items.put(collection, id, fields);
      this.#dispatch['items.remove'] = (collection, id) => services.items.remove(collection, id);
      this.#dispatch['items.list'] = (collection) => services.items.list(collection);
      // Cross-plugin reads (#196). `listFrom` names the OWNER as a separate argument
      // because an owner token can contain a colon, so a single-string address would need
      // a parsing rule — and a parsing rule in front of a permission check is somewhere
      // for a mismatch to hide. Guarded individually rather than with the rest: a
      // workspace mount and a compute frame both supply `items`, and a surface that has
      // not been taught the cross-plugin methods must not advertise them.
      if (services.items.listFrom) {
        this.#dispatch['items.listFrom'] = (owner, collection) => services.items.listFrom(owner, collection);
      }
      if (services.items.publicCollections) {
        this.#dispatch['items.publicCollections'] = () => services.items.publicCollections();
      }
    }
    // Anchors (#166): build/resolve a reference to a REGION of an addressed thing.
    // Pure and host-owned — see the service in workspace-manager for why resolution
    // must not live in the plugin.
    if (services.anchors) {
      this.#dispatch['anchors.text'] = (text, start, end) => services.anchors.text(text, start, end);
      this.#dispatch['anchors.media'] = (selector, assetId) => services.anchors.media(selector, assetId);
      this.#dispatch['anchors.resolve'] = (refs, subject) => services.anchors.resolve(refs, subject);
      // Guarded individually: both the mount and the compute frame supply `anchors`, and a
      // surface that has not been taught this one must not advertise it.
      if (services.anchors.needsAttention) {
        this.#dispatch['anchors.needsAttention'] = (res) => services.anchors.needsAttention(res);
      }
    }
    // Codec plugins (#98): the streaming format-codec surface — random source-byte
    // access + streaming ingest on read, output-byte emit on write, and
    // host-allowlisted dependency loading. Live only during a codec invocation.
    if (services.codec) {
      this.#dispatch['codec.size'] = () => services.codec.size();
      this.#dispatch['codec.sourceFile'] = () => services.codec.sourceFile();
      this.#dispatch['codec.read'] = (offset, length) => services.codec.read(offset, length);
      this.#dispatch['codec.begin'] = (variables, storageTypes, opts) => services.codec.begin(variables, storageTypes, opts);
      this.#dispatch['codec.batch'] = (columns) => services.codec.batch(columns);
      this.#dispatch['codec.progress'] = (done, total) => services.codec.progress(done, total);
      this.#dispatch['codec.missingCodes'] = (proposal) => services.codec.missingCodes(proposal);
      this.#dispatch['codec.writeChunk'] = (bytes) => services.codec.writeChunk(bytes);
      this.#dispatch['codec.loadAsset'] = (name) => services.codec.loadAsset(name);
    }
    // Media plugins (#139): resolve a media ref to an opaque Blob. The host owns the
    // asset store; the plugin only ever gets bytes back, never a handle or a path.
    if (services.assets) {
      this.#dispatch['assets.load'] = (ref) => services.assets.load(ref);
      this.#dispatch['assets.put'] = (file, meta) => services.assets.put(file, meta);
      if (services.assets.list) this.#dispatch['assets.list'] = () => services.assets.list();
    }
    // ZIP for archive-format plugins (#139): build/read a ZIP host-side.
    if (services.zip) {
      this.#dispatch['zip.make'] = (entries) => services.zip.make(entries);
      this.#dispatch['zip.read'] = (bytes) => services.zip.read(bytes);
    }
    // On-device transcription (#139 Phase 2). Core owns the worker and the network
    // because a sandbox can have neither — an opaque-origin frame cannot create a Worker,
    // and every CSP tier here is `connect-src 'none'`. Everything else about the feature
    // is a plugin's: the dialog, the language picker, what the transcript becomes.
    //
    // Progress and cancellation are HOST-rendered rather than passed back, because a
    // callback cannot survive the structured clone this broker is built on — the same
    // wall that made Layer 3b's `onRedraw` undeliverable. A plugin awaits a result, the
    // way it does for `webr.installPackages` and its watchdog.
    if (services.transcribe) {
      this.#dispatch['transcribe.run'] = (bytes, opts) => services.transcribe.run(bytes, opts);
      this.#dispatch['transcribe.options'] = () => services.transcribe.options();
      // The QUEUE, for a plugin that owns its own UI. `run` waits and shows the host's
      // modal; a workspace tab transcribing seven interviews wants neither. Everything
      // here is plain data in both directions, which is what lets it cross the broker at
      // all — a progress callback could not.
      this.#dispatch['transcribe.enqueue'] = (bytes, opts) => services.transcribe.enqueue(bytes, opts);
      this.#dispatch['transcribe.status'] = () => services.transcribe.status();
      this.#dispatch['transcribe.result'] = (id) => services.transcribe.result(id);
      this.#dispatch['transcribe.cancel'] = (id) => services.transcribe.cancel(id);
      this.#dispatch['transcribe.pause'] = () => services.transcribe.pause();
      this.#dispatch['transcribe.resume'] = () => services.transcribe.resume();
      this.#dispatch['transcribe.forget'] = (id) => services.transcribe.forget(id);
    }
    // Owner-scoped read of a workspace blob the plugin declares (#139, #146).
    if (services.stateRead) {
      this.#dispatch['state.read'] = (wsId, slotId) => services.stateRead(wsId, slotId);
    }
    // Owner-scoped WRITE of a workspace blob the plugin declares (#139, #146).
    if (services.stateWrite) {
      this.#dispatch['state.write'] = (wsId, value, dsId, slotId) => services.stateWrite(wsId, value, dsId, slotId);
    }
    // Cross-plugin discovery + invocation (#147): list active analysis plugins and
    // run another plugin's analysis function (host-mediated, never direct).
    if (services.plugins) {
      this.#dispatch['plugins.list'] = () => services.plugins.list();
    }
    if (services.runAnalysis) {
      this.#dispatch['run.analysis'] = (target, inputs) => services.runAnalysis(target, inputs);
    }
    this.#listener = (e) => this.#onMessage(e);
    window.addEventListener('message', this.#listener);
  }

  /** @returns {Promise<void>} Resolves when the iframe runtime is ready, or
   * rejects if it doesn't signal ready in time — so a stuck/dropped sandbox
   * handshake fails fast (and the loader can retry) instead of hanging forever.
   * @param {number} [ms=20000] */
  /**
   * Resolves when the guest runtime signals ready. **No deadline** (#154): a slow boot is
   * not a failure, and the old 20 s cap is what reported busy boots as crashes. This
   * settles when the guest says ready, when an explicit failure arrives, or when the
   * broker is disposed — never on a clock.
   */
  whenReady() {
    return this.#ready.promise;
  }

  /** Subscribe to guest progress / liveness / crash signals (#154). */
  onSignal(fn) {
    this.#onSignal = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** Latest progress the guest reported, and how long since its last heartbeat. Feeds
   * the advisory UI, which may only change wording. */
  status() {
    return {
      step: this.#progress.step,
      detail: this.#progress.detail,
      lastAliveMs: this.#lastAlive ? Date.now() - this.#lastAlive : null,
    };
  }

  /**
   * Send the plugin source for the iframe to import. Resolves with the manifest
   * the plugin module exported (the plugin is NOT activated yet, so the host can
   * version-check and pre-install packages first).
   *
   * @param {string} code - Plugin entry-module source text.
   * @param {string} [stdlib] - Source of the host's chart-drawing stdlib, for a plugin
   *   declaring `manifest.charts`. Sent as TEXT because a module cannot cross
   *   postMessage and a host-realm blob URL is not fetchable from an opaque-origin
   *   frame — the frame imports it itself, exactly as it does the plugin's own source.
   * @returns {Promise<import('./loader.js').PluginManifest>}
   */
  sendLoad(code, stdlib, modules = null, std = null) {
    // `modules` is the plugin's own files by name (#multi-file): the frame blobs them and
    // builds an import map, because a blob URL minted HERE carries the host's origin and the
    // sandbox is opaque. Omitted for the single-file case, which is every built-in today.
    // `std` is the GENERAL plugin stdlib's source (plugin-stdlib.js), handed to every
    // plugin — unlike `stdlib`, which is the chart drawing library and only matters to a
    // plugin declaring a `charts` section.
    this.#post({
      t: 'load', code, stdlib,
      ...(std ? { std } : {}),
      ...(modules && Object.keys(modules).length ? { modules } : {}),
    });
    // Bound the wait: a malicious/broken plugin that imports but never posts
    // {t:'manifest'} would otherwise leave this broker (and its live sandbox)
    // attached forever — a capability leak on the probe path especially, where
    // nothing else tears it down until the manifest resolves. Mirrors whenReady().
    return this.#manifestReady.promise;
  }

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
    const { rid, promise } = this.#calls.open('invoke');
    this.#post({ t: 'invoke', fn, args, rid });
    return promise;
  }

  /**
   * Ask one of the plugin's chart kinds to describe itself for a model, or to render
   * one. Plain data both ways — a descriptor spec, or an SVG string.
   *
   * @param {string} kind @param {'describe'|'render'} op
   * @param {object} model @param {object} [view]
   */
  chartCall(kind, op, model, view) {
    const { rid, promise } = this.#calls.open('chartCall');
    this.#post({ t: 'chartCall', kind, op, model, view, rid });
    return promise;
  }

  /** Bind the host-gathered inputs for the in-flight action (auto-injected into
   * the plugin's `webr.run`). Cleared with {@link PluginBroker#clearActiveInputs}. */
  setActiveInputs(inputs, opts = {}) {
    this.#activeInputs = inputs;
    this.#activeInjectOpts = opts || {};
  }

  clearActiveInputs() {
    this.#activeInputs = null;
    this.#activeInjectOpts = {};
  }

  /** Datasets the in-flight inputs reach into, by name. Empty for an ordinary run. */
  #inputDatasets() {
    const out = new Set();
    for (const d of Object.values(this.#activeInputs || {})) {
      if (d?.kind !== 'variables' || !Array.isArray(d.columns)) continue;
      for (const ref of d.columns) {
        const { dataset } = parseVarRef(ref);
        if (dataset) out.add(dataset);
      }
    }
    return out;
  }

  /**
   * `getColumns` across datasets, keyed by the REFERENCE that was asked for (#179).
   *
   * Keyed by reference rather than by bare name for the same reason the R binding is: two
   * datasets' `age` must stay two columns instead of one of them silently standing in for both.
   * A request with no qualified reference in it goes straight through, untouched.
   */
  async #columnsAcross(opts, data) {
    const wanted = Array.isArray(opts?.variables) ? opts.variables : null;
    if (!wanted || !wanted.some((v) => parseVarRef(v).dataset != null)) return data.getColumns(opts);
    const groups = new Map();
    for (const ref of wanted) {
      const { dataset, name } = parseVarRef(ref);
      const key = dataset ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ref, name });
    }
    const out = {};
    for (const [ds, list] of groups) {
      // eslint-disable-next-line no-await-in-loop -- one read per dataset
      const got = await data.getColumns({
        ...opts,
        variables: list.map((x) => x.name),
        ...(ds ? { dataset: ds } : {}),
      });
      for (const { ref, name } of list) if (got && name in got) out[ref] = got[name];
    }
    return out;
  }

  /** @see the `data.getVariableMeta` override in the constructor. */
  #withQualifiedMeta(base, data) {
    const names = this.#inputDatasets();
    if (!names.size) return base;
    const out = Array.isArray(base) ? [...base] : [];
    for (const ds of names) {
      let meta = [];
      try {
        meta = data.getVariableMeta({ dataset: ds }) || [];
      } catch {
        continue; // a dataset that has since closed: the lookup will fail loudly at read time
      }
      for (const m of meta) out.push({ ...m, name: formatVarRef(ds, m.name), dataset: ds });
    }
    return out;
  }

  /** Host-facing: set this plugin's output attribution ("Name · origin"). The
   * loader only knows the manifest name + host-tracked origin after load, so it
   * sets this post-activation. Used to stamp a fallback attributed section for any
   * output the plugin appends outside an explicit analysis bracket (#106). */
  setAttribution(attribution) {
    this.#attribution = attribution || null;
  }

  /**
   * Tell the iframe to call the plugin's `activate(app)`.
   *
   * @param {object} plugin - Plugin identity passed through as `app.plugin`.
   * @returns {Promise<void>} Resolves when `activate` returns.
   */
  sendActivate(plugin) {
    this.#post({ t: 'activate', plugin, debug: this.#debug });
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
   * Lifecycle hook: notify the workspace iframe that the active dataset changed.
   * If the plugin exports `workspace.onDatasetChanged`, it can re-read state and
   * re-render in place without a full remount. Resolves when the hook returns.
   * @param {object} [plugin] - Identity for makeApp if not already built.
   */
  sendDatasetChanged(plugin) {
    const { rid, promise } = this.#calls.open('datasetChanged');
    this.#post({ t: 'datasetChanged', plugin, rid });
    return promise;
  }

  /**
   * Lifecycle hook: notify the workspace iframe that its persisted state changed
   * externally (e.g. an import verb wrote new data via `app.state.write`). If the
   * plugin exports `workspace.onRefresh`, it can re-read state and re-render in
   * place — avoiding a full iframe teardown/remount.
   */
  sendWorkspaceRefresh() {
    const { rid, promise } = this.#calls.open('workspaceRefresh');
    this.#post({ t: 'workspaceRefresh', rid });
    return promise;
  }

  /** Push notification: the set of active plugins changed — workspace plugins that
   * registered `app.plugins.onChange(cb)` should re-query `app.plugins.list()`. */
  sendPluginsChanged() {
    this.#post({ t: 'pluginsChanged' });
  }

  /**
   * Lifecycle hook: notify the workspace iframe it is being deactivated so it can
   * flush unsaved state. Resolves when the hook returns (or times out).
   * @param {object} [plugin] - Identity for makeApp if not already built.
   */
  /**
   * Ask the plugin to flush before teardown. **Awaited with no deadline** (#154 stage 6).
   *
   * It used to race a 500 ms timer, so a plugin with real work to flush was silently
   * abandoned and the frame torn down under it — the write simply vanished. A flush is
   * the last chance a plugin has to save anything; hurrying it is how data is lost. The
   * caller decides when to give up, and only a person may cancel.
   */
  sendDeactivate(plugin) {
    const { rid, promise } = this.#calls.open('deactivate');
    this.#post({ t: 'deactivate', plugin, rid });
    return promise;
  }

  /**
   * Tear down: run every outstanding disposer (menu items, subscriptions) and
   * stop listening. The caller is responsible for removing the iframe element,
   * which destroys the plugin's heap.
   */
  dispose() {
    window.removeEventListener('message', this.#listener);
    try { this.#stopDebugWatch?.(); } catch { /* best-effort */ }
    this.#stopDebugWatch = null;
    // Every outstanding call ends HERE rather than on a clock (#154): disposal is a real
    // event, a deadline is a guess. Without this a caller awaiting a torn-down frame
    // would hang forever, which is exactly why timeouts existed.
    this.#calls.rejectAll(new Error('plugin surface disposed'));
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

  /**
   * Tell the frame which layout the user is in.
   *
   * Fire-and-forget: there is nothing to wait for, and a frame that has not finished
   * its handshake will be told again at mount. The frame turns it into
   * `data-screen` on its own documentElement, so a plugin's CSS keys off exactly the
   * selector the host's does — see plugin-host.html.
   *
   * Sent rather than measured because the mode is a USER'S CHOICE, not a viewport
   * width: a plugin reading its own iframe width would override someone who
   * deliberately picked the full layout on a narrow screen, which is the objection
   * small-screen mode was built around (core/screen-mode.js).
   */
  sendScreen(mode) {
    this.#post({ t: 'screen', mode });
  }

  #post(message) {
    // Opaque-origin iframe: target origin must be "*"; authentication is by the
    // source check on the receiving side, not by origin string.
    const payload = { __crosstab: PROTOCOL_VERSION, ...message };
    try {
      this.#iframe.contentWindow?.postMessage(payload, '*');
    } catch (e) {
      // #91 debugging: a host→sandbox post that can't be cloned. Localise it so the
      // failure names the offending value rather than a bare "object can not be cloned".
      let detail = '';
      try {
        structuredClone(payload);
        detail = ' — structuredClone(whole) OK → boundary rejected the message, not its content';
      } catch {
        detail = ` — non-cloneable at ${findBadClone(payload, 'msg')}`;
      }
      console.error('[plugin-broker] host→sandbox post failed:', e?.message, detail, message?.t);
      throw new Error(`host→sandbox post failed [${message?.t}]: ${e?.message || e}${detail}`);
    }
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
      // ---- #154 signals: the reason deadlines are gone --------------------------
      case 'progress':
        this.#progress = { step: msg.step, detail: msg.detail ?? null, at: Date.now() };
        this.#lastAlive = Date.now();
        this.#onSignal?.({ kind: 'progress', step: msg.step, detail: msg.detail ?? null });
        break;
      case 'alive':
        this.#lastAlive = Date.now();
        this.#onSignal?.({ kind: 'alive', step: msg.step });
        break;
      case 'crashed':
        // An explicit death. This is what a timeout was standing in for, and unlike a
        // timeout it can say WHERE and WHY. Rejects everything outstanding so no caller
        // is left hanging on a frame that is already gone.
        this.#ready.reject?.(new Error(msg.message || 'plugin crashed'));
        this.#calls.rejectAll(new Error(`plugin crashed during ${msg.step}: ${msg.message}`));
        this.#onSignal?.({ kind: 'crashed', step: msg.step, message: msg.message, stack: msg.stack });
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
      case 'lifecycleAck':
        debug('broker', `lifecycleAck: ${msg.hook} ok=${msg.ok}`, msg.error || '');
        // Settled BY ID (#154). Previously one shared slot held the pending deferred, so
        // a second hook overwrote the first and it never resolved — reachable with a
        // dataset switch during a workspace refresh. `ok:false` here means "no such hook",
        // which is a normal answer, not a failure: resolve it.
        this.#calls.settle(msg.rid, { ok: true, value: { hook: msg.hook, handled: !!msg.ok, error: msg.error || null } });
        break;
      case 'invoked':
        this.#calls.settle(msg.rid, { ok: msg.ok, value: msg.value, error: msg.error || 'plugin function failed' });
        break;

      case 'chartResult':
        this.#calls.settle(msg.rid, { ok: msg.ok, value: msg.value, error: msg.error || 'chart kind failed' });
        break;
      case 'call':
        this.#handleCall(msg);
        break;
      default:
        break;
    }
  }

  /**
   * Tell the iframe whether debug logging is on.
   *
   * The flag already rides the `activate` message, which covers a plugin loaded while
   * logging is on. This covers the other case, and it is the one that matters more:
   * someone turning logging ON to watch something that is happening right now. Without
   * it a plugin's own diagnostics stay dark until a reload — by which point whatever was
   * being diagnosed has usually gone.
   *
   * Additive to the wire protocol: an older sandbox ignores an unknown message type, so
   * this does not bump PROTOCOL_VERSION.
   *
   * @param {boolean} on
   */
  setDebugGate(on) {
    this.#debug = !!on;
    try { this.#post({ t: 'debug', on: this.#debug }); } catch { /* the frame may be gone */ }
  }

  /** Who the log line is about. Prefers the loader's late-bound id; falls back to the
   * attribution, which carries the plugin's identity for output stamping. */
  #pluginId() {
    const fromLoader = this.#pluginIdFn?.();
    if (fromLoader) return String(fromLoader);
    return this.#attribution?.pluginId ?? this.#attribution?.id ?? this.#attribution?.name ?? null;
  }

  /** Dispatch one RPC call and post the result (or error) back. */
  async #handleCall(msg) {
    const { id, method, args } = msg;
    // For output calls, tell the pane which plugin is appending so it can stamp a
    // fallback attributed section if the plugin appends outside an analysis bracket
    // (#106). The set→append is synchronous (handlers don't yield before mutating),
    // so this can't be clobbered by an interleaved call; cleared in `finally`.
    const stampAttr =
      method.startsWith('results.') &&
      this.#attribution &&
      typeof this.#services.results?.setActiveAttribution === 'function';
    // EVERY plugin→host call lands here, so this one place covers the whole surface: what
    // a plugin asked for, in order, how long it took, and how big the answer was. Only
    // failures were logged before, which meant a plugin that did the wrong thing
    // SUCCESSFULLY left no trace at all — and "it ran and the result was wrong" is the
    // harder bug.
    //
    // Shapes, never values. The log is exported into bug reports, and these arguments are
    // the user's data: variable names, cell values, search text, R source.
    const t0 = isDebug() ? Date.now() : 0;
    debug('rpc', `→ ${method}`, { plugin: this.#pluginId(), args: shapeOf(args) });
    try {
      const handler = this.#dispatch[method] ?? this.#builtinMethod(method);
      if (!handler) throw new Error(`unknown method "${method}"`);
      const revived = this.#reviveArgs(args ?? []);
      if (stampAttr) this.#services.results.setActiveAttribution(this.#attribution);
      const result = await handler(...revived);
      debug('rpc', `← ${method}`, { ms: Date.now() - t0, result: shapeOf(result) });
      this.#post({ t: 'result', id, ok: true, value: this.#marshalReturn(result) });
    } catch (err) {
      debug('rpc', `✗ ${method}`, { ms: Date.now() - t0, message: String(err?.message ?? err).slice(0, 200) });
      this.#post({ t: 'result', id, ok: false, error: String(err?.message ?? err) });
    } finally {
      if (stampAttr) this.#services.results.setActiveAttribution(null);
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
        // The other direction, which had no instrumentation at all: a menu command or an
        // event handler the host invokes INSIDE the plugin. A log showing the host fire a
        // callback and nothing happening afterwards is how you tell "the plugin was never
        // asked" from "the plugin was asked and did nothing".
        debug('rpc', `⇢ cb#${cbId}`, { plugin: this.#pluginId(), args: shapeOf(cbArgs) });
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
 * @param {() => ?string} [s.pluginId] - reads whose calls these are, for the log's
 *   `plugin:<id>` tag. A function because the id is not known when this is built.
 * @returns {Object<string, Function>}
 */
function buildDispatch({ data, results, webr, ui, web, pluginId }) {
  // Read at CALL time: the table is built before the plugin's manifest has been parsed,
  // so the id does not exist yet.
  const who = () => (typeof pluginId === 'function' ? pluginId() : null) ?? 'unknown';
  return {
    'data.getDataFrame': (opts) => data.getDataFrame(opts),
    'data.getColumns': (opts) => data.getColumns(opts),
    'data.getRows': (opts) => data.getRows(opts),
    'data.getVariableMeta': (opts) => data.getVariableMeta(opts),
    'data.maxOctetLengths': (names) => data.maxOctetLengths(names),
    'data.getSelectedVariables': () => data.getSelectedVariables(),
    'data.getRowCount': () => data.getRowCount(),
    'data.getTransforms': () => data.getTransforms(),
    'data.getHistory': () => data.getHistory(),
    'data.create': (dataset) => data.create(dataset),
    'data.setActive': (id) => data.setActive(id),

    'results.appendTable': (d, opts) => results.appendTable(d, opts),
    'results.appendPlot': (s, opts) => results.appendPlot(s, opts),
    'results.appendChart': (model) => results.appendChart(model),
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
    // Returns a File — structured-cloneable, so the plugin gets the bytes by reference
    // without the host ever exposing a path or the filesystem.
    'ui.pickFile': (opts) => ui.pickFile(opts),

    'web.get': (url) => web.get(url),

    // A plugin's own diagnostics, into the host's gated log. Plugins could already READ
    // the gate (`app.debug`) but had nowhere to write: the only option was `console.log`,
    // which does not reach the file `saveLog()` exports into a bug report and which the
    // user cannot turn off.
    //
    // Tagged `plugin:<id>` rather than with a tag of the plugin's choosing, so a plugin
    // cannot write a line that reads as if the engine wrote it — the log is evidence.
    //
    // `logShape`, NOT the `shapeOf` every other line here uses — and that distinction was
    // got wrong first time round. An RPC argument is the user's data in transit, so
    // recording its shape is the only safe thing. A plugin's own log line is a fact the
    // plugin DERIVED and chose to record, so shaping it destroys the whole point: the
    // first version turned `{delimiter: 'tab', bytes: 8}` into
    // `{delimiter: 'str(3)', bytes: 'number'}`, which says nothing at all.
    'debug.log': (tag, args) => {
      debug(
        `plugin:${who()}`,
        String(tag ?? '').slice(0, 80),
        ...(Array.isArray(args) ? args.slice(0, 8).map((a) => logShape(a)) : []),
      );
    },

    // The current user's self-set identity snapshot (#148) — so a plugin can stamp
    // authorship on what it creates (e.g. CAQDAS code applications → inter-coder
    // reliability). Read-only; self-asserted; the user's own name, not subject data.
    'identity.get': () => currentAuthor(),
  };
}

/** Reject `promise` if it hasn't settled within `ms`, clearing the timer either
 * way so no dangling handle keeps the broker alive. */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      promise.then(() => clearTimeout(t), () => clearTimeout(t));
    }),
  ]);
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

/** #91 debugging: localise the first non-structured-cloneable value in `value`,
 * returning a `msg.foo.bar <Type>` path so a clone failure names the offender. */
function findBadClone(value, path) {
  try {
    structuredClone(value);
    return path;
  } catch {
    /* this node fails — drill into its children */
  }
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    for (const k of keys) {
      try {
        structuredClone(value[k]);
      } catch {
        return findBadClone(value[k], `${path}.${k}`);
      }
    }
  }
  const ctor = (value && value.constructor && value.constructor.name) || typeof value;
  return `${path} <${ctor}>`;
}
