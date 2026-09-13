/**
 * @file output-edit-autosave.test.mjs
 * Restyling a chart marks the project dirty.
 *
 * "Everything is auto-saved" is a promise the app makes, and it is kept by each
 * tier emitting something when it mutates state. Three tiers have now been found
 * NOT emitting — assets (#149 A5), item records (#152), and chart view state —
 * and the shape is identical every time: the change lands in memory, the manifest
 * is written from a snapshot that predates it, and the work is gone on reload
 * unless some unrelated action happens to trigger a save in between.
 *
 * It is a nasty failure because it looks like it worked. The chart redraws, the
 * status bar says "saved", and nothing is wrong until the next session.
 *
 * What is pinned here is the WIRING, not the renderer: that a control change
 * reaches the project's dirty path, and that it does so WITHOUT the event that
 * makes the workspace scroll to the newest result — which would yank the chart
 * being edited off the screen on every nudge of a spinner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RESULTS = readFileSync(new URL('../core/results-pane.js', import.meta.url), 'utf8');
const SYNC = readFileSync(new URL('../core/project-sync.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../core/app.js', import.meta.url), 'utf8');

test('a chart-control change emits an edit, not just a repaint', () => {
  // The control panel is handed a callback; before the fix it was `rerender`,
  // which only redrew. Whatever it is handed now has to emit.
  const handed = RESULTS.match(/buildChartControls\(item,\s*(\w+)\)/);
  assert.ok(handed, 'the controls panel should still be built with a callback');
  const name = handed[1];
  assert.notEqual(name, 'rerender', 'a bare rerender saves nothing — that was the bug');
  // …and that callback emits the edit event.
  const body = RESULTS.slice(RESULTS.indexOf(`const ${name} = `), RESULTS.indexOf(`buildChartControls(item, ${name})`));
  assert.match(body, /output:edited/, `${name} should emit 'output:edited'`);
});

test('the project treats an output edit as dirtying', () => {
  assert.match(SYNC, /on\('output:edited',\s*\(\)\s*=>\s*this\.#onChange\(null\)\)/,
    'project-sync must schedule a save when output is edited in place');
});

test('an edit does NOT scroll the output pane to the bottom', () => {
  // 'output:written' means "a new result arrived" and the workspace answers it by
  // switching to Output and scrolling to the latest. Reusing it for restyling
  // would move the chart under the cursor every time a control changed.
  const scrollers = [...APP.matchAll(/bus\.on\('([^']+)',[^\n]*scrollToLatest/g)].map((m) => m[1]);
  assert.ok(scrollers.includes('output:written'), 'a new result should still scroll the pane');
  assert.ok(!scrollers.includes('output:edited'),
    `an in-place edit must not scroll the pane (scrolls on: ${scrollers.join(', ')})`);
});

test('the chart view is part of what gets saved', () => {
  // The trigger is only half of it: the view has to be in the persisted block or
  // there would be nothing to restore even with the save firing.
  assert.match(RESULTS, /kind:\s*'chart'[\s\S]{0,400}?view/,
    'a chart block should carry its view into the model');
});
