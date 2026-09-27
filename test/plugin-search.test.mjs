/**
 * @file plugin-search.test.mjs
 * #183 — "what do I enable to do X?" — plus #177, which is the same data seen from the
 * other picker.
 *
 * The gap was specific and total, not partial: the plugin manager's search read
 * `[name, id, category, keywords]`, so a user who wanted a **Hosmer–Lemeshow** test or a
 * **Kaplan–Meier** curve searched the one dialog that could have told them and got "No
 * plugins match your search" — while the plugin providing it sat right there, switched off.
 * The index already existed (`#recordCatalog` stores every catalogued plugin's action
 * labels so disabled plugins can still show detail); the search never read it.
 *
 * These test the two pure functions both pickers now share, against **catalogue-shaped**
 * objects — the same `{name, id, category, keywords, menu, howto}` that `list()` returns,
 * with the real labels copied from the manifests, en dashes and all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchPlugin, addsTooltip } from '../core/plugin-manager.js';

/** Real catalogue rows: names and labels as the manifests actually spell them. */
const SURVIVAL = {
  key: './plugins/builtin-survival/index.js',
  id: 'builtin-survival',
  name: 'Survival Analysis',
  category: 'Analyze',
  keywords: ['survival', 'hazard', 'censoring'],
  menu: ['Kaplan–Meier & log-rank', 'Cox proportional hazards'],
  howto: 'GUI: Analyze ▸ Survival ▸ Kaplan–Meier…, then pick the time and event columns.',
};
const LOGISTIC = {
  key: './plugins/builtin-logistic/index.js',
  id: 'builtin-logistic',
  name: 'Binary Logistic Regression',
  category: 'Analyze',
  keywords: ['logit', 'odds ratio'],
  menu: ['Binary logistic regression'],
  howto: 'Options include the Hosmer–Lemeshow goodness-of-fit test and a classification table.',
};
const ASSUMPTIONS = {
  key: './plugins/builtin-assumptions/index.js',
  id: 'builtin-assumptions',
  name: 'Assumption Checks',
  category: 'Analyze',
  keywords: [],
  menu: ['Normality (Shapiro–Wilk)', 'Equal variances (Levene / Brown–Forsythe)'],
};
const NO_MENU = { key: 'k', id: 'builtin-charts', name: 'Charts', category: 'Infrastructure', keywords: [], menu: [] };

const ALL = [SURVIVAL, LOGISTIC, ASSUMPTIONS, NO_MENU];

/** The plugins a query turns up, the way the dialog filters them. */
function found(q) {
  return ALL.filter((p) => matchPlugin(p, q).hit).map((p) => p.id);
}

// =============================================================================
// The question the feature exists to answer
// =============================================================================

test('an analysis name finds the plugin that adds it, and names the analysis', () => {
  const m = matchPlugin(SURVIVAL, 'kaplan');
  assert.equal(m.hit, true);
  assert.deepEqual(m.items, ['Kaplan–Meier & log-rank']);
  assert.deepEqual(found('kaplan'), ['builtin-survival']);
});

test('a typed hyphen matches the en dash the labels actually use', () => {
  // The motivating near-miss: every label in the manifests uses an EN DASH, so "kaplan-meier"
  // typed on a keyboard missed entirely under a plain substring search.
  for (const q of ['kaplan-meier', 'Kaplan–Meier', 'KAPLAN—MEIER']) {
    assert.deepEqual(found(q), ['builtin-survival'], `failed for ${q}`);
  }
  assert.deepEqual(found('shapiro-wilk'), ['builtin-assumptions']);
  assert.deepEqual(found('brown-forsythe'), ['builtin-assumptions']);
});

test('a test named only in the howto is findable too', () => {
  // Hosmer–Lemeshow is an OPTION inside the logistic dialog, not a menu label — the only
  // place it is written down is the plugin's howto text.
  assert.deepEqual(found('hosmer-lemeshow'), ['builtin-logistic']);
  assert.deepEqual(found('levene'), ['builtin-assumptions']);
});

test('terms are ANDed and order does not matter', () => {
  assert.equal(matchPlugin(SURVIVAL, 'cox hazards').hit, true);
  assert.equal(matchPlugin(SURVIVAL, 'hazards cox').hit, true);
  assert.deepEqual(matchPlugin(SURVIVAL, 'hazards cox').items, ['Cox proportional hazards']);
  // Both terms must appear SOMEWHERE — one of them being absent is not a match.
  assert.equal(matchPlugin(SURVIVAL, 'cox anova').hit, false);
});

test('a term may be spread across fields', () => {
  // "survival" is the plugin name, "cox" is a label: together they should still find it.
  const m = matchPlugin(SURVIVAL, 'survival cox');
  assert.equal(m.hit, true);
  assert.deepEqual(m.items, ['Cox proportional hazards']);
});

// =============================================================================
// What the row is allowed to claim
// =============================================================================

test('matching the plugin’s own name names no analysis in particular', () => {
  // Listing all of a plugin's analyses because its NAME matched would bury whatever was
  // actually asked for. Nothing specific matched, so the row stays quiet.
  const m = matchPlugin(SURVIVAL, 'survival analysis');
  assert.equal(m.hit, true);
  assert.deepEqual(m.items, []);
});

test('only the labels a term touched are reported', () => {
  const m = matchPlugin(ASSUMPTIONS, 'levene');
  assert.deepEqual(m.items, ['Equal variances (Levene / Brown–Forsythe)']);
  assert.equal(m.items.length, 1, 'the normality label must not be dragged along');
});

test('an empty query matches everything and claims nothing', () => {
  for (const q of ['', '   ', null, undefined]) {
    const m = matchPlugin(SURVIVAL, q);
    assert.equal(m.hit, true, `failed for ${JSON.stringify(q)}`);
    assert.deepEqual(m.items, []);
  }
  assert.equal(found('').length, ALL.length);
});

test('the old four fields still match — this widened the search, it did not narrow it', () => {
  assert.equal(matchPlugin(SURVIVAL, 'Survival Analysis').hit, true); // name
  assert.equal(matchPlugin(SURVIVAL, 'builtin-survival').hit, true); // id
  assert.equal(matchPlugin(SURVIVAL, 'analyze').hit, true); // category
  assert.equal(matchPlugin(SURVIVAL, 'censoring').hit, true); // keyword
  assert.equal(matchPlugin(SURVIVAL, 'structural equation').hit, false); // and still says no
});

test('a plugin with no actions is handled, not crashed on', () => {
  assert.equal(matchPlugin(NO_MENU, 'charts').hit, true);
  assert.deepEqual(matchPlugin(NO_MENU, 'charts').items, []);
  assert.equal(matchPlugin({}, 'anything').hit, false);
  assert.equal(matchPlugin(undefined, '').hit, true);
});

// =============================================================================
// #177 — the tooltip both pickers now share
// =============================================================================

test('addsTooltip is the launcher’s hover text, now available to both pickers', () => {
  assert.equal(
    addsTooltip(SURVIVAL),
    'Survival Analysis adds:\n• Kaplan–Meier & log-rank\n• Cox proportional hazards',
  );
});

test('a plugin that declares no actions gets no tooltip rather than an empty list', () => {
  assert.equal(addsTooltip(NO_MENU), '');
  assert.equal(addsTooltip({ name: 'X' }), '');
  assert.equal(addsTooltip(undefined), '');
});

// =============================================================================
// The touch path (owner, phone, 2026-09-26: "hover doesn't work on the phone")
// =============================================================================

/**
 * Every row now carries a details button, so the answer #177 promised is reachable without a
 * pointer. The invariant worth asserting is that the button never opens an empty box: for each
 * real plugin there must be something to show — action labels, a usage note, or the explicit
 * "this is infrastructure" line the dialog falls back to.
 *
 * Read from the REAL manifests, and the `menu` list is built exactly the way `#recordCatalog`
 * builds it, so this tracks what the catalogue will actually hold rather than a fixture.
 */
test('every real plugin has something to show behind the details button', async () => {
  const { readdirSync } = await import('node:fs');
  const dirs = readdirSync('plugins');
  const rows = [];
  for (const d of dirs) {
    const mod = await import(`../plugins/${d}/index.js`);
    const m = mod.manifest || mod.default?.manifest;
    assert.ok(m, `${d} exports no manifest`);
    const menu = ['menu', 'imports', 'exports', 'outputExports', 'codecs']
      .flatMap((k) => (Array.isArray(m[k]) ? m[k] : []))
      .map((x) => String(x?.label ?? '').replace(/\s*[.…]+\s*$/, ''))
      .filter(Boolean);
    rows.push({ id: m.id, name: m.name, menu, howto: m.howto || '' });
  }
  assert.ok(rows.length >= 60, `expected the full plugin set, read ${rows.length}`);
  const empty = rows.filter((r) => !r.menu.length && !r.howto).map((r) => r.id);
  // Not a failure if one is genuinely infrastructure — but it must be a KNOWN one, so a new
  // plugin shipping with neither a menu nor a note shows up here rather than as an empty panel.
  assert.deepEqual(empty, [], `plugins with nothing to show: ${empty.join(', ')}`);
});

test('the search index and the details panel read the same field', () => {
  // Both are `menu`. If these ever diverge, a plugin could be findable by an analysis the
  // panel does not list, or vice versa.
  const m = matchPlugin(SURVIVAL, 'cox');
  assert.ok(m.items.every((label) => SURVIVAL.menu.includes(label)));
  assert.ok(addsTooltip(SURVIVAL).includes(m.items[0]));
});
