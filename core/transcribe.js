/**
 * @file transcribe.js
 * Host side of on-device transcription (#139 Phase 2) — audio in, **WebVTT** out.
 *
 * ## Why WebVTT and not a new shape
 *
 * `builtin-caqdas` already imports transcripts, and `sniffTranscript` already recognises
 * WebVTT including `<v Speaker>` voice spans. Emitting it means transcription arrives
 * through the path that is already written, already tested and already understands
 * speaker labels, cue timings and the offset bookkeeping that keeps a coded highlight on
 * the right words. A bespoke "transcription result" object would be a second format to
 * keep in step with the first, and the first is the one with the coding surface attached.
 *
 * ## The two jobs are separable on purpose
 *
 * `mode: 'text'` transcribes. `mode: 'speakers'` only finds who spoke when. `mode: 'both'`
 * does both and labels each cue.
 *
 * Speakers-only matters more than it looks: it needs **no language support at all**.
 * Whisper knows 99 languages and none of them is Navajo, Cherokee, Lakota, Quechua,
 * Guaraní, or any Australian Aboriginal language — and it does not fail on one, it
 * transcribes into the nearest language it knows and returns fluent fabrication. For a
 * linguist that is worse than nothing. A speakers-only pass still turns an hour of audio
 * into navigable turns to type into, in any language on earth.
 *
 * ## Language is chosen, not guessed
 *
 * `language` defaults to explicit. Auto-detect exists but must be asked for, because the
 * silent-wrong-language failure above is the one a researcher is least able to notice.
 */

import { getAssets } from './assets.js';
import { createPool, workerCeiling } from './transcribe-pool.js';

/** Whisper's own language set, read from the model's `generation_config.json` (99 codes).
 * Kept here so the dialog can SHOW the limit rather than letting someone discover it
 * after recording a project around it. */
export const WHISPER_LANGUAGES = Object.freeze([
  ['af', 'Afrikaans'], ['am', 'Amharic'], ['ar', 'Arabic'], ['as', 'Assamese'],
  ['az', 'Azerbaijani'], ['ba', 'Bashkir'], ['be', 'Belarusian'], ['bg', 'Bulgarian'],
  ['bn', 'Bengali'], ['bo', 'Tibetan'], ['br', 'Breton'], ['bs', 'Bosnian'],
  ['ca', 'Catalan'], ['cs', 'Czech'], ['cy', 'Welsh'], ['da', 'Danish'],
  ['de', 'German'], ['el', 'Greek'], ['en', 'English'], ['es', 'Spanish'],
  ['et', 'Estonian'], ['eu', 'Basque'], ['fa', 'Persian'], ['fi', 'Finnish'],
  ['fo', 'Faroese'], ['fr', 'French'], ['gl', 'Galician'], ['gu', 'Gujarati'],
  ['ha', 'Hausa'], ['haw', 'Hawaiian'], ['he', 'Hebrew'], ['hi', 'Hindi'],
  ['hr', 'Croatian'], ['ht', 'Haitian Creole'], ['hu', 'Hungarian'], ['hy', 'Armenian'],
  ['id', 'Indonesian'], ['is', 'Icelandic'], ['it', 'Italian'], ['ja', 'Japanese'],
  ['jw', 'Javanese'], ['ka', 'Georgian'], ['kk', 'Kazakh'], ['km', 'Khmer'],
  ['kn', 'Kannada'], ['ko', 'Korean'], ['la', 'Latin'], ['lb', 'Luxembourgish'],
  ['ln', 'Lingala'], ['lo', 'Lao'], ['lt', 'Lithuanian'], ['lv', 'Latvian'],
  ['mg', 'Malagasy'], ['mi', 'Māori'], ['mk', 'Macedonian'], ['ml', 'Malayalam'],
  ['mn', 'Mongolian'], ['mr', 'Marathi'], ['ms', 'Malay'], ['mt', 'Maltese'],
  ['my', 'Burmese'], ['ne', 'Nepali'], ['nl', 'Dutch'], ['nn', 'Nynorsk'],
  ['no', 'Norwegian'], ['oc', 'Occitan'], ['pa', 'Punjabi'], ['pl', 'Polish'],
  ['ps', 'Pashto'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sa', 'Sanskrit'], ['sd', 'Sindhi'], ['si', 'Sinhala'], ['sk', 'Slovak'],
  ['sl', 'Slovenian'], ['sn', 'Shona'], ['so', 'Somali'], ['sq', 'Albanian'],
  ['sr', 'Serbian'], ['su', 'Sundanese'], ['sv', 'Swedish'], ['sw', 'Swahili'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['tg', 'Tajik'], ['th', 'Thai'],
  ['tk', 'Turkmen'], ['tl', 'Tagalog'], ['tr', 'Turkish'], ['tt', 'Tatar'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['uz', 'Uzbek'], ['vi', 'Vietnamese'],
  ['yi', 'Yiddish'], ['yo', 'Yoruba'], ['zh', 'Chinese'],
]);

/**
 * Model sizes, with the download each actually costs (measured, quantised, 2026-10-26).
 *
 * `tiny` is the weakest Whisper there is. It is the default because it is 39 MB and
 * because most of what it will be pointed at first is English — but a non-English
 * recording realistically wants `base` or `small`, and the dialog says so rather than
 * letting someone conclude the feature is bad when they were using its smallest model.
 */
/**
 * Accuracy and speed are MEASURED, against the AMI human transcript — 17.7 minutes of four
 * people talking over each other, which is the hardest freely licensed benchmark there is.
 * Word error rate after normalising spelling and ignoring disfluencies; an interview, being
 * one or two people taking turns, should do markedly better.
 *
 * `tiny` is not offered. On that benchmark it collapses into repetition loops — 174.7% word
 * error rate, emitting 5189 words where 2633 were spoken, a unique-word ratio of 0.063
 * against the human transcript's 0.237. It is not a fast option, it is a broken one, and
 * the loop also makes it slower than `base` in wall-clock terms.
 */
export const MODEL_SIZES = Object.freeze([
  // NAMED FOR THE CHOICE, not for Whisper's internals. Upstream calls these "base" and
  // "small", which in a two-item menu reads as a bug: the "small" one is the BIGGER
  // download and the slower run. A user picking a model is choosing between finishing
  // sooner and reading fewer mistakes, so the label says that and leads with the cost
  // that actually decides it — the wait.
  //
  // `id` stays `base`/`small` because it is the API contract the worker and every stored
  // job carry, and `detail` keeps the upstream name: a transcript in a methods section
  // needs to say which model produced it.
  { id: 'base', label: 'Faster — 16 min per hour of audio (73 MB)',
    detail: 'Whisper base', accuracy: 0.66, weightsMb: 73, realTime: 3.7 },
  { id: 'small', label: 'More accurate — 40 min per hour of audio (238 MB)',
    detail: 'Whisper small', accuracy: 0.74, weightsMb: 238, realTime: 1.5 },
]);

/**
 * What this cannot do, in the caller's hands rather than in a commit message.
 *
 * Measured: the human transcript of that meeting is 6.4% filler tokens, and the rate varies
 * 1.9x BETWEEN SPEAKERS (4.5% for one participant, 8.5% for another) — which is exactly the
 * sort of thing a linguist or a cultural anthropologist publishes. Whisper's best available
 * model emitted 17 of those 168 fillers. Roughly a tenth, and not uniformly.
 *
 * So a transcript from here can be filtered but never restored, and anyone comparing
 * disfluency between speakers would be handed a confident number drawn from a tenth of the
 * data. That is not a degraded finding, it is a false one — which is why this is stated
 * rather than quietly handled.
 */
export const LIMITATIONS = Object.freeze([
  Object.freeze({
    id: 'disfluencies',
    short: 'Filler words are mostly lost.',
    detail: 'Whisper drops about nine out of ten disfluencies — "um", "uh", "mm-hmm". '
      + 'Measured against a human transcript of the same audio it kept 17 of 168. If your '
      + 'analysis counts or compares filler use, this is the wrong tool: transcribe '
      + 'elsewhere and import the transcript instead.',
  }),
  Object.freeze({
    id: 'overlap',
    short: 'Overlapping speech is dropped, not guessed.',
    detail: 'When people talk over each other the quieter speaker tends to vanish rather '
      + 'than be mistranscribed. Most errors on meeting audio are missing words, not wrong '
      + 'ones.',
  }),
  Object.freeze({
    id: 'verbatim',
    short: 'The transcript is readable, not verbatim.',
    detail: '"gonna" becomes "going to", "twenty five" becomes "25", British spellings '
      + 'become American. Fine for content analysis; not a record of how something was said.',
  }),
]);

/** 16 kHz mono — what Whisper and the speaker embedder both expect. */
const SAMPLE_RATE = 16000;

/**
 * Decode any browser-readable audio file to the mono 16 kHz the models want.
 *
 * `decodeAudioData` handles whatever the browser handles (wav, mp3, m4a, ogg, flac), so
 * the supported-format question is the browser's rather than ours. Channels are averaged
 * rather than taking the first, because an interview recorded with one speaker per channel
 * would otherwise lose a participant.
 */
export async function decodeAudio(bytes) {
  // VIDEO WORKS, and not by accident: `decodeAudioData` demuxes the container and decodes
  // the audio track, so an MP4, M4V, MOV or WebM carrying speech is as acceptable as a WAV.
  // Verified against a real 45.9 MB H.264 + AAC film: 663.3 s of audio recovered in 1.6 s,
  // matching the published running time. Oral histories recorded on video need no separate
  // extraction step. What is NOT supported is whatever the browser itself cannot decode —
  // MKV and AVI are the usual disappointments — and the failure there is a plain throw.
  //
  // An ArrayBuffer argument is DETACHED by `decodeAudioData`; a TypedArray is copied first
  // and survives. That asymmetry is the API's, not ours, and it bites on the second
  // attempt rather than the first: a caller who retries a failed decode with the same
  // ArrayBuffer hands over an empty one and gets "Unable to decode audio data", which says
  // nothing about what went wrong. So say it here instead.
  const ab = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(0);
  if (!ab.byteLength) {
    throw new Error('This audio buffer has already been used. decodeAudioData detaches an '
      + 'ArrayBuffer, so it cannot be decoded twice — read the file again, or pass a '
      + 'Uint8Array, which is copied.');
  }
  const ctx = new (globalThis.OfflineAudioContext ?? globalThis.AudioContext)(1, 1, SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(ab);
  if (buf.numberOfChannels === 1 && buf.sampleRate === SAMPLE_RATE) return buf.getChannelData(0);

  const frames = Math.ceil(buf.duration * SAMPLE_RATE);
  const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

/** `HH:MM:SS.mmm`, WebVTT's timestamp. */
function vttTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)}.${p(ms, 3)}`;
}

/** A speaker index as a label a reader can live with: 0 → "Speaker 1". */
export const speakerName = (i) => (i === null || i === undefined ? '' : `Speaker ${i + 1}`);

/**
 * Cues (and/or speaker turns) as WebVTT text.
 *
 * Speaker-only output still produces cues — with an empty body — because a turn with no
 * words is exactly what a researcher transcribing by hand wants to type into, and because
 * the existing importer already knows this format. Nothing new has to learn anything.
 */
export function toVtt({ chunks = [], turns = null } = {}) {
  const lines = ['WEBVTT', ''];
  const rows = chunks.length
    ? chunks.map((c) => ({ start: c.start, end: c.end, speaker: c.speaker, text: c.text }))
    : (turns ?? []).map((t) => ({ start: t.start, end: t.end, speaker: t.speaker, text: '' }));

  for (const r of rows) {
    lines.push(`${vttTime(r.start)} --> ${vttTime(r.end)}`);
    const who = speakerName(r.speaker);
    lines.push(who ? `<v ${who}>${r.text}` : r.text);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Run a transcription / diarization job in a worker.
 *
 * Returns `{vtt, chunks, turns, seconds, cancel()}`. The worker is terminated on cancel,
 * which is the only reliable way to stop ONNX mid-inference — there is no cooperative
 * yield inside a model call, so a flag alone would leave the tab busy for the rest of the
 * chunk.
 *
 * @param {Float32Array} audio  mono 16 kHz, from {@link decodeAudio}
 * @param {object} [opts]
 * @param {'text'|'speakers'|'both'} [opts.mode]
 * @param {string|null} [opts.language]  an ISO code from {@link WHISPER_LANGUAGES}, or
 *   null to let Whisper guess — which the caller should only pass when the user asked.
 * @param {(p: object) => void} [opts.onProgress]
 */
export function transcribe(audio, opts = {}) {
  const {
    mode = 'both', language = 'en', size = 'base', threshold = 0.3, expected = 0,
    onProgress = null,
  } = opts;

  const worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
  let settle = null;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });

  worker.onmessage = (e) => {
    const m = e.data ?? {};
    if (m.type === 'progress' || m.type === 'stage') { onProgress?.(m); return; }
    if (m.type === 'done') {
      // The caveats travel WITH the transcript. A result that outlives the dialog that
      // produced it should still be able to say what it is not.
      settle.resolve({ ...m, vtt: toVtt(m), limitations: LIMITATIONS });
      worker.terminate();
    } else if (m.type === 'cancelled') {
      settle.reject(Object.assign(new Error('Transcription cancelled.'), { cancelled: true }));
      worker.terminate();
    } else if (m.type === 'error') {
      settle.reject(new Error(m.message));
      worker.terminate();
    }
  };
  worker.onerror = (err) => {
    settle.reject(new Error(`Transcription worker failed: ${err.message || 'unknown error'}`));
    worker.terminate();
  };

  // A vendored build must not reach the CDN; the worker is told where its code lives
  // rather than deciding, the same way every other runtime here is pinned in assets.js.
  const libUrl = getAssets()?.transformersUrl;
  if (libUrl) worker.postMessage({ type: 'config', libUrl });

  // `audio.buffer` is transferred, not copied — an hour of 16 kHz mono is ~230 MB and
  // structured-cloning that would double it for no reason.
  worker.postMessage(
    { type: 'run', id: 1, audio, mode, language, size, threshold, expected },
    [audio.buffer],
  );

  return Object.assign(done, {
    cancel() {
      worker.postMessage({ type: 'cancel' });
      // Terminate after a tick so a cancel mid-inference still stops: the worker only
      // sees the message between model calls.
      setTimeout(() => worker.terminate(), 0);
      settle.reject(Object.assign(new Error('Transcription cancelled.'), { cancelled: true }));
    },
  });
}


/**
 * How long each transcription segment is.
 *
 * Measured, not chosen: at this length segmentation costs nothing in accuracy (37.3% word
 * error rate segmented against 37.6% in one call on the same audio) and nothing in time
 * (8.9% FASTER on one worker, because shorter calls avoid whatever accumulates in a long
 * one). Shorter would mean more boundaries to lose words at; longer would mean coarser
 * progress and more memory held per segment.
 */
export const SEGMENT_SECONDS = 120;

/** Past this, a single call is split. Below it the overhead is not worth the bookkeeping. */
export const SEGMENT_ABOVE_SECONDS = 180;

/** Which speaker was talking at time `t`, from a diarization pass over the whole file. */
function speakerAt(turns, t) {
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (t >= turn.start && t < turn.end) return turn.speaker;
  }
  return null;
}

/**
 * Transcribe a long recording as a sequence of segments.
 *
 * NO OVERLAP AND NO DEDUPLICATION, because both were measured and neither helped. Four
 * stitching rules were scored against a human transcript: a plain cut beat timestamp
 * trimming, a repeated-run word drop, both together, and snapping the cut to the quietest
 * nearby moment. The dedup works — it removes most of what overlap duplicates — but
 * overlap never earns back what it costs, so the honest implementation is the one with
 * nothing in it.
 *
 * Segments are built one at a time as the pool frees a slot, so the decoded audio is the
 * only large thing held: a 40-minute interview in a single call crashed a phone, and the
 * point of this is that memory stops growing with the recording.
 *
 * @param {Float32Array} audio  mono 16 kHz
 * @param {object} opts  as {@link transcribe}
 * @param {(fn: () => Promise<any>) => Promise<any>} opts.schedule  the pool's `run`
 */
async function transcribeSegments(audio, opts) {
  const { schedule, onProgress, mode = 'both', onJob = null, ...rest } = opts;
  const step = Math.round(SEGMENT_SECONDS * SAMPLE_RATE);
  const total = Math.ceil(audio.length / step);
  const chunks = new Array(total).fill(null);
  let done = 0;

  // Report the shape BEFORE any work starts. A job whose segments are all still waiting —
  // because the queue is paused, or because another file is ahead of it — would otherwise
  // show no progress at all and read as "working" when nothing is. "0 of 7" is honest;
  // a blank is not.
  onProgress?.({ type: 'segments', stage: 'transcribe', done: 0, total });

  await Promise.all(Array.from({ length: total }, (_, i) => schedule(async () => {
    const from = i * step;
    // Copied here rather than up front: only the segments actually in flight exist at
    // once, which is the difference between holding one segment and holding the interview.
    const slice = new Float32Array(audio.subarray(from, Math.min(audio.length, from + step)));
    const job = transcribe(slice, { ...rest, mode: 'text', onProgress: null });
    onJob?.(job);
    const out = await job;
    const offset = from / SAMPLE_RATE;
    chunks[i] = (out.chunks ?? []).map((c) => ({
      ...c, start: (c.start ?? 0) + offset, end: (c.end ?? 0) + offset,
    }));
    done += 1;
    // REAL progress at last: segments finished out of segments total. Until now a long job
    // could only show a clock, because the model reports nothing from inside one call.
    onProgress?.({ type: 'segments', stage: 'transcribe', done, total });
  })));

  return chunks.flat().filter(Boolean);
}

/**
 * The host service behind `app.transcribe` — see `core/plugin-broker.js`.
 *
 * Core owns transcription only because a sandbox cannot have it: an opaque-origin plugin
 * frame cannot create a Worker, and every CSP tier is `connect-src 'none'`, so it could
 * neither run a model nor fetch one. Everything else about the feature belongs to whoever
 * builds on this — the dialog, the language choice, what a transcript becomes.
 *
 * Progress and cancellation are rendered HERE rather than handed back, because a function
 * cannot cross the broker's structured clone. A caller simply awaits a result.
 *
 * @param {object} deps
 * @param {(opts: object) => object} deps.showProgress  host progress UI; returns
 *   `{update(state), close()}` and calls `onCancel` if the user stops it.
 */
export function createTranscribeService({ showProgress, concurrency } = {}) {
  let pool = null;
  let active = 0;
  let lastChange = null;
  const ensurePool = () => {
    // One worker, always, until a second one demonstrably survives. `concurrency` is a
    // caller's override, not a prediction.
    if (!pool) pool = createPool({ start: concurrency ?? 1, onChange: (i) => { lastChange = i; } });
    return pool;
  };

  // ---- the queue -----------------------------------------------------------------
  //
  // Seven interviews is an ordinary afternoon's work, and a modal dialog is the wrong
  // shape for it: it blocks the very checking the user wants to do while the rest churn.
  // So jobs are RECORDS that can be inspected, not callbacks that must be watched.
  //
  // Pull, not push, because a function cannot cross the plugin broker's structured clone.
  // A workspace plugin owning the UI polls `status()`; nothing has to be handed a callback,
  // and the same API works for the host, a plugin, or a test.
  const jobs = new Map();
  let nextId = 1;

  /** Everything about a job EXCEPT its transcript, which is fetched on demand. */
  const summarise = (j) => ({
    id: j.id,
    name: j.name,
    state: j.state,
    mode: j.mode,
    size: j.size,
    seconds: j.seconds,
    progress: j.progress ? { ...j.progress } : null,
    error: j.error,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  });

  /**
   * Run one job to completion, reporting progress wherever the caller wants it.
   *
   * The single execution path for both surfaces: the host's modal passes a dialog, the
   * queue passes a recorder that writes into a job record. Two code paths would drift,
   * and the segmented branch is too fiddly to maintain twice.
   */
  function execute(audio, opts, report) {
    const mode = opts.mode ?? 'both';
    const size = opts.size ?? 'base';
    const seconds = audio.length / SAMPLE_RATE;
    const wantsText = mode === 'text' || mode === 'both';
    const wantsSpeakers = mode === 'speakers' || mode === 'both';
    const p = ensurePool();
    const inFlight = new Set();
    let stopped = false;
    const cancel = () => {
      stopped = true;
      for (const j of inFlight) j.cancel?.();
    };

    // An async function returns a bare Promise, and a caller needs somewhere to hang
    // cancel() — so the body runs in an IIFE and the handle rides on the promise, exactly
    // as `transcribe()` does.
    const promise = (async () => {

    // ---- long recordings are segmented --------------------------------------------
    //
    // A single call over 40 minutes crashed a phone, extra workers did nothing for a
    // single file, and progress could only ever be a clock. Segments fix all three, and
    // measurement says they cost nothing: 37.3% word error rate segmented against 37.6%
    // in one call, and 8.9% faster on one worker.
    if (wantsText && seconds > SEGMENT_ABOVE_SECONDS) {
      const chunks = await transcribeSegments(audio, {
        ...opts,
        mode: 'text',
        size,
        schedule: (fn) => p.run(fn),
        onJob: (j) => {
          inFlight.add(j);
          j.then(() => inFlight.delete(j), () => inFlight.delete(j));
        },
        onProgress: (x) => { if (!stopped) report.update?.(x); },
      });
      if (stopped) throw Object.assign(new Error('Transcription cancelled.'), { cancelled: true });

      // Speakers are identified ONCE over the whole recording. Cluster each segment
      // separately and "Speaker 1" means a different person in every one.
      let turns = null;
      if (wantsSpeakers) {
        report.update?.({ stage: 'speakers' });
        const job = transcribe(new Float32Array(audio), {
          ...opts, mode: 'speakers', size,
          onProgress: (x) => { if (!stopped) report.update?.(x); },
        });
        inFlight.add(job);
        turns = (await job).turns ?? null;
        inFlight.delete(job);
      }
      const withSpeakers = turns
        ? chunks.map((c) => ({ ...c, speaker: speakerAt(turns, (c.start + c.end) / 2) }))
        : chunks;
      const out = { chunks: withSpeakers, turns, seconds, segmented: true };
      return { ...out, vtt: toVtt(out), limitations: LIMITATIONS };
    }

    // ---- short enough for one call -------------------------------------------------
    return p.run(async () => {
      const job = transcribe(audio, {
        ...opts, mode, size, onProgress: (x) => { if (!stopped) report.update?.(x); },
      });
      inFlight.add(job);
      // A HEARTBEAT, because the model call reports nothing from inside. transformers.js
      // offers no per-chunk callback, so a single call is one opaque await. Silence reads
      // as a crash; a clock does not.
      const rate = MODEL_SIZES.find((m) => m.id === size)?.realTime ?? 2;
      const startedAt = Date.now();
      const tick = setInterval(() => {
        report.update?.({
          type: 'elapsed', stage: 'transcribe', seconds,
          elapsedMs: Date.now() - startedAt, estimateMs: (seconds / rate) * 1000,
        });
      }, 1000);
      try {
        return await job;
      } finally {
        clearInterval(tick);
        inFlight.delete(job);
      }
    });
    })();

    return Object.assign(promise, { cancel });
  }

  return {
    /** What a caller can ask for, so a plugin's dialog is built from the model's own
     * truth rather than a copied list that will drift. */
    options() {
      return {
        languages: WHISPER_LANGUAGES.map(([code, name]) => ({ code, name })),
        sizes: MODEL_SIZES.map((m) => ({ ...m })),
        // Handed over rather than buried: a caller building a dialog should be able to
        // show what this cannot do before someone spends twenty minutes finding out.
        limitations: LIMITATIONS.map((l) => ({ ...l })),
        modes: [
          { id: 'both', label: 'Transcribe and identify speakers' },
          { id: 'text', label: 'Transcribe only' },
          // Listed last but not least: this is the mode that works for a language
          // Whisper does not know, which is most of the world's languages.
          { id: 'speakers', label: 'Identify speakers only (works in any language)' },
        ],
      };
    },

    /**
     * Transcribe now, with the host's own progress dialog. One file, one wait.
     *
     * Still here because a plugin that wants a single transcript should not have to build
     * a queue UI to get one. For a batch, `enqueue` is the better shape.
     */
    async run(bytes, opts = {}) {
      const mode = opts.mode ?? 'both';
      const audio = await decodeAudio(bytes);
      let ui = null;
      active += 1;
      const report = { update: (x) => ui?.update(x) };
      // A placeholder until `execute` hands back the real one, so a Stop pressed in the
      // gap between showing the dialog and starting the work is not a crash.
      const handle = { cancel: () => {} };
      ui = showProgress?.({
        title: mode === 'speakers' ? 'Identifying speakers' : 'Transcribing',
        // Said up front because the first run is a download, and a silent 238 MB fetch
        // reads as a hang.
        hint: 'The first run downloads the model. Everything stays on this device.',
        onCancel: () => handle.cancel(),
      }) ?? null;
      try {
        const execution = execute(audio, opts, report);
        handle.cancel = execution.cancel ?? handle.cancel;
        return await execution;
      } finally {
        active -= 1;
        ui?.close();
      }
    },

    /**
     * Add a file to the queue and return its id. Does NOT wait, and shows no dialog.
     *
     * This is the batch shape: seven interviews go in, the caller watches `status()`, and
     * each transcript becomes available through `result(id)` the moment its job finishes —
     * so the first can be read while the seventh is still queued.
     */
    enqueue(bytes, opts = {}) {
      ensurePool();
      const id = `t${nextId++}`;
      const job = {
        id,
        name: opts.name || `Recording ${id}`,
        state: 'queued',
        mode: opts.mode ?? 'both',
        size: opts.size ?? 'base',
        seconds: null,
        progress: null,
        error: null,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        result: null,
        cancel: null,
      };
      jobs.set(id, job);

      (async () => {
        try {
          // Decoded here rather than at enqueue time so a queue of seven files does not
          // hold seven decoded recordings at once — which is the memory shape that
          // crashed a phone on ONE of them.
          const audio = await decodeAudio(bytes);
          if (job.state === 'cancelled') return;
          job.state = 'running';
          job.startedAt = Date.now();
          job.seconds = audio.length / SAMPLE_RATE;
          active += 1;
          const report = {
            update: (p) => {
              if (p.type === 'segments') job.progress = { done: p.done, total: p.total };
              else if (p.stage === 'speakers') job.progress = { ...(job.progress ?? {}), stage: 'speakers' };
              else if (p.type === 'elapsed') {
                job.progress = { elapsedMs: p.elapsedMs, estimateMs: p.estimateMs };
              }
            },
          };
          const execution = execute(audio, opts, report);
          job.cancel = execution.cancel ?? null;
          job.result = await execution;
          job.state = 'done';
        } catch (err) {
          job.state = err?.cancelled ? 'cancelled' : 'failed';
          job.error = String(err?.message ?? err);
        } finally {
          if (job.startedAt) active -= 1;
          job.finishedAt = Date.now();
          job.cancel = null;
        }
      })();

      return { id };
    },

    /** Everything a UI needs to draw itself, and nothing it does not. Safe to poll. */
    status() {
      return {
        paused: pool?.paused ?? false,
        capacity: this.capacity,
        jobs: [...jobs.values()].map(summarise),
      };
    },

    /** The transcript, once a job is done. Kept out of `status()` because an hour of
     * speech is a lot to hand over on every poll. */
    result(id) {
      const job = jobs.get(id);
      return job?.state === 'done' ? job.result : null;
    },

    /** Stop one job. A queued one never starts; a running one stops at its next segment
     * boundary, or immediately if it is a single call. */
    cancel(id) {
      const job = jobs.get(id);
      if (!job || job.state === 'done' || job.state === 'failed') return false;
      if (job.state === 'queued') {
        job.state = 'cancelled';
        job.finishedAt = Date.now();
        return true;
      }
      job.cancel?.();
      return true;
    },

    /** Stop starting new work. Whatever is mid-segment finishes; nothing else begins. */
    pause() { ensurePool().pause(); },
    resume() { ensurePool().resume(); },

    /** Forget finished jobs, so a long session does not accumulate transcripts in memory.
     * Anything still queued or running is left alone. */
    forget(id = null) {
      const drop = (j) => ['done', 'failed', 'cancelled'].includes(j.state);
      if (id) {
        const job = jobs.get(id);
        if (job && drop(job)) { jobs.delete(id); return true; }
        return false;
      }
      let n = 0;
      for (const [key, job] of jobs) if (drop(job)) { jobs.delete(key); n += 1; }
      return n;
    },

    /** How many run at once, why, and how to change it — so the UI can explain itself
     * rather than appearing to be slow for no reason. */
    get capacity() {
      return {
        limit: pool?.limit ?? 1,
        ceiling: pool?.ceiling ?? workerCeiling(),
        running: pool?.running ?? 0,
        pending: pool?.pending ?? 0,
        probing: pool?.probing ?? true,
        reached: pool?.reached ?? 0,
        paused: pool?.paused ?? false,
        basis: pool?.basis ?? 'one at a time until a second proves it fits',
        lastChange,
      };
    },
    setConcurrency(n) {
      ensurePool().setLimit(n);
    },

    /** Whether anything is running. No longer a gate — just a fact. */
    get busy() {
      return active > 0;
    },
  };
}
