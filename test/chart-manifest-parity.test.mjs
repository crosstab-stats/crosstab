/**
 * @file chart-manifest-parity.test.mjs
 * What `builtin-charts` BUILDS must equal what it DECLARES.
 *
 * ## The bug that earned this file
 *
 * A chart kind reaches the app in two steps: the plugin's `chartKinds()` factory builds
 * the kind objects, and the plugin's `manifest.charts.kinds` names them. **The host
 * registers from the manifest.** A kind built and not named is therefore invisible to the
 * running app, no matter how correct it is.
 *
 * `tornado` was in exactly that state from `24b8efc` — the commit that introduced it —
 * until 2026-10-10. And it was not a dormant kind nobody could reach: `builtin-decisions`
 * offers **Tornado** in the Mode dropdown of its sensitivity analysis and publishes
 * `tornadoModel(...)` through `appendChart`. The result was a user-facing action that
 * produced a figure nothing could draw — `chartBlockMode` found no registered kind and no
 * saved SVG, so the block read *"No active plugin can draw a 'tornado' chart. Enable one
 * in Edit ▸ Plugins and this figure will appear."* That advice could not be followed: the
 * only tornado renderer in the project is the one in `builtin-charts` itself.
 *
 * ## Why every other test missed it
 *
 * `chart-kinds-harness.mjs` registers whatever `chartKinds()` returns, bypassing the
 * manifest entirely — which is the right call for testing the kind BODIES (Node has no
 * sandbox, and the transport has its own tests). The cost is that the tests exercise a
 * registration path the app never takes. `tornado` was fully covered and completely
 * unavailable, and the suite was green throughout.
 *
 * So this is the more important half of the fix. Adding the missing string took one edit;
 * without this file the next kind can be written, tested and shipped dead in exactly the
 * same way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { KIND_NAMES, MANIFEST_KINDS } from './chart-kinds-harness.mjs';

test('every kind the plugin builds is declared in its manifest', () => {
  const undeclared = KIND_NAMES.filter((k) => !MANIFEST_KINDS.includes(k));
  assert.deepEqual(
    undeclared,
    [],
    'these kinds are built and tested but the host never registers them, so they do not '
      + 'exist in the running app — add them to manifest.charts.kinds',
  );
});

test('every kind the manifest declares is actually built', () => {
  // The other direction is the worse failure of the two: the host registers the name, a
  // plugin emits that kind, and the render call finds nothing behind it. Cheap to assert
  // and there is no reason it should ever be true.
  const unbuilt = MANIFEST_KINDS.filter((k) => !KIND_NAMES.includes(k));
  assert.deepEqual(unbuilt, [], 'declared in manifest.charts.kinds but chartKinds() does not build them');
});

test('tornado in particular, since that is the one that was broken', () => {
  assert.ok(KIND_NAMES.includes('tornado'), 'built');
  assert.ok(MANIFEST_KINDS.includes('tornado'), 'and declared, which is what the host registers from');
});

test('the manifest names each kind once', () => {
  // A duplicate would make the count look right while something else was missing.
  assert.equal(new Set(MANIFEST_KINDS).size, MANIFEST_KINDS.length);
});

test('the count is stated out loud, so a silent drop is visible in the diff', () => {
  // Deliberately a hard number rather than a comparison: removing a kind from both lists
  // at once would satisfy every assertion above without anyone noticing.
  assert.equal(MANIFEST_KINDS.length, 13, 'builtin-charts declares 13 kinds; update this if that is intended');
});
