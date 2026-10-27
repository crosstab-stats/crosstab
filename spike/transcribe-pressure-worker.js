/**
 * Worker for `transcribe-pressure.html` — loads the same model the real one does.
 *
 * A real same-origin file rather than a blob URL, for two reasons: the production worker
 * is loaded that way (`new URL('./transcribe-worker.js', import.meta.url)`), so this
 * measures the thing that ships; and the blob version of this spike hung with no error,
 * which is a question about blob module workers rather than about memory.
 */

let lib = null;

/**
 * Run the loaded pipeline over a clip and report how long it took.
 *
 * `max_new_tokens` bounds the decoder. Whisper's encoder cost is fixed per 30 s window but
 * the decoder runs until it stops, and synthetic audio makes it hallucinate at length — so
 * without a cap the timing would measure how chatty the model felt rather than how much
 * the device could get through. Capped, the work per job is near enough constant.
 */
async function run(audio, maxTokens, longForm = true, timestamps = true, wantText = false, gen = null) {
  const t = performance.now();
  // THE OPTIONS THAT SHIP. core/transcribe-worker.js passes chunk_length_s: 30,
  // stride_length_s: 5 and return_timestamps: true, and without them Whisper runs as a
  // single pass over its 30-second receptive field — so anything longer is truncated and
  // the spike silently measures half a clip while reporting a whole one. `longForm: false`
  // exists only to demonstrate that difference.
  // return_timestamps measured at 2.9x the cost of leaving it off (17276 ms against
  // 5910 ms for the same minute). The app needs it for WebVTT cues and for aligning
  // diarized speaker turns to text, so it defaults on — but it is the single biggest
  // performance lever in the shipping configuration and worth being able to toggle.
  const opts = longForm
    ? { chunk_length_s: 30, stride_length_s: 5, ...(timestamps ? { return_timestamps: true } : {}),
        ...(gen || {}) }
    : { max_new_tokens: maxTokens, ...(gen || {}) };
  let out;
  try {
    out = await self.pipe(audio, opts);
  } catch (err) {
    out = await self.pipe(audio);        // never lose a run over a rejected kwarg
  }
  const text = String(out?.text ?? '');
  // Repetition statistics, not the transcript. Whisper hallucinates loops on noisy audio,
  // and a loop inflates BOTH the character count and the time — so a timing taken without
  // this check can be measuring a malfunction and calling it throughput.
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const uniq = new Set(words).size;
  let worstRun = 0;
  for (let i = 1, run = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) worstRun = Math.max(worstRun, ++run);
    else run = 1;
  }
  // The most-repeated 4-word phrase: a cheap detector for the longer loops.
  const grams = new Map();
  for (let i = 0; i + 4 <= words.length; i++) {
    const g = words.slice(i, i + 4).join(' ');
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const topGram = [...grams.values()].reduce((a, b) => Math.max(a, b), 0);
  return {
    ms: Math.round(performance.now() - t),
    // The transcript itself, for scoring against a reference. Off by default because the
    // timing spikes do not need it and a 40-minute transcript is a lot to hand back.
    text: wantText ? text : undefined,
    chars: text.length,
    words: words.length,
    uniqueRatio: words.length ? +(uniq / words.length).toFixed(3) : null,
    repeatedWordRun: worstRun,
    topPhraseRepeats: topGram,
    // The last timestamp says how much audio was actually transcribed, which is the only
    // way to notice truncation from the outside.
    covered: Array.isArray(out?.chunks) && out.chunks.length
      ? (out.chunks[out.chunks.length - 1]?.timestamp?.[1] ?? null)
      : null,
  };
}

self.onmessage = async (e) => {
  if (e.data?.type === 'run') {
    try {
      if (!self.pipe) throw new Error('asked to run before loading');
      const r = await run(e.data.audio, e.data.maxTokens ?? 48,
        e.data.longForm !== false, e.data.timestamps !== false, e.data.wantText === true,
        e.data.gen ?? null);
      self.postMessage({ type: 'done', ...r });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
    return;
  }
  if (e.data?.type !== 'load') return;
  try {
    const url = e.data.libUrl || 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
    lib = await import(/* @vite-ignore */ url);
    // Held on `self` so it cannot be collected while we are measuring.
    self.pipe = await lib.pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny',
      { device: 'wasm', dtype: 'q8' },
    );
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
