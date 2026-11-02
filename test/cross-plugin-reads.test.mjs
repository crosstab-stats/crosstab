/**
 * @file cross-plugin-reads.test.mjs
 * Who may read a collection its own plugin did not write — the `read: 'public'` opt-in.
 *
 * ## The question this settles
 *
 * Owner tokens already decided who may read: a plugin reaches records whose owner token
 * equals its own, and nothing else (core/app.js resolves the token from the CALLER, so a
 * plugin cannot even name another owner). That made cross-developer reading impossible
 * rather than undecided — and made "analyse someone else's codings" a BUILT-IN privilege
 * by accident, since every built-in shares the `builtin` token. `builtin-agreement` could
 * read CAQDAS codings for no better reason than being shipped by us.
 *
 * The owner's decision (2026-11-01), of three options put to them:
 *
 *   - default stays **private to the owner domain**, which is what the code already did;
 *   - **`read: 'public'`** is a dev-declared offer to every ACTIVATED plugin, with no
 *     reading-side declaration and no per-reader consent prompt;
 *   - CAQDAS codings are marked public, participant quotes included.
 *
 * The cost was put to them explicitly and accepted: a coding carries a passage of
 * participant speech, and activation discloses nothing about data access. Recorded in
 * docs/SECURITY.md under "Cross-plugin reads" rather than hidden behind a flag name.
 *
 * ## What is asserted here
 *
 * Reads only. There is no `writeTo`, by design — a public collection has exactly one
 * author and any number of readers, which is what keeps `reads[]` causal edges and
 * `onConcurrentEdit` meaningful. The last two tests pin that absence, because an
 * asymmetry nobody tests is an asymmetry somebody will "fix".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeCollection, declaredCollections, canPluginRead, publicCollections,
  findCollection, CORE_COLLECTIONS,
} from '../core/collections.js';

const { manifest } = await import('../plugins/builtin-caqdas/index.js');

/** The declarations the host actually computes, from the REAL CAQDAS manifest. */
const caqdas = declaredCollections([{ ...manifest, collections: manifest.collections }], () => 'builtin');
const decls = [...CORE_COLLECTIONS, ...caqdas];

// ---------------------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------------------

test('a collection that says nothing is private to its owner', () => {
  assert.equal(normalizeCollection({ id: 'x' }).read, 'owner');
  // Same rule as `portable` and `scope`: a malformed value is the restrictive default,
  // never a guess. Guessing here would publish somebody's records.
  for (const bad of ['Public', 'PUBLIC', 'all', '', 1, true, null, {}, []]) {
    assert.equal(normalizeCollection({ id: 'x', read: bad }).read, 'owner', String(bad));
  }
});

test('every core collection is owner-only', () => {
  // Memos annotate codings and analyses and are the fastest-growing collection in a
  // qualitative project. Nothing has asked to read them, so nothing may.
  for (const d of CORE_COLLECTIONS) assert.equal(d.read, 'owner', d.id);
});

test('an owner-only collection is unreadable, and that is the NEGATIVE CONTROL', () => {
  // builtin-spatial's map layers are declared by a different built-in and say nothing
  // about reading, so they stay shut even though the asking plugin shares the `builtin`
  // token. Without this case the suite would pass on a policy that returned true always.
  const spatialish = declaredCollections(
    [{ id: 'builtin-spatial', collections: [{ id: 'boundarySets', label: 'Map layers' }] }],
    () => 'builtin',
  );
  assert.equal(canPluginRead([...decls, ...spatialish], 'builtin', 'boundarySets'), false);
});

// ---------------------------------------------------------------------------------------
// The opt-in
// ---------------------------------------------------------------------------------------

test('CAQDAS codings, codes and codebooks are readable; nothing else of theirs is', () => {
  assert.equal(canPluginRead(decls, 'builtin', 'segments'), true, 'codings');
  assert.equal(canPluginRead(decls, 'builtin', 'codes'), true, 'the code names');
  assert.equal(canPluginRead(decls, 'builtin', 'codebooks'), true, 'the scheme');
  // The three that are public are the three a consumer needs to say what a coding MEANS.
  // Anything CAQDAS adds later must opt in deliberately rather than inherit it.
  const published = publicCollections(caqdas).map((c) => c.collection).sort();
  assert.deepEqual(published, ['codebooks', 'codes', 'segments']);
});

test('the offer does not depend on who is asking', () => {
  // The owner chose "offer alone" over a per-reader grant, so there is deliberately no
  // caller argument to pass. A third party and a built-in get the same answer.
  assert.equal(canPluginRead.length, 3, 'decls, owner, collection — no reader');
});

test('an undeclared collection answers exactly like a private one', () => {
  // So a plugin cannot probe for what the user has installed by comparing the two.
  assert.equal(canPluginRead(decls, 'builtin', 'no-such-collection'), false);
  assert.equal(canPluginRead(decls, 'ns:nobody.example', 'segments'), false);
  assert.equal(canPluginRead(decls, '', 'segments'), false);
  assert.equal(canPluginRead(decls, 'builtin', ''), false);
  assert.equal(canPluginRead([], 'builtin', 'segments'), false);
});

test('the owner is a separate argument, never parsed out of one string', () => {
  // An owner token can itself contain a colon — `ns:acme.example`, `plugin:acme-labs:evil`
  // — so a single-string address would need a parsing rule, and a parsing rule in front
  // of a permission check is somewhere for a mismatch to hide.
  const odd = declaredCollections(
    [{ id: 'x', collections: [{ id: 'notes', read: 'public' }] }],
    () => 'plugin:acme-labs:evil',
  );
  assert.equal(canPluginRead(odd, 'plugin:acme-labs:evil', 'notes'), true);
  assert.ok(findCollection(odd, 'plugin:acme-labs:evil', 'notes'));
  // The colon is not a separator anywhere in this path.
  assert.equal(canPluginRead(odd, 'plugin', 'acme-labs:evil'), false);
});

// ---------------------------------------------------------------------------------------
// Discovery — without it, "public" only works for someone who hard-codes `builtin`
// ---------------------------------------------------------------------------------------

test('a consumer can find readable collections without hard-coding an owner', () => {
  const found = publicCollections(decls).find((c) => c.collection === 'segments');
  assert.ok(found, 'codings are discoverable');
  assert.equal(found.owner, 'builtin');
  assert.equal(found.label, 'Codings', 'the label a UI would show');
  // Scope comes along because a reader cannot resolve the TARGET's declaration itself.
  assert.ok('scope' in found);
});

// ---------------------------------------------------------------------------------------
// One home for the policy, and no write path
// ---------------------------------------------------------------------------------------

test('both plugin surfaces delegate to the host check rather than carrying a copy', () => {
  // A workspace mount holds the ItemStore and could read it directly; the compute frame
  // has its own binder. Two copies of a permission check is two chances to disagree about
  // who may read a participant's words.
  const mount = readFileSync('core/workspace-manager.js', 'utf8');
  const frame = readFileSync('core/loader.js', 'utf8');
  for (const [name, src] of [['mount', mount], ['compute frame', frame]]) {
    assert.ok(src.includes('itemsReadFrom'), name + ' delegates');
    assert.ok(!src.includes("read === 'public'"), name + ' does not re-decide the policy');
  }
  // And the host asks the pure function rather than writing the condition out again.
  const app = readFileSync('core/app.js', 'utf8');
  assert.ok(app.includes('canPluginRead('), 'the host calls the policy');
  assert.ok(!app.includes("decl.read !== 'public'"), 'and does not inline it');
});

test('there is no cross-plugin WRITE, on any surface', () => {
  // The asymmetry is the design: one author, many readers. Asserted because it is the
  // obvious-looking symmetry for someone to add later.
  //
  // Matching DEFINITIONS, not any occurrence of the word: the first version of this test
  // searched for the bare string and failed on the comment in core/app.js that explains
  // why the write path is absent. A guard that a correct explanation can break is a guard
  // that gets deleted.
  const forbidden = [
    /itemsWriteTo\s*[=:]/,          // a host service
    /\bwriteTo\s*[=:]\s*(\(|async)/, // a method on an items surface
    /\bputTo\s*[=:]\s*(\(|async)/,
    /itemsRemoveFrom\s*[=:]/,
    /'items\.(writeTo|putTo|removeFrom)'/, // a broker dispatch key
  ];
  for (const f of ['core/app.js', 'core/loader.js', 'core/workspace-manager.js',
    'core/plugin-broker.js', 'plugin-host.html']) {
    const src = readFileSync(f, 'utf8');
    for (const re of forbidden) assert.ok(!re.test(src), f + ' must not define ' + re);
  }
  // The in-frame namespace list is the authoritative surface, so pin it exactly.
  const shim = readFileSync('plugin-host.html', 'utf8');
  const line = shim.split('\n').find((l) => l.includes("makeNamespace('items'"));
  assert.ok(line, 'the items namespace is declared');
  assert.deepEqual(
    line.match(/'[a-zA-Z]+'/g).slice(1).map((s) => s.replace(/'/g, '')),
    ['put', 'remove', 'list', 'listFrom', 'publicCollections'],
    'exactly these five, and every write among them is owner-scoped',
  );
});

test('the sandbox shim and the broker agree on the item methods', () => {
  // Three places have to know a method exists: the service, the broker dispatch table and
  // the in-frame namespace list. A method missing from the last one is not a thrown error
  // in the plugin, it is `undefined is not a function` at the call site.
  const shim = readFileSync('plugin-host.html', 'utf8');
  const broker = readFileSync('core/plugin-broker.js', 'utf8');
  for (const m of ['put', 'remove', 'list', 'listFrom', 'publicCollections']) {
    assert.ok(new RegExp("'" + m + "'").test(shim), 'shim exposes ' + m);
    assert.ok(broker.includes("items." + m + "'"), 'broker dispatches items.' + m);
  }
});
