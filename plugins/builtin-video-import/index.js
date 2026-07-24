/**
 * @file plugins/builtin-video-import/index.js
 * Built-in importer plugin: File ▸ Import data… ▸ Video files (one row per file).
 *
 * The video member of the per-medium media importer family (#139): recorded
 * observations, elicitation videos, screen captures → one row per file for the CAQDAS
 * coding workspace, with a `media` ref (JSON array, list-shaped from day one) and
 * probed `duration`/`width`/`height`.
 *
 * Bytes stay host-side in the content-addressed store; this plugin only holds the
 * `File` (by reference) and the ref that comes back. Runs in the media-CSP sandbox
 * (`manifest.media`) so it can read metadata from a blob: `<video preload
 * = 'metadata'>` — header only, so a multi-GB, multi-hour movie probes without loading
 * its body, and the store write streams through `app.media.put`, so nothing sits in
 * RAM (the sink also dodges the browser's ~2 GB single-blob read wall).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-video-import',
  name: 'Video Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Import',
  media: true,
  keywords: ['video', 'movie', 'clip', 'observation', 'mp4', 'webm', 'qualitative', 'coding', 'media'],
  disciplines: ['Qualitative', 'Communication', 'Education', 'Anthropology', 'Sociology', 'Nursing'],
  howto:
    'GUI: File ▸ Import data… ▸ Video files…, then batch-select your clips. Each becomes one row (name + a media reference + duration/width/height), ready to code on the video timeline in the Coding workspace.\n' +
    'Used through the File menu, not a run command.',
  imports: [
    {
      label: 'Video files (MP4, WebM, MOV, …) → one row per file…',
      extensions: ['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv'],
      group: 'Media',
      datasetName: 'Video',

      order: 22,
      multiple: true,
      parse: 'parseFile',
    },
  ],
};

export async function parseFile(app, { name, file }) {
  const dims = await probeVideo(file);
  const { ref } = await app.media.put(file, { type: file.type || '', name, medium: 'video', ...dims });
  return mediaRow({ name, ref, medium: 'video', size: file.size, dims });
}

/** Read a video's duration + frame size from a blob: `<video preload="metadata">` —
 * header only, so a multi-hour movie never loads its body. Never rejects; capped so a
 * stuck decode can't hang the import. */
function probeVideo(file) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve({});
      return;
    }
    let settled = false;
    const done = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(() => done({}), 15000);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      const out = {};
      if (Number.isFinite(el.duration) && el.duration > 0) out.duration = Math.round(el.duration * 1000) / 1000;
      if (el.videoWidth) out.width = el.videoWidth;
      if (el.videoHeight) out.height = el.videoHeight;
      done(out);
    };
    el.onerror = () => done({});
    el.src = url;
  });
}

/** Build the shared one-row media dataset (only relevant columns; UNION ALL BY NAME
 * merges across a mixed selection). */
export function mediaRow({ name, ref, medium, size, dims }) {
  const variables = [
    { name: 'name', type: 'string', measurementLevel: 'nominal', label: 'File name' },
    { name: 'media', type: 'string', measurementLevel: 'nominal', label: 'Media' },
    { name: 'type', type: 'string', measurementLevel: 'nominal', label: 'Kind' },
    { name: 'size', type: 'numeric', measurementLevel: 'scale', label: 'Size (bytes)' },
  ];
  const columns = {
    name: [name],
    media: [JSON.stringify([ref])],
    type: [medium],
    size: [size],
  };
  if (dims.duration != null) {
    variables.push({ name: 'duration', type: 'numeric', measurementLevel: 'scale', label: 'Duration (s)' });
    columns.duration = [dims.duration];
  }
  if (dims.width != null) {
    variables.push({ name: 'width', type: 'numeric', measurementLevel: 'scale', label: 'Width (px)' });
    columns.width = [dims.width];
  }
  if (dims.height != null) {
    variables.push({ name: 'height', type: 'numeric', measurementLevel: 'scale', label: 'Height (px)' });
    columns.height = [dims.height];
  }
  return { variables, columns, source: name };
}
