/**
 * @file screen-mode.test.mjs
 * Small-screen mode: who gets to decide (owner, 2026-10-07).
 *
 * The policy is the feature. *"I don't want it to be forced. I hate it when sites detect a
 * small screen and then force you into their shite 'mobile friendly' design when the real
 * site would work fine"* — resolved as **detect as a default, never as an override**, which
 * is what keeps WCAG 1.4.10 Reflow satisfiable (that criterion is about the DEFAULT
 * presentation) without ever overriding somebody who has chosen.
 *
 * Every rule in `screen-mode.js`'s header is a case below. The one that matters most is
 * stored-`full` on a narrow screen: that is the exact objection, and it must not budge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScreenMode, onScreenModeChange, resolveScreenMode, SMALL_MAX_PX,
} from '../core/screen-mode.js';

// --- unset: the viewport supplies a default ----------------------------------

test('nobody has chosen and the screen is narrow → small', () => {
  // This is the case 1.4.10 needs: a first-time visitor at 320px gets a reflowed layout
  // without having to find a setting.
  assert.equal(resolveScreenMode({ stored: null, narrowViewport: true }), 'small');
});

test('nobody has chosen and the screen is wide → full', () => {
  assert.equal(resolveScreenMode({ stored: null, narrowViewport: false }), 'full');
});

test('an absent preference is treated as unset, however it is absent', () => {
  // localStorage disabled, a cleared profile, a junk value someone poked in by hand — all of
  // them mean "nobody has said", which is the viewport's cue, not a reason to crash.
  for (const stored of [null, undefined, '', 'yes', 'SMALL', 0, false]) {
    assert.equal(resolveScreenMode({ stored, narrowViewport: true }), 'small');
    assert.equal(resolveScreenMode({ stored, narrowViewport: false }), 'full');
  }
});

// --- chosen: the user wins ---------------------------------------------------

test('THE CASE THIS FEATURE EXISTS FOR: chosen `full` on a narrow screen stays full', () => {
  // Someone has seen the small layout, decided the real one works fine, and turned it off.
  // A viewport check that overrode that would be precisely the behaviour being objected to.
  assert.equal(resolveScreenMode({ stored: 'full', narrowViewport: true }), 'full');
});

test('chosen `small` on a wide screen stays small', () => {
  // The mirror case, and the reason it is not called "phone mode": a narrow WINDOW on a big
  // display, a split screen, a projector. The choice is about the layout, not the device.
  assert.equal(resolveScreenMode({ stored: 'small', narrowViewport: false }), 'small');
});

test('a choice survives being the same as the default', () => {
  assert.equal(resolveScreenMode({ stored: 'small', narrowViewport: true }), 'small');
  assert.equal(resolveScreenMode({ stored: 'full', narrowViewport: false }), 'full');
});

// --- the URL flag: an escape hatch, not a preference -------------------------

test('?screen= overrides both the stored choice and the viewport', () => {
  assert.equal(resolveScreenMode({ stored: 'full', narrowViewport: false, urlFlag: 'small' }), 'small');
  assert.equal(resolveScreenMode({ stored: 'small', narrowViewport: true, urlFlag: 'full' }), 'full');
});

test('a nonsense ?screen= value is ignored rather than obeyed', () => {
  for (const urlFlag of ['', 'tiny', 'true', '1', 'SMALL']) {
    assert.equal(resolveScreenMode({ stored: 'full', narrowViewport: true, urlFlag }), 'full',
      'the stored choice still decides');
  }
});

test('called with nothing at all, the answer is the full layout', () => {
  // The defensive default matters: a resolver that threw or returned undefined here would
  // leave the root element with no mode and every selector ambiguous.
  assert.equal(resolveScreenMode(), 'full');
  assert.equal(resolveScreenMode({}), 'full');
});

// --- the threshold -----------------------------------------------------------

test('the threshold is well above the WCAG floor, and says why in one number', () => {
  // 400px of launcher rails plus a 240px sidebar stop working long before 320px, so the
  // trigger is where the FULL layout fails, not where the criterion is measured.
  assert.equal(SMALL_MAX_PX, 720);
  assert.ok(SMALL_MAX_PX > 320);
});

// --- applying a mode tells the surfaces --------------------------------------
//
// This section exists because of a bug that lived for about ten minutes: the note's
// "use the full layout" button set the attribute and notified nobody, so the layout said
// `full` while the sidebar sat inside the Project tab and the menubar stayed collapsed.
// It was only possible because notifying was a separate step a caller had to remember, so
// the fix was to make it part of applying — and these pin that.

/** A document stand-in: the attribute is all `applyScreenMode` touches. */
const fakeDoc = (initial = 'full') => ({ documentElement: { dataset: { screen: initial } } });

test('applying a different mode notifies every listener', () => {
  const doc = fakeDoc('full');
  const seen = [];
  const off = onScreenModeChange((m) => seen.push(m));
  applyScreenMode('small', { doc });
  off();
  assert.deepEqual(seen, ['small']);
  assert.equal(doc.documentElement.dataset.screen, 'small');
});

test('applying the SAME mode notifies nobody — a no-op must not re-render the app', () => {
  const doc = fakeDoc('small');
  const seen = [];
  const off = onScreenModeChange(() => seen.push('x'));
  applyScreenMode('small', { doc });
  off();
  assert.deepEqual(seen, []);
});

test('boot applies without notifying, because nothing has subscribed yet', () => {
  const doc = fakeDoc('full');
  const seen = [];
  const off = onScreenModeChange(() => seen.push('x'));
  applyScreenMode('small', { doc, notify: false });
  off();
  assert.deepEqual(seen, []);
  assert.equal(doc.documentElement.dataset.screen, 'small', 'but the mode is still applied');
});

test('one broken listener does not stop the others', () => {
  // The listeners are the app re-arranging itself; a throw in the first must not leave the
  // menubar expanded in a small layout.
  const doc = fakeDoc('full');
  const seen = [];
  const realError = console.error;
  console.error = () => {};
  const offA = onScreenModeChange(() => { throw new Error('boom'); });
  const offB = onScreenModeChange((m) => seen.push(m));
  try {
    assert.doesNotThrow(() => applyScreenMode('small', { doc }));
  } finally {
    console.error = realError;
    offA(); offB();
  }
  assert.deepEqual(seen, ['small']);
});

test('a non-function subscription is ignored rather than breaking the next apply', () => {
  const off = onScreenModeChange(null);
  assert.equal(typeof off, 'function');
  const doc = fakeDoc('full');
  assert.doesNotThrow(() => applyScreenMode('small', { doc }));
});

test('an unknown mode value lands on full rather than writing nonsense to the root', () => {
  const doc = fakeDoc('small');
  assert.equal(applyScreenMode('tiny', { doc }), 'full');
  assert.equal(doc.documentElement.dataset.screen, 'full');
});
