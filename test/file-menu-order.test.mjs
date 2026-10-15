/**
 * @file file-menu-order.test.mjs
 * File's in/out block is contiguous, and a nested menu group reads as nested.
 *
 * Two findings from the owner, same root: one renderer draws every depth, and nothing
 * said which depth anything was.
 *
 * **The File menu.** Three items begin with "Export" and they were at orders 10, 31 and
 * 32 — `Export output…` ten slots and four unrelated items away from the other two. A
 * word repeating in three scattered places reads as clutter; the same word repeating in
 * one block reads as a list. The fix was adjacency, not a submenu: the group cannot grow
 * (plugins have no way to register a File item — the host files their manifest menu
 * entries under the plugin's own category), so a container would add a click to the
 * most-used item to tidy three things that will stay three.
 *
 * **The nested group.** `Edit ▸ Debugging` is drawn by the same `#renderSubmenu` as a
 * top-level menu, so in the ☰ panel it had identical chrome — full-width uppercase
 * heading, no indent — and sat in the list looking like a sibling of Transform, while
 * disappearing when Edit collapsed. Depth lives only in CSS, so that is what this guards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sources = ['core/app.js', 'core/export-service.js', 'core/import-service.js',
  'core/output-export.js', 'core/project-sync.js']
  .map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Every File item, as {label, order}.
 *
 * A window after each `path: ['File']`, ending at the NEXT one, rather than a match up
 * to the registration's closing brace: two of these items carry long `command` bodies,
 * and a pattern that needed to reach the end of the object skipped them silently — a
 * menu-order test that cannot see two of the items is worse than none, so the count is
 * asserted below. A fixed-size window is no good either; a comment between `label` and
 * `order` was enough to push one out of a 200-character one.
 */
function fileItems() {
  const out = [];
  const starts = [...sources.matchAll(/path: \['File'\]/g)].map((m) => m.index);
  for (const [i, at] of starts.entries()) {
    const win = sources.slice(at, starts[i + 1] ?? at + 2000);
    const label = win.match(/label: '([^']+)'/);
    const order = win.match(/order: (\d+)/);
    assert.ok(label && order, `a File item near "${win.slice(0, 60)}" has no label/order`);
    out.push({ label: label[1], order: Number(order[1]) });
  }
  return out.sort((a, b) => a.order - b.order);
}

test('the import/export items form one contiguous block at the end of File', () => {
  const items = fileItems();
  assert.equal(items.length, 13, 'File gained or lost an item — update this test deliberately');
  const io = items.filter((i) => /^(Import|Export)\b/.test(i.label));
  assert.equal(io.length, 4, io.map((i) => i.label).join(', '));
  const first = items.findIndex((i) => i === io[0]);
  assert.deepEqual(items.slice(first).map((i) => i.label), io.map((i) => i.label),
    'nothing unrelated may sit inside or after the in/out block');
  assert.deepEqual(io.map((i) => i.label), [
    'Import data…', 'Export data…', 'Export output…', 'Export analysis script…',
  ]);
});

test('Copy dataset stays OUT of the export block', () => {
  // It copies a dataset into another CrossTab project and writes no file. Filing it with
  // the exports would state the wrong destination, which is the one thing a label must
  // get right.
  const items = fileItems();
  const copy = items.find((i) => i.label.startsWith('Copy dataset'));
  const firstIO = items.find((i) => /^(Import|Export)\b/.test(i.label));
  assert.ok(copy.order < firstIO.order, 'Copy dataset must not sit among the exports');
});

test('a nested menu group is styled as nested, not as a top-level one', () => {
  // `#renderSubmenu` gives a nested group the same element and classes as a top-level
  // menu, so without a depth-aware rule the two are indistinguishable in the ☰ panel.
  const css = readFileSync('index.html', 'utf8');
  const rule = css.match(/\[data-screen="small"\] \.menu__flyout \.menu__group-toggle \{[^}]*\}/);
  assert.ok(rule, 'nothing distinguishes a nested group from a top-level one');
  assert.match(rule[0], /padding-left/, 'a nested group must be indented under its parent');
  // A descendant selector is what makes this depth-only: a top-level toggle is a direct
  // child of the panel, never inside a flyout. `>` here would match nothing.
  assert.doesNotMatch(rule[0], /^\[data-screen="small"\] > /);
  assert.match(css, /\.menu__flyout \.menu__group-toggle \+ \.menu__flyout \.menu__item/,
    "a nested group's own items must indent deeper than its heading");
});

test('the renderer says that a wide-screen group is not a flyout', () => {
  // The class is called `menu__flyout` and on a wide screen nothing flies out — the
  // children render inline under a label. The comment claiming otherwise is what made a
  // submenu look like a free way to collapse the File menu.
  const src = readFileSync('core/menu-shell.js', 'utf8');
  const doc = src.slice(src.indexOf('   * Render a submenu'), src.indexOf('#renderSubmenu(node) {'));
  assert.match(doc, /NOT a flyout/);
  assert.match(doc, /depth is not in the markup/i);
});
