/**
 * @file howto-core.test.mjs
 * The host's own how-to declaration obeys the contract it imposes (#192 H4).
 *
 * "Core is just another client" has to be checkable or it is decoration. Core declares
 * `howtoIndex` and `howtoFile` exactly as a plugin does, and its sidecar is validated by
 * the same `parseSidecar` — so if the host's docs drift out of step with its index, this
 * fails the same way a plugin author's would.
 *
 * The one place core IS special is that this row is written in a module rather than read
 * from a manifest, because the host has no manifest file. These tests exist partly to
 * stop that exception quietly growing into others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE_HOWTO } from '../core/howto-core.js';
import { parseSidecar, collectTopics, indexProblems, normalizeTopic } from '../core/howto.js';
import { classifyTarget } from '../core/howto-render.js';

const md = readFileSync('docs/howto-core.md', 'utf8');
const ids = CORE_HOWTO.howtoIndex.map((t) => t.id);

test('core’s sidecar has a section for every topic it declares, and no extras', () => {
  const { bodies, problems } = parseSidecar(md, ids);
  assert.deepEqual(problems, [], 'an unreachable section or a dead index row');
  assert.equal(bodies.size, ids.length);
});

test('core’s row is shaped exactly like a plugin’s catalogue row', () => {
  // If this ever needs a field a plugin row does not have, that is a bug in the
  // mechanism rather than a privilege of being the host.
  assert.equal(typeof CORE_HOWTO.id, 'string');
  assert.equal(typeof CORE_HOWTO.name, 'string');
  assert.equal(typeof CORE_HOWTO.howtoFile, 'string');
  assert.ok(Array.isArray(CORE_HOWTO.howtoIndex));
  assert.deepEqual(indexProblems([CORE_HOWTO]), []);
});

test('every core topic survives normalisation', () => {
  for (const raw of CORE_HOWTO.howtoIndex) {
    assert.ok(normalizeTopic(raw, { pluginId: CORE_HOWTO.id }), `${raw.id} is malformed`);
  }
});

test('core topics carry keywords — search covers nothing else', () => {
  // Bodies are not searched (that would mean fetching every sidecar), so a topic with no
  // keywords is findable only by the words in its title.
  for (const t of CORE_HOWTO.howtoIndex) {
    assert.ok((t.keywords ?? []).length >= 3, `${t.id} needs more search terms`);
  }
});

test('every seeAlso points at a topic that exists', () => {
  const known = new Set(ids);
  for (const t of CORE_HOWTO.howtoIndex) {
    for (const ref of t.seeAlso ?? []) {
      assert.ok(known.has(ref), `${t.id} → ${ref} is a dead cross-reference`);
    }
  }
});

test('every howto: link in the prose resolves to a declared topic', () => {
  // A cross-link that points nowhere renders as plain text, so it fails silently on
  // screen — which is exactly why it is worth failing loudly here.
  const known = new Set(ids);
  const links = [...md.matchAll(/\]\((howto:[^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'the core guide should cross-reference itself');
  for (const raw of links) {
    const t = classifyTarget(raw);
    assert.equal(t.kind, 'topic', raw);
    assert.ok(known.has(t.value), `${raw} names no core topic`);
  }
});

test('no prose link uses a scheme the renderer would refuse', () => {
  // Catching an author mistake here beats a link silently becoming plain text.
  for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    assert.notEqual(classifyTarget(target).kind, 'none', `${target} would not render as a link`);
  }
});

test('core topics collect and sort with everyone else', () => {
  const third = { id: 'zz-plugin', name: 'Aardvark Analysis', howtoFile: 'h.md', howtoIndex: [
    { id: 'aaa', title: 'A topic that sorts first', category: 'Getting started' },
  ] };
  const all = collectTopics([CORE_HOWTO, third]);
  const started = all.filter((t) => t.category === 'Getting started').map((t) => t.id);
  assert.equal(started[0], 'aaa', 'a third-party topic sorts ahead of core’s on title alone');
});
