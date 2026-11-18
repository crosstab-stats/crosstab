/**
 * @file csv-missing-codes.test.mjs
 * Typing a column that is numeric APART FROM a missing-value code.
 *
 * ## What happened
 *
 * College Scorecard's MERGED2025_26_PP.csv is 3,379 columns wide. Exactly 19 of them
 * are genuinely text. The reader typed **13** as numeric.
 *
 * The other 3,347 are numbers carrying one of two sentinels — "NA" (15.7M values) and
 * "PS" (2.6M) — and the rule "numeric iff every non-empty value parses as finite" is
 * all-or-nothing, so one "NA" in 6,272 rows makes the whole column a string. Typed as
 * strings they cannot be analysed at all, and they cost 322 MiB of DuckDB string slots
 * against 163 MiB as doubles, inside a database that (separately) could not spill.
 *
 * Neither sentinel alone is sufficient: "NA" recovers 2,843 columns, "PS" 414, and 90
 * more need both. And "PrivacySuppressed", which is the spelling the Scorecard docs
 * use, appears ZERO times in that release — a hard-coded list from the documentation
 * would have fixed nothing, which is why the codes are DETECTED and then confirmed.
 *
 * ## What these tests are about
 *
 * Mostly the two guards that stop the detector "recovering" things it shouldn't: a
 * column with no numbers in it at all, and a column with too many distinct values to be
 * carrying codes. Both are text columns that happen to be shaped like candidates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const { readCsv } = await import('../plugins/builtin-csv-codec/index.js');

/**
 * Run the codec over `text`.
 *
 * @param {string} text the file
 * @param {object} [opts]
 * @param {((payload: object) => string[])|null} [opts.answer] what the host replies to
 *   `missingCodes`. `null` means the host does NOT implement the verb at all, which is
 *   the negative control: typing must then be exactly what it was before.
 */
async function run(text, { answer = () => [], name = 'data.csv' } = {}) {
  const bytes = new TextEncoder().encode(text);
  const out = { batches: [], variables: null, asked: null, beginOpts: null };
  const codec = {
    size: async () => bytes.length,
    read: async (off, len) => bytes.subarray(off, off + len),
    begin: async (variables, storageTypes, opts) => {
      out.variables = variables;
      out.storageTypes = storageTypes;
      out.beginOpts = opts;
    },
    progress: async () => {},
    batch: async (cols) => { out.batches.push(cols); },
  };
  if (answer) {
    codec.missingCodes = async (payload) => { out.asked = payload; return answer(payload); };
  }
  await readCsv({ codec }, { name });

  const columns = {};
  for (const v of out.variables ?? []) columns[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) columns[v.name].push(...Array.from(b[v.name]));
  }
  return { ...out, columns };
}

/** The candidate rows, as `{value: [values, columns]}`, for terse assertions. */
const cand = (r) => Object.fromEntries((r.asked?.candidates ?? []).map((c) => [c.value, [c.values, c.columns]]));
/** The combo rows, as `{'NA PS': columns}`. */
const combo = (r) => Object.fromEntries((r.asked?.combos ?? []).map((k) => [k.codes.join(' '), k.columns]));

// =============================================================================
// The negative control: a host that does not ask gets the old behaviour
// =============================================================================

test('without the verb, typing is exactly what it was', async () => {
  const r = await run('a,b\n1,1\n2,NA\n3,3\n', { answer: null });
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'string'],
    'one "NA" still makes the whole column a string when nobody is asked');
  assert.deepEqual(r.columns.b, ['1', 'NA', '3']);
  assert.equal(r.asked, null, 'the verb was never called');
});

test('an empty answer is the old behaviour too', async () => {
  const r = await run('a,b\n1,1\n2,NA\n3,3\n', { answer: () => [] });
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'string']);
  assert.deepEqual(r.columns.b, ['1', 'NA', '3']);
});

// =============================================================================
// Detecting and applying
// =============================================================================

test('a code blocking an otherwise-numeric column is proposed', async () => {
  const r = await run('a,b\n1,1\n2,NA\n3,NA\n');
  assert.deepEqual(cand(r), { NA: [2, 1] }, 'two values, in one column');
  assert.deepEqual(combo(r), { NA: 1 });
});

test('accepting it retypes the column and strikes the code out', async () => {
  const r = await run('a,b\n1,1\n2,NA\n3,3\n', { answer: () => ['NA'] });
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'numeric']);
  assert.deepEqual(Array.from(r.columns.b).map((v) => (Number.isNaN(v) ? 'NaN' : v)), [1, 'NaN', 3]);
  assert.deepEqual(r.beginOpts.missingCodes, ['NA'], 'the schema records what was applied');
});

test('declining leaves the code as data', async () => {
  const r = await run('a,b\n1,1\n2,NA\n3,3\n', { answer: () => ['PS'] });
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'string']);
  assert.deepEqual(r.columns.b, ['1', 'NA', '3'], '"NA" was not the code that was ticked');
});

test('an accepted code is missing in a column that stayed text, too', async () => {
  // The user ticked "NA means missing in this file", not "…only where it helps".
  const r = await run('a,b\n1,x\n2,NA\n3,y\n', { answer: () => ['NA'] });
  assert.equal(r.variables[1].type, 'string', 'b has no numbers, so it stays text');
  assert.deepEqual(r.columns.b, ['x', null, 'y'], 'but the code is still struck out');
});

// =============================================================================
// The two guards — text columns shaped like candidates
// =============================================================================

test('a text column with few distinct values is NOT proposed', async () => {
  // `CONTROL_PEPS` is "Public" / "Private Nonprofit" / "Private For-Profit" and nothing
  // else. It sits well under the per-column cap, so only the "has a number in it"
  // guard stops it being "recovered" into a numeric column that is entirely missing.
  const text = 'ctrl\nPublic\nPrivate Nonprofit\nPrivate For-Profit\nPublic\n';
  const r = await run(text);
  assert.deepEqual(cand(r), {}, 'nothing proposed');
  assert.equal(r.variables[0].type, 'string');
  // Force-ticking all three WOULD make it an all-missing numeric column — but that takes
  // someone typing them in deliberately, having been told they mean missing. The guard
  // is that the detector never puts them forward.
  const forced = await run(text, { answer: () => ['Public', 'Private Nonprofit', 'Private For-Profit'] });
  assert.equal(forced.variables[0].type, 'numeric');
  assert.ok(Array.from(forced.columns.ctrl).every(Number.isNaN), 'entirely missing');
});

test('a high-cardinality text column is dropped rather than tracked', async () => {
  // `INSTNM` has 6,272 distinct values. Holding those for 3,379 columns is the very
  // thing this file dies of, so the column stops being tracked once it blows the cap.
  const rows = Array.from({ length: 40 }, (_v, i) => `Institution ${i}`).join('\n');
  const r = await run(`instnm\n${rows}\n`);
  assert.deepEqual(cand(r), {}, 'no candidates from a column of distinct prose');
});

test('a column needing five different codes is not a numeric column', async () => {
  // Four is the cap: a missing-value code recurs by definition.
  const r = await run('a\n1\nw\nx\ny\nz\nq\n2\n');
  assert.deepEqual(cand(r), {}, 'gave up on the column, so proposed nothing');
});

test('a column that is ALL code is numeric and entirely missing', async () => {
  // 2,652 columns of the owner's file are this: withheld or unreported for every
  // institution. The host said "NA means missing", so the column is a numeric variable
  // with no data — not a text column full of the word "NA".
  const r = await run('a,b\n1,NA\n2,NA\n', { answer: () => ['NA'] });
  assert.equal(r.variables[1].type, 'numeric');
  assert.ok(Array.from(r.columns.b).every(Number.isNaN), 'every value missing');
});

test('a column with no values at all is still text', async () => {
  const r = await run('a,b\n1,\n2,\n', { answer: () => ['NA'] });
  assert.equal(r.variables[1].type, 'string', 'nothing ever said it was a number');
});

test('the host is asked even when nothing is proposed, so a replay can still apply', async () => {
  // Re-running a recorded import against a revision that no longer proposes the code.
  const r = await run('a,b\n1,x\n2,NA\n', { answer: () => ['NA'] });
  assert.ok(r.asked, 'asked anyway');
  assert.deepEqual(r.asked.candidates, [], 'with nothing to propose');
  assert.deepEqual(r.columns.b, ['x', null], 'and the recorded code was still applied');
});

// =============================================================================
// The arithmetic the dialog needs
// =============================================================================

test('combinations are reported so a subset can be costed exactly', async () => {
  // onlyNA needs NA; onlyPS needs PS; both needs the pair. A sum of per-value column
  // counts would say NA recovers 2 and PS recovers 2, total 4 — there are only 3.
  const text = [
    'onlyNA,onlyPS,both,plain',
    '1,1,1,1',
    'NA,2,NA,2',
    '3,PS,PS,3',
  ].join('\n');
  const r = await run(text);
  assert.deepEqual(combo(r), { NA: 1, PS: 1, 'NA PS': 1 });
  assert.deepEqual(cand(r), { NA: [2, 2], PS: [2, 2] }, 'per-value totals span both columns');

  // Ticking one code recovers only the combos fully covered by it.
  const justNA = await run(text, { answer: () => ['NA'] });
  assert.deepEqual(justNA.variables.map((v) => v.type), ['numeric', 'string', 'string', 'numeric']);
  const bothCodes = await run(text, { answer: () => ['NA', 'PS'] });
  assert.deepEqual(bothCodes.variables.map((v) => v.type), ['numeric', 'numeric', 'numeric', 'numeric']);
});

test('the candidate list is capped, and says what it dropped', async () => {
  // 20 columns, each numeric but for its own distinct code.
  const header = Array.from({ length: 20 }, (_v, i) => `c${i}`).join(',');
  const r1 = Array.from({ length: 20 }, (_v, i) => `code${i}`).join(',');
  const r2 = Array.from({ length: 20 }, () => '1').join(',');
  const r = await run(`${header}\n${r1}\n${r2}\n`);
  assert.equal(r.asked.candidates.length, 12, 'capped');
  assert.equal(r.asked.omitted, 8, 'and it reports what did not fit, rather than implying there was nothing');
});

// =============================================================================
// The real workload
// =============================================================================

const REAL = new URL('../sample-data/MERGED2025_26_PP.csv', import.meta.url);
const haveReal = existsSync(REAL);

test('the owner\'s College Scorecard file: 13 numeric columns become 3,360', { skip: haveReal ? false : 'sample-data/MERGED2025_26_PP.csv not present (it is gitignored)' }, async () => {
  // The file this whole change exists for. Read through the codec's own verbs so the
  // measurement is of the shipped path, not of a reimplementation of it.
  const fd = openSync(REAL, 'r');
  const size = statSync(REAL).size;
  const codec = {
    size: async () => size,
    read: async (off, len) => {
      const n = Math.min(len, size - off);
      const buf = Buffer.allocUnsafe(n);
      readSync(fd, buf, 0, n, off);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
    begin: async (variables, _st, opts) => { codec._vars = variables; codec._opts = opts; },
    progress: async () => {},
    batch: async () => {}, // the typing is what is under test; the cells are not
  };
  let asked = null;
  codec.missingCodes = async (payload) => { asked = payload; return ['NA', 'PS']; };
  try {
    await readCsv({ codec }, { name: 'MERGED2025_26_PP.csv' });
  } finally {
    closeSync(fd);
  }

  const vars = codec._vars;
  assert.equal(vars.length, 3379, 'columns');
  assert.equal(codec._opts.rowCount, 6272, 'rows');

  // What it proposed, and the arithmetic the dialog will show.
  const byValue = Object.fromEntries(asked.candidates.map((c) => [c.value, c.columns]));
  assert.ok(byValue.NA > 0 && byValue.PS > 0, `NA and PS are both proposed (got ${Object.keys(byValue)})`);
  const recovered = asked.combos
    .filter((k) => k.codes.every((v) => v === 'NA' || v === 'PS'))
    .reduce((a, k) => a + k.columns, 0);
  assert.equal(recovered, 3347, 'ticking both recovers exactly the measured 3,347 columns');

  const numeric = vars.filter((v) => v.type === 'numeric').length;
  assert.equal(numeric, 3360, '13 + 3,347');
  assert.equal(vars.length - numeric, 19, 'and exactly 19 columns are genuinely text');
});
