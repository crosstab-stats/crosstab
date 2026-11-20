/**
 * @file parquet-codec-routing.test.mjs
 * The Parquet reader's storage-routing decision, which it was not making.
 *
 * ## Why this file exists
 *
 * A dataset too big for a DuckDB table has to go out of core — the host writes Parquet
 * and queries that rather than building a table in the wasm heap, which has no spill (see
 * `core/duckdb-manager.js`). The 2026-11-18 codec audit found three of five codecs never
 * declaring it, this one included: a multi-gigabyte Parquet file built a table however big
 * it was, while the same data in a CSV did not, purely because of which reader opened it.
 *
 * It is free in this format, which is the part worth pinning. Parquet's footer carries the
 * row count and the schema, so the decision is made before a single row group is read.
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

test('it declares a routing decision at all', async () => {
  // The audit's finding, in one assertion: `begin` used to be called with two arguments
  // and the host had nothing to route on.
  const r = await run([{ a: 1 }, { a: 2 }]);
  assert.ok(r.opts, 'begin() was called with no options at all');
  assert.equal(typeof r.opts.wide, 'boolean', 'no routing decision');
});

test('the decision is the host rule, not a private copy of it', async () => {
  // Asserted against `isWideDataset` rather than a hard-coded verdict, so re-tuning the
  // threshold does not need this file edited — and so a second copy of the arithmetic
  // cannot quietly diverge from the one every other reader uses.
  const { isWideDataset } = await import('../core/plugin-stdlib.js');
  for (const rows of [[{ a: 1 }], [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]]) {
    const r = await run(rows);
    assert.equal(r.opts.wide, isWideDataset(r.variables.length, r.opts.rowCount));
  }
});

test('a genuinely large file is routed out of core', async () => {
  // 4,000 columns x 10,000 rows is 40 million cells, which is past the rule's threshold.
  // The row count comes from the FOOTER, so this costs one small object, not 10,000 —
  // which is the whole reason the decision can be made for free in this format.
  const r = await run([wideRow], { groups: [1], numRowsInFooter: false });
  assert.equal(r.opts.wide, false, 'one row of 4,000 is not wide');

  const big = await runWithFooterRows(wideRow, 10_000);
  assert.equal(big.opts.rowCount, 10_000);
  assert.equal(big.opts.wide, true, '40 million cells should not build a table');
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
  // A real hyparquet footer hands back BigInt for the 64-bit fields. `isWideDataset`
  // multiplies, and mixing BigInt with a Number throws a TypeError — which would have
  // surfaced only on a real file, never in a test with plain numbers in it.
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
  assert.equal(typeof out.opts.wide, 'boolean');
});

test('an empty file still declares a schema, and routes to a table', async () => {
  // The host needs a schema to create the (empty) dataset. Nothing to route out of core.
  const r = await run([]);
  assert.deepEqual(r.variables, []);
  assert.equal(r.opts.rowCount, 0);
  assert.equal(r.opts.wide, false);
  assert.equal(r.batches.length, 0, 'an empty batch was sent');
});

test('it still streams row group by row group', async () => {
  // The property the routing fix must not have cost: one read per group, not one read of
  // the file. Three groups, three batches.
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }, { a: 6 }];
  const r = await run(rows, { groups: [2, 2, 2] });
  assert.equal(r.batches.length, 3);
  assert.deepEqual(r.batches.map((b) => b.a.length), [2, 2, 2]);
});
