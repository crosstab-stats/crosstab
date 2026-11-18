/**
 * @file csv-streaming.test.mjs
 * The CSV reader, which used to hold the whole file in memory and died on a 67 MB one.
 *
 * ## What happened
 *
 * It read the file, decoded it to one JS string, tokenised that into an array of arrays
 * of STRINGS, pivoted those into columns, and only then emitted — all alive at once. On
 * a College Scorecard extract (~3,300 columns) that is ~21 million JS strings, and it
 * emitted them as ONE batch of 21.45 million cells:
 *
 *     Out of Memory Error: failed to allocate data of size 1.0 MiB (3.1 GiB/3.1 GiB used)
 *
 * — owner, 2026-11-17, on a 67 MB file. The spinner froze too: the tokeniser never
 * yielded, so the one visible sign of life was blocked by the work it was reporting.
 *
 * Measured on a synthetic file of that shape, old vs new: peak RSS 2,094 MiB → 526 MiB,
 * one batch of 21,450,000 cells → ten of at most 2.2 million, and identical typing.
 *
 * ## What these tests are mostly about
 *
 * Streaming made the tokeniser incremental, and an incremental tokeniser has failure
 * modes the old one could not have: a quoted field, a row, or a multi-byte character
 * may straddle a chunk boundary. The old code was correct about those for free, because
 * the whole file was one string. So most of what follows feeds the reader its bytes in
 * absurdly small pieces and checks it still gets the same answer — a real read may
 * return short, and that is the same path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { readCsv } = await import('../plugins/builtin-csv-codec/index.js');

/**
 * Run the codec over `text`, handing it `chunk` bytes at a time.
 *
 * @param {string} text the file
 * @param {object} [opts]
 * @param {number} [opts.chunk] bytes per read — small values force boundary cases
 * @param {string} [opts.name] the filename (decides the delimiter)
 */
async function run(text, { chunk = 1 << 22, name = 'data.csv' } = {}) {
  const bytes = new TextEncoder().encode(text);
  const out = { batches: [], progress: [], variables: null, rowCount: null };
  const app = {
    codec: {
      size: async () => bytes.length,
      read: async (off, len) => bytes.subarray(off, off + Math.min(len, chunk)),
      begin: async (variables, storageTypes, opts) => {
        out.variables = variables;
        out.storageTypes = storageTypes;
        out.rowCount = opts?.rowCount ?? null;
        out.wide = !!opts?.wide;
      },
      progress: async (done, total) => { out.progress.push([done, total]); },
      batch: async (cols) => { out.batches.push(cols); },
    },
  };
  await readCsv(app, { name });

  // Stitch the batches back into whole columns, which is what the host does.
  const columns = {};
  for (const v of out.variables ?? []) columns[v.name] = [];
  for (const b of out.batches) {
    for (const v of out.variables) columns[v.name].push(...Array.from(b[v.name]));
  }
  return { ...out, columns };
}

// =============================================================================
// It still parses CSV
// =============================================================================

test('a plain file comes through with its types', async () => {
  const r = await run('a,b,c\n1,x,2.5\n2,y,3.5\n');
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 'b', 'c']);
  assert.deepEqual(r.variables.map((v) => v.type), ['numeric', 'string', 'numeric']);
  assert.deepEqual(Array.from(r.columns.a), [1, 2]);
  assert.deepEqual(r.columns.b, ['x', 'y']);
  assert.equal(r.rowCount, 2, 'the row count is known before the first batch');
});

test('a column is numeric only if EVERY value is — one "N/A" makes it text', async () => {
  // The rule the old parser enforced by having every value in hand. Keeping it is why
  // the file is read twice rather than typed from a sample of the first rows.
  const r = await run('a,b\n1,1\n2,2\n3,N/A\n');
  assert.equal(r.variables[0].type, 'numeric');
  assert.equal(r.variables[1].type, 'string');
  assert.deepEqual(r.columns.b, ['1', '2', 'N/A']);
});

test('an empty column is text, and blanks are missing not zero', async () => {
  const r = await run('a,b\n1,\n,\n');
  assert.equal(r.variables[1].type, 'string', 'nothing seen, so nothing says it is a number');
  assert.deepEqual(r.columns.b, [null, null]);
  assert.ok(Number.isNaN(r.columns.a[1]), 'a blank in a numeric column is NaN, not 0');
});

test('RFC-4180 quoting survives: delimiters, newlines and doubled quotes inside fields', async () => {
  const r = await run('a,b\n1,"x,y"\n2,"line\nbreak"\n3,"she said ""hi"""\n');
  assert.deepEqual(r.columns.b, ['x,y', 'line\nbreak', 'she said "hi"']);
  assert.equal(r.rowCount, 3, 'a newline inside quotes is not a row break');
});

test('CRLF, a missing trailing newline, and a blank last line', async () => {
  assert.deepEqual((await run('a,b\r\n1,x\r\n2,y\r\n')).columns.b, ['x', 'y']);
  assert.deepEqual((await run('a,b\n1,x\n2,y')).columns.b, ['x', 'y'], 'no trailing newline');
  assert.equal((await run('a,b\n1,x\n\n')).rowCount, 1, 'a blank trailing line is not a row');
});

test('a .tsv is read as tab-delimited', async () => {
  const r = await run('a\tb\n1\tx y\n', { name: 'data.tsv' });
  assert.deepEqual(r.variables.map((v) => v.name), ['a', 'b']);
  assert.deepEqual(r.columns.b, ['x y']);
});

test('duplicate and empty headers are made unique, as before', async () => {
  const r = await run('a,a,\n1,2,3\n');
  assert.equal(r.variables[0].name, 'a');
  assert.notEqual(r.variables[1].name, 'a');
  assert.equal(r.variables[2].name, 'V3');
});

// =============================================================================
// The part streaming made possible to get wrong
// =============================================================================

test('the same file, one byte at a time, parses identically', async () => {
  // Every boundary case at once: fields, rows, quotes and multi-byte characters all
  // split. A real random-access read may return short, so this is the same code path.
  const text = 'a,b,c\n1,"x,y",2.5\n2,"line\nbreak",3.5\n3,"ü é 漢",4\n';
  const whole = await run(text);
  const byByte = await run(text, { chunk: 1 });
  assert.deepEqual(byByte.columns.b, whole.columns.b);
  assert.deepEqual(Array.from(byByte.columns.c), Array.from(whole.columns.c));
  assert.deepEqual(byByte.columns.b, ['x,y', 'line\nbreak', 'ü é 漢']);
});

test('a multi-byte character split across a read is not corrupted', async () => {
  // "漢" is three bytes. Cutting after one used to be impossible; now it is routine,
  // and a decoder without {stream: true} would silently yield U+FFFD.
  const r = await run('a\n漢字\n', { chunk: 1 });
  assert.deepEqual(r.columns.a, ['漢字']);
});

test('a quoted field spanning a boundary keeps its quotes straight', async () => {
  for (const chunk of [1, 2, 3, 5, 7, 13]) {
    const r = await run('a,b\n1,"he said ""no"", twice"\n', { chunk });
    assert.deepEqual(r.columns.b, ['he said "no", twice'], `chunk=${chunk}`);
  }
});

// =============================================================================
// What the OOM was actually about
// =============================================================================

test('batches are bounded by CELLS, so width cannot blow one up', async () => {
  // The old reader emitted one batch per 50,000 ROWS, which is fine at 10 columns and
  // fatal at 3,300: it is the width that decides what a batch costs. 400 columns x 900
  // rows is 360,000 cells — one batch under the cell cap, many under a row cap.
  const cols = 400;
  const rows = 900;
  const header = Array.from({ length: cols }, (_, c) => `v${c}`).join(',');
  const line = Array.from({ length: cols }, (_, c) => String(c)).join(',');
  const r = await run(`${header}\n${`${line}\n`.repeat(rows)}`);
  assert.equal(r.rowCount, rows);
  const cells = r.batches.map((b) => Object.keys(b).length * b[r.variables[0].name].length);
  assert.ok(Math.max(...cells) <= 2_000_000, `largest batch ${Math.max(...cells)} cells`);
  assert.equal(r.columns.v0.length, rows, 'every row still arrives');
});

test('it reports progress while scanning, before it can know the total', async () => {
  // The stretch that looked like a hang. The first pass cannot say how many rows there
  // are — that is what it is counting — so it reports a running count against -1, and
  // the second pass reports against the real total.
  const header = Array.from({ length: 50 }, (_, c) => `v${c}`).join(',');
  const line = Array.from({ length: 50 }, (_, c) => String(c)).join(',');
  const r = await run(`${header}\n${`${line}\n`.repeat(4000)}`, { chunk: 4096 });
  assert.ok(r.progress.length > 0, 'nothing was reported at all');
  assert.ok(r.progress.some(([, total]) => total === -1), 'no report from the counting pass');
  assert.ok(r.progress.some(([, total]) => total === 4000), 'no report against a known total');
  // And the counts only ever go forward.
  const scan = r.progress.filter(([, t]) => t === -1).map(([d]) => d);
  assert.deepEqual(scan, [...scan].sort((x, y) => x - y));
});

test('an empty or header-only file says so rather than importing nothing', async () => {
  await assert.rejects(() => run(''), /no columns found/);
  const headerOnly = await run('a,b\n');
  assert.equal(headerOnly.rowCount, 0);
  assert.equal(headerOnly.batches.length, 0, 'no empty batch is sent');
});

test('the scan yields to the event loop, so the page can still paint', async () => {
  // The freeze, measured rather than reasoned about. A timer that never fires is a page
  // that never repaints, which is what "the swirly circle froze" means — and the old
  // reader tokenised the whole file in one synchronous call, so nothing could fire.
  //
  // `read` here resolves immediately, which is the hostile case: a promise that is
  // already settled only drains the microtask queue, so a loop awaiting it never lets a
  // TIMER run. Only an explicit macrotask yield does, which is why there is one.
  const header = Array.from({ length: 20 }, (_, c) => `v${c}`).join(',');
  const line = Array.from({ length: 20 }, (_, c) => String(c)).join(',');
  const text = `${header}\n${`${line}\n`.repeat(20000)}`;

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    // 64 KiB per read, so the file spans many chunks.
    await run(text, { chunk: 1 << 16 });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'the parse never let a timer run — the UI would be frozen');
});

test('every column in a batch has the SAME length', async () => {
  // The bug the browser caught and node had hidden. The first streaming version flushed
  // at CHUNK boundaries, so a chunk holding more rows than a batch overran the buffers —
  // and a Float64Array silently drops a write past its end while a plain Array grows, so
  // the numeric and string columns of one batch came out different lengths. Silent, and
  // it corrupts the data rather than failing.
  //
  // 60 columns, a mix of numeric and text, read in chunks big enough to hold many rows.
  const cols = 60;
  const header = Array.from({ length: cols }, (_, c) => `v${c}`).join(',');
  const line = Array.from({ length: cols }, (_, c) => (c % 3 === 0 ? 'text' : String(c))).join(',');
  const r = await run(`${header}\n${`${line}\n`.repeat(5000)}`, { chunk: 1 << 16 });

  for (const [i, b] of r.batches.entries()) {
    const lengths = [...new Set(Object.values(b).map((col) => col.length))];
    assert.equal(lengths.length, 1, `batch ${i} has ragged columns: ${lengths.join(', ')}`);
  }
  // ...and no batch exceeds the cell budget it was sized to.
  for (const b of r.batches) {
    const n = b[r.variables[0].name].length;
    assert.ok(n * cols <= 2_000_000, `batch of ${n * cols} cells`);
  }
  assert.equal(r.columns.v0.length, 5000, 'and not one row was dropped');
  assert.equal(r.columns.v1.length, 5000);
});

// =============================================================================
// Where the data goes once it is parsed
// =============================================================================

test('a dataset too big for a table is routed to the out-of-core ingest', async () => {
  // readstat has routed on this rule for a while and the CSV reader did not, so a huge
  // CSV built a DuckDB table however big it got. The threshold is ~32 million values;
  // 400 columns x 90,000 rows is 36 million.
  const cols = 400;
  const header = Array.from({ length: cols }, (_, c) => `v${c}`).join(',');
  const line = Array.from({ length: cols }, (_, c) => String(c)).join(',');
  const r = await run(`${header}
${`${line}
`.repeat(90000)}`);
  assert.equal(r.rowCount, 90000);
  assert.equal(r.wide, true, 'a 36-million-value file must not become a DuckDB table');
});

test('an ordinary file is NOT routed out of core', async () => {
  // The parquet path is slower and the file lands as a file rather than a table, so it
  // is for the shapes that need it. Routing everything there would be its own bug.
  const r = await run('a,b,c\n1,x,2\n2,y,3\n');
  assert.ok(!r.wide, 'a three-column file went out of core');
});
