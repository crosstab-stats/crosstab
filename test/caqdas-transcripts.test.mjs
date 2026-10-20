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

const {
  parseTranscript, sniffTranscript, parseTimestamp, timingValue, parseTiming,
  cueAtChar, clockOf,
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
