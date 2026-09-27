/**
 * @file site-plugins.js
 * **A deployment's own plugins**, registered at boot beside the built-ins (#185 slice 2).
 *
 * The case, in the owner's words: a group should be able to `git clone` the whole repo — getting
 * every built-in as it is — and point one setting at *their* directory of plugins, which are
 * then catalogued and activated exactly like ours. No fork of `core/app.js`, no per-user "load
 * plugin from file", and `git pull` stays clean because nothing of theirs lives in our tree.
 *
 * ## Why an index file rather than a list in `deploy.json`
 *
 * Static hosting has no directory listing, so *something* has to name the files. Putting that
 * list **inside their directory** (`<pluginDir>/index.json`) is what makes this genuinely
 * auto-registering: they add a plugin by editing their own index, next to the plugin, and never
 * touch the deployment settings again. A list in `deploy.json` would just be re-declaring our
 * config for every plugin they write.
 *
 * ## What it is allowed to load
 *
 * Only relative paths inside that directory, on this origin. No absolute URLs, no
 * protocol-relative `//host`, no `..`. A settings file must not become a way to aim the plugin
 * loader at somebody else's server — and the loader's sandbox (every plugin, ours included, runs
 * in an opaque-origin iframe and talks over `postMessage`) is unchanged either way: a site
 * plugin is not privileged, it is just *provided*.
 *
 * ## Identity
 *
 * Every entry's id is namespaced by the deployment (`pluginNamespace`, default `site`), so a
 * site plugin can never collide with a built-in, with another deployment's, or with a plugin a
 * user loads from a file. The host prepends it — the author cannot opt out — which is what makes
 * it worth anything. See {@link module:core/loader.qualifyId}.
 *
 * Pure parsing here; the fetch is a thin wrapper, so the format rules are unit-testable without
 * a server.
 */

import { deployConfig, findFieldLine, parseDeployConfig } from './deploy-config.js';

/** The file inside a deployment's plugin directory that lists its plugins. */
export const INDEX_FILE = 'index.json';

/**
 * Parse a deployment's plugin index.
 *
 * Generous in what it accepts, because it is hand-edited: a bare array of paths for the simple
 * case, `{ "plugins": [...] }` when they want room for comments, and each entry either a path
 * string or `{ entry, default }`. Strict in what it returns: `{entries, issues}` where every
 * entry is `{url, defaultOn}` with a vetted same-directory URL.
 *
 * @param {*} value  the parsed index (see {@link loadSitePlugins}, which tolerates comments
 *   and trailing commas exactly as `deploy.json` does)
 * @param {string} dir   the directory it came from, e.g. `site-plugins`
 * @returns {{entries: Array<{url:string, defaultOn:boolean}>, issues: Array<{field:string, why:string}>}}
 */
export function parsePluginIndex(value, dir) {
  const issues = [];
  const base = String(dir ?? '').replace(/\/+$/, '');
  const list = Array.isArray(value) ? value : Array.isArray(value?.plugins) ? value.plugins : null;
  if (!list) {
    issues.push({ field: `${base}/${INDEX_FILE}`, why: 'expected an array of plugins, or { "plugins": [ … ] }' });
    return { entries: [], issues };
  }
  const entries = [];
  const seen = new Set();
  for (const raw of list) {
    const item = typeof raw === 'string' ? { entry: raw } : raw;
    const entry = typeof item?.entry === 'string' ? item.entry.trim() : '';
    if (!entry) {
      issues.push({ field: `${base}/${INDEX_FILE}`, why: `entry ${JSON.stringify(raw)} has no "entry" path` });
      continue;
    }
    if (!isSafeEntryPath(entry)) {
      issues.push({ field: entry, why: 'must be a relative path inside the plugin directory' });
      continue;
    }
    const url = `./${base}/${entry.replace(/^\.\//, '')}`;
    if (seen.has(url)) {
      issues.push({ field: entry, why: 'listed more than once' });
      continue;
    }
    seen.add(url);
    // The per-entry marker, as the owner specified: default-on lives next to the plugin, not in
    // a second file, so one directory can serve several groups and only some of it is on.
    entries.push({ url, defaultOn: item.default === true || item.defaultOn === true });
  }
  return { entries, issues };
}

/**
 * Read the deployment's plugin index, if it declares a directory. Never throws: a missing or
 * broken index leaves the app with its built-ins, because a department's typo must not cost
 * everyone the app.
 *
 * @param {{cfg?: object, fetch?: typeof fetch, parse?: (text:string)=>any}} [opts]
 * @returns {Promise<{dir: string|null, namespace: string, entries: Array<{url:string, defaultOn:boolean}>, issues: Array}>}
 */
export async function loadSitePlugins({ cfg = deployConfig(), fetch: f = globalThis.fetch, parse = parseDeployConfig } = {}) {
  const dir = cfg?.pluginDir || null;
  const namespace = cfg?.pluginNamespace || 'site';
  const empty = { dir, namespace, entries: [], issues: [] };
  if (!dir) return empty;

  const url = `./${dir}/${INDEX_FILE}`;
  let text = null;
  try {
    const res = await f(url, { cache: 'no-store' });
    if (res.ok) text = await res.text();
  } catch {
    /* unreachable — fall through to the missing-index issue */
  }
  if (text == null) {
    // Reported against deploy.json, not the index: `pluginDir` is what pointed at a directory
    // with no index in it, and that is the line the user has to fix.
    return { ...empty, issues: [{ file: 'deploy.json', field: 'pluginDir', why: `no ${url} found (the directory needs an index)` }] };
  }
  let value = null;
  try {
    // Same tolerance as deploy.json: comments and trailing commas. An index that sat beside a
    // commentable settings file and rejected comments itself would be a trap.
    value = parse(text);
  } catch {
    value = null;
  }
  if (value == null) {
    return { ...empty, issues: [{ file: `${dir}/${INDEX_FILE}`, field: INDEX_FILE, why: 'could not be parsed' }] };
  }
  const { entries, issues } = parsePluginIndex(value, dir);
  // Locate each complaint in the index the user actually edits.
  const located = issues.map((i) => ({
    file: `${dir}/${INDEX_FILE}`,
    ...i,
    line: findFieldLine(text, i.field),
  }));
  return { dir, namespace, entries, issues: located };
}

/**
 * A relative path inside the plugin directory. Rejects anything that would leave it: an absolute
 * URL, a protocol-relative host, a root-relative path, or a `..` segment.
 */
function isSafeEntryPath(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.startsWith('/')) return false;
  if (s.split('/').includes('..')) return false;
  return s.endsWith('.js') || s.endsWith('.mjs');
}
