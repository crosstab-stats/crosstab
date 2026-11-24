/**
 * @file parquet-codec-routing.test.mjs
 * What the Parquet reader DECLARES to the host, which is what the host routes on.
 *
 * ## Why this file exists
 *
 * A dataset too big for a DuckDB table has to go out of core — the host writes Parquet
 * and queries that rather than building a table in the wasm heap, which has no spill (see
 * `core/duckdb-manager.js`). The 2026-11-18 codec audit found three of five codecs
 * declaring nothing the host could route on, this one included: a multi-gigabyte Parquet
 * file built a table however big it was, while the same data in a CSV did not, purely
 * because of which reader opened it.
 *
 * The first fix had the codec apply the shared cells rule and declare a verdict. That rule
 * was measured on 2026-11-23 and deleted (`spike/ingest-route-measure.mjs`): it was blind
 * to column type, which is what a DuckDB table actually charges for. So the codec declares
 * no verdict now — it declares FACTS, and the host's byte budget decides. These tests
 * moved with it, from "is the flag right" to "are the facts right", which is the half this
 * format can be held to a high standard on.
 *
 * Because it is free in this format, and that is the part worth pinning: Parquet's footer
 * carries the row count AND the column types, so everything the host routes on is known
 * before a single row group is read.
 *
 * ## Why hyparquet is stubbed
 *
 * The reader gets the library from the host as a declared ASSET — the sandbox has
 * `connect-src 'none'` and cannot fetch anything — and imports it from source text. That
 * seam is exactly where a fake belongs: these tests are about what the codec does with a
 * footer, not about Parquet decoding, and a real fixture would make the row count a
 * property of a binary blob nobody can read in a diff. The reader had NO tests before
 * this, so the seam is also the cheapest way to get some.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { readParquet } = await import('../plugins/builtin-parquet-codec/index.js');

// The codec imports its asset the only way a sandbox can: `URL.createObjectURL` over the
// source text, then `import(blobUrl)`. Node's ESM loader accepts `file:`, `data:` and
// `node:` and refuses `blob:`, so the import throws here for a reason that has nothing to
// do with the code under test. Redirect the one call to an equivalent `data:` URL. The
// source text is captured on the way through `loadAsset`, because a Blob only gives it
// back asynchronously and `createObjectURL` is synchronous.
let lastAssetSource = null;
URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(lastAssetSource).toString('base64')}`;
URL.revokeObjectURL = () => {};

/** A stand-in hyparquet, as module source text — which is how the real one arrives. */
function fakeHyparquet({ rows, groups, numRowsInFooter = true }) {
  const src = `
    const ROWS = ${JSON.stringify(rows)};
    const GROUPS = ${JSON.stringify(groups)};
    export async function parquetMetadataAsync() {
      const row_groups = GROUPS.map((n) => ({ num_rows: n }));
      return {
        ${numRowsInFooter ? 'num_rows: ROWS.length,' : ''}
        row_groups,
      };
    }
    export async function parquetReadObjects({ rowStart = 0, rowEnd = ROWS.length }) {
      return ROWS.slice(rowStart, rowEnd);
    }
  `;
  return src;
}

/**
 * Run the reader against a stubbed library and collect what it told the host.
 *
 * @param {object[]} rows the decoded records
 * @param {object} [opts]
 * @param {number[]} [opts.groups] row counts per row group (must sum to rows.length)
 * @param {boolean} [opts.numRowsInFooter] whether the footer carries `num_rows`
 */
async function run(rows, { groups = [rows.length], numRowsInFooter = true } = {}) {
  const out = { batches: [], variables: null, storageTypes: null, opts: null };
  const app = {
    codec: {
      loadAsset: async (name) => {
        assert.equal(name, 'hyparquet');
        lastAssetSource = fakeHyparquet({ rows, groups, numRowsInFooter });
        return lastAssetSource;
      },
      size: async () => 1024,
      read: async () => new Uint8Array(0),
      begin: async (variables, storageTypes, opts) => {
        out.variables = variables;
        out.storageTypes = storageTypes;
        out.opts = opts ?? null;
      },
      batch: async (cols) => { out.batches.push(cols); },
      progress: async () => {},
    },
  };
  await readParquet(app, {});
  return out;
}

const wideRow = (() => {
  const r = {};
  for (let c = 0; c < 4000; c++) r[`v${c}`] = c;
  return r;
})();

test('it declares the facts the host routes on, and no verdict of its own', async () => {
  // The audit's finding, in one assertion: `begin` used to be called with two arguments
  // and the host had nothing to route on. What it needs is the row count and a type per
  // column; what it must NOT be handed is a conclusion, which it would ignore.
  const r = await run([{ a: 1 }, { a: 2 }]);
  assert.ok(r.opts, 'begin() was called with no options at all');
  assert.equal(r.opts.rowCount, 2);
  assert.ok(!('wide' in r.opts), 'the codec is routing again');
  assert.deepEqual(r.storageTypes, { a: 'numeric' }, 'a type per column, or bytes cannot be estimated');
});

test('a genuinely large file is routed out of core — by the host, from the footer', async () => {
  // The property worth pinning is that the routing input costs ONE SMALL OBJECT. The row
  // count comes from the footer, so a 10,000-row file is routed without decoding 10,000
  // rows — here the stub can only produce one of them, and the declaration is still right.
  const r = await run([wideRow], { groups: [1], numRowsInFooter: false });
  assert.equal(r.opts.rowCount, 1);
  assert.equal(r.variables.length, 4000);

  const big = await runWithFooterRows(wideRow, 10_000);
  assert.equal(big.opts.rowCount, 10_000, 'the footer, not the rows');

  // And the verdict on that declaration, from the host rule. 4,000 columns x 10,000 rows
  // of doubles is 305 MiB — under the 384 MiB budget, so it is a TABLE, where the old
  // cells rule called it wide at 40 million cells. That reversal is the measured change:
  // it is the same shape in VARCHAR, at 611 MiB, that cannot be a table.
  const { exceedsTableBudget } = await import('../core/duckdb-manager.js');
  const shape = (type) => big.variables.map(() => ({ type }));
  assert.equal(exceedsTableBudget(0, shape('numeric'), big.opts.rowCount, true), false);
  assert.equal(exceedsTableBudget(0, shape('string'), big.opts.rowCount, true), true);
  // One more year of it, though, and the cumulative budget stops the second one — which
  // is the ceiling the deleted per-file rule could not see at all.
  const oneYear = 305 * 1024 * 1024;
  assert.equal(exceedsTableBudget(oneYear, shape('numeric'), big.opts.rowCount, true), true,
    'the budget belongs to the DATABASE, not to the file');
});

/** A footer claiming many rows while only one is actually decodable: the point is that the
 * routing reads the footer, so it must not need the rows to exist. */
async function runWithFooterRows(row, footerRows) {
  const out = { opts: null, variables: null };
  const src = `
    export async function parquetMetadataAsync() {
      return { num_rows: ${footerRows}, row_groups: [{ num_rows: 1 }] };
    }
    export async function parquetReadObjects() { return [${JSON.stringify(row)}]; }
  `;
  const app = {
    codec: {
      loadAsset: async () => { lastAssetSource = src; return src; },
      size: async () => 1024,
      read: async () => new Uint8Array(0),
      begin: async (variables, _st, opts) => { out.variables = variables; out.opts = opts ?? null; },
      batch: async () => {},
      progress: async () => {},
    },
  };
  await readParquet(app, {});
  return out;
}

test('the row count falls back to the row groups when the footer omits it', async () => {
  // Not every writer fills in `num_rows`. Summing the groups is the fallback, and both
  // are BigInt in a real footer — hence the Number() on the way out, or the arithmetic
  // throws "Cannot mix BigInt".
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];
  const r = await run(rows, { groups: [2, 2], numRowsInFooter: false });
  assert.equal(r.opts.rowCount, 4);
});

test('a BigInt row count does not poison the arithmetic', async () => {
  // A real hyparquet footer hands back BigInt for the 64-bit fields, and mixing BigInt
  // with a Number throws a TypeError — which would surface only on a real file, never in
  // a test with plain numbers in it. The codec used to multiply it itself; now it hands
  // the count to the host, so what matters is that what it hands over is a NUMBER.
  const out = { opts: null };
  const src = `
    export async function parquetMetadataAsync() {
      return { num_rows: 12n, row_groups: [{ num_rows: 12n }] };
    }
    export async function parquetReadObjects() { return [{ a: 1 }]; }
  `;
  const app = {
    codec: {
      loadAsset: async () => { lastAssetSource = src; return src; },
      size: async () => 1024,
      read: async () => new Uint8Array(0),
      begin: async (_v, _st, opts) => { out.opts = opts ?? null; },
      batch: async () => {},
      progress: async () => {},
    },
  };
  await readParquet(app, {});
  assert.equal(out.opts.rowCount, 12);
  assert.equal(typeof out.opts.rowCount, 'number', 'a BigInt reached the host');
  // And the host's own arithmetic survives one anyway, since a third-party codec may not
  // be so careful: both ends coerce.
  const { estimateTableBytes, routingRows } = await import('../core/duckdb-manager.js');
  assert.equal(routingRows(12n), 12);
  assert.equal(estimateTableBytes([{ type: 'numeric' }], 12n), 12 * 16);
});

test('an empty file still declares a schema, and routes to a table', async () => {
  // The host needs a schema to create the (empty) dataset. Nothing to route out of core —
  // and note WHY the host gets that right: zero rows must stay zero. The pessimistic
  // "unknown row count" assumption is `-1`, not falsy, precisely so an honest 0 is not
  // charged 100,000 phantom rows. See `routingRows`.
  const r = await run([]);
  assert.deepEqual(r.variables, []);
  assert.equal(r.opts.rowCount, 0);
  assert.ok(!('wide' in r.opts), 'the codec is routing again');
  assert.equal(r.batches.length, 0, 'an empty batch was sent');

  const { routingRows, exceedsTableBudget } = await import('../core/duckdb-manager.js');
  assert.equal(routingRows(r.opts.rowCount), 0, 'an empty file became a forecast of 100,000 rows');
  assert.equal(exceedsTableBudget(0, [], 0, false), false, 'even on the tightest budget');
});

test('it still streams row group by row group', async () => {
  // The property the routing fix must not have cost: one read per group, not one read of
  // the file. Three groups, three batches.
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 }];
  const r = await run(rows, { groups: [2, 2, 2] });
  assert.equal(r.batches.length, 3);
  assert.deepEqual(r.batches.map((b) => b.a.length), [2, 2, 2]);
});
