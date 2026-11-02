/**
 * @file plugin-data-domain.test.mjs
 * Which pairs of plugins share a data domain — the question `ownerToken` answers.
 *
 * An owner token is a storage key AND a write authority: every plugin resolving to the
 * same token can read and write the same workspace blobs and item records. So this file
 * is not really about a string format, it is about a partition. Each test names a PAIR
 * and asserts they are together or apart, because "what does the token look like" is the
 * question that let the original defects through.
 *
 * The defects, both found by measuring the real `qualifyId` → `ownerToken` chain with the
 * ids the real install path produces rather than ids by hand:
 *
 *   1. `manifest.author` was an authority. A plugin loaded from a file declaring
 *      `author: "Acme Labs"` got `ns:acme-labs` — the token of Acme's own plugins — and
 *      could read AND WRITE their records. The id prefix is a NAME, chosen for collision
 *      avoidance (#102); it was being read as a permission.
 *   2. Everyone who omitted `author` shared one domain: no tag gives `local:<id>`, hence
 *      `ns:local`, so unrelated file-installed plugins pooled together.
 *
 * And one that was NOT a token-format problem at all but the same root cause — trusting a
 * flag to mean something it does not: a SITE plugin sets `builtin` so the manager
 * catalogues it and refuses to delete it (#185), and the token checked that flag first,
 * so deployment-provided code got the data domain of all sixty built-ins.
 *
 * The rule under test: **verifiable provenance earns a shared namespace, unverifiable
 * provenance gets isolation.** A URL plugin's namespace is its host, which came out of
 * the URL the user typed. Everything else is isolated per plugin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { qualifyId } from '../core/loader.js';
import { ownerToken } from '../core/workspace-store.js';

/**
 * Run a plugin through the install path and return its data-domain token.
 *
 * Mirrors what actually happens: `core/loader.js` stamps `manifest.id = qualifyId(...)`,
 * the catalogue stores that id, `PluginManager#list()` hands it back alongside the
 * provenance flags, and `core/app.js` calls `ownerToken` on that entry. Testing from the
 * manifest rather than from a hand-written token is the whole point — the first version
 * of this change passed a token test and still shared domains, because the ids I invented
 * were not the ids `qualifyId` produces.
 */
function domainOf({ kind, url, namespace, manifest, builtin = false, site = false }) {
  const origin = site ? { kind: 'site', namespace } : builtin ? { kind: 'builtin' } : { kind, url };
  const qid = qualifyId(origin, manifest);
  // Exactly the entry shape PluginManager#list() builds (core/plugin-manager.js:1095).
  return ownerToken({
    builtin: builtin || site,
    site,
    namespace,
    id: qid,
    origin: site ? 'site' : builtin ? 'built-in' : kind,
  });
}

const fromFile = (manifest) => domainOf({ kind: 'file', manifest });
const authoredHere = (manifest) => domainOf({ kind: 'authored', manifest });
const fromPackage = (manifest) => domainOf({ kind: 'package', manifest });
const fromUrl = (url, manifest) => domainOf({ kind: 'url', url, manifest });
const builtIn = (manifest) => domainOf({ builtin: true, manifest });
const fromSite = (namespace, manifest) => domainOf({ site: true, namespace, manifest });

// ---------------------------------------------------------------------------------------
// Defect 1 — a self-declared author is not an authority
// ---------------------------------------------------------------------------------------

test('a plugin cannot reach another author\'s data by claiming their name', () => {
  // Acme publishes from their own host, so their namespace is evidence.
  const acme = fromUrl('https://acme.example/p.js', { id: 'tracker', author: 'Acme Labs' });
  // The forgery: same author tag, installed from a file the user was handed.
  const forgery = fromFile({ id: 'evil', author: 'Acme Labs' });

  assert.notEqual(forgery, acme, 'claiming an author tag must not reach their domain');
  // Stated positively too, so a future change that merely re-spells the tokens cannot
  // pass this test while re-pooling them.
  assert.equal(acme, 'ns:acme.example', 'a URL plugin is namespaced by its host');
  assert.equal(forgery, 'plugin:acme-labs:evil', 'an unverifiable install is isolated');
});

test('the author tag still names the plugin — it just grants nothing', () => {
  // The id keeps its author prefix: #102 wants it for collision avoidance and the
  // manager shows it. What changed is that the TOKEN no longer reads authority off it.
  assert.equal(qualifyId({ kind: 'file' }, { id: 'evil', author: 'Acme Labs' }), 'acme-labs:evil');
});

// ---------------------------------------------------------------------------------------
// Defect 2 — omitting the author must not pool unrelated plugins
// ---------------------------------------------------------------------------------------

test('two unrelated file-installed plugins do NOT share a domain', () => {
  const a = fromFile({ id: 'mine' });
  const b = fromFile({ id: 'yours' });
  assert.notEqual(a, b, 'this is the ns:local pooling that let them read each other');
  assert.ok(!a.startsWith('ns:'), 'an unverifiable install earns no shared namespace');
  assert.ok(!b.startsWith('ns:'));
});

test('the pooling is gone for every unverifiable install route, not just files', () => {
  // Three routes reached `ns:local` the same way, so fixing one would have left two.
  const tokens = [
    fromFile({ id: 'one' }),
    authoredHere({ id: 'two' }),
    fromPackage({ id: 'three' }),
    fromFile({ id: 'four', author: 'Someone' }),
    authoredHere({ id: 'five', author: 'Someone' }),
  ];
  assert.equal(new Set(tokens).size, tokens.length, 'every one of them is its own domain');
  assert.equal(tokens.filter((t) => t === 'ns:local').length, 0);
});

// ---------------------------------------------------------------------------------------
// Defect 3 — a site plugin is provided, not privileged (#185)
// ---------------------------------------------------------------------------------------

test('a site plugin does NOT get the built-ins\' data domain', () => {
  const ours = builtIn({ id: 'builtin-caqdas' });
  const theirs = fromSite('sdsu', { id: 'attendance' });
  assert.equal(ours, 'builtin');
  assert.notEqual(theirs, 'builtin', 'it sets builtin:true for deletion, not for data');
  assert.equal(theirs, 'site:sdsu');
});

test('two plugins from the SAME site share, two sites do not', () => {
  // A site's plugins are served by one deploy host, which is as verifiable as a URL host.
  assert.equal(fromSite('sdsu', { id: 'a' }), fromSite('sdsu', { id: 'b' }));
  assert.notEqual(fromSite('sdsu', { id: 'a' }), fromSite('ucsd', { id: 'a' }));
});

// ---------------------------------------------------------------------------------------
// The sharing that IS intended
// ---------------------------------------------------------------------------------------

test('one host is one domain, and two hosts are two', () => {
  const a1 = fromUrl('https://a.example/one.js', { id: 'one' });
  const a2 = fromUrl('https://a.example/two.js', { id: 'two' });
  const b1 = fromUrl('https://b.example/one.js', { id: 'one' });
  assert.equal(a1, a2, 'a developer serving from their own host gets a shared namespace');
  assert.notEqual(a1, b1, 'a different host is a different author');
});

test('all built-ins share one domain, deliberately', () => {
  assert.equal(builtIn({ id: 'builtin-caqdas' }), builtIn({ id: 'builtin-agreement' }));
});

test('an unparseable source URL is isolated rather than pooled under the fallback', () => {
  // qualifyId cannot read a host from a relative URL and falls back to the literal
  // prefix `url:`, which names no host. Reading a namespace off it would pool every
  // plugin that ever failed to parse.
  const a = fromUrl('./relative.js', { id: 'one' });
  const b = fromUrl('./other.js', { id: 'two' });
  assert.equal(qualifyId({ kind: 'url', url: './relative.js' }, { id: 'one' }), 'url:one');
  assert.notEqual(a, b);
  assert.notEqual(a, 'ns:url');
});

// ---------------------------------------------------------------------------------------
// Refusing to guess
// ---------------------------------------------------------------------------------------

test('a plugin with no id gets no token, loudly', () => {
  // The old code returned a bare `plugin:` here. That is not a degraded answer, it is the
  // wrong KEY, and a wrong key reads exactly like an empty one — so a caller looking up
  // data under it silently finds none and reports "no saved data".
  assert.throws(() => ownerToken({ builtin: false, id: null, origin: 'file' }), /no id/);
  assert.throws(() => ownerToken({ builtin: false, id: '  ', origin: 'file' }), /no id/);
  // A built-in and a site plugin are identified by their flags, so they still answer.
  assert.equal(ownerToken({ builtin: true, id: null }), 'builtin');
  assert.equal(ownerToken({ site: true, namespace: 'sdsu', id: null }), 'site:sdsu');
});

test('an unrecognised install route is isolated, not given the benefit of the doubt', () => {
  // A new kind should have to argue for a shared domain rather than inherit one.
  const token = ownerToken({ builtin: false, id: 'weird:thing', origin: 'some-new-kind' });
  assert.equal(token, 'plugin:weird:thing');
});

test('the retired `origin:` token shape appears nowhere', () => {
  // It grouped by HOW a plugin was installed ('url' | 'file' | 'authored' | 'package'),
  // which is not an author at all. Unreachable in practice because qualifyId always
  // supplies a namespace, but it was the shape the code reached for when it had nothing.
  const every = [
    builtIn({ id: 'builtin-x' }), fromSite('sdsu', { id: 'a' }),
    fromUrl('https://a.example/p.js', { id: 'a' }), fromFile({ id: 'a' }),
    authoredHere({ id: 'a' }), fromPackage({ id: 'a' }),
  ];
  for (const t of every) assert.ok(!t.startsWith('origin:'), t);
});
