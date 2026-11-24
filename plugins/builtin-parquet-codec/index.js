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
      catalog: 'catalogParquet',
      write: 'writeParquet',
      order: 30,
      multiple: true,
    },
  ],
};

/** The host's shared helpers (core/plugin-stdlib.js). Bound at module scope, as every
 * other plugin does it — the sandbox assigns the global before importing this module. */
const { tableVariableNames } = globalThis.ctStd;

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

/**
 * The column types a Parquet file DECLARES, from its footer — or null when the footer
 * cannot answer and the values have to be sniffed instead.
 *
 * ## Why this is not read off the spec
 *
 * Parquet's footer gives a physical type plus an optional `converted_type` (the old
 * annotation) or `logical_type` (the new one), and what matters here is not what those
 * MEAN but what hyparquet hands back for each of them — because that is what the ingest
 * has to store. The two differ in ways that cannot be guessed:
 *
 *  - `DATE`, `TIMESTAMP_*` and a bare `INT96` arrive as **Date objects**, not numbers.
 *  - `JSON`, `GEOMETRY` and `GEOGRAPHY` arrive as **parsed JS values** — so `String(v)`
 *    on one gives `[object Object]`, which is why `toText` had to learn about objects.
 *  - `DECIMAL` arrives as a **number**, already divided by its scale, whatever its
 *    physical type (INT32, INT64 or a byte array).
 *  - `TIME_MILLIS` is NOT converted at all and arrives as a raw INT32 — milliseconds
 *    past midnight, i.e. a number.
 *  - `UINT_64` arrives as **BigInt**; `UINT_32` as a number.
 *
 * Verified by writing real Parquet files and reading them back (hyparquet 1.33.1,
 * hyparquet-writer 0.16.1) for the common types, and read out of hyparquet's own
 * conversion function for the rest. Writing this from the Parquet spec alone would have
 * typed every timestamp column as numeric.
 *
 * ## Why it can return null
 *
 * `metadata.schema` is a flat, pre-order list whose first element is the root and whose
 * leaves are the columns. For a flat file — which is what this reader supports, and what
 * every file written by pandas, R-arrow or DuckDB from a data frame is — the leaf names
 * are unique and are exactly the keys `parquetReadObjects` produces. A NESTED file breaks
 * both of those, so rather than guess at a flattening this hands back null and lets the
 * caller sniff, which is what it did for every file before this.
 *
 * Exported — unlike everything else here that is not a codec verb — because the mapping
 * is the part worth testing exhaustively and it is PURE: a table of schema elements in,
 * a table of types out, no library, no network, no bytes. The round trip against real
 * Parquet files is what proves the mapping matches hyparquet's behaviour, and that needs
 * the pinned CDN modules; this is what proves the mapping itself, offline, always.
 *
 * @param {object} metadata - from `parquetMetadataAsync`
 * @returns {?{names: string[], types: Object<string, 'numeric'|'string'>}}
 */
export function schemaTypes(metadata) {
  const schema = metadata?.schema;
  if (!Array.isArray(schema) || schema.length < 2) return null;
  const names = [];
  const types = {};
  for (let i = 1; i < schema.length; i++) {
    const el = schema[i];
    // A group inside the root: nested. Bail rather than invent a flattening.
    if (Number(el?.num_children ?? 0) > 0) return null;
    const name = el?.name == null ? null : String(el.name);
    if (!name || Object.prototype.hasOwnProperty.call(types, name)) return null; // unnamed or a dup
    names.push(name);
    types[name] = declaredType(el);
  }
  return names.length ? { names, types } : null;
}

/**
 * One leaf's CrossTab type, from its physical type and its annotation.
 *
 * Ordered the way hyparquet's own converter is ordered, because that is the thing being
 * mirrored: the first rule that matches decides, and `DECIMAL` has to be tested before
 * the physical type it rides on.
 *
 * @param {{type?: string, converted_type?: string, logical_type?: object}} el
 * @returns {'numeric'|'string'}
 */
export function declaredType(el) {
  const phys = el?.type ?? '';
  const conv = el?.converted_type ?? '';
  const logical = el?.logical_type?.type ?? '';

  // Scaled to a Number by the reader, whatever bytes it was stored in.
  if (conv === 'DECIMAL' || logical === 'DECIMAL') return 'numeric';
  // Dates and timestamps arrive as Date objects and are carried as ISO text — the
  // engine's temporal convention, the same one the spreadsheet reader follows.
  if (conv === 'DATE' || logical === 'DATE') return 'string';
  if (conv === 'TIMESTAMP_MILLIS' || conv === 'TIMESTAMP_MICROS' || logical === 'TIMESTAMP') return 'string';
  if (phys === 'INT96' && !conv) return 'string'; // the legacy timestamp encoding
  // Parsed JS values: an object in a numeric column would be NaN, and in a string column
  // `String(v)` would be "[object Object]" — see `toText`.
  if (conv === 'JSON' || logical === 'JSON') return 'string';
  if (logical === 'GEOMETRY' || logical === 'GEOGRAPHY' || logical === 'UUID') return 'string';
  // Text, including a plain BYTE_ARRAY: hyparquet decodes those as UTF-8 by default.
  if (conv === 'UTF8' || conv === 'ENUM' || logical === 'STRING' || logical === 'ENUM') return 'string';
  if (phys === 'BYTE_ARRAY') return 'string';
  // Everything else the reader produces is a number, a BigInt or a boolean — all of which
  // `toNumber` handles. A FIXED_LEN_BYTE_ARRAY with no annotation is the one exception:
  // it arrives as raw bytes, which are not a number, so it is text.
  if (phys === 'FIXED_LEN_BYTE_ARRAY') return 'string';
  return 'numeric';
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
  // The engine's temporal convention, and the same one the spreadsheet reader follows.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  // A JSON, GEOMETRY or GEOGRAPHY column arrives already PARSED, so `String(v)` would
  // store "[object Object]" for every row. Found by probing what hyparquet actually
  // returns per type rather than by reading the Parquet spec, which says nothing about it.
  if (typeof v === 'object' && !(v instanceof Uint8Array)) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  // Opaque bytes (a FIXED_LEN_BYTE_ARRAY with no annotation): hex, because `String(bytes)`
  // gives "1,2,3" and `JSON.stringify` gives an object keyed by index.
  if (v instanceof Uint8Array) return [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  return String(v);
}

/**
 * Decode a Parquet file into the dataset, streaming one row group at a time.
 *
 * ## The storage-routing decision, which is no longer made here at all
 *
 * A dataset too big for a DuckDB table has to go out of core — the host writes Parquet and
 * queries that — and the 2026-11-18 audit found three of five codecs, this one included,
 * never declaring it: a multi-gigabyte Parquet file built a table however big it was,
 * while the same data in a CSV did not, purely because of which reader opened it. The fix
 * then was to call the shared rule from here. The fix now is that there is nothing to
 * call: that rule was measured on 2026-11-23 and deleted, and the host decides from the
 * schema and the row count every codec already declares.
 *
 * What survives is the part that was genuinely this format's: the footer carries BOTH the
 * row count and the column types, so everything the host routes on reaches it before a
 * single row group is read — no counting pass, no sniffing, and an exact estimate rather
 * than a pessimistic one.
 *
 * ## Column types are DECLARED, from the footer
 *
 * Which is the "formats that carry real types declare them" half of pulling host policy
 * out of the codecs. It used to sniff each column from the values in the first row group
 * that had any — the same shape of bug the JSON Lines reader had, and harder to excuse
 * here: a column whose first row group happens to be all-null, or all integers before a
 * later group introduces a string, was typed wrong with nothing said.
 *
 * The mapping is in `schemaTypes`/`declaredType`, and it was measured rather than read off
 * the spec, because what matters is not what an annotation MEANS but what hyparquet hands
 * back for it — `DATE` and `TIMESTAMP_*` arrive as Date objects, `JSON` arrives already
 * parsed, `DECIMAL` arrives pre-scaled as a Number, and `TIME_MILLIS` is not converted at
 * all. A mapping written from the spec would have typed every timestamp as numeric.
 *
 * A NESTED schema still falls back to sniffing: `schemaTypes` returns null rather than
 * invent a flattening, and this reader only ever supported flat files.
 */
export async function readParquet(app, { select } = {}) {
  const hp = await importAsset(await app.codec.loadAsset('hyparquet'));
  const size = await app.codec.size();
  const file = sourceBuffer(app, size);
  const metadata = await hp.parquetMetadataAsync(file);

  // A genuine SKIP, not a filter. Parquet is columnar, so hyparquet can be told which
  // columns to decode and the rest are never touched — no decompression, no allocation.
  // This is the format where "choose which variables to import" pays the most, and the
  // reason the shared contract is "drop unselected columns as early as you can" rather
  // than "drop them": where early means "never read", that is what it should mean.
  const wanted = select == null ? null : new Set(select);
  const only = wanted === null ? {} : { columns: [...wanted] };

  let began = false;
  let columns = null;
  let types = null;

  // From the footer, before anything is read. `num_rows` is the authority; summing the
  // row groups is the fallback for a writer that omits it. BigInt either way, so Number()
  // it before it reaches arithmetic.
  const rowCount = Number(
    metadata.num_rows ?? (metadata.row_groups || []).reduce((n, g) => n + Number(g.num_rows ?? 0), 0),
  ) || 0;

  const declare = async () => {
    await app.codec.begin(
      columns.map((c) => ({ name: c, type: types[c] })),
      types,
      { rowCount },
    );
    began = true;
  };

  // DECLARED, not sniffed — the thing this reader was getting wrong. It used to decide
  // each column from the values in the first row group that had any, which is the same
  // shape of bug the JSON-lines reader had, and harder to excuse in a format that carries
  // real types in its footer: a column whose first row group happens to be all-null, or
  // all integers before a later group introduces a string, was typed wrong in silence.
  //
  // Declaring also means the schema reaches the host BEFORE a single row group is read,
  // so an empty file keeps its columns instead of arriving as a dataset with none.
  const declared = schemaTypes(metadata);
  if (declared) {
    // The footer lists every column; a selection narrows which of them are read AND which
    // are declared, or the host would be promised columns that never arrive.
    columns = wanted === null ? declared.names : declared.names.filter((c) => wanted.has(c));
    if (!columns.length) throw new Error('Parquet: none of the selected variables are in this file');
    types = Object.fromEntries(columns.map((c) => [c, declared.types[c]]));
    await declare();
  }

  /**
   * The fallback: infer from the values, for a file whose footer cannot be read flatly —
   * a NESTED schema, or names that collide once flattened. `schemaTypes` returns null for
   * those rather than inventing a flattening, and this is what every file got before the
   * footer was consulted at all.
   */
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
    await declare();
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
      const objs = await hp.parquetReadObjects({ file, metadata, rowStart, rowEnd, ...only });
      if (objs.length) {
        if (!began) await beginFrom(objs);
        await emit(objs);
      }
    }
    rowStart = rowEnd;
  }
  // No row-group metadata (or all empty). With a declared schema the columns are already
  // announced, so this only has to cover the sniffing fallback — and a file that declares
  // nothing AND yields nothing still needs an empty schema, or the host has no dataset to
  // create.
  if (!began) {
    const objs = await hp.parquetReadObjects({ file, metadata, ...only });
    if (objs.length) { await beginFrom(objs); await emit(objs); }
    else await app.codec.begin([], {}, { rowCount: 0 });
  }
}

/**
 * The variable list without the data: the footer's schema.
 *
 * The cheapest catalog of any format here, and the most useful — Parquet is columnar, so
 * a selection made from this list is a genuine skip in `readParquet` rather than a filter
 * applied after decoding. Reading the footer costs one seek to the tail of the file,
 * whatever the file's size.
 *
 * `metadata.schema` is a FLAT, pre-order list whose first element is the root group and
 * whose leaves are the columns. Only leaves are taken (`num_children` absent or zero),
 * which also means a nested group contributes its leaves and not itself — the same thing
 * `parquetReadObjects` produces top-level keys for in the flat case this reader supports.
 * Nothing here maps the logical types: the reader still sniffs those from the first row
 * group, and offering a type here that the import then contradicts would be worse than
 * offering none. (That gap is the open item; see `readParquet`.)
 */
export async function catalogParquet(app, _info) {
  const hp = await importAsset(await app.codec.loadAsset('hyparquet'));
  const size = await app.codec.size();
  const metadata = await hp.parquetMetadataAsync(sourceBuffer(app, size));
  const leaves = (metadata?.schema ?? [])
    .filter((el) => !Number(el?.num_children ?? 0) && el?.name != null)
    .map((el) => String(el.name));
  const rowCount = Number(
    metadata?.num_rows ?? (metadata?.row_groups || []).reduce((n, g) => n + Number(g.num_rows ?? 0), 0),
  ) || 0;
  return { variables: tableVariableNames(leaves).map((nm) => ({ name: nm })), rowCount };
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
