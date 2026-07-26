/**
 * @file debug.js
 * Gated diagnostic logger. Silent by default — enable in the browser console:
 *
 *     localStorage.crosstab_debug = '1'     // all tags
 *     localStorage.crosstab_debug = 'ws-mgr,app'  // only these tags
 *
 * Then reload. Disable with `delete localStorage.crosstab_debug`.
 *
 * Tags are short module-level identifiers (`ws-mgr`, `app`, `broker`, etc.).
 * When the gate value is `'1'` or `'*'`, all tags pass. Otherwise it's a
 * comma-separated allowlist.
 */

let _enabled = false;
/** @type {Set<string>|'all'} */
let _tags = 'all';

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
 * isn't in the allowlist. Output goes to `console.debug` (collapsed by
 * default in most DevTools, visible when the "Verbose" level is ticked).
 *
 * @param {string} tag  Short module identifier, e.g. `'ws-mgr'`.
 * @param  {...any} args  Arbitrary values — same as console.debug.
 */
export function debug(tag, ...args) {
  if (!_enabled) return;
  if (_tags !== 'all' && !_tags.has(tag)) return;
  console.debug(`[${tag}]`, ...args);
}

/** Whether debug output is currently enabled (any tag). */
export function isDebug() {
  return _enabled;
}
