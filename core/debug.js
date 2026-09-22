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

const MAX_BUFFER = 2000;

let _enabled = false;
/** @type {Set<string>|'all'} */
let _tags = 'all';
/** @type {Array<{ts: number, tag: string, args: any[]}>} */
const _buffer = [];

function _readGate() {
  try {
    const raw = localStorage.getItem('crosstab_debug');
    if (!raw) { _enabled = false; return; }
    _enabled = true;
    _tags = (raw === '1' || raw === '*') ? 'all' : new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  } catch {
    _enabled = false;
  }
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
}

/** Whether debug output is currently enabled (any tag). */
export function isDebug() {
  return _enabled;
}

/** Turn debug logging on or off (updates localStorage + live state). */
export function setDebug(on) {
  try {
    if (on) {
      localStorage.setItem('crosstab_debug', '1');
    } else {
      localStorage.removeItem('crosstab_debug');
    }
  } catch { /* sandboxed / private browsing */ }
  _readGate();
  if (on) debug('debug', 'logging enabled');
}

/** Export the buffered log entries as a downloadable JSON file. */
export function saveLog() {
  const payload = {
    exported: new Date().toISOString(),
    userAgent: navigator.userAgent,
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
}
