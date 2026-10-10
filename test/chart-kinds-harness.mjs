/**
 * @file chart-kinds-harness.mjs
 * Register the builtin-charts plugin's kinds into core's registry, LOCALLY.
 *
 * Core ships no chart kinds any more — they live in `plugins/builtin-charts`, behind a
 * sandbox, reached over postMessage. Node has no sandbox and no postMessage, and putting
 * one in would test the plumbing rather than the charts.
 *
 * So the tests do the honest thing instead: import the real plugin, hand it the real
 * stdlib, and register the real kind objects it returns as *local* entries. Nothing is
 * stubbed. The kind bodies under test are byte-identical to the ones that run in the
 * app; only the transport is skipped, and the transport has its own tests in
 * chart-remote-kinds.test.mjs.
 *
 * This works because a kind registered locally may present the same two-verb shape a
 * remote one does — `chartSpecOf` prefers `describe()` when a kind has it — so the
 * synchronous helpers (`renderChart`, `defaultView`, `chartUiSpec`) drive the plugin's
 * kinds directly.
 *
 * Import this for its side effect, before anything that touches the registry.
 */
const lib = await import('../core/charts/stdlib.js');
const { chartKinds, manifest } = await import('../plugins/builtin-charts/index.js');
const { registerChartKind } = await import('../core/chart-renderer.js');

export const KINDS = chartKinds(lib);

for (const [name, kd] of Object.entries(KINDS)) {
  registerChartKind(name, kd);
}

/** Every kind name the plugin BUILDS. */
export const KIND_NAMES = Object.keys(KINDS);

/**
 * Every kind name the plugin DECLARES — which is the list the host actually registers
 * from, and the one these tests bypass.
 *
 * Exported because the gap between the two is a real failure mode rather than a
 * theoretical one: `tornado` was built, fully covered by these tests, and unreachable in
 * the running app for months, because this harness registers `chartKinds()` directly and
 * never looks at the manifest. A kind can therefore be written, tested and shipped dead,
 * and every test still passes. `chart-manifest-parity.test.mjs` closes that.
 */
export const MANIFEST_KINDS = manifest.charts.kinds.slice();
