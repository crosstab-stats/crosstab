/**
 * @file offline-transcription.test.mjs
 * The transcription model is cached like every other runtime (#201).
 *
 * The owner asked for "whisper cached same as everything else", and the gap was real:
 * `core/offline.js` mentioned neither transcription nor whisper, so the weights sat
 * outside "Make available offline" while WebR, DuckDB and the R packages were all inside
 * it. A user ticked the toggle, got their analyses and not their transcription, and found
 * out at the point of use — which for the field worker this feature exists for is the
 * worst possible moment.
 *
 * Two halves, and the first is the one that was actually blocking:
 *
 *  1. **`sw.js` gates caching by HOST.** The weights come from `huggingface.co`, which was
 *     not a runtime host, so they could not be cached even opportunistically on first use.
 *     The transformers.js library was already covered by `cdn.jsdelivr.net` — which is why
 *     transcription could begin offline and then fail fetching its model, the most
 *     confusing possible version of the bug.
 *  2. **A prefetch step** that asks for the model rather than listing its files. Which ONNX
 *     files a model needs is transformers.js's business and changes between versions, so a
 *     hardcoded list would be wrong on the next bump and wrong SILENTLY. Loading the
 *     pipeline and letting the service worker cache what it fetches is the strategy the
 *     WebR and DuckDB steps already use.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OFFLINE = readFileSync('core/offline.js', 'utf8');
const TRANSCRIBE = readFileSync('core/transcribe.js', 'utf8');
const WORKER = readFileSync('core/transcribe-worker.js', 'utf8');
const SW = readFileSync('sw.js', 'utf8');

test('the weights host is allowed, or nothing else here matters', () => {
  const block = SW.slice(SW.indexOf('hosts:start'), SW.indexOf('hosts:end'));
  assert.ok(block.includes("'huggingface.co'"), 'the model host is a runtime host');
  // Large files redirect to a CDN host. A cached redirect to an uncacheable target is
  // worse than no cache: it looks present and fails at read time.
  assert.match(block, /cdn-lfs[^']*\.huggingface\.co/, 'and the LFS host it redirects to');
});

test('the warm has a transcription step, and it is LAST', () => {
  const warm = OFFLINE.slice(OFFLINE.indexOf('async #runWarm('), OFFLINE.indexOf('  /**', OFFLINE.indexOf('async #runWarm(')));
  const model = warm.indexOf('#cacheTranscriptionModel');
  const pkgs = warm.indexOf('#cachePackages');
  const ready = warm.indexOf("'Offline ready.'");
  assert.ok(model > 0, 'the step exists');
  assert.ok(pkgs > 0 && model > pkgs, 'after the R packages');
  assert.ok(model < ready, 'and before claiming readiness');
});

test('a model failure does not take the warm down with it', () => {
  // Everything above it is already cached by then. An offline app that cannot transcribe
  // beats an all-or-nothing warm that cached nothing because of an optional model.
  const at = OFFLINE.indexOf('async #cacheTranscriptionModel(');
  const body = OFFLINE.slice(at, OFFLINE.indexOf('\n  }', at));
  assert.match(body, /try \{/, 'it is guarded');
  assert.match(body, /catch/);
  // ...but NOT silently: "offline ready" must not claim something this did not do.
  assert.match(body, /console\.warn/, 'the failure is logged');
  assert.match(body, /onProgress\([^)]*not cached/, 'and reported to the user');
});

test('the prefetch asks for the MODEL, never for a list of files', () => {
  assert.match(TRANSCRIBE, /export function preloadModel\(/);
  const at = TRANSCRIBE.indexOf('export function preloadModel(');
  const body = TRANSCRIBE.slice(at, TRANSCRIBE.indexOf('\n}', at));
  assert.match(body, /type: 'preload'/, 'it sends a preload message');
  // No file list anywhere: that is the whole point. A hardcoded set of .onnx paths would
  // rot at the next transformers.js bump, and rot silently.
  assert.ok(!/\.onnx/.test(body), 'no hardcoded weight filenames');
  // The worker answers it by loading the pipeline and nothing else.
  const wat = WORKER.indexOf("if (type === 'preload')");
  assert.ok(wat > 0, 'the worker handles it');
  // Bounded by the block's OWN closing brace. Two earlier versions got this wrong in the
  // same way and both failed on text outside the code under test: `wat + 500` read into
  // the transcribe handler, and stopping at the next `if (type === …)` swept up that
  // handler's doc comment, which says "an hour of audio is not transferred". Twice is a
  // pattern — when a source-level test slices, it has to slice on structure.
  const wclose = WORKER.indexOf('\n    return;\n  }', wat);
  assert.ok(wclose > wat, 'the preload block ends where it is expected to');
  const wbody = WORKER.slice(wat, wclose);
  assert.match(wbody, /await getAsr\(/, 'by loading the real pipeline');
  assert.ok(!/\bpipe\(|audio|decode/i.test(wbody), 'and running no inference: no audio, no decode');
});

test('the prefetch has a watchdog, because its whole job is the long wait', () => {
  const at = TRANSCRIBE.indexOf('export function preloadModel(');
  const body = TRANSCRIBE.slice(at, TRANSCRIBE.indexOf('\n}', at));
  assert.match(body, /lastSignal = Date\.now\(\)/, 'a clock that resets on any message');
  assert.ok(body.indexOf('lastSignal = Date.now();') < body.indexOf("m.type === 'progress'"),
    'reset BEFORE filtering by type — a download reports progress and nothing else for '
    + 'minutes, so a budget that only accepted a terminal message would kill the very '
    + 'operation it protects');
  assert.match(body, /clearInterval/, 'and it is torn down');
});

test('only the DEFAULT model is pre-fetched, and the choice is stated', () => {
  // base is ~73 MB, small ~238 MB. Caching both triples the download for a choice most
  // users never change; caching neither was the bug. The fallback for someone who does
  // change it is first-use caching, which the host allowance above makes possible.
  const at = OFFLINE.indexOf('async #cacheTranscriptionModel(');
  const body = OFFLINE.slice(at - 2000, OFFLINE.indexOf('\n  }', at));
  assert.match(body, /size: 'base'/, 'the default only');
  assert.ok(!/size: 'small'/.test(body), 'not both');
  assert.match(body, /opportunistic/i, 'and the weaker guarantee for the other is written down');
});
