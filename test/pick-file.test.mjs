/**
 * @file pick-file.test.mjs
 * One file picker, and the cancel path that four of the five used to get wrong.
 *
 * Core had five of these — `pickFile` in plugin-actions, `verbPickFile` in
 * workspace-manager (byte-identical), `pickFiles` in import-service, another `pickFile`
 * in plugin-manager, and `UiService#pickFile` — under two names and three argument
 * conventions.
 *
 * The duplication was tidying; the BUG was that they had diverged on the thing that
 * matters. A file input reports a chosen file through `change` and a dismissed dialog
 * through `cancel`, and `cancel` only arrived in Safari 16.4. Four of the five listened
 * for `cancel` alone, with comments calling a missing one "harmless" — true of the happy
 * path, false of the other. On an older iPad, cancelling an import, a plugin install or
 * a workspace verb's file prompt left the promise unsettled and the flow stopped dead.
 * `UiService#pickFile` already carried a focus fallback; folding them together is how
 * that reaches the rest.
 *
 * These drive a fake DOM, so the hang is reproduced rather than asserted from source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { pickFile, pickFiles } from '../core/pick-file.js';

/** The slice of DOM a file input needs, with the listeners exposed so a test can fire
 * exactly the events a given browser would. */
function fakeDom() {
  const el = {
    listeners: {}, files: null, style: {}, removed: false,
    addEventListener(t, fn) { (el.listeners[t] ??= []).push(fn); },
    remove() { el.removed = true; },
    click() { el.clicked = true; },
  };
  const win = {
    listeners: {},
    addEventListener(t, fn) { (win.listeners[t] ??= []).push(fn); },
  };
  const doc = { createElement: () => el, body: { append() {} } };
  const fire = (target, t) => (target.listeners[t] ?? []).forEach((fn) => fn());
  return { el, win, doc, fire };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a chosen file resolves', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ accept: '.csv', doc, win });
  el.files = ['FILE'];
  fire(el, 'change');
  assert.equal(await p, 'FILE');
  assert.equal(el.removed, true, 'the input must not be left in the document');
});

test('a `cancel` event resolves null', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ doc, win });
  fire(el, 'cancel');
  assert.equal(await p, null);
});

test('WITHOUT a cancel event, a refocus still settles it', async () => {
  // The bug. On Safari before 16.4 there is no `cancel`, so this is the only thing that
  // ends the wait — and four of the five pickers did not have it.
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ doc, win });
  assert.ok((win.listeners.focus ?? []).length === 1, 'the fallback must be armed');
  fire(win, 'focus');
  const settled = await Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), 900))]);
  assert.equal(settled, null, 'cancelling must not hang the flow');
});

test('the refocus fallback returns the file when `change` was merely slow', async () => {
  // It reads the input rather than assuming a dismissal: a refocus happens after a
  // SUCCESSFUL pick too, and answering null there would discard the user's choice.
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ doc, win });
  el.files = ['PICKED'];
  fire(win, 'focus');
  assert.equal(await p, 'PICKED');
});

test('nothing resolves twice', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ doc, win });
  el.files = ['FIRST'];
  fire(el, 'change');
  fire(el, 'cancel');
  fire(win, 'focus');
  await settle();
  assert.equal(await p, 'FIRST');
});

// =============================================================================
// The two shapes
// =============================================================================

test('pickFiles returns an ARRAY even when multiple is false', async () => {
  // The trap, and it is not hypothetical — the first version of this module let
  // `multiple: false` change the return shape. Both of import-service's call sites test
  // `files.length`, so `pickFiles(['.enc'], false)` returning a File meant encrypted
  // import silently did nothing on every run.
  const { el, win, doc, fire } = fakeDom();
  const p = pickFiles(['.enc'], false, { doc, win });
  el.files = ['ONE'];
  fire(el, 'change');
  const out = await p;
  assert.ok(Array.isArray(out), 'pickFiles must always resolve an array');
  assert.deepEqual(out, ['ONE']);
});

test('a cancelled pickFiles is an empty array, not null', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFiles(['.csv'], true, { doc, win });
  fire(el, 'cancel');
  assert.deepEqual(await p, []);
});

test('`multiple` sets the dialog attribute, not the return shape', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFiles(['.csv'], true, { doc, win });
  assert.equal(el.multiple, true);
  fire(el, 'cancel');
  await p;

  const b = fakeDom();
  const q = pickFile({ accept: '.csv', doc: b.doc, win: b.win });
  assert.notEqual(b.el.multiple, true, 'a single pick must not set multiple');
  b.fire(b.el, 'cancel');
  await q;
});

test('extensions are joined into one accept string', async () => {
  const { el, win, doc, fire } = fakeDom();
  const p = pickFile({ accept: ['.geojson', '.json'], doc, win });
  assert.equal(el.accept, '.geojson,.json');
  fire(el, 'cancel');
  await p;
});

// =============================================================================
// There is only one of them now
// =============================================================================

test('no core module wraps its own file input in a promise', () => {
  // What stops the six coming back. The hazard is specifically the PROMISE-wrapped
  // picker: something awaits it, so a dismissal with no `cancel` event hangs the caller.
  //
  // A plain callback-style input is a different pattern and stays allowed — the History
  // panel's script import, the R-script runner and the plugin picker each keep one, and
  // when the user dismisses those dialogs the right outcome is simply that nothing
  // happens. Nobody is waiting.
  const offenders = [];
  for (const f of readdirSync('core').filter((n) => n.endsWith('.js') && n !== 'pick-file.js')) {
    const src = readFileSync(`core/${f}`, 'utf8');
    for (const m of src.matchAll(/type\s*=\s*['"]file['"]/g)) {
      const before = src.slice(Math.max(0, m.index - 600), m.index);
      if (/new Promise\s*\(/.test(before)) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `promise-wrapped pickers: ${offenders.join(', ')}`);
});
