#!/usr/bin/env node
/**
 * Turn the AMI manual annotations into a reference transcript the accuracy spike can fetch.
 *
 * ## Why a build step rather than reading the zip in the browser
 *
 * The annotation bundle is 22 MB of 5183 files and the spike needs four of them. Shipping a
 * ZIP reader into a measurement page to pull 100 kB out of 22 MB would be work in the wrong
 * place; this writes a single JSON next to the audio instead. `sample-data/` is gitignored,
 * so this script is how the reference is reproducible, exactly like the audio fetcher.
 *
 * ## What counts as a reference word
 *
 * The XML carries three kinds of element and only one of them is speech:
 *
 *   - `<w>` with text — a word. Kept.
 *   - `<w punc="true">` — punctuation as its own element. Dropped, because Whisper's
 *     punctuation is a formatting choice rather than a recognition result, and scoring it
 *     would measure style.
 *   - `<vocalsound type="laugh">` and friends — non-speech. Dropped.
 *
 * Words carry `starttime`/`endtime` and live in per-speaker files, so the output keeps both:
 * word error rate needs the sequence, and diarization scoring will need the speaker and the
 * timing.
 *
 * Usage: node scripts/extract-ami-reference.mjs [meetingId]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ZIP = path.join(ROOT, 'sample-data', 'audio', 'ami_public_manual_1.6.2.zip');
const MEETING = process.argv[2] || 'ES2002a';
const OUT = path.join(ROOT, 'sample-data', 'audio', `ami-${MEETING}-reference.json`);

// =============================================================================
// A minimal ZIP reader — zero dependencies, like everything else in scripts/
// =============================================================================

/** Entries of a ZIP, read from its central directory. */
function readZip(buf) {
  // The end-of-central-directory record is at the tail, after a variable comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`not in zip: ${name}`);
      // The local header repeats the name and extra field with its own lengths.
      const lh = e.localOffset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header');
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const raw = buf.subarray(start, start + e.compressedSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported compression method ${e.method}`);
    },
  };
}

// =============================================================================
// Parsing
// =============================================================================

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);

/** Every spoken word in one speaker's file, in order. */
function parseWords(xml, speaker) {
  const out = [];
  const re = /<w\b([^>]*)>([^<]*)<\/w>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    if (/\bpunc\s*=\s*"true"/.test(attrs)) continue;       // punctuation is not speech
    const word = decode(m[2]).trim();
    if (!word) continue;
    const t = Number(/starttime="([\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const e = Number(/endtime="([\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    out.push({ w: word, t, e, s: speaker });
  }
  return out;
}

// =============================================================================

if (!existsSync(ZIP)) {
  console.error(`Missing ${path.relative(ROOT, ZIP)}.`);
  console.error('Run: node scripts/fetch-sample-audio.mjs ami-annotations');
  process.exit(1);
}

const zip = readZip(readFileSync(ZIP));
const files = zip.names().filter((n) => new RegExp(`words/${MEETING}\\.[A-Z]\\.words\\.xml$`).test(n));
if (!files.length) {
  console.error(`No word files for ${MEETING}. Available meetings look like:`,
    [...new Set(zip.names().filter((n) => n.startsWith('words/'))
      .map((n) => n.split('/')[1].split('.')[0]))].slice(0, 8).join(', '));
  process.exit(1);
}

let words = [];
const perSpeaker = {};
for (const f of files.sort()) {
  const speaker = /\.([A-Z])\.words\.xml$/.exec(f)[1];
  const got = parseWords(zip.read(f).toString('utf8'), speaker);
  perSpeaker[speaker] = got.length;
  words = words.concat(got);
}

// A meeting transcript is the speakers interleaved in time, which is also the order a
// transcriber produces and the order Whisper emits.
words.sort((a, b) => (a.t - b.t) || (a.e - b.e));

const covered = words.length ? words[words.length - 1].e - words[0].t : 0;
const out = {
  meeting: MEETING,
  source: 'AMI Meeting Corpus, University of Edinburgh. https://groups.inf.ed.ac.uk/ami/corpus/',
  licence: 'CC BY 4.0',
  note: 'Punctuation elements and <vocalsound> markers are excluded; only spoken words remain.',
  speakers: Object.keys(perSpeaker).sort(),
  wordCount: words.length,
  firstWordAt: words[0]?.t ?? null,
  lastWordEndsAt: words[words.length - 1]?.e ?? null,
  words,
};
writeFileSync(OUT, JSON.stringify(out), 'utf8');

console.log(`${MEETING}: ${words.length} words from ${files.length} speakers`);
for (const [s, n] of Object.entries(perSpeaker)) console.log(`  speaker ${s}: ${n}`);
console.log(`  speech spans ${words[0].t.toFixed(1)}s to ${words[words.length - 1].e.toFixed(1)}s`
  + ` (${(covered / 60).toFixed(1)} min)`);
console.log(`  ${(words.length / (covered / 60)).toFixed(0)} words per minute across the meeting`);
console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
