# Plugin lifecycle envelope (#154)

Replaces the timeout-driven handshake in `workspace-manager.js` / `loader.js` /
`plugin-broker.js`. The design goal, in the user's words: **CrossTab should be tolerant
enough to wait for a plugin to take hours to get started if that's what the analysis
needs.** Nothing here may kill a plugin that is merely slow.

## 1. What went wrong with the old one

A handshake step returned a promise with a deadline. When the deadline passed the mount
was declared failed, the frame was destroyed and rebuilt, up to three times, then the
workspace showed "did not become ready in time".

The flaw is that a deadline cannot distinguish the two reasons a handshake hangs:

- **Genuine failure** — bad `src`, revoked blob, CSP block, the guest threw before
  signalling, the frame was removed. *Every one of these can announce itself.*
- **Legitimate slowness** — a busy boot, a throttled hidden frame, an occluded window, a
  plugin with a large WASM payload. **Not a failure at all.**

So the timeout was standing in for failure signals that were never built, and in doing so
it misreported the second case as the first. Worse, `sandboxBlobUrl` revoked the frame's
source after 15 s while the deadlines were 20/40/60 s — so a slow frame had its source
pulled and *could not* succeed, making the retry ladder futile.

## 2. Established facts (measured, not assumed)

Measured in Chrome against the running app before designing, because the whole shape
depends on them.

- **Sandboxed opaque-origin iframes run OUT OF PROCESS.** A guest burning 2 500 ms of CPU
  (55.8 M spin iterations) left the host ticking 40 times with a 109 ms maximum gap. A
  plugin that takes 90 seconds — or hours — **does not block the host UI**. Isolation and
  off-thread execution come from the same mechanism; we do not have to choose.
- **The frames really are opaque.** The host gets `SecurityError` touching
  `contentWindow.location` on every live plugin frame.
- **A Worker cannot be spawned inside the cage.** An opaque-origin document's
  `URL.createObjectURL` yields `blob:null/…`, which is not fetchable, so
  `new Worker(blobUrl)` constructs and then fails to load. Adding `worker-src blob:` to
  the CSP does not help — the URL, not the policy, is the blocker.

**Consequence: do not add workers.** They are blocked, and the property they would have
bought (not blocking main) is already held. Threading is *done*; what is missing is
**reporting** and **patience**.

## 3. The envelope

### 3.1 States

One machine per surface, replacing flags spread across `#mounted`, the overlay and the
broker:

```
created → caged → loaded → activated → mounted → live
                                          ↘ (workspace only)
   any → draining → disposed
   any → failed(step, reason)          ← only ever from an EXPLICIT failure signal
```

`failed` is reachable only from a signal that says something failed. Elapsed time never
causes it.

### 3.2 Message envelope

Every host→guest call carries a request id; the guest echoes it. This replaces the single
`#lifecycleAck` slot, where two hooks in flight meant the first never resolved.

```js
host → guest  { __crosstab: v, rid, t: 'load' | 'activate' | 'mount' | 'hook' | 'drain', … }
guest → host  { __crosstab: v, rid, t: 'ok' | 'error', step, … }
guest → host  { __crosstab: v, t: 'progress', step, detail }   // unsolicited
guest → host  { __crosstab: v, t: 'alive', step }              // heartbeat, ~2 s
guest → host  { __crosstab: v, t: 'crashed', step, message, stack }
```

Pending calls live in a `Map<rid, deferred>`, so concurrent hooks are safe.

### 3.3 Failure signals — the replacement for timeouts

Every step gets a definite success *and* a definite failure. Silence must become
impossible except for a true infinite loop, which is contained by the process anyway.

| step | success | failure |
|---|---|---|
| cage load | iframe `load` | iframe `error`; `load` with no `hello` within a tick; CSP violation event |
| module import | `ok{step:'load', manifest}` | `error{step:'load'}` from the guest's try/catch |
| activate | `ok{step:'activate'}` | `error{step:'activate'}` |
| mount | `ok{step:'mount'}` | `error{step:'mount'}` |
| anywhere | — | `crashed` from guest `window.onerror` + `onunhandledrejection` |
| host-side | — | disposal rejects every pending rid |

The guest **must** install global `error` and `unhandledrejection` handlers that post
`crashed`. That is what converts a silent death into a reported one, and it is the single
change that makes deadlines unnecessary.

### 3.4 Progress and liveness

- `progress` messages as the guest passes each step, so the UI can say *what* is slow
  rather than only *that* something is.
- `alive` every ~2 s. The cage document can heartbeat while the plugin's own code is busy,
  so "working hard" is distinguishable from "wedged" **without** a deadline.
- Heartbeats never cause failure. A stopped heartbeat only changes the advisory wording.

### 3.5 The one timer, and what it may do

A single host-side advisory timer per mount. On expiry it may **only** change the UI:

> Still starting *(step: importing module)* — [Keep waiting] [Retry]

It may not tear down, rebuild, or mark anything failed. Retry is user-initiated, always.
Nothing else in the system has a deadline.

Corollary: `sandboxBlobUrl` must revoke on the iframe's `load` event or on dispose —
**never on a wall clock**. A source that expires mid-load is a self-inflicted failure.

### 3.6 Teardown

- `drain` (the current `deactivate`) is sent with **no deadline** and awaited, so a plugin
  can flush properly. Today it races a 500 ms timer and a slower flush is silently lost.
- It must complete **before** the project boundary advances, or #153's epoch guard will
  correctly drop the write and the hook will appear wired while doing nothing.
- Only after `drained` (or explicit user cancel) does the host `terminate`/remove. Killing
  is legitimate when a *person* asked for it.

## 4. Boot cost

Off-thread does not mean free: a catalogue re-probe spawns a process per plugin,
sequentially, for ~60 built-ins.

- Probe **lazily** — on first use rather than all at boot — so a version bump does not
  cost a full sweep.
- Or probe with a small concurrency cap; they are off-thread, so parallelism is cheap in
  wall-clock and bounded in memory.
- Mount workspaces on first tab view (`addTab` already accepts `onShow`), not eagerly at
  reconcile.

## 5. Migration

Each stage is independently shippable and independently verifiable.

1. **Blob lifetime → frame lifetime.** Smallest change, removes the self-inflicted abort.
   Verify the symptom on a cold boot.
2. **Guest crash reporting** — global handlers, `progress`, `alive`.
3. **rid-keyed acks**, replacing the single slot.
4. **Advisory-only UI**, deleting the retry ladder and every mount deadline.
5. **Lazy mount + lazy probe.**
6. **Drain with no deadline**, sequenced before the epoch advances.

Stage 1 alone may resolve the reported bug; stages 2–4 are what make it *stay* fixed,
because after them a hang is always either reported or genuinely infinite.

## 6. Built — outcomes

All stages built and verified in Chrome against the running app.

| measurement | before | after |
|---|---|---|
| CAQDAS workspace mount | 3 × 20 s attempts, then failed | **505 ms** |
| full 60-plugin re-probe + boot | the condition that broke mounts | **513 ms** |
| workspace mount straight after that sweep | — | **414 ms** |
| single manifest probe | — | **24 ms** |
| console errors on a clean run | 5 mount failures | **0** |

**Stage 5b (lazy probe) was deliberately NOT built.** The measurement says a full sweep
costs ~1.4 s; it only looked catastrophic because every probe was racing the 15 s revoke.
Building lazy probing would have been speculative complexity chasing a cost that the real
fix removed. Measure, then decide.

**Plugins needed no migration.** The protocol changes are host↔guest only — ,
, ,  are all handled in . Plugin modules see
the same  surface and the same hook names (, ,
), so  and  were verified unchanged rather
than ported. Keeping the plugin-facing contract stable through an internal rewrite is the
point of having the envelope in the first place.
