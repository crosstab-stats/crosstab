/**
 * @file scripts/test-globals.mjs
 * What the sandbox provides, provided to the test runner instead.
 *
 * Preloaded by `npm test` via `node --test --import`.
 *
 * A plugin reads the host's reporting formatters from `globalThis.ctStd` at MODULE scope
 * (see the binding line at the top of any compute plugin, and the rationale in
 * `core/plugin-stdlib.js`). In the app, `plugin-host.html` assigns that global inside the
 * frame before importing the plugin's module. The test suite imports those same modules
 * directly, with no frame — so something has to stand in, and this is it.
 *
 * It is the REAL stdlib, not a stub: a test that exercised a plugin against fake
 * formatters would be testing the fake. Frozen and spread the same way the frame does it,
 * so the surface a test sees matches the surface a plugin gets in production.
 *
 * Why here and not in `test/`: `node --test` treats every file under `test/` as a test
 * file, and this one holds no tests.
 */
import * as std from '../core/plugin-stdlib.js';

globalThis.ctStd = Object.freeze({ ...std });
