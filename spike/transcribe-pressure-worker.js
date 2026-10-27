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
async function run(audio, maxTokens) {
  const t = performance.now();
  let out;
  try {
    out = await self.pipe(audio, { max_new_tokens: maxTokens });
  } catch {
    // The cap is a nicety, not the measurement. Never lose the run over a rejected kwarg.
    out = await self.pipe(audio);
  }
  return { ms: Math.round(performance.now() - t), chars: String(out?.text ?? '').length };
}

self.onmessage = async (e) => {
  if (e.data?.type === 'run') {
    try {
      if (!self.pipe) throw new Error('asked to run before loading');
      const { ms, chars } = await run(e.data.audio, e.data.maxTokens ?? 48);
      self.postMessage({ type: 'done', ms, chars });
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
