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
      if (!p.loaded || !Array.isArray(p.workspaces)) continue;
      for (const ws of p.workspaces) if (ws && ws.id) wanted.set(ws.id, { plugin: p, ws });
    }
    for (const id of [...this.#mounted.keys()]) {
      if (!wanted.has(id)) this.#teardown(id);
    }
    for (const [id, { plugin, ws }] of wanted) {
      if (!this.#mounted.has(id)) {
        // eslint-disable-next-line no-await-in-loop -- mounts are rare + serial.
        await this.#mount(plugin, ws).catch((e) => {
          this.#teardown(id); // leave no half-mounted tab on failure
          this.#onError(new Error(`workspace "${ws.id}" failed to mount: ${e.message}`));
        });
      }
    }
  }

  async #mount(plugin, ws) {
    const view = `ws:${ws.id}`;
    const title = ws.title || ws.id;

    const pane = document.createElement('div');
    pane.style.cssText = 'height:100%;min-height:420px;';
    const iframe = document.createElement('iframe');
    // allow-scripts ONLY — same opaque-origin sandbox as a compute plugin, just
    // visible. No allow-same-origin (heap isolation), no forms/popups.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', `workspace: ${title}`);
    iframe.style.cssText = 'width:100%;height:100%;min-height:420px;border:0;display:block;';
    pane.append(iframe);
    this.#tabs.addTab({ view, title, pane });

    // Reserve the slot before the async handshake so a concurrent reconcile can't
    // double-mount; fill in the broker once built.
    const entry = { view, iframe, broker: null, pluginId: plugin.id };
    this.#mounted.set(ws.id, entry);

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
