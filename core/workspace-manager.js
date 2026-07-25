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
import { sandboxBlobUrl } from './plugin-sandbox.js';
import { ownerToken } from './workspace-store.js';

const API_VERSION = '1';

export class WorkspaceManager {
  #tabs;
  #store;
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
  constructor({ tabs, store, services, activeDatasetId, onError }) {
    this.#tabs = tabs;
    this.#store = store;
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
      for (const ws of p.workspaces) if (ws && ws.id) wanted.set(ws.id, { plugin: p, ws });
    }
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
    this.#tabs.addTab({ view, title, pane });

    // Reserve the slot before the async handshake so a concurrent reconcile can't
    // double-mount; KEEP it even if the handshake fails (the tab stays, showing a
    // retry overlay) so a transient sandbox timeout never silently deletes a
    // workspace and its unsaved-looking state.
    const entry = { view, iframe, broker: null, pluginId: plugin.id, pane, ws, plugin };
    this.#mounted.set(ws.id, entry);

    await this.#handshake(entry).then(
      () => overlay.remove(),
      (e) => {
        showRetryOverlay(overlay, () => void this.#retry(ws.id));
        this.#onError(new Error(`workspace "${ws.id}" failed to mount: ${e.message}`));
      },
    );
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
   * the caller, which shows a retry overlay rather than tearing the tab down). */
  async #handshake(entry) {
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
    // Bind this mount to the dataset that was active when it opened — coding state is
    // per-(owner, workspace, dataset), so switching datasets (which re-mounts) swaps
    // the blob.
    const dsId = this.#activeDatasetId();
    const services = {
      ...this.#services,
      // state.get/set scoped to THIS (owner, workspace id, dataset). The host is the
      // source of truth; the owner comes from host-asserted identity, so setState is
      // write-your-own by construction.
      workspace: {
        getState: () => (reserved ? null : this.#store.get(owner, ws.id, dsId)),
        setState: (value) => {
          if (reserved) throw new Error(`Workspace id "${ws.id}" is reserved by a built-in plugin.`);
          this.#store.set(owner, ws.id, dsId, value);
        },
      },
    };
    // Host-stamped attribution for this plugin's workspace output (matches the
    // menu-analysis format "Name · origin", e.g. "Qualitative Coding · built-in").
    const attribution = `${plugin.name || plugin.id} · ${plugin.origin || 'plugin'}`;
    const broker = new PluginBroker({ iframe, services, onError: this.#onError, attribution });
    entry.broker = broker;

    // A media-coding workspace (manifest.media) gets the media-CSP sandbox so it can
    // render host-provided <audio>/<img>/<video>; everything else stays strict. This
    // is the ONLY frame that renders — the loader's hidden compute frame never does,
    // so media capability lives here, not there (least privilege, #139).
    iframe.src = await sandboxBlobUrl(plugin.media ? 'media' : 'strict');
    await broker.whenReady();
    const source = await fetchSource(plugin.url);
    const manifest = await broker.sendLoad(source);
    const identity = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: API_VERSION,
    };
    await broker.sendActivate(identity);
    await broker.sendMountWorkspace(identity, { id: ws.id, title });
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
    await this.#handshake(entry).then(
      () => overlay.remove(),
      (e) => {
        showRetryOverlay(overlay, () => void this.#retry(id));
        this.#onError(new Error(`workspace "${entry.ws.id}" failed to mount: ${e.message}`));
      },
    );
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
    if (!this.#mounted.size) return true;
    for (const [id, entry] of this.#mounted) {
      if (!entry.broker) return false;
      try {
        await entry.broker.sendDatasetChanged();
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
    this.#mounted.delete(id);
    try {
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
  msg.textContent = 'Loading workspace…';
  o.append(spin, msg);
  return o;
}

/** Convert a loading overlay into a failure prompt with a "Reload" button. Keeps
 * the tab and the stored state intact — the user can retry without losing data. */
function showRetryOverlay(overlay, onRetry) {
  overlay.replaceChildren();
  const msg = document.createElement('div');
  msg.style.cssText = 'max-width:440px;text-align:center;line-height:1.5;padding:0 16px;';
  msg.textContent =
    'This workspace didn’t finish loading (the sandbox timed out). Your saved data is safe — reload to try again.';
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
