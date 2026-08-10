/**
 * @file caqdas-codebooks.test.mjs
 * A codebook is now a named, project-scoped object rather than "whatever codes happen
 * to be attached to this dataset".
 *
 * The two scopes are deliberately different and the difference is the whole design. A
 * CODEBOOK is project-wide — a coding scheme outlives and spans the documents it is
 * applied to, and researchers reuse one across studies. A CODING cannot be: it anchors
 * to a `__ct_rid` row id belonging to exactly one dataset, and means nothing in another.
 * Workspace-level scope can only say one thing for both, which is why per-collection
 * scope had to exist first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { manifest } = await import('../plugins/builtin-caqdas/index.js');
const { normalizeCollection } = await import('../core/collections.js');

const collOf = (id) => manifest.collections.find((c) => c.id === id);

test('codebooks and codes are project-scoped; codings are not', () => {
  assert.equal(collOf('codebooks').scope, 'project');
  assert.equal(collOf('codes').scope, 'project');
  // Not merely unset — a coding must never become project-wide, because its `doc` is a
  // row id from one dataset. Left to inherit, and the workspace is dataset-scoped.
  assert.equal(collOf('segments').scope, undefined,
    'segments inherit the workspace scope, which is per-dataset');
});

test('the declaration survives normalisation with its scope intact', () => {
  // The plugin can declare whatever it likes; what matters is what the host keeps.
  assert.equal(normalizeCollection(collOf('codes')).scope, 'project');
  assert.equal(normalizeCollection(collOf('segments')).scope, null, 'null = inherit');
});

test('a codebook is addressable — it has an id and a display name', () => {
  // The thing that did not exist before. Without `labelField` the sidebar renders a
  // record as its id and cannot offer rename, which is most of what a manager needs.
  const cb = collOf('codebooks');
  assert.equal(cb.labelField, 'name');
  assert.equal(cb.label, 'Codebooks');
  assert.equal(cb.sidebar, 'list', 'codebooks are few — list them, unlike segments');
});

test('codings stay a count in the sidebar, not a list', () => {
  // A project holds thousands. The inventory's job is to show data EXISTS here.
  assert.equal(collOf('segments').sidebar, 'count');
});

test('every declared collection is well-formed', () => {
  for (const raw of manifest.collections) {
    const d = normalizeCollection(raw);
    assert.ok(d, `${raw.id} normalised away entirely`);
    assert.equal(d.id, raw.id);
  }
});

test('codings declare their row reference so a re-home can carry them (#151)', () => {
  // The asymmetry that dissolved half of #151: a CODING points at a `__ct_rid`, a CODE
  // points at nothing dataset-shaped. So codings need remapping and codes just follow.
  assert.deepEqual(collOf('segments').rowRefs, ['doc']);
  assert.equal(collOf('codes').rowRefs, undefined, 'a code references no row');
  assert.equal(collOf('codebooks').rowRefs, undefined);
});
