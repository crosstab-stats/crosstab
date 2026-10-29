/**
 * @file caqdas-transcripts.test.mjs
 * Time-aligned transcripts: the parsers, and the two coordinate systems they keep.
 *
 * A transcript is the dominant real qualitative source — most interview work IS coding a
 * transcript against a recording — and it is the one thing the media-coding core could
 * not do. What makes it more than another text import is that every passage has to know
 * BOTH where it sits in the text (so a highlight lands on the right words) and when it
 * was said (so a click can move the playhead). A cue that holds one without the other is
 * no use, so these tests are mostly about the two staying in step.
 *
 * The other thing under test is tolerance. Real files are messy: a `.vtt` with no
 * `WEBVTT` header, an `.srt` with comma decimals, a hand-typed file with wrapped
 * paragraphs and bracketed times, karaoke timestamps inside a cue, HTML entities. None
 * of that should cost the user a line of their data, and none of it should put markup
 * inside a quote that ends up in a paper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../plugins/builtin-caqdas/index.js', import.meta.url), 'utf8');

const {
  parseTranscript, sniffTranscript, parseTimestamp, timingValue, parseTiming,
  cueAtChar, clockOf, textRuns, activeCueIndex, transcriptToDocument,
} = await import('../plugins/builtin-caqdas/index.js');

// =============================================================================
// Timestamps
// =============================================================================

test('a timestamp parses in every shape these formats use', () => {
  assert.equal(parseTimestamp('00:00:01.000'), 1);
  assert.equal(parseTimestamp('00:01:30.500'), 90.5);
  assert.equal(parseTimestamp('01:00:00.000'), 3600);
  assert.equal(parseTimestamp('00:00:02,250'), 2.25, 'SubRip uses a comma decimal');
  assert.equal(parseTimestamp('02:05'), 125, 'MM:SS, which hand-typed files use');
  assert.equal(parseTimestamp('1:02:05'), 3725);
});

test('a short fraction is milliseconds, not a number of them', () => {
  // `.5` is half a second. Reading it as 5 ms would quietly shift every cue.
  assert.equal(parseTimestamp('00:00:01.5'), 1.5);
  assert.equal(parseTimestamp('00:00:01.05'), 1.05);
});

test('something that is not a time is refused rather than guessed at', () => {
  // The plain-text parser offers it every line of the file, so a loose parse would
  // invent cues out of prose that happens to hold a colon.
  for (const bad of ['', 'hello', '00:99:00.000', '00:00:71', 'Ann: hello', null]) {
    assert.ok(Number.isNaN(parseTimestamp(bad)), JSON.stringify(bad));
  }
});

// =============================================================================
// Which format is this
// =============================================================================

test('the three forms are told apart by what is in them', () => {
  assert.equal(sniffTranscript('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi'), 'vtt');
  assert.equal(sniffTranscript('1\n00:00:01,000 --> 00:00:02,000\nhi'), 'srt');
  assert.equal(sniffTranscript('[00:01] Ann: hello'), 'text');
});

test('a header-less VTT is still a VTT, and the decimal is what decides', () => {
  // Plenty of files in the wild omit the WEBVTT line, and an SRT index line is optional
  // in practice — so the comma-vs-point decimal is the only reliable difference.
  assert.equal(sniffTranscript('00:00:01.000 --> 00:00:02.000\nhi'), 'vtt');
  assert.equal(sniffTranscript('00:00:01,000 --> 00:00:02,000\nhi'), 'srt');
});

// =============================================================================
// The two coordinate systems
// =============================================================================

const VTT = `WEBVTT

NOTE this file came from the recorder
and the note runs over two lines

00:00:00.000 --> 00:00:04.000
<v Ann>Ann: I couldn't afford it</v>

00:00:04.000 --> 00:00:09.500
Ben: The bus never came

00:00:09.500 --> 00:00:12.000
Ann: and the nurse knew my name
`;

test('the text is the transcript, plainly, and the cues index into it', () => {
  const { text, cues, kind } = parseTranscript(VTT);
  assert.equal(kind, 'vtt');
  assert.equal(text, "Ann: I couldn't afford it\nBen: The bus never came\nAnn: and the nurse knew my name");
  assert.equal(cues.length, 3);
  // The property the whole feature rests on: every cue's span is exactly its own words.
  for (const c of cues) assert.equal(text.slice(c.start, c.end), lineFor(text, c));
});

/** The line of `text` a cue's offsets point at. */
function lineFor(text, c) {
  return text.slice(c.start, c.end);
}

test('the offsets land on the right words, not merely a plausible length', () => {
  // The failure this prevents is off-by-one accumulation: lengths that all look right
  // while every highlight sits one line adrift.
  const { text, cues } = parseTranscript(VTT);
  assert.equal(text.slice(cues[0].start, cues[0].end), "Ann: I couldn't afford it");
  assert.equal(text.slice(cues[1].start, cues[1].end), 'Ben: The bus never came');
  assert.equal(text.slice(cues[2].start, cues[2].end), 'Ann: and the nurse knew my name');
});

test('the times come across, and an end is never before its start', () => {
  const { cues } = parseTranscript(VTT);
  assert.deepEqual(cues.map((c) => [c.tStart, c.tEnd]), [[0, 4], [4, 9.5], [9.5, 12]]);
  for (const c of cues) assert.ok(c.tEnd > c.tStart, JSON.stringify(c));
});

test('speakers are read from both conventions and LEFT in the text', () => {
  // Stripping the name would make a coded quote ambiguous about whose words it was,
  // which is the one thing a transcript exists to record.
  const { text, cues } = parseTranscript(VTT);
  assert.deepEqual(cues.map((c) => c.speaker), ['Ann', 'Ben', 'Ann']);
  assert.ok(text.includes('Ann: I'), 'the label is still in the text');
});

test('a VTT metadata block contributes no cue', () => {
  // NOTE can run to several lines, which is why it is skipped as a block rather than
  // filtered as a line — a one-line filter leaves "and the note runs over two lines"
  // behind as a cue with no timing.
  const { text } = parseTranscript(VTT);
  assert.ok(!text.includes('recorder'));
  assert.ok(!text.includes('note runs over'));
});

// =============================================================================
// SubRip
// =============================================================================

test('SubRip parses, index lines and comma decimals and all', () => {
  const srt = ['1', '00:00:01,000 --> 00:00:03,000', 'first line', '',
    '2', '00:00:03,000 --> 00:00:05,250', 'second line', ''].join('\n');
  const { text, cues, kind } = parseTranscript(srt);
  assert.equal(kind, 'srt');
  assert.equal(text, 'first line\nsecond line');
  assert.deepEqual(cues.map((c) => c.tEnd), [3, 5.25]);
});

test('a cue of several lines becomes one line of transcript', () => {
  // Subtitle files wrap for the screen; a transcript is not wrapped for a screen, and a
  // coded quote should not contain the break.
  const srt = ['1', '00:00:01,000 --> 00:00:04,000', 'I could not', 'afford it', ''].join('\n');
  const { text, cues } = parseTranscript(srt);
  assert.equal(text, 'I could not afford it');
  assert.equal(cues.length, 1);
  assert.equal(text.slice(cues[0].start, cues[0].end), 'I could not afford it');
});

// =============================================================================
// Hand-typed transcripts
// =============================================================================

test('plain timestamped lines parse, bracketed or bare', () => {
  const plain = ['[00:00:05] Ann: it was the money',
    '00:00:20 Ben: the bus never came',
    '[1:30] Ann: much later'].join('\n');
  const { text, cues, kind } = parseTranscript(plain);
  assert.equal(kind, 'text');
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map((c) => c.tStart), [5, 20, 90]);
  assert.equal(text.split('\n')[0], 'Ann: it was the money');
});

test('a line with a start and no end runs until the next one starts', () => {
  // These files record starts only. Guessing a fixed length would overlap the next line
  // and make every "which cue is this" answer ambiguous.
  const { cues } = parseTranscript(['[00:00:05] one', '[00:00:20] two'].join('\n'));
  assert.equal(cues[0].tEnd, 20);
  assert.ok(cues[1].tEnd > cues[1].tStart, 'and the last one gets the fallback');
});

test('a wrapped paragraph joins the line above instead of being dropped', () => {
  // The common shape of a hand-typed file. Dropping un-timestamped lines would lose
  // most of the content — silently, which is the worst way to lose it.
  const plain = ['[00:00:05] Ann: it was the money, in the end',
    'and I could not see a way round it',
    '[00:00:30] Ben: the bus never came'].join('\n');
  const { text, cues } = parseTranscript(plain);
  assert.equal(cues.length, 2);
  assert.ok(text.includes('money, in the end and I could not see a way round it'));
  assert.equal(text.slice(cues[0].start, cues[0].end),
    'Ann: it was the money, in the end and I could not see a way round it');
});

test('a speaker is one that RECURS, not any short prefix with a colon', () => {
  // No line-by-line rule can tell "I remember thinking:" from a name — both are a short
  // prefix before a colon. What settles it is that a real label comes back.
  const { cues } = parseTranscript([
    '[00:00:05] Ann: it was the money',
    '[00:00:10] I remember thinking: there is no way I can pay that',
    '[00:00:20] 00:15: a time that survived the line parse',
    '[00:00:30] Ann: and the nurse knew my name',
  ].join('\n'));
  assert.equal(cues[0].speaker, 'Ann');
  assert.equal(cues[1].speaker, '', 'a one-off three-word prefix is a sentence');
  assert.equal(cues[2].speaker, '', 'nor is a timestamp that survived the line parse');
  assert.equal(cues[3].speaker, 'Ann');
});

test('a label with a number in it is still a label', () => {
  // "Participant 3" and "Child 2" are ordinary in this literature; an earlier rule
  // banned any digit to keep timestamps out and threw these out with them. What needed
  // excluding was the SHAPE of a timestamp, not the presence of a digit.
  const { cues } = parseTranscript([
    '[00:00:05] Participant 3: it was the money',
    '[00:00:20] Participant 3: and the bus never came',
  ].join('\n'));
  assert.deepEqual(cues.map((c) => c.speaker), ['Participant 3', 'Participant 3']);
});

test('a single-speaker transcript keeps its one label', () => {
  // A one- or two-word candidate is kept even appearing once: a transcript can
  // legitimately hold a single line from `Interviewer`, and losing the label costs more
  // than a rare false positive does.
  const { cues } = parseTranscript('[00:00:05] Interviewer: tell me about the cost');
  assert.equal(cues[0].speaker, 'Interviewer');
});

// =============================================================================
// Markup never reaches a quote
// =============================================================================

test('inline VTT markup is stripped, including karaoke timestamps', () => {
  // All of this would otherwise end up inside a coded quote and then inside a paper.
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000',
    '<c.loud>I <i>really</i></c> <00:00:02.500>could not afford it', ''].join('\n');
  const { text } = parseTranscript(vtt);
  assert.equal(text, 'I really could not afford it');
});

test('entities are decoded, and an escaped entity stays escaped', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000',
    'cost &amp; benefit &lt;see note&gt; &amp;lt;literal&amp;gt;', ''].join('\n');
  const { text } = parseTranscript(vtt);
  assert.equal(text, 'cost & benefit <see note> &lt;literal&gt;');
});

test('cue settings after the end time are not read as content', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000 align:start line:90%',
    'the words', ''].join('\n');
  const { text, cues } = parseTranscript(vtt);
  assert.equal(text, 'the words');
  assert.equal(cues[0].tEnd, 4);
});

test('a cue id line is not mistaken for content', () => {
  const vtt = ['WEBVTT', '', 'intro-1', '00:00:01.000 --> 00:00:04.000', 'the words', ''].join('\n');
  assert.equal(parseTranscript(vtt).text, 'the words');
});

test('control characters do not survive into the text', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000',
    `two${String.fromCharCode(0)}words`, ''].join('\n');
  const { text } = parseTranscript(vtt);
  assert.doesNotMatch(text, /\p{Cc}/u);
  assert.equal(text, 'two words', 'and the words either side do not weld together');
});

// =============================================================================
// What it refuses
// =============================================================================

test('a block with no timing line is skipped and counted', () => {
  const vtt = ['WEBVTT', '', 'just some prose with no timing', '',
    '00:00:01.000 --> 00:00:04.000', 'a real cue', ''].join('\n');
  const { cues, skipped } = parseTranscript(vtt);
  assert.equal(cues.length, 1);
  assert.equal(skipped, 1);
});

test('a file with nothing time-aligned in it yields no cues', () => {
  // The importer refuses rather than making an ordinary text document out of it, so the
  // user is told the file is not what the picker promised.
  assert.equal(parseTranscript('just a plain document\nwith two lines').cues.length, 0);
  assert.equal(parseTranscript('').cues.length, 0);
  assert.equal(parseTranscript(null).cues.length, 0);
});

test('a cue whose body is only markup is skipped, not made empty', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', '<c.loud></c>', '',
    '00:00:04.000 --> 00:00:06.000', 'real words', ''].join('\n');
  const { cues, text } = parseTranscript(vtt);
  assert.equal(cues.length, 1);
  assert.equal(text, 'real words');
  assert.equal(text.slice(cues[0].start, cues[0].end), 'real words',
    'the surviving cue still indexes correctly');
});

test('a BOM and CRLF line endings do not break the first cue', () => {
  const vtt = '﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\nthe words\r\n';
  assert.equal(parseTranscript(vtt).text, 'the words');
});

// =============================================================================
// The timing value: written, read back, and refused when it is not one
// =============================================================================

test('timing round-trips through its stored form', () => {
  const { cues } = parseTranscript(VTT);
  const back = parseTiming(timingValue({ cues, refs: ['asset:abc123'] }));
  assert.deepEqual(back.media, ['asset:abc123']);
  assert.deepEqual(back.cues, cues);
});

test('a transcript with no recording is still a valid timing value', () => {
  // Cancel at the media prompt is a real answer — plenty of archived qualitative data is
  // a transcript with no surviving audio.
  const back = parseTiming(timingValue({ cues: parseTranscript(VTT).cues }));
  assert.deepEqual(back.media, []);
  assert.equal(back.cues.length, 3);
});

test('any other cell in the dataset is NOT read as timing', () => {
  // Detection is by value shape, because a column NAME breaks on rename and on a join.
  // That means every string in the row is offered to it, so it has to be strict.
  for (const not of ['', 'some prose', '42', '["asset:abc"]', '{}', '{"cues":[]}',
    '{"cues":"nope"}', '{"media":["asset:a"]}', null, undefined]) {
    assert.equal(parseTiming(not), null, JSON.stringify(not));
  }
});

test('a malformed cue inside a timing value is dropped, not trusted', () => {
  // Bitrot and hand-editing both reach this. A cue with no offsets cannot be used, and
  // treating a missing offset as 0 would highlight the start of the document.
  const back = parseTiming(JSON.stringify({
    v: 1,
    media: ['asset:a', 'http://evil.example/x', 7],
    cues: [
      { tStart: 0, tEnd: 1, start: 0, end: 5, speaker: 'Ann' },
      { tStart: 1, tEnd: 2, start: null, end: 9 },
      { tStart: 'x', start: 6, end: 9 },
      { tStart: 3, start: 10, end: 14 },
    ],
  }));
  assert.equal(back.cues.length, 2);
  assert.deepEqual(back.media, ['asset:a'], 'only asset/data refs survive');
  assert.equal(back.cues[1].tEnd, 3, 'a cue with no end gets its start, not NaN');
});

// =============================================================================
// From a coded span back to a time
// =============================================================================

test('a character offset resolves to the cue it sits in', () => {
  const { text, cues } = parseTranscript(VTT);
  assert.equal(cueAtChar(cues, 0).tStart, 0);
  assert.equal(cueAtChar(cues, 5).tStart, 0);
  assert.equal(cueAtChar(cues, text.indexOf('Ben')).tStart, 4);
  assert.equal(cueAtChar(cues, text.indexOf('nurse')).tStart, 9.5);
});

test('the newline between two cues belongs to the one that ended', () => {
  // Otherwise a selection that includes the line break reports a time from the line
  // after the words it covers.
  const { cues } = parseTranscript(VTT);
  assert.equal(cueAtChar(cues, cues[0].end).tStart, 0);
});

test('an offset past the end gives the last cue, and nonsense gives nothing', () => {
  const { cues } = parseTranscript(VTT);
  assert.equal(cueAtChar(cues, 10_000).tStart, 9.5);
  assert.equal(cueAtChar(cues, -1), null);
  assert.equal(cueAtChar(cues, NaN), null);
  assert.equal(cueAtChar([], 5), null);
});

test('the lookup is correct over many cues, not just a handful', () => {
  // It binary-searches because a long interview holds thousands of cues and this runs
  // for every coding on every render — so the search has to be checked at every index.
  const lines = Array.from({ length: 500 }, (_, i) => `[0:${String(i).padStart(2, '0')}] line ${i}`);
  // Build with explicit seconds so the times are strictly increasing past a minute.
  const plain = Array.from({ length: 500 }, (_, i) => `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}] line ${i}`);
  void lines;
  const { text, cues } = parseTranscript(plain.join('\n'));
  assert.equal(cues.length, 500);
  for (let i = 0; i < cues.length; i += 1) {
    const mid = Math.floor((cues[i].start + cues[i].end) / 2);
    assert.equal(cueAtChar(cues, mid).start, cues[i].start, `cue ${i}`);
    assert.equal(text.slice(cues[i].start, cues[i].end), `line ${i}`);
  }
});

// =============================================================================
// The clock
// =============================================================================

test('the clock reads as a clock', () => {
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(9), '0:09');
  assert.equal(clockOf(90), '1:30');
  assert.equal(clockOf(3600), '1:00:00');
  assert.equal(clockOf(3725.9), '1:02:05', 'the part-second is not rounded up to a new second');
  assert.equal(clockOf(-5), '0:00');
  assert.equal(clockOf(NaN), '0:00');
});

// =============================================================================
// The coding surface: runs
// =============================================================================
// Splitting the text at every coding boundary was inline in the renderer; a transcript
// needs the same runs grouped into lines, so it is one function now. Two copies of
// boundary arithmetic is how a highlight ends up one character out in one view and not
// the other.

const spans = (runs) => runs.map((r) => [r.a, r.b, r.covering.length]);

test('with no codings the whole document is one run', () => {
  assert.deepEqual(spans(textRuns(10, [])), [[0, 10, 0]]);
});

test('a coding splits the text into before, the coding, and after', () => {
  assert.deepEqual(spans(textRuns(20, [{ start: 5, end: 9 }])),
    [[0, 5, 0], [5, 9, 1], [9, 20, 0]]);
});

test('the runs tile the document exactly — no gap, no overlap', () => {
  // The property the renderer depends on: it concatenates run slices, so a gap loses
  // text and an overlap duplicates it.
  const runs = textRuns(30, [{ start: 2, end: 8 }, { start: 6, end: 12 }, { start: 20, end: 25 }]);
  assert.equal(runs[0].a, 0);
  assert.equal(runs[runs.length - 1].b, 30);
  for (let i = 1; i < runs.length; i += 1) assert.equal(runs[i].a, runs[i - 1].b);
});

test('an overlapping pair gives the shared stretch BOTH codings', () => {
  // Two coders, or two codes on one passage. The renderer colours by the first and shows
  // every one in the tooltip, which it cannot do if the run only knows about one.
  const runs = textRuns(20, [{ start: 2, end: 10, codeId: 'a' }, { start: 6, end: 14, codeId: 'b' }]);
  assert.deepEqual(spans(runs), [[0, 2, 0], [2, 6, 1], [6, 10, 2], [10, 14, 1], [14, 20, 0]]);
  assert.deepEqual(runs[2].covering.map((c) => c.codeId), ['a', 'b']);
});

test('a coding reaching past the end of the text is clamped, not dropped', () => {
  // The text can shrink under a coding — the document was edited — and the anchor
  // resolver leaves the offsets as it found them.
  const runs = textRuns(10, [{ start: 8, end: 40 }]);
  assert.deepEqual(spans(runs), [[0, 8, 0], [8, 10, 1]]);
});

test('extra boundaries split further without changing the covering', () => {
  // The transcript pane passes its cue edges so no run straddles two lines.
  const runs = textRuns(20, [{ start: 2, end: 18 }], [10]);
  assert.deepEqual(spans(runs), [[0, 2, 0], [2, 10, 1], [10, 18, 1], [18, 20, 0]]);
});

test('degenerate input yields nothing rather than a broken run', () => {
  for (const len of [0, -1, NaN, null, 'ten']) {
    assert.deepEqual(textRuns(len, [{ start: 0, end: 5 }]), [], JSON.stringify(len));
  }
  // A coding with no position cannot be drawn and must not break the ones that can.
  assert.deepEqual(spans(textRuns(10, [{ start: null, end: 5 }, { start: 2, end: 4 }])),
    [[0, 2, 0], [2, 4, 1], [4, 10, 0]]);
});

test('a zero-width coding does not produce an empty run', () => {
  // An empty run would be an empty <mark> — invisible, unclickable, and counted.
  assert.deepEqual(spans(textRuns(10, [{ start: 4, end: 4 }])), [[0, 4, 0], [4, 10, 0]]);
});

// =============================================================================
// The coding surface: which line is playing
// =============================================================================

test('the active cue follows the clock', () => {
  const { cues } = parseTranscript(VTT);
  assert.equal(activeCueIndex(cues, 0), 0);
  assert.equal(activeCueIndex(cues, 3.9), 0);
  assert.equal(activeCueIndex(cues, 4), 1);
  assert.equal(activeCueIndex(cues, 11), 2);
});

test('before the first cue nothing is lit', () => {
  // A transcript that starts at 0:08 should not light its first line at 0:00.
  const { cues } = parseTranscript(['WEBVTT', '', '00:00:08.000 --> 00:00:10.000', 'late', ''].join('\n'));
  assert.equal(activeCueIndex(cues, 0), -1);
  assert.equal(activeCueIndex(cues, 8), 0);
});

test('a gap between cues keeps the line that just ended', () => {
  // Silence between two lines is part of reading the one before it, and a highlight that
  // blinks off in every pause is worse than one that lingers.
  const { cues } = parseTranscript(['WEBVTT', '',
    '00:00:00.000 --> 00:00:02.000', 'first', '',
    '00:00:10.000 --> 00:00:12.000', 'second', ''].join('\n'));
  assert.equal(activeCueIndex(cues, 5), 0, 'in the silence after the first line');
  assert.equal(activeCueIndex(cues, 10), 1);
});

test('past the end the last line stays lit, and nonsense lights nothing', () => {
  const { cues } = parseTranscript(VTT);
  assert.equal(activeCueIndex(cues, 10_000), 2);
  assert.equal(activeCueIndex(cues, NaN), -1);
  assert.equal(activeCueIndex([], 5), -1);
  assert.equal(activeCueIndex(null, 5), -1);
});

test('the search is right at every index, not just at the ends', () => {
  // It binary-searches because `timeupdate` fires several times a second.
  const plain = Array.from({ length: 300 },
    (_, i) => `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}] line ${i}`);
  const { cues } = parseTranscript(plain.join('\n'));
  for (let i = 0; i < cues.length; i += 1) {
    assert.equal(activeCueIndex(cues, cues[i].tStart), i, `at the start of cue ${i}`);
    assert.equal(activeCueIndex(cues, cues[i].tStart + 0.5), i, `mid-cue ${i}`);
  }
});

// =============================================================================
// The surface's wiring, which is DOM work and read from the source
// =============================================================================

test('a time gutter is marked as chrome, or it would shift every offset', async () => {
  // Character offsets are measured by walking the text nodes in the pane. A gutter
  // reading "0:04" that is not skipped adds four characters to every offset after it,
  // and every highlight in the document sits adrift of the words it marks.
  const src = await readFile(new URL('../plugins/builtin-caqdas/index.js', import.meta.url), 'utf8');
  const render = src.slice(src.indexOf('function renderCueLines'), src.indexOf('function seekTo'));
  assert.match(render, /gut\.setAttribute\(NONTEXT/, 'the gutter must be marked');
  // And both directions must skip the SAME nodes, or a selection restored after a
  // re-render lands somewhere other than where it was made.
  const off = src.slice(src.indexOf('function offsetWithin'), src.indexOf('function offsetWithin') + 600);
  const setr = src.slice(src.indexOf('function setSelectionRange'), src.indexOf('function setSelectionRange') + 900);
  assert.match(off, /documentTextWalker\(container\)/);
  assert.match(setr, /documentTextWalker\(container\)/);
});

test('the newline between two lines is in the text ONCE', () => {
  // The newline is real text at a real offset, so the line it ends must contain it —
  // which is why a line runs to the NEXT cue's start rather than to its own end.
  //
  // The first draft appended a synthetic `\n` per line INSTEAD, and the run covering the
  // real one was then picked up by the following line. The browser pass measured 83
  // characters in an 81-character document: one character of drift per line, so a coded
  // highlight a word out at the top of a transcript and a sentence out at the bottom.
  // Node could not see it — `textRuns` was right and the renderer's assembly was not.
  const render = SRC.slice(SRC.indexOf('function renderCueLines'), SRC.indexOf('function seekTo'));
  assert.match(render, /cues\[i \+ 1\]\.start/, 'a line runs to where the next one starts');
  assert.doesNotMatch(render, /createTextNode\('\\n'\)/,
    'a synthetic newline would be the second copy of one the runs already carry');
});

test('a transcript is a TEXT document, so coding it needs no new path', async () => {
  // The whole design: the timing only adds a player and a gutter. If a transcript were
  // its own `kind`, every one of retrieve, memos, drift, QDPX export and the quantitiser
  // would need a branch for it.
  const src = await readFile(new URL('../plugins/builtin-caqdas/index.js', import.meta.url), 'utf8');
  const load = src.slice(src.indexOf('async function loadDocs'), src.indexOf('async function loadDocs') + 2400);
  assert.match(load, /kind: 'text', text: raw, label,/);
  assert.doesNotMatch(load, /kind: 'transcript'/);
});

test('the coded quote comes from the DOCUMENT, never from the selection string', () => {
  // A transcript draws each line as its own block, so the browser's own
  // `Selection.toString()` inserts and drops line breaks at those boundaries — measured
  // over all 3321 spans of a three-line transcript in Chrome. The offsets are exact
  // either way, so the quote must be sliced out of the document text. Reaching for
  // `range.toString()` here would look like a simplification and would start storing the
  // gutter clocks inside quotes.
  const src = SRC.slice(SRC.indexOf('const currentSpan ='), SRC.indexOf('const currentSpan =') + 1200);
  assert.match(src, /doc\.text\.slice\(lo, hi\)/);
  assert.doesNotMatch(src, /range\.toString\(\)/);
  assert.doesNotMatch(src, /sel\.toString\(\)/);
});

test('a time gutter is not selectable, which is a separate guard from the offsets', () => {
  // Two different jobs: `user-select: none` decides what the BROWSER puts in a
  // selection (so a quote copied out of the pane has no clock in the middle of the
  // sentence), and the tree-walker filter decides what the plugin COUNTS. Neither
  // substitutes for the other, and dropping either was a bug found in the browser.
  const css = SRC.slice(SRC.indexOf('.caqdas__cuetime {'), SRC.indexOf('.caqdas__cuetime:hover'));
  assert.match(css, /user-select: none/);
  assert.match(css, /-webkit-user-select: none/, 'iPad Safari needs the prefix');
});

// =============================================================================
// From a transcription result to a codeable transcript (#139)
// =============================================================================
//
// The engine hands back data and says nothing about what a transcript IS — that is the
// plugin's decision, and another plugin putting the same result in its own dataset would
// be equally right. CAQDAS's answer is the shape the tests above already describe: text
// plus cues, two coordinate systems that must stay in step.

// The engine's result carries a WebVTT string, which is what `transcriptToDocument`
// feeds to the SAME parser an imported .vtt goes through. These build one the way core
// does (`toVtt`), so the two halves are tested against each other rather than against a
// hand-written fixture that could drift from what the engine actually emits.
const vttTime = (s) => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec}.${ms}`;
};
const result = (chunks) => ({
  chunks,
  vtt: ['WEBVTT', ''].concat(chunks.flatMap((c) => [
    `${vttTime(c.start)} --> ${vttTime(c.end ?? c.start)}`,
    c.speaker === null || c.speaker === undefined
      ? String(c.text ?? '')
      : `<v Speaker ${c.speaker + 1}>${String(c.text ?? '')}`,
    '',
  ])).join('\n'),
});

test('a transcribed interview is the SAME shape as an imported .vtt', () => {
  // The point of delegating: one parser, so the two can never drift. A second
  // implementation here would be a second place for text offsets and cue times to
  // disagree, which is the bug that puts a coded highlight on the wrong words.
  const doc = transcriptToDocument(result([
    { start: 0, end: 2.5, text: 'Hello there', speaker: 0 },
    { start: 2.5, end: 5, text: 'and welcome', speaker: 1 },
  ]), 'asset:xyz');
  const parsed = parseTiming(doc.timing);
  assert.ok(parsed, 'the timing cell is one parseTiming accepts');
  assert.deepEqual(parsed.media, ['asset:xyz']);
  assert.equal(parsed.cues.length, 2);
  // Every cue must point at its own words in the assembled text.
  for (const c of parsed.cues) {
    const slice = doc.text.slice(c.start, c.end);
    assert.ok(slice.trim().length, `cue ${c.tStart} covers text`);
  }
  assert.match(doc.text, /Hello there/);
  assert.match(doc.text, /and welcome/);
});

test('the timing cell carries the version the rest of the code expects', () => {
  // timingValue stamps `v: 1`; a hand-rolled JSON.stringify here omitted it, which is
  // the sort of difference that goes unnoticed until a future reader needs it.
  const doc = transcriptToDocument(result([{ start: 0, end: 1, text: 'hi' }]), 'asset:a');
  assert.equal(JSON.parse(doc.timing).v, 1);
});

test('speakers survive the round trip as names', () => {
  const doc = transcriptToDocument(result([
    { start: 0, end: 1, text: 'first', speaker: 0 },
    { start: 1, end: 2, text: 'second', speaker: 1 },
  ]), null);
  const parsed = parseTiming(doc.timing);
  assert.deepEqual(parsed.cues.map((c) => c.speaker), ['Speaker 1', 'Speaker 2']);
});

test('a media ref is optional — without one it is a transcript with no player', () => {
  const doc = transcriptToDocument(result([{ start: 0, end: 1, text: 'hi' }]), null);
  assert.deepEqual(parseTiming(doc.timing).media, []);
});

test('nothing in, nothing out — and it does not throw', () => {
  for (const bad of [null, undefined, {}, { vtt: '' }, { vtt: 'WEBVTT\n' }]) {
    const doc = transcriptToDocument(bad);
    assert.equal(typeof doc.text, 'string');
    assert.equal(typeof doc.timing, 'string');
  }
});

// =============================================================================
// The Transcripts toolbar on a phone
//
// There is no layout engine here, so this pins the STRUCTURE that the layout depends
// on rather than the pixels. Measured in a real browser at 390 px and 320 px: the old
// flat row split "Model" from its select and "to" from its input, because labels and
// controls were siblings and the wrap could fall between them. Nesting the control
// inside its label makes that impossible to express.

test('every control in the transcribe toolbar is nested inside its own label', () => {
  const bar = SRC.slice(SRC.indexOf('// ---- controls ---'), SRC.indexOf('root.append(bar)'));
  assert.ok(bar, 'the toolbar is where we think it is');

  // The shape that caused the bug: a label appended as a SIBLING of its control, so a
  // wrap could fall between them. Substring checks rather than built regexes — the
  // escaping is the part that goes wrong, and there is nothing here that needs it.
  assert.ok(
    !bar.includes("bar.append(mk('label'"),
    'labels are not appended to the bar as bare siblings of their controls',
  );
  // And the shape that fixes it: each control is passed to field(), which nests it.
  for (const name of ['Model', 'Mode', 'Language', 'From', 'to']) {
    assert.ok(
      bar.includes(`field('${name}'`),
      `${name} is a field(), so its label contains its control`,
    );
  }
});

test('a field can shrink instead of pushing the row off a phone screen', () => {
  // `min-width: auto` is a flex item's default and it REFUSES to go below its content,
  // so one wide option ("Faster - 16 min per hour of audio (73 MB)") drags the whole row
  // past the right edge rather than wrapping. This is the line that allows the shrink.
  const bar = SRC.slice(SRC.indexOf('// ---- controls ---'), SRC.indexOf('root.append(bar)'));
  assert.match(bar, /minWidth: '0'/, 'fields may shrink below their content width');
  assert.match(bar, /flexWrap: 'nowrap'/, 'but never break inside a field');
  assert.match(bar, /flexWrap: 'wrap'/, 'while the bar itself wraps between fields');
});

// =============================================================================
// A transcription must survive the tab being re-created
//
// Reported from a phone: a 21-minute interview reached "part 2 of 11" and then the row
// went back to idle as if nothing had been started. The row -> job mapping lived in a
// plain Map rebuilt on every mount, and this tab is an iframe that gets re-created — by
// a dataset switch, a project switch, the Restart button, or iOS discarding it under the
// memory pressure transcription itself creates. Losing the map orphaned the job: the row
// showed idle, and because harvesting only ever walks that map, the transcript the engine
// went on to finish was never collected.
//
// Driven in a browser against a fake queue, before and after: the old code showed
// "— Transcribe" after a remount with the job sitting in the queue done and unclaimed;
// the new code still showed "running — part 2 of 11" and harvested it on completion.
// These pin the parts of that which can be checked without a DOM.
// =============================================================================

test('the in-flight row to job mapping is persisted, not just the finished transcripts', () => {
  // `transcripts` was always persisted — the comment above it even says losing an hour
  // of transcription to a navigation would be unforgivable. The job still RUNNING was
  // the half that was not kept.
  assert.ok(SRC.includes('transcribing:'), 'state carries the in-flight mapping');
  assert.ok(
    SRC.includes('transcripts: saved, transcribing: pending'),
    'both halves are written by the same persist()',
  );
  assert.ok(
    SRC.includes('new Map(Object.entries(pending))'),
    'and a fresh mount starts from what the last one left behind',
  );
});

test('a job is recorded when it STARTS, not when it finishes', () => {
  // Writing it on completion would be useless: the whole point is to survive something
  // that happens while the job is still running.
  const start = SRC.indexOf('async function startOne');
  const body = SRC.slice(start, SRC.indexOf('allBtn.addEventListener', start));
  assert.ok(body.includes('pending[row.rid] = id'), 'the mapping is written at enqueue time');
  assert.ok(body.includes('await persist()'), 'and flushed immediately');
});

test('re-attaching by name requires an unambiguous pairing', () => {
  // Row ids change when a dataset is reloaded, so the persisted map is not always enough
  // and the job name (the row label) is the only other handle. Guessing wrong would file
  // a transcript against the wrong recording, which is worse than leaving it unattached
  // where it is at least visible — so it only adopts when there is exactly one candidate
  // on each side.
  const at = SRC.indexOf('And adopt a job that is plainly ours');
  assert.ok(at > 0, 'the re-attach pass exists');
  const body = SRC.slice(at, at + 1400);
  assert.ok(body.includes('matches.length === 1'), 'one row with that label');
  assert.ok(body.includes('sameName.length === 1'), 'and one job with that name');
});

test('work that cannot be matched to a row is reported, never silently dropped', () => {
  assert.ok(SRC.includes('const orphans = status.jobs.filter'), 'unattached jobs are collected');
  // The phrase wraps across a template-literal line, so match the contiguous part.
  assert.ok(SRC.includes('not matched to a '), 'and said out loud');
  assert.ok(SRC.includes('finished but unclaimed'), 'including the ones already done');
  // Discarding must not be able to stop work in progress.
  const at = SRC.indexOf('orphanDiscard.addEventListener');
  const body = SRC.slice(at, at + 700);
  assert.ok(body.includes('app.transcribe.forget()'), 'discard only forgets finished jobs');
});

test('every path that drops the mapping drops the persisted copy too', () => {
  // A stale entry pointing at a job the engine no longer has would leave a row waiting
  // forever on something that does not exist.
  const refresh = SRC.slice(SRC.indexOf('async function refresh()'));
  const harvest = refresh.slice(0, refresh.indexOf('table.replaceChildren'));
  const deletes = (harvest.match(/delete pending\[/g) ?? []).length;
  assert.ok(deletes >= 2, `harvest and failure both clear it (found ${deletes})`);
  assert.ok(
    harvest.includes('if (!byId.has(id))'),
    'and a mapping naming a job the engine has lost is dropped on sight',
  );
});

// =============================================================================
// "Failed, no status"
//
// Reported from a phone, on a clean launch: language detected, "clip 0 of 11", and then
// the row went straight back to idle. Nothing in Output, no status anywhere.
//
// The cause was one line in the harvest loop: a job reaching `failed` had its row->job
// mapping DELETED, so `describe()` then found no job for the row and rendered it as
// idle. The engine's `job.error` — which said exactly what went wrong — was thrown away
// on the next poll, one tick after it arrived. A failure was indistinguishable from
// never having pressed the button.
//
// Driven in a browser against a fake queue, before and after. Old: "running - part 0 of
// 11" then "- Transcribe" with no Output entry. New: "failed - Transcription worker
// failed: out of memory - Try again", still there after a remount, and the same text in
// Output.
// =============================================================================

test('a failed transcription is remembered, not erased', () => {
  assert.ok(SRC.includes('transcribeFailures'), 'failures are persisted like transcripts');
  const at = SRC.indexOf("job.state === 'failed' || job.state === 'cancelled'");
  assert.ok(at > 0, 'the failure branch exists');
  const branch = SRC.slice(at, at + 1200);
  assert.ok(branch.includes('failures[rid] = {'), 'the reason is kept');
  assert.ok(branch.includes('job.error'), "and it is the engine's own reason");
});

test('a failure is reported in Output, where a user goes looking', () => {
  const at = SRC.indexOf("job.state === 'failed' || job.state === 'cancelled'");
  const branch = SRC.slice(at, at + 1200);
  assert.ok(branch.includes('app.results?.appendError?.'), 'it reaches the Output tab');
  assert.ok(branch.includes('failed:'), 'naming the recording and the reason');
});

test('a remembered failure outranks idle in the row', () => {
  // The bug was precisely that `!job` fell through to "-", so the order of these two
  // checks is the fix.
  const at = SRC.indexOf('if (!job && failures[row.rid])');
  assert.ok(at > 0, 'a remembered failure is checked BEFORE falling back to idle');
  assert.ok(at < SRC.indexOf("if (!job) return { state: '\u2014', detail: '' };"),
    'and it comes first');
});

test('trying again clears the old verdict', () => {
  const start = SRC.indexOf('async function startOne');
  const body = SRC.slice(start, SRC.indexOf('allBtn.addEventListener', start));
  assert.ok(body.includes('delete failures[row.rid]'), 'a new attempt clears the failure');
  assert.ok(SRC.includes("'Try again'"), 'and the button says the row has been tried');
});
