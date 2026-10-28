/**
 * @file el-children.test.mjs
 * `el()` takes children in its OPTIONS object. Passed positionally they vanish silently.
 *
 * ## Why this test exists
 *
 * The transcription progress dialog shipped without its Stop button. The button was
 * created, given a click handler that cancelled the job, and then handed to:
 *
 *     el('div', { class: 'ct-dialog__actions' }, [stop])
 *
 * `el(tag, opts)` has two parameters. The third argument was ignored, the div was appended
 * empty, and a user watching a twenty-minute transcription had no way to stop it. Nothing
 * threw, nothing logged, and the code reads exactly like the hyperscript convention it
 * resembles — which is what made it survive review.
 *
 * `el`'s own documentation anticipated this: "the failure mode is silent and there are 509
 * of them". A silent failure mode that has already caught us once deserves a guard rather
 * than vigilance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Every source file that could call `el`. */
function sources() {
  const out = [];
  for (const dir of ['core', 'plugins']) {
    for (const f of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!f.isFile()) continue;
      if (!/\.(js|mjs)$/.test(f.name)) continue;
      out.push(path.join(f.parentPath ?? f.path ?? dir, f.name));
    }
  }
  return out;
}

test('no call passes children to el() positionally', () => {
  // `el('div', {...}, [kid])` — a third argument the function does not have.
  const positional = /\bel\(\s*['"`][a-zA-Z0-9]+['"`]\s*,\s*\{[^{}]*\}\s*,/;
  const offenders = [];
  for (const file of sources()) {
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (positional.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'children belong in the options object — passed positionally they are dropped and '
    + 'nothing complains:\n' + offenders.join('\n'));
});

test('the transcription dialog really does append its Stop button', () => {
  // The specific regression: a progress dialog for a job that can run for twenty minutes
  // must offer a way out, and must do it by a route that actually reaches the DOM.
  const app = readFileSync('core/app.js', 'utf8');
  const dialog = app.slice(app.indexOf('ct-transcribe'), app.indexOf('ct-transcribe') + 3000);
  assert.match(dialog, /children:\s*\[stop\]/,
    'the Stop button is appended through `children`, not a phantom third argument');
  assert.match(dialog, /onCancel\?\.\(\)/, 'and it still cancels the job');
});
