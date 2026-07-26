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
