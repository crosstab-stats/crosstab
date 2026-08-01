import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub (node has none by default) — installed before importing
// the module, which reads globalThis.localStorage lazily at call time.
function freshStore() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
freshStore();

const { getIdentity, setIdentity, deriveInitials, currentAuthor } = await import('../core/user-identity.js');

beforeEach(() => freshStore());

test('deriveInitials: one word → first two letters; multi → first+last', () => {
  assert.equal(deriveInitials('Jane Public'), 'JP');
  assert.equal(deriveInitials('jane'), 'JA');
  assert.equal(deriveInitials('Jane Q. Public'), 'JP');
  assert.equal(deriveInitials('  '), '');
  assert.equal(deriveInitials(''), '');
});

test('getIdentity mints a stable authorId + colour, unset name by default', () => {
  const a = getIdentity();
  assert.match(a.authorId, /.+/);
  assert.equal(a.set, false);
  assert.equal(a.name, '');
  assert.match(a.color, /^#/);
  const b = getIdentity();
  assert.equal(b.authorId, a.authorId, 'authorId is stable across calls');
});

test('setIdentity derives initials from the name and marks set', () => {
  const before = getIdentity().authorId;
  const id = setIdentity({ name: 'Jane Public' });
  assert.equal(id.name, 'Jane Public');
  assert.equal(id.initials, 'JP');
  assert.equal(id.set, true);
  assert.equal(id.authorId, before, 'authorId survives setting a name');
});

test('explicit initials override derivation and are upper-cased + capped', () => {
  const id = setIdentity({ name: 'Robert', initials: 'rjp' });
  assert.equal(id.initials, 'RJP');
  const long = setIdentity({ name: 'X', initials: 'abcdef' });
  assert.equal(long.initials, 'ABCD'); // capped at 4
});

test('authorId survives a display-name change (attribution is stable)', () => {
  const first = setIdentity({ name: 'Jane Public' });
  const renamed = setIdentity({ name: 'Jane Q. Scholar' });
  assert.equal(renamed.authorId, first.authorId);
  assert.equal(renamed.initials, 'JS');
});

test('currentAuthor is a compact snapshot with authorId always present', () => {
  setIdentity({ name: 'Ada Lovelace', color: '#009e73' });
  const a = currentAuthor();
  assert.deepEqual(Object.keys(a).sort(), ['authorId', 'color', 'initials', 'name'].sort());
  assert.equal(a.initials, 'AL');
  assert.equal(a.color, '#009e73');
});
