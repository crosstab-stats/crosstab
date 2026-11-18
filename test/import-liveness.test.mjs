/**
 * @file import-liveness.test.mjs
 * Two rules every import path has to keep, after a 67 MB CSV broke both.
 *
 * ## 1. A batch is bounded by CELLS, not rows
 *
 * The CSV reader emitted one batch per 50,000 ROWS. That is fine at ten columns and
 * fatal at three thousand: the width decides what a batch costs. A College Scorecard
 * extract went through as a single batch of 21,450,000 values and DuckDB died —
 *
 *     Out of Memory Error: failed to allocate data of size 1.0 MiB (3.1 GiB/3.1 GiB used)
 *
 * — on a file of 67 MB (owner, 2026-11-17). Excel and NDJSON had the identical
 * arithmetic waiting for a wide enough sheet or object.
 *
 * ## 2. Nothing may read the whole file and then parse it in one synchronous go
 *
 * That is what froze the spinner. The parse never yielded, so the one thing on screen
 * saying "still working" was blocked by the work it was reporting — and the import
 * looked like a hang long before it looked like a crash.
 *
 * Neither rule can be checked by running every codec here: three of them need WASM this
 * runner has no DOM for. So these are read against the source, which is the only thing
 * a new codec will have in common with the old ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

/** Every plugin that declares a `codecs:` section, with its source. */
function codecs() {
  const out = [];
  for (const d of readdirSync('plugins', { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const path = `plugins/${d.name}/index.js`;
    if (!existsSync(path)) continue;
    const src = readFileSync(path, 'utf8');
    if (/^\s*codecs:\s*\[/m.test(src)) out.push([d.name, src, path]);
  }
  return out;
}

/** Comments are prose about the rule, not the rule — strip before asserting absence. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('there are codecs to check, so a rename cannot empty this file', () => {
  const found = codecs().map(([n]) => n);
  assert.ok(found.length >= 4, `only found ${found.join(', ')}`);
});

test('no INGEST batch is sliced by a fixed row count', () => {
  // The exact shape of the bug: a constant number of ROWS used as an ingest batch size.
  //
  // Scoped by what the loop DOES, not by what its constant is called. An export loop
  // pulls rows out of the store and hands them to a library — different bound, does not
  // cross into DuckDB, and not what blew up — so the test looks for a loop whose body
  // feeds `app.codec.batch`. Keying on the name instead flagged both export paths and
  // would have kept doing so forever.
  const offenders = [];
  for (const [name, src] of codecs()) {
    const body = code(src);
    for (const m of body.matchAll(/for \(let off = 0; off < [^;]+; off \+= (\w+)\)/g)) {
      const window = body.slice(m.index, m.index + 500);
      if (!/app\.codec\.batch\(/.test(window)) continue; // an export loop
      const id = m[1];
      if (id === 'perBatch') continue; // derived from the width, per file
      offenders.push(`${name}: ingest batch sized by ${id}`);
    }
  }
  assert.deepEqual(offenders, [], 'size an ingest batch by cells (EMIT_CELLS / width), not rows');
});

test('a codec that reads the whole file does not then parse it in one blocking call', () => {
  // `readAll` is the tell. It is legitimate where the format genuinely needs the whole
  // buffer — a .xlsx is a zip — but then the parse must not be the only thing between
  // the read and the first batch, or the UI has nothing to show for the wait.
  for (const [name, src] of codecs()) {
    if (!/async function readAll\(/.test(code(src))) continue;
    // The ones that legitimately need it, and why. A new entry here is a decision.
    assert.ok(
      name === 'builtin-excel-codec',
      `${name} reads the whole file; stream it, or add it here with a reason`,
    );
  }
});

test('the CSV reader streams: it never materialises the file or the cells', () => {
  const src = code(readFileSync('plugins/builtin-csv-codec/index.js', 'utf8'));
  // The three things it used to do, each of which is the OOM on its own.
  assert.ok(!/async function readAll\(/.test(src), 'still reads the whole file');
  assert.ok(!/function tokenize\(text/.test(src), 'still tokenises a whole-file string');
  assert.ok(!/const rows = tokenize/.test(src), 'still builds an array of rows of strings');
  // ...and the two things it must do instead.
  assert.match(src, /decoder\.decode\(u8, \{ stream: true \}\)/, 'decode incrementally');
  assert.match(src, /EMIT_CELLS/, 'batch by cells');
});

test('the CSV reader yields, so the spinner can turn', () => {
  // Without this the parse holds the main thread for the whole file. Every other
  // streaming codec yields incidentally, at the await on its next read; this one says
  // so explicitly because it is the one that got it wrong.
  const src = code(readFileSync('plugins/builtin-csv-codec/index.js', 'utf8'));
  assert.match(src, /setTimeout/, 'no explicit yield in the scan loop');
});

test('every codec can report progress, and the ones with a long silent pass do', () => {
  // The verb has to exist in the sandbox namespace or a codec calling it gets
  // "not a function" at the worst possible moment.
  const host = readFileSync('plugin-host.html', 'utf8');
  assert.match(host, /makeNamespace\('codec', \[[^\]]*'progress'/);
  const broker = readFileSync('core/plugin-broker.js', 'utf8');
  assert.match(broker, /dispatch\['codec\.progress'\]/);

  // CSV is the one with a pass that produces no batches at all — it is counting rows,
  // which is what the progress is about — so it must report from inside that pass.
  const csv = code(readFileSync('plugins/builtin-csv-codec/index.js', 'utf8'));
  assert.match(csv, /app\.codec\.progress\(/);
});

test('the host relays a codec report, including before the schema is known', () => {
  const svc = readFileSync('core/codec-service.js', 'utf8');
  assert.match(svc, /progress: \(done, total/, 'the sink has no progress verb');
  assert.match(svc, /onProgress: \(cb\)/, 'the reader cannot be subscribed to');
  const imp = readFileSync('core/import-service.js', 'utf8');
  // Registered before begin(), or the first pass is unheard — which is exactly the
  // stretch that looked like a hang.
  const at = imp.indexOf('reader.onProgress');
  const begun = imp.indexOf('await reader.begin()');
  assert.ok(at > 0 && begun > 0 && at < begun, 'subscribe before begin(), not after');
});

// =============================================================================
// The chain, end to end — because checking the links is not checking the chain
// =============================================================================

test('every codec verb exists at all four points in the chain', async () => {
  // THE BUG THIS EXISTS FOR. `progress` was added to the sandbox namespace, to the
  // broker's dispatch table, and to the read session's sink — three of the four — and
  // the fourth, the `serviceApi` object the dispatch actually calls, was missed. Every
  // test above passed. The import died on an iPhone with:
  //
  //   plugin crashed during loading: services.codec.progress is not a function
  //
  // (owner, 2026-11-18). Each link was checked; the chain was not. So this walks it.
  const { CodecService } = await import('../core/codec-service.js');
  const svc = new CodecService({ importers: {}, exporters: {}, loader: {}, results: {} });
  const api = new Set(Object.keys(svc.serviceApi));

  const broker = readFileSync('core/plugin-broker.js', 'utf8');
  const dispatched = [...broker.matchAll(/dispatch\['codec\.(\w+)'\]/g)].map((m) => m[1]);
  assert.ok(dispatched.length >= 6, `found only ${dispatched.length} dispatched codec verbs`);

  const host = readFileSync('plugin-host.html', 'utf8');
  const exposed = /makeNamespace\('codec', \[([^\]]*)\]/.exec(host)?.[1] ?? '';
  const inSandbox = new Set([...exposed.matchAll(/'(\w+)'/g)].map((m) => m[1]));

  for (const verb of dispatched) {
    assert.ok(api.has(verb), `broker dispatches codec.${verb}, but serviceApi has no such verb`);
    assert.ok(inSandbox.has(verb), `codec.${verb} is dispatched but not exposed to plugins`);
  }
  // ...and nothing is offered to a plugin that the host cannot answer.
  for (const verb of inSandbox) {
    assert.ok(dispatched.includes(verb), `plugins can call codec.${verb}, but nothing dispatches it`);
  }
});

test('a read verb refuses politely outside a read, rather than being undefined', async () => {
  // `progress` is advisory, but it still goes through the same session guard as the
  // rest: a codec calling it in a write would otherwise reach into a null session.
  const { CodecService } = await import('../core/codec-service.js');
  const svc = new CodecService({ importers: {}, exporters: {}, loader: {}, results: {} });
  for (const verb of ['begin', 'batch', 'progress']) {
    assert.throws(() => svc.serviceApi[verb](), /outside a codec invocation/, verb);
  }
});

// =============================================================================
// Where a dataset is ingested, and how much of it is in memory while that happens
// =============================================================================

test('the wide rule routes on SIZE, and a width term was measured and rejected', async () => {
  const { isWideDataset } = await import('../core/plugin-stdlib.js');
  // The shapes the rule is for.
  assert.equal(isWideDataset(7000, 70000), true, 'the 7k-column GSS');
  assert.equal(isWideDataset(50, 2_000_000), true, 'tall rather than wide');
  assert.equal(isWideDataset(50, 1000), false, 'an ordinary file becomes a table');
  // An unknown row count assumes substantial: guessing small is the guess that crashes.
  assert.equal(isWideDataset(500, -1), true);

  // And the one that is pinned BY A MEASUREMENT rather than by reasoning. A 3,300-column
  // College Scorecard extract is 21 million values — under the threshold — and it is
  // what killed a phone, so routing it out of core was the obvious guess. Measured on
  // desktop: 7.3s and 178 MiB of JS heap through parquet, against 8.7s and 121 MiB as a
  // table. The out-of-core path costs MORE, because it accumulates a row group in JS.
  // If this ever flips to `true`, that measurement has to be redone first.
  assert.equal(isWideDataset(3300, 6500), false);
});

test('a row group is sized by cells, so the wide path is bounded too', async () => {
  const { rowGroupFor } = await import('../core/plugin-stdlib.js');
  // The out-of-core writer accumulates a whole row group in JS before writing it, so
  // the group size IS that path's peak memory. A flat 8,000 rows had the same blind
  // spot as a flat batch size: 26 million values at 3,300 columns, 56 million at 7,000.
  for (const cols of [10, 50, 1200, 3300, 7000]) {
    assert.ok(rowGroupFor(cols) * cols <= 4_000_000, `${cols} columns -> ${rowGroupFor(cols)} rows`);
  }
  // Nothing narrow changes: the old 8,000 is still the cap.
  assert.equal(rowGroupFor(10), 8000);
  assert.equal(rowGroupFor(50), 8000);
  // ...and nothing is driven so small that the file becomes all overhead.
  assert.ok(rowGroupFor(100000) >= 256);
});

test('both codecs route on the SAME rule', async () => {
  // Two copies of a routing decision send the same file down different paths depending
  // on which reader opened it. readstat had the only copy and CSV had none.
  for (const name of ['builtin-csv-codec', 'builtin-readstat-codec']) {
    const src = readFileSync(`plugins/${name}/index.js`, 'utf8');
    assert.match(src, /isWideDataset/, `${name} does not use the shared rule`);
    assert.ok(!/Math\.ceil\(\(varCount \* rows\)/.test(code(src)), `${name} still has its own copy`);
  }
});
