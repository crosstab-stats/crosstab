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

/**
 * Build a `.crosstab` bundle Blob from the open datasets.
 * @param {object} deps
 * @param {import('./dataset-manager.js').DatasetManager} deps.datasets
 * @param {string} [deps.projectName]
 * @returns {Promise<Blob>}
 */
export async function exportProjectBundle({ datasets, projectName }) {
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
  };
  entries.unshift({ name: 'manifest.json', data: pretty(manifest) });
  entries.push({ name: 'README.md', data: README });
  return makeZip(entries);
}

/**
 * Read a `.crosstab` bundle's manifest + entry list without importing (for a
 * preview / validation). Full import (rebuild datasets) is a follow-up.
 * @param {Uint8Array} buf
 */
export function inspectProjectBundle(buf) {
  const files = readZip(buf);
  const mf = files.find((f) => f.name === 'manifest.json');
  const manifest = mf ? JSON.parse(new TextDecoder().decode(mf.data)) : null;
  if (!manifest || manifest.format !== FORMAT) throw new Error('Not a CrossTab project bundle.');
  return { manifest, files: files.map((f) => ({ name: f.name, bytes: f.data.length })) };
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
- **manifest.json** — project name, export date, and the dataset index.

Re-open the whole thing in CrossTab, or use any single part on its own. Your work
is yours — no lock-in.
`;
