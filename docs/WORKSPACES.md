# Plugin workspaces (#93)

Lets a plugin contribute its own **workspace tab** next to Data / Variables /
Output / R Console — promoting the workspace from a privileged, host-built feature
(the R Console) to something any plugin can declare. The first real consumer is
CAQDAS qualitative coding (#67).

This is the design we converged on (2026-06-22). Status markers: ✅ built,
🚧 in progress, ⬜ not started.

## Decisions (locked)

- **Project-persisted from day one.** A workspace's state is saved into the
  project and restored on reopen; it also travels in the `.crosstab` bundle. For
  CAQDAS the codes *are* the work — ephemeral wouldn't make sense.
- **Opaque, plugin-owned blob.** The host stores workspace state but does **not**
  interpret it. The host's contract: persist it, version-stamp it, save/restore
  with the project, carry it in the bundle, and **preserve it even when the
  plugin is absent** (round-trip safety — never discard a part you don't
  understand). The plugin owns its schema and any migrations (the blob carries
  its own version).
- **Keyed by workspace id, not plugin id.** State lives under a declared
  `workspace id`. Multiple plugins that declare the same id share the blob — this
  is how a lite "TA recoder" plugin and a heavy "faculty analyzer" plugin can
  operate on the same coding data. Sharing is explicit (both authors declare the
  id) and opt-in by installation (the user chooses what to install); a plugin can
  only touch ids it declares.
- **CAQDAS transcripts live in the dataset.** Each row is a document (a text
  column); codes attach to **row + character span**. The blob holds the codes,
  not the source text. (Workspace-held documents may come later as a second mode.)
- **The reparent-reload gotcha is neutralized by host-persisted state.** Because
  the blob is the source of truth in the host, a workspace rehydrates from
  `state.get()` on mount — so we never have to fight iframe DOM reparenting.

## Architecture

### Trust / sandbox
A workspace renders the plugin's **own UI inside its sandboxed iframe**
(`plugin-host.html`, `sandbox="allow-scripts"`, opaque origin, CSP
`default-src 'none'`). It can draw anything inside its box but cannot touch the
host DOM, host storage, or the network — its only channel is the existing
postMessage broker, which the host polices. Same model as compute plugins; the
workspace just gives that sealed frame a visible surface. Residual risk
(visual phishing inside its own rectangle) is managed by provenance labelling +
the broker never handing over data the plugin didn't legitimately request.

### Two trigger models (composing, not exclusive)
- **Menu analyses** — declared in the manifest, **host-invoked** (`run()` on a
  menu click; the host pops the input dialog and injects inputs). Unchanged.
- **Workspace interactions** — the plugin owns its DOM and wires its own events;
  when it needs the host it calls `ct.*` (data, run R, append output, state).

A single `run()` can use all three faucets at once: declared inputs (the dialog),
`ct.data.*` (dataset), and `ct.state.get()` (its blob). The plugin reads its blob
simply by being the plugin that holds it — there is no "data source" flag.

### Iframe model
A workspace plugin gets a **dedicated, visible workspace iframe** mounted in its
tab pane (separate from the hidden compute iframe; created in its final home, so
no reparenting). State is shared between the two through the **host blob store**
(the single source of truth), so the workspace's `run()` analyses see the live
coding state. Module-loaded-twice is the accepted cost; it buys us zero
reparent/re-handshake complexity.

### New host API (broker)
Added to the `app` proxy and the broker dispatch, scoped to the iframe's
workspace id:
- `ct.state.get()` → the current blob (or null).
- `ct.state.set(value)` → persist the blob (object or `Uint8Array`); marks the
  project dirty (rides the autosave/`#settle` path).
- `ct.invoke(fn, args)` (optional) → let a workspace button run one of the
  plugin's own declared analyses without duplicating logic.

### Manifest
```js
workspaces: [{ id: 'transcript-coding', title: 'Coding', icon? }]   // owns a tab
usesWorkspace: ['transcript-coding']                                 // reads another's blob
```
Plugin module exports `workspace.mount(app, root)` (called by the host after
activate via a `mountWorkspace` message); the plugin rehydrates from
`await app.state.get()` and renders into `root`.

### Lifecycle (rides the activePlugins work already shipped)
Tab appears when the plugin is active, disappears when disabled — reconciled off
`CoreEvents.PLUGINS_CHANGED`. The active set (and therefore the tab set) is
already persisted per-project. Missing-plugin handling mirrors #102: opening a
project whose workspace plugin you lack shows no tab + a warning, and the blob is
**preserved** for when you install it.

### Persistence
A new per-workspace-id sidecar in the project bundle, dirty-tracked like sources
(`project-sync` `#snapshot`/`#settle`; `project-bundle` for the `.crosstab` file).
Self-describing manifest entry (plugin id + version + human label) so a human can
see what an opaque blob is even without the plugin.

## Build plan

1. ⬜ **Spike** — hello-world workspace: manifest `workspaces` → tab → sandboxed
   iframe renders → `ct.state.set/get` survives a project reopen → tab toggles
   with enable/disable.
2. ⬜ **Primitive** — harden: API, lifecycle, persistence + bundle, missing-plugin.
3. ⬜ **CAQDAS (#67)** — dataset-backed transcript coding workspace on top.

## File map (where each piece lands)

- `core/workspace-store.js` (new) — host blob store keyed by workspace id;
  export/import for the project; dirty signalling.
- `core/workspace-manager.js` (new) — tab + pane creation, the dedicated
  workspace iframe + its broker, lifecycle reconcile off `PLUGINS_CHANGED`.
- `plugin-host.html` — add `state` namespace + `mountWorkspace` handler (inert
  unless a workspace is mounted).
- `core/plugin-broker.js` — add `state.get/set` dispatch (scoped to a workspace
  id); allow a workspace-scoped broker.
- `core/loader.js` — allow a visible, mounted plugin instance (workspace iframe).
- `core/plugin-manager.js` — record `workspaces` in the catalog; expose on `list()`.
- `core/app.js` — construct the store + manager; reconcile on `PLUGINS_CHANGED`.
- `index.html` — `#tabs` + `.workspace` already support sibling tabs/panes; the
  manager injects a `<button class="tab">` + `<div class="view">` per workspace.
- `core/project-sync.js` — snapshot/restore the workspace store (sidecar).
- `core/project-bundle.js` — include workspace blobs (self-describing).
- `plugins/builtin-hello-workspace/` (new, spike) — proves the loop.
- `plugins/builtin-caqdas/` (new, #67) — the first real workspace.
