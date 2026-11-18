/**
 * @file opfs-ref.test.mjs
 * How DuckDB is told about an OPFS file, and why there is only one way now.
 *
 * ## What this replaced
 *
 * `registerFileHandle` posts a `FileSystemFileHandle` to the worker. WebKit refuses to
 * clone it — measured on an iPhone (iOS 18.7): `opfsHandlesToWorker: false`,
 * `DataCloneError — The object can not be cloned`. So `registerParquetFile` fell back to
 * `registerFileBuffer`, which loads the whole Parquet into the heap. The out-of-core
 * path was not out-of-core on the one platform least able to afford it, and mobile is
 * the product's differentiator.
 *
 * `registerOPFSFileName` takes a STRING; the worker opens OPFS itself, so nothing
 * crosses the boundary. Measured the same day on BOTH an iPhone and Chromium desktop
 * (where `opfsHandlesToWorker` is true): `registered: true`, `rowsRead: [{n: 3}]` on
 * each. One path, not a capability branch.
 *
 * The cost is the prefix on the registered key, which is what SQL must then use. These
 * tests pin the one function that knows about it, because everything else in the app
 * keeps the plain OPFS name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { opfsRef } = await import('../core/duckdb-manager.js');

test('a plain name becomes an opfs reference', () => {
  assert.equal(opfsRef('ct_wide_3.parquet'), 'opfs://ct_wide_3.parquet');
});

test('it is idempotent, so a reference can be passed back in', () => {
  // `dropRegisteredFile` and the restore path both hand back whatever they were given,
  // which may already be a reference.
  assert.equal(opfsRef('opfs://ct_wide_3.parquet'), 'opfs://ct_wide_3.parquet');
  assert.equal(opfsRef(opfsRef('x.parquet')), 'opfs://x.parquet');
});

test('empty and nullish inputs do not produce "opfs://undefined"', () => {
  assert.equal(opfsRef(''), 'opfs://');
  assert.equal(opfsRef(null), 'opfs://');
  assert.equal(opfsRef(undefined), 'opfs://');
});

test('stripping the prefix recovers the OPFS file name', () => {
  // The inverse `dropRegisteredFile` performs: OPFS knows nothing about the prefix, so
  // `removeEntry` must never see it.
  const strip = (n) => String(n ?? '').replace(/^opfs:\/\//, '');
  assert.equal(strip(opfsRef('ct_wide_3.parquet')), 'ct_wide_3.parquet');
  assert.equal(strip('ct_wide_3.parquet'), 'ct_wide_3.parquet', 'a plain name survives untouched');
});
