/**
 * @file debug.js
 * Gated diagnostic logger. Silent by default — enable via the
 * Edit ▸ Debugging menu, or in the browser console:
 *
 *     localStorage.crosstab_debug = '1'     // all tags
 *     localStorage.crosstab_debug = 'ws-mgr,app'  // only these tags
 *
 * Tags are short module-level identifiers (`ws-mgr`, `app`, `broker`, etc.).
 * When the gate value is `'1'` or `'*'`, all tags pass. Otherwise it's a
 * comma-separated allowlist.
 *
 * When enabled, messages are also buffered in a ring buffer (most recent
 * {@link MAX_BUFFER} entries). `saveLog()` exports the buffer as a JSON file
 * the user can attach to a bug report.
 */

import { defineSetting } from './settings.js';
// build-stamp.js imports nothing, so this cannot cycle. (help.js, which collects the
// same two fields for Help ▸ Report a bug…, imports FROM here — which is why this
// module reads the stamp itself rather than borrowing `collectDiagnostics`.)
import { formatBuildTime, runningBuildStamp } from './build-stamp.js';

const MAX_BUFFER = 2000;

/**
 * The gate, as a declared setting.
 *
 * Free-form rather than a boolean: the value is `1`/`*` for everything, or a
 * comma-separated tag list (`ws-mgr,app`) — so no `values` list, and the menu's
 * checkbox writes `1` while a developer typing into the console can still narrow it.
 * Off is the key being ABSENT, which is why `setDebug(false)` clears rather than writes.
 */
const gateSetting = defineSetting({
  id: 'debug.logging',
  key: 'crosstab_debug',
  fallback: '',
  onError: '', // sandboxed / private browsing ⇒ logging stays off
  label: 'Debug logging',
  group: 'Advanced',
  hint: 'Record diagnostics for a bug report. Off unless you have been asked to turn it on.',
  // The gate is cached in module state (`_enabled`, `_tags`) so that a disabled log call
  // costs nothing, which means a change to the stored value is invisible until something
  // re-reads it. Re-reading IS the apply.
  apply: () => _readGate(),
});

let _enabled = false;
/** @type {Set<string>|'all'} */
let _tags = 'all';
/** @type {Array<{ts: number, tag: string, args: any[]}>} */
const _buffer = [];

function _readGate() {
  const raw = gateSetting.get();
  if (!raw) { _enabled = false; return; }
  _enabled = true;
  _tags = (raw === '1' || raw === '*') ? 'all' : new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
_readGate();

/**
 * Log a tagged diagnostic message. No-op when the gate is off or the tag
 * isn't in the allowlist. Output goes to `console.debug` and the ring buffer.
 *
 * @param {string} tag  Short module identifier, e.g. `'ws-mgr'`.
 * @param  {...any} args  Arbitrary values — same as console.debug.
 */
export function debug(tag, ...args) {
  if (!_enabled) return;
  if (_tags !== 'all' && !_tags.has(tag)) return;
  console.debug(`[${tag}]`, ...args);
  _buffer.push({ ts: Date.now(), tag, args: _serialize(args) });
  if (_buffer.length > MAX_BUFFER) _buffer.splice(0, _buffer.length - MAX_BUFFER);
  _persistSoon();
}

// --- surviving a process kill -------------------------------------------------
//
// Every diagnostic in this file assumes the page lives long enough to export. On iOS it
// does not: importing a CSV on an iPhone relaunched the PWA outright (owner, 2026-11-18)
// — the web view was killed for memory, which is not a JS error, so no handler ran, the
// ring buffer died with the process, and the exported log from the next launch was empty.
// The one crash that most needed evidence is the one that destroys it.
//
// So the tail is mirrored to localStorage as it is written, and the NEXT launch picks it
// up and carries it in the export as `previousSession`. A hard kill now leaves a trace.
//
// Throttled, and small: this runs on every logged line, and a synchronous localStorage
// write per line on a phone is its own problem. The tail is what matters — the last
// moments before the kill — so it keeps the final {@link PERSIST_ENTRIES}.

/** Entries mirrored for the next launch. The tail, not the history: enough to see what
 * was happening, small enough that writing it is cheap and it cannot fill the quota. */
const PERSIST_ENTRIES = 80;
/** Minimum gap between mirror writes. */
const PERSIST_MS = 1000;
const PERSIST_KEY = 'crosstab_debug_tail';

let _persistAt = 0;
let _persistTimer = null;

/** Mirror the tail, at most once per {@link PERSIST_MS}, trailing-edge so the LAST
 * lines before a kill are the ones that survive. */
function _persistSoon() {
  const now = Date.now();
  if (now - _persistAt < PERSIST_MS) {
    if (_persistTimer == null && typeof setTimeout === 'function') {
      _persistTimer = setTimeout(() => { _persistTimer = null; _persistNow(); }, PERSIST_MS);
    }
    return;
  }
  _persistNow();
}

function _persistNow() {
  _persistAt = Date.now();
  try {
    const tail = _buffer.slice(-PERSIST_ENTRIES).map((e) => ({
      time: new Date(e.ts).toISOString(),
      tag: e.tag,
      message: e.args,
    }));
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ at: new Date().toISOString(), tail }));
  } catch {
    // Quota, private mode, or no localStorage at all. A diagnostic that breaks the app
    // it is diagnosing is worse than no diagnostic.
  }
}

/** The tail left behind by the previous page load, read once at module load — before
 * anything this session can overwrite it. Null when there is none. */
const _previousSession = (() => {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
})();

/** What the previous page load was doing when it stopped. Present in a saved log as
 * `previousSession`, and the only evidence available after an out-of-memory kill. */
export function previousSession() {
  return _previousSession;
}

/** Mirror the tail NOW, bypassing the throttle. Called when the page is going away —
 * `pagehide`/`freeze` is the last word a browser gives you, and on iOS it is sometimes
 * the only one before the web view is reclaimed. */
export function flushDebugTail() {
  if (_persistTimer != null) {
    try { clearTimeout(_persistTimer); } catch { /* no timers here */ }
    _persistTimer = null;
  }
  _persistNow();
}

/** Whether debug output is currently enabled (any tag). */
export function isDebug() {
  return _enabled;
}

/** Turn debug logging on or off (updates localStorage + live state). */
export function setDebug(on) {
  if (on) gateSetting.set('1');
  else gateSetting.clear(); // off is the ABSENCE of the key, not the string "0"
  _readGate();
  if (on) debug('debug', 'logging enabled');
}

/**
 * Export the buffered log entries as a downloadable JSON file.
 *
 * ## Why the header is bigger than it was
 *
 * It used to carry `exported`, `userAgent` and the entries, and that is not enough to
 * triage anything. A report off the owner's work desktop (a 67 MB CSV dying at 3.1 GiB)
 * arrived as one entry — `logging enabled` — and no way to tell WHICH BUILD produced
 * it. A day went into the stale-service-worker theory before the build stamp, read from
 * a separate Help ▸ Report a bug…, showed the build was current and the fault was
 * somewhere else entirely.
 *
 * `collectDiagnostics` in help.js had both fields all along. The export did not, and
 * nobody files two reports. So the fields that answer the first two questions are here:
 *
 *  - `build`, via `runningBuildStamp`, which reads THROUGH the service worker and so
 *    reports the code actually executing rather than the newest deploy (build-stamp.js
 *    explains why those differ on an installed PWA, and why getting it backwards tells
 *    you that you are up to date while you run last week's code).
 *  - `lastError`, the always-on single slot. The ring buffer only fills when debugging
 *    was ENABLED, which is exactly wrong for a bug report — nobody turns debugging on
 *    before the thing they could not reproduce. An export can therefore have no entries
 *    and still carry the failure.
 */
export async function saveLog() {
  let build = 'unknown';
  try {
    build = formatBuildTime(await runningBuildStamp()) || 'unknown';
  } catch {
    /* a report that cannot name its build is still worth having */
  }
  const payload = {
    exported: new Date().toISOString(),
    build,
    userAgent: navigator.userAgent,
    // Whether the fast multi-threaded path is even available on this device.
    isolated: typeof crossOriginIsolated === 'boolean' ? String(crossOriginIsolated) : 'unknown',
    lastError: lastError(),
    // What the PREVIOUS page load was doing when it stopped. After an out-of-memory kill
    // this is the only evidence there is: no error fires, and this session's buffer
    // starts empty because the process that filled it is gone.
    previousSession: previousSession(),
    entries: _buffer.map((e) => ({
      time: new Date(e.ts).toISOString(),
      tag: e.tag,
      message: e.args,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `crosstab-debug-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function _serialize(args) {
  return args.map((v) => {
    if (v === undefined) return '(undefined)';
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(String);
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
  });
}

// --- last error, always on ----------------------------------------------------
//
// The ring buffer above only fills when debugging is ENABLED, which is exactly wrong
// for a bug report: nobody turns debugging on before the thing they cannot reproduce.
// So one slot, recorded unconditionally, costing a string assignment per uncaught error.
//
// It is deliberately NOT a second buffer. A report needs "what broke last", and a
// history of everything that ever broke is both larger than a URL can carry (#175) and
// more than a reporter can be asked to read before they send it.

/** @type {{time: string, message: string, where: string, stack: string}|null} */
let _lastError = null;

/** One stack, clipped: enough to name the failing module, short enough for a URL. */
function _clipStack(stack) {
  if (typeof stack !== 'string' || !stack) return '';
  return stack.split('\n').slice(0, 4).join('\n').slice(0, 600);
}

/**
 * Record an uncaught error for a later bug report. Called by the global handlers below,
 * and available to any code that swallows an error it still wants reported.
 *
 * @param {any} err
 * @param {string} [where] - a hint about the source, e.g. 'unhandledrejection'.
 */
export function recordError(err, where = '') {
  try {
    const message = err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err && err.message ? err.message : err);
    _lastError = {
      time: new Date().toISOString(),
      message: message.slice(0, 300),
      where: String(where).slice(0, 120),
      stack: _clipStack(err instanceof Error ? err.stack : ''),
    };
  } catch {
    /* recording a failure must never be a second failure */
  }
}

/** The last uncaught error, or null. */
export function lastError() {
  return _lastError;
}

/** Install the global capture. Idempotent; called once from app start-up. */
export function installErrorCapture(target = globalThis) {
  if (target.__ctErrorCapture) return;
  target.__ctErrorCapture = true;
  target.addEventListener?.('error', (e) => {
    // A failed <img>/<script> load also fires 'error' on window, with no `error` object.
    // Those are not app faults and would evict a real one from the single slot.
    if (!e?.error) return;
    recordError(e.error, e.filename ? `${e.filename}:${e.lineno ?? '?'}` : 'error');
  });
  target.addEventListener?.('unhandledrejection', (e) => {
    recordError(e?.reason, 'unhandledrejection');
  });
  // The page going away is the last chance to write the tail. `pagehide` fires on a
  // normal navigation and on a bfcache suspend; `freeze` fires when a background tab is
  // discarded. Neither fires on a hard out-of-memory kill — that is what the throttled
  // mirror in `debug()` is for — but when one DOES fire it costs nothing to take it.
  for (const evt of ['pagehide', 'freeze']) {
    target.addEventListener?.(evt, () => { if (_enabled) flushDebugTail(); });
  }
}
