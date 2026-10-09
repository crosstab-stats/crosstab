/**
 * @file reflow-min-width.test.mjs
 * WCAG 2.2 AA **1.4.10 Reflow**: no fixed `min-width` wider than a 320px viewport.
 *
 * ## The bug this exists to stop coming back
 *
 * Small-screen mode (`core/screen-mode.js`) reflows the app by capping surfaces — a dialog
 * gets `width: 94vw; max-width: 94vw`. That cap is defeated by a fixed `min-width` on
 * anything INSIDE it, because a child's `min-width` outranks an ancestor's `max-width`.
 * Two places did exactly that and both shipped unnoticed:
 *
 *   - `.ct-edit { min-width: 380px }` — on the form inside the dialog, so the variable
 *     metadata editor, the rehome dialog, and every plugin dialog raised through
 *     `ui-service`'s `showForm` stayed 380px wide inside a 299px dialog.
 *   - the import-from-URL input, pinned at `min-width: 340px`.
 *
 * Measured overshoot for the first, by viewport: 320px → 81px, 375px → 29px, 390px → 15px,
 * clean above ~404px. So it failed on a phone, and failed subtly enough to read as a
 * slightly cramped dialog rather than as a defect — which is why it survived an iPhone pass.
 * The result is horizontal scrolling alongside vertical on a FORM, and 1.4.10 exempts only
 * content that genuinely needs a two-dimensional layout (it names data tables; our grid is
 * the real exemption, and keeps its 2-D scrolling on purpose).
 *
 * ## Why a source scan rather than a rendered check
 *
 * The defect is a static CSS fact, and the rendered check needs a real 320px viewport —
 * which Chrome on Windows will not give (its narrowest window is ~535 CSS px), so even the
 * live verification had to force the dialog's width to measure it. A grep over the sources
 * catches the next one at authoring time instead, in every file at once, with no browser.
 *
 * The fix pattern is `min-width: min(Npx, 100%)`: the intended comfortable width when there
 * is room, and never wider than the parent when there is not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The reflow target from the criterion itself: content must work at 320 CSS px. */
const VIEWPORT = 320;

/**
 * Declarations that are allowed to exceed it, each with the reason it is exempt.
 * Deliberately empty — it exists so that adding one is a decision somebody writes down
 * rather than a number somebody raises.
 */
const EXEMPT = [
  // e.g. { file: 'core/x.js', value: 900, why: 'the data grid, which 1.4.10 exempts' },
];

function sources() {
  const out = [];
  out.push('index.html');
  for (const f of readdirSync('core')) if (f.endsWith('.js')) out.push(`core/${f}`);
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      readFileSync(join('plugins', d.name, 'index.js'));
      out.push(`plugins/${d.name}/index.js`);
    } catch { /* not every plugin directory has one */ }
  }
  return out;
}

test('no fixed min-width is wider than a 320px viewport', () => {
  const offenders = [];
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8');
    // `min-width: 380px` — but NOT `min-width: min(380px, 100%)`, which is the fix.
    for (const m of text.matchAll(/min-width:\s*(\d+)px/g)) {
      const value = Number(m[1]);
      if (value <= VIEWPORT) continue;
      if (EXEMPT.some((e) => e.file === file && e.value === value)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line} — min-width: ${value}px`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a fixed min-width wider than 320px defeats the dialog/panel caps small-screen mode '
      + 'relies on, and reintroduces two-dimensional scrolling. Use min-width: min(Npx, 100%).',
  );
});

test('the two known offenders are fixed in the form that actually works', () => {
  // Pinning the SHAPE of the fix, not just the absence of the number: `max-width` on the
  // child, or dropping the min-width entirely, would both pass the scan above while either
  // failing to constrain the child or losing the comfortable width on a desktop.
  const html = readFileSync('index.html', 'utf8');
  assert.match(html, /\.ct-edit \{ min-width: min\(380px, 100%\); \}/);
  const imports = readFileSync('core/import-service.js', 'utf8');
  assert.match(imports, /min-width:min\(340px, 100%\)/);
});

test('the scan would have caught the bug it was written for', () => {
  // A guard nobody has seen fail is a guard nobody knows works. This runs the same matcher
  // over the pre-fix text and asserts it fires.
  const before = '.ct-edit { min-width: 380px; }';
  const hits = [...before.matchAll(/min-width:\s*(\d+)px/g)].filter((m) => Number(m[1]) > VIEWPORT);
  assert.equal(hits.length, 1, 'the matcher must flag a flat 380px');
  const after = '.ct-edit { min-width: min(380px, 100%); }';
  const none = [...after.matchAll(/min-width:\s*(\d+)px/g)].filter((m) => Number(m[1]) > VIEWPORT);
  assert.equal(none.length, 0, 'and must not flag the min() form, or the fix would not pass');
});
