/**
 * @file plugin-stdlib.test.mjs
 * The stdlib a plugin is handed, and the path it travels to get there.
 *
 * ## Why it exists
 *
 * A plugin runs in a sandboxed, opaque-origin iframe and cannot import from `core/`, so
 * every helper core shares it has had to re-derive. The duplication audit (2026-10-10)
 * found our own built-ins proving the cost — `filenameFor()` byte-identical in three
 * places, HTML escaping in 17 spellings across 14 files, `el()` in 509 call sites and four
 * signatures. The host half was fixed by consolidating; the plugin half could not be,
 * because there was nothing to consolidate ONTO.
 *
 * ## The shape of the fix
 *
 * `plugin-stdlib.js` is the implementation and `core/text.js` re-exports from it, so the
 * host and every plugin run the same code rather than two copies that agree today.
 * Solving a duplication problem by adding one more copy for plugins would have been the
 * joke writing itself — so the host's own ~74 escaping call sites exercise exactly what
 * the plugins get.
 *
 * It travels as SOURCE over the path the chart stdlib already proved: the host fetches the
 * text, posts it with `load`, and the frame blob-imports it in its own realm (a blob URL
 * minted in the host's realm is not fetchable from an opaque origin). It lands on
 * `app.std`, which every plugin shape already receives — `app` is the first argument to
 * every invoked function — so there is no manifest section to adopt.
 *
 * Verified live, not just here: a scratch plugin loaded through `loader.activateSource`
 * reported all ten exports present, with `escapeHtml('a"b')` giving `a&quot;b`,
 * `filenameFor('My Report!!', 'html')` giving `my-report.html`, `formatCount(5456, 'row')`
 * giving `5,456 rows`, and `el('div', {class:'c', text:'t'})` producing class `c` / text
 * `t`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  STDLIB_VERSION, escapeHtml, stripEllipsis, slug, filenameFor,
  formatNumber, formatCount, formatWhen, joinMeta,
} from '../core/plugin-stdlib.js';

// =============================================================================
// Names
// =============================================================================

test('filenameFor is the function three exporters had each written out', () => {
  assert.equal(filenameFor('My Report!!', 'html'), 'my-report.html');
  assert.equal(filenameFor('', 'docx'), 'crosstab-output.docx');
  assert.equal(filenameFor(null, 'csv'), 'crosstab-output.csv');
});

test('a long title cannot produce an unusable filename', () => {
  assert.equal(slug('x'.repeat(200)).length, 60);
});

test('punctuation collapses rather than accumulating dashes', () => {
  assert.equal(slug('A — B: C?!'), 'a-b-c');
  assert.equal(slug('...leading and trailing...'), 'leading-and-trailing');
});

// =============================================================================
// Formatting — the app's voice
// =============================================================================

test('numbers are grouped, because 5456 does not read at a glance', () => {
  assert.equal(formatNumber(5456), (5456).toLocaleString());
  assert.equal(formatNumber('nope'), '');
});

test('counts agree with their noun', () => {
  assert.equal(formatCount(1, 'row'), '1 row');
  assert.equal(formatCount(2, 'row'), '2 rows');
  assert.equal(formatCount(0, 'dataset'), '0 datasets');
  assert.equal(formatCount(3, 'analysis', 'analyses'), '3 analyses', 'an irregular plural is passed in');
});

const DAY = 86400000;
const NOW = 1760000000000;

test('a date is relative while that is the more useful answer', () => {
  assert.equal(formatWhen(NOW, { now: NOW }), 'just now');
  assert.equal(formatWhen(NOW - 30 * 60000, { now: NOW }), '30 mins ago');
  assert.equal(formatWhen(NOW - 3 * DAY, { now: NOW }), '3 days ago');
});

test('and absolute once it stops being', () => {
  const old = formatWhen(NOW - 30 * DAY, { now: NOW });
  assert.doesNotMatch(old, /ago/);
  assert.match(old, /\d{4}/);
});

test('a timestamp from the future does not read as negative time', () => {
  // Clock skew between devices is ordinary, and "in -3 days" makes a reader distrust
  // everything else on the row.
  assert.doesNotMatch(formatWhen(NOW + 5 * DAY, { now: NOW }), /ago/);
});

test('no timestamp is an empty string, not "Invalid Date"', () => {
  assert.equal(formatWhen(0), '');
  assert.equal(formatWhen(null), '');
  assert.equal(formatWhen('soon'), '');
});

test('joinMeta drops what the caller does not know', () => {
  // A fact we do not have is left out, never rendered as 0 or "unknown" — a project saved
  // before row counts were recorded says less, instead of saying something false.
  assert.equal(joinMeta(['3 days ago', null, '', '2 datasets']), '3 days ago · 2 datasets');
  assert.equal(joinMeta([]), '');
  assert.equal(joinMeta(), '');
});

// =============================================================================
// Text — the same functions core uses, reached the other way
// =============================================================================

test('escapeHtml here IS the one core uses', async () => {
  const viaText = await import('../core/text.js');
  assert.equal(viaText.escapeHtml, escapeHtml, 'text.js re-exports, it does not reimplement');
  assert.equal(viaText.stripEllipsis, stripEllipsis);
});

test('and it is attribute-safe, which is what the audit was about', () => {
  assert.equal(escapeHtml(`a"b'c`), 'a&quot;b&#39;c');
});

// =============================================================================
// The delivery path
// =============================================================================

const loader = readFileSync('core/loader.js', 'utf8');
const broker = readFileSync('core/plugin-broker.js', 'utf8');
const host = readFileSync('plugin-host.html', 'utf8');

test('the host fetches it as source, cached, resolved against its own URL', () => {
  // Resolved against import.meta.url so it follows the app wherever it is served from;
  // cached because every plugin load would otherwise re-read it.
  assert.match(loader, /fetch\(new URL\('\.\/plugin-stdlib\.js', import\.meta\.url\)\)/);
  assert.match(loader, /let pluginStdlibPromise = null;/);
});

test('every plugin load carries it', () => {
  // Both activate paths — not just one — or a plugin's stdlib would depend on how it
  // happened to be loaded.
  const calls = loader.match(/sendLoad\(code, await chartStdlibSource\(\), modules, await pluginStdlibSource\(\)\)/g);
  assert.equal(calls?.length, 2);
});

test('the frame imports it in ITS realm, and never dies if it is missing', () => {
  // A blob URL minted in the host's realm is not fetchable from an opaque origin, which
  // is why the source travels as text and is blobbed on the far side.
  assert.match(host, /URL\.createObjectURL\(new Blob\(\[msg\.std\]/);
  assert.match(host, /catch \(err\) \{ std = null;/, 'a failed import leaves app.std undefined, not a dead plugin');
  assert.match(host, /finally \{ URL\.revokeObjectURL\(url\); \}/);
});

test('it lands on app.std, so no plugin needs a manifest section for it', () => {
  assert.match(host, /^\s*std,$/m);
});

test('the stdlib imports nothing — it is imported standalone in the sandbox', () => {
  // A relative specifier would resolve against a blob URL and fail. This is the one
  // constraint that would break the whole mechanism, and it would break at RUNTIME only.
  const src = readFileSync('core/plugin-stdlib.js', 'utf8');
  assert.doesNotMatch(src, /^import\s/m);
  assert.match(STDLIB_VERSION, /^\d+\.\d+\.\d+$/);
});

// =============================================================================
// The built-ins that proved the need now use it
// =============================================================================

test('the two exporters no longer carry their own filenameFor', () => {
  for (const f of ['plugins/builtin-html-export/index.js', 'plugins/builtin-docx-export/index.js']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /^function filenameFor\(/m, `${f} still defines its own`);
    assert.match(src, /const \{[^}]*filenameFor[^}]*\} = lib\(app\)/, `${f} should take it from app.std`);
  }
});

test('…and they still work without it, because a plugin must not break on a bad build', () => {
  // The fallbacks are not belt-and-braces: a build that fails to serve the stdlib would
  // otherwise take every migrated plugin down with it.
  const src = readFileSync('plugins/builtin-html-export/index.js', 'utf8');
  assert.match(src, /const std = app && app\.std;/);
  assert.match(src, /\(std && std\.escapeHtml\) \|\|/);
});
