/**
 * @file tab-strip-narrow.test.mjs
 * The view tab strip at phone width: tabs keep their size, the strip scrolls, and the tab
 * you just activated is the one you can see.
 *
 * ## The bug
 *
 * Small-screen mode made `.tabs` scroll (`overflow-x: auto`) on the reasoning that "a tab
 * you cannot reach is a view you cannot reach" — and it did not work, because `.tabs` is a
 * flex row and a flex item's default `flex-shrink: 1` outranks the container's overflow.
 * The items squeezed instead of overflowing, so there was never anything to scroll.
 *
 * The owner's iPhone screenshot (2026-10-10, with a CAQDAS workspace tab open) shows both
 * halves of it: **"R Console" broken onto two lines** inside its own tab, and the active
 * **"Coding" tab sliced in half at the right edge** — selected, underlined, and unreadable.
 *
 * Two fixes, because they are two faults:
 *
 * 1. `flex: 0 0 auto; white-space: nowrap` on `.tab`, so a tab is its natural width and the
 *    strip genuinely overflows. Measured at a 390px strip: 435px of tabs, 524px of scroll
 *    width, nothing shrunk.
 * 2. `scrollIntoView({ inline: 'nearest' })` on the selected tab. Opening a workspace
 *    APPENDS its tab, so on a narrow screen the tab you just activated is precisely the one
 *    off the right edge. `nearest` scrolls only when it must, so switching between two
 *    already-visible tabs does not jerk the row.
 *
 * Source-level assertions: there is no DOM here, and the behaviour was verified in the
 * browser by constraining the strip to 390px and activating the last tab — it scrolled 62px
 * and the tab came fully into view.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const app = readFileSync('core/app.js', 'utf8');

test('a tab keeps its natural width, so the strip has something to scroll', () => {
  const rule = html.slice(html.indexOf('      .tab {'), html.indexOf('.tab:hover'));
  assert.match(rule, /flex:\s*0\s+0\s+auto/, 'flex-shrink must be 0 — the default 1 defeated overflow-x');
  assert.match(rule, /white-space:\s*nowrap/, 'a label must not wrap inside its own tab');
});

test('the strip still scrolls — the half that was already right', () => {
  assert.match(html, /\.tabs \{ overflow-x: auto; scrollbar-width: thin; \}/);
});

test('activating a tab brings it into view', () => {
  assert.match(app, /if \(selected\) b\.scrollIntoView\?\.\(\{ inline: 'nearest', block: 'nearest' \}\)/);
});

test('…only when it has to, so visible tabs do not jump the row', () => {
  // `inline: 'start'` would scroll on every switch, yanking the strip under the thumb.
  assert.doesNotMatch(app, /scrollIntoView\?\.\(\{ inline: '(start|center|end)'/);
});

test('it is driven off the same flag that sets aria-selected', () => {
  // One decision, used twice: a tab cannot end up announced as selected while the strip
  // is scrolled somewhere else.
  const show = app.slice(app.indexOf('  const show = (name) => {'), app.indexOf('syncClearBtn(current);'));
  assert.match(show, /const selected = b\.dataset\.view === name;/);
  assert.match(show, /b\.setAttribute\('aria-selected', String\(selected\)\)/);
});
