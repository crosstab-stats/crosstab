/**
 * @file menu-command.test.mjs
 * A menu command that fails must SAY so (owner, 2026-10-02).
 *
 * From a bug report that is the whole argument for this file: *"I opened a project, selected
 * a dataset, attempted File|Copy Dataset and nothing happened."* The command called a method
 * that had been renamed, so it threw a TypeError — which the shell caught and wrote to the
 * console. On screen: nothing. A broken item and an item that genuinely does nothing were
 * then indistinguishable, and the only person who could tell was someone with devtools open.
 *
 * Tested through `runCommand` rather than a click, because the DECISION is what happens to a
 * failure, and that needs no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../core/menu-shell.js';

/** Swallow the console noise the runner deliberately emits. */
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = real;
  }
}

test('a command that throws is reported, not swallowed', () => {
  // The exact shape of the reported bug: the command names a method that no longer exists.
  const broken = { id: 'core:proj-copy-ds', label: 'Copy dataset…', command: () => undefined.nope() };
  const seen = [];
  quietly(() => runCommand(broken, (item, err) => seen.push([item.label, err instanceof Error])));
  assert.equal(seen.length, 1, 'the user has to be told');
  assert.deepEqual(seen[0], ['Copy dataset…', true]);
});

test('an async command that REJECTS is reported too', async () => {
  // try/catch does not see a rejected promise, and most commands here are async — so the
  // common case would have stayed silent if only the synchronous throw were handled.
  const failing = { id: 'x', label: 'Export…', command: async () => { throw new Error('disk full'); } };
  const seen = [];
  await quietly(() => runCommand(failing, (item, err) => seen.push(err.message)));
  assert.deepEqual(seen, ['disk full']);
});

test('a command that works reports nothing', async () => {
  const seen = [];
  let ran = 0;
  runCommand({ id: 'a', label: 'Fine', command: () => { ran += 1; } }, () => seen.push('x'));
  await runCommand({ id: 'b', label: 'Also fine', command: async () => { ran += 1; } }, () => seen.push('x'));
  assert.equal(ran, 2);
  assert.deepEqual(seen, []);
});

test('a command that discards its promise cannot be reported — and that is why they must return it', () => {
  // `() => void doThing()` hands back undefined, so there is nothing to attach a catch to.
  // Pinned as a known limit rather than left as a surprise: the MenuItem contract now says
  // to return the promise, and this test is what that sentence is about.
  const seen = [];
  // The rejection is pre-handled so this test does not itself leak one; what is under test
  // is the RETURN value — undefined gives the runner nothing to attach a catch to.
  const discarding = {
    id: 'c',
    label: 'Discards',
    command: () => { Promise.reject(new Error('lost')).catch(() => {}); },
  };
  const out = runCommand(discarding, () => seen.push('reported'));
  assert.equal(out, undefined);
  assert.deepEqual(seen, [], 'nothing to observe — the command threw its own promise away');
});

test('a reporter that itself throws does not become the failure', () => {
  // Reporting a problem must never be a second problem on top of it.
  const broken = { id: 'd', label: 'Bad', command: () => { throw new Error('first'); } };
  assert.doesNotThrow(() => quietly(() => runCommand(broken, () => { throw new Error('second'); })));
});

test('no reporter at all still does not throw', () => {
  // The shell is constructible without one (plugins, tests, headless), and a failure then
  // falls back to the console plus the bug-report slot.
  assert.doesNotThrow(() => quietly(() => runCommand({ id: 'e', label: 'Bad', command: () => { throw new Error('x'); } })));
});
