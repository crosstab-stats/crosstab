/**
 * @file missing-codes-recorded.test.mjs
 * The missing-value codes an import applied, carried all the way to the exported script.
 *
 * ## The gap this closes, which is NOT the one I first claimed
 *
 * I thought an exported script would re-run the import and prompt for the codes again.
 * It does not: `# use "file" via importer` is a COMMENT, `parse()` strips it, and nothing
 * in CrossTab ever re-executes an import from text — op-log replay restores the stored
 * Parquet instead. So there was no re-prompt to fix.
 *
 * The real gap is fidelity in the Stata/SPSS/R export. That one DOES emit a runnable open
 * command, and without the codes it opens the file differently than CrossTab did:
 * `read.csv` leaves "PS" as text, so the 3,347 columns CrossTab typed as numeric come
 * back as character and every analysis below them runs on different data. The rule that
 * export is written to is "emit only what the matching importer can read back", and the
 * import line was quietly breaking it.
 *
 * ## Why the codes ride in the comment line
 *
 * Because the script exporter re-parses the syntax TEXT and has no second channel — the
 * same reason `via <importer>` is in there. So the chain is: op.src.missingCodes →
 * `# use … missing "NA", "PS"` → the exporter's regex → the dialect's own idiom.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { serialize } = await import('../core/crosstab-syntax.js');
const { openCommand } = await import('../core/script-export.js');

/** A load op as the import records one. */
const loadOp = (extra = {}) => ({
  type: 'load',
  src: {
    table: 'src_1',
    origin: 'MERGED2025_26_PP.csv',
    importer: 'builtin-csv-codec',
    meta: [{ name: 'UNITID', type: 'numeric' }],
    ...extra,
  },
});

// =============================================================================
// The line
// =============================================================================

test('the codes are written into the use line', () => {
  const text = serialize([loadOp({ missingCodes: ['NA', 'PS'] })]);
  assert.match(text, /# use "MERGED2025_26_PP\.csv" via builtin-csv-codec missing "NA", "PS"/);
});

test('an import with no codes is unchanged', () => {
  // The overwhelmingly common case must not grow a trailing clause.
  const text = serialize([loadOp({ missingCodes: [] })]);
  assert.match(text, /# use "MERGED2025_26_PP\.csv" via builtin-csv-codec$/m);
  assert.doesNotMatch(text, /missing/);
});

test('a code containing a quote survives the round trip into the exporter', () => {
  const text = serialize([loadOp({ missingCodes: ['sa"id', 'N/A'] })]);
  // Whatever the quoting, the exporter must recover the ORIGINAL strings — it re-parses
  // this text and there is nowhere else for them to come from.
  const m = /# use "[^"]*" via [\w.-]+ missing (.+)$/m.exec(text);
  assert.ok(m, `no missing clause in: ${text}`);
  const recovered = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, '$1'));
  assert.deepEqual(recovered, ['sa"id', 'N/A']);
});

// =============================================================================
// What each dialect does with them
// =============================================================================

test('R gets na.strings, which is exactly the concept', () => {
  const r = openCommand('r', 'f.csv', 'builtin-csv-codec', ['NA', 'PS']);
  assert.equal(r.line, 'd <- read.csv("f.csv", stringsAsFactors = FALSE, na.strings = c("NA", "PS"))');
});

test('readxl spells it `na`, not `na.strings`', () => {
  const r = openCommand('r', 'f.xlsx', 'builtin-excel-codec', ['NA']);
  assert.match(r.line, /readxl::read_excel\("f\.xlsx", na = c\("NA"\)\)/);
});

test('Stata has no option, so the codes are undone afterwards', () => {
  const st = openCommand('stata', 'f.csv', 'builtin-csv-codec', ['NA', 'PS']);
  const lines = st.line.split('\n');
  assert.equal(lines[0], 'import delimited "f.csv", clear');
  assert.match(st.line, /ds, has\(type string\)/);
  assert.match(st.line, /inlist\(`v', "NA", "PS"\)/);
  assert.match(st.line, /destring, replace/);
});

test('a typed format is left alone — it carries its own missing values', () => {
  // Codes only ever arise where the format has none. Adding an argument to read_sav
  // would be noise at best and wrong at worst.
  const sav = openCommand('r', 'f.sav', 'builtin-readstat-codec', ['NA', 'PS']);
  assert.match(sav.line, /haven::read_sav\("f\.sav"\)$/);
  const dta = openCommand('stata', 'f.dta', 'builtin-readstat-codec', ['NA']);
  assert.equal(dta.line, 'use "f.dta", clear');
});

test('no codes means the command is byte-identical to before', () => {
  for (const codes of [null, [], undefined]) {
    assert.equal(
      openCommand('r', 'f.csv', 'builtin-csv-codec', codes).line,
      'd <- read.csv("f.csv", stringsAsFactors = FALSE)',
    );
    assert.equal(
      openCommand('stata', 'f.csv', 'builtin-csv-codec', codes).line,
      'import delimited "f.csv", clear',
    );
  }
});

test('junk in the recorded codes cannot reach the script', () => {
  const r = openCommand('r', 'f.csv', 'builtin-csv-codec', ['NA', '', null, 7, 'PS']);
  assert.equal(r.line, 'd <- read.csv("f.csv", stringsAsFactors = FALSE, na.strings = c("NA", "PS"))');
});

test('a quote in a code is escaped for each dialect', () => {
  const r = openCommand('r', 'f.csv', 'builtin-csv-codec', ['sa"id']);
  assert.match(r.line, /na\.strings = c\("sa\\"id"\)/, 'R escapes with a backslash');
  const st = openCommand('stata', 'f.csv', 'builtin-csv-codec', ['sa"id']);
  assert.match(st.line, /inlist\(`v', "sa""id"\)/, 'Stata doubles the quote');
});
