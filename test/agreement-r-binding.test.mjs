/**
 * @file agreement-r-binding.test.mjs
 * `builtin-agreement.fromCodings` bound `vars` in one R call and read it in the next (#200).
 *
 * Found by browser-testing #196, which is the only reason it was found at all: the run
 * reached the R step, and R said `Error in eval(expr, env): object 'vars' not found`.
 *
 * **Confirmed pre-existing**, by running the identical scenario against the plugin as it
 * was before #196 — it failed the same way. So this had never worked. It takes TWO coders
 * in one project to reach, which nobody had, and the unit suite could not see it because
 * the defect lives in the boundary between two `app.webr.run` calls rather than in either
 * side's logic.
 *
 * ## Why it could never have worked
 *
 * `core/webr-manager.js` evaluates every run as
 * `shelter.captureR(prelude + code, { env })`, with `env` built FRESH for each call. An
 * `<-` assignment therefore does not outlive the call that made it. The variables path
 * never hit this because the host injects its data as a prelude *inside the same
 * evaluation*; only the codings path tried to carry state across a boundary that does not
 * carry any.
 *
 * `compute` even advertised the contract and dropped it: it took `{ bound = false }` and
 * immediately did `void bound`. A flag that is documented, passed, and discarded reads as
 * a decision honoured somewhere else — which is the most expensive kind of dead code.
 *
 * The fix moves the binding into the same call as the computation, so there is no
 * cross-call state to lose. These tests pin the SHAPE of that, because the arithmetic is
 * `irr`'s job and the only thing that broke here was plumbing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('plugins/builtin-agreement/index.js', 'utf8');
const WEBR = readFileSync('core/webr-manager.js', 'utf8');

/**
 * The source with comments stripped.
 *
 * Needed because the fix's own doc comment NAMES the old shape — "`compute` even took a
 * `{ bound: true }` flag that it discarded with `void bound`" — so an absence check
 * against the raw file fails on the explanation of why the thing is absent. A guard that a
 * correct comment can break is a guard that gets deleted, so the checks below read code.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the matrix binding is SOURCE, not a separate run', () => {
  const at = SRC.indexOf('function matrixSource(');
  assert.ok(at > 0, 'matrixSource exists');
  const body = SRC.slice(at, SRC.indexOf('\n}', at));
  assert.match(body, /return `vars <- as\.data\.frame/, 'it returns the R source');
  assert.ok(!body.includes('webr.run'), 'and runs nothing itself — that was the bug');
});

test('the old two-call shape is gone, flag and all', () => {
  assert.ok(!CODE.includes('bindMatrix'), 'no bindMatrix');
  assert.ok(!/await app\.webr\.run\(\s*`vars <-/.test(CODE), 'no standalone vars assignment');
  // The discarded flag mattered: it described a contract nothing implemented.
  assert.ok(!CODE.includes('void bound'), 'no discarded bound flag');
  assert.ok(!CODE.includes('bound: true'), 'and no caller passing one');
});

test('compute prepends its prelude so the binding is in the SAME evaluation', () => {
  const at = SRC.indexOf('async function compute(');
  const body = SRC.slice(at, SRC.indexOf('\n}', at));
  assert.match(body, /\{ prelude = '' \} = \{\}/, 'it takes a prelude');
  assert.match(body, /app\.webr\.run\(prelude \+ rCode\)/, 'and puts it in the one call');
});

test('both callers still reach compute the way their data arrives', () => {
  // The variables path passes nothing: its `vars` is injected by the host as a prelude
  // into the same evaluation, which is exactly why it never hit this bug.
  assert.match(SRC, /const stats = await compute\(app, metric, weight\);/, 'variables path');
  // The codings path passes the matrix it just built.
  assert.match(SRC, /prelude: matrixSource\(rows, coders\.length\)/, 'codings path');
});

test('the reason is pinned in webr-manager, not just asserted here', () => {
  // If this ever stops being true — if a run starts sharing an environment — the fix above
  // is still correct but its justification changes, and whoever reads it should find out
  // from a failing test rather than from a comment.
  assert.match(WEBR, /captureR\(prelude \+ code, \{\s*env,/, 'every run is given an env');
  const at = WEBR.indexOf('const env = {};');
  assert.ok(at > 0, 'and that env is built per call, so assignments do not persist');
});

test('the matrix is column-major, which is what matrix(nrow, ncol) expects', () => {
  // The one piece of real logic in the moved function. R fills a matrix down the columns,
  // so the flattening has to walk raters outermost — getting this backwards would
  // transpose the ratings and quietly compute agreement between the wrong things.
  const at = SRC.indexOf('function matrixSource(');
  const body = SRC.slice(at, SRC.indexOf('\n}', at));
  assert.match(body, /for \(let c = 0; c < nRaters; c\+\+\) for \(const r of rows\)/,
    'raters outermost, rows inner');
  assert.match(body, /nrow = \$\{rows\.length\}, ncol = \$\{nRaters\}/);
});
