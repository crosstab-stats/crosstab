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
const { chartKinds } = await import('../plugins/builtin-charts/index.js');
const { registerChartKind } = await import('../core/chart-renderer.js');

export const KINDS = chartKinds(lib);

for (const [name, kd] of Object.entries(KINDS)) {
  registerChartKind(name, kd);
}

/** Every kind name the plugin supplies. */
export const KIND_NAMES = Object.keys(KINDS);
