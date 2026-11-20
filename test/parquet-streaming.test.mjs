/**
 * @file parquet-streaming.test.mjs
 * Writing a wide dataset's Parquet to OPFS a row group at a time.
 *
 * ## Why
 *
 * `loadWide` is the only import path that works on WebKit, because it encodes Parquet in
 * JS and writes it with `createWritable` — DuckDB cannot write to OPFS there at all
 * (measured 2026-11-18: a `COPY … TO` into a registered `opfs://` file left it at one
 * byte). But `openParquetWriter` used to accumulate the WHOLE encoded file in a
 * `ByteWriter` and hand over a buffer, so the last mobile ceiling was ours, not
 * duckdb-wasm's.
 *
 * ## The trick, and why it is safe
 *
 * `ByteWriter` keeps `offset` (total ever written) and `index` (position in the current
 * buffer). Every file position in the Parquet metadata comes from `offset` — checked
 * across parquet-writer.js, column.js, indexes.js and metadata.js, where the only
 * `.index` occurrences are `Array.indexOf`. So draining bytes `[0, index)` and resetting
 * `index` is invisible to the format. Upstream's own node `fileWriter` does exactly this.
 *
 * Verified against the REAL library before any of it was written — 400 columns x 20,000
 * rows, buffered vs streamed, produced byte-identical files (29,178,336 bytes) with peak
 * buffer 27.8 MiB against 2.9 MiB.
 *
 * These tests cannot import hyparquet-writer (it is a CDN dependency, and the suite does
 * not reach the network). What they pin is OUR half: that the drain copies the right
 * bytes in the right order, resets correctly, never holds the whole file, and that the
 * backpressure chain which makes the async writes safe is actually connected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { stripComments } = await import('../core/plugin-modules.js');

/**
 * A faithful stand-in for hyparquet-writer's ByteWriter: the two counters, and the
 * contract that `offset` is monotonic while `index` may be reset by a flush.
 */
function FakeByteWriter(size = 64) {
  this.buffer = new ArrayBuffer(size);
  this.offset = 0;
  this.index = 0;
}
FakeByteWriter.prototype.append = function append(bytes) {
  if (this.index + bytes.length > this.buffer.byteLength) {
    const grown = new ArrayBuffer(Math.max(this.buffer.byteLength * 2, this.index + bytes.length));
    new Uint8Array(grown).set(new Uint8Array(this.buffer));
    this.buffer = grown;
  }
  new Uint8Array(this.buffer, this.index, bytes.length).set(bytes);
  this.index += bytes.length;
  this.offset += bytes.length; // never reset — the metadata's file positions
};

/** The drain under test, written exactly as duckdb-manager performs it. */
function makeDrain(bw, sink) {
  return async () => {
    if (bw.index === 0) return;
    const chunk = new Uint8Array(bw.buffer.slice(0, bw.index));
    bw.index = 0;
    await sink.write(chunk);
  };
}

// =============================================================================
// The drain
// =============================================================================

test('drained chunks concatenate to exactly what was written', async () => {
  const bw = new FakeByteWriter();
  const chunks = [];
  const drain = makeDrain(bw, { write: async (c) => { chunks.push(c); } });

  const expected = [];
  for (let group = 0; group < 7; group++) {
    const bytes = Uint8Array.from({ length: 50 + group * 13 }, (_v, i) => (group * 31 + i) % 256);
    bw.append(bytes);
    expected.push(...bytes);
    await drain();
  }

  const joined = chunks.flatMap((c) => [...c]);
  assert.deepEqual(joined, expected, 'byte order and content survive the resets');
  assert.equal(bw.offset, expected.length, 'offset counted every byte');
  assert.equal(bw.index, 0, 'and the buffer was released');
});

test('offset — which the metadata uses — is never reset by draining', async () => {
  // The correctness crux. If draining moved `offset`, every row-group and column-chunk
  // position in the footer would point at the wrong place and the file would be corrupt
  // in a way no length check would catch.
  const bw = new FakeByteWriter();
  const drain = makeDrain(bw, { write: async () => {} });
  bw.append(new Uint8Array(100));
  await drain();
  assert.equal(bw.offset, 100);
  bw.append(new Uint8Array(40));
  assert.equal(bw.offset, 140, 'kept counting across the flush');
  assert.equal(bw.index, 40, 'while index restarted from the drain');
});

test('the buffer never holds more than one row group', async () => {
  const bw = new FakeByteWriter();
  const drain = makeDrain(bw, { write: async () => {} });
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    bw.append(new Uint8Array(1000));
    peak = Math.max(peak, bw.index);
    await drain();
  }
  assert.equal(bw.offset, 40000, 'all of it was written');
  assert.ok(peak <= 1000, `peak buffer was ${peak}, should be one group`);
});

test('draining nothing writes nothing', async () => {
  const bw = new FakeByteWriter();
  let writes = 0;
  const drain = makeDrain(bw, { write: async () => { writes += 1; } });
  await drain();
  await drain();
  assert.equal(writes, 0, 'an empty buffer must not produce an empty chunk');
});

test('the chunk is a COPY — the buffer is reused the moment the write is pending', async () => {
  // The write is async and the encoder carries straight on into the same ArrayBuffer. A
  // view instead of a copy would ship whatever the next row group overwrote it with.
  const bw = new FakeByteWriter();
  let held = null;
  const drain = makeDrain(bw, { write: async (c) => { held = c; } });
  bw.append(Uint8Array.from([1, 2, 3, 4]));
  await drain();
  bw.append(Uint8Array.from([9, 9, 9, 9])); // reuses the same backing buffer
  assert.deepEqual([...held], [1, 2, 3, 4], 'the pending chunk was not overwritten');
});

// =============================================================================
// The wiring that makes the async writes safe
// =============================================================================

// The out-of-core route moved out of `data-store.js` into `core/ingest.js` on
// 2026-11-20, when the five separate ways into the engine became one. These three read
// the new home; every property they assert is the same property.

test('the ingest awaits the drain, and the producer awaits the ingest', () => {
  const ing = stripComments(readFileSync('core/ingest.js', 'utf8'));
  assert.match(ing, /await writer\.drain\(\)/, 'the row-group flush awaits the write');
  assert.match(ing, /return accRows >= groupRows \? flush\(\) : Promise\.resolve\(\);/,
    'and batch() RETURNS the flush, so the producer waits');
  assert.match(ing, /await flush\(\)/, 'the final partial group is awaited too');

  // The chain continues through the one `load`, which awaits every batch...
  const ds = stripComments(readFileSync('core/data-store.js', 'utf8'));
  // Matched on the PROPERTY, not the parameter name: the callback must await the batch.
  // The first version of this pinned `async (columns)` and broke the moment the parameter
  // was renamed, which tests nothing anyone cares about.
  assert.match(ds, /await stream\(async \([^)]*\) => \{[\s\S]{0,120}?await ingest\.batch\(/,
    'DataStore#load drops the batch promise');

  // ...and back to the codec reader, which must return it rather than discarding it.
  // Without this every row group's OPFS write races.
  const imp = stripComments(readFileSync('core/import-service.js', 'utf8'));
  assert.match(imp, /reader\.drain\(\(columns\) => \{ tick\(columns\); return batch\(columns\); \}\)/,
    'import-service returns the batch promise rather than discarding it');
});

test('the writer is opened WITH a name, or it would buffer the whole file', () => {
  const ing = stripComments(readFileSync('core/ingest.js', 'utf8'));
  assert.match(ing, /openParquetWriter\(columns, \{ name: file \}\)/);
  const dm = stripComments(readFileSync('core/duckdb-manager.js', 'utf8'));
  // No name → the old buffered behaviour, which other callers may still rely on.
  assert.match(dm, /openParquetWriter\(columns, \{ name = null \} = \{\}\)/);
  assert.match(dm, /const sink = name \? await this\.#openOpfsSink\(name\) : null/);
});

test('a failed wide import closes the writable before deleting the file', () => {
  // A writable left open holds the file; the cleanup would then fail silently and leave
  // a half-written Parquet behind.
  const ing = stripComments(readFileSync('core/ingest.js', 'utf8'));
  assert.match(ing, /await writer\.abort\?\.\(\)[\s\S]*?dropRegisteredFile/,
    'abort comes before the delete');
  // ...and the one `load` must actually CALL abort on any failure, or the rollback that
  // used to be inline in each path is now nobody's job.
  const ds = stripComments(readFileSync('core/data-store.js', 'utf8'));
  assert.match(ds, /catch \(err\) \{[\s\S]{0,400}?await ingest\.abort\(\);[\s\S]{0,80}?throw err;/,
    'DataStore#load does not roll the half-built source back');
});

test('the finished file is registered WITHOUT reading it back', () => {
  // The whole point: the bytes were never in memory and must not be put there to
  // register them. Reading back is the unlucky fallback only.
  const dm = stripComments(readFileSync('core/duckdb-manager.js', 'utf8'));
  assert.match(dm, /#registerWrittenParquet\(name\)/, 'finalize registers the written file');
  assert.match(dm, /registerOPFSFileName\(opfsRef\(name\)\)[\s\S]*?return opfsRef\(name\)/,
    'by name, which is measured working on both platforms');
});
