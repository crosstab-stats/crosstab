#!/usr/bin/env node
/**
 * Fetch the speech fixtures the transcription spikes measure against.
 *
 * ## Why this script exists
 *
 * The first throughput sweep used synthetic noise, because it needs no file and every
 * device gets byte-identical work. That turned out to measure **the encoder and nothing
 * else**: probed directly, Whisper returns 4 characters on noise at token caps of 16, 48
 * and 220 — it hits end-of-sequence immediately. Whisper's two halves parallelise
 * oppositely (the encoder is wide matmuls already threaded inside one worker; the decoder
 * is autoregressive and leaves cores idle), so a measurement with no decode in it cannot
 * tell us how real interviews scale.
 *
 * `sample-data/` is gitignored, so the fixtures cannot be committed. This script is how
 * they are reproducible instead: run it and get the same bytes, with the licence and
 * attribution written next to them.
 *
 * ## Why these two
 *
 * **AMI ES2002a** is the one with ground truth. Four speakers, 21 minutes, and the corpus
 * ships word-level transcripts WITH speaker labels under CC BY 4.0 — audio and annotations
 * alike. So one file can answer three different questions: how fast, how accurate (word
 * error rate against a human transcript), and whether diarization actually identifies the
 * right number of people. Nothing else free does all three.
 *
 * **VNIT541Reid** is the one that looks like the real job. A two-person oral-history
 * interview, 40 minutes, recorded by the US Army — so it is a federal work in the public
 * domain rather than a licence someone asserted, and it sounds like archival interview
 * audio instead of a clean lab recording. It is also long enough to test the sustained and
 * thermal behaviour that every burst measurement so far has had to extrapolate.
 *
 * Usage:
 *   node scripts/fetch-sample-audio.mjs           the two defaults (~120 MB)
 *   node scripts/fetch-sample-audio.mjs --all     plus far-field AMI and the annotations
 *   node scripts/fetch-sample-audio.mjs --list    print the manifest and exit
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEST = path.join(ROOT, 'sample-data', 'audio');

/**
 * Each fixture records where it came from and what we may do with it, because a fixture
 * whose licence lives only in someone's memory is a liability.
 */
const FIXTURES = [
  {
    id: 'ami-es2002a',
    file: 'ami-ES2002a-mix-headset.wav',
    url: 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav',
    bytes: 40724524,
    about: '21 min, 4 speakers, 16 kHz mono. Mixed close-talk headset mics, so clean audio.',
    licence: 'CC BY 4.0',
    attribution: 'AMI Meeting Corpus, University of Edinburgh. https://groups.inf.ed.ac.uk/ami/corpus/',
    note: 'Has ground-truth word-level transcripts with speaker labels (see --all).',
    default: true,
  },
  {
    id: 'army-reid',
    file: 'army-VNIT541-reid-interview.mp3',
    url: 'https://archive.org/download/VNIT541Reid/VNIT-541_Reid.mp3',
    bytes: 58628096,       // approximate; the check below allows archive.org re-encodes
    bytesApprox: true,
    about: '40.7 min, 2 speakers (interviewer + subject), VBR MP3. Archival interview audio.',
    licence: 'Public Domain Mark 1.0',
    attribution: 'US Army. "Oral history with COL John Reid, Commander, ACTIV (Vietnam War)". '
      + 'https://archive.org/details/VNIT541Reid',
    note: 'A US federal work, so public domain by origin rather than by assertion.',
    default: true,
  },
  {
    id: 'ami-es2002a-farfield',
    file: 'ami-ES2002a-array1-01.wav',
    url: 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Array1-01.wav',
    bytes: null,
    about: 'The same 21 min meeting from a far-field room array instead of headsets — the '
      + 'harder and more realistic case, and the one a laptop mic in an office resembles.',
    licence: 'CC BY 4.0',
    attribution: 'AMI Meeting Corpus, University of Edinburgh. https://groups.inf.ed.ac.uk/ami/corpus/',
    default: false,
  },
  {
    id: 'ami-annotations',
    file: 'ami_public_manual_1.6.2.zip',
    url: 'https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip',
    bytes: 22887865,
    about: 'Manual annotations for the whole AMI corpus: words, timings and speaker turns. '
      + 'This is what makes word error rate and diarization error measurable at all.',
    licence: 'CC BY 4.0',
    attribution: 'AMI Meeting Corpus, University of Edinburgh. https://groups.inf.ed.ac.uk/ami/corpus/',
    default: false,
  },
];

const human = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} kB`);

async function sha256(file) {
  const h = createHash('sha256');
  h.update(await readFile(file));
  return h.digest('hex');
}

/** Already there and the right size? Then leave it alone — these are big files. */
async function present(dest, fx) {
  try {
    const s = await stat(dest);
    if (!s.size) return false;
    if (fx.bytes == null || fx.bytesApprox) return true;
    return s.size === fx.bytes;
  } catch { return false; }
}

async function fetchOne(fx) {
  const dest = path.join(DEST, fx.file);
  if (await present(dest, fx)) {
    const s = await stat(dest);
    console.log(`  = ${fx.file} already present (${human(s.size)})`);
    return { ...fx, size: s.size, sha: await sha256(dest), skipped: true };
  }
  process.stdout.write(`  . ${fx.file} <- ${new URL(fx.url).host} `);
  const res = await fetch(fx.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${fx.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const s = await stat(dest);
  console.log(`${human(s.size)}`);
  return { ...fx, size: s.size, sha: await sha256(dest), skipped: false };
}

/** The licences travel with the files, in a form a person can read. */
async function writeProvenance(got) {
  const lines = [
    '# Sample audio — where it came from and what we may do with it',
    '',
    'Written by `scripts/fetch-sample-audio.mjs`. `sample-data/` is gitignored, so these',
    'files are not in the repository; the script is how they are reproducible.',
    '',
    'These fixtures exist because the transcription throughput sweep originally used',
    'synthetic noise, and noise turns out to decode to nothing — Whisper returns 4',
    'characters on it whatever the token cap. That made the measurement encoder-only, and',
    'the encoder is the half that parallelises WORST. Real speech is the only way to learn',
    'how transcription actually scales, how accurate it is, and whether speaker detection',
    'works.',
    '',
  ];
  for (const f of got) {
    lines.push(`## ${f.file}`, '');
    lines.push(`- **Source**: ${f.url}`);
    lines.push(`- **Licence**: ${f.licence}`);
    lines.push(`- **Attribution**: ${f.attribution}`);
    lines.push(`- **What it is**: ${f.about}`);
    if (f.note) lines.push(`- **Note**: ${f.note}`);
    lines.push(`- **Size**: ${f.size} bytes`);
    lines.push(`- **sha256**: \`${f.sha}\``);
    lines.push('');
  }
  lines.push('Both licences permit reuse with attribution, including commercially. Neither is',
    'a "research only" or non-commercial licence, which is why these were chosen over the',
    'better-known speech corpora that are.', '');
  await writeFile(path.join(DEST, 'PROVENANCE.md'), lines.join('\n'), 'utf8');
  console.log(`\nWrote ${path.relative(ROOT, path.join(DEST, 'PROVENANCE.md'))}`);
}

const argv = process.argv.slice(2);
const ids = argv.filter((a) => !a.startsWith('--'));
// Naming ids explicitly beats --all when one extra is wanted and another is 40 MB of
// far-field audio nobody asked for yet.
const wanted = ids.length
  ? FIXTURES.filter((f) => ids.includes(f.id))
  : FIXTURES.filter((f) => argv.includes('--all') || f.default);
if (ids.length && wanted.length !== ids.length) {
  const known = FIXTURES.map((f) => f.id).join(', ');
  console.error(`Unknown fixture id. Known: ${known}`);
  process.exit(1);
}

if (argv.includes('--list')) {
  for (const f of FIXTURES) {
    console.log(`${f.default ? '*' : ' '} ${f.id.padEnd(22)} ${f.licence.padEnd(24)} `
      + `${f.bytes ? human(f.bytes).padStart(8) : '       ?'}  ${f.about.split('.')[0]}`);
  }
  console.log('\n* = fetched by default; --all fetches everything.');
  process.exit(0);
}

await mkdir(DEST, { recursive: true });
console.log(`Fetching ${wanted.length} fixture(s) into ${path.relative(ROOT, DEST)}/\n`);
const got = [];
for (const fx of wanted) {
  try {
    got.push(await fetchOne(fx));
  } catch (err) {
    console.error(`  ! ${fx.file} FAILED — ${err.message}`);
  }
}
// Describe EVERY fixture on disk, not just the ones fetched this run. Writing only this
// run's results meant `node fetch-sample-audio.mjs ami-annotations` silently dropped the
// licences of the two files already sitting next to it — in the one file whose entire job
// is recording where the bytes came from and what may be done with them.
const onDisk = [];
for (const fx of FIXTURES) {
  const dest = path.join(DEST, fx.file);
  const fetched = got.find((g) => g.id === fx.id);
  if (fetched) { onDisk.push(fetched); continue; }
  try {
    const s = await stat(dest);
    if (s.size) onDisk.push({ ...fx, size: s.size, sha: await sha256(dest) });
  } catch { /* not fetched, not present — nothing to record */ }
}
if (onDisk.length) await writeProvenance(onDisk);
console.log(`\n${got.length}/${wanted.length} ready. Point the spike at one with`);
console.log('  spike/transcribe-pressure.html?audio=/sample-data/audio/<file>&sweep=2,4,8');
