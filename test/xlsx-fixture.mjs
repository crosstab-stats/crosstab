/**
 * @file xlsx-fixture.mjs
 * An .xlsx, built by hand.
 *
 * The streaming reader and the Excel codec both have to be tested against real OOXML, and
 * the suite has no network — SheetJS is a pinned CDN dependency, so it cannot be the thing
 * that produces the test files. So they are assembled here: a real zip (one entry
 * genuinely DEFLATEd, via Node's zlib, so `DecompressionStream` and the chunk-boundary
 * carry are exercised rather than assumed) holding the parts a workbook actually has.
 *
 * Nothing here imports SheetJS or any other library. Equivalence with the real SheetJS was
 * measured out-of-tree, cell for cell; what the suite pins is our half.
 *
 * Not a test file — it defines no tests.
 */
import { deflateRawSync, crc32 } from 'node:zlib';

const enc = (s) => new TextEncoder().encode(s);

/** A real zip. `deflate` picks method 8 (so the inflate path runs) over method 0. */
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc(f.name);
    const plain = typeof f.data === 'string' ? enc(f.data) : f.data;
    const body = f.deflate ? new Uint8Array(deflateRawSync(plain)) : plain;
    const method = f.deflate ? 8 : 0;
    const sum = crc32(Buffer.from(plain));

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, plain.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    parts.push(lh, body);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, plain.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += lh.length + body.length;
  }
  const cdBytes = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdBytes, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

export const WORKBOOK_XML =
  '<?xml version="1.0"?><workbook xmlns:r="x"><sheets>' +
  '<sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Codebook" sheetId="2" r:id="rId2"/>' +
  '</sheets></workbook>';

export const RELS_XML =
  '<?xml version="1.0"?><Relationships>' +
  '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
  '</Relationships>';

/** numFmtId 14 is a built-in date; 164 is a custom one. Style 0 is General. */
export const STYLES_XML =
  '<?xml version="1.0"?><styleSheet>' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/>' +
  '<numFmt numFmtId="165" formatCode="&quot;day &quot;#,##0.00"/></numFmts>' +
  '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/>' +
  '<xf numFmtId="165"/></cellXfs></styleSheet>';

export const SHARED_XML =
  '<?xml version="1.0"?><sst count="4" uniqueCount="4">' +
  '<si><t>alpha</t></si>' +
  '<si><t>na&#239;ve &amp; co</t></si>' +
  '<si><r><t>rich </t></r><r><t>text</t></r></si>' +
  '<si/>' +
  '</sst>';

/** Build a sheet part from `<row>` XML. */
export const sheetXml = (dim, rows) =>
  `<?xml version="1.0"?><worksheet><dimension ref="${dim}"/><sheetData>${rows}</sheetData></worksheet>`;

/** Assemble a whole workbook; `sheet1`/`sheet2` are `<row>` XML strings. */
export function workbook({ sheet1, sheet2 = '<row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row>',
  dim1 = 'A1:E9', dim2 = 'A1:A1', shared = SHARED_XML, deflate = true } = {}) {
  return zip([
    { name: 'xl/workbook.xml', data: WORKBOOK_XML, deflate },
    { name: 'xl/_rels/workbook.xml.rels', data: RELS_XML, deflate },
    { name: 'xl/styles.xml', data: STYLES_XML, deflate },
    { name: 'xl/sharedStrings.xml', data: shared, deflate },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(dim1, sheet1), deflate },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml(dim2, sheet2), deflate },
  ]);
}

