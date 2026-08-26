/**
 * @file project-sync.js
 * Ties the {@link ProjectStore} (OPFS) to the live {@link DatasetManager}: the
 * File-menu project commands, the current-project binding, and **autosave**.
 *
 * A project is a *living document*. Once it has a name (first save), every change
 * to any open dataset — a transform, an appended/joined source, a derived dataset,
 * a dataset added/removed, the active switch — schedules a debounced save of the
 * whole project. Autosave is cheap: only datasets whose *sources* changed get
 * their Parquet rewritten (tracked in `#sourcesDirty`); everything else just
 * updates `project.json` (see {@link ProjectStore#save} `writeSourcesFor`).
 *
 * Because the project holds independent copies of its datasets, autosaving them
 * is safe — it never touches the shared building-block library.
 */

import { CoreEvents } from './event-bus.js';
import { DATASETS_CHANGED } from './dataset-manager.js';
import { ASSETS_CHANGED } from './asset-store.js';
import { ProjectStore, FOLDER_PROJECT_ID, buildManifest } from './project-store.js';
import { attachLiveDoc } from './live-sync.js';
import { BlobExchange, sourceRefs, assetRefs } from './gap-fill.js';
import { debug } from './debug.js';
import { liveOps } from './op-log.js';
import { rememberFolder, rememberRemote, listLocations, forgetLocation, ensureReadWrite } from './project-locations.js';
import { passphraseFor, shouldEncrypt, PASSPHRASE_ABORT } from './at-rest.js';
import { syncFolderProject, manifestsEqual } from './folder-sync.js';
import { PLUGIN_STATE, pluginOpsOf, isPluginOp, pluginTarget, foldPluginOpinions, migrateLegacyActivePlugins } from './plugin-state.js';
import { SHARE_STATE, isShareOp, shareOpsOf, shareOp, foldSharing } from './share-state.js';
import { isAuthError } from './storage-driver.js';
import { showConflictDialog } from './conflict-ui.js';
import { FolderBackend, OpfsBackend } from './storage-backend.js';
import { showEncryptionSettings } from './encryption-settings.js';
import { ensureCollabIdentity, roomFor, inviteLinkFor } from './live-invite.js';

const DEBOUNCE_MS = 800;

/** Bus event: the current project's name/binding changed (drives the sidebar header). */
export const PROJECT_CHANGED = 'project:changed';

/**
 * How often to check a REMOTE project for a co-author's write.
 *
 * A folder poll reads a local file every 3s, which costs nothing. A remote poll is a
 * network round trip against a provider that rate-limits, once per open tab — so this
 * trades a slower pickup for not being the reason someone gets throttled mid-save.
 */
const REMOTE_POLL_MS = 15000;

// Gap-fill chunks carry raw Parquet bytes (a Uint8Array). Trystero's action channel
// only transmits binary when the WHOLE payload is a TypedArray; a Uint8Array nested
// inside a plain object gets JSON-serialised to a numeric-keyed object and arrives
// corrupt (the SHA-256 check then rejects it, so a new dataset silently never lands).
// So base64 the bytes across the wire — the SourceExchange stays binary end-to-end.
function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000; // fromCharCode.apply chokes on huge spreads; walk it in windows
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The ops that introduce Parquet-backed data. */
export function isSourceOp(op) {
  return op?.type === 'load' || op?.type === 'append' || op?.type === 'join';
}

/**
 * Does applying `mergedLog` require rebuilding the data tier, or can the (expensive)
 * DuckDB reload be skipped and only the workspace/analysis tiers applied?
 *
 * Two independent reasons to rebuild, and missing the second one cost a peer its rows:
 *
 *  1. **The log's shape moved** — a dataset or collection op appeared or vanished. This
 *     is the everyday case, and comparing op ids is enough to see it.
 *  2. **Bytes we were waiting for arrived.** Gap-fill does not touch the log at all: the
 *     op already described the dataset perfectly, only its Parquet was late. So the
 *     re-apply that gap-fill fires to consume those bytes sees a log identical to the one
 *     it applied byte-less a moment earlier. Judged on shape alone it is a no-op — and
 *     the bytes sit in the cache forever while the peer displays the dataset's name and
 *     nothing else, permanently.
 *
 * @param {object[]} localLog     my current log (byte-less is fine — only ids are read)
 * @param {object[]} mergedLog    the log about to be applied
 * @param {Iterable<string>} [awaitingBytes]  source op ids the last apply had no bytes for
 * @param {{has: (id: string) => boolean}} [heldBytes]  bytes received since (a Map/Set)
 */
export function needsDataRebuild({ localLog = [], mergedLog = [], awaitingBytes = [], heldBytes = null } = {}) {
  const isDsOrColl = (op) => op.owner === 'core' && typeof op.target === 'string'
    && (op.target.startsWith('ds:') || op.target.startsWith('coll/'));
  const sig = (log) => JSON.stringify(log.filter(isDsOrColl).map((o) => o.id).sort());
  if (sig(localLog) !== sig(mergedLog)) return true;
  if (!heldBytes) return false;
  for (const id of awaitingBytes) if (heldBytes.has(id)) return true;
  return false;
}

/** The media-asset tier of a flat one-true-log — used where a bundle arrives as just
 * `log` (a `.crosstab` import, a merge result) rather than pre-split by ProjectStore. */
/** The project-METADATA projection: the name, folded from `setProjectName` ops (#149
 * A3). The name is user data, and it was the one piece that lived only in
 * `#binding.name` — merge took `mine ?? theirs` and contentSig ignored it, so a
 * co-author's rename never propagated and our next save silently reverted it (the same
 * family as the move-to-folder rename bug). As an op it merges, carries its author, and
 * travels like everything else. */
export const PROJECT_META = {
  key: 'projectMeta',
  match: (op) => op.owner === 'core' && op.target === 'project/name',
  fold: (ops) => {
    let name = null;
    for (const op of liveOps(ops)) if (op.type === 'setProjectName') name = op.payload?.name ?? null;
    return { name };
  },
};

/** The project-metadata tier of a flat log (a `.crosstab` import, a merge result). */
const metaOpsOf = (log) =>
  (log ?? []).filter((o) => o.owner === 'core' && o.target === 'project/name');

const assetOpsOf = (log) =>
  (log ?? []).filter((o) => o.owner === 'core' && typeof o.target === 'string' && o.target.startsWith('asset:'));

/** The item tier of a flat log (#152). Owner-agnostic: unlike `asset:`, item records are
 * owned by whoever wrote them (core or a plugin), and the tier is addressed by prefix. */
const itemOpsOf = (log) =>
  (log ?? []).filter((o) => typeof o.target === 'string' && o.target.startsWith('item:'));

/**
 * What to do about a folder key that is no longer the folder's — the whole policy, as a
 * pure function so it can be tested. The behaviour it governs is safety-critical (it is
 * what stops a peer writing files its collaborators cannot read) and lived untested
 * inside a private method until 2026-08-10.
 *
 * Three outcomes rather than two. "Unreadable" earns its own because it is usually
 * TRANSIENT: a rekey rewrites the encryption meta and then re-encrypts every file, so a
 * poll landing mid-write legitimately sees a truncated one. Halting on the first
 * glimpse would turn every rekey into a session-ending event for every peer. But the
 * patience has to be bounded — silently never saving is its own kind of data loss — so
 * it becomes a halt once it persists.
 *
 * @param {{current:boolean, reason:string}} status  from ProjectStore#keyStatus
 * @param {number} unreadableRun  consecutive polls that could not read the meta
 * @returns {{action:'continue'|'skip'|'halt', reason:string}}
 */
export function keyHaltDecision(status, unreadableRun = 0) {
  if (status?.current) return { action: 'continue', reason: '' };
  if (status?.reason === 'unreadable' && unreadableRun < UNREADABLE_TOLERANCE) {
    return { action: 'skip', reason: 'the folder’s protection file could not be read — retrying' };
  }
  const reason = {
    rekeyed: 'Its passphrase was changed by someone else.',
    unprotected: 'Its protection was removed by someone else.',
    protected: 'It was protected by someone else.',
    unreadable: 'Its protection file could not be read.',
  }[status?.reason] ?? 'Its protection changed.';
  return { action: 'halt', reason };
}

/** Consecutive unreadable polls tolerated before halting (~12 s at the 3 s poll). */
export const UNREADABLE_TOLERANCE = 4;

export class ProjectSync {
  #store;
  #datasets;
  #ui;
  #menus;
  #bus;
  #results;
  #statusEl;
  /** () => string[]|null : load keys of the plugins active right now (persisted
   * with the project). Null ⇒ feature unavailable ⇒ don't record. */
  #getActivePlugins;
  /** (keys: string[]) => Promise : drive the active plugin set to a project's
   * saved list when opening it. */
  #applyActivePlugins;
  /** () => object[] : the workspace tier's ops (the `ws:` slice of the log), folded into
   * `manifest.log` on save (#148). Null ⇒ feature unavailable. */
  #getWorkspaceOps;
  /** () => the media-asset tier's ops, and the restore hook (#149 A5). */
  /** The shared project log — this tier owns the project's own metadata (#149 A3). */
  #log = null;
  #getAssetOps;
  #applyAssetOps;
  /** Byte-level access to the asset store, for live gap-fill (#155).
   * `{ held(), read(id), store(id, bytes, meta) }`. */
  #assetBytes = null;
  /** The live ASSET exchange (the sibling of #liveExchange, which carries Parquet). */
  #liveAssetExchange = null;
  /** () => the item tier's ops, and the restore hook (#152 Layer 1). */
  #getItemOps;
  #applyItemOps;
  /** (ops) => void : restore the workspace tier from its ops on open. */
  #applyWorkspaces;
  /** () => object[] : snapshot the Output tab's result model (#103). */
  #getOutput;
  /** (model) => void : restore (or clear) the Output tab on open/switch. */
  #applyOutput;
  /** () => object[] : snapshot the analysis log (the script's analysis steps, #132). */
  #getAnalysisLog;
  /** (entries) => void : restore (or clear) the analysis log on open/switch. */
  #applyAnalysisLog;
  /** Regenerate output for analyses that arrived from a co-author (#156). */
  #materializeAnalyses;
  /** Reconcile the live plugin set from the log's `plugin:` tier (#157). */
  #applyProjectPlugins;
  /** `[{key, activated}]` for every INSTALLED plugin — the seed's raw material (#157). */
  #getPluginStates;
  /** Serialises materialisation so two peer runs never interleave in the pane. */
  #materializeChain = Promise.resolve();
  /** () => string[] : every installed plugin's identifiers (key + manifest id), so
   * a recorded plugin can be told apart from one this install simply doesn't have. */
  #pluginIdentities;
  #getMergers;
  /** () => ((owner, collection) => boolean) — collections that want concurrent
   * same-record edits surfaced rather than silently decided (#166). */
  #getSurfaces;
  /** Live co-authoring (#148 step 6): a LiveDoc riding the presence session's op
   * channel, or null when not co-authoring. Publishes local edits + applies merged
   * remote state (reusing local Parquet — no disk round-trip). */
  #liveDoc = null;
  #liveSession = null;
  #livePublishTimer = null;
  /** Gap-fill (#148 step 6c): fetch Parquet a co-author has that we lack (new dataset
   * / cold join). Received bytes wait in #liveSourceBytes; #liveLastManifest is re-
   * applied once they arrive. */
  #liveExchange = null;
  #liveSourceBytes = new Map();
  #liveLastManifest = null;
  /** Source op ids the last apply wanted but had no bytes for. The rebuild fast-path
   * keys off the op-log's SHAPE, which gap-fill never changes — the arriving bytes are
   * exactly the thing the log already described. Without this the re-apply that
   * gap-fill fires to consume them would take the fast path and drop them. */
  #liveMissingBytes = new Set();
  /** In-flight byte snapshot shared across one gap-fill serve burst (see the source
   * exchange's `read`). @type {Promise<object>|null} */
  #servingSnapshot = null;
  #coauthorPeers = 0; // peers actually co-authoring (drives "waiting" vs "co-authoring")
  /** Serialises merge applies. Each apply snapshots then disposes+rebuilds DuckDB
   * tables; two overlapping applies (a merge tick + a gap-fill re-apply, both fired
   * un-awaited) would race — one drops a table the other is exporting. Chained here so
   * they run strictly one-at-a-time. */
  #applyChain = Promise.resolve();
  #conflictAbort = null; // aborts an open conflict dialog when a peer resolves it first
  /** Plugin identifiers recorded in the open project that AREN'T installed here —
   * carried forward verbatim on every save so the association survives until the
   * plugin is added and resolves (#102). Empty for a fully-resolved project. */
  #unresolvedPlugins = [];
  /** Load keys of plugins the user **deactivated but chose to keep with the open
   * project** (#118) — installed here yet not currently active, so they're neither
   * in activatedKeys() nor in #unresolvedPlugins. Merged into the saved plugin set
   * so a save doesn't silently drop a plugin whose project data we're preserving.
   * Session-scoped: cleared on open/new (a reopened project reactivates them). */
  #keptPlugins = new Set();

  /** Current project: `{ id, name }` once saved/opened, else `null`. */
  #binding = null;
  /** True while a picked folder (FSA) is the active backend, vs OPFS (#143). */
  /**
   * Is a PICKED DIRECTORY attached — the File System Access handle, specifically?
   *
   * All that is left of what used to be "folder mode". Everything about how the bytes
   * behave — merge, poll, layout, re-key checks — now comes from the driver's declared
   * capabilities, because keying those on this flag produced four bugs: saves that
   * overwrote a peer, a poll that never ran, a re-key that went unnoticed, and a project
   * list that queried the wrong store.
   *
   * What genuinely remains folder-specific is the HANDLE: a write-permission re-grant
   * needs a user gesture, the OS double-click shortcuts are files in a real directory, and
   * the registry holds a structured-cloneable handle rather than an address. Those are the
   * File System Access API's requirements, not the engine's opinion about storage.
   */
  /** The backend the open project lives on, or null for local storage (#172). */
  #backend = null;
  /** Folder writes halted because its key changed under us (#144). Cleared by reopening. */
  #folderKeyStale = false;

  /** Consecutive polls that could not read the folder's encryption meta. A rekey
   * rewrites that file, so a tick landing mid-write legitimately sees nothing usable;
   * this rides out the gap rather than halting the session over it. */
  #metaUnreadable = 0;
  /** A dedicated OPFS store for LISTING in-browser projects even while the main store
   * is folder-backed — so the launcher/sidebar list always shows OPFS projects, never
   * the current folder's single project (which is surfaced via the folder registry). */
  #opfs = new ProjectStore();
  /** The registry id of the currently-open location, so the sidebar can exclude the
   * active one from its list — true of a folder, a Dropbox path or a WebDAV address. */
  #activeLocationId = null;
  /** The active project's collab identity (#148 step 5 / #143) — a stable id + secret
   * that derive the live signaling room. Minted for folder projects (they're the
   * shareable ones) and carried in the manifest so both peers compute the same room.
   * Null for a plain OPFS project (not shared). */
  /**
   * Is a project OPEN? (#158)
   *
   * Distinct from `#binding !== null`, which only says whether a project has been
   * *saved*: an unsaved "Untitled project" is very much open. This is the third state
   * the engine never had — nothing open at all — and its absence is why the launcher and
   * an invite joiner each had to fake one.
   *
   * A faked project is indistinguishable from a real empty one, and everything that
   * treats it as real does damage: its blank dataset merged into a co-author's project,
   * and its plugin set — asserted with the newest clock in the room — silently
   * reconfigured the host's. Both were patched with guards; the guards go away because
   * the state they were guarding against no longer occurs.
   *
   * While closed there is nothing to save, nothing to publish, and no opinion to
   * assert. "Start blank" is NOT this state: it opens a real project that happens to be
   * empty.
   */
  #open = false;
  #collabId = null;
  #collabSecret = null;
  /** Room joined from an invite LINK (#156), before any peer manifest has arrived.
   * A link carries the DERIVED room id, not the project uuid, so the joiner cannot
   * compute the room itself until it receives the owner's collab identity over the
   * wire. Until then this override is the only way in. @type {{roomId,secret}|null} */
  #inviteRoom = null;
  /** Last project manifest we wrote/saw in the folder — lets the poll detect a
   * peer's write cheaply (readManifest + compare) without a full merge each tick. */
  #lastManifest = null;
  /** Folder-mode change-detection poll timer. */
  #pollTimer = null;
  /** Dataset ids whose Parquet sources changed since the last save. */
  #sourcesDirty = new Set();
  /** True while loading a project, to suppress autosave during reconstruction. */
  #loading = false;
  /** Once true, the first change with no project auto-starts an Untitled one. Set
   * after boot so the seed load doesn't spawn a project. */
  #armed = false;
  /** Guard against re-entrant auto-create from a burst of changes. */
  #creating = false;
  /** True if any change arrived *during* the initial auto-create (when there's no
   * binding yet to schedule against) — triggers a catch-up save once it's done, so
   * a rapid burst right after the first edit is never lost. */
  #changedWhileCreating = false;

  #timer = null;
  #saving = false;
  #dirtyAgain = false;
  /** Unsaved changes exist since the last successful save. Drives #settle so a
   * change made just before switching projects (e.g. toggling a plugin) is
   * flushed to the current binding rather than dropped. */
  #dirty = false;

  /**
   * @param {Object} deps
   * @param {import('./project-store.js').ProjectStore} deps.projectStore
   * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
   * @param {import('./ui-service.js').UiService} deps.ui
   * @param {import('./menu-shell.js').MenuShell} deps.menus
   * @param {import('./event-bus.js').EventBus} deps.bus
   * @param {{appendError: Function}} deps.results
   * @param {HTMLElement} deps.statusEl
   * @param {() => (string[]|null)} [deps.getActivePlugins] - Snapshot the active
   *   plugin keys to persist with the project (null ⇒ don't record).
   * @param {(opinions: Map<string, boolean>) => Promise<void>} [deps.applyProjectPlugins] -
   *   Reconcile the live plugin set from the log's `plugin:` tier (#157). Replaces the
   *   old set-apply, which could not express "the project says this one is OFF".
   * @param {(keys: string[]) => Promise<void>} [deps.applyActivePlugins] - Restore
   *   a project's saved plugin set on open.
   */
  constructor({ projectStore, datasets, ui, menus, bus, results, statusEl, getActivePlugins, applyActivePlugins, getWorkspaceOps, applyWorkspaces, getAssetOps, applyAssetOps, assetBytes, getItemOps, applyItemOps, projectLog, getOutput, applyOutput, getAnalysisLog, applyAnalysisLog, materializeAnalyses, applyProjectPlugins, getPluginStates, pluginIdentities, getMergers, getSurfaces }) {
    this.#store = projectStore;
    this.#datasets = datasets;
    this.#ui = ui;
    this.#menus = menus;
    this.#bus = bus;
    this.#results = results;
    this.#statusEl = statusEl;
    this.#getActivePlugins = getActivePlugins ?? null;
    this.#applyActivePlugins = applyActivePlugins ?? null;
    this.#getWorkspaceOps = getWorkspaceOps ?? null;
    this.#applyWorkspaces = applyWorkspaces ?? null;
    this.#log = projectLog ?? null;
    this.#log?.register(PROJECT_META);
    this.#log?.register(PLUGIN_STATE); // #157: activation is project state, on the log
    this.#log?.register(SHARE_STATE); // may this project be shared at all — same argument
    this.#getAssetOps = getAssetOps ?? null;
    this.#applyAssetOps = applyAssetOps ?? null;
    this.#assetBytes = assetBytes ?? null;
    this.#getItemOps = getItemOps ?? null;
    this.#applyItemOps = applyItemOps ?? null;
    this.#getOutput = getOutput ?? null;
    this.#applyOutput = applyOutput ?? null;
    this.#getAnalysisLog = getAnalysisLog ?? null;
    this.#applyAnalysisLog = applyAnalysisLog ?? null;
    this.#materializeAnalyses = materializeAnalyses ?? null;
    this.#applyProjectPlugins = applyProjectPlugins ?? null;
    this.#getPluginStates = getPluginStates ?? null;
    this.#pluginIdentities = pluginIdentities ?? null;
    this.#getMergers = getMergers ?? null;
    this.#getSurfaces = getSurfaces ?? null;
  }

  /** Merger map for a sync (core + active builtin plugins), or core-only if unwired. */
  #mergers() {
    return (this.#getMergers ? this.#getMergers() : null) ?? { core: { strategy: 'three-way' } };
  }

  /** Plugin identifiers the OPEN project references but this install can't resolve
   * (not registered here) — used to warn when a user adds a local plugin whose id
   * matches one the project expects (#102). */
  referencedPlugins() {
    return [...this.#unresolvedPlugins];
  }

  /** Keep an installed-but-now-deactivated plugin associated with the open project,
   * so a save doesn't drop it from the plugin set (#118). Keyed like activatedKeys()
   * — by load key. Used when the user deactivates a plugin that has project data and
   * picks "keep, just deactivate". */
  keepPlugin(key) {
    if (!key || this.#keptPlugins.has(key)) return;
    this.#keptPlugins.add(key);
    this.#noteAssociationChange();
  }

  /** Drop a plugin from the open project's association entirely (#118): forget it
   * from the kept set and from any unresolved record (matched by load key OR manifest
   * id — bundles record ids, in-app saves record keys). Deactivation already removes
   * it from activatedKeys(); this clears the carried-forward buckets so it's truly
   * gone from the saved plugin set. */
  dropPlugin({ key, id } = {}) {
    let changed = this.#keptPlugins.delete(key);
    const before = this.#unresolvedPlugins.length;
    this.#unresolvedPlugins = this.#unresolvedPlugins.filter((x) => x !== key && x !== id);
    changed = changed || this.#unresolvedPlugins.length !== before;
    if (changed) this.#noteAssociationChange();
  }

  /** A project↔plugin association changed (kept/dropped) — persist it into an
   * existing project. Like {@link #onPluginsChanged}, an unbound session ignores it
   * (the next real save captures the set anyway). */
  #noteAssociationChange() {
    if (this.#loading || !this.#binding) return;
    this.#dirty = true;
    this.#schedule();
  }

  /** The recorded plugin identifiers this install can't resolve to an installed
   * plugin (matched by key OR manifest id) — the ones to carry forward on save so
   * the association isn't lost (#102). */
  /**
   * Reconcile the live plugin set from the log, migrating a legacy scalar on the way
   * (#157). Returns the opinions applied.
   *
   * Order matters: migrate FIRST, then fold, so a legacy project's implied activations
   * are in the log before anything reads it — and so the very next save carries ops
   * rather than the scalar. `migrateLegacyActivePlugins` defers to any op already
   * present, so a project that has been through this once is untouched by its own
   * stale scalar.
   */
  async #applyPluginState(bundle, { migrate = true, receive = true } = {}) {
    if (!this.#log || !this.#applyProjectPlugins) return new Map();
    // The ops live in the saved manifest's log; put them back before folding, exactly as
    // the name tier does. Without this the fold reads whatever the PREVIOUS project left
    // in memory — the opened project's own record of itself never arrives.
    if (receive) {
      this.#log.clearWhere(isPluginOp);
      this.#log.receiveOps(pluginOpsOf(bundle?.log));
      // Same reason, same place: fold the opened project's sharing decision, not the
      // previous project's. Missing this is how a closed project would reopen shareable.
      this.#log.clearWhere(isShareOp);
      this.#log.receiveOps(shareOpsOf(bundle?.log));
    }
    if (migrate && Array.isArray(bundle?.activePlugins) && bundle.activePlugins.length) {
      const opinions = foldPluginOpinions(this.#log.slice(isPluginOp));
      const ops = migrateLegacyActivePlugins(bundle.activePlugins, opinions, (x) => x);
      for (const op of ops) this.#log.append(op);
      if (ops.length) debug('project', 'migrated legacy activePlugins to ops', { count: ops.length });
    }
    const opinions = foldPluginOpinions(this.#log.slice(isPluginOp));
    if (opinions.size) {
      try {
        await this.#applyProjectPlugins(opinions);
      } catch (err) {
        console.warn('[project] applying the project plugin set failed', err);
      }
    }
    return opinions;
  }

  /**
   * Record an opinion for every installed plugin the project has not yet spoken about
   * (#157) — its state at this moment, on or off.
   *
   * Activated plugins are project state, so a project has to be able to say what its set
   * IS, not merely how it deviates from whatever the last project left switched on. That
   * needs explicit "off" as much as explicit "on": with activations alone, opening a
   * project that never used the spatial plugin would leave spatial running because the
   * previous project had turned it on and this one never contradicted it.
   *
   * Fills GAPS rather than running once. An earlier version bailed the moment the log
   * held any plugin op at all, which meant toggling one plugin before the project's
   * first save silenced the whole statement — the project then recorded that single
   * deviation and nothing else. Gap-filling is idempotent, survives that order, and
   * gives a plugin installed later an opinion at the next snapshot instead of leaving it
   * permanently unspoken-for.
   *
   * At snapshot rather than at creation because the launcher picks the set AFTER the
   * project exists; by the first save the answer has settled.
   */
  #seedPluginState() {
    if (!this.#log || !this.#getPluginStates || !this.#open) return;
    // Never while co-authoring: seeding ASSERTS a whole set with fresh stamps that beat
    // everything already in the shared log, so one peer filling a gap would impose its
    // set on everyone else. (The joiner case this also covered is gone — a joiner now
    // holds no project at all until the host's arrives, so it has nothing to assert.)
    if (this.#liveDoc) return;
    const states = this.#getPluginStates() || [];
    if (!states.length) return;
    const opinions = foldPluginOpinions(this.#log.slice(isPluginOp));
    let n = 0;
    for (const { key, activated } of states) {
      if (!key || opinions.has(key)) continue; // already spoken for — say nothing
      this.#log.append({
        target: pluginTarget(key), owner: 'core',
        type: activated ? 'activatePlugin' : 'deactivatePlugin', payload: { key },
      });
      n++;
    }
    if (n) debug('project', 'recorded plugin state for the project', { count: n });
  }

  #computeUnresolved(recorded) {
    if (!Array.isArray(recorded) || !recorded.length) return [];
    const have = new Set(this.#pluginIdentities ? this.#pluginIdentities() : []);
    return recorded.filter((x) => x && !have.has(x));
  }

  activate() {
    if (!this.#store.available) {
      this.#setStatus('Projects unavailable (no OPFS)');
      return;
    }
    this.#menus.register({ id: 'core:proj-new', path: ['File'], label: 'New project', order: 1, command: () => void this.newProject() });
    // Open / Store in / Manage live in the project manager (#173), registered by app.js.
    // There is deliberately no Save: everything autosaves, "Save project…" was naming and
    // "Save project as…" was duplicating — a label that handed people a fork when they
    // wanted a backup. Naming is rename; forking is duplicate; the flush is automatic.
    if (typeof window !== 'undefined' && window.showDirectoryPicker) {
      // Folder open/move/close are rows in the manager's rail, not menu items — the
      // whole point of #173 being that a location is a dimension inside a verb.
    }
    // Per-project at-rest protection for OPFS projects (#144) — set/remove a passphrase
    // on the CURRENT project (each project has its own). Folder projects are protected
    // via their folder passphrase instead, so these guard against that case.
    this.#menus.register({ id: 'core:proj-protect', path: ['File'], label: 'Protect this project…', order: 8, command: () => void this.protectProject() });
    this.#menus.register({ id: 'core:proj-changepass', path: ['File'], label: 'Change passphrase…', order: 9, command: () => void this.changePassphrase() });
    this.#menus.register({ id: 'core:proj-unprotect', path: ['File'], label: 'Remove protection…', order: 10, command: () => void this.unprotectProject() });
    this.#menus.register({ id: 'core:encryption-settings', path: ['File'], label: 'Encryption settings…', order: 10, command: () => showEncryptionSettings() });
    this.#bus.on(CoreEvents.DATA_CHANGED, (s) => this.#onChange(s));
    this.#bus.on(DATASETS_CHANGED, () => this.#onChange(null));
    this.#bus.on(CoreEvents.PLUGINS_CHANGED, () => this.#onPluginsChanged());
    this.#bus.on(CoreEvents.WORKSPACE_CHANGED, () => this.#onChange(null));
    this.#bus.on(ASSETS_CHANGED, () => this.#onChange(null)); // an asset landed (#149 A5)
    // An item record landed (#152). Appending to the log emits nothing by itself, so
    // without this the manifest is written from a snapshot taken before the record
    // existed — the record lives in memory and is gone on reload. Same failure the asset
    // tier hit in #149 A5; verified in-browser before the fix (item ops absent from
    // project.json) and after (present, no manual nudge).
    this.#bus.on(CoreEvents.ITEMS_CHANGED, () => this.#onChange(null));
    this.#bus.on('output:written', () => this.#onChange(null));
    this.#bus.on('output:cleared', () => this.#onChange(null)); // persist a user "Clear output"
    this.#setStatus();
    this.#emitProject();
  }

  /** Broadcast the current project name so the sidebar header can show it. */
  /** Whether a project is open (#158). False at the launcher and while waiting to be
   * let into a co-authoring room — both of which used to fake an empty project. */
  get hasProject() {
    return this.#open;
  }

  /**
   * Declare that a project is coming into being (#158) — the launcher picking a source,
   * an importer landing a file. Purely the state flag: the caller supplies the contents.
   *
   * Separate from {@link newProject} because the launcher's demo paths load their data
   * themselves and must not have it cleared out from under them a moment later.
   */
  beginProject() {
    this.#open = true;
  }

  /**
   * Close the project: no datasets, no log, no binding — the launcher state.
   *
   * Deliberately NOT `newProject()`. That opens an empty project, which is a different
   * thing and the confusion this whole task exists to end.
   */
  async closeProject() {
    await this.#settle();
    if (this.#storeIsRemote()) this.#detachFolder();
    this.#loading = true;
    try {
      await this.#datasets.loadBundle({ log: [], empty: true });
      this.#applyItemOps?.([]);
      this.#applyAssetOps?.([]);
      this.#applyWorkspaces?.([]);
      this.#applyOutput?.([]);
      this.#applyAnalysisLog?.([]);
      this.#log?.reset();
      this.#binding = null;
      this.#collabId = null;
      this.#collabSecret = null;
      this.#unresolvedPlugins = [];
      this.#keptPlugins.clear();
      this.#sourcesDirty.clear();
      this.#dirty = false;
      this.#open = false;
    } finally {
      this.#loading = false;
    }
    this.#setStatus();
    this.#emitProject();
  }

  #emitProject() {
    this.#bus.emit(PROJECT_CHANGED, { name: this.#binding?.name ?? null });
  }

  // --- save -----------------------------------------------------------------

  /** "Save project…": prompt for a name if unsaved, else force a full save. */
  async saveInteractive() {
    if (this.#binding) {
      await this.#fullSave(this.#binding.id, this.#binding.name);
      return;
    }
    const name = await this.#promptName('Save project', 'My project');
    if (name) await this.#fullSave(null, name);
  }

  /** "Save project as…": always a new project entry, bound to the copy. */
  async saveAs() {
    const base = this.#binding?.name ? `${this.#binding.name} copy` : 'My project';
    const name = await this.#promptName('Save project as', base);
    if (name) await this.#fullSave(null, name);
  }

  /** Run a save attempt, retrying once after a short pause on a transient engine
   * failure before letting it surface. The WASM runtimes can throw a one-off trap
   * (observed on iPad: a DuckDB "out of bounds call_indirect" during the Parquet
   * export, which then succeeded on the next try) — and a dropped save would break the
   * "everything you do is saved" guarantee. The snapshot/export + OPFS write are
   * idempotent, so a retry is safe (#91). A second failure propagates to the caller. */
  async #attemptSave(fn) {
    try {
      return await fn();
    } catch (err) {
      console.warn('[project] save attempt failed — retrying once:', err?.message || err);
      await new Promise((r) => setTimeout(r, 250));
      return fn();
    }
  }

  /** Write the whole project (all datasets' sources + logs) and (re)bind. */
  async #fullSave(id, name) {
    // Default-protect a brand-new OPFS project when the policy is on (#144). Pre-mint
    // the id and set a per-project passphrase so the very first write is already
    // encrypted (never a plaintext version on disk first). Skipping the prompt leaves
    // this one project plaintext — it's asked once, at creation, not on every save.
    if (id == null && !this.#store.flat && !this.#store.encrypted && shouldEncrypt('local')) {
      const pass = await passphraseFor('local-new');
      if (pass) {
        const newId = crypto.randomUUID();
        try {
          await this.#store.unlock(pass, newId); // mints per-project meta + key
          id = newId;
        } catch (err) {
          this.#results.appendError(`Couldn’t set up protection — saving unprotected: ${err.message}`);
          this.#store.lock();
        }
      }
    }
    this.#setStatus('saving', name);
    try {
      const savedId = await this.#attemptSave(async () => {
        const bundle = await this.#snapshot(true); // all sources
        return this.#store.save({ id, name, savedAt: Date.now(), bundle });
      });
      this.#open = true;
      this.#binding = { id: savedId, name };
      this.#sourcesDirty.clear();
      this.#dirty = false;
      this.#setStatus('saved');
      this.#emitProject();
    } catch (err) {
      console.error('[project] save failed', err);
      this.#results.appendError(`Save project failed: ${err.message}`);
      this.#setStatus('error');
    }
  }

  // --- autosave -------------------------------------------------------------

  /** A plugin was enabled/disabled (or a set applied). Persist it — but only into
   * an *existing* project. A plugin toggle alone must not birth an Untitled project
   * (and the launcher applies sets before any binding exists), so unbound = ignore;
   * the set is captured by activatedKeys() at the next real save / on open anyway. */
  #onPluginsChanged() {
    if (this.#loading || !this.#open || !this.#binding) return;
    this.#dirty = true;
    this.#schedule();
  }

  #onChange(summary) {
    if (this.#loading) return;
    // Nothing is open — but a change ARRIVING is exactly how a project begins (an
    // import, a demo load, a peer's first manifest). `#armed` already gated this so the
    // boot seed wouldn't spawn one; now the state it was standing in for is explicit.
    if (!this.#open) {
      // …but only if there is actually something there. An import creates its dataset
      // BEFORE announcing the change, so a real beginning always has one; a bare signal
      // with nothing behind it is noise, and treating it as a project start is how the
      // launcher ends up sitting on an autosaved "Untitled project" nobody asked for.
      if (!this.#armed || this.#datasets.activeId == null) return;
      this.#open = true;
    }
    this.#dirty = true;
    this.#scheduleLivePublish(); // stream this edit to live co-authors (#148 step 6), if any
    // A source-changing op means that dataset's Parquet must be rewritten. With the
    // universal log, undo/redo/rewind can also add or drop a source op, so they
    // mark sources dirty too (keeps the saved Parquet set in step with the log).
    // `binned` is here so a dataset deleted before the project's first full save still
    // gets its Parquet written — it leaves the live set, so nothing else would mark it.
    if (summary && ['load', 'replace', 'append', 'join', 'restore', 'undo', 'redo', 'rewind', 'binned'].includes(summary.reason)) {
      if (summary.datasetId != null) this.#sourcesDirty.add(summary.datasetId);
    }
    if (this.#binding) {
      this.#schedule();
      return;
    }
    // No project yet: the first real change auto-starts an autosaving "Untitled
    // project" so work is never lost. (Armed after boot, so the seed doesn't.)
    if (!this.#armed) return;
    if (this.#creating) {
      // A change landed mid-create — it can't schedule yet (no binding); remember
      // so #autoCreate does a catch-up save once the project exists.
      this.#changedWhileCreating = true;
      return;
    }
    this.#creating = true;
    this.#creation = this.#autoCreate();
    void this.#creation;
  }

  /** Enable auto-creating an Untitled project on the next change. Called once the
   * app has booted, so the demo-seed load doesn't spawn one. */
  arm() {
    this.#armed = true;
  }

  /**
   * Run a launcher data-seed load (Demo / Blank) without it counting as a user
   * change that auto-creates a project — the same exemption the boot seed gets by
   * load order. Without this, *re-opening* the launcher and picking a demo (which
   * happens after boot has armed auto-create) would spawn an "Untitled project"
   * from merely loading regenerable demo data, with no work done. The session is
   * left armed afterwards, so the user's first real change still autosaves — the
   * "everything you do is saved" promise is untouched; only loading throwaway demo
   * data is exempt.
   *
   * @param {() => Promise<void>} fn - performs the data load (newProject + load).
   */
  async loadingSeed(fn) {
    const prevArmed = this.#armed;
    this.#armed = false;
    try {
      return await fn();
    } finally {
      this.#armed = prevArmed;
    }
  }

  /**
   * The current project id, creating the autosaving "Untitled project" first if there
   * isn't one. Media needs this: an asset's bytes live in the project directory, so a
   * file dropped into a never-saved project has to bring the project into existence
   * before it has anywhere to go (#149 A5). Concurrent callers share one creation.
   * @returns {Promise<string|null>}
   */
  async ensureProject() {
    if (this.#binding) return this.#binding.id;
    if (!this.#creating) {
      this.#creating = true;
      this.#creation = this.#autoCreate();
    }
    try { await this.#creation; } catch { /* surfaced by the save path */ }
    return this.#binding?.id ?? null;
  }

  /** In-flight #autoCreate, so ensureProject can await a creation already under way. */
  #creation = null;

  async #autoCreate() {
    this.#recordName('Untitled project');
    try {
      await this.#fullSave(null, 'Untitled project');
    } finally {
      this.#creating = false;
    }
    // Catch up on any changes that arrived during creation: #fullSave snapshotted
    // (and cleared the dirty set) at an earlier point, so re-save the now-final
    // state in full. Loop in case more changes land during the catch-up.
    while (this.#changedWhileCreating && this.#binding) {
      this.#changedWhileCreating = false;
      await this.#fullSave(this.#binding.id, this.#binding.name);
    }
  }

  #schedule() {
    this.#setStatus('saving');
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#flush(), DEBOUNCE_MS);
  }

  async #flush() {
    this.#timer = null;
    if (!this.#binding) return;
    if (this.#saving) {
      this.#dirtyAgain = true;
      return;
    }
    this.#saving = true;
    const dirty = this.#sourcesDirty;
    this.#sourcesDirty = new Set();
    try {
      if (this.#syncedElsewhere()) {
        await this.#attemptSave(() => this.#mergeSave(dirty)); // merge-aware (never clobbers a peer)
      } else {
        await this.#attemptSave(async () => {
          const bundle = await this.#snapshot(false, dirty);
          return this.#store.save(
            { id: this.#binding.id, name: this.#binding.name, savedAt: Date.now(), bundle },
            { writeSourcesFor: dirty },
          );
        });
      }
      this.#dirty = false;
      this.#setStatus('saved');
    } catch (err) {
      console.error('[project] autosave failed', err);
      // Keep the dirty set so the next attempt re-tries those sources.
      for (const id of dirty) this.#sourcesDirty.add(id);
      this.#setStatus('error');
    } finally {
      this.#saving = false;
    }
    if (this.#dirtyAgain) {
      this.#dirtyAgain = false;
      this.#schedule();
    }
  }

  /** Before switching projects: flush any unsaved change to the CURRENT binding,
   * then quiesce. Replaces a plain "cancel" — cancelling dropped a change made
   * just before the switch (e.g. a plugin toggle whose debounced save hadn't
   * fired). Safe against the mid-switch clobber a cancel guarded: it always writes
   * to the current binding's own id and awaits in-flight saves first, so by the
   * time the caller loads the next project nothing is pending or racing. */
  async #settle() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#dirtyAgain = false;
    // Let any in-flight autosave finish (it targets the current binding).
    while (this.#saving) await new Promise((r) => setTimeout(r, 20));
    if (this.#dirty && this.#binding) {
      const dirty = this.#sourcesDirty;
      this.#sourcesDirty = new Set();
      try {
        if (this.#syncedElsewhere()) {
          await this.#attemptSave(() => this.#mergeSave(dirty));
        } else {
          await this.#attemptSave(async () => {
            const bundle = await this.#snapshot(false, dirty);
            return this.#store.save(
              { id: this.#binding.id, name: this.#binding.name, savedAt: Date.now(), bundle },
              { writeSourcesFor: dirty },
            );
          });
        }
        this.#dirty = false;
      } catch (err) {
        console.error('[project] settle save failed', err);
      }
    }
    // A change could have landed during the awaits above — drop its timer so it
    // can't fire against the next project after the switch.
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#dirtyAgain = false;
  }

  /** Snapshot all open datasets. With `all`, every dataset's Parquet is included;
   * otherwise only those in `dirty` (the rest save metadata-only). */
  /** Ensure the project has a collab identity (mint if absent), returning it. Every
   * project is potentially collaborative (#148) — the identity travels with folder
   * syncs AND export bundles, so a copy imported elsewhere shares the same room. */
  #ensureCollab() {
    if (!this.#collabId || !this.#collabSecret) {
      const i = ensureCollabIdentity({ collabId: this.#collabId, collabSecret: this.#collabSecret });
      this.#collabId = i.collabId;
      this.#collabSecret = i.collabSecret;
    }
    return { collabId: this.#collabId, collabSecret: this.#collabSecret };
  }

  /** The project's collab identity, minting one if needed — for export bundles. */
  collabIdentity() {
    return this.#ensureCollab();
  }

  /** The full current-state snapshot (flat one-true-log + source bytes + scalars) — the
   * same shape `#save` persists. Public so the `.crosstab` exporter can write a FAITHFUL
   * clone (raw log, preserving op ids + row ids) rather than a lossy re-synthesised
   * snapshot, so a bundle hand-off can then co-author (shared op/row identity). */
  async exportSnapshot() {
    return this.#snapshot(true);
  }

  async #snapshot(all, dirty = new Set()) {
    this.#ensureCollab(); // every saved project carries a collab identity (transport-agnostic)
    this.#seedPluginState(); // #157: a project states its plugin set once, then records changes
    // Assemble the flat one-true-log from every tier — collection ops, then each live
    // dataset's raw slice (source ops carrying their Parquet bytes for #writeSources to
    // strip → op-id sidecars), then a deleted dataset's orphaned ops, then the analysis
    // ops. buildManifest persists this verbatim as `manifest.log`; merge unions it by id.
    const log = [...this.#datasets.collectionOps()];
    const datasetMeta = {};
    // Live datasets AND binned ones. A deleted dataset is retained, not copied to some
    // other store (#149 A8), so it serialises through exactly the same path — its ops
    // and its op-id-keyed Parquet sidecars just stay in the project. Purging is what
    // finally takes it out of this list.
    for (const ds of [...this.#datasets.all(), ...this.#datasets.binnedStores()]) {
      const { ops } = await ds.rawExport({ includeParquet: all || dirty.has(ds.id) });
      log.push(...ops);
      datasetMeta[ds.id] = { libraryLink: ds.libraryLink ?? null };
    }
    log.push(...this.#datasets.orphanDataOps()); // purged datasets' ops stay in the log
    const analysisLog = this.#getAnalysisLog ? this.#getAnalysisLog() : null; // raw analysis ops
    if (Array.isArray(analysisLog)) log.push(...analysisLog);
    const wsOps = this.#getWorkspaceOps ? this.#getWorkspaceOps() : null; // ws: tier ops (#148)
    if (Array.isArray(wsOps)) log.push(...wsOps);
    const assetOps = this.#getAssetOps ? this.#getAssetOps() : null; // asset: tier ops (#149 A5)
    if (Array.isArray(assetOps)) log.push(...assetOps);
    const itemOps = this.#getItemOps ? this.#getItemOps() : null; // item: tier ops (#152)
    if (Array.isArray(itemOps)) log.push(...itemOps);
    if (this.#log) log.push(...this.#log.slice(PROJECT_META.match)); // project/name (#149 A3)
    if (this.#log) log.push(...this.#log.slice(isPluginOp)); // plugin activation (#157)
    // Sharing has to travel: a folder co-holder learns the project was closed by reading
    // the log they already sync, which is the only channel left once the room is refused.
    if (this.#log) log.push(...this.#log.slice(isShareOp));
    // Record the active plugin set alongside the data, so reopening restores the
    // analyses too. Null when the feature isn't wired (keeps old saves untouched).
    // Carry forward any recorded plugins this install can't resolve (not installed
    // here) so the association survives until the plugin is added (#102).
    // Which plugins are active now rides the `plugin:` tier of the log (#157), so it
    // merges, undoes and travels like every other decision. The scalar below is kept
    // only as a compatibility shim for readers older than the tier — written, never read
    // back by this version (a legacy save's scalar is migrated to ops on open, and the
    // ops are authoritative from then on).
    let activePlugins = this.#getActivePlugins ? this.#getActivePlugins() : null;
    if (activePlugins) {
      // Carry forward plugins not in the live active set but still associated with
      // the project: unresolved (not installed here — #102) and kept (installed but
      // deactivated with data preserved — #118). Without this a save would drop them.
      const extra = [...this.#unresolvedPlugins, ...this.#keptPlugins];
      if (extra.length) activePlugins = [...new Set([...activePlugins, ...extra])];
    }
    const output = this.#getOutput ? this.#getOutput() : undefined;
    return {
      log, activeId: this.#datasets.activeId, activePlugins, output, datasetMeta,
      collabId: this.#collabId, collabSecret: this.#collabSecret, // #148 — persist the live-room identity
    };
  }

  // --- new / open -----------------------------------------------------------

  /** Start a fresh project: one empty dataset, unbound. */
  async newProject() {
    await this.#settle();
    this.#open = true; // "start blank" opens a REAL project that happens to be empty
    if (this.#storeIsRemote()) this.#detachFolder(); // a fresh project is OPFS, not the folder's
    this.#loading = true;
    try {
      await this.#datasets.loadBundle({ log: [] }); // empty log ⇒ one fresh blank dataset
      // ORDER MATTERS (#153): state tiers are replaced BEFORE the workspace tier, because
      // applying workspaces REMOUNTS the workspace plugins, and a plugin reads its records
      // on mount. Remounting first meant a plugin mounted against the OUTGOING project's
      // records, loaded them into memory, and wrote them straight back — racing the clear
      // that came two lines later. Symptom: switching from the spatial demo to another
      // project kept exactly the ACTIVE map layer, because that is the one wsSaveState
      // writes. Consumers are re-mounted last, when the state they read is already right.
      this.#applyAssetOps?.([]);
      this.#applyItemOps?.([]);
      this.#applyWorkspaces?.([]); // a fresh project has no workspace state
      this.#applyOutput?.([]); // …and no output (clears stale output on switch)
      this.#applyAnalysisLog?.([]); // …and no recorded analyses (script)
    } finally {
      this.#loading = false;
    }
    this.#binding = null;
    this.#collabId = null; // a fresh (OPFS) project isn't shared → no collab room
    this.#collabSecret = null;
    this.#sourcesDirty.clear();
    this.#dirty = false;
    this.#unresolvedPlugins = []; // a fresh project carries no unresolved plugins
    this.#keptPlugins.clear(); // …nor any kept-deactivated ones (#118)
    this.#setStatus();
    this.#emitProject();
  }

  /**
   * Show the project browser, or open one directly by id.
   * @param {string} [id]
   * @param {{applyPlugins?: boolean}} [opts] - When opening by id, also restore the
   *   project's saved plugin set (default true). The launcher passes false: its
   *   picker has already applied the (possibly tweaked) selection.
   */
  async openProject(id, { applyPlugins = true } = {}) {
    if (id == null) {
      let entries;
      try {
        // The local catalog, not the live store — with a remote project open, asking the
        // live store would offer you the contents of Dropbox to browse.
        entries = await this.listProjects();
      } catch (err) {
        this.#results.appendError(`Open project failed: ${err.message}`);
        return;
      }
      this.#showBrowseModal(entries);
      return;
    }
    // Local storage is a backend like any other, so this is the same flow everything else
    // takes: probe on a throwaway store, decrypt, adopt, load. The passphrase handling
    // that used to live here inline is now the shared one.
    return this.openLocation(new OpfsBackend(id), { applyPlugins });
  }

  /**
   * Load a project id from the store that is ALREADY attached.
   *
   * The inner half of {@link openLocation}, and deliberately not public: calling it
   * without adopting a backend first is how a project gets loaded out of whichever store
   * happened to be attached.
   */
  async #loadProject(id, { applyPlugins = true } = {}) {
    this.#setStatus('loading');
    this.#loading = true;
    let projName = null;
    try {
      const { name, bundle } = await this.#store.load(id);
      projName = name;
      this.#collabId = bundle.collabId ?? null; // #148 — carry the live-room identity
      this.#collabSecret = bundle.collabSecret ?? null;
      await this.#datasets.loadBundle(bundle);
      // Restore plugin workspace blobs BEFORE plugins load, so a workspace's
      // mount() sees its saved state via state.get(). Absent ⇒ empty.
      // ORDER MATTERS (#153): state tiers are replaced BEFORE the workspace tier, because
      // applying workspaces REMOUNTS the workspace plugins, and a plugin reads its records
      // on mount. Remounting first meant a plugin mounted against the OUTGOING project's
      // records, loaded them into memory, and wrote them straight back — racing the clear
      // that came two lines later. Symptom: switching from the spatial demo to another
      // project kept exactly the ACTIVE map layer, because that is the one wsSaveState
      // writes. Consumers are re-mounted last, when the state they read is already right.
      this.#applyAssetOps?.(bundle.assetOps || assetOpsOf(bundle.log));
      this.#applyItemOps?.(bundle.itemOps || itemOpsOf(bundle.log));
      this.#applyWorkspaces?.(bundle.workspaceOps || []);
      this.#applyNameOps(bundle.log);
      this.#applyOutput?.(bundle.output || []); // restore the Output tab (or clear)
      this.#applyAnalysisLog?.(bundle.analysisLog || []); // restore the script's analysis steps
      // Restore the project's plugin set from its `plugin:` ops (unless the caller
      // already applied one, e.g. the launcher), migrating a legacy scalar first (#157).
      // A plugin the project has never mentioned is left alone — only a recorded `false`
      // switches anything off.
      if (applyPlugins) await this.#applyPluginState(bundle);
      // Remember any recorded plugins not installed here, so a later save doesn't
      // forget them (they reactivate once the plugin is added — #102).
      this.#unresolvedPlugins = this.#computeUnresolved(bundle.activePlugins);
      this.#keptPlugins.clear(); // reopened project reactivates its set fresh (#118)
      this.#open = true;
      this.#binding = { id, name };
      this.#sourcesDirty.clear();
      this.#dirty = false;
      this.#setStatus('saved');
      this.#emitProject();
    } catch (err) {
      console.error('[project] load failed', err);
      this.#results.appendError(
        `Couldn't open ${projName ? `"${projName}"` : 'the project'} — its data may be damaged (${err.message}). ` +
          `Starting a fresh project instead; the damaged one is left untouched so you can delete or re-import it.`,
      );
      // The failed load left the dataset half-torn-down and the binding still
      // pointing at whatever was open before. Detach the binding and clear dirty
      // FIRST so the recovery can't autosave this broken state over any project,
      // then load a clean blank. (#loading is still true → no autosave fires.)
      this.#binding = null;
      this.#dirty = false;
      this.#sourcesDirty.clear();
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      try {
        await this.#datasets.loadBundle({ log: [] }); // empty log ⇒ one fresh blank dataset
        this.#applyAssetOps?.([]);
        this.#applyItemOps?.([]);
        this.#applyWorkspaces?.([]); // last: remounting plugins read the tiers above
        this.#applyOutput?.([]);
        this.#applyAnalysisLog?.([]);
      } catch (e2) {
        console.error('[project] recovery load failed', e2);
      }
      this.#setStatus();
      this.#emitProject();
    } finally {
      this.#loading = false;
    }
  }

  /**
   * Open an external `.crosstab` bundle as a NEW project — never overwrites the
   * currently-open one (cancels its pending save, loads the bundle's datasets,
   * then saves a fresh project named per the bundle). Same clobber-safety as
   * {@link ProjectSync#openProject}.
   * @param {{name: string, bundle: object}} arg
   */
  async openBundle({ name, bundle }) {
    await this.#settle();
    this.#open = true; // an imported bundle IS a project
    if (this.#storeIsRemote()) this.#detachFolder(); // an imported bundle is a fresh OPFS project
    this.#setStatus('loading');
    this.#loading = true;
    try {
      await this.#datasets.loadBundle(bundle);
    } catch (err) {
      this.#loading = false;
      this.#results.appendError(`Open bundle failed: ${err.message}`);
      this.#setStatus('error');
      throw err;
    }
    this.#applyAssetOps?.(bundle.assetOps || assetOpsOf(bundle.log));
    this.#applyItemOps?.(bundle.itemOps || itemOpsOf(bundle.log));
    this.#applyWorkspaces?.(bundle.workspaceOps || []); // last — remounts read the above
    this.#applyOutput?.(bundle.output || []);
    this.#applyAnalysisLog?.(bundle.analysisLog || []);
    // Restore the bundle's recorded plugin set (#102), so opening a shared bundle brings
    // back the same analyses. Plugins the recipient doesn't have are skipped (the import
    // handler's warning dialog surfaces those).
    await this.#applyPluginState(bundle);
    // Carry forward bundle plugins not installed here (the import handler also warns
    // about them) so they're remembered, not dropped, on the project's first save.
    this.#unresolvedPlugins = this.#computeUnresolved(bundle.activePlugins);
    this.#keptPlugins.clear(); // a freshly-opened bundle carries no kept-deactivated set (#118)
    this.#loading = false;
    // It's a brand-new project; never bound to (and so never overwriting) the one
    // that was open. Persist + name it from the bundle.
    this.#binding = null;
    // Preserve the bundle's collab identity (#148) so this imported OPFS copy shares a
    // room with the origin (the flash-drive hand-off case); null → #snapshot mints one.
    this.#collabId = bundle.collabId ?? null;
    this.#collabSecret = bundle.collabSecret ?? null;
    this.#sourcesDirty.clear();
    await this.#fullSave(null, name || 'Imported project');
  }

  // --- folder-backed projects (#143) ----------------------------------------

  /**
   * Is the open project somewhere other than this browser's own storage?
   *
   * Was `folderBacked`, and answered "is the folder FLOW active" — which is how behaviour
   * came to be keyed on a UI path. Callers only ever wanted "not local", and that is now
   * what they get, whether the bytes sit in a directory, in Dropbox or on a WebDAV server.
   * @returns {boolean}
   */
  get folderBacked() {
    return !!this.#backend && this.#backend.kind !== 'opfs';
  }

  /** How the open project's location should be described in a list, or null if local. */
  describeLocation() {
    return this.#backend?.describe?.() ?? null;
  }

  /** Pick a folder + attach the store to it (shared by move/open). Returns the
   * handle, or null on cancel/denied. Flushes any pending OPFS save first. */
  /** Re-grant write, flush any pending OPFS save, then point the store at the folder. */
  /**
   * Open a project stored on a WebDAV server.
   *
   * Same shape as {@link ProjectSync##openExistingFolder}, for the same reason: probe on
   * a THROWAWAY store and touch the live project only once the remote has proved it
   * holds one. A wrong address, a wrong password or an empty collection must all leave
   * whatever is currently open exactly as it was.
   *
   * `askPassword` is passed in rather than imported so the credential never becomes this
   * module's business: it prompts, hands the string to the driver, and nothing here
   * writes it anywhere. The address is remembered only after a successful open — there
   * is no point offering someone a shortcut to a place that did not work.
   *
   * @param {{url: string, username?: string, name?: string}} conn
   * @param {() => Promise<string|null>} askPassword
   * @returns {Promise<boolean>} whether a project was opened
   */
  /**
   * Open the project held by a backend — folder, Dropbox, WebDAV, anything (#172).
   *
   * One flow, where there were two near-identical ones written by copying. The skeleton
   * was always the same and is the part worth stating: **probe on a THROWAWAY store, and
   * touch the live project only once the destination has proved it holds one.** A refused
   * credential, a wrong passphrase, an unreachable server or an empty location all leave
   * whatever is currently open exactly as it was.
   *
   * `backend.driver()` is called twice on purpose — the probe and the live store must
   * never share a driver, or aborting the probe would leave the live one half-configured.
   *
   * @param {object} backend  see storage-backend.js
   * @returns {Promise<boolean>} whether a project was opened
   */
  async openLocation(backend, { applyPlugins = true } = {}) {
    const what = backend.describe?.() ?? { label: 'that location' };
    if (!(await backend.connect())) return false; // cancelled or refused — nothing touched

    const probe = new ProjectStore();
    probe.useDriver(backend.driver());

    // WHICH project. Local storage holds many and names one; every other backend holds a
    // single project and discovers its id by listing. That is the entire difference, and
    // keeping it to one line is what stops local storage being a separate flow again.
    let id = backend.projectId;
    let pass = null;
    try {
      // Encryption first: the meta is plaintext, so this read doubles as the reachability
      // and credential check, before anyone is asked for a second secret.
      if (await probe.hasEncryption(id ?? undefined)) {
        pass = await passphraseFor(backend.passphraseMode ?? 'folder');
        if (!pass) return false;
        try {
          await probe.unlock(pass, id ?? undefined);
        } catch {
          this.#results.appendError('Wrong passphrase — the project was not opened.');
          return false;
        }
      }
      if (id == null) {
        const entries = await probe.list();
        if (!entries.length) {
          this.#results.appendError(`No CrossTab project at ${what.label} — use "Move project to…" to put one there first.`);
          return false;
        }
        id = entries[0].id;
      }
    } catch (err) {
      this.#results.appendError(isAuthError(err)
        ? `${what.label} refused those credentials — sign in again.`
        : `Could not reach ${what.label}: ${err.message}`);
      return false;
    }

    await this.#settle(); // flush any pending save before switching backends
    this.#adopt(backend);
    if (pass) await this.#store.unlock(pass, id ?? undefined);
    await this.#loadProject(id, { applyPlugins });
    if (!this.#binding) {
      this.#detachBackend(); // damaged — back to local rather than sitting on a dead store
      return false;
    }
    await this.#afterAttach(backend);
    return true;
  }

  /**
   * Move the open project to a backend.
   *
   * Same discipline as {@link openLocation}: everything before the commit line is
   * side-effect-free, so a cancel or a refusal leaves the project where it was.
   *
   * @returns {Promise<boolean>}
   */
  async moveTo(backend) {
    const what = backend.describe?.() ?? { label: 'that location' };
    // Only the app's OWN storage is safe to clear out afterwards. A picked folder or a
    // cloud location belongs to the user: it may hold files we did not write, it may be
    // shared with collaborators, and emptying it is not a side effect anyone should get
    // from a menu item. So a move OFF local storage is a move, and a move off anywhere
    // else is a copy — which has to be SAID, because it is not what "move" implies.
    const previous = this.#backend?.describe?.() ?? null;
    const wasLocal = !this.#store.capabilities?.flat;
    if (wasLocal && !this.#binding) {
      this.#results.appendError('Add some data first — an empty project has nothing to move.');
      return false;
    }
    if (!(await backend.connect())) return false;

    // Probe with a THROWAWAY store. `hasEncryption` reads the plaintext meta, so an
    // occupied destination is spotted even when it is protected and we hold no key —
    // where `list` alone would look reassuringly empty and we would write over it.
    try {
      const probe = new ProjectStore();
      probe.useDriver(backend.driver());
      if ((await probe.hasEncryption()) || (await probe.list()).length > 0) {
        this.#results.appendError(`${what.label} already holds a CrossTab project — open it instead.`);
        return false;
      }
    } catch (err) {
      this.#results.appendError(isAuthError(err)
        ? `${what.label} refused those credentials — sign in again.`
        : `Could not check ${what.label}: ${err.message}`);
      return false;
    }

    // Protection is decided BEFORE anything is written.
    let pass = null;
    if (shouldEncrypt('folder')) {
      pass = await passphraseFor('folder-new');
      if (pass === PASSPHRASE_ABORT) return false;
    }

    // --- committed ------------------------------------------------------------
    const orphanLocalId = wasLocal ? this.#binding?.id : null;
    const projectName = this.activeName || 'My project'; // read BEFORE unbinding
    try {
      await this.#settle();
      this.#adopt(backend);
      if (pass) await this.#store.unlock(pass);
      // Mint the live-room identity: it rides the manifest, so a collaborator opening this
      // location joins the same room (#148).
      const ident = ensureCollabIdentity({ collabId: this.#collabId, collabSecret: this.#collabSecret });
      this.#collabId = ident.collabId; this.#collabSecret = ident.collabSecret;
      this.#binding = null; // a brand-new entry, living there now
      await this.#fullSave(null, projectName);
      await this.#afterAttach(backend);
      if (orphanLocalId) {
        // A true move: drop the now-redundant local copy, through a throwaway OPFS store
        // since the live one is elsewhere. Best-effort — the data is already safely away.
        try { await new ProjectStore().delete(orphanLocalId); } catch { /* leave it */ }
        this.#results.appendText('The copy in this browser has been removed.');
      } else if (previous) {
        // The old copy is still openable, which makes it a fork waiting to happen: edit
        // it and the two diverge with no way to reconcile them. Better to say so than to
        // delete someone's directory, and better than the silence this used to be.
        this.#results.appendText(
          `**The previous copy is still at ${previous.label}** — it was not deleted, because that `
          + 'location is yours rather than the app\u2019s. It will not receive any further changes, so '
          + 'open it only to retrieve something; editing both copies forks the project.',
        );
      }
      return true;
    } catch (err) {
      this.#results.appendError(`Move to ${what.label} failed: ${err.message}`);
      this.#detachBackend();
      // Re-open what we were moving rather than leaving the user looking at nothing while
      // their project sits intact one reopen away.
      if (orphanLocalId) { try { await this.openProject(orphanLocalId); } catch { /* already reported */ } }
      return false;
    }
  }

  /**
   * Point the live store at a backend.
   *
   * Locks first, always. Opening an UNENCRYPTED project after an encrypted one would
   * otherwise leave the previous project's key in place — the save guard would catch the
   * mismatch and throw, but "your save failed" is a poor way to learn that a key was
   * never dropped. The old local-project path locked here for exactly this reason, and
   * the shared flow has to keep doing it.
   */
  #adopt(backend) {
    this.#store.lock();
    this.#backend = backend;
    this.#store.useDriver(backend.driver());
  }

  /**
   * The bookkeeping every successful attach needs, wherever the bytes are: record the
   * poll baseline, start watching for a peer, remember the location, write any OS-facing
   * shortcuts the backend offers, and tell the app.
   */
  async #afterAttach(backend) {
    try { this.#lastManifest = await this.#store.readManifest(this.#binding.id); } catch { this.#lastManifest = null; }
    // Record the open. A remote location gets its stamp from remember() below; a local
    // project has no registry entry, so the catalog carries it.
    if (backend.kind === 'opfs') await this.#store.markOpened(this.#binding.id);
    if (backend.pollMs) this.#startPoll(backend.pollMs);
    const mark = backend.remember?.();
    if (mark) {
      try {
        this.#activeLocationId = mark.handle
          ? await rememberFolder(mark.handle, { name: this.activeName || mark.name, savedAt: Date.now() })
          : await rememberRemote(mark.kind, mark.config, { name: this.activeName || mark.name });
      } catch { /* the project is open; the list entry is a convenience */ }
    }
    if (backend.shortcuts) await this.#writeShortcuts(backend);

    this.#emitProject();
  }

  /** Put the live store back on local storage. */
  #detachBackend() {
    this.#stopPoll();
    this.#backend = null;
    this.#activeLocationId = null;
    this.#lastManifest = null;
    this.#folderKeyStale = false;
    this.#metaUnreadable = 0;
    this.#store.useDriver(null);
    this.#store.lock();
  }

  async #attach(handle) {

    if (!(await ensureReadWrite(handle))) {
      this.#results.appendError('Folder write access wasn’t granted.');
      return false;
    }
    await this.#settle(); // flush any pending OPFS save before switching backends
    this.#store.useDirectory(handle);
    return true;
  }

  /** Show the OS folder picker and ensure write permission, but do NOT touch the
   * live store — for flows that must probe/prompt before committing (moveToFolder),
   * so a cancel leaves the current project's attachment completely untouched.
   * @returns {Promise<FileSystemDirectoryHandle|null>} */
  async #pickFolderHandle() {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) {
      this.#results.appendError('This browser can’t use a project folder — use Chrome or Edge on desktop.');
      return null;
    }
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'crosstab-projects', mode: 'readwrite' });
    } catch {
      return null; // user cancelled the picker
    }
    if (!(await ensureReadWrite(handle))) {
      this.#results.appendError('Folder write access wasn’t granted.');
      return null;
    }
    return handle;
  }

  /** Pick a folder AND attach the live store to it (open/reconnect flows). */
  async #pickFolder() {
    const handle = await this.#pickFolderHandle();
    if (!handle) return null;
    return (await this.#attach(handle)) ? handle : null;
  }

  /** Revert the store to OPFS after a failed/aborted folder attach. */
  /**
   * Is the open project somewhere other than this browser's own storage?
   *
   * The question every `if (#folderMode) #detachFolder()` was really asking. Keyed on the
   * store rather than on how the user got here, so a remote project reverts on the same
   * terms a folder one does — closing, opening another, importing a bundle.
   */
  #storeIsRemote() {
    // `flat` alone, deliberately: a picked folder declares it, so adding `#folderMode ||`
    // would only reintroduce the flow flag as belt-and-braces — and belt-and-braces is
    // how it survived long enough to cause four bugs.
    return !!this.#store.capabilities?.flat;
  }

  /** @deprecated Name kept where old call sites still read well; {@link #detachBackend}
   * is the same act, and the only one now. */
  #detachFolder() {
    this.#detachBackend();
  }

  /**
   * Open the (single) project in a folder. Validates the folder — permission,
   * passphrase, a project present — against a THROWAWAY probe store FIRST, and only
   * switches the live store + loads once cleared. So a wrong/cancelled passphrase or
   * an empty folder never clobbers the currently-open project: nothing that touches
   * the live project happens until we know we can open the incoming one. Takes a raw
   * handle (does its own attach) and is shared by pick + reconnect.
   * @param {FileSystemDirectoryHandle} handle
   */
  /** Open the project in a picked directory — the folder case of {@link openLocation}. */
  async #openExistingFolder(handle) {
    return this.openLocation(new FolderBackend(handle));
  }

  /**
   * Move the open project into a picked directory — the folder case of {@link moveTo}.
   *
   * The picker runs first and separately, because acquiring a handle is a user gesture
   * that must not be entangled with the commit: a cancelled picker has to leave the
   * project exactly where it was, and the cheapest way to guarantee that is to have
   * nothing to undo.
   */
  async moveToFolder() {
    const handle = await FolderBackend.pick();
    if (!handle) return false;
    return this.moveTo(new FolderBackend(handle));
  }

  /**
   * Drop the OS-facing double-click shortcuts (Windows `.url`, Mac `.webloc`, a
   * HOW-TO note) into the folder if they're not already there (#143), so a
   * recipient can launch CrossTab straight from the shared folder. Plaintext,
   * app-URL only — never the passphrase. Best-effort: a shortcut is a convenience,
   * so a write failure must never block opening or saving the project.
   */
  /** Ask the backend for any OS-facing files it wants alongside the project, and write
   * them. Only a real directory has anywhere for a double-click file to live, so most
   * backends offer none and this does nothing. */
  async #writeShortcuts(backend) {
    try {
      const files = backend.shortcuts(this.activeName || 'CrossTab project', location.origin, location.pathname);
      for (const f of files ?? []) {
        // Independent per file: one failing (a blocked extension, say) must not cost the
        // others, and none of them is worth failing an open over.
        try {
          if (!(await this.#store.hasPlainFile(f.name))) await this.#store.writePlainFile(f.name, f.text);
        } catch { /* skip this one */ }
      }
    } catch { /* a shortcut is a convenience */ }
  }

  /**
   * **Open project from a folder…** — open an existing project a collaborator shared
   * via a folder. Prompts for the passphrase if the folder is encrypted (one gate:
   * it opens the files *and* is the key to the collaboration). Refuses an empty
   * folder (use *Move project to a folder…* to seed one).
   */
  async openFromFolder() {
    // Pick WITHOUT attaching — #openExistingFolder validates against a probe store
    // and only switches the live store once cleared, so a wrong/cancelled passphrase
    // never clobbers the currently-open project.
    const handle = await this.#pickFolderHandle();
    if (!handle) return;
    try {
      await this.#openExistingFolder(handle);
    } catch (err) {
      this.#results.appendError(`Open from folder failed: ${err.message}`);
      this.#detachFolder();
    }
  }

  /**
   * Reconnect a **remembered** folder (the launcher's boot-time reopen entry) — no
   * picker. The browser still requires re-granting write via a user gesture, which
   * `#openExistingFolder` does (`ensureReadWrite`) before probing, so this runs from
   * that click. Like the pick path, it validates before touching the live project.
   * @param {FileSystemDirectoryHandle} handle  from {@link module:core/project-locations}
   */
  async reopenFolder(handle) {
    if (!handle) return;
    try {
      await this.#openExistingFolder(handle);
    } catch (err) {
      this.#results.appendError(`Reopen folder failed: ${err.message}`);
      this.#detachFolder();
    }
  }

  /** Leave the current location: flush, revert the store to local, start fresh. */
  async closeFolder() {
    if (!this.folderBacked) return;
    this.#stopPoll();
    await this.#settle(); // flush while still folder-backed
    this.#detachFolder(); // → OPFS, clears folderMode/lastManifest/poll
    // Keep the folder in the registry (reopenable from the launcher/sidebar) — closing
    // ≠ forgetting; the sidebar's ✕ is the explicit "forget".
    await this.newProject();
  }

  /**
   * **Protect this project…** — set a passphrase so the project's data is encrypted at
   * rest (#144). Works for both an OPFS project (its own per-project passphrase — the
   * shared-lab case) and a folder project (its folder passphrase). Also the migration
   * path for an existing plaintext project: mint the key + meta, re-save encrypted.
   */
  async protectProject() {
    const folder = this.#store.flat; // one project per location — folder or remote alike
    await this.#settle(); // make sure it's saved (and, for OPFS, has a binding) before we re-key it
    if (!folder && !this.#binding) {
      this.#results.appendError('Add some data first — an empty project has nothing to protect yet.');
      return;
    }
    const id = folder ? FOLDER_PROJECT_ID : this.#binding.id;
    const name = this.#binding?.name ?? 'this project';
    if (await this.#store.hasEncryption(id)) {
      this.#results.appendError('This project is already protected.');
      return;
    }
    // OPFS is on-device (per-project); a folder is opened "on any machine" and shared.
    const pass = await passphraseFor(folder ? 'enable' : 'local-new'); // set mode + "no recovery"
    if (!pass) return; // cancelled — unchanged
    try {
      await this.#store.unlock(pass, id); // mints salt/verifier + key
      // Announce BETWEEN the meta write and the rewrite. The new epoch is on disk by
      // now, so a peer that checks immediately sees the change; and it gets to halt
      // before we spend seconds re-encrypting every file underneath it.
      if (folder) this.#announceRekey();
      if (folder) await this.#folderRewrite(name);
      else await this.#fullSave(id, name);
      this.#results.appendText?.(folder
        ? `🔒 **“${name}” is now protected.** Everyone who opens this folder will need this passphrase — share it with your collaborators out of band. It isn't stored anywhere and can't be recovered.`
        : `🔒 **“${name}” is now protected.** You'll need this passphrase to open it on this device — it isn't stored anywhere and can't be recovered.`);
    } catch (err) {
      this.#results.appendError(`Couldn’t protect the project: ${err.message}`);
    }
    this.#emitProject();
  }


  /**
   * **Change passphrase…** — rekey a protected project in one step (#144).
   *
   * The reason this is not just unprotect-then-protect: that sequence rewrites every
   * file to disk IN THE CLEAR in between, and on a synced folder those plaintext bytes
   * reach the cloud. An operation meant to improve confidentiality must not destroy it
   * on the way through.
   *
   * The store writes a transitional meta describing BOTH keyings before we rewrite
   * anything, so an interruption anywhere in the rewrite leaves a folder that either
   * passphrase still opens. `finishRekey` retires the old one only once every file is
   * under the new key.
   */
  async changePassphrase() {
    const folder = this.#store.flat; // one project per location — folder or remote alike
    await this.#settle();
    if (!folder && !this.#binding) return;
    const id = folder ? FOLDER_PROJECT_ID : this.#binding.id;
    const name = this.#binding?.name ?? 'this project';
    if (!(await this.#store.hasEncryption(id))) {
      this.#results.appendError('This project isn’t protected — use “Protect this project…” first.');
      return;
    }
    const current = await passphraseFor('change-current', { name });
    if (!current) return;
    const next = await passphraseFor('change-new', { name });
    if (!next) return;

    try {
      await this.#store.changePassphrase(current, next, id);
      // Peers first: the new epoch is already on disk, so they can halt before we spend
      // the rewrite re-encrypting every file underneath them.
      if (folder) this.#announceRekey();
      if (folder) await this.#folderRewrite(name);
      else await this.#fullSave(id, name);
      // Only now is every file under the new key, so only now may the old one retire.
      await this.#store.finishRekey(id);
      this.#results.appendText?.(
        `🔑 **“${name}” has a new passphrase.** ${folder
          ? 'Everyone sharing this folder needs the new one — send it out of band. The old passphrase no longer opens it.'
          : 'The old passphrase no longer opens it.'} It isn’t stored anywhere and can’t be recovered.`);
    } catch (err) {
      // The store refuses before touching anything if the current passphrase is wrong,
      // so the common failure leaves the project exactly as it was.
      this.#results.appendError(`Couldn’t change the passphrase: ${err.message}`);
      if (this.#store.rekeyPending) {
        this.#results.appendError(
          'The rekey did not finish. Both the old and the new passphrase still open this '
          + 'project — try again, and keep the old one until it succeeds.');
      }
    }
    this.#emitProject();
  }

  /**
   * **Remove protection…** — decrypt the project back to plaintext IN PLACE (#144).
   * Requires a confirmation (it lowers at-rest security). For a folder project the
   * warning is stronger: it exposes the data to everyone sharing the folder and to
   * whatever cloud service mirrors it. The project is already unlocked, so this drops
   * the key + meta and re-writes the whole bundle in the clear.
   */
  async unprotectProject() {
    const folder = this.#store.flat; // one project per location — folder or remote alike
    await this.#settle();
    if (!folder && !this.#binding) return;
    const id = folder ? FOLDER_PROJECT_ID : this.#binding.id;
    const name = this.#binding?.name ?? 'this project';
    if (!(await this.#store.hasEncryption(id))) {
      this.#results.appendError('This project isn’t protected.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Remove protection?',
      message: folder
        ? `“${name}” will be re-written UNENCRYPTED in its folder. Anyone who has the folder — and whatever cloud service it syncs through — will then be able to read it with no passphrase. This turns off protection for everyone the folder is shared with.`
        : `“${name}” will be stored unencrypted on this device. Anyone (or any program) that can read this browser's files could then read it.`,
      okLabel: 'Remove protection',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.#store.removeEncryption(id); // deletes the meta + drops the key
      if (folder) this.#announceRekey();
      if (folder) await this.#folderRewrite(name);
      else await this.#fullSave(id, name);
      this.#results.appendText?.(folder
        ? `🔓 **“${name}” is no longer protected** — its data is now stored unencrypted in the folder (and wherever that folder syncs).`
        : `🔓 **“${name}” is no longer protected** — it's stored unencrypted on this device now.`);
    } catch (err) {
      this.#results.appendError(`Couldn’t remove protection: ${err.message}`);
    }
    this.#emitProject();
  }

  /**
   * Blind full re-write of the current folder project's bundle with whatever key
   * state is set now — used to flip a folder project's at-rest protection in place
   * (protect: key set → encrypted; unprotect: key null → plaintext). Bypasses the
   * merge sync (an explicit one-shot admin action), then resets the per-peer base so
   * the poll doesn't read its own write back as a remote change.
   */
  async #folderRewrite(name) {
    const bundle = await this.#snapshot(true); // all sources
    await this.#store.save({ id: FOLDER_PROJECT_ID, name, savedAt: Date.now(), bundle });
    this.#lastManifest = await this.#store.readManifest(FOLDER_PROJECT_ID);
  }

  /** Remembered project locations — folders and remote alike (sidebar + launcher). */
  listProjectLocations() {
    return listLocations();
  }

  /**
   * **Every project this device knows about, wherever it lives** (#171).
   *
   * The one list. Until now the app kept two and rendered them separately — the local
   * catalog and the location registry — which is why a project moved to Dropbox vanished
   * from the Projects list while one moved to a folder did not, and why the sidebar showed
   * two rows with the same name and no way to tell them apart.
   *
   * The two STORES stay, and that is deliberate: the local catalog is the nested store's
   * own bookkeeping (it is how the store knows what it holds), and the registry has to
   * hold `FileSystemDirectoryHandle`s, which only IndexedDB can keep. What changes is that
   * nothing above this line sees either of them. Location becomes an attribute of a
   * project rather than a category of project — the whole of #171 in one sentence.
   *
   * Ordered by `lastOpenedAt`, falling back to `savedAt` for anything that predates it.
   *
   * @returns {Promise<Array<{
   *   key: string, name: string, kind: string, projectId: (string|number|null),
   *   locationId: (string|null), savedAt: number, lastOpenedAt: number,
   *   datasetCount: (number|null), entry: (object|null), isOpen: boolean,
   * }>>}
   */
  async listAllProjects() {
    const out = [];

    // Local projects, from the store's own catalog.
    try {
      for (const p of await this.#opfs.list()) {
        out.push({
          key: `opfs:${p.id}`,
          name: p.name,
          kind: 'opfs',
          projectId: p.id,
          locationId: null,
          savedAt: p.savedAt ?? 0,
          lastOpenedAt: p.lastOpenedAt ?? p.savedAt ?? 0,
          datasetCount: p.datasetCount ?? null,
          entry: null,
          isOpen: this.#backend?.kind === 'opfs' && String(this.#binding?.id) === String(p.id),
        });
      }
    } catch { /* local storage unavailable — the remembered locations still stand */ }

    // Everywhere else, from the location registry.
    try {
      for (const e of await listLocations()) {
        out.push({
          key: `loc:${e.id}`,
          name: e.name,
          kind: e.kind,
          projectId: null,
          locationId: e.id,
          savedAt: e.savedAt ?? 0,
          lastOpenedAt: e.lastOpenedAt ?? e.savedAt ?? 0,
          datasetCount: null,
          entry: e,
          isOpen: this.#activeLocationId === e.id,
        });
      }
    } catch { /* no registry — the local ones still stand */ }

    return out.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  }

  /** The `n` most recently opened, excluding whichever is open now. */
  async listRecentProjects(n = 5) {
    return (await this.listAllProjects()).filter((p) => !p.isOpen).slice(0, n);
  }

  /** @deprecated Name kept while call sites migrate; it never meant folders only. */
  listFolderProjects() {
    return listLocations();
  }

  /**
   * Delete the files CrossTab wrote at a remembered location — and nothing else (#173).
   *
   * `ProjectStore#delete` refuses on a flat store, deliberately: *"don't blow away the
   * user's picked folder from here"*. That guard is right. A picked folder may hold the
   * user's own files beside the project, and a cloud folder may be shared with people who
   * would simply find their data gone.
   *
   * So this removes a KNOWN LIST — the manifest, the marker, the encryption meta, the
   * Parquet sources, the assets, the two shortcut files — and leaves the directory itself
   * and anything unrecognised alone. A `removeTree` here would be indefensible; someone
   * who keeps their analysis notes in the same folder should still have them afterwards.
   *
   * Best-effort per file: one failure must not strand the rest half-deleted.
   *
   * The BACKEND is passed in rather than built here: constructing one needs credential
   * prompts, which belong to the UI. The engine deletes; it does not ask for passwords.
   *
   * @param {object} backend
   * @returns {Promise<number>} how many files were removed
   */
  async deleteRemoteFiles(backend) {
    if (!backend) throw new Error('That location cannot be reached to delete anything.');
    if (!(await backend.connect())) return 0;
    const driver = backend.driver();
    const names = new Set(['project.json', 'project.base.json', 'crosstab-project.json',
      'crosstab-encryption.json', 'Open in CrossTab.html', 'HOW TO OPEN.txt']);
    // Sources and assets are named by the manifest rather than fixed, so they are read
    // from what is actually there rather than guessed.
    try {
      for (const name of await driver.list('')) {
        if (/^ds\d+_src\d+\.parquet$/.test(name)) names.add(name);
      }
      for (const name of await driver.list('assets')) names.add(`assets/${name}`);
    } catch { /* an unreadable listing just means fewer files removed */ }

    let removed = 0;
    for (const name of names) {
      try { await driver.remove(name); removed++; } catch { /* leave it and carry on */ }
    }
    debug('project', 'deleted remote project files', { removed });
    return removed;
  }

  /** Forget a remembered folder (removes the list entry; leaves the folder's files). */
  async forgetFolderProject(id) {
    await forgetLocation(id);
    this.#emitProject(); // refresh sidebar
  }

  /**
   * A folder-mode save: instead of a blind overwrite (which would clobber a peer
   * sharing the same `project.json`), run the merge-aware {@link syncFolderProject} —
   * land my Parquet, three-way merge against the peer + base, resolve conflicts, write
   * the result, and (if a peer contributed) reload it. Core (tabular) merges host-side;
   * plugin-blob (e.g. CAQDAS codebook) merge needs the sandbox bridge — a follow-up —
   * so those currently surface as conflicts rather than auto-merging.
   */
  async #mergeSave(dirty) {
    if (!this.#binding) return;
    if (!(await this.#keyStillCurrent())) return; // #144 — never write with a stale key
    const bundle = await this.#snapshot(true, dirty); // include Parquet — syncFolderProject writes sources
    const result = await syncFolderProject({
      store: this.#store,
      id: this.#binding.id,
      name: this.#binding.name,
      bundle,
      // No base: the merge derives the common ancestor from the shared op-id set (#148).
      mergers: this.#mergers(), // core + active builtin plugin mergers — merges CAQDAS coding across peers
      // Per-collection conflict policy (#166): most item records resolve silently by
      // HLC, but a collection may ask for a genuine disagreement to be shown instead.
      surfaces: this.#getSurfaces ? this.#getSurfaces() : null,
      resolveConflicts: (conflicts) => showConflictDialog(conflicts),
      applyMerged: (id, manifest) => this.#applyMergedManifest(id, manifest),
      now: Date.now(),
    });
    // Record the written manifest as my poll baseline (a cheap "did the peer write?"
    // detector — NOT a merge ancestor anymore). applyMerged already set it on reload.
    if (result.action !== 'cancelled' && result.manifest) this.#lastManifest = result.manifest;
    return result;
  }

  /** Reload a merged manifest into the live app (datasets + workspaces + output) when
   * a peer's changes came in. Keeps the binding + plugin set (same project); suppresses
   * autosave during the reload. */
  async #applyMergedManifest(id, manifest) {
    this.#loading = true;
    try {
      const { bundle } = await this.#store.load(id);
      await this.#datasets.loadBundle(bundle);
      this.#applyAssetOps?.(bundle.assetOps || assetOpsOf(bundle.log));
      this.#applyItemOps?.(bundle.itemOps || itemOpsOf(bundle.log));
      // Refresh (not remount) in place, and still LAST: onRefresh re-reads the records.
      await this.#applyWorkspaces?.(bundle.workspaceOps || [], { refresh: true });
      this.#applyNameOps(bundle.log);
      this.#applyOutput?.(bundle.output || []);
      this.#applyAnalysisLog?.(bundle.analysisLog || []);
      this.#lastManifest = manifest;
    } finally {
      this.#loading = false;
    }
  }

  // --- live co-authoring (#148 step 6) --------------------------------------

  /** Whether a live co-authoring session is active (this peer opted in). */
  get coauthoring() {
    return !!this.#liveDoc;
  }

  /** How many peers are actually co-authoring with us right now (0 = we've opted in but
   * nobody else has joined the doc yet → the UI shows "waiting"). */
  get coauthorPeerCount() {
    return this.#coauthorPeers;
  }

  /** The current project as a wire manifest (Parquet stripped to file refs — the
   * receiver reuses its own local bytes; see {@link #applyLiveManifest}). */
  /**
   * The manifest published to peers. **Without Parquet bytes** — that is what gap-fill
   * is for (#148 6c).
   *
   * It used to be `#snapshot(true)`, i.e. every dataset's full Parquet inlined into every
   * live update. Two things wrong with that. It is enormous — a real dataset would blow
   * past the data channel's message limit on every keystroke-scale edit. And it does not
   * even survive the wire: Trystero JSON-serialises the payload, and a Uint8Array nested
   * in a plain object comes out the other side as `{"0":31,"1":139,…}` (the same defect
   * the gap-fill chunks are base64-encoded to avoid). So the receiver saw a source op
   * carrying a `parquet` that was neither usable nor absent.
   *
   * Bytes travel by the one path built to carry them, chunked, base64-safe and
   * hash-verified.
   */
  async #currentManifest() {
    // Nothing open ⇒ no manifest. This is what makes joining an ADOPTION: the merge sees
    // one side with a project and one with literally nothing, so there is no ancestor to
    // reconcile, no register to collide on, and no phantom dataset to union in. It falls
    // out of the state rather than being special-cased anywhere.
    if (!this.#open) return null;
    const bundle = await this.#snapshot(false);
    // Strip `output` too. It is never applied on receipt (see #applyMergedManifestLive),
    // so every chart's SVG was being serialised onto the wire on every publish — a
    // keystroke-scale edit re-shipping the whole Output pane — purely to be discarded.
    return buildManifest({ name: this.#binding?.name ?? 'Live project', savedAt: Date.now(), bundle: { ...bundle, output: undefined } });
  }

  /**
   * Start live co-authoring on an already-joined presence {@link LiveSession}: attach a
   * {@link LiveDoc} that publishes local edits and applies merged remote state. Same
   * merge kernel + mergers as folder sync — just on a faster clock.
   * @param {import('./live-sync.js').LiveSession} session
   */
  async startCoauthoring(session) {
    debug('live', 'startCoauthoring', { has: !!this.#liveDoc, selfId: session?.selfId, peers: session?.peers?.length });
    if (this.#liveDoc || !session) return;
    const manifest = await this.#currentManifest();
    this.#liveSession = session;
    this.#coauthorPeers = 0;

    // Build the gap-fill exchanges BEFORE attaching the doc. attachLiveDoc can deliver a
    // peer's manifest immediately — which is exactly what happens to an invite joiner —
    // and the apply path reaches for `#liveExchange` to request the bytes it lacks. Built
    // afterwards, that reach was an optional-chain onto null: no request was ever sent,
    // and the joiner sat with dataset NAMES and no rows, waiting for bytes nobody had
    // been asked for. `#liveLastManifest` was reset here too, discarding the very
    // manifest a later arrival would have re-applied.
    this.#liveSourceBytes = new Map();
    this.#liveLastManifest = null;
    this.#liveMissingBytes = new Set();
    this.#servingSnapshot = null;
    this.#initGapFill(session);

    this.#liveDoc = attachLiveDoc(session, {
      selfId: session.selfId,
      manifest,
      base: manifest, // session-start snapshot = the common ancestor
      mergers: this.#mergers(), // core + builtin plugin mergers (#148 6b)
      onChange: (m) => { void this.#applyLiveManifest(m); },
      onConflicts: async (conflicts) => {
        this.#conflictAbort?.abort(); // supersede any prior open dialog
        const ctrl = new AbortController();
        this.#conflictAbort = ctrl;
        const res = await showConflictDialog(conflicts, { signal: ctrl.signal });
        if (this.#conflictAbort === ctrl) this.#conflictAbort = null;
        if (res && this.#liveDoc) this.#liveDoc.resolve(res); // aborted (peer resolved first) → res is null
      },
      onResolved: () => { this.#conflictAbort?.abort(); this.#conflictAbort = null; }, // peer resolved → close my stale dialog
      onPeers: (n) => { this.#coauthorPeers = n; this.#emitProject(); }, // "waiting" → "co-authoring"
    });
    await this.#refreshHeld(); // seed both exchanges with what I already hold
    this.#liveDoc.hello();
    this.#emitProject();
  }

  /** Wire the byte-transfer exchanges onto the session. Called BEFORE the doc is
   * attached, so a manifest arriving on connect finds them ready (#156 follow-up). */
  #initGapFill(session) {
    // Base-data gap-fill (#148 6c): serve the sources I hold to a peer that lacks them,
    // and fetch any I lack. Rides the SAME ops channel; LiveDoc ignores need/src-chunk.
    const held = new Set();
    this.#liveExchange = new BlobExchange({
      kind: 'source',
      refsOf: sourceRefs,
      held,
      read: async (ref) => {
        // #snapshot(true) exports EVERY dataset through DuckDB, so calling it once per
        // requested ref made serving N sources cost N full-project exports. A peer asks
        // for all its gaps in one `need`, and the exchange serves them in a tight await
        // loop, so one shared in-flight snapshot covers the whole burst. The cache is
        // released on the next macrotask — after the loop's awaits (microtasks) drain —
        // which keeps the staleness window to a single serve pass.
        if (!this.#servingSnapshot) {
          this.#servingSnapshot = this.#snapshot(true); // my log WITH source bytes
          setTimeout(() => { this.#servingSnapshot = null; }, 0);
        }
        const snap = await this.#servingSnapshot;
        for (const op of snap.log) if (op.id === ref.id && op.payload?.src?.parquet) return op.payload.src.parquet;
        return this.#liveSourceBytes.get(ref.id) ?? null;
      },
      store: async (ref, bytes) => { this.#liveSourceBytes.set(ref.id ?? ref.key, bytes); },
      // Base64 the chunk bytes going out (see bytesToB64) so Trystero doesn't mangle them.
      send: (m, to) => session.sendOps(m.t === 'gap-chunk' ? { ...m, bytes: bytesToB64(m.bytes) } : m, to),
      onReceived: ({ ok, key }) => { debug('live', 'gap-fill received', { key, ok }); if (ok && this.#liveLastManifest) void this.#applyLiveManifest(this.#liveLastManifest); },
    });

    // ASSET gap-fill (#155). A second exchange on the SAME channel, discriminated by
    // `kind`. It exists because #152 moved spatial geometry out of the workspace blob —
    // which travels inside manifest.log — into a content-addressed asset, which does not.
    // Without this a co-authored map layer reaches the peer as a record with a valid
    // assetId and no bytes behind it, and CAQDAS media never arrived at all.
    //
    // Assets are the easier half: the id IS the sha256, so the transfer-time integrity
    // check and the identity check are the same comparison.
    this.#liveAssetExchange = new BlobExchange({
      kind: 'asset',
      refsOf: assetRefs,
      held: new Set(),
      read: async (ref) => (this.#assetBytes ? this.#assetBytes.read(ref.id) : null),
      store: async (ref, bytes) => { await this.#assetBytes?.store(ref.id, bytes, { name: ref.name, type: ref.type }); },
      send: (m, to) => session.sendOps(m.t === 'gap-chunk' ? { ...m, bytes: bytesToB64(m.bytes) } : m, to),
      onReceived: ({ ok, key }) => {
        debug('live', 'asset gap-fill received', { key, ok });
        // A workspace showing that asset needs to re-read it — the record was already
        // there, only the bytes were missing.
        if (ok) void this.#applyWorkspaces?.([], { refresh: true });
      },
    });

    // Decode chunk bytes back to a Uint8Array, then offer the message to BOTH exchanges;
    // each ignores the other's kind.
    session.onOps((m, peer) => {
      // A peer changed the folder's protection. Check now rather than waiting for the
      // next poll — `#keyStillCurrent` halts us if our key is no longer the folder's.
      if (m?.t === 'rekey') { void this.#keyStillCurrent(); return; }
      const msg = m?.t === 'gap-chunk' && typeof m.bytes === 'string' ? { ...m, bytes: b64ToBytes(m.bytes) } : m;
      void this.#liveExchange?.receive(msg, peer);
      void this.#liveAssetExchange?.receive(msg, peer);
    });
  }


  /**
   * Tell connected peers the folder's protection just changed.
   *
   * Advisory only, and deliberately so: live co-authoring carries MANIFESTS, not
   * ciphertext, and `LiveDoc` is entirely key-unaware — so this cannot hand anyone a
   * key, and must not pretend to. All it does is make peers run the check they would
   * otherwise run on their next poll, which turns "up to 3 seconds of writing with a
   * stale key, plus however long the folder rewrite takes" into "immediately".
   *
   * Correctness never depends on this message arriving. The on-disk epoch remains the
   * source of truth and the poll still catches everything; a peer that is offline, or
   * that misses the broadcast, is exactly as safe as before — just later.
   */
  #announceRekey() {
    if (!this.#liveSession) return;
    try {
      this.#liveSession.sendOps({ t: 'rekey' });
      debug('live', 'announced rekey to peers');
    } catch (err) {
      debug('live', 'rekey announce failed (harmless — the poll still catches it)', err?.message);
    }
  }

  /** Refresh the gap-fill "held" set from my current sources (so I can serve them, and
   * so requestMissing knows what I still lack). */
  async #refreshHeld() {
    if (!this.#liveExchange) return;
    try {
      const snap = await this.#snapshot(true);
      for (const op of snap.log) if (['load', 'append', 'join'].includes(op.type) && op.payload?.src?.parquet) this.#liveExchange.held.add(op.id);
    } catch { /* best effort */ }
    // Assets I actually hold BYTES for — the index alone is not enough, since a peer can
    // hold the ref long before the file arrives (#155).
    try {
      if (this.#assetBytes && this.#liveAssetExchange) {
        for (const id of await this.#assetBytes.held()) this.#liveAssetExchange.held.add(id);
      }
    } catch { /* best effort */ }
  }

  /** Stop co-authoring (the presence layer owns leaving the room). */
  stopCoauthoring() {
    debug('live', 'stopCoauthoring', { had: !!this.#liveDoc });
    if (this.#livePublishTimer) { clearTimeout(this.#livePublishTimer); this.#livePublishTimer = null; }
    this.#liveDoc = null;
    this.#liveSession = null;
    this.#liveExchange = null;
    this.#liveAssetExchange = null;
    this.#liveSourceBytes = new Map();
    this.#liveLastManifest = null;
    this.#liveMissingBytes = new Set();
    this.#servingSnapshot = null;
    this.#coauthorPeers = 0;
    this.#conflictAbort?.abort(); // close any open conflict dialog when co-authoring ends
    this.#conflictAbort = null;
    this.#emitProject();
  }

  /** Testing aid: hold outgoing live updates so a real conflict can be staged (pause
   * BOTH peers, edit the same thing in each, resume → the two edits collide from the
   * same base). Incoming updates still apply. `crosstab.projects.pauseLiveSync(true/false)`. */
  pauseLiveSync(on) {
    debug('live', on ? 'sync PAUSED (testing)' : 'sync RESUMED');
    this.#liveDoc?.setPaused(!!on); // full partition: holds both directions, flushes on resume
  }

  /** Debounced: publish the local project state to co-authors after an edit settles. */
  #scheduleLivePublish() {
    if (!this.#liveDoc || this.#loading || !this.#open) return; // nothing open ⇒ nothing to say
    if (this.#livePublishTimer) clearTimeout(this.#livePublishTimer);
    this.#livePublishTimer = setTimeout(async () => {
      this.#livePublishTimer = null;
      if (!this.#liveDoc) return;
      try {
        await this.#refreshHeld(); // I may have added a dataset — offer it to peers
        this.#liveDoc.localUpdate(await this.#currentManifest());
      } catch (err) { console.error('[live] publish failed', err); }
    }, 400);
  }

  /**
   * Apply a merged manifest from a co-author to the live app WITHOUT a disk round-trip
   * (#148 step 6a): rebuild datasets from the manifest reusing the **local** Parquet
   * (matched by source id — I already hold the shared sources' bytes), then apply the
   * merged workspaces/output. A source id I lack is a collaborator's NEW dataset →
   * byte gap-fill (#148 6c). Skips the (expensive) dataset reload when the tabular
   * structure is unchanged (the common coding-only case), applying just the blobs.
   */
  /** Public entry: serialise applies through {@link #applyChain} so a merge apply and a
   * gap-fill re-apply never overlap on DuckDB (which caused "table does not exist" when
   * one apply's dispose raced the other's snapshot). */
  #applyLiveManifest(manifest) {
    this.#applyChain = this.#applyChain
      .then(() => this.#applyMergedManifestLive(manifest))
      .catch((err) => console.error('[live] apply failed', err));
    return this.#applyChain;
  }

  async #applyMergedManifestLive(manifest) {
    const mergedLog = manifest?.log || [];
    debug('live', 'applyMerged', { ops: mergedLog.length });
    // Adoption (#158): a peer's project arriving while we hold none IS the project. No
    // merge happened to get here — `#currentManifest` returned null, so the merge had
    // one operand — and from this point the ordinary apply path materialises it.
    if (!this.#open && mergedLog.length) {
      this.#open = true;
      debug('live', 'adopted a co-author project from nothing');
    }
    this.#loading = true; // suppress autosave + echo-publish during apply
    try {
      const SRC = isSourceOp;
      // Decide whether to rebuild BEFORE touching bytes — the decision needs op ids, which
      // a byte-less snapshot carries just as well, and exporting every dataset to Parquet
      // merely to compare ids meant a one-word memo re-exported the whole project through
      // DuckDB on every keystroke-scale update.
      const cheap = await this.#snapshot(false);
      const dataChanged = needsDataRebuild({
        localLog: cheap.log,
        mergedLog,
        awaitingBytes: this.#liveMissingBytes,
        heldBytes: this.#liveSourceBytes,
      });
      if (dataChanged) {
        // Only now pay for bytes: my current log WITH sources (fresh — safe for DuckDB).
        const snap = await this.#snapshot(true);
        const localParquet = new Map();
        for (const op of snap.log) if (SRC(op) && op.payload?.src?.parquet) localParquet.set(op.id, op.payload.src.parquet);
        // Attach source bytes to the merged log — from local (shared base) or a COPY of a
        // co-author's streamed bytes (#148 6c). The copy matters: DuckDB's registerFileBuffer
        // TRANSFERS (detaches) the ArrayBuffer, so we must not hand over the retained cache.
        const stillMissing = new Set();
        const log = mergedLog.map((op) => {
          if (!SRC(op) || !op.payload?.src?.file) return op;
          const held = this.#liveSourceBytes.get(op.id);
          const parquet = localParquet.get(op.id) ?? (held ? held.slice() : null);
          if (!parquet) { stillMissing.add(op.id); return op; } // byte-less → loadBundle drops this dataset until gap-fill lands
          return { ...op, payload: { ...op.payload, src: { ...op.payload.src, parquet } } };
        });
        this.#liveMissingBytes = stillMissing; // what a later gap-fill arrival must un-block
        if (stillMissing.size) {
          // A co-author added data we don't hold yet — request the bytes; onReceived
          // re-applies this manifest once they arrive (#148 6c gap-fill).
          this.#liveLastManifest = manifest;
          const refs = this.#liveExchange?.requestMissing(manifest);
          debug('live', 'gap-fill requesting', { missing: stillMissing.size, refs: refs?.length });
        }
        // `empty: true` — on the LIVE path a peer must never invent a dataset the merged
        // log did not describe (#148 edge b / #158). Without it, a log folding to zero
        // datasets makes each peer mint its own local "Dataset 1", with its own random id
        // and its own `addDataset` op, which then propagates back as a dataset nobody
        // created — the same phantom class #158 removed from boot and from the joiner.
        // Deleting the last dataset locally still leaves one, because `remove()` appends
        // a real replacement op that travels; the difference is that the op is authored
        // once, by the peer that acted, instead of separately by everyone who applies.
        await this.#datasets.loadBundle({ log, activeId: manifest.activeId, datasetMeta: manifest.datasetMeta, empty: true });
      }
      this.#applyAnalysisLog?.(mergedLog.filter((o) => typeof o.target === 'string' && o.target.startsWith('analysis:')));
      this.#applyAssetOps?.(assetOpsOf(mergedLog));
      // Ask for any asset BYTES this manifest references that we don't hold (#155).
      // Unconditional, unlike the source request above: a peer can add a map layer or a
      // recording without touching the datasets, so "no missing sources" says nothing
      // about assets. requestMissing is a no-op when there is no gap.
      if (this.#liveAssetExchange) {
        const want = this.#liveAssetExchange.requestMissing(manifest);
        if (want.length) debug('live', 'asset gap-fill requesting', { count: want.length });
      }
      this.#applyItemOps?.(itemOpsOf(mergedLog)); // #152: peers' item records land here
      // Last, so a workspace refreshing in place sees the merged records, not the old ones.
      await this.#applyWorkspaces?.(mergedLog.filter((o) => typeof o.target === 'string' && o.target.startsWith('ws:')), { refresh: true });
      // An invite joiner has no collab identity of its own — it entered using the room
      // id baked into the link. The owner's manifest carries the real identity, so adopt
      // it once, and the joiner can derive the same room itself on every later load
      // (#156). Never overwrite an identity we already have: that would move an existing
      // project into someone else's room.
      if (!this.#collabId && manifest?.collabId && manifest?.collabSecret) {
        this.#collabId = manifest.collabId;
        this.#collabSecret = manifest.collabSecret;
        this.#inviteRoom = null; // we can compute it now
        this.#dirty = true;
        this.#schedule();
        debug('live', 'adopted collab identity from invite host');
      }
      this.#applyNameOps(mergedLog); // a co-author's rename lands here (#149 A3)
      // Plugins the merged log turns ON that aren't installed HERE. Recorded so our own
      // save keeps the association (#102) instead of quietly dropping the co-author's
      // half of the project's tooling.
      const wantedByPeers = [...foldPluginOpinions(pluginOpsOf(mergedLog))].filter(([, on]) => on).map(([k]) => k);
      const unresolved = this.#computeUnresolved(wantedByPeers);
      if (unresolved.length) this.#unresolvedPlugins = [...new Set([...this.#unresolvedPlugins, ...unresolved])];
      // Still NOT applyOutput — the merged manifest's `output` array is never applied.
      // mergeProjects resolves `output` as "mine" and is NOT operand-symmetric: the
      // transport imposes a canonical operand order, so whichever peer fills the "mine"
      // slot wins and BOTH then apply that, wholesale. The symptom was A's invite link
      // being replaced by B's "waiting to join" message.
      //
      // The pixels are regenerated, never merged (the rule ARCHITECTURE-unified-log.md
      // §7 sets out): the analysis LOG is the shared truth, and each peer materialises
      // its own pane from it. `#materializeAnalyses` below is that materialisation —
      // without it a co-author's run showed in History and nowhere else.
      this.#persistPeerWork(dataChanged); // a co-author's work is work (#149 C1)
    } catch (err) {
      console.error('[live] apply failed', err);
    } finally {
      this.#loading = false;
    }
    // Deliberately AFTER the apply, un-awaited and on its own chain. Replaying an
    // analysis can take as long as the analysis takes (the runner's own watchdog waits
    // 45s before it will even comment), and holding the apply chain — or `#loading` —
    // open that long would stall every merge behind one slow regression.
    if (this.#materializeAnalyses || this.#applyProjectPlugins) {
      this.#materializeChain = this.#materializeChain
        // Plugin set FIRST, so a plugin a co-author switched on is ready by the time its
        // analysis replays. Nothing special happens here any more: the `plugin:` ops
        // arrived in the merged log with everything else, and the fold is the answer.
        // The union-adoption this replaces existed only because activation was a scalar
        // outside the log, and it could not express "off" at all (#157).
        .then(() => this.#applyPluginState({ log: mergedLog }, { migrate: false }))
        .then(() => this.#materializeAnalyses?.())
        .catch((err) => console.error('[live] materialise failed', err));
    }
  }

  /**
   * Mark work that arrived from a co-author as needing a save (#149 C1).
   *
   * Applied peer ops used to live in memory until our OWN next edit, so a crash, a
   * closed tab or a power cut lost them locally — the whole point of co-authoring is
   * that everyone's work counts, and "it's still on their machine" is not persistence.
   *
   * Deliberately NOT routed through `#onChange`: that would also fire
   * `#scheduleLivePublish`, echoing the state we just received straight back at the
   * peer. This takes only the persistence half. When the data tier changed we also mark
   * every live dataset's sources dirty, or the incremental save would write a manifest
   * referencing `src_<opId>.parquet` sidecars that were never written for a peer's new
   * dataset.
   *
   * @param {boolean} dataChanged  whether the data/collection tier was rebuilt.
   */
  /** Record the project name as an op. Idempotent — skipped when the folded name
   * already matches, so a save/load round-trip doesn't append duplicates. */
  #recordName(name) {
    if (!this.#log || !name) return;
    if (this.#log.state('projectMeta')?.name === name) return;
    this.#log.append({ target: 'project/name', owner: 'core', type: 'setProjectName', payload: { name } });
  }

  /** Replace the project-metadata tier from a loaded/merged log, then adopt the folded
   * name as the display name. The op WINS over `manifest.name`: it's the merged value,
   * so this is how a co-author's rename actually lands. */
  #applyNameOps(log) {
    if (!this.#log) return null;
    this.#log.clearWhere(PROJECT_META.match);
    this.#log.receiveOps(metaOpsOf(log));
    const folded = this.#log.state('projectMeta')?.name ?? null;
    if (folded && this.#binding && this.#binding.name !== folded) {
      this.#binding.name = folded;
      this.#dirty = true; // the catalog/manifest still says the old name — re-save
      this.#emitProject();
    }
    return folded;
  }

  #persistPeerWork(dataChanged) {
    this.#dirty = true;
    if (dataChanged) for (const ds of this.#datasets.all()) this.#sourcesDirty.add(ds.id);
    if (this.#binding) this.#schedule();
  }

  /**
   * Has the folder been re-keyed under us? (#144)
   *
   * The owner of a shared folder can Protect it, Remove protection, or change the
   * passphrase at any time. Every other connected peer keeps the key it derived when it
   * opened — so its next save re-encrypts with the old key (after an unprotect) or
   * cannot read the new files (after a protect or rekey). Silent divergence, precisely
   * when confidentiality is what is changing. Until now the only mitigation was a
   * sentence in the unprotect confirmation.
   *
   * Returns false ⇒ the caller must not touch the folder. We relock, stop polling and
   * tell the user what happened; reopening the folder re-prompts and re-derives, which
   * is the one path that always produces a correct key.
   *
   * Deliberately stops rather than silently re-prompting mid-save: a save is already in
   * flight when this fires, and a modal that appears from nowhere while data is being
   * written is a worse answer than a clear halt.
   */
  async #keyStillCurrent() {
    // Anywhere a peer can write, a peer can re-key. Gating this on the folder FLOW meant a
    // remote project never checked — it would have gone on writing under a key the other
    // side had already replaced, which is #144's whole concern, absent exactly where the
    // bytes leave the machine.
    if (!this.#syncedElsewhere() || !this.#binding) return true;
    if (this.#folderKeyStale) return false; // already halted; don't re-announce every tick
    let status;
    try {
      status = await this.#store.keyStatus(this.#binding.id);
    } catch {
      // A THROW here used to return true — "don't block on a guess". That guess was the
      // wrong way round: not knowing whether our key is current is a reason to hold
      // still, not to write. Treated the same as an unreadable meta below.
      status = { current: false, reason: 'unreadable' };
    }
    if (status.current) { this.#metaUnreadable = 0; return true; }
    if (status.reason === 'unreadable') this.#metaUnreadable = (this.#metaUnreadable || 0) + 1;

    const decision = keyHaltDecision(status, this.#metaUnreadable);
    if (decision.action === 'skip') {
      this.#setStatus('Folder — checking protection…');
      return false; // no write this tick; the poll keeps running
    }
    this.#stopPoll();
    this.#store.lock();
    // A dedicated halt, NOT a detach: reverting the store would send the next save to
    // local storage and quietly fork the project into a second copy on this device. It
    // stays bound to its location and simply stops writing.
    this.#folderKeyStale = true;
    const what = decision.reason;
    this.#setStatus(`Folder locked — ${what}`);
    this.#results.appendError(
      `This shared folder is no longer using the key you opened it with. ${what} `
      + 'Saving has stopped so nothing is written that your collaborators could not read. '
      + 'Re-open the folder (File ▸ Open project from a folder…) to continue — your work so far is still here.',
    );
    this.#emitProject();
    return false;
  }

  /**
   * Does something other than this tab write these bytes?
   *
   * If so, two things must be true: a save has to MERGE rather than overwrite, and a poll
   * has to watch for a peer's write. That is equally true of a synced folder and of a
   * cloud API, and it was previously keyed on `#folderMode` — a flag about which UI FLOW
   * was used, not about how the bytes behave. Remote projects therefore took the
   * plain-overwrite branch, which means two people editing one Dropbox project would have
   * clobbered each other whole-project at a time, silently.
   *
   * Same mistake as `folderBacked` testing `kind === 'folder'`, one layer up: behaviour
   * keyed on identity rather than on a declared capability. The capability now answers it.
   */
  #syncedElsewhere() {
    return !!this.#store.capabilities?.externallySynced;
  }

  /** Poll for a peer's write. Folders are a local file read, so they can be watched
   * often; a remote costs a network round trip per tick and a provider's rate limit, so
   * it is watched less often. */
  #startPoll(ms = 3000) {
    this.#stopPoll();
    this.#pollTimer = setInterval(() => void this.#syncPull(), ms);
  }

  #stopPoll() {
    if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null; }
  }

  /** Poll tick: cheaply read the folder's manifest; if a peer advanced it, merge it
   * in. Skips while the tab is hidden, or a save/load/merge is already in flight. */
  async #syncPull() {
    if (!this.#syncedElsewhere() || !this.#binding || this.#saving || this.#loading) return;
    if (typeof document !== 'undefined' && document.hidden) return; // back off when hidden
    if (!(await this.#keyStillCurrent())) return; // #144 — the poll is also how we notice
    let theirs;
    try { theirs = await this.#store.readManifest(this.#binding.id); } catch { return; }
    if (!theirs || (this.#lastManifest && manifestsEqual(theirs, this.#lastManifest))) return;
    // A peer wrote → pull it in via the merge-aware save (guarded like #flush).
    this.#saving = true;
    try {
      await this.#mergeSave();
    } catch (err) {
      console.error('[project] sync pull failed', err);
    } finally {
      this.#saving = false;
    }
  }

  async #delete(id) {
    try {
      await this.#store.delete(id);
      if (this.#binding?.id === id) {
        this.#binding = null;
        this.#setStatus();
        this.#emitProject();
      }
    } catch (err) {
      this.#results.appendError(`Delete failed: ${err.message}`);
    }
  }

  // --- sidebar surface -------------------------------------------------------

  /** Id of the current project, or null if unsaved. */
  get activeId() {
    return this.#binding?.id ?? null;
  }

  /** Name of the current project, or null if unsaved (e.g. for a report title). */
  get activeName() {
    return this.#binding?.name ?? null;
  }

  /** Summaries of all saved projects (for the sidebar's Projects zone). */
  listProjects() {
    // Always the OPFS (in-browser) projects. The live store is whatever the open project
    // sits on, so asking IT would query Dropbox for the list of your local projects —
    // which is what happened while this was keyed on the folder flow rather than on
    // whether the live store is the local one.
    return (this.#store.capabilities?.flat ? this.#opfs : this.#store).list();
  }

  /** Registry id of the open folder project (null if not in a folder). */
  get activeFolderId() {
    return this.#activeLocationId;
  }

  /** Whether the active project can host live collaboration — it has a collab identity
   * (minted for folder projects), so a signaling room can be derived (#148) — AND it has
   * not been affirmatively closed to sharing. Both are required: an identity says a room
   * *could* be derived, the decision says whether it may be. */
  get collabReady() {
    return !!(this.#collabId && this.#collabSecret) && !this.sharingDisabled;
  }

  /**
   * The project's recorded sharing decision: `true` yes, `false` no, `null` never said.
   *
   * `null` is not `false`. Every project built before this tier existed has never said
   * anything, and must stay shareable — reading silence as refusal would switch
   * collaboration off across the whole install on upgrade.
   */
  get sharing() {
    return this.#log ? foldSharing(this.#log.slice(isShareOp)) : null;
  }

  /** Has this project been affirmatively closed to sharing? */
  get sharingDisabled() {
    return this.sharing === false;
  }

  /* Deliberately not cached, though `collabReady` reads it on every render. The fold is
   * a filter over the log plus a sort of at most a handful of ops, and a cache here
   * could only fail in one direction — reporting a closed project as shareable — which
   * is the single outcome this whole tier exists to prevent. Measure before trading that
   * away. Note the identity check runs FIRST in `collabReady`, so a project with no room
   * to derive never folds at all. */

  /**
   * Record whether this project may be shared, as an op.
   *
   * Writes only on a real change, so reopening a project cannot spam its log with a
   * fresh decision per session. The op rides the same publish path as any edit, so a
   * live peer hears it immediately and a folder co-holder on the next sync — which is
   * the point: the refusal has to reach the people who can already derive the room.
   *
   * @param {boolean} on
   * @returns {boolean} whether anything was recorded
   */
  setSharing(on) {
    if (!this.#log) return false;
    const want = !!on;
    if (this.sharing === want) return false;
    this.#log.append(shareOp(want));
    if (this.#binding) { this.#dirty = true; this.#schedule(); }
    this.#scheduleLivePublish();
    this.#emitProject();
    debug('project', 'sharing decision recorded', { sharing: want });
    return true;
  }

  /** A stable identity for the CURRENTLY-OPEN project — changes only on a real project
   * switch, NOT on status/co-author re-emits. Lets listeners tell "switched projects"
   * from "same project, something updated" (so presence isn't torn down on every emit). */
  get projectKey() {
    return this.#collabId ?? this.#binding?.id ?? null;
  }

  /** The live signaling room + secret for the active project, or null if it has no
   * collab identity (a non-shared OPFS project). Both folder peers derive the same
   * room from the manifest — the entry point for presence + live co-authoring (#148). */
  async activeRoom() {
    // Refused before anything else, including the invite room. A joiner's log is empty
    // at this point so this cannot block a fresh join; once the project arrives carrying
    // a refusal, every later session is turned away here — one gate covering hosting,
    // auto-live and rejoining, rather than three that can drift apart.
    if (this.sharingDisabled) return null;
    if (this.#inviteRoom) return this.#inviteRoom;
    return roomFor({ collabId: this.#collabId, collabSecret: this.#collabSecret });
  }

  /**
   * A shareable invite link for the active project (#156), or null if it has no collab
   * identity yet. The room id and secret ride in the URL **fragment**, which browsers
   * never send to a server — so the link is safe to paste into an email in the sense
   * that no intermediary *server* sees the key.
   *
   * It is NOT safe in the sense that anyone holding the link can join: the link IS the
   * credential. That is the intended trade (it is what makes "just email a link" work),
   * and the caller should say so plainly when handing it over.
   */
  async inviteLink() {
    if (!this.#collabId || !this.#collabSecret) return null;
    // Minting a link for a project that refuses the room would hand someone a key to a
    // door that will not open — worse than no link, because it looks like it worked.
    if (this.sharingDisabled) return null;
    // Strip the query string as well as the fragment: the host's own `?launch=demo-quant`
    // (or any other local state) has no business travelling to a recipient, who is
    // joining a project rather than replaying how the sender happened to open theirs.
    const base = `${location.origin}${location.pathname}`;
    return inviteLinkFor({
      baseUrl: base,
      manifest: { collabId: this.#collabId, collabSecret: this.#collabSecret },
    });
  }

  /**
   * Join a project from an invite link, starting from nothing (#156).
   *
   * The joiner holds no data at all: no bundle, no shared folder. It enters the room
   * with the link's credentials, and everything — the op log, then the Parquet sources
   * and asset bytes via gap-fill (#148 6c, #155) — arrives from the peer. That is why a
   * live peer must be present; a link alone is an address, not a copy.
   *
   * The joiner opens NO project (#158). It used to stand up a blank one "so there is
   * somewhere for the manifest to land", and I wrote that its empty dataset merging into
   * the host's project was "untidy but harmless". It was neither: that dataset was
   * reported as a mystery "Dataset 1" appearing in the host's sidebar, and the same
   * phantom project also asserted a full plugin set with the newest clock in the room,
   * silently reconfiguring the host's plugins.
   *
   * Holding nothing is what makes this an ADOPTION rather than a merge — there is no
   * ancestor to reconcile and no local state to leak. The project arrives whole.
   */
  async joinByInvite({ roomId, secret }) {
    if (!roomId || !secret) throw new Error('joinByInvite: the link is missing its room or key');
    await this.closeProject();
    this.#inviteRoom = { roomId, secret };
    this.#setStatus();
    this.#emitProject();
    return this.#inviteRoom;
  }

  /** Rename the *active* project. If it has never been saved (no binding), this
   * names and saves it for the first time — so the sidebar's ✎ is always an inline
   * rename, never the Save modal, matching every other pencil in the sidebar. */
  async renameActive(name) {
    name = String(name).trim();
    if (!name) return;
    if (this.#binding) await this.renameProject(this.#binding.id, name);
    else await this.#fullSave(null, name);
  }

  /** Rename a project. The active project renames in place (and re-saves);
   * another project is renamed on disk. */
  async renameProject(id, name) {
    name = String(name).trim();
    if (!name) return;
    try {
      if (id === this.#binding?.id) {
        this.#binding.name = name;
        this.#recordName(name); // the rename is an op, so it merges and propagates (#149 A3)
        // `store.rename` only patches `manifest.name` in place; the appended op needs a
        // real save or it never reaches disk (the log would reload without the rename).
        this.#dirty = true;
        this.#schedule();
        await this.#store.rename(id, name);
        this.#emitProject();
        this.#setStatus('saved');
      } else if (id) {
        await this.#store.rename(id, name);
        this.#emitProject(); // refresh the sidebar list
      }
    } catch (err) {
      this.#results.appendError(`Rename project failed: ${err.message}`);
    }
  }

  /** Delete a project. Deleting the active one drops you into a fresh Untitled
   * project (one empty dataset, autosaves on first edit). */
  async deleteProject(id) {
    const wasActive = id === this.#binding?.id;
    await this.#delete(id);
    if (wasActive) await this.newProject();
    else this.#emitProject(); // refresh the list
  }

  // --- UI helpers -----------------------------------------------------------

  async #promptName(title, suggested) {
    const form = await this.#ui.showForm({
      title,
      fields: [{ name: 'name', label: 'Project name', value: suggested }],
      okLabel: 'Save',
    });
    return form?.name?.trim() || null;
  }

  #showBrowseModal(entries) {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = 'Open project';
    form.append(h2);

    if (entries.length === 0) {
      const p = document.createElement('p');
      p.className = 'ct-dialog__hint';
      p.textContent = 'No saved projects yet. Use File ▸ Save project.';
      form.append(p);
    } else {
      const list = document.createElement('ul');
      list.className = 'ct-dialog__vars ct-lib__list';
      for (const e of entries) list.append(this.#entryRow(e, dialog));
      form.append(list);
    }

    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const close = document.createElement('button');
    close.type = 'submit';
    close.value = 'cancel';
    close.textContent = 'Close';
    menu.append(close);
    form.append(menu);
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  #entryRow(entry, dialog) {
    const li = document.createElement('li');
    li.className = 'ct-lib__row';
    const info = document.createElement('div');
    info.className = 'ct-lib__info';
    const name = document.createElement('div');
    name.className = 'ct-lib__name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'ct-lib__meta';
    const when = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : '';
    meta.textContent = `${entry.datasetCount} dataset${entry.datasetCount === 1 ? '' : 's'}${when ? ` · ${when}` : ''}`;
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'ct-lib__actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ct-dialog__primary';
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      dialog.close('cancel');
      void this.openProject(entry.id);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ct-lib__delete';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      del.disabled = true;
      await this.#delete(entry.id);
      li.remove();
    });
    actions.append(open, del);
    li.append(info, actions);
    return li;
  }

  #setStatus(state, nameOverride) {
    if (!this.#statusEl) return;
    const name = nameOverride ?? this.#binding?.name;
    let text;
    if (state === 'saving') text = `Project: ${name ?? '…'} — saving…`;
    else if (state === 'loading') text = 'Project: loading…';
    else if (state === 'error') text = `Project: ${name ?? ''} — save failed`;
    else if (this.#binding) text = `Project: ${this.#binding.name} — saved ✓`;
    else if (typeof state === 'string' && state !== 'saved') text = state;
    // "Unsaved project" is a project that hasn't been saved yet. With none open at all
    // there is nothing to be unsaved (#158) — saying otherwise is the old conflation in
    // the one place the user can actually see it.
    else if (!this.#open) text = 'No project open';
    else text = 'Unsaved project';
    this.#statusEl.textContent = text;
  }
}

/**
 * A minimal yes/no confirmation modal (matching the app's `ct-dialog` conventions).
 * Resolves true only if the user clicks the primary button; Cancel/Escape/backdrop
 * resolve false. `danger` styles the primary button as a destructive action.
 * @param {{title: string, message: string, okLabel?: string, danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, message, okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';
    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = title;
    const p = document.createElement('p');
    p.className = 'ct-dialog__hint';
    p.textContent = message;
    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = danger ? 'ct-dialog__danger' : 'ct-dialog__primary';
    ok.textContent = okLabel;
    menu.append(cancel, ok);
    form.append(h2, p, menu);
    dialog.append(form);

    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } dialog.close(); };
    cancel.addEventListener('click', () => finish(false));
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(true); });
    dialog.addEventListener('close', () => { if (!done) { done = true; resolve(false); } dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
