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
  howto:
    'GUI: File ▸ Import data… (or Export data…), choose JSON Lines (.ndjson / .jsonl). Streams newline-delimited JSON, one object per row.\n' +
    'Used through the File menu, not a run command.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'codec-ndjson',
      title: 'JSON Lines',
      category: 'Data',
      keywords: ['json', 'ndjson', 'jsonl', 'json lines', 'newline delimited', 'stream', 'api', 'import', 'export'],
      needs: ['builtin-ndjson-codec'],
      seeAlso: ['import-data', 'export-data'],
    },
  ],
  codecs: [
    {
      id: 'ndjson',
      label: 'JSON Lines (.ndjson)…',
      extensions: ['.ndjson', '.jsonl'],
      read: 'readNdjson',
      catalog: 'catalogNdjson',
      write: 'writeNdjson',
      order: 40,
      multiple: true,
    },
  ],
};

/** The host's shared helpers (core/plugin-stdlib.js). */
const { ingestTable, tableVariableNames } = globalThis.ctStd;

const READ_CHUNK = 1 << 20; // 1 MiB source reads
const WRITE_BATCH = 10_000; // rows per output flush

/**
 * Decode an NDJSON file into the dataset, streaming.
 *
 * ## What this reader got wrong, and why it was structural
 *
 * It inferred the schema from the FIRST object alone — `typeof row[k] === 'number'` on
 * one record decided the column for the whole file — and then coerced every later row to
 * that guess. One string in the first record and a column of ten million numbers imported
 * as text; one number in the first record and every later `"N/A"` became `NaN` silently.
 * It also detected no missing-value codes and never routed a large file out of core, so a
 * multi-gigabyte JSON-lines file built a DuckDB table however big it was.
 *
 * None of that was carelessness, and that is the point: typing, code detection and width
 * routing are properties of tabular data and of our storage, not of newline-delimited
 * JSON, and asking each codec to re-implement them is what produced five codecs with five
 * different subsets of the behaviour right. They now live in `ingestTable`
 * (plugin-stdlib), and this reader does the one thing that is genuinely about this format:
 * turn bytes into rows of raw values.
 *
 * So it now gets exact typing over every record, the `NA`/`PS` missing-code pass, the
 * cell-sized batching, and the out-of-core route — for free, and identically to every
 * other reader.
 *
 * ## The two things this format needs that a delimited file does not
 *
 * **There is no header row**, so the columns are only known once every record has been
 * seen: a key may first appear in the last object in the file. `keyOrder` is therefore
 * built during pass 1 (first appearance wins, which keeps the column order of a
 * well-formed file) and handed over afterwards as the header. Pass 2 re-reads with the
 * order already complete, so every row is full width.
 *
 * **The values are real JS values**, not text, so the typing rule is `typeof v ===
 * 'number'` rather than "parses as a finite number". Without that, `Number(true)` is 1
 * and a column of booleans would import as numeric — and a JSON `true` is not 1.
 */
export async function readNdjson(app, { select } = {}) {
  const size = await app.codec.size();
  // First appearance wins, and it is shared between the two passes deliberately: pass 2
  // must position values exactly as pass 1 typed them.
  const keyOrder = [];
  const index = new Map();

  await ingestTable(app, {
    select,
    header: () => keyOrder,
    // JSON carries its own types. Anything that is not a number is text, including a
    // boolean and including `null` (which the shared missing rule catches first anyway).
    numeric: (v) => typeof v === 'number',
    scanRows: (onRow, ctx) => scan(app, size, (obj) => {
      if (ctx.pass === 1) {
        for (const k of Object.keys(obj)) {
          if (!index.has(k)) { index.set(k, keyOrder.length); keyOrder.push(k); }
        }
      }
      // Positioned by the shared key order, not by this object's own key order — two
      // records may list the same fields in a different order, and JSON says that is the
      // same object.
      const row = new Array(keyOrder.length);
      for (const k of Object.keys(obj)) {
        const at = index.get(k);
        if (at !== undefined) row[at] = obj[k];
      }
      return onRow(row);
    }, ctx.tick),
  });
}

/**
 * The variable list without the data — and in this format that is a SAMPLE, with a caveat
 * the host cannot soften.
 *
 * There is no header row. A field may first appear in the last record of the file, so the
 * only honest complete answer is to read the whole thing, which is what the catalog call
 * exists to avoid. So it reads the first chunk, takes the union of the keys it finds, and
 * a field that appears only later is simply not offered.
 *
 * That is a real limitation and it fails SAFELY, which is the reason it is acceptable: a
 * field nobody was offered is one the user did not untick, and an unselected column is
 * dropped — so the worst case is a late-appearing field being left out of a subset
 * import. Importing everything (the default, no selection) is unaffected and still sees
 * every field, because `readNdjson` builds its key order over the whole file.
 *
 * The alternative — scanning the file to list its columns, then scanning it twice more to
 * import them — would make choosing cost more than not choosing.
 */
export async function catalogNdjson(app, _info) {
  const size = await app.codec.size();
  const order = [];
  const seen = new Set();
  await scan(app, Math.min(READ_CHUNK, size), (obj) => {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) { seen.add(k); order.push(k); }
    }
    return undefined;
  }, () => {});
  return { variables: tableVariableNames(order).map((nm) => ({ name: nm })) };
}

/**
 * Read the source in chunks, split it into lines, and hand each parsed object to `onObj`.
 *
 * Called twice (see `ingestTable`), so it holds no state across calls beyond what it is
 * given. Malformed lines and non-object values are skipped — identically on both passes,
 * which is what makes the two passes agree.
 *
 * `onObj` may return a promise, awaited before the next line is parsed: that is how a
 * filled batch stops the parse rather than overrunning its buffers.
 */
async function scan(app, size, onObj, onTick) {
  const decoder = new TextDecoder();
  let offset = 0;
  let partial = '';

  const handleLine = async (line) => {
    const t = line.trim();
    if (!t) return;
    let obj;
    try { obj = JSON.parse(t); } catch { return; } // skip malformed lines
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return;
    const wait = onObj(obj);
    if (wait) await wait;
  };

  while (offset < size) {
    // eslint-disable-next-line no-await-in-loop -- sequential by nature
    const u8 = await app.codec.read(offset, Math.min(READ_CHUNK, size - offset));
    if (!u8.length) break;
    offset += u8.length;
    partial += decoder.decode(u8, { stream: true });
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      // eslint-disable-next-line no-await-in-loop -- a batch may have flushed
      await handleLine(line);
    }
    onTick();
  }
  partial += decoder.decode();
  if (partial) await handleLine(partial);
  onTick();
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
