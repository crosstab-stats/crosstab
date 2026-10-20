/**
 * @file todo-hygiene.test.mjs
 * TODO.md is the board. These are the ways it has actually lied about what is left.
 *
 * Three stale markers turned up in a fortnight — the `band` chart kind shipped with its
 * box unticked, the `atomicWrite` entry, and a variable-picker item whose three children
 * were all resolved while the parent still read "two of three". Each cost a conversation:
 * the owner asks what is open, the answer includes finished work, and the next few
 * minutes go on re-deriving that it is finished. None of it was caught by anything,
 * because the only existing TODO-reading test guards the chart inventory.
 *
 * So these check the three shapes the drift took. They are deliberately about the
 * FILE's own rules rather than about taste:
 *
 *  1. A top-level `[x]` under *Open work* is misfiled by the file's own preamble, which
 *     says completed entries live under **Completed** "in the original sections".
 *  2. A `[~]` parent whose every child is `[x]` is finished unless prose says otherwise —
 *     and when prose does say otherwise, say so HERE too, with a reason.
 *  3. A gap in an entry's numbered children means a row went missing. That is how #148
 *     hid a half-built item: its list ran 1, 2, 3, 5, 6, and the absent 4 was
 *     "inter-coder reliability", whose coefficients had shipped and whose
 *     disagreement view had not.
 *
 * What these CANNOT check is whether an entry's prose matches the code it describes;
 * that is the comment-audit problem and it needs a reader. These catch the mechanical
 * half, which is the half that recurs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../TODO.md', import.meta.url), 'utf8');
const LINES = SRC.replace(/\r\n/g, '\n').split('\n');

/** Everything above `## Completed` — the live board. */
const OPEN_END = LINES.findIndex((l) => l.startsWith('## Completed'));

test('the file still has the two halves these tests are about', () => {
  // If the structure is reorganised, every test below silently passes on nothing.
  assert.ok(OPEN_END > 0, 'no "## Completed" heading');
  assert.ok(LINES.some((l) => l.startsWith('## Open work')), 'no "## Open work" heading');
  assert.ok(LINES.slice(0, OPEN_END).some((l) => /^- \[[ ~]\] /.test(l)),
    'the open section holds no open items, which cannot be right');
});

const openLines = () => LINES.slice(0, OPEN_END);
const titleOf = (l) => l.replace(/^\s*- \[[ x~]\] /, '').replace(/\*\*/g, '').slice(0, 80);

// =============================================================================
// 1. Finished entries do not sit on the board
// =============================================================================

test('no top-level [x] entry is left under Open work', () => {
  // The file's preamble: completed entries keep their full reasoning under Completed,
  // "in the original sections". A done entry left here is read as open by every survey
  // of what is left — which is exactly what happened to four of them.
  //
  // Note this is TOP-LEVEL only. A `[x]` CHILD under an unfinished parent belongs here:
  // that is how a partly-done entry shows which parts are done.
  const stale = openLines()
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^- \[x\] /.test(l))
    .map(({ l, i }) => `TODO.md:${i + 1} ${titleOf(l)}`);
  assert.deepEqual(stale, [], 'move these to the mirrored heading under ## Completed');
});

// =============================================================================
// 2. A [~] parent with nothing left in it
// =============================================================================

/**
 * `[~]` entries whose every checkbox child is `[x]`, but which are legitimately still in
 * progress because the remaining work is in their PROSE rather than in a checkbox.
 *
 * An allowlist rather than a looser rule, because the looser rules are all worse: looking
 * for words like "still open" rewards phrasing over substance, and skipping the check
 * whenever an entry has un-checkboxed bullets skips almost every entry in the file. This
 * way a new occurrence fails, and closing one means deleting a line here — which is the
 * reminder the whole test exists to provide.
 *
 * Each key is the start of the entry's title; each value is why it is NOT finished.
 */
const PROSE_REMAINDER = {
  'File import — as a plugin extension point':
    'the `readFile` ~128 MB ceiling on the way back OUT of WebR is still only mitigated '
    + 'in a note, not in code',
  'Import data from a web page (URL scrape)':
    'the general case is an undecided fetch strategy (serverless proxy vs paste-the-HTML); '
    + 'only the Wikipedia slice is built',
};

/** Top-level entries paired with their immediate checkbox children. */
function entriesWithChildren() {
  const out = [];
  const lines = openLines();
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^- \[([ x~])\] /.exec(lines[i]);
    if (!head) continue;
    const entry = { mark: head[1], line: i + 1, title: titleOf(lines[i]), kids: [] };
    for (let j = i + 1; j < lines.length && !/^- \[/.test(lines[j]); j += 1) {
      const kid = /^\s+- \[([ x~])\] /.exec(lines[j]);
      if (kid) entry.kids.push({ mark: kid[1], line: j + 1, title: titleOf(lines[j]) });
    }
    out.push(entry);
  }
  return out;
}

test('a [~] entry whose every child is done is closed, or says why not', () => {
  const unexplained = entriesWithChildren()
    .filter((e) => e.mark === '~' && e.kids.length && e.kids.every((k) => k.mark === 'x'))
    .filter((e) => !Object.keys(PROSE_REMAINDER).some((k) => e.title.startsWith(k)))
    .map((e) => `TODO.md:${e.line} ${e.title}`);
  assert.deepEqual(unexplained, [],
    'tick these [x] and move them to Completed, or add them to PROSE_REMAINDER with the reason');
});

test('the allowlist cannot rot: every entry it names still exists and is still [~]', () => {
  // Without this, an allowlist entry outlives the thing it excuses and quietly disables
  // the check for a title nobody will ever write again.
  const entries = entriesWithChildren();
  for (const [prefix, why] of Object.entries(PROSE_REMAINDER)) {
    const hit = entries.find((e) => e.title.startsWith(prefix));
    assert.ok(hit, `PROSE_REMAINDER names "${prefix}", which is no longer an open entry`);
    assert.equal(hit.mark, '~', `"${prefix}" is no longer [~] — drop it from PROSE_REMAINDER`);
    assert.ok(why.length > 20, `give a real reason for "${prefix}"`);
  }
});

// =============================================================================
// 3. A numbered child that went missing
// =============================================================================

test('an entry’s numbered children have no gaps', () => {
  // How #148 hid a half-built item. The list ran 1, 2, 3, 5, 6 and read as finished,
  // while `PREREQUISITE for 3 + 4` still pointed at a row that was no longer in the
  // file — so "inter-coder reliability" was invisible for weeks with half of it built.
  //
  // Renumbering a list to close a gap is NOT the fix: the numbers are referred to by
  // prose elsewhere in the entry. The fix is to put the missing row back, or to say in
  // the entry where it went.
  const gaps = [];
  for (const e of entriesWithChildren()) {
    const ns = e.kids
      .map((k) => /^(\d+)\.\s/.exec(k.title))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    if (ns.length < 2) continue;
    const seen = new Set(ns);
    for (let n = Math.min(...ns); n < Math.max(...ns); n += 1) {
      if (!seen.has(n)) gaps.push(`TODO.md:${e.line} ${e.title} — no item ${n}`);
    }
  }
  assert.deepEqual(gaps, [], 'a numbered row is missing; restore it rather than renumbering');
});

// =============================================================================
// The legend the markers are read against
// =============================================================================

test('only the three documented markers are used', () => {
  // The legend says `[ ]` todo, `[~]` in progress, `[x]` done. A fourth spelling would
  // read as open or closed depending on who was looking, and every check above would
  // skip it in silence.
  const odd = LINES
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*- \[[^\]]\] /.test(l) && !/^\s*- \[[ x~]\] /.test(l))
    .map(({ l, i }) => `TODO.md:${i + 1} ${l.trim().slice(0, 60)}`);
  assert.deepEqual(odd, []);
});
