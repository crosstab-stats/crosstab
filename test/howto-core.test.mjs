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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { CORE_HOWTO } from '../core/howto-core.js';
import { parseSidecar, collectTopics, indexProblems, normalizeTopic } from '../core/howto.js';
import { classifyTarget } from '../core/howto-render.js';

const md = readFileSync('docs/howto-core.md', 'utf8');
const ids = CORE_HOWTO.howtoIndex.map((t) => t.id);

/**
 * Every topic id the SHIPPED app can resolve, mapped to who provides it.
 *
 * Core's references are allowed to leave core — ids are global (`collectTopics` enforces
 * uniqueness *because* `howto:` links address them globally), and the task layer's job is
 * to send a reader to the plugin page that owns a procedure rather than restate it here.
 *
 * Built by importing the real manifests rather than scraping them, so a renamed or
 * deleted plugin topic breaks the link test instead of rotting silently on screen.
 */
const provider = new Map(ids.map((id) => [id, 'core']));
for (const dir of readdirSync('plugins').filter((d) => d.startsWith('builtin-'))) {
  // eslint-disable-next-line no-await-in-loop
  const mod = await import(`../plugins/${dir}/index.js`);
  for (const t of mod.manifest?.howtoIndex ?? []) {
    if (t?.id && !provider.has(t.id)) provider.set(t.id, mod.manifest.id ?? dir);
  }
}

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

test('every seeAlso points at a topic the shipped app can resolve', () => {
  for (const t of CORE_HOWTO.howtoIndex) {
    for (const ref of t.seeAlso ?? []) {
      assert.ok(
        provider.has(ref),
        `${t.id} → ${ref} resolves to nothing core or any builtin declares`,
      );
    }
  }
});

test('a task page routes OUTWARD — that is what makes it a task page', () => {
  // The layer exists to get a reader from a question to the procedure that answers it.
  // If every task reference stayed inside core, the layer would be a second table of
  // contents for the ten pages core already had.
  const tasks = CORE_HOWTO.howtoIndex.filter((t) => t.category === 'How do I…');
  assert.ok(tasks.length >= 8, 'the task layer should cover the common questions');
  const outward = tasks.flatMap((t) => (t.seeAlso ?? []).filter((r) => provider.get(r) !== 'core'));
  assert.ok(outward.length >= tasks.length, 'most task pages should reach a plugin page');
  for (const t of tasks) {
    // No `needs`: a task page has to be readable BEFORE you enable anything, which is the
    // same reason the guide documents plugins that are catalogued but off.
    assert.equal(t.needs, undefined, `${t.id} must not require a plugin to be readable`);
  }
});

test('every howto: link in the prose resolves to a declared topic', () => {
  // A cross-link that points nowhere renders as plain text, so it fails silently on
  // screen — which is exactly why it is worth failing loudly here.
  const links = [...md.matchAll(/\]\((howto:[^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'the core guide should cross-reference itself');
  for (const raw of links) {
    const t = classifyTarget(raw);
    assert.equal(t.kind, 'topic', raw);
    assert.ok(provider.has(t.value), `${raw} names no topic core or any builtin declares`);
  }
});

test('no sidecar uses markdown the renderer does not implement', () => {
  // `renderHowto` knows headings, lists, paragraphs and inline spans. Anything else
  // reaches the page as literal characters, and nothing fails on the way: the sidecar
  // parses, the ids resolve, the links work. Three pipe tables shipped in the task layer
  // before a browser showed them as rows of `| --- |`.
  //
  // Checked across every builtin too — a plugin author reaching for a table has no more
  // reason to know the renderer's vocabulary than I did.
  const sidecars = [['docs/howto-core.md', md]];
  for (const dir of readdirSync('plugins').filter((d) => d.startsWith('builtin-'))) {
    const path = `plugins/${dir}/howto.md`;
    if (existsSync(path)) sidecars.push([path, readFileSync(path, 'utf8')]);
  }
  assert.ok(sidecars.length > 60, 'the builtins should be in this sweep');

  for (const [path, text] of sidecars) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${path}:${i + 1}`;
      assert.doesNotMatch(line, /^\s*\|/, `${at} is a markdown table; the renderer has none`);
      assert.doesNotMatch(line, /^\s*>\s/, `${at} is a blockquote; the renderer has none`);
    });
  }
});

test('no sidecar hard-wraps a link or a list item', () => {
  // Two rules the renderer imposes and never states, both of which I broke in one draft
  // without failing a single test: the sidecar parsed, the ids resolved, the links were
  // well-formed. Only the browser showed it.
  //
  // A paragraph's lines are joined with `<br>` and the inline pass runs PER LINE, so a
  // link split across two lines matches nothing and renders as literal brackets. And a
  // list block requires EVERY line to start with a bullet, so one wrapped item demotes
  // the whole list to a paragraph.
  const sidecars = [['docs/howto-core.md', md]];
  for (const dir of readdirSync('plugins').filter((d) => d.startsWith('builtin-'))) {
    const path = `plugins/${dir}/howto.md`;
    if (existsSync(path)) sidecars.push([path, readFileSync(path, 'utf8')]);
  }

  const BULLET = /^\s*(?:\d+[.)]|[-*])\s+/;
  for (const [path, text] of sidecars) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${path}:${i + 1}`;
      // A code span is a syntax summary, not a link: `keep VAR1, VAR2 [as TYPE]`.
      const bare = line.replace(/`[^`]*`/g, '');
      assert.equal(
        (bare.match(/\[/g) ?? []).length, (bare.match(/\]\(/g) ?? []).length,
        `${at} has a link that does not open and close on one line`,
      );
      // Two different unsupported shapes, and they fail differently on screen, so the
      // message has to say which. A nested list is the nastier one: the indented bullets
      // still match the bullet test, so the block passes AS a list and `ordered` is read
      // from the first line — the sub-items render as top-level steps of the outer list,
      // turning three steps with two options into five steps.
      if (i > 0 && BULLET.test(lines[i - 1]) && /^\s+\S/.test(line)) {
        assert.fail(BULLET.test(line)
          ? `${at} is a NESTED list; the renderer flattens it into the outer list`
          : `${at} continues a list item onto a second line`);
      }
    });
  }
});

test('no prose link uses a scheme the renderer would refuse', () => {
  // Catching an author mistake here beats a link silently becoming plain text.
  for (const [, target] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    assert.notEqual(classifyTarget(target).kind, 'none', `${target} would not render as a link`);
  }
});

test('the task layer sorts above the alphabet, and a PLUGIN can reach the same spot', () => {
  // `How do I…` falls between `Graphs` and `Import` alphabetically, which buried it under
  // a hundred procedure pages. The rank is attached to the CATEGORY, so this also checks
  // the part that keeps it an ordering policy rather than a privilege of being the host:
  // a third party filing under the same name sorts there too.
  const third = { id: 'zz-plugin', name: 'Aardvark', howtoFile: 'h.md', howtoIndex: [
    { id: 'zz-task', title: 'How do I do something a plugin owns?', category: 'How do I…' },
    { id: 'zz-proc', title: 'A procedure', category: 'Aaaaardvark' },
  ] };
  const all = collectTopics([CORE_HOWTO, third]);
  const order = [...new Set(all.map((t) => t.category))];
  assert.deepEqual(order.slice(0, 3), ['How do I…', 'Getting started', 'Working with data']);
  // 'Aaaaardvark' would sort first of all under a pure alphabetical rule.
  assert.ok(order.indexOf('Aaaaardvark') > 2, 'an unpinned category cannot jump the pins');
  assert.ok(all.some((t) => t.id === 'zz-task' && t.category === 'How do I…'));
  assert.ok(order.slice(3).every((c, i, a) => i === 0 || a[i - 1].localeCompare(c) <= 0),
    'everything after the pins is still alphabetical');
});

test('core topics collect and sort with everyone else', () => {
  const third = { id: 'zz-plugin', name: 'Aardvark Analysis', howtoFile: 'h.md', howtoIndex: [
    { id: 'aaa', title: 'A topic that sorts first', category: 'Getting started' },
  ] };
  const all = collectTopics([CORE_HOWTO, third]);
  const started = all.filter((t) => t.category === 'Getting started').map((t) => t.id);
  assert.equal(started[0], 'aaa', 'a third-party topic sorts ahead of core’s on title alone');
});
