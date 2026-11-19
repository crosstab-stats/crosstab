/**
 * @file xlsx-streaming.test.mjs
 * Reading an .xlsx a chunk at a time, instead of holding four copies of it.
 *
 * ## What happened
 *
 * The Excel codec read a workbook with SheetJS, which materialises every cell as an
 * object; the codec then built an array-of-arrays from that and pivoted THAT into
 * columns. Bytes, workbook, AoA and columns, all alive together. Measured on a College
 * Scorecard year converted to .xlsx (3,379 × 6,272): 735 MiB at 500 rows, 1,322 at
 * 1,000, 2,578 at 2,000 — linear at ~1.23 MiB/row, so the real file wanted about
 * **7.6 GiB** against a renderer cap near 4.
 *
 * An .xlsx is a zip of XML, so it can be read a chunk at a time, and now is
 * (`core/xlsx-stream.js`). Same file, measured under a hard heap cap: 13–20 MiB of live
 * heap, and it completes inside a 160 MiB cap. The alternative on the table was an
 * asterisk on the format picker reading "Excel: small files only", which the owner
 * declined — *"Lack of parity isn't defensible for me when we have a path to parity."*
 *
 * ## What these tests are about
 *
 * Correctness, not memory: the reader has to agree with SheetJS cell for cell, because
 * anything it does differently is a silent behaviour change for a file that imports fine
 * today. Equivalence against the real SheetJS was measured out-of-tree (this suite has no
 * network, and SheetJS is a CDN dependency); what is pinned here is OUR half, against
 * workbooks built by hand in the OOXML the reader claims to read.
 *
 * The workbooks are built as real zips — one entry genuinely DEFLATEd, so
 * `DecompressionStream` and the chunk-boundary carry are exercised rather than assumed.
 * Nothing here imports SheetJS or any other library.
 *
 * The cases that matter and were all wrong at some point while writing it: a blank row
 * in the middle (SheetJS's `blankrows: false` DROPS it, which shifts every row after it),
 * a sparse row (cells carry their own column reference, so a gap is not a shift), the
 * shared-string table, dates (a number plus a style that says "date" — indistinguishable
 * from a plain number without the style table), and a row that straddles a chunk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  openWorkbook, listSheets, readSharedStrings, readDateStyles, streamSheetRows,
  readSheetDimension, colFromRef, isDateFormatCode, serialToDate, zipDirectory, streamZipEntry,
} from '../core/xlsx-stream.js';
import { zip, workbook, WORKBOOK_XML, RELS_XML, sheetXml } from './xlsx-fixture.mjs';

/** Every data row of a sheet, dense, blank rows dropped — what the codec sees. */
async function rowsOf(bytes, which = 0) {
  const wb = openWorkbook(bytes);
  const sheets = await listSheets(wb);
  const shared = await readSharedStrings(wb.sharedStringsEntry);
  const styles = await readDateStyles(wb.stylesEntry);
  const out = [];
  await streamSheetRows(sheets[which].entry, {
    sharedStrings: shared,
    dateStyles: styles,
    onRow: (values) => { out.push(values); },
  });
  return out;
}

// =============================================================================
// The zip half
// =============================================================================

test('the central directory is read without inflating anything', async () => {
  const bytes = workbook({ sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>' });
  const names = zipDirectory(bytes).map((e) => e.name);
  assert.deepEqual(names, [
    'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
  ]);
});

test('a DEFLATEd entry inflates in chunks, and a STORED one passes straight through', async () => {
  const text = 'x'.repeat(5000);
  for (const deflate of [true, false]) {
    const bytes = zip([{ name: 'a.txt', data: text, deflate }]);
    const entry = zipDirectory(bytes)[0];
    assert.equal(entry.method, deflate ? 8 : 0);
    let got = '';
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of streamZipEntry(entry)) got += new TextDecoder().decode(chunk);
    assert.equal(got, text, `method ${entry.method} round-trips`);
  }
});

test('a non-zip is rejected rather than misread', () => {
  // The first bytes of a real .xls (an OLE compound file). The codec checks the magic
  // before this is ever reached, but a reader that silently produced garbage for a
  // format it cannot read would be worse than one that throws.
  const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  assert.throws(() => zipDirectory(xls), /not a zip/i);
});

// =============================================================================
// Sheets, names and order
// =============================================================================

test('sheets come back in WORKBOOK order, joined through the rels', async () => {
  // Deliberately: the directory lists sheet1 before sheet2, and the rels agree — but the
  // join is what makes that reliable. Guessing "sheet1.xml is the first tab" is wrong
  // often enough to matter, so the names must come from workbook.xml.
  const wb = openWorkbook(workbook({ sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>' }));
  const sheets = await listSheets(wb);
  assert.deepEqual(sheets.map((s) => s.name), ['Data', 'Codebook']);
  assert.equal(sheets[0].entry.name, 'xl/worksheets/sheet1.xml');
});

test('the dimension is read without inflating the sheet', async () => {
  const wb = openWorkbook(workbook({ sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>', dim1: 'A1:DYY6273' }));
  const sheets = await listSheets(wb);
  const dim = await readSheetDimension(sheets[0].entry);
  // The shape of the file this was written for: 6,273 spreadsheet rows is 6,272 data
  // rows, and column DYY is the 3,379th.
  assert.deepEqual(dim, { rows: 6272, cols: 3379 });
});

test('a sheet with no declared dimension says so instead of guessing', async () => {
  const bytes = zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', deflate: true,
      data: '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml('A1:A1', ''), deflate: true },
  ]);
  const sheets = await listSheets(openWorkbook(bytes));
  assert.equal(await readSheetDimension(sheets[0].entry), null);
});

// =============================================================================
// Cell values
// =============================================================================

test('numbers, shared strings, inline strings, booleans and formula results', async () => {
  const rows = await rowsOf(workbook({
    sheet1:
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
      '<c r="C1" t="inlineStr"><is><t>head C</t></is></c><c r="D1" t="s"><v>2</v></c>' +
      '<c r="E1" t="s"><v>3</v></c></row>' +
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>-2.5</v></c>' +
      '<c r="C2" t="b"><v>1</v></c><c r="D2" t="str"><v>cached</v></c>' +
      '<c r="E2" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="3"><c r="A3"><v>2</v></c><c r="B3"><v>0</v></c>' +
      '<c r="C3" t="b"><v>0</v></c><c r="D3" t="inlineStr"><is><t>a&lt;b</t></is></c>' +
      '<c r="E3"/></row>',
  }));

  assert.deepEqual(rows[0], ['alpha', 'naïve & co', 'head C', 'rich text', ''],
    'rich text concatenates its runs; an empty <si/> is the empty string',
  );
  // The reader reports what the cell says and leaves policy to the caller: it is the
  // CODEC that maps '' to missing, which is also what the SheetJS path did via
  // `defval: null`. Asserted here so a change to either half shows up as a failure.
  assert.equal(rows[0][4], '');
  assert.deepEqual(rows[1], [1, -2.5, true, 'cached', '#DIV/0!']);
  assert.deepEqual(rows[2], [2, 0, false, 'a<b', null],
    'false is a value, 0 is a value, and a self-closing cell is missing',
  );
});

test('a date is a number PLUS a style that says so', async () => {
  const rows = await rowsOf(workbook({
    sheet1:
      '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>' +
      // Same serial four times: no style, built-in date style, custom date style,
      // and a custom format whose only letters are inside a quoted literal.
      '<row r="2"><c r="A2"><v>45305</v></c><c r="B2" s="1"><v>45305</v></c>' +
      '<c r="C2" s="2"><v>45305</v></c><c r="D2" s="3"><v>45305</v></c></row>',
  }));
  const [plain, builtin, custom, money] = rows[1];
  assert.equal(plain, 45305, 'without a style it is just a number');
  assert.ok(builtin instanceof Date, 'numFmtId 14 is a built-in date format');
  assert.ok(custom instanceof Date, 'a custom yyyy-mm-dd is a date format');
  assert.equal(money, 45305, 'a literal "day " in a money format must not make it a date');
  assert.equal(builtin.toISOString().slice(0, 10), '2024-01-14');
  assert.equal(custom.getTime(), builtin.getTime());
});

test('the serial epoch is the one SheetJS uses, 1899-12-30 flat', () => {
  assert.equal(serialToDate(45305).toISOString().slice(0, 10), '2024-01-14');
  assert.equal(serialToDate(61).toISOString().slice(0, 10), '1900-03-01');
  // Serials below 61 are a day behind what Excel DISPLAYS, because Excel's calendar
  // contains 1900-02-29, a day that did not exist (inherited from Lotus 1-2-3). A flat
  // epoch is nevertheless correct here, because it is what the codec already did:
  // measured against the real SheetJS, serial 1 reads back as 1899-12-31 there too, so
  // "correcting" this would move every pre-March-1900 date in files that import fine
  // today. Dates in January 1900 are not what a data file holds; a silent one-day shift
  // in a column that works is a real regression.
  assert.equal(serialToDate(1).toISOString().slice(0, 10), '1899-12-31');
  assert.equal(serialToDate(60).toISOString().slice(0, 10), '1900-02-28');
});
test('a format code is a date only if it has date letters OUTSIDE its literals', () => {
  for (const code of ['yyyy-mm-dd', 'd/m/yy', 'hh:mm:ss', 'mmm yyyy']) {
    assert.equal(isDateFormatCode(code), true, code);
  }
  for (const code of ['0.00', '#,##0', '"day "#,##0.00', '0.0%', '', null, '[Red]0.00']) {
    assert.equal(isDateFormatCode(code), false, JSON.stringify(code));
  }
});

// =============================================================================
// Row shape: the part that silently changes a file's meaning
// =============================================================================

test('a SPARSE row keeps its columns — a gap is not a shift', async () => {
  const rows = await rowsOf(workbook({
    sheet1:
      '<row r="1"><c r="A1"><v>1</v></c><c r="E1"><v>5</v></c></row>' +
      // Only A and E are present; B, C and D must come back missing, not shifted left.
      '<row r="2"><c r="A2"><v>9</v></c><c r="E2"><v>99</v></c></row>',
  }));
  // Holes, not shifts: index 4 holds 99 whether or not B/C/D were ever written. (The
  // array is sparse, so read each index rather than comparing arrays — a hole and an
  // explicit undefined are the same thing to the codec and different to deepEqual.)
  assert.equal(rows[1].length, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => rows[1][i] ?? null), [9, null, null, null, 99]);
  assert.equal(colFromRef('E2'), 4);
  assert.equal(colFromRef('DYY1'), 3378, 'three letters: the 3,379th column of the real file');
});

test('rows ABSENT from the XML are absent from the output, not blank-filled', async () => {
  // Excel omits a row with nothing in it. SheetJS's `blankrows: false` then drops it from
  // the array too, which means every row after it shifts up — so the reader must deliver
  // what is there and let the caller drop blanks, which is what the codec does.
  const rows = await rowsOf(workbook({
    sheet1:
      '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>1</v></c></row>' +
      '<row r="5"><c r="A5"><v>2</v></c></row>',
  }));
  assert.equal(rows.length, 3, 'rows 3 and 4 do not exist and are not invented');
  assert.deepEqual(rows.map((r) => r[0]), ['h', 1, 2]);
});

test('an EMPTY row present in the XML comes through as an empty row', async () => {
  const rows = await rowsOf(workbook({
    sheet1:
      '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>' +
      '<row r="2"/>' +
      '<row r="3"><c r="A3"/><c r="B3"/></row>' +
      '<row r="4"><c r="A4"><v>7</v></c></row>',
  }));
  // Both forms reach the caller; it is the CODEC that drops them, to match SheetJS.
  assert.equal(rows.length, 4);
  const blank = (v) => !v || v.every((x) => x === null || x === undefined || x === '');
  assert.deepEqual(rows.map(blank), [false, true, true, false]);
});

test('a row straddling a chunk boundary is not split in half', async () => {
  // The inflate hands over chunks at boundaries nobody chose; a row, a tag, or a
  // multi-byte character can land across one. 4,000 columns of varying width makes
  // several such boundaries inevitable, and every value must still arrive intact.
  const n = 4000;
  let header = '<row r="1">';
  let data = '<row r="2">';
  const letter = (i) => {
    let s = '';
    for (let x = i + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
    return s;
  };
  for (let i = 0; i < n; i++) {
    header += `<c r="${letter(i)}1" t="inlineStr"><is><t>名前${i}</t></is></c>`;
    data += `<c r="${letter(i)}2"><v>${i * 1.5}</v></c>`;
  }
  const rows = await rowsOf(workbook({ sheet1: `${header}</row>${data}</row>`, dim1: `A1:A${n}` }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, n);
  assert.equal(rows[0][0], '名前0');
  assert.equal(rows[0][n - 1], `名前${n - 1}`, 'the last header survived every boundary');
  assert.equal(rows[1][n - 1], (n - 1) * 1.5);
  // And a multi-byte character really did straddle one: the sheet is far larger than a
  // single inflate chunk.
  assert.ok(rows[0].every((v, i) => v === `名前${i}`));
});

test('reading holds the SHEET, not the file: a wide sheet streams in bounded heap', async () => {
  // Not a memory measurement — `process.memoryUsage()` in a test would be flaky. What
  // this pins is the structural property the measurement depends on: the reader never
  // accumulates, so the caller's retained set is the only thing that grows. If a future
  // edit reintroduces a `pending` array (the first version of this module had one, and
  // it cost 788 MiB on a 2,000-row sheet), `seen` would stop being 1 here.
  let rows = 0;
  let maxHeldByReader = 0;
  const bytes = workbook({
    sheet1: Array.from({ length: 300 }, (_, r) =>
      `<row r="${r + 1}">${Array.from({ length: 40 }, (_, c) => `<c r="${String.fromCharCode(65 + (c % 26))}${r + 1}"><v>${r * c}</v></c>`).join('')}</row>`).join(''),
  });
  const wb = openWorkbook(bytes);
  const sheets = await listSheets(wb);
  const live = new Set();
  await streamSheetRows(sheets[0].entry, {
    sharedStrings: [],
    dateStyles: [],
    onRow: async (values) => {
      rows += 1;
      live.add(values);
      maxHeldByReader = Math.max(maxHeldByReader, live.size);
      await Promise.resolve(); // an async consumer, which is what the codec is
      live.delete(values);
    },
  });
  assert.equal(rows, 300);
  assert.equal(maxHeldByReader, 1,
    'the reader delivers each row and waits — it does not read ahead into an array',
  );
});
