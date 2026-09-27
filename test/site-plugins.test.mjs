/**
 * @file site-plugins.test.mjs
 * #185 slice 2 — a deployment's own plugin directory.
 *
 * The feature: a group clones the whole repo, keeps its own plugins in its own folder, lists
 * them in an index file inside that folder, and CrossTab registers them at boot exactly like
 * the built-ins. Two properties have to hold, and the second is the one worth tests:
 *
 *  1. **The index is read the way a human writes it** — a bare list for the simple case, or
 *     objects when they want the default-on marker, with a useful complaint for anything else.
 *  2. **It cannot be used to load someone else's code.** The whole mechanism is "the deployment
 *     names files it serves", so an entry that escapes that directory — an absolute URL, a
 *     protocol-relative host, a `..` — is refused rather than fetched. A settings file must not
 *     become a way to aim the plugin loader at another origin.
 *
 * Identity is the third leg: a site plugin's id is namespaced by the HOST from `deploy.json`,
 * never by the plugin's own manifest, which is what stops one forging `builtin-…`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INDEX_FILE, loadSitePlugins, parsePluginIndex } from '../core/site-plugins.js';
import { originMeta } from '../core/plugin-manager.js';
import { qualifyId } from '../core/loader.js';
import { validateDeployConfig } from '../core/deploy-config.js';

const urls = (r) => r.entries.map((e) => e.url);

// =============================================================================
// The index, as a person writes it
// =============================================================================

test('a bare list of paths is the simple case', () => {
  const r = parsePluginIndex(['attendance/index.js', 'grades/index.js'], 'site-plugins');
  assert.deepEqual(urls(r), ['./site-plugins/attendance/index.js', './site-plugins/grades/index.js']);
  assert.deepEqual(r.issues, []);
  assert.ok(r.entries.every((e) => e.defaultOn === false), 'nothing is on by default unless asked');
});

test('objects carry the default-on marker, next to the plugin', () => {
  // The owner's call: the marker belongs in the index beside the plugin, not in deploy.json,
  // because one directory may serve several groups with only part of it switched on.
  const r = parsePluginIndex(
    { plugins: [{ entry: 'attendance/index.js', default: true }, { entry: 'grades/index.js' }] },
    'site-plugins',
  );
  assert.deepEqual(r.entries.map((e) => [e.url.split('/')[2], e.defaultOn]), [
    ['attendance', true],
    ['grades', false],
  ]);
});

test('mixed forms, a trailing slash on the directory, and ./ on an entry all work', () => {
  const r = parsePluginIndex(['./a.js', { entry: 'b/index.mjs', defaultOn: true }], 'dept/plugins/');
  assert.deepEqual(urls(r), ['./dept/plugins/a.js', './dept/plugins/b/index.mjs']);
  assert.equal(r.entries[1].defaultOn, true);
});

test('a malformed index says what it wanted instead of failing silently', () => {
  for (const bad of [null, 42, 'a string', { entries: [] }]) {
    const r = parsePluginIndex(bad, 'p');
    assert.deepEqual(r.entries, []);
    assert.match(r.issues[0].why, /expected an array/);
  }
  const partial = parsePluginIndex(['ok.js', { nope: 1 }, ''], 'p');
  assert.deepEqual(urls(partial), ['./p/ok.js']); // the good one still loads
  assert.equal(partial.issues.length, 2);
});

test('a duplicate entry is reported, not loaded twice', () => {
  const r = parsePluginIndex(['a.js', 'a.js', './a.js'], 'p');
  assert.deepEqual(urls(r), ['./p/a.js']);
  assert.equal(r.issues.filter((i) => /more than once/.test(i.why)).length, 2);
});

// =============================================================================
// What it refuses to load
// =============================================================================

test('an entry that leaves the deployment’s own directory is refused', () => {
  const hostile = [
    'https://evil.example/p.js', // another origin outright
    '//evil.example/p.js', // protocol-relative: the sneaky one
    '/etc/passwd.js', // root-relative
    '../../core/app.js', // climbing out
    'ok/../../../x.js', // climbing out mid-path
  ];
  const r = parsePluginIndex(hostile, 'site-plugins');
  assert.deepEqual(r.entries, [], 'none of these may become a plugin URL');
  assert.equal(r.issues.length, hostile.length);
  for (const i of r.issues) assert.match(i.why, /relative path inside/);
});

test('only JavaScript modules are entries', () => {
  const r = parsePluginIndex(['plugin.js', 'mod.mjs', 'readme.md', 'index.json'], 'p');
  assert.deepEqual(urls(r), ['./p/plugin.js', './p/mod.mjs']);
  assert.equal(r.issues.length, 2);
});

// =============================================================================
// Identity — the host prepends the namespace, so it cannot be forged
// =============================================================================

test('a site plugin is namespaced by the deployment, not by its own manifest', () => {
  const origin = { kind: 'site', namespace: 'sdsu' };
  assert.equal(qualifyId(origin, { id: 'attendance' }), 'sdsu-attendance');
  // Already prefixed: left alone rather than doubled.
  assert.equal(qualifyId(origin, { id: 'sdsu-grades' }), 'sdsu-grades');
  // A forgery attempt is prefixed anyway, so it reads as exactly what it is.
  assert.equal(qualifyId(origin, { id: 'builtin-frequencies' }), 'sdsu-builtin-frequencies');
  // And the real built-in keeps its id, so a site plugin can never take its place.
  assert.equal(qualifyId({ kind: 'builtin' }, { id: 'builtin-frequencies' }), 'builtin-frequencies');
});

test('the namespace a deployment may claim is checked before it ever reaches an id', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(validateDeployConfig({ pluginNamespace: 'builtin' }).pluginNamespace, 'site');
  } finally {
    console.warn = warn;
  }
  assert.equal(qualifyId({ kind: 'site', namespace: 'site' }, { id: 'x' }), 'site-x');
});

// =============================================================================
// Loading — a department's typo must not cost everyone the app
// =============================================================================

test('no plugin directory means no fetch and no entries', async () => {
  let fetched = false;
  const r = await loadSitePlugins({ cfg: { pluginDir: null }, fetch: async () => { fetched = true; } });
  assert.deepEqual(r.entries, []);
  assert.equal(fetched, false, 'the stock build must not even look');
});

test('a missing or broken index leaves the built-ins alone and says why', async () => {
  const missing = await loadSitePlugins({
    cfg: { pluginDir: 'site-plugins', pluginNamespace: 'x' },
    fetch: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(missing.entries, []);
  assert.match(missing.issues[0].why, new RegExp(INDEX_FILE));

  const broken = await loadSitePlugins({
    cfg: { pluginDir: 'site-plugins' },
    fetch: async () => ({ ok: true, text: async () => '{ oh no' }),
  });
  assert.deepEqual(broken.entries, []);
  assert.match(broken.issues[0].why, /could not be parsed/);

  const thrown = await loadSitePlugins({
    cfg: { pluginDir: 'site-plugins' },
    fetch: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(thrown.entries, []);
  assert.equal(thrown.issues.length, 1);
});

test('a good index loads, carrying the namespace for the loader', async () => {
  const index = JSON.stringify({ plugins: [{ entry: 'attendance/index.js', default: true }] });
  const r = await loadSitePlugins({
    cfg: { pluginDir: 'site-plugins', pluginNamespace: 'sdsu' },
    fetch: async (url) => {
      assert.equal(url, './site-plugins/index.json');
      return { ok: true, text: async () => index };
    },
  });
  assert.deepEqual(r.entries, [{ url: './site-plugins/attendance/index.js', defaultOn: true }]);
  assert.equal(r.namespace, 'sdsu');
  assert.deepEqual(r.issues, []);
});

test('the index tolerates comments and trailing commas, like deploy.json', async () => {
  // It sits next to a commentable settings file, so an index that rejected comments would be a
  // trap. Tolerant BY DEFAULT, not by caller opt-in: this test first passed the parser in by
  // hand while app.js did not, so a commented index would have worked here and failed in the
  // app — the gap the test itself exposed.
  const text = '{\n  // our plugins\n  "plugins": [ "a.js", ]\n}';
  const r = await loadSitePlugins({
    cfg: { pluginDir: 'p' },
    fetch: async () => ({ ok: true, text: async () => text }),
  });
  assert.deepEqual(urls(r), ['./p/a.js']);
});

// =============================================================================
// Provenance (found by the owner, 2026-09-27, on the example site plugin)
// =============================================================================

/**
 * A site plugin showed as **"built-in"** in Edit ▸ Plugins. The cause is worth keeping: a site
 * entry deliberately sets `builtin: true` so the picker will not let a user delete a plugin the
 * deployment provides — and TWO places independently answer "where did this come from". I had
 * taught `#originLabel` (output attribution) about site plugins and not `list().origin` (the
 * picker row and the missing-plugin dialog), so the row fell through to the built-in branch.
 *
 * It took a real example plugin to show it; no unit test I had written could have, because both
 * paths were "correct" in isolation. So the token is checked here, and the renderer is a pure
 * exported function rather than an expression buried in a row builder.
 */
test('a deployment’s own plugin does not read as one of ours', () => {
  assert.equal(originMeta({ origin: 'site' }, 'Example University Lab'), 'from Example University Lab');
  // A deployment that never named itself still must not claim to be us.
  assert.equal(originMeta({ origin: 'site' }, null), 'from this site');
  assert.notEqual(originMeta({ origin: 'site' }, null), 'built-in');
});

test('every other provenance token is passed through untouched', () => {
  for (const origin of ['built-in', 'url', 'file', 'authored', 'package']) {
    assert.equal(originMeta({ origin }, 'Example Lab'), origin);
  }
  assert.equal(originMeta({}, null), '');
  assert.equal(originMeta(undefined, null), '');
});
