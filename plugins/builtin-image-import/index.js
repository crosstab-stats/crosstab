/**
 * @file plugins/builtin-image-import/index.js
 * Built-in importer plugin: File ▸ Import data… ▸ Image files (one row per file).
 *
 * The image member of the per-medium media importer family (#139). Turns a batch of
 * images into a codeable dataset for the CAQDAS coding workspace: one row per file,
 * with a `media` column holding an `asset:<hash>` reference (JSON array, list-shaped
 * from day one) and probed `width`/`height`.
 *
 * The bytes never live in the dataset: the host holds them in the content-addressed
 * media store, and this plugin only ever holds the `File` (by reference) and the ref
 * that comes back. Runs in the media-CSP sandbox (`manifest.media`) so it can decode
 * the image via a blob: `<img>` to read its dimensions; the actual storage streams
 * host-side through `app.media.put`, so a huge image never has to sit in RAM here.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-image-import',
  name: 'Image Import',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Import',
  media: true, // needs the media CSP to decode/probe images (img-src blob:)
  keywords: ['image', 'photo', 'picture', 'png', 'jpg', 'qualitative', 'coding', 'media'],
  disciplines: ['Qualitative', 'Anthropology', 'Communication', 'Education', 'Geography'],
  howto:
    'GUI: File ▸ Import data… ▸ Image files…, then batch-select your images. Each becomes one row (name + a media reference + width/height), ready to code in the Coding workspace.\n' +
    'Used through the File menu, not a run command.',
  imports: [
    {
      label: 'Image files (PNG, JPEG, …) → one row per file…',
      extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'],
      group: 'Media',
      order: 20,
      multiple: true,
      parse: 'parseFile',
    },
  ],
};

/**
 * Store one image and return its single-row dataset. The host streams the file into
 * the media store (`media.put`) and hands back an `asset:` ref; we probe dimensions
 * for the metadata columns. The engine stacks rows from a multi-file selection.
 */
export async function parseFile(app, { name, file }) {
  const dims = await probeImage(file);
  const { ref } = await app.media.put(file, { type: file.type || '', name, medium: 'image', ...dims });
  return mediaRow({ name, ref, medium: 'image', size: file.size, dims });
}

/** Read an image's natural dimensions via a throwaway blob: `<img>`. Never rejects
 * (a decode failure just yields no dimensions) and is capped so a corrupt file can't
 * hang the import. Header/decoder work only — the bytes aren't materialised here. */
function probeImage(file) {
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
    const img = new Image();
    img.onload = () => done({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
    img.onerror = () => done({});
    img.src = url;
  });
}

/** Build the shared one-row media dataset. Only relevant columns are included; the
 * engine's UNION ALL BY NAME merges them across a mixed selection. */
export function mediaRow({ name, ref, medium, size, dims }) {
  const variables = [
    { name: 'name', type: 'string', measurementLevel: 'nominal', label: 'File name' },
    { name: 'media', type: 'string', measurementLevel: 'nominal', label: 'Media' },
    { name: 'type', type: 'string', measurementLevel: 'nominal', label: 'Kind' },
    { name: 'size', type: 'numeric', measurementLevel: 'scale', label: 'Size (bytes)' },
  ];
  const columns = {
    name: [name],
    media: [JSON.stringify([ref])], // list-shaped from day one (one ref today)
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
