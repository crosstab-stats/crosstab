/**
 * @file transcribe-worker.js
 * On-device speech-to-text and speaker diarization, off the main thread (#139 Phase 2).
 *
 * ## Why a worker, and why in core
 *
 * The spike (`spike/whisper-spike.html`) ran this on the main thread and froze the tab for
 * seconds at a time. That is the one thing that cannot ship, so the worker is not an
 * optimisation here — it is the feature's shape.
 *
 * And it cannot live in a plugin, for two measured reasons recorded in
 * `core/plugin-sandbox.js`: a plugin frame is opaque-origin, so **a Worker cannot be
 * created inside it** (`createObjectURL` yields an unfetchable `blob:null/…`), and every
 * sandbox CSP tier sets `connect-src 'none'`, so it could not fetch 44 MB of model weights
 * even if it could run them. Transcription is therefore a core runtime, like WebR and
 * DuckDB — which is also how its assets are pinned (see `core/assets.js`).
 *
 * ## Two independent jobs
 *
 * **Transcription** (Whisper) turns audio into timed text. **Diarization** (speaker
 * embeddings + clustering) turns audio into speaker turns. They are deliberately separable:
 * diarization needs no language support at all, so it serves a Navajo or Quechua recording
 * exactly as well as an English one, where Whisper serves neither. A researcher working in
 * a language Whisper does not know can still get "Speaker A 0:00–1:12, Speaker B 1:12–1:40"
 * and type into that skeleton.
 *
 * ## What the measurements decided
 *
 * From `spike/RESULTS.md`, on real hardware rather than from the published estimates:
 *
 *  - **WASM q8 is the default, not the fallback.** 39 MB and ready in 3.9 s, against
 *    91 MB / 50.9 s for WebGPU q4 — and on a 4-core phone WASM hit **17× real time**,
 *    beating a 16-core desktop's WASM and matching that desktop's WebGPU. Four fast cores
 *    beat sixteen slower ones; ORT's WASM threading does not scale with core count.
 *  - **The segmentation model is the wrong tool for "who".** `pyannote-segmentation-3.0`
 *    is a frame-level speaker-ACTIVITY detector: it found the right *number* of speakers
 *    and then alternated them every half second, 29 times across three actual turns.
 *    Identity comes from embeddings, so that model is not used here at all.
 *  - **Clustering threshold matters more than anything else.** 0.25–0.35 gave exactly the
 *    right answer on the ground-truth conversation; 0.65 gave eleven speakers for two.
 */

/* global self */

/** Pinned, like every other runtime this project loads. Overridden by the host for a
 * vendored/air-gapped build — the worker never decides where its code comes from. */
let LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

/** Models, by job. Multilingual by default: `whisper-tiny` is **the same 39 MB** as
 * `whisper-tiny.en` and covers 99 languages, so the English-only build buys nothing. */
const WHISPER = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};
const EMBEDDER = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

/** Window for a speaker embedding. Two seconds is long enough for a stable voice print
 * and short enough to find a turn — and it is why turn boundaries land within ±2 s and a
 * one-word interjection is absorbed rather than found. */
const WIN_SECONDS = 2;
const SAMPLE_RATE = 16000;

let lib = null;
let asr = null;
let asrKey = '';
let embedder = null;
let cancelled = false;

const post = (type, payload) => self.postMessage({ type, ...payload });

async function loadLib() {
  if (!lib) lib = await import(/* @vite-ignore */ LIB_URL);
  return lib;
}

/** Progress from the model loader, normalised to one shape the host can render. */
const progressFor = (stage) => (p) => {
  if (p?.status === 'progress' && p.total) {
    post('progress', { stage, file: p.file, loaded: p.loaded, total: p.total });
  }
};

async function getAsr({ size = 'base', device = 'wasm', dtype = 'q8' }) {
  const key = `${size}:${device}:${dtype}`;
  if (asr && asrKey === key) return asr;
  const t = await loadLib();
  asr = await t.pipeline('automatic-speech-recognition', WHISPER[size] ?? WHISPER.base, {
    device,
    dtype,
    progress_callback: progressFor('model'),
  });
  asrKey = key;
  return asr;
}

async function getEmbedder() {
  if (embedder) return embedder;
  const t = await loadLib();
  const [processor, model] = await Promise.all([
    t.AutoProcessor.from_pretrained(EMBEDDER),
    t.AutoModel.from_pretrained(EMBEDDER, { dtype: 'q8', progress_callback: progressFor('speakers') }),
  ]);
  embedder = { processor, model };
  return embedder;
}

/** Cosine similarity of two equal-length vectors. */
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Speaker turns for `audio`, as `[{speaker, start, end}]` in seconds.
 *
 * Agglomerative rather than k-means because the number of speakers is exactly what you do
 * not know in advance — except when you do, which is why `expected` exists: an interview
 * usually has a known headcount, and saying so beats tuning a threshold by eye.
 */
async function diarize(audio, { threshold = 0.3, expected = 0 } = {}) {
  const { processor, model } = await getEmbedder();
  const step = WIN_SECONDS * SAMPLE_RATE;
  const windows = [];

  for (let i = 0; i + step <= audio.length; i += step) {
    if (cancelled) return null;
    const out = await model(await processor(audio.subarray(i, i + step)));
    const tensor = out.embeddings ?? out.last_hidden_state ?? Object.values(out)[0];
    windows.push({ at: i / SAMPLE_RATE, vec: Array.from(tensor.data) });
    if (windows.length % 10 === 0) {
      post('progress', { stage: 'speakers', loaded: i + step, total: audio.length });
    }
  }
  if (!windows.length) return [];

  const speakers = [];
  const assign = [];
  for (const w of windows) {
    let best = -1;
    let bestSim = -2;
    speakers.forEach((sp, i) => {
      const sim = cosine(w.vec, sp.centroid);
      if (sim > bestSim) { bestSim = sim; best = i; }
    });
    // With a known headcount, never exceed it: join the nearest speaker once the roster
    // is full, whatever the distance. Without one, the threshold decides.
    const roomForMore = !expected || speakers.length < expected;
    if (best >= 0 && (bestSim >= threshold || !roomForMore)) {
      const sp = speakers[best];
      sp.centroid = sp.centroid.map((c, i) => (c * sp.n + w.vec[i]) / (sp.n + 1));
      sp.n += 1;
      assign.push(best);
    } else {
      speakers.push({ centroid: [...w.vec], n: 1 });
      assign.push(speakers.length - 1);
    }
  }

  const turns = [];
  windows.forEach((w, i) => {
    const last = turns[turns.length - 1];
    if (last && last.speaker === assign[i]) last.end = w.at + WIN_SECONDS;
    else turns.push({ speaker: assign[i], start: w.at, end: w.at + WIN_SECONDS });
  });
  return turns;
}

/** Which speaker was talking at a moment — the turn containing it, else the nearest. */
function speakerAt(turns, time) {
  if (!turns?.length) return null;
  for (const t of turns) if (time >= t.start && time < t.end) return t.speaker;
  let best = turns[0];
  let dist = Infinity;
  for (const t of turns) {
    const d = time < t.start ? t.start - time : time - t.end;
    if (d < dist) { dist = d; best = t; }
  }
  return best.speaker;
}

/**
 * Which language is being spoken in one 30-second window, as `[code, probability]` pairs.
 *
 * ## Why this is hand-rolled
 *
 * transformers.js 4.3.1 DOES NOT DETECT. Omitting `language` does not ask the model to
 * work it out; `_retrieve_init_tokens` in `models/whisper/modeling_whisper.js` reads:
 *
 *     if (!language) {
 *         // TODO: Implement language detection
 *         logger.warn('No language specified - defaulting to English (en).');
 *         language = 'en';
 *     }
 *
 * — so "auto" was English wearing a different label, and the failure is silent: French
 * audio came back as fluent English prose ("even today, what crime did I commit?"), not
 * as an error. Measured, both ways round, before this function existed.
 *
 * ## How it works
 *
 * Whisper's prefix is `<|startoftranscript|> <|lang|> <|task|>`. Normally the language
 * token is FORCED into that prefix, which is why nothing is ever detected. Run the decoder
 * for exactly one step from `<|startoftranscript|>` ALONE and the model's own first
 * prediction is its guess — that is what the language tokens are for. One encoder pass
 * plus one decoder step, so it costs a fraction of transcribing the same window.
 *
 * The softmax is taken over the 99 language tokens only, not the full 51865-token
 * vocabulary: the question is "which language", and normalising over every word in the
 * vocabulary would answer a different one.
 */
async function detectIn(pipe, pcm) {
  const t = await loadLib();
  const feats = await pipe.processor(pcm);
  const gc = pipe.model.generation_config;
  const out = await pipe.model({
    input_features: feats.input_features,
    decoder_input_ids: new t.Tensor('int64', [BigInt(gc.decoder_start_token_id)], [1, 1]),
  });
  const row = out.logits.tolist()[0].at(-1);

  const entries = Object.entries(gc.lang_to_id ?? {});
  if (!entries.length) return [];
  let max = -Infinity;
  for (const [, id] of entries) if (row[id] > max) max = row[id];
  let sum = 0;
  const exps = entries.map(([tok, id]) => {
    const e = Math.exp(row[id] - max);
    sum += e;
    return [tok.replace(/[<|>]/g, ''), e];
  });
  return exps
    .map(([code, e]) => [code, e / sum])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

self.onmessage = async (e) => {
  const { type, id } = e.data ?? {};

  if (type === 'cancel') { cancelled = true; return; }
  if (type === 'config') { LIB_URL = e.data.libUrl || LIB_URL; return; }
  // Scoring only. WHERE to sample is a product decision and lives in the service, which
  // sends the windows it chose — so an hour of audio is not transferred to answer a
  // question that thirty seconds of it can answer.
  if (type === 'detect') {
    cancelled = false;
    try {
      const { windows = [], size, device, dtype } = e.data;
      const pipe = await getAsr({ size, device, dtype });
      post('stage', { id, stage: 'ready' });
      const scored = [];
      for (const w of windows) {
        if (cancelled) { post('cancelled', { id }); return; }
        scored.push(await detectIn(pipe, w));
      }
      post('detected', { id, windows: scored });
    } catch (err) {
      post('error', { id, message: String(err?.message ?? err) });
    }
    return;
  }

  if (type !== 'run') return;

  cancelled = false;
  const { audio, mode = 'both', language = null, size, device, dtype, threshold, expected } = e.data;

  try {
    let turns = null;
    let detected = null;
    if (mode === 'speakers' || mode === 'both') {
      post('stage', { id, stage: 'speakers' });
      turns = await diarize(audio, { threshold, expected });
      if (cancelled) { post('cancelled', { id }); return; }
    }

    let chunks = [];
    if (mode === 'text' || mode === 'both') {
      post('stage', { id, stage: 'transcribe' });
      const pipe = await getAsr({ size, device, dtype });
      // PROOF OF LIFE, and it matters more than it looks. The host's watchdog treats
      // silence as death, and model init emits download progress only on a COLD cache —
      // warm, it is completely silent and can still take seconds on a slow device. Saying
      // "ready" here splits that silence in two, so the watchdog's budget has to cover
      // inference alone rather than inference plus an unknowable init.
      post('stage', { id, stage: 'ready' });
      if (cancelled) { post('cancelled', { id }); return; }

      // DEFENCE IN DEPTH. The service resolves the language before it gets here, so
      // normally `language` is already a concrete code. But a caller using `transcribe()`
      // on its own must not fall into the library's silent English default, so detect
      // from the middle of whatever we were handed rather than passing nothing through.
      let used = language || null;
      if (!used) {
        const mid = Math.max(0, Math.floor((audio.length - 30 * SAMPLE_RATE) / 2));
        const scored = await detectIn(pipe, audio.subarray(mid, mid + 30 * SAMPLE_RATE));
        used = scored[0]?.[0] ?? 'en';
        detected = { code: used, confidence: scored[0]?.[1] ?? 0, windows: [scored] };
      }
      if (cancelled) { post('cancelled', { id }); return; }

      // An unsupported language still does not fail: it is transcribed as the nearest
      // neighbour Whisper knows, and the result is fluent fabrication. Detection makes
      // that visible (a low confidence is a real signal) but cannot prevent it.
      const out = await pipe(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        language: used,
        task: 'transcribe',
      });
      chunks = (out.chunks ?? []).map((c) => ({
        start: c.timestamp?.[0] ?? 0,
        end: c.timestamp?.[1] ?? 0,
        text: String(c.text ?? '').trim(),
      })).filter((c) => c.text);
      if (!chunks.length && out.text) {
        chunks = [{ start: 0, end: audio.length / SAMPLE_RATE, text: String(out.text).trim() }];
      }
    }

    if (cancelled) { post('cancelled', { id }); return; }
    post('done', {
      id,
      language: language || detected?.code || null,
      detected,
      chunks: chunks.map((c) => ({
        ...c,
        speaker: turns ? speakerAt(turns, (c.start + c.end) / 2) : null,
      })),
      turns,
      seconds: audio.length / SAMPLE_RATE,
    });
  } catch (err) {
    post('error', { id, message: String(err?.message ?? err) });
  }
};
