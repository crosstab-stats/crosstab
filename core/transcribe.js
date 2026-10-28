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
  { id: 'base', label: 'Base — 73 MB, about 16 min per hour of audio', accuracy: 0.66,
    weightsMb: 73, realTime: 3.7 },
  { id: 'small', label: 'Small — 238 MB, more accurate, about 40 min per hour', accuracy: 0.74,
    weightsMb: 238, realTime: 1.5 },
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
  // A QUEUE, not a refusal. The first version threw on a second job, justified by a claim
  // about phone memory that had never been measured — and transcribing a set of interviews
  // is an ordinary thing to want. What the measurement actually says is in
  // `transcribe-pool.js`: 219 MB per worker, linear, fully reclaimed on terminate. So the
  // answer is to run as many as this device can take and queue the rest.
  let pool = null;
  let active = 0;
  let lastChange = null;

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
     * Transcribe and/or diarize `bytes` (any audio the browser can decode).
     *
     * @param {ArrayBuffer|Uint8Array} bytes
     * @param {object} [opts] see {@link transcribe}; `language` must be an explicit code
     *   unless the caller deliberately passes null to auto-detect.
     * @returns {Promise<{vtt: string, chunks: object[], turns: object[]|null, seconds: number}>}
     */
    async run(bytes, opts = {}) {
      const mode = opts.mode ?? 'both';
      const size = opts.size ?? 'base';
      // One worker, always, until a second one demonstrably survives. `concurrency` is a
      // caller's override, not a prediction.
      if (!pool) pool = createPool({ start: concurrency ?? 1, onChange: (i) => { lastChange = i; } });

      // Decoded BEFORE queueing, so a job waiting its turn holds audio rather than an
      // undecoded file — and so a format the browser cannot read fails immediately
      // instead of after a queue wait.
      const audio = await decodeAudio(bytes);

      const seconds = audio.length / SAMPLE_RATE;

      return pool.run(async () => {
        let ui = null;
        const job = transcribe(audio, { ...opts, mode, size, onProgress: (p) => ui?.update(p) });
        active += 1;
        ui = showProgress?.({
          title: mode === 'speakers' ? 'Identifying speakers' : 'Transcribing',
          // Said up front because the first run is a download, and a silent 238 MB fetch
          // reads as a hang.
          hint: 'The first run downloads the model. Everything stays on this device.',
          onCancel: () => job.cancel(),
        }) ?? null;

        // A HEARTBEAT, because the model call reports nothing from inside.
        //
        // transformers.js offers no per-chunk callback, so between "model downloaded" and
        // "done" there is one opaque await that can last twenty minutes on an hour of
        // audio. Silence that long is indistinguishable from a crash, and the honest fix
        // until there is real progress is to show the clock: elapsed, and an estimate from
        // the measured rate for this model. The estimate is stated as an estimate and the
        // display says so plainly once it is exceeded.
        const rate = MODEL_SIZES.find((m) => m.id === size)?.realTime ?? 2;
        const startedAt = Date.now();
        const tick = setInterval(() => {
          ui?.update({
            type: 'elapsed',
            stage: 'transcribe',
            seconds,
            elapsedMs: Date.now() - startedAt,
            estimateMs: (seconds / rate) * 1000,
          });
        }, 1000);

        try {
          return await job;
        } finally {
          clearInterval(tick);
          active -= 1;
          ui?.close();
        }
      });
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
        basis: pool?.basis ?? 'one at a time until a second proves it fits',
        lastChange,
      };
    },
    setConcurrency(n) {
      if (!pool) pool = createPool({ start: n, onChange: (i) => { lastChange = i; } });
      pool.setLimit(n);
    },

    /** Whether anything is running. No longer a gate — just a fact. */
    get busy() {
      return active > 0;
    },
  };
}
