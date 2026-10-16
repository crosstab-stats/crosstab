/**
 * @file baked-plot-inventory.test.mjs
 * The list of charts still handing the host a finished SVG matches reality.
 *
 * TODO.md carries two linked entries about this — the #140 baked-chart review and chart
 * Layer 3b — and both scoped the remaining work by a hand-written list. By 2026-10-15
 * that list said "16 plugins, 23 call sites" and named `plots` boxplot, `meta` forest,
 * `survival` Kaplan-Meier, both word clouds and the Q-Q/residual diagnostics as pending,
 * all of which had been migrated to model kinds months earlier. The real figure was 11
 * sites across 9 plugins, so anyone planning Layer 3b would have scoped it at roughly
 * double, against a list naming plugins with nothing left to do.
 *
 * Nobody noticed because nothing could: a prose inventory has no failure mode. This is
 * that failure mode. It is not a rule about what plugins may do — a plugin is free to
 * bake a figure — it is a check that the written record still describes the code.
 *
 * When a chart migrates, delete its line here AND update both TODO entries. When a new
 * plugin bakes one, add it with a note saying why the geometry is not ours to draw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

/**
 * Every figure still drawn outside the chart layer, and why it is still there.
 *
 * The dividing line, from the #140 review: **ask R for numbers, not pictures.** Baking
 * stays legitimate where the geometry is the hard part and is not ours — force-directed
 * layouts, map projections, biplot arrow fields, ordination configurations.
 */
const BAKED = {
  'builtin-cointegration': 1, // conditional volatility — one series over time
  'builtin-decisions': 1, // decision tree — JS-drawn, deliberately (layout is the figure)
  'builtin-ecology': 1, // NMDS ordination configuration
  'builtin-ordination': 2, // CA biplot (arrow field) + MDS perceptual map
  'builtin-sna': 1, // network — force-directed layout
  'builtin-spatial': 1, // choropleth — map projection
  'builtin-timeseries': 2, // STL decomposition (multi-panel) + ARIMA forecast
  'builtin-var': 1, // impulse-response, multi-panel
};

/** plugin dir -> number of `appendPlot` call sites. */
function actual() {
  const out = {};
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory() || !existsSync(`plugins/${d.name}/index.js`)) continue;
    const n = (readFileSync(`plugins/${d.name}/index.js`, 'utf8').match(/appendPlot\(/g) ?? []).length;
    if (n) out[d.name] = n;
  }
  return out;
}

test('the recorded inventory of baked figures is the real one', () => {
  assert.deepEqual(actual(), BAKED);
});

test('the totals TODO.md quotes still hold', () => {
  const counts = actual();
  const sites = Object.values(counts).reduce((a, b) => a + b, 0);
  const plugins = Object.keys(counts).length;
  assert.equal(sites, 10, `TODO.md says 10 baked sites; found ${sites}`);
  assert.equal(plugins, 8, `TODO.md says 8 plugins; found ${plugins}`);

  const todo = readFileSync('TODO.md', 'utf8');
  assert.match(todo, new RegExp(`\\*\\*${sites} sites across ${plugins}\\n?\\s*plugins\\*\\*`),
    'TODO.md no longer quotes the current figures — update both chart entries together');
});

test('no migrated chart is still listed as pending work', () => {
  // The specific decay that happened: Layer 3b's groups kept naming plugins that had
  // already moved to a model kind. A name in those groups must still bake something.
  const todo = readFileSync('TODO.md', 'utf8');
  const head = todo.indexOf('Layer 3b — host-mediated controls for BAKED plots');
  assert.ok(head > 0, 'the Layer 3b entry moved — this check is blind');
  // Just the three group bullets, not the whole entry: the prose around them names
  // modules and chart KINDS in backticks too (`appendChart`, `sced`, `scatter`), and a
  // slice that swept those in would fail on every one of them.
  const at = todo.indexOf('Opt-in, for everything not in Layer 2', head);
  assert.ok(at > head, 'the group list lost its anchor line');
  // Matched, not indexOf'd: the closing line is re-dated on every re-count ("Coverage
  // checked" became "Coverage re-checked"), and a missed anchor silently widened the
  // slice to the rest of the file rather than failing honestly.
  const end = todo.slice(at).search(/\*Coverage re-?checked/);
  assert.ok(end > 0, 'the group list lost its closing line');
  const groups = todo.slice(at, at + end);
  const baked = new Set(Object.keys(actual()).map((d) => d.replace('builtin-', '')));
  // Plugin names appear as `inline code` inside the group lines; parenthesised asides
  // name the MIGRATED ones, so they are excluded before checking.
  const pending = groups.replace(/\*\([^)]*\)\*/gs, '');
  for (const [, name] of pending.matchAll(/`([a-z]+)`/g)) {
    assert.ok(baked.has(name), `Layer 3b still lists \`${name}\` as pending, but it bakes nothing`);
  }
});
