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
 * Multi-sheet workbooks: a single-sheet workbook imports straight through; a
 * multi-sheet workbook prompts with a checklist of sheets (row×col hints, first
 * sheet pre-checked) so summary/codebook sheets can be skipped. Selected sheets are
 * **split into separate datasets** — one per sheet — because workbook sheets are
 * usually heterogeneous (data + codebook + summary), so pooling/row-stacking them
 * would be wrong; joining is a deliberate keyed operation the existing Merge feature
 * owns. The first selected sheet streams through the host ingest as the primary
 * dataset (the codec must emit a schema); each additional sheet is created as its
 * own named dataset via `app.data.create`. Export writes a single sheet.
 */

/** The host's shared helpers (core/plugin-stdlib.js). */
const { uniqueName, createTypeScan } = globalThis.ctStd;

export const manifest = {
  id: 'builtin-excel-codec',
  name: 'Excel codec',
  version: '2', // #91 freshness marker: bumped when export was added
  apiVersion: '0.1.0',
  category: 'Data',
  keywords: ['excel', 'xlsx', 'xls', 'spreadsheet', 'workbook', 'sheetjs', 'file'],
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'codec-excel',
      title: 'Excel workbooks',
      category: 'Data',
      keywords: ['excel', 'xlsx', 'xls', 'spreadsheet', 'workbook', 'worksheet', 'sheet', 'import', 'export'],
      needs: ['builtin-excel-codec'],
      seeAlso: ['import-data', 'export-data'],
    },
  ],
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

// Values per ingest batch, not ROWS. A fixed row count is fine at ten columns and
// fatal at three thousand: the width decides what a batch costs, which is how the CSV
// reader came to hand DuckDB one batch of 21 million cells and OOM at 3.1 GiB
// (owner, 2026-11-17). A sheet that wide is rarer than a CSV that wide, but the
// arithmetic is identical and so is the fix.
const EMIT_CELLS = 1_000_000;

// --- read --------------------------------------------------------------------

/** Decode an Excel workbook: parse with SheetJS, choose which sheet(s) to import,
 * and split them into datasets — the first streams through the host ingest (the
 * primary), each additional sheet becomes its own dataset via `app.data.create`.
 * Each sheet: first row = header, per-column type inference, rows in batches. */
export async function readXlsx(app, { name }) {
  const size = await app.codec.size();
  const bytes = await readAll(app, size);

  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  // cellDates → date cells become JS Date (carried as ISO text below). Don't parse
  // formulas' cached errors into throws; SheetJS yields them as strings.
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });

  const sheetNames = wb.SheetNames || [];
  if (!sheetNames.length) throw new Error('Excel: the workbook has no sheets');

  const chosen = await chooseSheets(app, XLSX, wb, sheetNames, name);
  if (chosen == null) throw new Error('Excel import cancelled');
  if (!chosen.length) throw new Error('Excel: no sheets selected');

  // Type the sheets, asking the host which recurring values mean "missing" (#the NA/PS
  // problem — a Scorecard year typed 211 of 3,379 columns numeric here against the CSV
  // reader's 3,360, because this rule was a COPY of that one and only one got fixed).
  //
  // Asked ONCE, from the primary sheet's proposal, and applied to every chosen sheet: a
  // missing-value code is a convention of the file, not of a tab within it. A workbook
  // whose sheets use different codes would need a prompt each, which is worse than this
  // is wrong.
  const aoas = chosen.map((sn) => sheetAoa(XLSX, wb.Sheets[sn]));
  const scans = aoas.map((aoa) => scanSheet(aoa));
  const accepted = typeof app.codec.missingCodes === 'function' && scans.length
    ? await app.codec.missingCodes(scans[0].proposal())
    : [];
  const codes = Array.isArray(accepted) ? accepted.filter((v) => typeof v === 'string') : [];

  // Build each chosen sheet's columns; drop any that turn out to have no columns.
  const built = chosen
    .map((sn, i) => ({ sheet: sn, ...buildColumns(aoas[i], scans[i].decide(codes)) }))
    .filter((b) => b.variables.length);
  if (!built.length) throw new Error('Excel: the selected sheet(s) have no columns');

  // First chosen sheet → stream through the host ingest as the primary dataset
  // (the codec contract requires emitting a schema via begin()).
  const primary = built[0];
  const total = primary.columns[primary.variables[0].name].length;
  // The row count is known here, so the progress bar can show a denominator rather
  // than counting up towards nothing.
  await app.codec.begin(primary.variables, primary.storageTypes, { rowCount: total, missingCodes: codes });
  const perBatch = Math.max(1, Math.floor(EMIT_CELLS / Math.max(1, primary.variables.length)));
  for (let off = 0; off < total; off += perBatch) {
    const chunk = {};
    for (const v of primary.variables) chunk[v.name] = primary.columns[v.name].slice(off, off + perBatch);
    await app.codec.batch(chunk);
  }

  // Additional chosen sheets → each its own new dataset (split, not pooled/joined).
  // activate:false so focus stays on the primary import. If app.data.create isn't
  // available for some reason, surface it rather than silently dropping sheets.
  for (let i = 1; i < built.length; i++) {
    const b = built[i];
    if (!app.data || typeof app.data.create !== 'function') {
      throw new Error('Excel: cannot create extra sheet datasets (app.data.create unavailable)');
    }
    // eslint-disable-next-line no-await-in-loop -- create sequentially to avoid racing the engine.
    await app.data.create({ name: b.sheet, variables: b.variables, columns: b.columns, activate: false });
  }
}

/** Choose which sheet(s) to import. One sheet → use it. Several → a multi-select
 * checklist (first sheet pre-checked; summary/codebook sheets can be unticked),
 * falling back to the first sheet if the UI service isn't available here. Returns
 * the chosen sheet names, `[]` if none picked, or `null` if cancelled. */
async function chooseSheets(app, XLSX, wb, sheetNames, fileName) {
  if (sheetNames.length === 1) return [sheetNames[0]];
  if (!app.ui || typeof app.ui.selectFromList !== 'function') return [sheetNames[0]];
  const items = sheetNames.map((sn) => {
    const { rows, cols } = sheetDims(XLSX, wb.Sheets[sn]);
    return { value: sn, label: `${sn}  (${rows.toLocaleString()} rows × ${cols} cols)` };
  });
  const chosen = await app.ui.selectFromList({
    title: 'Choose sheets to import',
    hint: `“${fileName || 'Workbook'}” has ${sheetNames.length} sheets. Each selected sheet becomes its own dataset — skip summary/codebook sheets you don’t need.`,
    items,
    multiple: true,
    okLabel: 'Import',
    selected: [sheetNames[0]], // first sheet pre-checked
  });
  return chosen; // array of names, [] if none, or null if cancelled
}

/** Header:1 array-of-arrays for a worksheet: raw JS types (numbers as numbers,
 * Dates as Dates); defval:null fills gaps; blankrows:false drops fully-empty rows. */
function sheetAoa(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

/** Data-row and column counts for a worksheet (rows excludes the header), for the
 * sheet-picker hint. Empty sheet → 0×0. */
function sheetDims(XLSX, ws) {
  const ref = ws && ws['!ref'];
  if (!ref) return { rows: 0, cols: 0 };
  const r = XLSX.utils.decode_range(ref);
  return { rows: Math.max(0, r.e.r - r.s.r), cols: r.e.c - r.s.c + 1 };
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
function buildColumns(aoa, decision = null) {
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

  // The typing rule is `createTypeScan`'s, shared with every codec that infers types
  // from values. `decision` is what it concluded; a caller that has not run one gets a
  // fresh scan with no accepted codes, which is the old behaviour exactly.
  const decided = decision ?? scanSheet(aoa).decide([]);
  const variables = [];
  const storageTypes = {};
  const columns = {};
  const used = {};
  for (let c = 0; c < width; c++) {
    const nm = uniqueName(header[c], used);
    used[nm] = true;
    const values = raw[c];
    if (decided.isNumeric[c]) {
      variables.push({ name: nm, type: 'numeric', measurementLevel: 'scale' });
      storageTypes[nm] = 'numeric';
      const a = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) a[i] = decided.isMissing(values[i]) ? NaN : Number(values[i]);
      columns[nm] = a;
    } else {
      variables.push({ name: nm, type: 'string', measurementLevel: 'nominal' });
      storageTypes[nm] = 'string';
      // A value the host called missing is missing here too, even though the column
      // stayed text — the same rule the CSV reader applies.
      columns[nm] = values.map((v) => (decided.isMissing(v) ? null : cellToString(v)));
    }
  }
  return { variables, storageTypes, columns };
}

/** A spreadsheet cell is a number only when SheetJS handed back a real one. A text cell
 * reading "01234" is a ZIP code, and parsing it would drop the leading zero — which is
 * why this rule differs from the CSV reader's and is passed in rather than assumed. */
const EXCEL_NUMERIC = (v) => typeof v === 'number' && Number.isFinite(v);

/** Run the shared type scan over a sheet's rows (row 0 is the header). */
function scanSheet(aoa) {
  const width = aoa.reduce((w, row) => Math.max(w, row ? row.length : 0), 0);
  const scan = createTypeScan({ columns: width, numeric: EXCEL_NUMERIC });
  for (let r = 1; r < aoa.length; r++) scan.observeRow(aoa[r] || []);
  return scan;
}

/** Stringify a cell for a string column: Dates → ISO text, everything else via
 * String(); null stays null (missing). */
function cellToString(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return String(v);
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
