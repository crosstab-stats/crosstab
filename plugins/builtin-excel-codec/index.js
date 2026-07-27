/**
 * @file plugins/builtin-excel-codec/index.js
 * Excel (.xlsx/.xls/.xlsm/.xlsb) as a format codec (#98) — read + write — via SheetJS.
 *
 * Unlike the CSV/ReadStat codecs this does NOT stream: a spreadsheet is an inherently
 * bounded format (≤ ~1,048,576 rows, and practically far smaller) and SheetJS builds
 * the whole workbook in memory anyway. So read decodes the whole file then emits rows
 * to the host ingest in batches (the commit stays memory-bounded through DuckDB), and
 * write pulls all rows, builds one worksheet, and emits the `.xlsx` bytes in one chunk.
 *
 * SheetJS is a host-vetted shared library fetched via `app.codec.loadAsset('xlsx')`
 * (the sandbox has `connect-src 'none'` and can't fetch it itself) and blob-imported.
 *
 * Read type handling mirrors the CSV codec: a column is numeric only if every non-empty
 * value is a real number; everything else (text, booleans, dates) becomes a string
 * column. `cellDates: true` turns date cells into JS `Date`s, carried as ISO text
 * (consistent with the engine's Bridge-A temporal convention). Write emits raw values
 * (numbers as numbers, everything else as text; missing → empty cell) so a file
 * round-trips — the same "raw values, not labels" contract the CSV codec uses.
 *
 * Multi-sheet workbooks: one sheet imported per file. A single-sheet workbook uses
 * it directly; a multi-sheet workbook prompts for which sheet (pooling several
 * sheets into one dataset is a possible follow-up). Export writes a single sheet.
 */

export const manifest = {
  id: 'builtin-excel-codec',
  name: 'Excel codec',
  version: '2', // #91 freshness marker: bumped when export was added
  apiVersion: '0.1.0',
  category: 'Data',
  keywords: ['excel', 'xlsx', 'xls', 'spreadsheet', 'workbook', 'sheetjs', 'file'],
  rPackages: [],
  howto:
    'GUI: File ▸ Import data… (or Export data…), choose Excel (.xlsx / .xls). Import reads a worksheet as a table — first row is the header, one column per spreadsheet column (multi-sheet workbooks ask which sheet). Export writes the current dataset to a single-sheet .xlsx.\n' +
    'Used through the File menu, not a run command.',
  codecs: [
    {
      id: 'xlsx',
      label: 'Excel…',
      extensions: ['.xlsx', '.xls', '.xlsm', '.xlsb'],
      read: 'readXlsx',
      write: 'writeXlsx',
      order: 11, // just after CSV (10)
      multiple: true,
    },
  ],
};

const EMIT_BATCH = 50_000;

// --- read --------------------------------------------------------------------

/** Decode an Excel workbook into the dataset: parse with SheetJS, choose a sheet,
 * treat the first row as a header, infer per-column type, then stream rows to the
 * host ingest in batches. */
export async function readXlsx(app, { name }) {
  const size = await app.codec.size();
  const bytes = await readAll(app, size);

  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  // cellDates → date cells become JS Date (carried as ISO text below). Don't parse
  // formulas' cached errors into throws; SheetJS yields them as strings.
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });

  const sheetNames = wb.SheetNames || [];
  if (!sheetNames.length) throw new Error('Excel: the workbook has no sheets');

  const sheetName = await chooseSheet(app, sheetNames, name);
  if (sheetName == null) throw new Error('Excel import cancelled');

  const ws = wb.Sheets[sheetName];
  // header:1 → array-of-arrays; raw:true keeps native JS types (numbers as numbers,
  // Dates as Dates); defval:null fills gaps; blankrows:false drops fully-empty rows.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
  const { variables, storageTypes, columns } = buildColumns(aoa);
  if (!variables.length) throw new Error(`Excel: sheet "${sheetName}" has no columns`);

  await app.codec.begin(variables, storageTypes);
  const total = columns[variables[0].name].length;
  for (let off = 0; off < total; off += EMIT_BATCH) {
    const chunk = {};
    for (const v of variables) chunk[v.name] = columns[v.name].slice(off, off + EMIT_BATCH);
    await app.codec.batch(chunk);
  }
}

/** Pick which sheet to import. One sheet → use it; several → prompt (falling back
 * to the first if the UI service isn't available in this context). */
async function chooseSheet(app, sheetNames, fileName) {
  if (sheetNames.length === 1) return sheetNames[0];
  if (!app.ui || typeof app.ui.selectFromList !== 'function') return sheetNames[0];
  const chosen = await app.ui.selectFromList({
    title: 'Choose a sheet',
    hint: `“${fileName || 'Workbook'}” has ${sheetNames.length} sheets — pick one to import.`,
    items: sheetNames.map((s) => ({ value: s, label: s })),
    multiple: false,
  });
  if (chosen === null) return null; // cancelled
  return Array.isArray(chosen) ? chosen[0] : chosen;
}

/** Read the whole source via chunked random-access reads, concatenated. */
async function readAll(app, size) {
  const CHUNK = 1 << 22; // 4 MiB
  const parts = [];
  let off = 0;
  while (off < size) {
    const u8 = await app.codec.read(off, Math.min(CHUNK, size - off));
    if (!u8.length) break;
    parts.push(u8);
    off += u8.length;
  }
  const out = new Uint8Array(off);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** Turn an array-of-arrays (row 0 = header) into {variables, storageTypes, columns}:
 * numeric columns as Float64Array (NaN for missing), everything else as string
 * arrays (null for missing). */
function buildColumns(aoa) {
  if (!aoa.length) return { variables: [], storageTypes: {}, columns: {} };

  const headerRow = aoa[0] || [];
  const width = aoa.reduce((w, row) => Math.max(w, row ? row.length : 0), 0);
  const header = [];
  for (let c = 0; c < width; c++) {
    const h = headerRow[c];
    header.push(h === null || h === undefined || String(h).trim() === '' ? `V${c + 1}` : String(h).trim());
  }

  // Collect raw cell values per column (missing → null).
  const raw = header.map(() => []);
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      raw[c].push(cell === undefined || cell === '' ? null : cell ?? null);
    }
  }

  const variables = [];
  const storageTypes = {};
  const columns = {};
  const used = {};
  for (let c = 0; c < width; c++) {
    const nm = uniqueName(header[c], used);
    used[nm] = true;
    const values = raw[c];
    if (isNumericColumn(values)) {
      variables.push({ name: nm, type: 'numeric', measurementLevel: 'scale' });
      storageTypes[nm] = 'numeric';
      const a = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) a[i] = values[i] === null ? NaN : Number(values[i]);
      columns[nm] = a;
    } else {
      variables.push({ name: nm, type: 'string', measurementLevel: 'nominal' });
      storageTypes[nm] = 'string';
      columns[nm] = values.map(cellToString);
    }
  }
  return { variables, storageTypes, columns };
}

/** True if every non-null value is a real (finite) number — SheetJS raw mode yields
 * genuine JS numbers for numeric cells, so a text/date/boolean cell disqualifies the
 * column (→ string), matching the CSV codec's conservative rule. */
function isNumericColumn(values) {
  let seen = 0;
  for (const v of values) {
    if (v === null) continue;
    seen++;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return seen > 0;
}

/** Stringify a cell for a string column: Dates → ISO text, everything else via
 * String(); null stays null (missing). */
function cellToString(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
}

/** Ensure a column name is unique within the dataset being built. */
function uniqueName(base, used) {
  if (!(base in used)) return base;
  let i = 2;
  while (`${base}_${i}` in used) i++;
  return `${base}_${i}`;
}

// --- write -------------------------------------------------------------------

/** Excel's hard row ceiling (header + data rows), per the .xlsx grid limit. */
const XLSX_MAX_ROWS = 1_048_576;

/** Encode the current (derived) dataset as a single-sheet .xlsx. Pulls rows in
 * batches to build the sheet, writes raw values (numbers as numbers, everything else
 * as text; missing → empty cell), and emits the whole workbook as one byte chunk
 * (SheetJS builds it in memory — Excel is bounded, so this is fine). */
export async function writeXlsx(app, _info) {
  const meta = await app.data.getVariableMeta();
  if (!meta.length) throw new Error('no variables to export');
  const names = meta.map((m) => m.name);
  const total = await app.data.getRowCount();
  if (total + 1 > XLSX_MAX_ROWS) {
    throw new Error(
      `Excel supports at most ${(XLSX_MAX_ROWS - 1).toLocaleString()} rows; this dataset has ` +
        `${total.toLocaleString()}. Export as CSV or Parquet instead.`,
    );
  }

  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  const aoa = [names];
  const BATCH = 50_000;
  for (let off = 0; off < total; off += BATCH) {
    const rows = await app.data.getRows({ offset: off, limit: BATCH });
    for (const r of rows) aoa.push(names.map((n) => exportCell(r[n])));
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const ab = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  await app.codec.writeChunk(new Uint8Array(ab));
  return {
    filename: 'crosstab-export.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/** A cell value for export: numbers stay numbers (NaN → empty), missing → empty
 * cell (null, which SheetJS renders blank), everything else → text. */
function exportCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  return String(v);
}

// --- helpers -----------------------------------------------------------------

/** Import a fetched module source (from loadAsset) by blob URL — the only way in,
 * since the codec sandbox allows `blob:` scripts but not external fetch. */
async function importAsset(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
