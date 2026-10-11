/**
 * @file caqdas-stdlib-migration.test.mjs
 * CAQDAS as a good citizen of the plugin stdlib: the host's `el()`, and the host's colours.
 *
 * It was the plugin with the most to gain and the most to break — 197 `el()` calls and a
 * stylesheet of 45 literal colours, hand-matched to the host by eye. Both are the shapes
 * the duplication audit flagged:
 *
 * - `el(tag, cls, text)` is one of FOUR signatures in this app, two of which take the same
 *   three arguments in opposite order. A line copied between files silently swaps an
 *   element's class with its text; both render, one is nonsense, nothing errors.
 * - Literal hex cannot follow a theme. Every pane is an opaque-origin iframe that inherits
 *   no custom properties, so "match the host" has meant "copy its colours and hope".
 *
 * The rendering was verified in the browser afterwards, which is the check that matters
 * for a swap-the-arguments migration: the document list draws `#1` in muted grey beside
 * each title, the active row highlights, and the text pane fills. A class/text swap would
 * put row numbers in the class attribute and be obvious on sight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('plugins/builtin-caqdas/index.js', 'utf8');
const styles = src.slice(src.indexOf('const STYLES = `'), src.indexOf('`;', src.indexOf('const STYLES = `')));

test('no positional el() call survives', () => {
  // `el('div', 'cls')` rather than `el('div', { class: 'cls' })` — the shape that can be
  // ordered wrong. A second argument that is not an object literal is the tell.
  const bad = [...src.matchAll(/(?<![\w.$])el\(\s*[^,)]+\s*,\s*([^,){\s])/g)]
    .map((m) => src.slice(0, m.index).split('\n').length);
  assert.deepEqual(bad, [], 'these lines still pass the class positionally');
});

test('the helper delegates to the host rather than reimplementing', () => {
  assert.match(src, /const el = app\.std\?\.el \?\? \(\(tag, opts = \{\}\) => \{/);
});

test('…and still works on a build that failed to serve the stdlib', () => {
  // A missing convenience must not take the coding workspace down with it.
  const fb = src.slice(src.indexOf('const el = app.std?.el'), src.indexOf('const el = app.std?.el') + 400);
  assert.match(fb, /opts\.class/);
  assert.match(fb, /e\.textContent = String\(opts\.text\)/, 'textContent, never innerHTML');
});

test('the structural palette comes from the host tokens', () => {
  for (const token of ['--ct-text', '--ct-line', '--ct-line-soft', '--ct-accent', '--ct-muted', '--ct-danger', '--ct-surface']) {
    assert.ok(styles.includes(`var(${token})`), `${token} is unused — the migration missed it`);
  }
});

test('the colours it still owns are left alone', () => {
  // The amber drift warning and the accent-derived hover tints are this plugin's design
  // decisions, not instances of a shared value. Tokenising them would have been tidier and
  // wrong.
  assert.match(styles, /#fff4e0/, 'drift warning background');
  assert.match(styles, /#8a6d3b/, 'drift warning text');
});

test('white is a SURFACE only where it is a background', () => {
  // As a text colour `#fff` means "legible on a painted code chip", which is a different
  // idea and must not follow a theme's background.
  assert.doesNotMatch(styles, /background(-color)?:\s*#fff\b/);
  assert.match(styles, /color:\s*#fff\b/, 'text on a painted chip stays white');
});
