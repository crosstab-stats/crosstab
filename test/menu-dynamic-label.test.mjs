/**
 * @file menu-dynamic-label.test.mjs
 * A menu item may name what it would act on (#191).
 *
 * `Undo` told you nothing about what was about to change — worst exactly when it matters,
 * after reordering history or when the last thing you did was in a different tier from the
 * thing you are looking at. The coordinator always knew which op it would hit; the menubar
 * simply had no way to say so, because labels were frozen at register time and refreshing
 * one meant rebuilding the whole bar.
 *
 * So a label (and an enabled state) may be a FUNCTION, re-evaluated when the containing
 * menu opens. These test the resolution rules; the wiring is asserted at source level
 * below, and the rendered text was checked in the running app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labelOf, isEnabled } from '../core/menu-shell.js';

/** Swallow the console noise `recordError` emits for a deliberately broken item. */
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

test('a plain string label is unchanged', () => {
  assert.equal(labelOf({ id: 'x', label: 'Frequencies…' }), 'Frequencies…');
});

test('a function label is resolved at read time', () => {
  let target = 'Computed age2';
  const item = { id: 'core:undo', sortLabel: 'Undo', label: () => `Undo: ${target}` };
  assert.equal(labelOf(item), 'Undo: Computed age2');
  // The whole point: the SAME item reads differently once the target changes, with no
  // re-registration and no menubar rebuild.
  target = 'Frequencies';
  assert.equal(labelOf(item), 'Undo: Frequencies');
});

test('a label that THROWS falls back to the sort label, it does not take the menubar down', () => {
  const item = { id: 'core:undo', sortLabel: 'Undo', label: () => { throw new Error('no store'); } };
  assert.equal(quietly(() => labelOf(item)), 'Undo');
});

test('a label returning nothing usable falls back too', () => {
  // An empty string would render as an invisible, unclickable row.
  assert.equal(labelOf({ id: 'core:redo', sortLabel: 'Redo', label: () => '' }), 'Redo');
  assert.equal(labelOf({ id: 'core:redo', sortLabel: 'Redo', label: () => null }), 'Redo');
});

test('with no sortLabel the id is the fallback, never undefined', () => {
  assert.equal(quietly(() => labelOf({ id: 'plug:thing', label: () => { throw new Error('x'); } })), 'plug:thing');
});

test('an item with no `enabled` is enabled', () => {
  assert.equal(isEnabled({ id: 'x', label: 'Go' }), true);
});

test('`enabled` gates the item, and is re-read each time', () => {
  let can = false;
  const item = { id: 'core:undo', label: 'Undo', enabled: () => can };
  assert.equal(isEnabled(item), false);
  can = true;
  assert.equal(isEnabled(item), true);
});

test('a THROWING `enabled` leaves the item usable', () => {
  // The safe direction: a broken availability check must not silently remove a working
  // command from the menu. A disabled item that should work is unreportable by the user
  // ("it's greyed out"); an enabled one that fails at least says why.
  const item = { id: 'x', label: 'Go', enabled: () => { throw new Error('nope'); } };
  assert.equal(quietly(() => isEnabled(item)), true);
});

// --- the wiring ------------------------------------------------------------------
// Source-level, because there is no DOM here (the project runs `node --test` with no
// jsdom). What these protect is that the dynamic path stays WIRED — a later edit that
// quietly restores a static 'Undo' label would otherwise pass everything above.

const app = readFileSync('core/app.js', 'utf8');
const shell = readFileSync('core/menu-shell.js', 'utf8');
const coordinator = readFileSync('core/undo-coordinator.js', 'utf8');

test('Undo and Redo register a computed label, not a fixed one', () => {
  assert.match(app, /label: \(\) => actionLabel\('Undo', undoCoordinator\.undoTarget\(\)\)/);
  assert.match(app, /label: \(\) => actionLabel\('Redo', undoCoordinator\.redoTarget\(\)\)/);
});

test('both are disabled when there is nothing to act on', () => {
  assert.match(app, /enabled: \(\) => !!undoCoordinator\.undoTarget\(\)/);
  assert.match(app, /enabled: \(\) => !!undoCoordinator\.redoTarget\(\)/);
});

test('the coordinator exposes the target it would act on', () => {
  assert.match(coordinator, /undoTarget\(\)\s*\{/);
  assert.match(coordinator, /redoTarget\(\)\s*\{/);
});

test('redoTarget mirrors what redo() actually does, not canRedo', () => {
  // canRedo also returns true for an undone analysis whose op is no longer redoable, so
  // wiring `enabled` to it would leave an enabled item that does nothing when clicked.
  const body = coordinator.slice(coordinator.indexOf('redoTarget()'), coordinator.indexOf('lastActionIsAnalysis'));
  assert.match(body, /topRedoable/);
  assert.doesNotMatch(body, /canRedo/);
});

test('the panel refreshes computed items before it is shown', () => {
  // After `panel.hidden = false` the previous text would be visible for a frame.
  const open = shell.slice(shell.indexOf('#open(wrapper'), shell.indexOf('#focusAt'));
  const refreshAt = open.indexOf('#refreshDynamic');
  const showAt = open.indexOf('panel.hidden = false');
  assert.ok(refreshAt !== -1 && showAt !== -1, 'both steps present');
  assert.ok(refreshAt < showAt, 'refresh must come BEFORE the panel is shown');
});

test('the tree sorts on the static label, so a menu cannot reshuffle as you work', () => {
  assert.match(shell, /makeNode\(staticLabel\(item\), item\.order\)/);
});
