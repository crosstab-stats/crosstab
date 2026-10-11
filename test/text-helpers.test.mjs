/**
 * @file text-helpers.test.mjs
 * The two transforms that must mean the same thing everywhere — and the duplication audit
 * that produced them.
 *
 * The owner asked (2026-10-10) for a sweep for "functions with a similar smell where there
 * is risk of capability drift due to unnecessary functional redundancy". It found two that
 * had already drifted, not merely risked it:
 *
 * - **Escaping: 16 helpers across 13 files, 4 character sets** — `&<>`, `&<>"`, `&<>"'`,
 *   and a quotes-only `attr()`. Two call sites fed a text-only escaper into an HTML
 *   attribute, which is a bug in both.
 * - **Ellipsis stripping: 9 sites, 2 behaviours.** Six handled only the single character
 *   `…`, three also handled `...`, so a menu item written with three dots kept its dots on
 *   some screens and lost them on others.
 *
 * Neither drifted by decision. They drifted because writing a three-line helper is faster
 * than finding the one that already exists — so the test that matters most here is the last
 * one in the file, which fails if a fourteenth copy appears.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { escapeHtml, stripEllipsis } from '../core/text.js';

// =============================================================================
// escapeHtml
// =============================================================================

test('all five characters, including both quotes', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('safe in an attribute, which is the bug this consolidation fixed', () => {
  // core/app.js put a user-typed WebDAV path into value="…" through an escaper that left
  // quotes alone; builtin-html-export did the same with plugin-supplied image alt text,
  // into a file people then share.
  const hostile = '" onerror="alert(1)';
  const html = `<img alt="${escapeHtml(hostile)}">`;
  assert.doesNotMatch(html, /onerror="/, 'the attribute cannot be closed early');
  assert.match(html, /&quot; onerror=&quot;/);
});

test('safe in a single-quoted attribute too', () => {
  assert.doesNotMatch(`<a title='${escapeHtml("' onclick='x")}'>`, /onclick='/);
});

test('the ampersand is not double-escaped', () => {
  // A two-pass implementation that escaped `<` before `&` would turn `&lt;` into `&amp;lt;`.
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml(escapeHtml('<')), '&amp;lt;', 'escaping twice IS double-escaping — by the caller');
});

test('null and undefined are empty, not the words', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
});

test('ordinary text passes through untouched', () => {
  assert.equal(escapeHtml('Household income (£)'), 'Household income (£)');
});

// =============================================================================
// stripEllipsis
// =============================================================================

test('both spellings of a trailing ellipsis', () => {
  assert.equal(stripEllipsis('Frequencies…'), 'Frequencies');
  assert.equal(stripEllipsis('Frequencies...'), 'Frequencies', 'the half that six copies missed');
});

test('trailing space around it goes too', () => {
  assert.equal(stripEllipsis('Run R script … '), 'Run R script');
});

test('an ellipsis that is not trailing stays', () => {
  assert.equal(stripEllipsis('Wait… then go'), 'Wait… then go');
  assert.equal(stripEllipsis('…'), '');
});

test('a label with no ellipsis is returned as it was', () => {
  assert.equal(stripEllipsis('Crosstabs'), 'Crosstabs');
  assert.equal(stripEllipsis(null), '');
});

// =============================================================================
// The guard — the part that stops the fourteenth copy
// =============================================================================

const CORE = readdirSync('core').filter((f) => f.endsWith('.js')).map((f) => `core/${f}`);

test('no core module defines its own HTML escaper', () => {
  const offenders = [];
  for (const f of CORE) {
    // plugin-stdlib.js IS the implementation (text.js re-exports it, and the sandbox
    // imports it as source); sanitize-html.js does a different job entirely.
    if (f === 'core/plugin-stdlib.js' || f === 'core/text.js' || f === 'core/sanitize-html.js') continue;
    const src = readFileSync(f, 'utf8');
    // The shape every one of the sixteen took: a replace over the HTML metacharacters.
    if (/replace\(\s*\/\[?&[^)]*\/g?\s*,/.test(src) && /&amp;/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'import escapeHtml from core/text.js instead');
});

test('no core module strips a trailing ellipsis by hand', () => {
  const offenders = CORE.filter((f) => f !== 'core/text.js' && f !== 'core/plugin-stdlib.js')
    .filter((f) => /replace\(\/(?:…|\\\.\\\.\\\.)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'import stripEllipsis from core/text.js instead');
});

test('the helpers the audit found duplicated are each defined once', () => {
  // downloadBlob was byte-identical in two files; sha256hex had two spellings; b64url had
  // a robust loop in one place and a `String.fromCharCode(...bytes)` spread in the other,
  // which throws RangeError on a large array. One definition each now.
  const count = (needle) => CORE.filter((f) => readFileSync(f, 'utf8').includes(needle)).length;
  assert.equal(count('function downloadBlob('), 1);
  assert.equal(count('function sha256hex('), 1);
  assert.equal(count('function b64url('), 1);
  const invite = readFileSync('core/live-invite.js', 'utf8');
  assert.doesNotMatch(invite, /String\.fromCharCode\(\.\.\./, 'the spread copy is the one that went');
});
