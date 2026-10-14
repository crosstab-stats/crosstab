/**
 * @file plugin-howto-pages.test.mjs
 * Every plugin's authored how-to obeys the contract it declares (#192).
 *
 * This is the test that makes authoring 60-odd pages safe to do in batches: it walks the
 * repo, pairs each manifest's `howtoIndex` with its sidecar, and runs the same
 * `parseSidecar` the app does. A delimiter that does not match a declared id, or a
 * declared topic with no section, fails here rather than showing a reader an empty page.
 *
 * It also enforces the rules that keep the index usable at scale — unique ids across ALL
 * plugins (because `howto:` links address them globally), real keywords (search covers
 * nothing else), and cross-links that resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parseSidecar } from '../core/howto.js';
import { classifyTarget } from '../core/howto-render.js';
import { CORE_HOWTO } from '../core/howto-core.js';

/** Pull a plugin's declared index out of its manifest without executing it. */
function declaredIndex(src) {
  const at = src.indexOf('howtoIndex: [');
  if (at === -1) return null;
  let depth = 0;
  let end = at;
  for (let i = src.indexOf('[', at); i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = src.slice(at, end);
  return {
    ids: [...block.matchAll(/id: '([^']+)'/g)].map((m) => m[1]),
    titles: [...block.matchAll(/title: '((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]),
    keywords: [...block.matchAll(/keywords: \[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((k) => k[1])),
    seeAlso: [...block.matchAll(/seeAlso: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].map((k) => k[1])),
    file: (src.match(/howtoFile: '([^']+)'/) ?? [])[1] ?? null,
  };
}

const documented = readdirSync('plugins', { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`plugins/${d.name}/index.js`))
  .map((d) => ({ dir: d.name, src: readFileSync(`plugins/${d.name}/index.js`, 'utf8') }))
  .map((p) => ({ ...p, index: declaredIndex(p.src) }))
  .filter((p) => p.index);

test('at least one plugin ships an authored how-to', () => {
  assert.ok(documented.length > 0, 'nothing to check — did the batches land?');
});

test('every declared topic has a section, and every section is declared', () => {
  for (const { dir, index } of documented) {
    assert.ok(index.file, `${dir}: declares topics but no howtoFile`);
    const path = `plugins/${dir}/${index.file}`;
    assert.ok(existsSync(path), `${dir}: ${index.file} is missing`);
    const { bodies, problems } = parseSidecar(readFileSync(path, 'utf8'), index.ids);
    assert.deepEqual(problems, [], `${dir}: ${problems.join('; ')}`);
    assert.equal(bodies.size, index.ids.length, `${dir}: section count`);
    for (const [id, body] of bodies) {
      assert.ok(body.trim().length > 80, `${dir}/${id}: too thin to be a how-to`);
    }
  }
});

test('topic ids are unique across EVERY plugin and core', () => {
  // `howto:` links address ids globally, so a collision silently shadows one plugin's
  // page with another's — `collectTopics` drops the duplicate rather than merging it.
  const seen = new Map();
  for (const id of CORE_HOWTO.howtoIndex.map((t) => t.id)) seen.set(id, 'core');
  for (const { dir, index } of documented) {
    for (const id of index.ids) {
      assert.ok(!seen.has(id), `${dir}: "${id}" is already used by ${seen.get(id)}`);
      seen.set(id, dir);
    }
  }
});

test('every topic carries real search terms', () => {
  // Search covers titles, categories, keywords and the plugin name — never bodies. A
  // topic with thin keywords is findable only by the words that happen to be in its title.
  for (const { dir, index } of documented) {
    index.ids.forEach((id, i) => {
      const kw = index.keywords[i] ?? [];
      assert.ok(kw.length >= 4, `${dir}/${id}: ${kw.length} keywords is not enough to be found by`);
    });
  }
});

test('every cross-link in a body points at a topic that exists', () => {
  // A `howto:` link to nothing renders as plain text — it fails silently on screen, which
  // is exactly why it is worth failing loudly here.
  const known = new Set(CORE_HOWTO.howtoIndex.map((t) => t.id));
  for (const { index } of documented) for (const id of index.ids) known.add(id);
  for (const { dir, index } of documented) {
    const md = readFileSync(`plugins/${dir}/${index.file}`, 'utf8');
    for (const [, target] of md.matchAll(/\]\((howto:[^)\s]+)\)/g)) {
      const t = classifyTarget(target);
      assert.equal(t.kind, 'topic', `${dir}: ${target}`);
      assert.ok(known.has(t.value), `${dir}: ${target} names no topic`);
    }
  }
});

test('no body uses a link scheme the renderer would refuse', () => {
  for (const { dir, index } of documented) {
    const md = readFileSync(`plugins/${dir}/${index.file}`, 'utf8');
    for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
      assert.notEqual(classifyTarget(target).kind, 'none',
        `${dir}: ${target} would render as plain text, not a link`);
    }
  }
});

test('every seeAlso resolves', () => {
  const known = new Set(CORE_HOWTO.howtoIndex.map((t) => t.id));
  for (const { index } of documented) for (const id of index.ids) known.add(id);
  for (const { dir, index } of documented) {
    for (const ref of index.seeAlso) {
      assert.ok(known.has(ref), `${dir}: seeAlso "${ref}" names no topic`);
    }
  }
});

test('a menu item that names a topic names a REAL one', () => {
  // `howto: 'x'` on a menu item is what its dialog's ⓘ opens. A typo there is a dialog
  // whose help button lands on "that topic is not in the index".
  const known = new Set(CORE_HOWTO.howtoIndex.map((t) => t.id));
  for (const { index } of documented) for (const id of index.ids) known.add(id);
  for (const { dir, src } of documented) {
    const menuAt = src.indexOf('  menu: [');
    if (menuAt === -1) continue;
    for (const [, id] of src.slice(menuAt).matchAll(/howto: '([^']+)'/g)) {
      assert.ok(known.has(id), `${dir}: menu item points at "${id}", which is not a topic`);
    }
  }
});
