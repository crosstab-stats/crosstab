/**
 * @file plugins/builtin-audio-import/index.js
 * Built-in importer plugin: File ▸ Import data… ▸ Audio files (one row per file).
 *
 * The audio member of the per-medium media importer family (#139): interview
 * recordings, field audio, voice responses → one row per file for the CAQDAS coding
 * workspace, with a `media` ref (JSON array, list-shaped from day one) and probed
 * `duration`.
 *
 * Bytes stay host-side in the content-addressed store; this plugin only holds the
 * `File` (by reference) and the ref that comes back. Runs in the media-CSP sandbox
 * (`manifest.media`) so it can read metadata from a blob: `<audio>` — `preload
 * = 'metadata'` reads only the header, so a 4-hour recording probes without loading
 * its body, and the store write streams through `app.media.put`, so nothing sits in
 * RAM.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-audio-import',
  name: 'Audio Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Import',
  media: true,
  keywords: ['audio', 'sound', 'recording', 'interview', 'mp3', 'wav', 'qualitative', 'coding', 'media'],
  disciplines: ['Qualitative', 'Communication', 'Sociology', 'Education', 'Music', 'Nursing'],
  howto:
    'GUI: File ▸ Import data… ▸ Audio files…, then batch-select your recordings. Each becomes one row (name + a media reference + duration), ready to code on the audio timeline in the Coding workspace.\n' +
    'Used through the File menu, not a run command.',
  imports: [
    {
      label: 'Audio files (MP3, WAV, M4A, …) → one row per file…',
      extensions: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba'],
      group: 'Media',
      order: 21,
      multiple: true,
      parse: 'parseFile',
    },
  ],
};

export async function parseFile(app, { name, file }) {
  const dims = await probeAudio(file);
  const { ref } = await app.media.put(file, { type: file.type || '', name, medium: 'audio', ...dims });
  return mediaRow({ name, ref, medium: 'audio', size: file.size, dims });
}

/** Read an audio file's duration from a blob: `<audio preload="metadata">` — header
 * only, so it never loads a long recording's body. Never rejects; capped so a stuck
 * decode can't hang the import. */
function probeAudio(file) {
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
    const el = document.createElement('audio');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const out = {};
      if (Number.isFinite(el.duration) && el.duration > 0) out.duration = Math.round(el.duration * 1000) / 1000;
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
