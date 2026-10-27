/**
 * @file mp3-sync.js
 * Find real MPEG-1 Layer III frame boundaries inside a byte range.
 *
 * Shared by the transcription spikes because both need the same thing for the same reason:
 * Safari refuses to decode an MP3 slice that begins mid-frame ("Decoding failed"), which
 * sent the owner's phone down a full-file decode path and cost it ~150 MB it did not have.
 * Scanning forward to a genuine frame header gives the decoder a clean start.
 *
 * Validated against the 40-minute Army recording at 12 byte offsets: every probe found a
 * boundary within one frame (~600 bytes) and the frame chain then covered 100% of the
 * slice. See spike/RESULTS.md.
 */

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG1_RATES = [44100, 48000, 32000];

/**
 * Length in bytes of the frame whose header starts at `i`, or 0 if that is not a header.
 *
 * @param {Uint8Array} b
 * @param {number} i
 */
export function frameLength(b, i) {
  if (i + 4 > b.length) return 0;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  if (((b[i + 1] >> 3) & 0x03) !== 3) return 0;          // MPEG-1 only
  if (((b[i + 1] >> 1) & 0x03) !== 1) return 0;          // Layer III only
  const bitrate = MPEG1_BITRATES[(b[i + 2] >> 4) & 0x0f];
  const rate = MPEG1_RATES[(b[i + 2] >> 2) & 0x03];
  if (!bitrate || !rate) return 0;
  const pad = (b[i + 2] >> 1) & 0x01;
  return Math.floor((144000 * bitrate) / rate) + pad;
}

/**
 * Offset of the first real frame header in `bytes`, or -1.
 *
 * Three consecutive valid frames are required: a lone 0xFF inside audio data passes the
 * single-header test often enough to matter, and a false positive here means a failed
 * decode rather than a wrong answer — but a failed decode is what we are avoiding.
 *
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {number} [searchLimit] how far to look; a frame is ~600 B so the default is ample
 */
export function mp3Sync(bytes, searchLimit = 200000) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const limit = Math.min(b.length - 4, searchLimit);
  for (let i = 0; i < limit; i++) {
    let at = i;
    let ok = true;
    for (let f = 0; f < 3; f++) {
      const len = frameLength(b, at);
      if (!len) { ok = false; break; }
      at += len;
    }
    if (ok) return i;
  }
  return -1;
}

/** Mean absolute amplitude: a cheap, robust stand-in for "is anybody talking". */
export function level(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 7) sum += Math.abs(pcm[i]);
  return sum / Math.ceil(pcm.length / 7);
}

/** A short, stable fingerprint, so two runs can prove they transcribed the same audio. */
export function fingerprint(pcm) {
  let h = 2166136261;
  for (let i = 0; i < pcm.length; i += 997) {
    h ^= Math.round(pcm[i] * 10000) | 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}
