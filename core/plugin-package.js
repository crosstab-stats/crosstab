/**
 * @file plugin-package.js
 * The `.ctplugin` **plugin package** — a single self-describing ZIP carrying a
 * plugin's entry module plus its bundled assets, so a *multi-file* plugin can be
 * shared as one file and added with "Add from file" (#119). It's the no-lock-in
 * counterpart for plugins of the `.crosstab` project bundle (#96): until now only
 * built-ins could be multi-file (their assets came from the host allowlist); a
 * package lets any third-party codec ship its WASM/worker/glue the same way.
 *
 * Layout (a plain ZIP, STORE method — extracts clean to a folder):
 *   crosstab-plugin.json   descriptor: format, entry filename, name, asset map
 *   index.js               the plugin's entry module (exports its manifest)
 *   assets/<file>          each bundled dependency, one per declared asset
 *
 * The descriptor's `assets` map pairs each **declared asset key** (the exact
 * `path` the plugin's manifest declares, which is also the string the loader looks
 * up in {@link PluginLoader#resolveAsset}) with its ZIP entry — so a packaged
 * plugin's `app.codec.loadAsset(name)` resolves from the bundle with no manifest
 * rewriting: the same declaration drives both URL-sibling and bundle resolution.
 */

import { makeZip, readZip } from './zip.js';

const FORMAT = 'crosstab-plugin';
const FORMAT_VERSION = 1;
const ENTRY = 'index.js';
const dec = new TextDecoder();
const enc = new TextEncoder();

/**
 * Build a `.ctplugin` Blob.
 * @param {object} arg
 * @param {string} arg.name - Display name (for the descriptor; cosmetic).
 * @param {string} arg.indexSource - The entry module source.
 * @param {Array<{key:string, bytes:Uint8Array}>} [arg.assets] - Bundled assets,
 *   each keyed by the declared `path`/`name` its manifest uses.
 * @returns {Blob}
 */
export function packPlugin({ name, indexSource, assets = [] }) {
  const entries = [{ name: ENTRY, data: enc.encode(String(indexSource)) }];
  const used = new Set();
  const map = [];
  for (const a of assets) {
    let file = `assets/${sanitize(a.key)}`;
    while (used.has(file)) file = file.replace(/(\.[^.]*)?$/, (ext) => `_${ext || ''}`);
    used.add(file);
    entries.push({ name: file, data: a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes) });
    map.push({ key: a.key, file });
  }
  const descriptor = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    name: name || 'CrossTab plugin',
    entry: ENTRY,
    exportedAt: new Date().toISOString(),
    generator: 'CrossTab',
    assets: map,
  };
  entries.unshift({ name: 'crosstab-plugin.json', data: enc.encode(JSON.stringify(descriptor, null, 2)) });
  entries.push({ name: 'README.md', data: enc.encode(README) });
  return makeZip(entries);
}

/**
 * Parse a `.ctplugin` package.
 * @param {Uint8Array} buf
 * @returns {{name:string, indexSource:string, assets: Map<string,Uint8Array>}}
 */
export function unpackPlugin(buf) {
  const files = readZip(buf);
  const byName = new Map(files.map((f) => [f.name, f.data]));
  const desc = byName.get('crosstab-plugin.json');
  if (!desc) throw new Error('Not a CrossTab plugin package (no crosstab-plugin.json).');
  let descriptor;
  try {
    descriptor = JSON.parse(dec.decode(desc));
  } catch {
    throw new Error('Plugin package descriptor is corrupt.');
  }
  if (descriptor.format !== FORMAT) throw new Error('Unrecognised plugin package format.');
  const entryName = descriptor.entry || ENTRY;
  const entryBytes = byName.get(entryName);
  if (!entryBytes) throw new Error(`Plugin package is missing its entry module (${entryName}).`);
  const assets = new Map();
  for (const a of descriptor.assets || []) {
    const bytes = a && a.file ? byName.get(a.file) : null;
    if (!bytes) throw new Error(`Plugin package is missing a declared asset (${a?.file}).`);
    // Key by the declared path so PluginLoader#resolveAsset (which keys off the
    // manifest's asset path) finds it — copy out of the zip's shared buffer.
    assets.set(a.key, bytes.slice());
  }
  return { name: descriptor.name || 'CrossTab plugin', indexSource: dec.decode(entryBytes), assets };
}

/** Quick sniff: is this byte buffer a ZIP (so addFromFile treats it as a package)? */
export function looksLikeZip(buf) {
  return buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
}

/** Filesystem-safe leaf name for a declared asset key (`../../a/b.wasm` → `b.wasm`). */
function sanitize(key) {
  const leaf = String(key || 'asset').split(/[\\/]/).pop() || 'asset';
  return leaf.replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '') || 'asset';
}

const README = `# CrossTab plugin package (.ctplugin)

A single-file, self-describing bundle of a CrossTab plugin and the assets it
ships with. It's an ordinary ZIP:

- **crosstab-plugin.json** — what this is: the entry module filename and the map
  of the plugin's declared assets to the files in here.
- **index.js** — the plugin's entry module (it exports the plugin manifest).
- **assets/** — the plugin's bundled dependencies (e.g. a WASM module + its glue
  and worker), one file per asset the manifest declares.

Add it in CrossTab via **Edit ▸ Plugins… ▸ Add from file**. Plugins run sandboxed
and bring their own assets — nothing is fetched from anywhere you didn't choose.
`;
