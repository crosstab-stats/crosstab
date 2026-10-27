/**
 * Worker for `transcribe-pressure.html` — loads the same model the real one does.
 *
 * A real same-origin file rather than a blob URL, for two reasons: the production worker
 * is loaded that way (`new URL('./transcribe-worker.js', import.meta.url)`), so this
 * measures the thing that ships; and the blob version of this spike hung with no error,
 * which is a question about blob module workers rather than about memory.
 */

let lib = null;

self.onmessage = async (e) => {
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
