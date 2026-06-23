/**
 * @file plugins/builtin-ndjson-codec/index.js
 * Reference streaming codec (#98): newline-delimited JSON (.ndjson / .jsonl).
 *
 * The simplest possible end-to-end codec — pure JS, no host assets — so it both
 * ships a genuinely useful interchange format AND proves the streaming codec
 * contract: `read` pulls source bytes via `app.codec.read` and pushes row batches
 * into the host ingest with `begin`/`batch`; `write` pulls rows via `app.data` and
 * emits output bytes with `app.codec.writeChunk`. Runs in the strict (no-WASM)
 * sandbox.
 */

export const manifest = {
  id: 'builtin-ndjson-codec',
  name: 'JSON Lines codec',
  apiVersion: '0.1.0',
  category: 'Data',
  codecs: [
    {
      id: 'ndjson',
      label: 'JSON Lines (.ndjson)…',
      extensions: ['.ndjson', '.jsonl'],
      read: 'readNdjson',
      write: 'writeNdjson',
      order: 40,
      multiple: true,
    },
  ],
};

const READ_CHUNK = 1 << 20; // 1 MiB source reads
const READ_BATCH = 10_000; // rows per ingest batch
const WRITE_BATCH = 10_000; // rows per output flush

/**
 * Decode an NDJSON file into the dataset, streaming. Columns are inferred from the
 * first object's keys (numbers → numeric, everything else → string); later rows
 * are coerced to that schema (extra keys ignored, missing → null). The source is
 * read in chunks and split into lines, so the whole file is never held at once.
 */
export async function readNdjson(app, _info) {
  const size = await app.codec.size();
  const decoder = new TextDecoder();
  let offset = 0;
  let partial = '';
  let rows = [];
  let columns = null;
  let types = null;
  let began = false;

  const begin = async (row) => {
    columns = Object.keys(row);
    types = {};
    for (const c of columns) types[c] = typeof row[c] === 'number' ? 'numeric' : 'string';
    const variables = columns.map((c) => ({ name: c, type: types[c] }));
    await app.codec.begin(variables, types);
    began = true;
  };

  const flush = async () => {
    if (!rows.length) return;
    const out = {};
    for (const c of columns) {
      if (types[c] === 'numeric') {
        const a = new Float64Array(rows.length);
        for (let i = 0; i < rows.length; i++) { const v = rows[i][c]; a[i] = typeof v === 'number' ? v : NaN; }
        out[c] = a;
      } else {
        const a = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) { const v = rows[i][c]; a[i] = v == null ? null : String(v); }
        out[c] = a;
      }
    }
    await app.codec.batch(out);
    rows = [];
  };

  const handleLine = async (line) => {
    const s = line.trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch { return; } // skip malformed lines
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (!began) await begin(obj);
    rows.push(obj);
    if (rows.length >= READ_BATCH) await flush();
  };

  while (offset < size) {
    const u8 = await app.codec.read(offset, Math.min(READ_CHUNK, size - offset));
    if (!u8.length) break;
    offset += u8.length;
    partial += decoder.decode(u8, { stream: true });
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      await handleLine(line);
    }
  }
  partial += decoder.decode();
  if (partial) await handleLine(partial);
  // Empty/headerless file still needs a schema so the host creates a (empty) table.
  if (!began) await app.codec.begin([], {});
  await flush();
}

/**
 * Encode the current dataset as NDJSON, one object per row, streaming in batches.
 * Returns the suggested filename/MIME for the host download.
 */
export async function writeNdjson(app, _info) {
  const meta = await app.data.getVariableMeta();
  const names = meta.map((m) => m.name);
  const total = await app.data.getRowCount();
  const enc = new TextEncoder();
  for (let off = 0; off < total; off += WRITE_BATCH) {
    const batch = await app.data.getRows({ offset: off, limit: WRITE_BATCH });
    let s = '';
    for (const r of batch) {
      const obj = {};
      for (const n of names) obj[n] = r[n] ?? null;
      s += JSON.stringify(obj) + '\n';
    }
    await app.codec.writeChunk(enc.encode(s));
  }
  return { filename: 'data.ndjson', mimeType: 'application/x-ndjson' };
}
