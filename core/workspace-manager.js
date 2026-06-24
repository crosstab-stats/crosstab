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

/** Same sandbox document the loader uses; resolved relative to /core. */
const HOST_URL = new URL('../plugin-host.html', import.meta.url).href;
const API_VERSION = '1';

export class WorkspaceManager {
  #tabs;
  #store;
  #services;
  #onError;
  /** workspaceId → { view, iframe, broker, pluginId }. @type {Map<string, object>} */
  #mounted = new Map();

  /**
   * @param {Object} deps
   * @param {{addTab: Function, removeTab: Function, show: Function}} deps.tabs - The
   *   workspace tab registry from wireWorkspaceTabs.
   * @param {import('./workspace-store.js').WorkspaceStore} deps.store
   * @param {Object} deps.services - The host service bundle (data/results/webr/ui/web).
   * @param {(err: Error) => void} [deps.onError]
   */
  constructor({ tabs, store, services, onError }) {
    this.#tabs = tabs;
    this.#store = store;
    this.#services = services;
    this.#onError = onError ?? ((e) => console.error('[workspace]', e));
  }

  /**
   * Drive the set of workspace tabs to match the active plugins. Idempotent: call
   * it on every plugin load/unload (e.g. off CoreEvents.PLUGINS_CHANGED).
   *
   * @param {Array<{id, loaded, url, workspaces?}>} pluginList - From PluginManager#list().
   */
  async reconcile(pluginList) {
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
    for (const id of [...this.#mounted.keys()]) this.#teardown(id);
    await this.reconcile(pluginList);
  }

  async #mount(plugin, ws) {
    const view = `ws:${ws.id}`;
    const title = ws.title || ws.id;

    const pane = document.createElement('div');
    pane.style.cssText = 'position:relative;height:100%;min-height:420px;';
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

  /** Build the broker and run the load → activate → mount handshake into
   * `entry.iframe`. Rejects if the sandbox doesn't become ready in time (caught by
   * the caller, which shows a retry overlay rather than tearing the tab down). */
  async #handshake(entry) {
    const { plugin, ws, iframe } = entry;
    const title = ws.title || ws.id;
    const services = {
      ...this.#services,
      // state.get/set scoped to THIS workspace id (the host is the source of truth).
      workspace: {
        getState: () => this.#store.get(ws.id),
        setState: (value) => this.#store.set(ws.id, value),
      },
    };
    // Host-stamped attribution for this plugin's workspace output (matches the
    // menu-analysis format "Name · origin", e.g. "Qualitative Coding · built-in").
    const attribution = `${plugin.name || plugin.id} · ${plugin.origin || 'plugin'}`;
    const broker = new PluginBroker({ iframe, services, onError: this.#onError, attribution });
    entry.broker = broker;

    iframe.src = HOST_URL;
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

  #teardown(id) {
    const entry = this.#mounted.get(id);
    if (!entry) return;
    this.#mounted.delete(id);
    try {
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
  s.textContent = '@keyframes ws-spin { to { transform: rotate(360deg); } }';
  document.head.append(s);
}
