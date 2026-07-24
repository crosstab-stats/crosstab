/**
 * @file media-import.js
 * Host-side media ingest (#139): the "Media files…" entry in File ▸ Import data….
 *
 * Media can't ride the normal (sandboxed) importer path — it has to write the
 * host-owned media store and probe dimensions via real DOM elements, neither of
 * which a plugin can do. So this registers a **host** importer whose `parse` is a
 * plain host function: `import-service` just calls `spec.parse({ticket,name,file})`
 * and waits for `deliver(ticket, …)`, so a host callback drives the exact same
 * picker → parse → deliver → commit flow as any plugin importer, with no sandbox.
 *
 * **One row per file.** Each file's bytes go to the content-addressed store as an
 * `asset:<hash>`, its intrinsic dimensions are probed, and a 1-row dataset is
 * delivered. The engine pools per-file rows with `UNION ALL BY NAME`, so metadata
 * columns appear **as relevant** — audio contributes `duration`, image/video add
 * `width`/`height`, unioned with nulls where a column doesn't apply — with no manual
 * column reconciliation here.
 *
 * The `media` column is a **JSON array of refs** — a single element today, but
 * list-shaped from day one so multiple clips per row need no format migration later
 * (there is no native list column type; the data model is numeric/string/factor).
 */

const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba'];
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'];

/** Register the host media importer into the unified Import picker. */
export function registerMediaImporter({ importers, mediaStore, results }) {
  return importers.register({
    id: 'core-media',
    label: 'Media files (audio, image, video)…',
    group: 'Media',
    extensions: [...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT],
    multiple: true, // pick a whole folder's worth at once → one row each
    parse: ({ ticket, name, file }) => {
      // Host callback: run the async ingest, then deliver. On failure deliver null so
      // the import loop skips just this file (and reports the error) rather than
      // aborting the batch.
      void ingestMediaFile(file, name, mediaStore).then(
        (dataset) => importers.deliver(ticket, dataset),
        (err) => {
          results?.appendError?.(`Media import of “${name}” failed: ${err?.message || err}`);
          importers.deliver(ticket, null);
        },
      );
    },
  });
}

/** Classify a File into audio/image/video from its MIME type, falling back to its
 * extension (some browsers report '' for exotic containers). Null if unrecognised. */
export function mediumOf(file, name = file?.name || '') {
  const mt = String(file?.type || '');
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  const dot = String(name).lastIndexOf('.');
  const ext = dot >= 0 ? String(name).slice(dot).toLowerCase() : '';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

/**
 * Probe a media file's intrinsic dimensions with a throwaway element. Resolves with
 * `{duration?, width?, height?}` — only the fields that apply and decode. **Never
 * rejects**: a probe failure (unsupported codec, corrupt file) just yields no
 * dimensions, and a stubborn decode is capped by a timeout so it can't hang the
 * import.
 */
export function probeMedia(file, medium) {
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

    if (medium === 'image') {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onerror = () => done({});
      img.src = url;
    } else if (medium === 'audio' || medium === 'video') {
      const el = document.createElement(medium === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      el.onloadedmetadata = () => {
        const out = {};
        if (Number.isFinite(el.duration) && el.duration > 0) out.duration = Math.round(el.duration * 1000) / 1000;
        if (medium === 'video') {
          if (el.videoWidth) out.width = el.videoWidth;
          if (el.videoHeight) out.height = el.videoHeight;
        }
        done(out);
      };
      el.onerror = () => done({});
      el.src = url;
    } else {
      done({});
    }
  });
}

/**
 * Ingest one file into the store and return its 1-row dataset (`{variables, columns}`
 * — the same contract any importer delivers). Only the columns relevant to this file
 * are included; the engine unions them across files.
 */
export async function ingestMediaFile(file, name, mediaStore) {
  const medium = mediumOf(file, name) || 'file';
  const dims = await probeMedia(file, medium);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { id } = await mediaStore.put(bytes, {
    type: file.type || '',
    name,
    medium,
    ...dims,
  });
  const ref = `asset:${id}`;

  const variables = [
    { name: 'name', type: 'string', measurementLevel: 'nominal', label: 'File name' },
    { name: 'media', type: 'string', measurementLevel: 'nominal', label: 'Media' },
    { name: 'type', type: 'string', measurementLevel: 'nominal', label: 'Kind' },
    { name: 'size', type: 'numeric', measurementLevel: 'scale', label: 'Size (bytes)' },
  ];
  const columns = {
    name: [name],
    // List-shaped from day one (a single ref today).
    media: [JSON.stringify([ref])],
    type: [medium],
    size: [file.size],
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
