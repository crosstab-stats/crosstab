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

## Fixed in the post-launch plugin-audit pass (2026-07)

A focused review of the plugin/import surface turned up two gaps against controls
we already intended to enforce; both are closed.

- **`web.get` redirect bypass.** The per-origin consent gate (#89) approved the
  *requested* origin, but the host fetch used the default `redirect: 'follow'`, so a
  grant for a trusted host let its (open-)redirect bounce the request — carrying data
  in the URL — to an origin the user never approved. The host fetch now uses
  `redirect: 'manual'` and rejects any 30x, so the cross-origin hop never fires; the
  data can only reach the exact origin the user consented to. (`core/app.js`.) Trade-off:
  endpoints that rely on redirects (e.g. a Wikipedia REST title that 302s to its
  canonical) must be given as the direct URL; the error says so.
- **Probe-time capability exposure.** *Cataloguing* a plugin (reading its manifest,
  no activation, no consent) built a broker with the full service bundle and imported
  the plugin, whose top-level module code could then RPC `data.*`/`webr.*` — reading
  the active dataset or running R before any trust decision. The probe now gets a
  **deny-all** service bundle (every `app.*` call throws), and `sendLoad` has a 20s
  timeout so a plugin that imports but never returns a manifest can't keep a live,
  capable sandbox attached indefinitely. (`core/loader.js`, `core/plugin-broker.js`.)

## Accepted residual risks (won't fix)

These are real gaps we have consciously chosen **not** to close, because the
available fixes cost more (in ongoing maintenance or fragility) than the risk
warrants for a local single-user tool. Recorded so the trade-off is deliberate.

- **#4 — WebR network egress.** Plugin-supplied R can reach the network
  (`download.file`, `url()`, `install.packages`) from the host origin, bypassing the
  `web.get` consent gate. Note the *non-fixes*: sanitising R **source** is theatre —
  R is dynamic (`get("url")()`, `do.call`, `eval(parse())`), so any text blocklist is
  trivially bypassed. The only robust fix is a transport-level XHR/`fetch` allowlist
  *inside* the WebR worker, which is sizable and fragile across WebR versions.
  **Accepted, not pursued:** it's partly redundant anyway — activated plugins are
  already trusted with the active dataset (above), so R egress is not a new exposure
  beyond the consented `web.get`. Revisit only if WebR exposes a supported network
  hook that makes the allowlist cheap and stable.
- **#9 — runtime asset integrity.** Cached runtime code (WebR/DuckDB/R packages) has
  no integrity check. TOFU hashing (hash what we download) is theatre — it can't tell
  a legit upgrade from an injection. Pinned SRI would be real defence but requires
  re-vetting and updating hashes on **every** legitimate upstream bump — a
  maintenance burden we're not taking on. **Accepted.** If we ever want the
  protection for free, the clean route is to serve the *vendored* runtime from our
  own origin (the air-gap path, #71, already produces it), which removes the CDN from
  the trusted path with zero ongoing hashing — a deploy-time choice (#90), not a code
  obligation here.
- **#10 — data at rest is plaintext (local storage *and* exports).** The whole project
  bundle persists to **OPFS / IndexedDB / localStorage in the clear**, and DuckDB reads
  the Parquet sources *directly* from OPFS handles (`BROWSER_FSACCESS`,
  `core/duckdb-manager.js`). Exported `.crosstab`/data files land wherever the user saves
  them, also plaintext. **Threat scope — be precise about what this is and isn't:**
  browser storage is **origin-isolated**, so *other websites cannot read it* (that's the
  same-origin threat the platform is built to stop, and it holds). The gap is **local /
  offline access to the bytes** — a stolen or shared machine, a forensic disk image, or a
  backup/sync of the browser profile — where OPFS/IndexedDB are ordinary app-data files
  with no more protection than any other app's. It is **not** a defence against malware
  running *as the user while a project is open* (that reads the decrypted data or scrapes
  the key from memory regardless); at-rest encryption only ever protects the
  powered-off / offline / backup copy.
  - *Why not always-on app-level encryption:* it would be **theatre** unless keyed by a
    secret the machine doesn't store. If the app can auto-decrypt on next launch, the key
    sits on disk beside the ciphertext (a "non-extractable" `CryptoKey` resists *script*
    extraction but still lives in the same profile) — a disk image has both. It is *real*
    only when keyed by a **user passphrase** (or hardware-backed key) entered per session.
    And mandatory encryption would **break the large-data path**: DuckDB's direct-OPFS
    streaming read can't run against ciphertext, so multi-GB Parquet would have to be
    decrypted into memory and OOM.
  - *Primary answer (recommended, documented):* **OS full-disk encryption**
    (BitLocker / FileVault / LUKS) protects *all* app data uniformly, keyed off-disk
    (TPM/login), with zero app cost and no fight with DuckDB. This is the correct at-rest
    control; app-level encryption on top is largely redundant for the stolen-laptop threat.
  - *Planned optional mitigation* for the FDE-gap (no-FDE machines, shared computers) and
    the off-machine export case: **opt-in passphrase encryption for local storage,
    default-on (opt-*out*) for exports**, reusing the collaboration crypto kernel (same
    KDF/AES envelope). Real, because keyed by a user secret; non-taxing, because scoped to
    who asks for it. Tracked as TODO #144 (incl. the unresolved OOM-vs-encryption
    interaction). **Accepted as the default posture; the opt-in is the mitigation.**
