/**
 * @file import-missing-codes.test.mjs
 * The host side of the missing-value-code question (the codec side is
 * csv-missing-codes.test.mjs).
 *
 * ## What it is for
 *
 * MERGED2025_26_PP.csv types 13 of 3,379 columns as numeric; 3,347 are numbers wearing
 * "NA" or "PS". The codec detects the codes and asks; this is the asking.
 *
 * ## The two things that have actually gone wrong here before
 *
 * 1. THE CHAIN. `progress` was added to the sandbox namespace, the broker's dispatch
 *    table and the read session's sink — three of four — and the `serviceApi` object the
 *    dispatch actually calls was missed. Every unit test passed and the import died on
 *    an iPhone with `services.codec.progress is not a function`. import-liveness walks
 *    that chain generically; what is pinned here is that the verb refuses outside a read
 *    like its siblings, and that the sink defaults to "no codes" so a host that never
 *    answers reproduces the old typing.
 *
 * 2. THE ARITHMETIC. The per-value column counts do not sum to the answer: a column
 *    blocked by both codes is recovered by neither alone. On the owner's file the two
 *    candidates report 2,933 and 504 columns, which sums to 3,437 for a true answer of
 *    3,347. The hint must not print the sum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' }, configurable: true,
});
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  configurable: true,
});

const { missingCodesPrompt } = await import('../core/import-service.js');
const { CodecService } = await import('../core/codec-service.js');

/** The owner's actual proposal, as the CSV codec sends it. */
const REAL = {
  candidates: [
    { value: 'NA', values: 15671641, columns: 2933 },
    { value: 'PS', values: 2623088, columns: 504 },
  ],
  combos: [
    { codes: ['NA'], columns: 2843 },
    { codes: ['PS'], columns: 414 },
    { codes: ['NA', 'PS'], columns: 90 },
  ],
  omitted: 0,
};

// =============================================================================
// The prompt
// =============================================================================

test('nothing to propose means nothing to ask', () => {
  assert.equal(missingCodesPrompt('x.csv', { candidates: [] }), null);
  assert.equal(missingCodesPrompt('x.csv', {}), null);
  assert.equal(missingCodesPrompt('x.csv', undefined), null);
});

test('every candidate starts ticked — the detector proposes, the user disposes', () => {
  const p = missingCodesPrompt('MERGED2025_26_PP.csv', REAL);
  assert.deepEqual(p.items.map((i) => i.value), ['NA', 'PS']);
  assert.deepEqual(p.selected, ['NA', 'PS']);
  assert.equal(p.multiple, true);
});

test('each code is labelled with what it costs', () => {
  const p = missingCodesPrompt('MERGED2025_26_PP.csv', REAL);
  assert.match(p.items[0].label, /^NA — 15,671,641 values in 2,933 columns$/);
  assert.match(p.items[1].label, /^PS — 2,623,088 values in 504 columns$/);
});

test('the hint reports 3,347 — NOT the 3,437 a sum would give', () => {
  const p = missingCodesPrompt('MERGED2025_26_PP.csv', REAL);
  assert.match(p.hint, /3,347 more columns numeric/);
  assert.doesNotMatch(p.hint, /3,437/, 'the per-value counts must not be summed');
  assert.match(p.hint, /MERGED2025_26_PP\.csv/, 'and it says which file');
});

test('the hint says what Cancel does, because Cancel still imports', () => {
  const p = missingCodesPrompt('x.csv', REAL);
  assert.match(p.hint, /Cancel imports everything as text/);
});

test('a truncated candidate list says so', () => {
  const p = missingCodesPrompt('x.csv', { ...REAL, omitted: 8 });
  assert.match(p.hint, /8 rarer values are not listed/);
  const q = missingCodesPrompt('x.csv', REAL);
  assert.doesNotMatch(q.hint, /not listed/, 'and stays quiet when nothing was dropped');
});

test('no recoverable columns means no claim about them', () => {
  const p = missingCodesPrompt('x.csv', { candidates: REAL.candidates, combos: [] });
  assert.doesNotMatch(p.hint, /more columns numeric/);
});

// =============================================================================
// The verb, at the points the chain has broken before
// =============================================================================

test('missingCodes refuses outside a read, like its siblings', async () => {
  const svc = new CodecService({ importers: {}, exporters: {}, loader: {}, results: {} });
  assert.throws(() => svc.serviceApi.missingCodes({}), /outside a codec invocation/);
});

test('the verb exists at the broker and in the sandbox', async () => {
  const { readFileSync } = await import('node:fs');
  const broker = readFileSync('core/plugin-broker.js', 'utf8');
  assert.match(broker, /dispatch\['codec\.missingCodes'\]/, 'the broker dispatches it');
  const host = readFileSync('plugin-host.html', 'utf8');
  const exposed = /makeNamespace\('codec', \[([^\]]*)\]/.exec(host)?.[1] ?? '';
  assert.match(exposed, /'missingCodes'/, 'plugins can call it');
  const svc = new CodecService({ importers: {}, exporters: {}, loader: {}, results: {} });
  assert.ok('missingCodes' in svc.serviceApi, 'and the host can answer it');
});

/**
 * Drive a real read session and have the "codec" ask the question through `serviceApi` —
 * the same object the broker's dispatch calls, which is the link that has been missed
 * before. Returns what the codec got back.
 *
 * @param {?Function} listener what the host registers via `reader.onMissingCodes`
 */
async function askThroughRealSession(listener, proposal) {
  let captured = null;
  let got;
  let svc;
  svc = new CodecService({
    importers: { registerCodec: (s) => { captured = s; return () => {}; } },
    exporters: { register: () => () => {} },
    // Stands in for the plugin: asks the way a codec asks, mid-read.
    loader: { invoke: async () => { got = await svc.serviceApi.missingCodes(proposal); } },
    results: {},
  });
  svc.register({ id: 't', label: 'T', extensions: ['.t'], pluginId: 'p', read: 'readT' });
  const reader = captured.startRead(new Blob(['x']));
  // This read never calls begin(), so begin() rejects; nothing here awaits it.
  reader.begin().catch(() => {});
  if (listener) reader.onMissingCodes(listener);
  await reader.drain(() => {});
  return got;
}

test('an unanswered question is "no codes", so the old typing is reproduced', async () => {
  // The guarantee both negative controls in csv-missing-codes.test.mjs rest on: a host
  // that registers no listener must not leave the codec waiting, or throw at it.
  const got = await askThroughRealSession(null, { candidates: [{ value: 'NA', values: 2, columns: 1 }] });
  assert.deepEqual(got, []);
});

test('the proposal reaches the host and the answer reaches the codec', async () => {
  let seen = null;
  const got = await askThroughRealSession((p) => { seen = p; return ['NA']; }, REAL);
  assert.deepEqual(got, ['NA'], 'the codec got what the host chose');
  assert.deepEqual(seen.candidates.map((c) => c.value), ['NA', 'PS'], 'the host saw the proposal');
  assert.equal(seen.combos.length, 3, 'including the combination arithmetic');
});

test('a host that answers with junk is treated as "no codes"', async () => {
  assert.deepEqual(await askThroughRealSession(() => null, REAL), []);
  assert.deepEqual(await askThroughRealSession(() => 'NA', REAL), [], 'a bare string is not a list');
});
