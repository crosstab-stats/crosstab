/**
 * @file workspace-manager.js
 * Host side of plugin workspaces (#93): turns a plugin's manifest `workspaces`
 * declaration into a real workspace TAB.
 *
 * Each workspace gets its own VISIBLE sandboxed iframe (a second plugin-host
 * instance, distinct from the hidden compute iframe), mounted in its tab pane and
 * never reparented. Its broker is given a workspace-scoped `state` service backed
 * by the host {@link WorkspaceStore} — the single source of truth for the blob, so
 * the workspace and the plugin's `run()` analyses see the same coding state, and a
 * reload simply rehydrates from `state.get()`.
 *
 * Tab lifecycle rides the active-plugin set: {@link WorkspaceManager#reconcile} is
 * called whenever plugins load/unload, mounting tabs for active workspace plugins
 * and tearing down the rest.
 */

import { PluginBroker } from './plugin-broker.js';
import { attachSandbox } from './plugin-sandbox.js';
import { Lifecycle, advisory } from './plugin-lifecycle.js';
import { ownerToken, DEFAULT_SLOT, NO_DS } from './workspace-store.js';
import { newItemId } from './item-store.js';
import { declaredCollections, assetRefDecls } from './collections.js';
import { debug } from './debug.js';

const API_VERSION = '1';

export class WorkspaceManager {
  #tabs;
  #store;
  /** The item tier (#152) — the granular counterpart to the blob store above.
   * @type {import('./item-store.js').ItemStore|null} */
  #items = null;
  /** () => the current project epoch (#153), for rejecting writes from a mount whose
   * project has since closed. @type {() => number} */
  #epoch = () => 0;
  #services;
  #activeDatasetId;
  #onError;
  /** workspaceId → { view, iframe, broker, pluginId }. @type {Map<string, object>} */
  #mounted = new Map();
  /** Workspace ids declared by **built-in** plugins — reserved so a third-party
   * plugin can't squat a well-known id (e.g. `caqdas-coding`) and read/overwrite its
   * state (#89). Recomputed every reconcile from the live plugin list. */
  #builtinWsIds = new Set();

  /**
   * @param {Object} deps
   * @param {{addTab: Function, removeTab: Function, show: Function}} deps.tabs - The
   *   workspace tab registry from wireWorkspaceTabs.
   * @param {import('./workspace-store.js').WorkspaceStore} deps.store
   * @param {Object} deps.services - The host service bundle (data/results/webr/ui/web).
   * @param {(err: Error) => void} [deps.onError]
   */
  constructor({ tabs, store, items, epoch, services, activeDatasetId, onError }) {
    this.#tabs = tabs;
    this.#store = store;
    this.#items = items ?? null;
    this.#epoch = epoch ?? (() => 0);
    this.#services = services;
    // Which dataset a mount is bound to (coding state is per-dataset, #139). Read at
    // mount; a dataset switch re-mounts (see app.js), binding to the new one.
    this.#activeDatasetId = activeDatasetId ?? (() => null);
    this.#onError = onError ?? ((e) => console.error('[workspace]', e));
  }

  /**
   * Drive the set of workspace tabs to match the active plugins. Idempotent: call
   * it on every plugin load/unload (e.g. off CoreEvents.PLUGINS_CHANGED).
   *
   * @param {Array<{id, loaded, url, workspaces?}>} pluginList - From PluginManager#list().
   */
  async reconcile(pluginList) {
    // Reserved ids = every workspace id a built-in declares (whether active or not),
    // so the reservation holds regardless of plugin activation order (#89).
    this.#builtinWsIds = new Set();
    for (const p of pluginList || []) {
      if (p.builtin && Array.isArray(p.workspaces)) {
        for (const ws of p.workspaces) if (ws && ws.id) this.#builtinWsIds.add(ws.id);
      }
    }
    const wanted = new Map(); // workspaceId → { plugin, ws }
    for (const p of pluginList || []) {
      if (!p.activated || !Array.isArray(p.workspaces)) continue;
      for (const ws of p.workspaces) {
        if (ws && ws.id && ws.tab !== false) wanted.set(ws.id, { plugin: p, ws });
      }
    }
    debug('ws-mgr', 'reconcile — wanted:', [...wanted.keys()], 'mounted:', [...this.#mounted.keys()]);
    for (const id of [...this.#mounted.keys()]) {
      if (!wanted.has(id)) this.#teardown(id);
    }
    for (const [id, { plugin, ws }] of wanted) {
      if (!this.#mounted.has(id)) {
        // eslint-disable-next-line no-await-in-loop -- mounts are rare + serial.
        await this.#mount(plugin, ws); // never throws: shows its own retry overlay on failure
      }
    }
  }

  /**
   * Tear down every mounted workspace and mount the wanted set fresh. Use this when
   * the underlying state was replaced wholesale — e.g. switching projects, where a
   * workspace plugin stays active (so {@link reconcile} sees no change) but its blob
   * is now a different project's. A plain re-render in place would leak the old
   * iframe's document-level listeners, so we recreate the iframe outright.
   *
   * @param {Array<{id, loaded, url, workspaces?}>} pluginList - From PluginManager#list().
   */
  async remountActive(pluginList) {
    debug('ws-mgr', 'remountActive — tearing down:', [...this.#mounted.keys()]);
    // Tearing down the tab the user is on falls the tab bar back to Output. Capture
    // it first and restore it after re-mount (show() no-ops if it wasn't re-created),
    // so a re-mount triggered by e.g. switching datasets keeps the user on the tab
    // they were looking at instead of dumping them to Output.
    const wasActive = this.#tabs.activeView?.();
    for (const id of [...this.#mounted.keys()]) this.#teardown(id);
    await this.reconcile(pluginList);
    if (wasActive) this.#tabs.show?.(wasActive);
  }

  async #mount(plugin, ws) {
    debug('ws-mgr', `mount ${ws.id} (scope=${ws.scope || 'dataset'})`);
    const view = `ws:${ws.id}`;
    const title = ws.title || ws.id;

    const pane = document.createElement('div');
    pane.className = 'ws-pane';
    pane.style.cssText = 'position:relative;height:100%;min-height:420px;';
    // Toolbar strip: verb buttons (if any) on the left, restart on the right.
    // Always rendered — the restart button is available for every workspace.
    const toolbarVerbs = (ws.verbs || []).filter((v) => (v.category || 'toolbar') === 'toolbar');
    const toolbar = buildVerbToolbar(toolbarVerbs, async (verb, file) => {
      const entry = this.#mounted.get(ws.id);
      if (!entry?.broker) return;
      try {
        const args = file ? [{ __file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } }] : [{}];
        const result = await entry.broker.invoke(verb.run, args);
        this.#handleVerbResult(result);
      } catch (err) {
        this.#onError(new Error(`verb "${verb.id}" failed: ${err.message}`));
      }
    }, () => void this.#restart(ws.id));
    pane.append(toolbar);
    const iframe = makeIframe(title);
    pane.append(iframe);
    // A loading overlay covers the iframe during the handshake. It both signals
    // "not ready yet" and BLOCKS interaction — the 20s sandbox-ready window is long
    // enough for a user to click into a half-mounted workspace, which is what made
    // it feel like a crash. Removed on success; swapped for a retry prompt on failure.
    const overlay = makeOverlay();
    pane.append(overlay);

    // Reserve the slot before anything async so a concurrent reconcile can't
    // double-mount; KEEP it even if the handshake fails (the tab stays, showing a
    // retry prompt) so a stumble never silently deletes a workspace.
    const entry = {
      view, iframe, broker: null, pluginId: plugin.id, pane, ws, plugin, dsId: null,
      overlay, lc: null, startedAt: 0, advisoryTimer: null,
    };
    this.#mounted.set(ws.id, entry);

    // LAZY (#154 stage 5): the handshake starts when the tab is first shown, not at
    // reconcile. Mounting every workspace at boot meant N sandbox documents racing to
    // load while DuckDB and WebR warmed — self-inflicted contention that the old
    // deadlines then reported as failure.
    this.#tabs.addTab({ view, title, pane, onShow: () => this.#ensureStarted(ws.id) });
  }

  /** Begin (or resume) a workspace's handshake. Idempotent — showing a tab repeatedly
   * must not start a second one. */
  #ensureStarted(id) {
    const entry = this.#mounted.get(id);
    if (!entry || entry.lc) return;
    void this.#start(entry, id);
  }

  /**
   * Run the handshake, reporting rather than timing out (#154).
   *
   * There is no retry ladder and no deadline. A surface fails ONLY when something says
   * it failed — the frame's own `error`, an explicit `crashed` from the guest, or a
   * rejected step. Slowness changes the overlay's wording and nothing else, because a
   * plugin may legitimately take minutes, or hours, if that is what the analysis needs.
   */
  async #start(entry, id) {
    const lc = new Lifecycle({ onChange: () => this.#paint(entry) });
    entry.lc = lc;
    entry.startedAt = Date.now();
    // The ONE timer in the whole envelope. It may only re-word the overlay.
    entry.advisoryTimer = setInterval(() => this.#paint(entry), 2_000);
    this.#paint(entry);
    try {
      await this.#handshake(entry, lc);
      lc.advance('live');
      debug('ws-mgr', `${id}: live`);
      this.#stopAdvisory(entry);
      entry.overlay?.remove();
    } catch (e) {
      // An explicit failure — never a clock.
      lc.fail(lc.step, e.message);
      this.#stopAdvisory(entry);
      showRetryOverlay(entry.overlay, () => void this.#retry(id), `${entry.ws.title || id}: ${e.message}`);
      this.#onError(new Error(`workspace "${id}" failed to start: ${e.message}`));
    }
  }

  #stopAdvisory(entry) {
    if (entry.advisoryTimer) { clearInterval(entry.advisoryTimer); entry.advisoryTimer = null; }
  }

  /** Update the overlay from the lifecycle + the guest's own progress/heartbeat. */
  #paint(entry) {
    if (!entry.overlay || !entry.lc || entry.lc.isFailed) return;
    const status = entry.broker?.status?.() ?? { lastAliveMs: null };
    const a = advisory({
      step: entry.lc.step,
      elapsedMs: Date.now() - entry.startedAt,
      lastAliveMs: status.lastAliveMs,
    });
    updateOverlayMessage(entry.overlay, a.message, a.level !== 'ok' ? () => void this.#retry(entry.ws.id) : null);
  }

  /** User-initiated restart: flush the workspace's state via deactivate, then
   * tear down and remount the iframe in place. Safe even if the workspace is
   * wedged — deactivate has a timeout, and on failure we proceed anyway. */
  async #restart(id) {
    const entry = this.#mounted.get(id);
    if (!entry) return;
    try { await entry.broker?.sendDeactivate?.(); } catch { /* timeout or dead — fine */ }
    await this.#retry(id);
  }

  /** Build the broker and run the load → activate → mount handshake into
   * `entry.iframe`. Rejects if the sandbox doesn't become ready in time (caught by
   * the caller, which shows a retry overlay rather than tearing the tab down).
   * @param {object} entry
   * @param {number} [readyMs=20000] - Timeout for the sandbox ready signal. */
  async #handshake(entry, lc) {
    const { plugin, ws, iframe } = entry;
    const title = ws.title || ws.id;
    // Ownership token: the plugin's namespace (built-ins share one; URL/file plugins
    // get their host/author namespace). It is part of the storage KEY (#145), so a
    // different author declaring the same id gets a separate slot — collision-safe by
    // construction, no runtime claim. Built-in ids stay reserved at the TAB level so a
    // non-built-in can't hijack a built-in's visible tab (identity, not data — the
    // owner-keyed store already isolates the data either way).
    const owner = ownerToken(plugin);
    const reserved = this.#builtinWsIds.has(ws.id) && !plugin.builtin;
    // The project this mount belongs to. A write arriving after the project closed is a
    // straggler from a torn-down mount and must not land in whatever is open now (#153).
    const mountEpoch = this.#epoch();
    const stale = (what) => {
      if (this.#epoch() === mountEpoch) return false;
      debug('ws-mgr', `dropped ${what} from "${ws.id}": mounted in project epoch `
        + `${mountEpoch}, now ${this.#epoch()}`);
      return true;
    };
    // Bind this mount to the dataset that was active when it opened — coding state is
    // per-(owner, workspace, dataset), so switching datasets (which re-mounts) swaps
    // the blob.
    // Project-scoped workspaces (scope: 'project') always use NO_DS; dataset-scoped
    // (default) use the active dataset id. The host enforces the scope so the plugin
    // doesn't need to care.
    const scope = ws.scope || 'dataset';
    // dsId lives on the entry so notifyDatasetChanged can update it — the
    // closures below read entry.dsId, keeping state calls bound to whichever
    // dataset is current rather than the one that was active at mount time.
    entry.dsId = scope === 'project' ? NO_DS : this.#activeDatasetId();
    const services = {
      ...this.#services,
      workspace: {
        getState: (slotId) => {
          if (reserved) return null;
          return this.#store.get(owner, ws.id, slotId || DEFAULT_SLOT, entry.dsId);
        },
        setState: (value, opts) => {
          if (reserved) throw new Error(`Workspace id "${ws.id}" is reserved by a built-in plugin.`);
          if (stale('state.set')) return;
          const slotId = opts?.slot || DEFAULT_SLOT;
          this.#store.set(owner, ws.id, slotId, entry.dsId, value, { label: opts?.label });
        },
        listSlots: () => {
          if (reserved) return [];
          return this.#store.listSlots(owner, ws.id, entry.dsId);
        },
        deleteSlot: (slotId) => {
          if (reserved) throw new Error(`Workspace id "${ws.id}" is reserved by a built-in plugin.`);
          if (stale('state.delete')) return;
          if (!slotId) return;
          this.#store.set(owner, ws.id, slotId, entry.dsId, null);
        },
      },
      // Item records (#152). Same authority model as the blob store: `owner` is derived
      // from the plugin HERE and never accepted from the sandbox, so a plugin can only
      // ever write its own records. Scope is host-enforced from the workspace's declared
      // scope, exactly as the blob path does, so the plugin doesn't have to care.
      items: {
        put: (collection, id, fields) => {
          if (reserved) throw new Error(`Workspace id "${ws.id}" is reserved by a built-in plugin.`);
          if (stale('items.put')) return null;
          if (!this.#items || !collection) return null;
          const itemId = id || newItemId();
          this.#items.put(owner, String(collection), itemId, fields ?? {}, {
            scope: { wsId: ws.id, dsId: entry.dsId === NO_DS ? null : entry.dsId },
          });
          return itemId;
        },
        remove: (collection, id) => {
          if (reserved) throw new Error(`Workspace id "${ws.id}" is reserved by a built-in plugin.`);
          if (stale('items.remove')) return;
          if (!this.#items || !collection || !id) return;
          this.#items.remove(owner, String(collection), String(id));
        },
        list: (collection) => {
          if (reserved || !this.#items || !collection) return [];
          const dsKey = entry.dsId === NO_DS ? undefined : entry.dsId;
          return this.#items.list(owner, String(collection), { dsId: dsKey })
            .map((r) => ({ id: r.id, fields: r.fields, author: r.author ?? null }));
        },
      },
      // The selection, bound to this plugin so it reads its OWN collections (#153).
      selection: {
        get: (collection) => this.#services.selectionRead?.get(plugin.id, collection) ?? null,
        dataset: () => this.#services.selectionRead?.dataset() ?? null,
      },
      // `assets.load`/`put` come from the host bundle unchanged; `list` is scoped to the
      // refs held in THIS plugin's own item records (manifest.assetRefs), so a shared,
      // deduped byte pool never becomes a way to enumerate someone else's files.
      assets: {
        ...(this.#services.assets ?? {}),
        list: () => {
          if (!this.#items || !this.#services.assets?.listRefs) return [];
          const refs = [];
          for (const d of assetRefDecls(declaredCollections([plugin], () => owner))) {
            for (const rec of this.#items.list(owner, d.collection)) {
              const v = rec.fields?.[d.field];
              if (v) refs.push(v);
            }
          }
          return this.#services.assets.listRefs(refs);
        },
      },
    };
    if (this.#services.workspaceRead) {
      services.stateRead = (wsId, slotId) => this.#services.workspaceRead(plugin.id, wsId, slotId);
    }
    if (this.#services.workspaceWrite) {
      services.stateWrite = (wsId, value, dsId, slotId) => this.#services.workspaceWrite(plugin.id, wsId, value, dsId, slotId);
    }
    // Host-stamped attribution for this plugin's workspace output (matches the
    // menu-analysis format "Name · origin", e.g. "Qualitative Coding · built-in").
    const attribution = `${plugin.name || plugin.id} · ${plugin.origin || 'plugin'}`;
    const broker = new PluginBroker({ iframe, services, onError: this.#onError, attribution });
    entry.broker = broker;

    // A media-coding workspace (manifest.media) gets the media-CSP sandbox so it can
    // render host-provided <audio>/<img>/<video>; everything else stays strict. This
    // is the ONLY frame that renders — the loader's hidden compute frame never does,
    // so media capability lives here, not there (least privilege, #139).
    // Guest signals feed the lifecycle: progress advances it, a crash fails it with a
    // reason. This is what replaced the deadline.
    broker.onSignal((sig) => {
      if (sig.kind === 'crashed') lc.fail(lc.step, `${sig.step}: ${sig.message}`);
      else this.#paint(entry);
    });

    const { loaded } = await attachSandbox(iframe, plugin.media ? 'media' : 'strict');
    await loaded;              // the FRAME says it loaded — or errors
    lc.advance('caged');
    await broker.whenReady();  // the GUEST says its runtime is up — no deadline
    const source = await fetchSource(plugin.url);
    const manifest = await broker.sendLoad(source);
    lc.advance('loaded');
    const identity = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: API_VERSION,
    };
    await broker.sendActivate(identity);
    lc.advance('activated');
    await broker.sendMountWorkspace(identity, { id: ws.id, title });
    lc.advance('mounted');
  }

  /** Re-run a failed/timed-out mount in place: dispose the dead broker + iframe,
   * build a fresh iframe in the SAME pane, and redo the handshake behind a loading
   * overlay. The tab and the workspace's stored state are untouched, so this is a
   * safe "try again" (the data was never lost — the sandbox just didn't come up). */
  async #retry(id) {
    const entry = this.#mounted.get(id);
    if (!entry) return;
    try { entry.broker?.dispose(); } catch { /* ignore */ }
    try { entry.iframe?.remove(); } catch { /* ignore */ }
    entry.pane.querySelectorAll('.ws-overlay').forEach((o) => o.remove());
    const iframe = makeIframe(entry.ws.title || entry.ws.id);
    entry.iframe = iframe;
    entry.broker = null;
    const overlay = makeOverlay();
    entry.pane.append(iframe, overlay);
    entry.overlay = overlay;
    // A retry is a USER action, so it starts a fresh lifecycle rather than resuming a
    // failed one — the only sanctioned way a surface leaves the failed state (#154).
    this.#stopAdvisory(entry);
    entry.lc = null;
    await this.#start(entry, id);
  }

  /**
   * Notify all mounted workspaces that the active dataset changed. For each
   * workspace whose plugin exports `onDatasetChanged`, sends the lifecycle hook
   * (avoiding a full remount). Returns true if ALL mounted workspaces handled the
   * hook; returns false if any workspace lacks the hook (caller should fall back
   * to {@link remountActive}).
   *
   * @param {Array} pluginList - From PluginManager#list().
   * @returns {Promise<boolean>} true if all workspaces handled the hook in place.
   */
  async notifyDatasetChanged(pluginList) {
    if (!this.#mounted.size) { debug('ws-mgr', 'notifyDatasetChanged: no mounted workspaces'); return true; }
    const activeDsId = this.#activeDatasetId();
    debug('ws-mgr', 'notifyDatasetChanged START — mounted:', [...this.#mounted.keys()], 'activeDs:', activeDsId);
    // Rebind each dataset-scoped workspace to the now-active dataset BEFORE
    // sending the hook, so any state.get() the plugin calls inside
    // onDatasetChanged reads the correct (new) dataset's blob.
    let allHandled = true;
    for (const [id, entry] of this.#mounted) {
      // Not started yet (lazy mount, #154 stage 5) — nothing to notify, and nothing
      // wrong. It will read the current dataset when the user opens it.
      if (!entry.lc) { debug('ws-mgr', `${id}: SKIP (not started)`); continue; }
      if (!entry.broker) { debug('ws-mgr', `${id}: SKIP (no broker)`); allHandled = false; continue; }
      const scope = entry.ws?.scope || 'dataset';
      if (scope === 'dataset') entry.dsId = activeDsId;
      debug('ws-mgr', `${id}: sending hook (scope=${scope}, dsId=${entry.dsId})`);
      try {
        // No race (#154). The hook settles when the guest answers, when it crashes, or
        // when the broker is disposed. A plugin that takes a while to re-read its state
        // is not misbehaving, and cutting it off mid-hook was how state got half-applied.
        await entry.broker.sendDatasetChanged();
        debug('ws-mgr', `${id}: hook OK`);
      } catch (err) {
        debug('ws-mgr', `${id}: hook FAILED —`, err.message);
        allHandled = false;
      }
    }
    debug('ws-mgr', 'notifyDatasetChanged END — allHandled:', allHandled);
    return allHandled;
  }

  /**
   * Notify all mounted workspaces that their persisted state may have changed
   * externally (e.g. an import verb wrote new boundary data via
   * `app.state.write`). If every workspace handles `onRefresh`, returns true
   * (no remount needed). Returns false if any workspace lacks the hook, so the
   * caller can fall back to {@link remountActive}.
   *
   * @returns {Promise<boolean>}
   */
  async notifyWorkspaceRefresh() {
    if (!this.#mounted.size) return true;
    debug('ws-mgr', 'notifyWorkspaceRefresh — mounted:', [...this.#mounted.keys()]);
    for (const [, entry] of this.#mounted) {
      if (!entry.lc) continue;        // not started yet — it will read fresh state on open
      if (!entry.broker) return false;
      try {
        await entry.broker.sendWorkspaceRefresh();
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Process a verb's return envelope — emit events so the host refreshes. */
  #handleVerbResult(result) {
    if (!result) return;
    if (result.message && !result.ok) this.#onError(new Error(result.message));
    if (result.refresh) {
      const bus = this.#services.bus;
      const refreshes = Array.isArray(result.refresh) ? result.refresh : [result.refresh];
      for (const r of refreshes) {
        if (r === 'output') bus?.emit?.('output:written');
        if (r === 'dataset' || r === 'columns') bus?.emit?.('data:changed');
        if (r === 'workspace') bus?.emit?.('workspace:refresh');
      }
    }
  }

  async #teardown(id) {
    const entry = this.#mounted.get(id);
    if (!entry) return;
    debug('ws-mgr', `teardown ${id}`);
    this.#mounted.delete(id);
    this.#stopAdvisory(entry);
    entry.lc?.dispose();
    try {
      // Let the plugin flush, with NO deadline (#154 stage 6). This used to race a
      // 500 ms timer, so a plugin with real work to save was cut off and its write
      // vanished. The frame is only destroyed after the flush answers — or after the
      // broker rejects it, which happens on a crash or an explicit dispose.
      if (entry.broker) await entry.broker.sendDeactivate().catch(() => {});
      entry.broker?.dispose();
    } catch (err) {
      console.error('[workspace] dispose threw', err);
    }
    try {
      entry.iframe?.remove();
    } catch {
      /* already gone */
    }
    this.#tabs.removeTab(entry.view);
  }
}

/** Fetch a plugin's entry-module source text (builtin/URL plugins). */
async function fetchSource(url) {
  if (!url) throw new Error('no source URL for this workspace plugin');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`source fetch failed (${res.status})`);
  return res.text();
}

/** A visible, sandboxed (allow-scripts only — opaque origin, heap-isolated, no
 * forms/popups) iframe for a workspace pane. */
function makeIframe(title) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('title', `workspace: ${title}`);
  iframe.style.cssText = 'width:100%;height:100%;min-height:420px;border:0;display:block;';
  return iframe;
}

/** A full-pane overlay (spinner + "Loading…") shown during the mount handshake. It
 * sits above the iframe and intercepts clicks, so the workspace can't be used until
 * it's actually ready. */
function makeOverlay() {
  ensureSpinKeyframes();
  const o = document.createElement('div');
  o.className = 'ws-overlay';
  o.style.cssText =
    'position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;gap:12px;' +
    'align-items:center;justify-content:center;background:var(--bg,#f7f8fa);color:#5a6470;font:inherit;';
  const spin = document.createElement('div');
  spin.style.cssText =
    'width:28px;height:28px;border:3px solid #c8d0d8;border-top-color:var(--accent,#2980b9);' +
    'border-radius:50%;animation:ws-spin .8s linear infinite;';
  const msg = document.createElement('div');
  msg.className = 'ws-overlay-msg';
  msg.textContent = 'Loading workspace…';
  o.append(spin, msg);
  return o;
}

/** Update the text line in a loading overlay (used for retry progress). */
/**
 * Update the loading overlay's wording, and optionally offer a retry BESIDE it (#154).
 *
 * The offer is not a failure. A slow workspace stays loading, keeps its spinner, and
 * simply gains a "Retry" the user may ignore — because taking a long time is not the
 * same as being broken, and only a person may decide to give up.
 */
function updateOverlayMessage(overlay, text, onRetry = null) {
  const msg = overlay.querySelector('.ws-overlay-msg');
  if (msg) msg.textContent = text;
  const existing = overlay.querySelector('.ws-overlay-retry');
  if (!onRetry) { existing?.remove(); return; }
  if (existing) return; // already offered — don't rebuild it every tick
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ws-overlay-retry';
  btn.textContent = 'Retry';
  btn.title = 'Restart this workspace. It may still finish on its own.';
  btn.style.cssText =
    'margin-top:4px;padding:5px 12px;border:1px solid #c8d0d8;border-radius:6px;'
    + 'background:#fff;cursor:pointer;font:inherit;font-size:13px;';
  btn.addEventListener('click', onRetry);
  overlay.append(btn);
}

/** Convert a loading overlay into a failure prompt with a "Reload" button. Keeps
 * the tab and the stored state intact — the user can retry without losing data. */
function showRetryOverlay(overlay, onRetry, reason = '') {
  if (!overlay) return;
  overlay.replaceChildren();
  const msg = document.createElement('div');
  msg.style.cssText = 'max-width:440px;text-align:center;line-height:1.5;padding:0 16px;';
  // Say what actually happened. The old wording blamed "the sandbox timed out" for
  // every failure, which after #154 is never the reason — a surface now fails only when
  // something reports a cause, so show it.
  msg.textContent = reason
    ? `This workspace stopped: ${reason}. Your saved data is safe — reload to try again.`
    : 'This workspace stopped before it finished loading. Your saved data is safe — reload to try again.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload workspace';
  btn.style.cssText =
    'font:inherit;padding:8px 16px;border-radius:6px;border:1px solid var(--accent,#2980b9);' +
    'background:var(--accent,#2980b9);color:#fff;cursor:pointer;';
  btn.addEventListener('click', () => onRetry());
  overlay.append(msg, btn);
}

let spinInjected = false;
/** Inject the @keyframes the loading spinner uses, once. */
function ensureSpinKeyframes() {
  if (spinInjected) return;
  spinInjected = true;
  const s = document.createElement('style');
  s.textContent =
    '@keyframes ws-spin { to { transform: rotate(360deg); } } ' +
    '.ws-pane { display: flex; flex-direction: column; } ' +
    '.ws-pane[hidden] { display: none; }';
  document.head.append(s);
}

/** Build a host-rendered toolbar strip for a workspace. Verb buttons on the left,
 * a restart button pushed to the right. Always rendered — even workspaces with no
 * toolbar verbs get the strip (for restart). `needsFile` verbs open a file picker
 * synchronously on click (preserving user activation). */
function buildVerbToolbar(verbs, onInvoke, onRestart) {
  const bar = document.createElement('div');
  bar.className = 'ws-verb-toolbar';
  bar.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #e2e6ea;' +
    'background:#f7f8fa;flex:none;flex-wrap:wrap;';
  for (const verb of verbs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = verb.label.replace(/\s*[…\.]+\s*$/, '');
    btn.title = verb.label;
    btn.style.cssText =
      'font:inherit;font-size:13px;padding:4px 10px;border:1px solid #ccd2d8;border-radius:6px;' +
      'background:#fff;cursor:pointer;';
    btn.addEventListener('mouseenter', () => { btn.style.background = '#eef3f8'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#fff'; });
    btn.addEventListener('click', () => {
      if (verb.needsFile) {
        verbPickFile(verb.needsFile.extensions).then((file) => {
          if (file) onInvoke(verb, file);
        });
      } else {
        onInvoke(verb, null);
      }
    });
    bar.append(btn);
  }

  // Restart button — right-aligned, always present.
  const spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1;';
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart';
  restart.title = 'Restart this workspace (saves state first)';
  restart.style.cssText =
    'font:inherit;font-size:12px;padding:3px 8px;border:1px solid #ccd2d8;border-radius:6px;' +
    'background:#fff;cursor:pointer;color:#5a6470;';
  restart.addEventListener('mouseenter', () => { restart.style.background = '#eef3f8'; });
  restart.addEventListener('mouseleave', () => { restart.style.background = '#fff'; });
  restart.addEventListener('click', () => onRestart());
  bar.append(spacer, restart);

  return bar;
}

/** Open a native file picker for a verb's needsFile declaration. Must be called
 * synchronously from a click handler to preserve user activation. */
function verbPickFile(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (Array.isArray(extensions) && extensions.length) input.accept = extensions.join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}
