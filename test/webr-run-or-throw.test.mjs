/**
 * @file webr-run-or-throw.test.mjs
 * `app.webr.runOrThrow` — the helper eleven plugins each carried a copy of.
 *
 * The helper is three lines, so what is worth testing is not the arithmetic but the two
 * properties that made its PLACEMENT a design decision:
 *
 *  - it goes out over `webr.run`, because the broker rewrites that one dispatch entry per
 *    invocation to inject the run's bound inputs. A host-side `webr.runOrThrow` verb would
 *    have bypassed the injection and run plugins' R without their variables;
 *  - `run`'s options are forwarded, so adopting it cannot silently drop an argument.
 *
 * `plugin-host.html` is an inline-script document and cannot be imported, so the region
 * between its `webr:start` / `webr:end` markers is lifted and run — the same seam
 * technique as sw.js's host rules and the host's own import-map aliases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fakeWebr } from './webr-fake.mjs';

/** The host's webr namespace over a recording `run`. */
function loadWebr() {
  const calls = [];
  return {
    calls,
    make: (reply) => fakeWebr({
      run: (...args) => { calls.push({ method: 'webr.run', args }); return Promise.resolve(reply()); },
    }),
  };
}

test('runOrThrow travels over webr.run, so the broker injects the run inputs', async () => {
  const { calls, make } = loadWebr();
  const webr = make(() => ({ result: { names: ['ok'], values: [1] } }));
  await webr.runOrThrow('summary(x)');
  assert.deepEqual(calls.map((c) => c.method), ['webr.run'],
    'runOrThrow must not call a host verb of its own — webr.run is the injected entry');
});

test('options are forwarded, not dropped', async () => {
  const { calls, make } = loadWebr();
  const webr = make(() => ({ result: 1 }));
  await webr.runOrThrow('1', { capturePlot: true });
  assert.deepEqual(calls[0].args, ['1', { capturePlot: true }]);
});

test('the result is unwrapped, and a missing one throws', async () => {
  const { make } = loadWebr();
  const payload = { names: ['mean'], values: [3] };
  assert.equal(await make(() => ({ result: payload })).runOrThrow('1'), payload);

  for (const empty of [{ result: null }, { result: undefined }, {}]) {
    await assert.rejects(() => make(() => empty).runOrThrow('1'), /R returned no result/);
  }
});

test('the namespace still carries every proxied verb', () => {
  // The wrapper spreads the proxy; a typo there would silently remove `installPackages`
  // from every plugin at once.
  const webr = loadWebr().make(() => ({ result: 1 }));
  for (const m of ['run', 'installPackages', 'writeFile', 'readFile', 'mountFile', 'unmount', 'runOrThrow']) {
    assert.equal(typeof webr[m], 'function', m);
  }
});

test('no plugin still defines its own runR', () => {
  // The point of the exercise. A new plugin copying the old helper from a sibling is the
  // likely regression, and it would never show up as a failure anywhere else.
  const offenders = readdirSync('plugins', { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`plugins/${d.name}/index.js`))
    .filter((d) => /\basync function runR\b/.test(readFileSync(`plugins/${d.name}/index.js`, 'utf8')))
    .map((d) => d.name);
  assert.deepEqual(offenders, [], `use app.webr.runOrThrow instead: ${offenders.join(', ')}`);
});
