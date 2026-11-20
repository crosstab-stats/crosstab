/**
 * @file plugins/builtin-parquet-codec/index.js
 * Reference streaming codec (#98): Apache Parquet (.parquet).
 *
 * Parquet is the project's own internal interchange format, so a plugin-owned
 * Parquet codec is the cleanest proof of the codec interface — and high-value for
 * exchanging data with pandas/R-arrow/DuckDB. It's pure JS (hyparquet to read,
 * hyparquet-writer to write), so it runs in the strict no-WASM sandbox; it gets
 * those libraries from the host via `app.codec.loadAsset` (the sandbox can't fetch
 * them itself), then streams: read decodes row-group by row-group into the host
 * ingest; write pulls rows in batches and emits the encoded bytes.
 */

export const manifest = {
  id: 'builtin-parquet-codec',
  name: 'Parquet codec',
  apiVersion: '0.1.0',
  category: 'Data',
  howto:
    'GUI: File ▸ Import data… (or Export data…), choose Parquet (.parquet). Reads/writes Apache Parquet, streaming row-group by row-group.\n' +
    'Used through the File menu, not a run command.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'codec-parquet',
      title: 'Parquet',
      category: 'Data',
      keywords: ['parquet', 'apache', 'columnar', 'big data', 'compressed', 'arrow', 'import', 'export'],
      needs: ['builtin-parquet-codec'],
      seeAlso: ['import-data', 'export-data'],
    },
  ],
  codecs: [
    {
      id: 'parquet',
      label: 'Parquet (.parquet)…',
      extensions: ['.parquet'],
      read: 'readParquet',
      write: 'writeParquet',
      order: 30,
      multiple: true,
    },
  ],
};

/** The host's shared helpers (core/plugin-stdlib.js). Bound at module scope, as every
 * other plugin does it — the sandbox assigns the global before importing this module. */
const { isWideDataset } = globalThis.ctStd;

const WRITE_BATCH = 50_000; // rows per write pass

/** Import a host-provided JS module from its source text (sandbox-safe: blob: is
 * allowed by the plugin CSP, external fetch is not). */
async function importAsset(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A hyparquet `asyncBuffer` backed by random-access reads of the source file. */
function sourceBuffer(app, size) {
  return {
    byteLength: size,
    slice: async (start, end) => {
      const s = Math.max(0, start | 0);
      const e = end == null ? size : Math.min(size, end | 0);
      const u8 = await app.codec.read(s, Math.max(0, e - s));
      return u8.buffer;
    },
  };
}

/** Is a decoded Parquet value numeric for our purposes? (INT64 comes back BigInt,
 * BOOLEAN as true/false — both map to numbers; BYTE_ARRAY/UTF8 stays text.) */
function isNumericValue(v) {
  return typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean';
}
function toNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  return NaN;
}
function toText(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Decode a Parquet file into the dataset, streaming one row group at a time.
 *
 * ## The storage-routing decision, which this reader was not making
 *
 * A dataset too big for a DuckDB table has to go out of core — the host writes Parquet
 * and queries that — and the 2026-11-18 audit found three of five codecs, this one
 * included, never declaring it. So a multi-gigabyte Parquet file built a table however
 * big it was, while the same data in a CSV did not, purely because of which reader opened
 * it.
 *
 * It is free here, and that is the part worth noticing: Parquet's footer carries the row
 * count and the schema, so the decision can be made before a single row group is read.
 * `isWideDataset` is the host's one rule, so this file goes the same way as any other.
 *
 * ## Column types are STILL sniffed from the first row group, and should not be
 *
 * `beginFrom` decides each column from the values in the first row group that has any.
 * That is the same shape of bug the JSON Lines reader had — a type decided from a sample
 * and applied to the file — and in a format that carries real types in its footer it is
 * harder to excuse: a column whose first row group happens to be all-null, or all
 * integers before a later group introduces a string, is typed wrong with nothing said.
 *
 * Not fixed here, deliberately. The right fix is to read `metadata.schema` and declare
 * the types, which is the "formats that carry real types declare them" half of the hoist —
 * and getting it right means handling the logical/converted types (DECIMAL, DATE,
 * TIMESTAMP, STRING, ENUM) and nested groups, against a real file. Guessing at that
 * mapping with no Parquet fixture to check it on would be trading a visible sampling bug
 * for an invisible mis-mapping. Recorded in TODO.md with the mechanism.
 */
export async function readParquet(app, _info) {
  const hp = await importAsset(await app.codec.loadAsset('hyparquet'));
  const size = await app.codec.size();
  const file = sourceBuffer(app, size);
  const metadata = await hp.parquetMetadataAsync(file);

  let began = false;
  let columns = null;
  let types = null;

  // From the footer, before anything is read. `num_rows` is the authority; summing the
  // row groups is the fallback for a writer that omits it. BigInt either way, so Number()
  // it before it reaches arithmetic.
  const rowCount = Number(
    metadata.num_rows ?? (metadata.row_groups || []).reduce((n, g) => n + Number(g.num_rows ?? 0), 0),
  ) || 0;

  const beginFrom = async (objs) => {
    columns = Object.keys(objs[0] || {});
    types = {};
    for (const c of columns) {
      // numeric only if every non-null value in the sample is numeric
      let numeric = true, sawValue = false;
      for (const o of objs) {
        const v = o[c];
        if (v == null) continue;
        sawValue = true;
        if (!isNumericValue(v)) { numeric = false; break; }
      }
      types[c] = sawValue && numeric ? 'numeric' : 'string';
    }
    await app.codec.begin(
      columns.map((c) => ({ name: c, type: types[c] })),
      types,
      { rowCount, wide: isWideDataset(columns.length, rowCount) },
    );
    began = true;
  };

  const emit = async (objs) => {
    const out = {};
    for (const c of columns) {
      if (types[c] === 'numeric') {
        const a = new Float64Array(objs.length);
        for (let i = 0; i < objs.length; i++) a[i] = toNumber(objs[i][c]);
        out[c] = a;
      } else {
        const a = new Array(objs.length);
        for (let i = 0; i < objs.length; i++) a[i] = toText(objs[i][c]);
        out[c] = a;
      }
    }
    await app.codec.batch(out);
  };

  const groups = metadata.row_groups || [];
  let rowStart = 0;
  for (const g of groups) {
    const num = Number(g.num_rows ?? 0);
    const rowEnd = rowStart + num;
    if (num > 0) {
      const objs = await hp.parquetReadObjects({ file, metadata, rowStart, rowEnd });
      if (objs.length) {
        if (!began) await beginFrom(objs);
        await emit(objs);
      }
    }
    rowStart = rowEnd;
  }
  // No row-group metadata (or all empty): one read of the whole file.
  if (!began) {
    const objs = await hp.parquetReadObjects({ file, metadata });
    if (objs.length) { await beginFrom(objs); await emit(objs); }
    else await app.codec.begin([], {}, { rowCount: 0, wide: false });
  }
}

/**
 * Encode the current dataset as Parquet (numeric → DOUBLE, everything else →
 * UTF8 BYTE_ARRAY), streaming rows in batches into the writer, then emit the bytes.
 */
export async function writeParquet(app, _info) {
  const W = await importAsset(await app.codec.loadAsset('hyparquet-writer'));
  const meta = await app.data.getVariableMeta();
  const cols = meta.map((m) => ({ name: m.name, type: m.type === 'numeric' ? 'numeric' : 'string' }));

  const schema = [{ name: 'root', num_children: cols.length }];
  for (const c of cols) {
    schema.push(
      c.type === 'string'
        ? { name: c.name, type: 'BYTE_ARRAY', converted_type: 'UTF8', repetition_type: 'OPTIONAL' }
        : { name: c.name, type: 'DOUBLE', repetition_type: 'OPTIONAL' },
    );
  }
  const bw = new W.ByteWriter();
  const pw = new W.ParquetWriter({ writer: bw, schema, statistics: false });

  const total = await app.data.getRowCount();
  const writeRows = (rows) => {
    const columnData = cols.map((c) => ({
      name: c.name,
      data: rows.map((r) => {
        const v = r[c.name];
        if (v == null) return null;
        return c.type === 'numeric' ? Number(v) : String(v);
      }),
    }));
    pw.write({ columnData, rowGroupSize: 1_000_000_000 });
  };

  if (total === 0) {
    writeRows([]); // emit the schema even for an empty dataset
  } else {
    for (let off = 0; off < total; off += WRITE_BATCH) {
      writeRows(await app.data.getRows({ offset: off, limit: WRITE_BATCH }));
    }
  }
  pw.finish();
  await app.codec.writeChunk(new Uint8Array(bw.getBuffer()));
  return { filename: 'data.parquet', mimeType: 'application/vnd.apache.parquet' };
}
