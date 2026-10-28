/**
 * @file transcribe.test.mjs
 * On-device transcription (#139 Phase 2) — the parts that are not a model.
 *
 * The models themselves are measured in `spike/whisper-spike.html` and recorded in
 * `spike/RESULTS.md`; nothing here re-runs a 39 MB download. What IS tested is everything
 * a wrong answer would come from after the model returns: the WebVTT the importer has to
 * read, the speaker labelling, and the clustering that turns embeddings into turns.
 *
 * ## The two decisions these assertions protect
 *
 * **WebVTT, not a new shape.** `builtin-caqdas`'s `sniffTranscript` already recognises it
 * and `parseTranscript` already handles `<v Speaker>` voice spans, cue timings and the
 * offset bookkeeping that keeps a coded highlight on the right words. If this emitted its
 * own format there would be two to keep in step, and only one of them has a coding surface.
 *
 * **Speakers without text is a first-class output.** Whisper knows 99 languages and none
 * of them is Navajo, Quechua or any Australian Aboriginal language — and it does not fail
 * on one, it returns fluent fabrication in the nearest language it knows. Diarization needs
 * no language support at all, so a turn-structured skeleton with empty cues is the useful
 * thing for exactly the recordings transcription cannot touch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toVtt, speakerName, WHISPER_LANGUAGES, MODEL_SIZES } from '../core/transcribe.js';

// =============================================================================
// WebVTT — the format the existing importer reads
// =============================================================================

test('cues become WebVTT the caqdas sniffer recognises', () => {
  const vtt = toVtt({
    chunks: [
      { start: 0, end: 2.5, text: 'Hello there.', speaker: 0 },
      { start: 2.5, end: 5, text: 'General Kenobi.', speaker: 1 },
    ],
  });
  assert.match(vtt, /^WEBVTT\n/);
  // `sniffTranscript` keys on a `-->` line with a POINT decimal (a comma would be SRT).
  assert.match(vtt, /00:00:00\.000 --> 00:00:02\.500/);
  assert.match(vtt, /<v Speaker 1>Hello there\./);
  assert.match(vtt, /<v Speaker 2>General Kenobi\./);
});

test('the timestamps are the format parseTimestamp accepts', () => {
  // HH:MM:SS.mmm, zero-padded. An hour-plus recording must not produce `1:2:3.4`.
  const vtt = toVtt({ chunks: [{ start: 3723.004, end: 3725, text: 'late', speaker: null }] });
  assert.match(vtt, /01:02:03\.004 --> 01:02:05\.000/);
});

test('no speaker means no voice span, not an empty one', () => {
  const vtt = toVtt({ chunks: [{ start: 0, end: 1, text: 'anonymous', speaker: null }] });
  assert.doesNotMatch(vtt, /<v/);
  assert.match(vtt, /\nanonymous\n/);
});

test('SPEAKERS-ONLY still produces cues, which is the point of it', () => {
  // The output for a language Whisper cannot transcribe: a turn-structured skeleton to
  // type into. Empty bodies are deliberate, not a degenerate case.
  const vtt = toVtt({
    turns: [{ speaker: 0, start: 0, end: 12 }, { speaker: 1, start: 12, end: 24 }],
  });
  assert.match(vtt, /00:00:00\.000 --> 00:00:12\.000\n<v Speaker 1>/);
  assert.match(vtt, /00:00:12\.000 --> 00:00:24\.000\n<v Speaker 2>/);
});

test('chunks win over turns when both are present', () => {
  // `both` mode labels its cues from the turns, so emitting turns as well would print
  // every moment twice.
  const vtt = toVtt({
    chunks: [{ start: 0, end: 1, text: 'said', speaker: 0 }],
    turns: [{ speaker: 0, start: 0, end: 60 }],
  });
  assert.equal((vtt.match(/-->/g) ?? []).length, 1);
});

test('an empty result is still valid WebVTT', () => {
  assert.match(toVtt({}), /^WEBVTT/);
  assert.match(toVtt({ chunks: [], turns: [] }), /^WEBVTT/);
});

test('speakers are numbered from one, because nobody is Speaker 0', () => {
  assert.equal(speakerName(0), 'Speaker 1');
  assert.equal(speakerName(3), 'Speaker 4');
  assert.equal(speakerName(null), '');
  assert.equal(speakerName(undefined), '');
});

// =============================================================================
// The language list — a limit that has to be VISIBLE
// =============================================================================

test('the language list is Whisper’s real 99, not a hopeful selection', () => {
  // Read from the model’s own generation_config.json. The count matters because the
  // dialog shows this list: if it drifts, the UI starts promising languages the model
  // cannot do, which fails as fluent fabrication rather than as an error.
  assert.equal(WHISPER_LANGUAGES.length, 99);
  const codes = new Set(WHISPER_LANGUAGES.map(([c]) => c));
  for (const present of ['en', 'es', 'zh', 'haw', 'mi', 'yo', 'sw', 'bo', 'ht']) {
    assert.ok(codes.has(present), `${present} should be supported`);
  }
  // And the absences that matter for Ethnic Studies, Cultural Anthropology and
  // Linguistics. Asserted so that nobody "helpfully" pads the list with a code Whisper
  // has no token for — the model would then silently transcribe into a neighbour.
  for (const absent of ['nv', 'chr', 'lkt', 'oj', 'qu', 'gn', 'ay', 'yua']) {
    assert.ok(!codes.has(absent), `${absent} is NOT supported and must not be listed`);
  }
});

test('every language has a readable name', () => {
  for (const [code, name] of WHISPER_LANGUAGES) {
    assert.match(code, /^[a-z]{2,3}$/, code);
    assert.ok(name && name !== code, `${code} needs a name`);
  }
});

test('the model sizes name their real download and their measured cost', () => {
  // The numbers are in the labels because the dialog shows them, and "Base/Small" alone
  // tells a user nothing about a 238 MB commitment on a phone or forty minutes of waiting.
  const byId = Object.fromEntries(MODEL_SIZES.map((m) => [m.id, m]));
  assert.match(byId.base.label, /73 MB/);
  assert.match(byId.small.label, /238 MB/);
  assert.match(byId.base.label, /per hour of audio/);
  assert.match(byId.small.label, /per hour/);

  // The labels must NOT use Whisper's own size names. In a two-item menu "Base" and
  // "Small" read as a bug, because the "small" one is the bigger download and the slower
  // run — the owner spotted it immediately. A user is choosing between finishing sooner
  // and reading fewer mistakes, so the label says that.
  for (const m of MODEL_SIZES) {
    assert.doesNotMatch(m.label, /(base|small|tiny|large)/i,
      `"${m.label}" leaks an upstream model name into the menu`);
  }
  // But the upstream name is still recorded, because a transcript in a methods section
  // has to say which model produced it.
  assert.equal(byId.base.detail, 'Whisper base');
  assert.equal(byId.small.detail, 'Whisper small');
  // Faster first: the cheaper choice should be the one a user lands on by default.
  assert.equal(MODEL_SIZES[0].id, 'base');
  assert.ok(MODEL_SIZES[0].realTime > MODEL_SIZES[1].realTime);
  for (const m of MODEL_SIZES) {
    assert.ok(m.accuracy > 0 && m.accuracy < 1, `${m.id} carries a measured accuracy`);
    assert.ok(m.realTime > 0, `${m.id} carries a measured speed`);
  }
});

test('TINY IS NOT OFFERED, because it does not work', () => {
  // Measured against the AMI human transcript over the full 17.7 minutes: 174.7% word
  // error rate, 5189 words emitted where 2633 were spoken, unique-word ratio 0.063 against
  // the human transcript's 0.237. It collapses into repetition loops, and the loop makes
  // it SLOWER than base in wall-clock terms as well. There is no case for shipping it.
  assert.equal(MODEL_SIZES.find((m) => m.id === 'tiny'), undefined);
  // The reason lives in a comment beside the table, so read the file rather than the
  // comment-stripped form `codeOf` produces.
  assert.match(readFileSync('core/transcribe.js', 'utf8'), /repetition loops/i,
    'and the reason is written down where it was removed');
  const src = codeOf('core/transcribe.js');
  // Nothing may quietly default back to it.
  assert.doesNotMatch(src, /size = 'tiny'/, 'no default of tiny survives');
  assert.doesNotMatch(src, /opts\.size \?\? 'tiny'/, 'nor in the service');
  const worker = codeOf('core/transcribe-worker.js');
  assert.doesNotMatch(worker, /size = 'tiny'/, 'nor in the worker');
  assert.doesNotMatch(worker, /WHISPER\.tiny/, 'nor as a fallback for an unknown size');
});

test('a batch is a QUEUE of inspectable records, not a callback', async () => {
  // Seven interviews is an ordinary afternoon, and a modal is the wrong shape for it: it
  // blocks the very checking the user wants to do while the rest churn. And a callback
  // cannot cross the broker, so a plugin owning the UI has to be able to PULL.
  const { createTranscribeService } = await import('../core/transcribe.js');
  const svc = createTranscribeService({});
  const empty = svc.status();
  assert.deepEqual(empty.jobs, []);
  assert.equal(empty.paused, false);
  assert.ok(empty.capacity, 'a UI can explain why only one runs at a time');

  for (const method of ['enqueue', 'status', 'result', 'cancel', 'pause', 'resume', 'forget']) {
    assert.equal(typeof svc[method], 'function', `${method} is part of the queue API`);
  }

  // `status()` must be safe to poll: a transcript of an hour of speech has no business
  // being copied on every tick, so it is fetched by id when a job finishes.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /const summarise = /);
  assert.doesNotMatch(src.slice(src.indexOf('const summarise'), src.indexOf('const summarise') + 400),
    /result/, 'the summary carries no transcript');
  assert.match(src, /result\(id\)/, 'which is fetched separately');
});

test('a queued job can be cancelled before it ever starts', async () => {
  const { createTranscribeService } = await import('../core/transcribe.js');
  const svc = createTranscribeService({});
  // decodeAudio needs an AudioContext, which Node has not got — so this exercises the
  // record-keeping, which is the part a UI depends on.
  const { id } = svc.enqueue(new Uint8Array([1, 2, 3]), { name: 'interview 1' });
  const before = svc.status().jobs.find((j) => j.id === id);
  assert.equal(before.name, 'interview 1');
  assert.equal(before.state, 'queued');
  assert.equal(svc.cancel(id), true);
  assert.equal(svc.status().jobs.find((j) => j.id === id).state, 'cancelled');
  // And a cancelled job can be forgotten, so a long session does not accumulate.
  assert.equal(svc.forget(id), true);
  assert.equal(svc.status().jobs.length, 0);
});

test('pause stops the NEXT segment, not the current one', async () => {
  // There is no cooperative yield inside a model call, so a running segment always
  // finishes. Because the work is segmented, that means a pause lands within a couple of
  // minutes rather than at the end of the batch — which is the difference between a
  // usable button and a decorative one.
  const { createPool } = await import('../core/transcribe-pool.js');
  const pool = createPool();
  let started = 0;
  const gate = [];
  const mk = () => pool.run(() => new Promise((res) => { started += 1; gate.push(res); }));
  const a = mk();
  const b = mk();
  await new Promise((r) => { setTimeout(r, 0); });
  assert.equal(started, 1, 'one running');
  pool.pause();
  assert.equal(pool.paused, true);
  gate.shift()();                       // the running one finishes
  await a;
  await new Promise((r) => { setTimeout(r, 0); });
  assert.equal(started, 1, 'and the next one does NOT start');
  pool.resume();
  await new Promise((r) => { setTimeout(r, 0); });
  assert.equal(started, 2, 'until resumed');
  gate.shift()();
  await b;
});

test('long recordings are segmented, and the thresholds are measured not guessed', async () => {
  const { SEGMENT_SECONDS, SEGMENT_ABOVE_SECONDS } = await import('../core/transcribe.js');
  // 120 s because segmentation at that length measured free: 37.3% word error rate
  // segmented against 37.6% in one call, and 8.9% FASTER on a single worker.
  assert.equal(SEGMENT_SECONDS, 120);
  assert.ok(SEGMENT_ABOVE_SECONDS > SEGMENT_SECONDS,
    'a recording must be longer than one segment before splitting is worth the bookkeeping');

  const src = codeOf('core/transcribe.js');
  assert.match(src, /seconds > SEGMENT_ABOVE_SECONDS/, 'the service chooses by duration');
  // Segments are copied as they are dispatched, not all up front: holding the whole
  // interview is the thing that crashed a phone.
  assert.match(src, /audio\.subarray\(from/, 'one segment at a time');
});

test('NO overlap and NO deduplication, because both were measured and neither helped', async () => {
  // Four stitching rules scored against the AMI human transcript on identical audio:
  //   plain cut, no overlap              37.3%   <- simplest, and best
  //   silence-snapped cut                37.8%
  //   8 s overlap + trim + word dedup    38.2%
  //   8 s overlap + timestamp trim       38.3%
  //   8 s overlap, naive concat          41.3%
  // The dedup WORKS - it takes insertions from 44 to 26 against 21 for no overlap at all -
  // it just never earns back what overlap costs. This test exists so the machinery is not
  // reintroduced later on the reasonable-sounding theory that it must help.
  const raw = readFileSync('core/transcribe.js', 'utf8');
  assert.match(raw, /NO OVERLAP AND NO DEDUPLICATION/,
    'the decision is recorded where someone would otherwise add overlap');
  assert.match(raw, /37\.3%/, 'with the number that settled it');
  // Narrowly: no overlap ARITHMETIC. The word itself appears legitimately in LIMITATIONS,
  // which is about people talking over each other — a different thing entirely.
  const src = codeOf('core/transcribe.js');
  assert.doesNotMatch(src, /overlapSeconds|OVERLAP_SECONDS|\+\s*over/,
    'no overlap term survives in the segment arithmetic');
  assert.match(src, /from \+ step\)/, 'a segment is exactly one step long');
});

test('speakers are identified once over the whole recording, never per segment', async () => {
  // Speaker identity is global. Cluster each segment separately and "Speaker 1" means a
  // different person in every one, which is worse than no labels at all.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /mode: 'speakers'/, 'a separate whole-file pass');
  assert.match(src, /speakerAt\(turns/, 'and the segments are matched to its turns after');
  const raw = readFileSync('core/transcribe.js', 'utf8');
  assert.match(raw, /Speaker 1" means a different person/i, 'the reason is written down');
});

test('a segmented job reports real progress, not an estimate', () => {
  const src = codeOf('core/transcribe.js');
  assert.match(src, /type: 'segments'/, 'segments finished out of segments total');
  const app = codeOf('core/app.js');
  assert.match(app, /p\.type === 'segments'/, 'and the host renders it');
  assert.match(app, /part \$\{p\.done\} of \$\{p\.total\}/);
});

test('video is supported, and the reason is written down', async () => {
  // ETHN has faculty working from video recordings of oral histories, so "can it take an
  // MP4" is a real question with a real answer. decodeAudioData demuxes the container and
  // decodes the audio track: verified against a 45.9 MB H.264 + AAC film, which yielded
  // 663.3 s of audio against a published running time of 664 s.
  const src = readFileSync('core/transcribe.js', 'utf8');
  assert.match(src, /VIDEO WORKS/, 'a caller should not have to guess');
  assert.match(src, /MKV and AVI/, 'and the exceptions are named');
});

test('a reused ArrayBuffer fails with a sentence, not a shrug', async () => {
  // decodeAudioData DETACHES an ArrayBuffer but copies a TypedArray, so a retry after a
  // failed decode hands over an empty buffer. The browser's own message for that is
  // "Unable to decode audio data", which blames the file.
  const { decodeAudio } = await import('../core/transcribe.js');
  const detached = new ArrayBuffer(0);
  await assert.rejects(() => decodeAudio(detached), /already been used/);
  await assert.rejects(() => decodeAudio(detached), /read the file again/,
    'and it says what to do about it');
});

test('what it CANNOT do is stated, not buried', async () => {
  const { LIMITATIONS } = await import('../core/transcribe.js');
  const fillers = LIMITATIONS.find((l) => l.id === 'disfluencies');
  assert.ok(fillers, 'the filler loss is a named limitation');
  // Measured: 17 of 168 filler tokens kept, and filler rate varies 1.9x between speakers.
  // Somebody comparing disfluency across speakers would get a confident, false number.
  assert.match(fillers.detail, /17 of 168/);
  assert.match(fillers.detail, /import the transcript/i, 'and says what to do instead');
  for (const l of LIMITATIONS) {
    assert.ok(l.id && l.short && l.detail, `${l.id} needs a short form and a detail`);
  }

  // It must reach the two places a user or a caller can actually see it.
  const app = codeOf('core/app.js');
  assert.match(app, /LIMITATIONS/, 'the progress dialog shows it every run');
  const src = codeOf('core/transcribe.js');
  assert.match(src, /limitations: LIMITATIONS/, 'and the result carries it onward');
});

test('a long job shows a clock, so it cannot look like a hang', () => {
  // transformers.js exposes no per-chunk callback, so between "model downloaded" and
  // "done" there is one opaque await — twenty minutes on an hour of audio. Silence that
  // long is indistinguishable from a crash.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /setInterval/, 'a heartbeat exists');
  assert.match(src, /type: 'elapsed'/);
  assert.match(src, /clearInterval/, 'and it stops when the job does');
  const app = codeOf('core/app.js');
  assert.match(app, /p\.type === 'elapsed'/, 'and the host renders it');
  assert.match(app, /longer than estimated/, 'including when the estimate is beaten');
});

// =============================================================================
// It is a CAPABILITY, not a privileged feature
// =============================================================================

test('transcription is exposed to plugins, like zip and state.read', async () => {
  // The owner's architectural point, and the project's own rule: everything is a plugin
  // except where technically not possible. Core owns the worker and the model fetch
  // because a sandbox can have neither — an opaque-origin frame cannot create a Worker
  // (measured, see plugin-sandbox.js) and every CSP tier is connect-src 'none'. Nothing
  // beyond that is forced, so nothing beyond that should be core's.
  const broker = codeOf('core/plugin-broker.js');
  assert.match(broker, /if \(services\.transcribe\) \{/, 'conditional, like zip');
  assert.match(broker, /'transcribe\.run'/);
  assert.match(broker, /'transcribe\.options'/);

  const host = readFileSync('plugin-host.html', 'utf8');
  // The queue is part of the capability too: a plugin owning a transcription tab needs
  // enqueue/status/result/cancel/pause/resume, and every one of them is plain data in
  // both directions — which is exactly why they can cross the broker at all.
  assert.match(host, /transcribe: makeNamespace\('transcribe', \['run', 'options', 'enqueue',/);
  for (const m of ['enqueue', 'status', 'result', 'cancel', 'pause', 'resume', 'forget']) {
    assert.match(broker, new RegExp(`'transcribe\.${m}'`), `${m} is brokered`);
  }

  const app = codeOf('core/app.js');
  assert.match(app, /services\.transcribe = createTranscribeService\(/);
});

test('options() reports the model’s own truth, so a plugin dialog cannot drift', async () => {
  const { createTranscribeService } = await import('../core/transcribe.js');
  const svc = createTranscribeService({});
  const o = svc.options();
  assert.equal(o.languages.length, 99);
  assert.ok(o.languages.every((l) => l.code && l.name));
  assert.deepEqual(o.sizes.map((x) => x.id), ['base', 'small']);
  // A caller building a dialog can show the caveats before someone spends twenty minutes
  // discovering them.
  assert.ok(Array.isArray(o.limitations) && o.limitations.length >= 1);
  assert.ok(o.limitations.some((l) => l.id === 'disfluencies'));
  // Speakers-only must be offered, and must say why it is different — it is the mode
  // that works for the languages Whisper has never heard of.
  const speakers = o.modes.find((m) => m.id === 'speakers');
  assert.ok(speakers, 'speakers-only is an offered mode');
  assert.match(speakers.label, /any language/i);
});

test('a second job is QUEUED, not refused', async () => {
  // This asserted the opposite until 2026-10-27. The refusal was justified by "two models
  // and an hour of audio in parallel is how a phone runs out of memory" — never measured,
  // and wrong as policy besides: transcribing a set of interviews is an ordinary need, and
  // one weak device should not cap every device. See transcribe-pool.test.mjs for what the
  // measurement actually says (219 MB per worker, linear, fully reclaimed).
  const { createTranscribeService } = await import('../core/transcribe.js');
  const svc = createTranscribeService({});
  assert.equal(svc.busy, false);
  const src = codeOf('core/transcribe.js');
  assert.doesNotMatch(src, /already running/, 'no blanket refusal');
  // `p` is the pool inside execute(); what matters is that work is scheduled through it
  // rather than started directly, which is what makes the limit mean anything.
  assert.match(src, /p\.run\(/, 'it goes through the pool');
  assert.match(src, /schedule: \(fn\) => p\.run\(fn\)/, 'segments too');
  // And the pool's limit is reportable, because "running 2 at a time" needs a because.
  const cap = svc.capacity;
  assert.ok(cap.limit >= 1);
  assert.ok(cap.basis, 'the limit can explain itself');
  assert.equal(typeof svc.setConcurrency, 'function', 'and the user can override it');
});

test('progress and cancel are HOST-rendered for a single run', () => {
  // The same wall that made Layer 3b's `onRedraw` undeliverable: a function does not
  // survive a structured clone. For ONE file the host draws the dialog, as it already
  // does for webr.installPackages. For a BATCH the answer is different — see the queue
  // test below, which is pull-based precisely because of this wall.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /showProgress\?\.\(/);
  assert.match(src, /onCancel: \(\) => handle\.cancel\(\)/);
  const app = codeOf('core/app.js');
  assert.match(app, /showProgress: \(\{ title, hint, onCancel \}\)/);
  // And it says the data stays put, because a model download looks like an upload to
  // someone watching a progress bar on their own interview recording.
  assert.match(app, /showModal\(\)/);
  const svc = readFileSync('core/transcribe.js', 'utf8');
  assert.match(svc, /Everything stays on this device/);
});

// =============================================================================
// The worker's own decisions, read from its source
// =============================================================================

/**
 * Source with comments stripped.
 *
 * These assertions mean "the CODE does not do this", not "the word never appears" — and
 * the comment explaining WHY the segmentation model is unused is worth keeping, so a raw
 * text scan would forbid the documentation of its own rule.
 */
const codeOf = (path) => readFileSync(path, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const worker = codeOf('core/transcribe-worker.js');

test('the multilingual model is the default, not the .en build', () => {
  // `whisper-tiny` is the SAME 39 MB as `whisper-tiny.en` and covers 99 languages, so the
  // English-only build buys nothing and costs everyone else.
  assert.match(worker, /tiny: 'onnx-community\/whisper-tiny'/);
  assert.doesNotMatch(worker, /whisper-tiny\.en/);
});

test('the segmentation model is NOT used', () => {
  // It found the right speaker COUNT and then alternated them 29 times across three
  // turns — a frame-level activity detector, not an identity model. Identity comes from
  // embeddings. Asserted so it does not get reintroduced as an optimisation.
  assert.doesNotMatch(worker, /pyannote/);
  assert.match(worker, /wespeaker-voxceleb-resnet34-LM/);
});

test('a known speaker count caps the roster', () => {
  // An interview usually has a known headcount, and saying so beats tuning a cosine
  // threshold by eye — 0.25 gave 2 speakers on the ground-truth clip and 0.65 gave 11.
  assert.match(worker, /roomForMore/);
  assert.match(worker, /bestSim >= threshold \|\| !roomForMore/);
});

test('cancel terminates rather than setting a flag and hoping', () => {
  // There is no cooperative yield inside an ONNX call, so a flag alone leaves the tab
  // busy until the chunk finishes.
  const host = codeOf('core/transcribe.js');
  assert.match(host, /worker\.terminate\(\)/);
  assert.match(host, /cancel\(\)/);
});

test('audio is transferred, not copied', () => {
  // An hour of 16 kHz mono is ~230 MB; structured-cloning it would double that.
  const host = codeOf('core/transcribe.js');
  assert.match(host, /\[audio\.buffer\]/);
});

test('the worker is told where its library lives', () => {
  // A vendored / air-gapped build must not reach the CDN. Same rule as every other
  // runtime: assets.js decides, the consumer does not.
  const host = codeOf('core/transcribe.js');
  assert.match(host, /getAssets\(\)\?\.transformersUrl/);
  const assets = readFileSync('core/assets.js', 'utf8');
  assert.match(assets, /transformersUrl: 'https:\/\/cdn\.jsdelivr\.net/, 'pinned CDN default');
  assert.match(assets, /transformersUrl: '\.\/vendor\//, 'and a local path for air-gap');
});
