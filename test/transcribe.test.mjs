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
import {
  toVtt,
  speakerName,
  WHISPER_LANGUAGES,
  MODEL_SIZES,
  sampleForDetection,
  summariseDetection,
  DETECT_WINDOWS,
  DETECT_WINDOW_SECONDS,
  LIMITATIONS,
  parseClock,
  formatClock,
  sliceRange,
  shiftTiming,
  normaliseRange,
} from '../core/transcribe.js';

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
  // 99 languages plus "Detect automatically", which is first and is the default.
  assert.equal(o.languages.length, 100);
  assert.equal(o.languages[0].code, '', 'detect is the first entry');
  assert.match(o.languages[0].name, /detect/i);
  assert.ok(o.languages.slice(1).every((l) => l.code && l.name));

  // ALPHABETICAL by name. The source list is in ISO-code order, which renders as
  // Bengali, Tibetan, Breton, Bosnian, Catalan — indistinguishable from a bug.
  const names = o.languages.slice(1).map((l) => l.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')),
    'languages are sorted by name, not by code');

  // And detecting is what happens when nobody chooses: forcing English is a guess that
  // is silently wrong for every recording that is not in English.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /language = ''/, 'transcribe() detects by default');
  assert.ok(o.limitations.some((l) => l.id === 'language'),
    'and the risk of an unknown language is stated');
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

// ---------------------------------------------------------------------------------
// Language detection.
//
// transformers.js 4.3.1 does NOT detect — `_retrieve_init_tokens` warns "No language
// specified - defaulting to English (en)" and forces English. Measured consequence,
// before any of this existed: 30 s of French LibriVox came back as "even today, what
// crime did I commit?" — fluent English, no error, nothing for a user to notice. So
// detection is ours, and these are the parts of it that are pure.
// ---------------------------------------------------------------------------------

test('detection samples across the recording, not just the opening', () => {
  // The case that motivated it: an interviewer's English preamble in front of an
  // interview in another language. If sampling read only the first window the whole file
  // would be transcribed as the preamble's language.
  const audio = new Float32Array(20 * 60 * 16000).fill(0.2);
  const picked = sampleForDetection(audio);

  assert.equal(picked.length, DETECT_WINDOWS);
  assert.ok(picked[0].at > 0, 'the first window is not the very start of the file');
  const ats = picked.map((w) => w.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b), 'in order');
  assert.ok(ats.at(-1) > 15 * 60, 'and the last window is late in the recording');
  for (const w of picked) {
    assert.equal(w.pcm.length, DETECT_WINDOW_SECONDS * 16000);
  }
});

test('a recording shorter than one window is used whole', () => {
  const audio = new Float32Array(10 * 16000).fill(0.2);
  const picked = sampleForDetection(audio);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].at, 0);
  assert.equal(picked[0].pcm.length, audio.length);
});

test('empty audio gives nothing to detect from', () => {
  assert.deepEqual(sampleForDetection(new Float32Array(0)), []);
  assert.deepEqual(sampleForDetection(null), []);
});

test('silent windows are skipped — there is no speech in them to be in any language', () => {
  // Twenty minutes of silence with speech only in the last quarter. A silent window
  // scores confidently and arbitrarily, so a vote from one is worse than no vote.
  const audio = new Float32Array(20 * 60 * 16000);
  audio.fill(0.2, Math.floor(audio.length * 0.75));
  const picked = sampleForDetection(audio);

  assert.ok(picked.length >= 1);
  assert.ok(picked.length < DETECT_WINDOWS, 'the quiet windows did not get a vote');
  for (const w of picked) assert.ok(w.at > 10 * 60, 'only the windows with speech in them');
});

test('if the whole recording is quiet the loudest window is used anyway', () => {
  // A weak guess beats having nothing to guess from: returning [] here would send the
  // transcription down the library's silent-English path instead.
  const audio = new Float32Array(20 * 60 * 16000).fill(0.0001);
  const loudAt = Math.floor(audio.length * 0.5);
  audio.fill(0.004, loudAt, loudAt + 16000);
  const picked = sampleForDetection(audio);
  assert.equal(picked.length, 1);
});

test('detection sums probabilities rather than counting votes', () => {
  // One window certain, three barely leaning. Counting votes would answer "de" 3-1;
  // summing answers "fr", which is what you want when one window caught clear speech
  // and the others caught cross-talk.
  const perWindow = [
    [['fr', 0.99], ['en', 0.01]],
    [['de', 0.34], ['fr', 0.33]],
    [['de', 0.34], ['fr', 0.33]],
    [['de', 0.34], ['fr', 0.33]],
  ];
  const out = summariseDetection(perWindow, perWindow.map((_, i) => ({ at: i * 60 })));
  assert.equal(out.code, 'fr');
  assert.equal(out.name, 'French');
  assert.equal(out.runnerUp.code, 'de');
  assert.ok(out.confidence > 0 && out.confidence <= 1, 'confidence is a mean, so a share');
});

test('a confidently disagreeing window is reported as mixed, not averaged away', () => {
  // The code-switching signal. Half an interview in Spanish is not noise to be smoothed
  // over — it is the reason that half of the transcript is about to be wrong.
  const perWindow = [
    [['en', 0.95]],
    [['en', 0.93]],
    [['es', 0.91]],
    [['en', 0.90]],
  ];
  const windows = [{ at: 10 }, { at: 70 }, { at: 130 }, { at: 190 }];
  const out = summariseDetection(perWindow, windows);

  assert.equal(out.code, 'en');
  assert.equal(out.mixed, true);
  assert.equal(out.dissenting.length, 1);
  assert.equal(out.dissenting[0].name, 'Spanish');
  assert.equal(out.dissenting[0].at, 130, 'and WHERE it was heard, so it can be found');
});

test('a hesitant disagreement is not called mixed', () => {
  // Every window leaning the same way with one wobble is ordinary model noise. Crying
  // "mixed" at it would make the warning meaningless, which is worse than not warning.
  const perWindow = [[['en', 0.95]], [['en', 0.80]], [['cy', 0.40], ['en', 0.39]]];
  const out = summariseDetection(perWindow, [{ at: 0 }, { at: 60 }, { at: 120 }]);
  assert.equal(out.code, 'en');
  assert.equal(out.mixed, false);
});

test('no scores at all is an empty answer, not a confident English one', () => {
  const out = summariseDetection([], []);
  assert.equal(out.code, '');
  assert.equal(out.confidence, 0);
  assert.equal(out.mixed, false);
});

test('the detect caveat names the one-language-per-file behaviour', () => {
  // The owner asked for this caveat specifically: an interviewer's introduction before
  // the interview is the common case, and a file that genuinely switches language gets
  // one language for all of it.
  const caveat = LIMITATIONS.find((l) => l.id === 'detect');
  assert.ok(caveat, 'there is a caveat about detection');
  assert.match(caveat.detail, /whole file/i);
  assert.match(caveat.detail, /introduction/i);
  assert.match(caveat.short, /ONE language/);
});

test('the worker never passes a blank language to the library', () => {
  // The regression that matters. transformers.js reads a missing language as English and
  // says so only in a console warning, so a blank must never reach `pipe()`.
  const worker = codeOf('core/transcribe-worker.js');
  assert.match(worker, /language: used/, 'the pipeline is given a resolved code');
  assert.doesNotMatch(worker, /\.\.\.\(language \? \{ language/, 'and not a conditional spread');
  assert.match(worker, /detectIn\(pipe, audio\.subarray/, 'detecting instead when nobody resolved one');
});

// ---------------------------------------------------------------------------------
// Transcribing part of a recording (#193).
//
// The range lives in the ENGINE rather than in a plugin that snips bytes, and the
// reason is almost entirely these tests: cues have to come back in the ORIGINAL
// recording's clock, or the transcript and the player disagree and nothing in the UI
// says so.
// ---------------------------------------------------------------------------------

test('a time is read the way a person writes one down', () => {
  assert.equal(parseClock('2:15'), 135);
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('135'), 135);
  assert.equal(parseClock('2:15.5'), 135.5);
  // Minutes beyond 59 in the LEADING field: "90:00" is how people write an hour and a
  // half, and refusing it would be pedantry about an unambiguous value.
  assert.equal(parseClock('90:00'), 5400);
  assert.equal(parseClock(' 2:15 '), 135, 'trimmed');
});

test('a mistyped time is rejected, not reinterpreted', () => {
  // `2:75` as 3m15s is the dangerous reading: it would silently transcribe a stretch the
  // user did not ask for. Only the leading field is unbounded.
  assert.equal(parseClock('2:75'), null);
  assert.equal(parseClock('1:60:00'), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(':30'), null);
  assert.equal(parseClock('1:2:3:4'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);
});

test('formatClock round-trips what parseClock reads', () => {
  for (const t of ['0:30', '2:15', '19:30', '1:02:03']) {
    assert.equal(formatClock(parseClock(t)), t);
  }
});

test('the engine accepts a range as text, so a sandboxed plugin needs no parser', () => {
  // A plugin cannot import this module (opaque origin), so if the engine took only
  // numbers every plugin would carry its own copy of the grammar and they would drift.
  assert.deepEqual(normaliseRange({ from: '2:15', to: '19:30' }), { from: 135, to: 1170 });
  assert.deepEqual(normaliseRange({ from: 135 }), { from: 135, to: null });
  assert.deepEqual(normaliseRange({}), { from: null, to: null });
  assert.deepEqual(normaliseRange({ from: '', to: '' }), { from: null, to: null });
  assert.throws(() => normaliseRange({ from: '2:75' }), /not a time/);
  // Ordering is rejected AT THE DOOR, not inside the job. Caught by testing `enqueue`
  // rather than `sliceRange`: an inverted range returned a job id and then failed minutes
  // later with a parse error in it, which is not what "parsed at the door" means.
  assert.throws(() => normaliseRange({ from: '5:00', to: '2:00' }), /end must come after/);
  assert.throws(() => normaliseRange({ from: '2:00', to: '2:00' }), /end must come after/);
  assert.throws(() => normaliseRange({ to: 'abc' }), /not a time/);
  assert.throws(() => normaliseRange({ from: -1 }), /not a time/);
});

test('slicing takes the stretch asked for, and nothing is copied', () => {
  const audio = new Float32Array(600 * 16000);   // 10 minutes
  const r = sliceRange(audio, { from: 135, to: 330 });
  assert.equal(r.from, 135);
  assert.equal(r.to, 330);
  assert.equal(r.ranged, true);
  assert.equal(r.audio.length, 195 * 16000);
  // A subarray, not a copy: the engine already holds the PCM, and an extra copy of a long
  // recording is what took a phone past its ceiling.
  assert.equal(r.audio.buffer, audio.buffer, 'a view, not a copy');
});

test('no range means the whole recording, and says so', () => {
  const audio = new Float32Array(600 * 16000);
  const r = sliceRange(audio, {});
  assert.equal(r.ranged, false);
  assert.equal(r.audio.length, audio.length);
  assert.equal(r.to, 600);
});

test('an end past the end of the recording is clamped, not refused', () => {
  // "2:15 to 25:00" of a ten-minute interview means "to the end". Erroring would be
  // punishing someone for not knowing the exact duration of their own file.
  const audio = new Float32Array(600 * 16000);
  const r = sliceRange(audio, { from: 135, to: 1500 });
  assert.equal(r.to, 600);
  assert.equal(r.audio.length, (600 - 135) * 16000);
});

test('an empty or impossible range is an error, not a silent whole-file run', () => {
  // The invisible-default failure this codebase keeps refusing to ship: asking for five
  // minutes and quietly getting ninety.
  const audio = new Float32Array(600 * 16000);
  assert.throws(() => sliceRange(audio, { from: 300, to: 120 }), /end must come after/);
  assert.throws(() => sliceRange(audio, { from: 700 }), /only 10:00 long/);
});

test('timings come back in the ORIGINAL recording clock, not the slice clock', () => {
  // The whole reason this is not a plugin's job. A cue 10 s into a slice that began at
  // 2:15 is at 2:25 in the media, and every consumer — WebVTT, the CAQDAS cue offsets,
  // the player gutter — reads these as media positions.
  const moved = shiftTiming({
    chunks: [{ start: 0, end: 4, text: 'first' }, { start: 10, end: 14, text: 'second' }],
    turns: [{ speaker: 0, start: 0, end: 14 }],
  }, 135);
  assert.deepEqual(moved.chunks.map((c) => [c.start, c.end]), [[135, 139], [145, 149]]);
  assert.deepEqual(moved.turns, [{ speaker: 0, start: 135, end: 149 }]);
  assert.equal(moved.chunks[0].text, 'first', 'and the text is untouched');
});

test('a zero offset is left exactly alone', () => {
  const input = { chunks: [{ start: 1, end: 2, text: 'x' }], turns: null };
  const out = shiftTiming(input, 0);
  assert.equal(out.chunks, input.chunks, 'the same array, not a rebuilt copy');
});

test('the shifted cues are what the WebVTT is built from', () => {
  // The trap this closes: `transcribe()` already produced a VTT in SLICE time, and that
  // is the copy a plugin turns into a document. Left alone it would put the text at
  // 0:00 and the player at 2:15 and let them disagree in silence.
  const shifted = shiftTiming({ chunks: [{ start: 0, end: 4, text: 'hello' }], turns: null }, 135);
  const vtt = toVtt(shifted);
  assert.match(vtt, /00:02:15\.000 --> 00:02:19\.000/);
  assert.doesNotMatch(vtt, /00:00:00\.000 --> /);
});

test('the engine, not the plugin, owns the range — recorded in code', () => {
  // Scoped to execute()'s body: `detectLanguage`'s own DEFINITION sits earlier in the
  // file than execute() does, so searching the whole module compares a definition
  // against a call site and proves nothing.
  const src = codeOf('core/transcribe.js');
  const body = src.slice(src.indexOf('function execute(full'));
  assert.ok(body, 'execute() takes the full recording');
  // Sliced before detection, so asking for 2:15-19:30 of a bilingual recording is not
  // detected from audio the user explicitly excluded.
  const sliceAt = body.indexOf('sliceRange(full');
  const detectAt = body.indexOf('detectLanguage(audio');
  assert.ok(sliceAt > -1, 'execute() slices');
  assert.ok(detectAt > -1, 'execute() detects');
  assert.ok(sliceAt < detectAt, 'the audio is sliced before the language is detected');
});

test('a failing segment says WHICH part, and where it starts', () => {
  // One segment failing kills the whole transcription. "It failed" with no position is
  // almost no help to someone deciding whether the problem is the recording, the device
  // or the model.
  const src = codeOf('core/transcribe.js');
  assert.match(src, /Part \$\{i \+ 1\} of \$\{total\}/, 'the part number is in the message');
  assert.match(src, /from \$\{at\}/, 'and the timestamp it starts at');
  // The original text must survive: the pool matches on it to decide to back off.
  assert.match(src, /failed — \$\{err\?\.message \?\? err\}/, "the engine's own reason is kept");
});

test('an empty worker error is explained rather than called unknown', () => {
  // On a phone this is the COMMON case: a worker killed by the OS for memory reports no
  // reason at all, where a real scripting error always carries one. "unknown error"
  // reads as a bug in the app and tells the user nothing to do.
  const src = codeOf('core/transcribe.js');
  assert.doesNotMatch(src, /unknown error/, 'no more "unknown error"');
  assert.match(src, /ran out /, 'it names the likely cause');
  assert.match(src, /Faster model/, 'and gives the user something to try');
  // The pool classifies by message, so these words have to stay.
  assert.match(src, /Transcription worker failed: \$\{detail\}/, 'still matches the pool\'s test');
});
