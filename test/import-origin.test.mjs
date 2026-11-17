/**
 * @file import-origin.test.mjs
 * The file an import read, recorded on the op and carried to everything that describes it.
 *
 * ## The bug
 *
 * `src.label` was doing two jobs. It is the value of the `source_file` provenance COLUMN,
 * so the importers deliberately leave it undefined on the commonest import of all — one
 * file replacing the dataset — because a constant column repeating one filename on every
 * row is noise. The side effect was that the import everybody does recorded no filename
 * anywhere: History and Syntax fell through to `src.table`, the internal DuckDB name, and
 * showed `# use "src_1"`. The exported R script, meanwhile, opened with
 * `read.csv("your-data.csv")` and a comment telling you to go and point it at your data.
 *
 * *"this doesn't help reproducing things all that much if the person looking at the syntax
 * doesn't know what file to load"* — owner, 2026-11-17.
 *
 * ## The fix, and its one honest limit
 *
 * `origin` is separate from `label`: metadata about the op, never a column. A browser
 * hands a File its basename and nothing else — no API yields the full path from a file
 * input or a drop — so this is a NAME, not a path, and every surface that prints it says
 * so rather than implying the script will find the file from anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { serialize, timeline } = await import('../core/crosstab-syntax.js');
const { scriptToR, scriptToStata, scriptToSpss, openCommand } = await import('../core/script-export.js');

const loadOp = (src) => [{ id: 's1', type: 'load', src: { table: 'src_1', meta: [], ...src } }];

// =============================================================================
// What the syntax line says
// =============================================================================

test('a source line names the file it read', () => {
  assert.match(serialize(loadOp({ origin: 'GSS-2022.sav', label: null })), /# use "GSS-2022\.sav"/);
});

test('without an origin it still falls back, rather than printing nothing', () => {
  // Data that never came from a file — a plugin's data.create, a derived dataset — has
  // no filename to give, and the internal table name is the only handle that exists.
  assert.match(serialize(loadOp({ origin: null, label: null })), /# use "src_1"/);
  // A label (the provenance column's value) still beats the table name.
  assert.match(serialize(loadOp({ origin: null, label: 'wave2' })), /# use "wave2"/);
  // ...and the origin beats the label, because the label is a column value and the
  // origin is the answer to "what do I open?".
  assert.match(serialize(loadOp({ origin: 'wave2.csv', label: 'wave2' })), /# use "wave2\.csv"/);
});

test('the source row stays read-only, so the round-trip is unaffected', () => {
  // The line is a comment; Run never parses it back. That is what makes it safe to
  // change its text at all.
  const [row] = timeline(loadOp({ origin: 'GSS-2022.sav' }));
  assert.equal(row.kind, 'source');
  assert.equal(row.editable, false);
});

// =============================================================================
// The reader chosen for a file
// =============================================================================

test('the reader follows the extension, in every dialect', () => {
  assert.match(openCommand('r', 'survey.csv').line, /^d <- read\.csv\("survey\.csv"/);
  assert.match(openCommand('r', 'GSS.sav').line, /haven::read_sav\("GSS\.sav"\)/);
  assert.match(openCommand('r', 'panel.dta').line, /haven::read_dta/);
  assert.match(openCommand('r', 'book.xlsx').line, /readxl::read_excel/);
  assert.match(openCommand('r', 'big.parquet').line, /arrow::read_parquet/);
  assert.match(openCommand('stata', 'panel.dta').line, /^use "panel\.dta", clear$/);
  assert.match(openCommand('stata', 'survey.csv').line, /^import delimited/);
  assert.match(openCommand('spss', 'GSS.sav').line, /^GET FILE='GSS\.sav'\.$/);
});

test('a package-needing reader says which package', () => {
  assert.match(openCommand('r', 'GSS.sav').note, /haven/);
  assert.match(openCommand('r', 'big.parquet').note, /arrow/);
  assert.equal(openCommand('r', 'survey.csv').note, undefined);
});

test('an unopenable format declines rather than guessing', () => {
  // read.csv on a .sav yields a one-column frame of binary mush, silently — the worst
  // kind of wrong, because it runs.
  assert.equal(openCommand('r', 'mystery.qqq'), null);
  // Stata needs a plug-in for .sav, and naming a command that may not be installed is
  // worse than the instruction comment the caller falls back to.
  assert.equal(openCommand('stata', 'GSS.sav'), null);
  // SPSS's GET DATA for a delimited file needs the full variable list to be right, and a
  // wrong one silently mistypes every column.
  assert.equal(openCommand('spss', 'survey.csv'), null);
  assert.equal(openCommand('r', null), null);
  assert.equal(openCommand('r', ''), null);
});

test('a quote in a filename cannot break out of the generated string', () => {
  const line = openCommand('r', 'odd"name.csv').line;
  assert.ok(line.includes('odd\\"name.csv'), line);
  assert.ok(openCommand('spss', "o'hara.sav").line.includes("o''hara.sav"));
});

// =============================================================================
// The exported script
// =============================================================================

const rOf = (syntax) => scriptToR(syntax).text;

test('the R script opens the file the analysis was built from', () => {
  const out = rOf('# use "GSS-2022.sav"\nkeep if age > 18');
  assert.match(out, /d <- haven::read_sav\("GSS-2022\.sav"\)/);
  // The placeholder it replaces is gone, along with the instruction to fix it.
  assert.ok(!out.includes('your-data.csv'));
  assert.ok(!out.includes('point this at it'));
  // The package it needs is named where it is needed.
  assert.match(out, /install\.packages\("haven"\)/);
});

test('the header says what the file does about its data — three cases, three sentences', () => {
  assert.match(rOf('# use "survey.csv"\nkeep if age > 18'),
    /Opens survey\.csv itself — run it from that file's folder/);
  // Named but not openable: still better than nothing, because you know what to open.
  assert.match(rOf('# use "weird.qqq"\nkeep if age > 18'),
    /The data is NOT in this file: open weird\.qqq first/);
  // Nothing recorded at all — the old placeholder and the old instruction.
  const bare = rOf('keep if age > 18');
  assert.match(bare, /Edit the read\.csv\(\) path/);
  assert.match(bare, /your-data\.csv/);
});

test('R does not also tell you to open a file it just opened', () => {
  // The anchor comment ("open it before running this") sat under the read line and
  // contradicted it.
  const out = rOf('# use "survey.csv"\nkeep if age > 18');
  assert.ok(!out.includes('open it before running this'));
  // It is kept where it is still true: an unopenable format.
  assert.ok(rOf('# use "weird.qqq"\nkeep if age > 18').includes('open it before running this'));
});

test('Stata and SPSS open their own native formats, and say so', () => {
  const stata = scriptToStata('# use "panel.dta"\nkeep if age > 18').text;
  assert.match(stata, /^use "panel\.dta", clear$/m);
  assert.match(stata, /Opens panel\.dta itself/);

  const spss = scriptToSpss('# use "GSS.sav"\nkeep if age > 18').text;
  assert.match(spss, /^GET FILE='GSS\.sav'\.$/m);
  assert.match(spss, /Opens GSS\.sav itself/);

  // A format the dialect cannot open natively keeps the instruction, and the header
  // keeps agreeing with it.
  const mismatch = scriptToStata('# use "GSS.sav"\nkeep if age > 18').text;
  assert.ok(!mismatch.includes('use "GSS.sav", clear'));
  assert.match(mismatch, /open GSS\.sav first/);
});

test('only the FIRST source opens the script; an append stays an instruction', () => {
  // A second file has to be merged with the first, and that is not a step this
  // translator can honestly write — so it is named, not executed.
  const out = rOf('# use "wave1.csv"\n# append "wave2.csv"\nkeep if age > 18');
  assert.equal((out.match(/read\.csv\(/g) || []).length, 1);
  assert.match(out, /read\.csv\("wave1\.csv"/);
  assert.match(out, /append.*wave2\.csv.*open it before running this/);
});

// =============================================================================
// The importer, which is better evidence than the name
// =============================================================================

test('the syntax line says which reader parsed the file', () => {
  const op = (src) => [{ id: 's1', type: 'load', src: { table: 'src_1', meta: [], ...src } }];
  assert.match(serialize(op({ origin: 'survey.txt', importer: 'csv' })), /# use "survey\.txt" via csv/);
  // Unknown importer: the clause is absent rather than empty or "null".
  assert.match(serialize(op({ origin: 'x.csv', importer: null })), /# use "x\.csv"\n/);
});

test('the importer beats the extension where it knows better', () => {
  // THE case this exists for. A .txt opened by the CSV codec IS comma-delimited — that
  // is what the codec did to the bytes, not an inference about the name — and the
  // extension alone cannot resolve it at all.
  assert.equal(openCommand('r', 'survey.txt'), null);
  assert.match(openCommand('r', 'survey.txt', 'csv').line, /^d <- read\.csv\("survey\.txt"/);
  // ...and the codec's own rule is tab for .tsv, comma for everything else, so the
  // extension still refines WITHIN the importer.
  assert.match(openCommand('r', 'data.tsv', 'csv').line, /read\.delim/);
});

test('an importer that spans formats still reads the extension — and it is proven', () => {
  // `readstat` covers six formats across three R packages, so its id alone cannot pick
  // a reader. But it dispatches on the suffix itself and refuses anything it does not
  // recognise, so for a file it ACCEPTED the extension is not a guess.
  assert.match(openCommand('r', 'GSS.sav', 'readstat').line, /haven::read_sav/);
  assert.match(openCommand('r', 'panel.dta', 'readstat').line, /haven::read_dta/);
  assert.match(openCommand('r', 'cohort.sas7bdat', 'readstat').line, /haven::read_sas/);
  // An extension readstat would itself have rejected resolves to nothing, rather than
  // being forced into one of its six.
  assert.equal(openCommand('r', 'mystery.baz', 'readstat'), null);
});

test('a single-format importer ignores the extension entirely', () => {
  // .xlsb and .xlsm are extensions the first version of this map did not carry; naming
  // the importer makes listing every one of them unnecessary.
  assert.match(openCommand('r', 'book.xlsb', 'excel').line, /readxl::read_excel/);
  assert.match(openCommand('r', 'book.xlsm', 'excel').line, /readxl::read_excel/);
  assert.match(openCommand('r', 'odd.name', 'parquet').line, /arrow::read_parquet/);
  assert.match(openCommand('r', 'feed.jsonl', 'ndjson').line, /jsonlite/);
});

test('an unknown importer id falls back to the extension, not to nothing', () => {
  // A third-party importer we have no entry for still gets whatever the name supports.
  assert.match(openCommand('r', 'survey.csv', 'some-third-party').line, /read\.csv/);
  assert.equal(openCommand('r', 'survey.txt', 'some-third-party'), null);
});

test('the exported script uses the importer the syntax recorded', () => {
  const out = scriptToR('# use "survey.txt" via csv\nkeep if age > 18').text;
  assert.match(out, /d <- read\.csv\("survey\.txt"/);
  assert.match(out, /Opens survey\.txt itself/);
  // Without the clause the same file is unresolvable, and the placeholder returns.
  const bare = scriptToR('# use "survey.txt"\nkeep if age > 18').text;
  assert.match(bare, /your-data\.csv/);
});

test('Stata and SPSS read the clause too', () => {
  assert.match(scriptToStata('# use "data.txt" via csv\nkeep if age > 18').text, /^import delimited "data\.txt", clear$/m);
  assert.match(scriptToSpss('# use "GSS.sav" via readstat\nkeep if age > 18').text, /^GET FILE='GSS\.sav'\.$/m);
});
