/**
 * @file project-bundle.js
 * The open `.crosstab` project bundle — a single self-describing ZIP capturing an
 * entire project in OPEN formats, so the work is portable, reproducible, and never
 * locked into CrossTab (or anyone). Counterpart to full proprietary-format support
 * (#95) — equal, not privileged (see the format-equality principle).
 *
 * Layout (extracts clean to a folder):
 *   manifest.json              project name, dates, version, dataset index
 *   data/<ds>.parquet          the working data (open columnar, types preserved)
 *   data/<ds>.schema.json      variable defs: labels, value labels, measurement,
 *                              missing-value descriptors
 *   analysis/<ds>.transforms.json   the transform log (what was done), replayable
 *   README.md                  what it is + how to open each part without CrossTab
 *
 * v1: export (this file) is read-only — it can't corrupt a project. Import + the
 * reproducible analysis.R / output report.html are follow-ups.
 */

import { makeZip, readZip } from './zip.js';

const FORMAT = 'crosstab-project';
const FORMAT_VERSION = 1;
const dec = new TextDecoder();

/**
 * Build a `.crosstab` bundle Blob from the open datasets.
 * @param {object} deps
 * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
 * @param {string} [deps.projectName]
 * @param {Array<{id:string,name:string,builtin?:boolean,origin?:string,url?:string}>} [deps.plugins]
 *   The active analysis/plugin set, recorded so a recipient can restore the same
 *   analyses (and be warned about any they don't have — #102).
 * @returns {Promise<Blob>}
 */
export async function exportProjectBundle({ datasets, projectName, plugins = [], collab = null }) {
  const entries = [];
  const index = [];
  const used = new Set();
  for (const ds of datasets.all()) {
    let base = slug(ds.name) || `dataset_${ds.id}`;
    while (used.has(base)) base = `${base}_`; // de-dup filename collisions
    used.add(base);

    const meta = ds.getVariableMeta();
    const parquet = await ds.getInjectionParquet();
    const dataFile = parquet && parquet.byteLength ? `data/${base}.parquet` : null;
    if (dataFile) entries.push({ name: dataFile, data: parquet });
    entries.push({ name: `data/${base}.schema.json`, data: pretty(meta) });
    entries.push({ name: `analysis/${base}.transforms.json`, data: pretty(ds.getTransforms()) });

    index.push({
      id: ds.id,
      name: ds.name,
      file: dataFile,
      schema: `data/${base}.schema.json`,
      transforms: `analysis/${base}.transforms.json`,
      rows: ds.rowCount,
      variables: meta.length,
    });
  }

  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    name: projectName || 'Untitled project',
    exportedAt: new Date().toISOString(),
    generator: 'CrossTab',
    datasets: index,
    // The active analysis/plugin set, so opening the bundle restores the same
    // analyses — and warns about any the recipient doesn't have (#102). Built-ins
    // are always present on open; non-built-ins (a URL/file/authored plugin) may
    // not be, hence the recorded origin/url.
    plugins: (plugins || []).map((p) => ({
      id: p.id,
      name: p.name,
      builtin: !!p.builtin,
      origin: p.origin,
      ...(p.url ? { url: p.url } : {}),
    })),
    // The dataset-collection op-log (unit 6) travels with the bundle so every window
    // that opens it shares ONE collection identity. Without it, an importer would
    // RECONSTRUCT different op-ids than the exporter kept, and the merge would then see
    // the same dataset's add/remove as rival independent ops (a spurious conflict).
    collectionLog: datasets.collectionOps ? datasets.collectionOps() : null,
    // Collab identity (#148) — travels with the bundle so a copy imported to OPFS on
    // another machine (flash-drive hand-off) meets the origin in the SAME room.
    // Collaboration is transport-agnostic: whoever holds the bundle is a collaborator
    // (same trust model as holding the shared folder); encrypt the export to protect it.
    ...(collab?.collabId ? { collabId: collab.collabId, collabSecret: collab.collabSecret } : {}),
  };
  entries.unshift({ name: 'manifest.json', data: pretty(manifest) });
  entries.push({ name: 'README.md', data: README });
  return makeZip(entries);
}

/**
 * Read a `.crosstab` bundle into a bundle ready for {@link DatasetManager#loadBundle} —
 * the flat one-true-log shape (#148). A `.crosstab` is a portable SNAPSHOT (the derived
 * Parquet + schema, tool-agnostic), not the internal op-log, so import synthesises a
 * fresh log: one `addDataset` + one `load` (carrying the derived Parquet + schema meta)
 * per dataset. The transform log travels in the file as a record but is NOT replayed (the
 * data is already derived). Synthetic op ids are DETERMINISTIC (keyed by dataset id) so
 * two people importing the same bundle produce the identical log — mergeable.
 * @param {Uint8Array} buf
 * @returns {{name: string, bundle: {activeId: any, log: object[]}, plugins: object[]}}
 */
export function importProjectBundle(buf) {
  const files = readZip(buf);
  const byName = new Map(files.map((f) => [f.name, f.data]));
  const mf = byName.get('manifest.json');
  if (!mf) throw new Error('Not a CrossTab bundle (no manifest.json).');
  const manifest = JSON.parse(dec.decode(mf));
  if (manifest.format !== FORMAT) throw new Error('Unrecognised bundle format.');

  const op = (id, counter, target, type, payload) => ({ id, hlc: { wall: 0, counter }, target, owner: 'core', type, payload, reads: [] });
  // Collection tier: prefer the exporter's real ops (shared collection identity); else
  // synthesise deterministic addDataset ops so every importer converges on the same log.
  const haveColl = Array.isArray(manifest.collectionLog) && manifest.collectionLog.length;
  const log = haveColl ? [...manifest.collectionLog] : [];
  let activeId = null;
  let i = 0;
  for (const d of manifest.datasets || []) {
    if (activeId === null) activeId = d.id;
    if (!haveColl) log.push(op(`bundle-add-${d.id}`, i, `coll/ds:${d.id}`, 'addDataset', { id: d.id, name: d.name }));
    const schemaRaw = d.schema ? byName.get(d.schema) : null;
    const meta = schemaRaw ? JSON.parse(dec.decode(schemaRaw)) : [];
    const parquet = d.file ? byName.get(d.file) : null;
    if (parquet && parquet.byteLength) {
      // One base `load` op carrying the derived data + schema (the shape rawRestore
      // materialises). File ref left off → rawExport keys a fresh sidecar on the op id.
      log.push(op(`bundle-load-${d.id}`, i, `ds:${d.id}/source:bundle-${d.id}`, 'load', { src: { meta, label: d.name, parquet } }));
    }
    i++;
  }
  if (activeId === null) throw new Error('Bundle has no datasets.');
  // The recorded plugin set (#102): `activePlugins` (ids) restores analyses on open;
  // `plugins` (full descriptors) lets the caller warn about any not installed here.
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return {
    name: manifest.name || 'Imported project',
    bundle: {
      activeId,
      log,
      activePlugins: plugins.map((p) => p.id).filter(Boolean),
      // Preserve the collab identity so the imported copy shares a room with the origin (#148).
      collabId: manifest.collabId ?? null,
      collabSecret: manifest.collabSecret ?? null,
    },
    plugins,
  };
}

/** Open a native picker for a `.crosstab` bundle; resolves the File or null. */
export function pickBundleFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.crosstab,.zip';
    input.style.display = 'none';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** A filesystem-safe slug for a dataset/project name. */
export function slug(s) {
  return String(s ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

const README = `# CrossTab project bundle

This is an open, self-describing export of a CrossTab project. Everything here is
in a standard format you can open without CrossTab.

- **data/*.parquet** — your data, one file per dataset (Apache Parquet; open it in
  Python (pandas/pyarrow/duckdb), R (arrow/duckdb), Julia, Excel via Power Query, …).
- **data/*.schema.json** — variable definitions: labels, value labels (code →
  category), measurement level, and missing-value descriptors.
- **analysis/*.transforms.json** — the transform steps applied (recode, compute,
  filter, …), in order.
- **manifest.json** — project name, export date, the dataset index, and the list
  of analyses/plugins that were active (so re-opening in CrossTab restores them, and
  warns about any you don't have installed).

Re-open the whole thing in CrossTab, or use any single part on its own. Your work
is yours — no lock-in.
`;
