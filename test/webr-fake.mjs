/**
 * @file webr-fake.mjs
 * A plugin-test `app.webr` built from the HOST's own namespace code.
 *
 * Six test files stubbed `webr` by hand, eight stubs between them. When `runOrThrow`
 * landed five test cases broke, and the obvious fix — paste the three-line helper into
 * each fake — would have left eight copies of a host behaviour to keep in step with the
 * host. A fake that drifts from the thing it stands in for is worse than no fake: it
 * passes while the app fails.
 *
 * So the region between `plugin-host.html`'s `webr:start` / `webr:end` markers is lifted
 * and run over the stub's own `run`. Tests get the real wrapper; a change to what
 * `runOrThrow` does shows up in every plugin test without anyone updating a fake.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** `makeWebr`, lifted from the runtime document and parameterised on its namespace factory. */
function loadMakeWebr() {
  const src = readFileSync('plugin-host.html', 'utf8');
  const block = src.match(/\/\/ webr:start[\s\S]*?\/\/ webr:end/);
  assert.ok(block, 'the webr:start/end seam is gone from plugin-host.html — restore it or every webr fake is blind');
  return new Function(`
    const factory = arguments[0];
    const reviveValue = (v) => v;
    function makeNamespace(ns, methods) { return factory(ns, methods); }
    ${block[0]}
    return makeWebr();`);
}

const makeWebr = loadMakeWebr();

/**
 * An `app.webr` for a plugin test.
 *
 * @param {object} stubs the proxied verbs this test cares about — `{run}` at minimum.
 *   Anything the plugin calls that was not stubbed throws by name rather than returning
 *   `undefined`, so a missing stub reads as a missing stub.
 * @returns {object} the stubs plus the host's own local verbs (`runOrThrow`).
 */
export function fakeWebr(stubs = {}) {
  return makeWebr((ns, methods) => {
    const obj = {};
    for (const name of methods) {
      obj[name] = stubs[name]
        ?? (async () => { throw new Error(`${ns}.${name} is not stubbed in this test`); });
    }
    return Object.freeze(obj);
  });
}
