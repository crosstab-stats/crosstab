/**
 * @file plugins/builtin-excel-codec/index.js
 * Excel (.xlsx/.xls/.xlsm/.xlsb) as a format codec (#98) — read + write.
 *
 * ## Reading streams; the format decides which reader
 *
 * An .xlsx/.xlsm is a zip of XML, so it CAN be read a chunk at a time, and is: the host's
 * `core/xlsx-stream.js` inflates one sheet part through `DecompressionStream` and scans
 * rows out of it. Measured on a College Scorecard year converted to .xlsx (3,379 × 6,272):
 * 13–20 MiB of live heap for a 54 MiB slice of it, against SheetJS's 2,578 MiB for the
 * same slice — SheetJS materialises every cell as an object, and the old code then built
 * an array-of-arrays from that and pivoted THAT into columns, four copies alive at once.
 * Extrapolated, the full file needed about 7.6 GiB against a renderer cap near 4.
 *
 * .xls (BIFF, an OLE compound file) and .xlsb (binary sheet parts) are not XML and have
 * no streaming path, so they still go through SheetJS. They are the legacy formats, where
 * a file big enough to matter is rare — .xls caps at 65,536 rows by construction.
 *
 * This file therefore holds TWO readers. The alternative was an asterisk on the format
 * picker saying "Excel: small files only", which the owner declined: *"Lack of parity
 * isn't defensible for me when we have a path to parity."* Both readers end at the same
 * place — `begin()` then cell-bounded `batch()` calls — so what the host ingests, the
 * type rule it applies, and the missing-code prompt are identical either way.
 *
 * Writing still builds the workbook whole via SheetJS: it has no streaming writer, and an
 * export is bounded by what is already in the dataset.
 *
 * ## Dependencies
 *
 * Both are **declared assets**, fetched by the host and blob-imported here (the sandbox
 * has `connect-src 'none'` and can't fetch anything itself): `xlsx-stream` is a
 * same-origin sibling path to the host's own module, `xlsx` is the host-vetted SheetJS
 * build. An .xlsx no longer fetches SheetJS at all.
 *
 * ## Sheets, types and missing values
 *
 * Read type handling is the shared rule (`createTypeScan`): a column is numeric only if
 * every non-empty value is a real number — a genuine JS number, not a string that parses
 * as one, so a text cell reading "01234" stays a ZIP code. Date cells are carried as ISO
 * text (the engine's Bridge-A temporal convention). Recurring non-numeric values are
 * offered to the host as candidate missing codes, asked once per file.
 *
 * Multi-sheet workbooks: a single-sheet workbook imports straight through; a multi-sheet
 * workbook prompts with a checklist of sheets (row×col hints, first sheet pre-checked) so
 * summary/codebook sheets can be skipped. Selected sheets are **split into separate
 * datasets** — one per sheet — because workbook sheets are usually heterogeneous (data +
 * codebook + summary), so pooling/row-stacking them would be wrong; joining is a
 * deliberate keyed operation the existing Merge feature owns. The first selected sheet
 * streams through the host ingest as the primary dataset (the codec must emit a schema);
 * each additional sheet is created as its own named dataset via `app.data.create`, which
 * takes columns and so is still built whole. Export writes a single sheet.
 */

/** The host's shared helpers (core/plugin-stdlib.js). */
const { uniqueName, createTypeScan, ingestTable, tableVariableNames } = globalThis.ctStd;

export const manifest = {
  id: 'builtin-excel-codec',
  name: 'Excel codec',
  version: '3', // #91 freshness marker: bumped when .xlsx reading became streaming
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
  // The streaming .xlsx reader is the HOST's (core/xlsx-stream.js), reached as a declared
  // asset: a same-origin sibling path, fetched as text and blob-imported in the sandbox.
  // That is why that module imports nothing — a blob URL has no base to resolve against.
  // SheetJS is still here for .xls/.xlsb, and is no longer fetched at all for an .xlsx.
  assets: [
    { name: 'xlsx-stream', path: '../../core/xlsx-stream.js', kind: 'text' },
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
      catalog: 'catalogXlsx',
      write: 'writeXlsx',
      order: 11, // just after CSV (10)
      multiple: true,
    },
  ],
};


// --- read --------------------------------------------------------------------

/**
 * Decode an Excel workbook.
 *
 * Two readers, chosen by what the file actually is:
 *
 *  - **.xlsx/.xlsm** — the host's streaming reader (`core/xlsx-stream.js`, loaded as a
 *    declared asset). An OOXML workbook is a zip of XML, so the sheet can be inflated
 *    and scanned a chunk at a time. Measured on a Scorecard year converted to .xlsx:
 *    13–20 MiB of live heap for a 54 MiB file, against SheetJS's 2,578 MiB for the same
 *    file and an extrapolated 7.6 GiB for the full one.
 *  - **.xls/.xlsb** — SheetJS. BIFF and the binary sheet parts are not XML and cannot be
 *    scanned this way. They are also the legacy formats, where a file big enough to
 *    matter is rare: .xls caps at 65,536 rows by construction.
 *
 * The streaming path reads the sheet TWICE — once to decide column types, once to emit.
 * The alternative is holding every cell to decide types from, which is the thing being
 * fixed; a second inflate costs CPU, and CPU is not what runs out.
 */
export async function readXlsx(app, { name, plan } = {}) {
  const size = await app.codec.size();
  const bytes = await readAll(app, size);

  const ooxml = await openStreaming(app, bytes);
  if (ooxml) return readStreaming(app, ooxml, name, plan);
  return readWithSheetJs(app, bytes, name, plan);
}

/**
 * The table of contents: one source per sheet, each with its own header row.
 *
 * ## What this replaced, and why it is better than a guess
 *
 * The first version offered the FIRST sheet's header and said so as a known rough edge:
 * the sheet picker came later, inside the read, so a selection made here was matched by
 * name against whatever sheet was then chosen. Pick from sheet 1, import sheet 2, and you
 * got the intersection. Declaring every sheet removes the guess entirely — and it removed
 * this codec's own dialog with it, because the host can now ask "which sheets, and which
 * variables in each" in one go, before the read.
 *
 * Each sheet the user picks from becomes its own dataset. That is the rule this codec has
 * always followed (workbook tabs are usually heterogeneous — data, codebook, summary — so
 * pooling them would be wrong and a keyed join is Merge's job); what is new is that each
 * one can be narrowed.
 *
 * ## Cost
 *
 * It reads the whole file, because an .xlsx is a zip and the central directory is at the
 * end of it. What it does NOT do is scan the sheets: `firstRowOf` stops the inflate at the
 * header row. That early exit had to be added to `core/xlsx-stream.js` for this — without
 * it, listing a five-sheet workbook inflated all five in full, which would make choosing
 * cost more than importing and break the promise the offer makes.
 *
 * .xls/.xlsb have no streaming form at all, so SheetJS parses the workbook. Acceptable
 * because those formats cap at 65,536 rows: the file that would make this expensive
 * cannot exist.
 */
export async function catalogXlsx(app, _info) {
  const size = await app.codec.size();
  const bytes = await readAll(app, size);
  const ooxml = await openStreaming(app, bytes);
  if (!ooxml) return { sources: await sheetJsSources(app, bytes) };

  const sources = [];
  for (const sheet of ooxml.sheets) {
    // eslint-disable-next-line no-await-in-loop -- one header row per sheet, sequential
    const dim = await ooxml.mod.readSheetDimension(sheet.entry);
    // eslint-disable-next-line no-await-in-loop
    const header = await firstRowOf(ooxml, sheet);
    const names = tableVariableNames(padNames(header, dim?.cols ?? header.length));
    if (!names.length) continue; // an empty tab is not a source
    sources.push({
      id: sheet.name,
      label: sheet.name,
      // The count the picker shows beside each heading, which is what tells a data sheet
      // from a codebook at a glance. `readSheetDimension` reads the sheet's own
      // `<dimension>` record, so it costs nothing; -1 when the file omits it.
      //
      // NOT `rows - 1`: its contract already EXCLUDES the header, and subtracting again
      // reported 1 row for a two-row sheet. Caught by the agreement test, which is the
      // kind of off-by-one that otherwise just looks like a slightly wrong label.
      rowCount: dim ? Math.max(0, dim.rows) : -1,
      variables: names.map((nm) => ({ name: nm })),
    });
  }
  return { sources };
}

/** The same, for a legacy workbook: SheetJS, every sheet, first row of each. */
async function sheetJsSources(app, bytes) {
  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const out = [];
  for (const sn of wb.SheetNames || []) {
    const aoa = sheetAoa(XLSX, wb.Sheets[sn]);
    const names = tableVariableNames(padNames(aoa[0] ?? [], aoaWidth(aoa)));
    if (!names.length) continue;
    out.push({
      id: sn,
      label: sn,
      rowCount: Math.max(0, aoa.length - 1),
      variables: names.map((nm) => ({ name: nm })),
    });
  }
  return out;
}

/** The first non-blank row of a sheet, and nothing after it. */
async function firstRowOf(ooxml, sheet) {
  if (!sheet) return [];
  let header = null;
  await ooxml.mod.streamSheetRows(sheet.entry, {
    sharedStrings: ooxml.sharedStrings,
    dateStyles: ooxml.dateStyles,
    onRow: (values) => {
      if (blankRow(values)) return undefined; // leading blanks are not the header
      header = values;
      // `false` STOPS the scan. Without it this inflated the whole sheet to read one row
      // of it — and a five-sheet workbook inflated five sheets in full to list them,
      // which is the opposite of what offering the choice promises.
      return false;
    },
  });
  return header ?? [];
}

/** Same, for a legacy workbook: SheetJS, first sheet, first row. */
async function firstRowWithSheetJs(app, bytes) {
  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const first = (wb.SheetNames || [])[0];
  if (!first) return [];
  const aoa = sheetAoa(XLSX, wb.Sheets[first]);
  return aoa[0] ?? [];
}

/**
 * Open the file with the streaming reader, or return null if it is not a format the
 * reader handles (so the caller falls back to SheetJS).
 *
 * The detection is deliberately structural and cheap — zip magic, a workbook part, and
 * sheet parts that are `.xml` rather than `.bin`. Only that much is guarded: once a file
 * IS an OOXML workbook, a failure reading it is a bug in the reader and must surface as
 * an error, not quietly re-route to the path that needs 7.6 GiB.
 */
async function openStreaming(app, bytes) {
  let mod;
  let wb;
  let sheets;
  try {
    // "PK" — not a zip, so .xls (BIFF/OLE compound).
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
    mod = await importAsset(await app.codec.loadAsset('xlsx-stream'));
    wb = mod.openWorkbook(bytes);
    if (!wb.workbookEntry) return null;
    sheets = await mod.listSheets(wb);
    if (!sheets.length) return null;
    if (sheets.some((s) => !/\.xml$/i.test(s.entry.name))) return null; // .xlsb: binary parts
  } catch {
    return null; // not something this reader recognises
  }
  // Past detection: anything from here is a real failure and is allowed to throw.
  return {
    mod,
    sheets,
    sharedStrings: await mod.readSharedStrings(wb.sharedStringsEntry),
    dateStyles: await mod.readDateStyles(wb.stylesEntry),
  };
}

/** A row with nothing in it. SheetJS's `blankrows: false` drops these, which means a
 * blank row in the middle shifts every row after it — so dropping them is part of the
 * contract, not a tidy-up. */
const blankRow = (v) => !v || v.every((x) => x === null || x === undefined || x === '');

/** Stream one sheet's rows, dropping blank rows and treating the first surviving row as
 * the header. `onRow` therefore gets dense data rows. Returns the header row. */
async function eachDataRow(ooxml, sheet, onRow) {
  let header = null;
  await ooxml.mod.streamSheetRows(sheet.entry, {
    sharedStrings: ooxml.sharedStrings,
    dateStyles: ooxml.dateStyles,
    onRow: (values) => {
      if (blankRow(values)) return undefined;
      if (header === null) { header = values; return undefined; }
      return onRow(values);
    },
  });
  return header ?? [];
}

/** Read an .xlsx by streaming it. */
async function readStreaming(app, ooxml, fileName, plan = null) {
  const names = ooxml.sheets.map((sh) => sh.name);
  const chosen = await sheetsToRead(app, names, plan, fileName);
  const byName = new Map(ooxml.sheets.map((s) => [s.name, s]));
  const primary = byName.get(chosen[0]);
  const selectFor = (sheet) => plan?.sources?.[sheet] ?? null;

  // The primary sheet goes through the shared ingest, which owns the two passes, the
  // typing, the missing-code ask, the naming, the cell-sized batching and the
  // table-vs-out-of-core routing. This reader's part is `eachDataRow`: inflate the sheet
  // part, skip blank rows, take the first non-blank row as the header.
  //
  // What it hands over that a delimited reader does not: a cell is a number only when the
  // reader gave back a real one (EXCEL_NUMERIC), and a Date becomes ISO text rather than
  // whatever `String(date)` says in the current locale (`toText`).
  let headerRow = [];
  const { missingCodes: codes } = await ingestTable(app, {
    select: selectFor(chosen[0]),
    numeric: EXCEL_NUMERIC,
    toText: cellToString,
    // Called after pass 1, with the width the data actually reached. A sheet whose rows
    // run wider than its header keeps those columns; the shared ingest names the blanks.
    header: (w) => padNames(headerRow, w),
    scanRows: async (onRow) => { headerRow = await eachDataRow(ooxml, primary, onRow); },
  });

  // Additional chosen sheets → each its own new dataset (split, not pooled/joined:
  // workbook tabs are usually heterogeneous, so row-stacking them would be wrong).
  //
  // These are built WHOLE in memory, because `app.data.create` takes columns and has no
  // streaming form. A second WIDE sheet in one workbook would still hit the old ceiling;
  // the primary sheet — which is what a data file is — does not. Recorded in TODO.md
  // rather than papered over.
  for (const nm of chosen.slice(1)) {
    const sheet = byName.get(nm);
    if (!sheet) continue;
    if (!app.data || typeof app.data.create !== 'function') {
      throw new Error('Excel: cannot create extra sheet datasets (app.data.create unavailable)');
    }
    // Its OWN selection, not the primary's. "ABC from sheet 1 and DEF from sheet 2" is
    // two datasets, each narrowed to what was ticked under its own heading — which is why
    // the catalogue declares a source per sheet rather than one list of names.
    // eslint-disable-next-line no-await-in-loop -- sequential, to avoid racing the engine.
    const built = await collectSheet(ooxml, sheet, codes, selectFor(nm));
    if (!built.variables.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await app.data.create({ name: nm, variables: built.variables, columns: built.columns, activate: false });
  }
}

/** Variables, storage types and unique names from a header row and a type decision. */
function buildSchema(headerRow, width, decided) {
  const variables = [];
  const storageTypes = {};
  const used = {};
  for (let c = 0; c < width; c++) {
    const h = headerRow[c];
    const base = h === null || h === undefined || String(h).trim() === '' ? `V${c + 1}` : String(h).trim();
    const nm = uniqueName(base, used);
    used[nm] = true;
    const numeric = !!decided.isNumeric[c];
    variables.push({
      name: nm,
      type: numeric ? 'numeric' : 'string',
      measurementLevel: numeric ? 'scale' : 'nominal',
    });
    storageTypes[nm] = numeric ? 'numeric' : 'string';
  }
  return { variables, storageTypes };
}

/** A whole sheet as columns, for the `app.data.create` path (extra sheets). Two passes,
 * same as the primary, but the result is retained rather than emitted. */
async function collectSheet(ooxml, sheet, codes, select = null) {
  const scan = createTypeScan({ numeric: EXCEL_NUMERIC });
  const headerRow = await eachDataRow(ooxml, sheet, (v) => scan.observeRow(v));
  const decided = scan.decide(codes);
  const width = Math.max(headerRow.length, decided.isNumeric.length);
  const schema = buildSchema(headerRow, width, decided);
  // This sheet's own selection, applied to this sheet's own columns.
  const keep = select == null
    ? schema.variables.map((_v, c) => c)
    : schema.variables.map((v, c) => (select.includes(v.name) ? c : -1)).filter((c) => c >= 0);
  if (!keep.length) return { variables: [], storageTypes: {}, columns: {} };

  const raw = keep.map(() => []);
  await eachDataRow(ooxml, sheet, (values) => {
    for (let k = 0; k < keep.length; k++) {
      const cell = values[keep[k]];
      raw[k].push(cell === undefined || cell === '' ? null : cell ?? null);
    }
  });

  const variables = keep.map((c) => schema.variables[c]);
  const storageTypes = {};
  const columns = {};
  for (let k = 0; k < keep.length; k++) {
    const nm = variables[k].name;
    storageTypes[nm] = schema.storageTypes[nm];
    if (storageTypes[nm] === 'numeric') {
      const a = new Float64Array(raw[k].length);
      for (let i = 0; i < a.length; i++) a[i] = decided.isMissing(raw[k][i]) ? NaN : Number(raw[k][i]);
      columns[nm] = a;
    } else {
      columns[nm] = raw[k].map((v) => (decided.isMissing(v) ? null : cellToString(v)));
    }
  }
  return { variables, storageTypes, columns };
}

// --- read: the SheetJS path (.xls, .xlsb) ------------------------------------

/** Read a legacy workbook with SheetJS: parse the whole thing, pivot to columns, emit.
 * Memory is proportional to the cell count — which is why this is no longer the path an
 * .xlsx takes, and is acceptable for the formats that have no other. */
async function readWithSheetJs(app, bytes, name, plan = null) {
  const XLSX = await importAsset(await app.codec.loadAsset('xlsx'));
  // cellDates → date cells become JS Date (carried as ISO text below). Don't parse
  // formulas' cached errors into throws; SheetJS yields them as strings.
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });

  const sheetNames = wb.SheetNames || [];
  if (!sheetNames.length) throw new Error('Excel: the workbook has no sheets');

  const chosen = await sheetsToRead(app, sheetNames, plan, name);
  const selectFor = (sheet) => plan?.sources?.[sheet] ?? null;
  const aoas = chosen.map((sn) => sheetAoa(XLSX, wb.Sheets[sn]));
  // The primary is the first chosen sheet that HAS columns, not simply the first chosen
  // one — an empty tab selected first should not become the dataset. (Preserved
  // deliberately: the old code filtered the empties out before taking `built[0]`.)
  const at = aoas.findIndex((aoa) => aoaWidth(aoa) > 0);
  if (at < 0) throw new Error('Excel: the selected sheet(s) have no columns');

  // Same shared ingest as the streaming path — so this format, which cannot stream and
  // therefore has an array-of-arrays in hand, still gets exactly one typing rule, one
  // missing-code pass and one storage-routing decision. It used to have its own copies of
  // all three, which is how it came to type 211 of a file's 3,379 columns differently
  // from the delimited reader on the same data.
  const primaryAoa = aoas[at];
  const { missingCodes: codes } = await ingestTable(app, {
    select: selectFor(chosen[at]),
    numeric: EXCEL_NUMERIC,
    toText: cellToString,
    header: (w) => padNames(primaryAoa[0] || [], Math.max(w, aoaWidth(primaryAoa))),
    rowCount: Math.max(0, primaryAoa.length - 1),
    scanRows: async (onRow) => {
      for (let r = 1; r < primaryAoa.length; r++) {
        // eslint-disable-next-line no-await-in-loop -- a filled batch stops the walk.
        const wait = onRow(primaryAoa[r] || []);
        if (wait) await wait; // eslint-disable-line no-await-in-loop
      }
    },
  });

  // The other chosen sheets become their own datasets, with the codes the host accepted
  // ONCE for the file: a missing-value code is a convention of the workbook, not of a tab
  // within it.
  for (let i = 0; i < aoas.length; i++) {
    if (i === at) continue;
    const b = {
      sheet: chosen[i],
      ...buildColumns(aoas[i], scanAoa(aoas[i]).decide(codes), selectFor(chosen[i])),
    };
    if (!b.variables.length) continue;
    if (!app.data || typeof app.data.create !== 'function') {
      throw new Error('Excel: cannot create extra sheet datasets (app.data.create unavailable)');
    }
    // eslint-disable-next-line no-await-in-loop -- sequential, to avoid racing the engine.
    await app.data.create({ name: b.sheet, variables: b.variables, columns: b.columns, activate: false });
  }
}

/** A header row padded out to `width`, so columns the header never mentioned still exist.
 * Blank entries are left blank: naming them is the shared ingest's job, in one place. */
function padNames(headerRow, width) {
  const out = (headerRow ?? []).slice();
  while (out.length < width) out.push('');
  return out;
}

/** The widest row in an array-of-arrays, header included. */
function aoaWidth(aoa) {
  return (aoa ?? []).reduce((w, row) => Math.max(w, row ? row.length : 0), 0);
}

/**
 * Which sheets this read covers.
 *
 * ## The dialog that used to live here
 *
 * This codec used to put up its own sheet picker, mid-read, via `app.ui.selectFromList`.
 * Deciding WHETHER to ask and WHAT to show was always right — nothing above a codec can
 * know that a workbook has tabs while a CSV does not. What was wrong was that the host
 * had ALREADY asked which variables to import by then, from a guess at the first sheet's
 * header: two dialogs, two owners, in an order nobody designed, and a selection that
 * could only be matched against whichever sheet was chosen afterwards.
 *
 * `catalogXlsx` now declares a source per sheet, so the host asks both questions at once,
 * before the read, and hands the answer down as `plan`. The decision is still this
 * codec's — it is the catalogue that says there are sheets at all — it is just made in
 * the one place where the user can see every part of the question together.
 *
 * ## The fallback, which is not dead code
 *
 * No plan means nobody asked: the host only consults a catalogue when its importer
 * declares one AND there is something to decide, and a read can also be driven by a
 * caller that has no picker at all (the test harness, a replayed script). The first sheet
 * is the right default for the same reason it was pre-ticked in the old dialog — in a
 * workbook used as a data file, sheet 1 is the data and the rest is a codebook.
 *
 * @param {object} app
 * @param {string[]} names - every sheet in the workbook, in order
 * @param {?{sources: Object<string, ?string[]>}} plan - what the host was told to import
 * @param {string} fileName
 * @returns {Promise<string[]>} the sheets to read, primary first
 */
async function sheetsToRead(app, names, plan, fileName) {
  const picked = Object.keys(plan?.sources ?? {}).filter((id) => names.includes(id));
  if (picked.length) {
    // The workbook's own order, not the order the dialog happened to return them in: the
    // first sheet of the FILE is the primary if it was picked, which keeps "the data sheet
    // becomes the dataset" true however the user ticked the boxes.
    return names.filter((n) => picked.includes(n));
  }
  if (!names.length) throw new Error('Excel: the workbook has no sheets');
  if (names.length > 1) {
    // Nobody asked and there is more than one. Say which one was used rather than picking
    // silently — a workbook whose data is on tab 2 would otherwise import its codebook
    // with no indication that a choice was made on the user's behalf.
    app.results?.appendText?.(
      `${fileName} has ${names.length} sheets; imported “${names[0]}”. `
      + 'Use File ▸ Import data… with “Choose which variables to import” to pick others.',
    );
  }
  return [names[0]];
}

/** Header:1 array-of-arrays for a worksheet: raw JS types (numbers as numbers,
 * Dates as Dates); defval:null fills gaps; blankrows:false drops fully-empty rows. */
function sheetAoa(XLSX, ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
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
 * arrays (null for missing). The SheetJS path only — the streaming path never builds
 * an array-of-arrays in the first place. */
function buildColumns(aoa, decision = null, select = null) {
  if (!aoa.length) return { variables: [], storageTypes: {}, columns: {} };

  const headerRow = aoa[0] || [];
  const width = aoa.reduce((w, row) => Math.max(w, row ? row.length : 0), 0);
  const decided = decision ?? scanAoa(aoa).decide([]);
  const schema = buildSchema(headerRow, width, decided);
  // This sheet's own selection, applied to this sheet's own columns.
  const keep = select == null
    ? schema.variables.map((_v, c) => c)
    : schema.variables.map((v, c) => (select.includes(v.name) ? c : -1)).filter((c) => c >= 0);
  if (!keep.length) return { variables: [], storageTypes: {}, columns: {} };

  const variables = keep.map((c) => schema.variables[c]);
  const storageTypes = {};
  const columns = {};
  for (const c of keep) {
    const nm = schema.variables[c].name;
    const isNum = schema.storageTypes[nm] === 'numeric';
    storageTypes[nm] = schema.storageTypes[nm];
    const out = isNum ? new Float64Array(Math.max(0, aoa.length - 1)) : [];
    for (let r = 1; r < aoa.length; r++) {
      const cell = (aoa[r] || [])[c];
      const v = cell === undefined || cell === '' ? null : cell ?? null;
      if (isNum) out[r - 1] = decided.isMissing(v) ? NaN : Number(v);
      else out.push(decided.isMissing(v) ? null : cellToString(v));
    }
    columns[nm] = out;
  }
  return { variables, storageTypes, columns };
}

/** A spreadsheet cell is a number only when the reader handed back a real one. A text
 * cell reading "01234" is a ZIP code, and parsing it would drop the leading zero — which
 * is why this rule differs from the CSV reader's and is passed in rather than assumed. */
const EXCEL_NUMERIC = (v) => typeof v === 'number' && Number.isFinite(v);

/** Run the shared type scan over an array-of-arrays (row 0 is the header). */
function scanAoa(aoa) {
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
