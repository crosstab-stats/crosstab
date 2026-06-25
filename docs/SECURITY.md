# CrossTab security model

CrossTab is a **local-first, client-only** application: there is no server, no
shared backend, and no other users' data on the device. Everything runs in the
browser (WebR/R-WASM + DuckDB-WASM), and persistence is local (OPFS / IndexedDB /
localStorage). That shape determines what is and isn't a meaningful threat.

## What we defend against

1. **Untrusted third-party plugins.** Plugins are the extensibility story and are
   treated as untrusted code. Each runs in a `sandbox="allow-scripts"` iframe with
   **no** `allow-same-origin` (opaque origin, isolated heap); the engine never
   `import()`s, `eval`s, or otherwise runs plugin source in the host realm — it
   fetches the text and `postMessage`s it into the sandbox. Plugin → host calls go
   through an explicit allowlist broker; message identity is established by
   `event.source` window identity (unforgeable across an opaque-origin boundary),
   not by origin string.
2. **Untrusted shared files.** A `.crosstab` project bundle or a `.ctplugin`
   package may come from someone else. Opening one must never auto-execute plugin
   code, and rendered file content must never become script in the host origin.
3. **A malicious link** (`?launch=…`).
4. **Runtime-CDN supply chain** (WebR / DuckDB / R packages) — see "Deferred".

## What we explicitly do **not** treat as a vulnerability (by design)

These are conscious trade-offs for a local single-user tool. They are documented
here so the decision is on record, not rediscovered as "bugs".

### Activated plugins are trusted with the active dataset

`app.data.*` (`getDataFrame`, `getColumns`, `getRows`, …) resolves to the
**currently-active dataset** for any activated plugin. The per-action variable
picker is a *convenience* (it decides what gets bound into R for that run), **not**
an enforcement boundary — a plugin can read the whole active dataset regardless of
what the user selected for it. Activation is the trust decision: enabling a plugin
grants it the active dataset. Combined with the consented `app.web.get`
(see below) this is the intended capability surface, not a leak.

*Mitigation that remains:* `app.web.get` requires per-site user consent, so a
plugin reading the data still cannot send it off-device without an explicit allow.
(WebR network egress is a known gap — see "Deferred", #4.)

### Opening an untrusted bundle reconciles the active plugin set

Opening a `.crosstab` drives the active plugin set to exactly the bundle's list —
activating ones it names and disabling ones it doesn't (`applyActivatedSet`). This
is what makes a shared project reproducible (#102/#118). It **never runs foreign
code**: unknown plugin ids are skipped, and a plugin that *is* present was already
installed and sandboxed on this machine. The bundle reconfigures *which installed
plugins are live*, nothing more. Accepted.

### `?launch=<name>` can open a saved project headlessly

`?launch=` resolves to a preset (`start-blank`/`demo-quant`/`demo-qual`) or, failing
that, to one of **the user's own** locally-saved projects by name, opening it
without the launcher. A crafted link can therefore open one of your saved projects
(and reconcile its plugin set, as above). It cannot load a *foreign* project or
attacker data — it only matches names already in your local catalog — and it runs
no foreign code. This is the shortcut/bookmark feature working as intended. Accepted.

## Fixed in the pre-launch hardening pass (#89)

- **Stored-XSS on project open** — restored Output blocks (`text`, and `table`
  items without a re-renderable spec) are now run through `sanitizeHtml` before
  reaching the host DOM, so a malicious shared `.crosstab` can't inject script via
  saved output. (`core/results-pane.js`)
- **Plugin-name XSS on fork** — the creator dialog title now escapes the source
  plugin's (author-controlled) display name. (`core/plugin-creator.js`)
- **`web.get` consent is per-origin** — an "allow" is remembered **only for the
  host the user saw**; a fetch to a different origin re-prompts. One approval no
  longer authorises fetching from (and exfiltrating to) any host. The legacy
  boolean "any-URL" grant is dropped on upgrade (one-time re-prompt).
  (`core/loader.js`, `core/plugin-manager.js`, `core/app.js`)
- **Workspace-state ownership** — workspace state is still keyed by workspace id
  (so same-author lite/heavy plugins share, and the on-disk `{id: value}` format is
  unchanged), but a built-in's workspace ids are **reserved** against non-built-in
  plugins, and any id is otherwise bound to the first plugin namespace that touches
  it this session. A third-party plugin can no longer squat `caqdas-coding` (etc.)
  to read or overwrite its blob. (`core/workspace-store.js`,
  `core/workspace-manager.js`)

## Deferred (tracked, not theatre)

- **#4 — WebR network egress.** Plugin-supplied R can still reach the network
  (`download.file`, `url()`, `install.packages`) from the host origin, bypassing the
  `web.get` consent gate. **Sanitising R *source* is not a fix** — R is dynamic
  (`get("url")()`, `do.call`, `eval(parse())`), so any text blocklist is trivially
  bypassed. The real fix is a **transport-level allowlist** inside the WebR worker
  (block XHR/`fetch` except the package repo), mirroring the iframe's
  `connect-src`. Sizable and WebR-version-fragile; partly redundant given activated
  plugins are already trusted with the data (above). Tracked for its own task.
- **#9 — runtime asset integrity.** Cached runtime code (WebR/DuckDB/R packages) has
  no integrity check. Hashing *what we download* is theatre (it can't tell a legit
  upgrade from an injection). The non-theatre options are (a) **pinned SRI** baked
  into the app at vendor time (trust root = our own origin, not the CDN), or better
  (b) **serve the vendored runtime from our own origin** for the public build so the
  CDN leaves the trusted path entirely — which the air-gap vendoring path (#71)
  already produces. Decide at deploy time (#90); no TOFU hashing.
