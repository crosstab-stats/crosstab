/**
 * @file plugin-state.test.mjs
 * The plugin-activation tier (#157) — Layer 1, in isolation.
 *
 * The property under test is the one the old scalar `activePlugins` could not hold:
 * that "off" is a fact with a clock, not the absence of an "on".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGIN_STATE, foldPluginState, foldPluginOpinions, pluginOpsFor,
  pluginTarget, keyOfPluginTarget, isPluginOp, pluginOpsOf, migrateLegacyActivePlugins,
} from '../core/plugin-state.js';

let seq = 0;
const op = (key, type, hlc) => ({
  id: `op-${++seq}`, hlc: hlc ?? `hlc-${String(seq).padStart(4, '0')}`,
  target: pluginTarget(key), owner: 'core', type, payload: { key },
});
const on = (key, hlc) => op(key, 'activatePlugin', hlc);
const off = (key, hlc) => op(key, 'deactivatePlugin', hlc);

test('targets round-trip, including keys that look like paths or URLs', () => {
  for (const key of ['./plugins/x/index.js', 'https://example.org/p.js', 'plain']) {
    assert.equal(keyOfPluginTarget(pluginTarget(key)), key);
  }
  assert.equal(keyOfPluginTarget('ds:5/rows'), null);
  assert.equal(keyOfPluginTarget(null), null);
});

test('the tier is recognised by owner AND target, so a plugin cannot forge one', () => {
  assert.ok(isPluginOp({ owner: 'core', target: 'plugin:a' }));
  assert.equal(isPluginOp({ owner: 'some-plugin', target: 'plugin:a' }), false);
  assert.equal(isPluginOp({ owner: 'core', target: 'ws:a' }), false);
  assert.deepEqual(pluginOpsOf([{ owner: 'core', target: 'plugin:a' }, { owner: 'core', target: 'ds:1/x' }]).length, 1);
});

test('fold is last-writer-wins per plugin, in log order', () => {
  assert.deepEqual([...foldPluginState([on('a'), on('b')])].sort(), ['a', 'b']);
  assert.deepEqual([...foldPluginState([on('a'), off('a')])], []);
  assert.deepEqual([...foldPluginState([off('a'), on('a')])], ['a']);
  assert.deepEqual([...foldPluginState([on('a'), off('a'), on('a')])], ['a']);
});

test('THE POINT: a later deactivation beats an earlier activation from anywhere', () => {
  // The union rule this replaces could not express it — a set union only grows, so a
  // co-author who still had the plugin on re-added it every merge and the peer who
  // turned it off watched it come back.
  const merged = [on('spatial', 'hlc-0001'), off('spatial', 'hlc-0002')]; // A on, then B off
  assert.deepEqual([...foldPluginState(merged)], [], 'off wins because it is later');
  // …and symmetrically, turning it back on later wins in turn.
  assert.deepEqual([...foldPluginState([...merged, on('spatial', 'hlc-0003')])], ['spatial']);
});

test('a plugin with no ops is unspoken-for, not off', () => {
  const opinions = foldPluginOpinions([on('a')]);
  assert.equal(opinions.get('a'), true);
  assert.equal(opinions.has('b'), false, 'never mentioned ⇒ no opinion');
  assert.equal(opinions.get('b'), undefined);
  // The distinction matters: only a recorded `false` should switch anything off.
  assert.equal(foldPluginState([on('a')]).has('b'), false);
});

test('undone ops are hidden, so undo of a deactivation restores the activation', () => {
  const activate = on('a', 'hlc-0001');
  const deactivate = off('a', 'hlc-0002');
  const undo = { id: 'op-u', hlc: 'hlc-0003', owner: 'core', target: 'undo', type: 'undo', payload: { opId: deactivate.id } };
  assert.deepEqual([...foldPluginState([activate, deactivate, undo])], ['a'],
    'the activation beneath the undone deactivation stands again');
});

test('pluginOpsFor writes nothing when the log already agrees', () => {
  const opinions = foldPluginOpinions([on('a'), off('b')]);
  assert.deepEqual(pluginOpsFor(opinions, ['a'], ['a', 'b']), [],
    'no churn — a project open must not spam an op per plugin per session');
});

test('pluginOpsFor records both directions of an actual change', () => {
  const opinions = foldPluginOpinions([on('a'), on('b')]);
  const ops = pluginOpsFor(opinions, ['a', 'c'], ['a', 'b', 'c']);
  const byKey = Object.fromEntries(ops.map((o) => [o.payload.key, o.type]));
  assert.deepEqual(byKey, { b: 'deactivatePlugin', c: 'activatePlugin' });
  assert.ok(ops.every((o) => o.owner === 'core' && o.target.startsWith('plugin:')));
});

test('pluginOpsFor deactivates a plugin that leaves the wanted set', () => {
  // Silently forgetting it would be the old bug in a new place: the project would stop
  // saying "on" without ever saying "off", and a peer's stale "on" would win again.
  const opinions = foldPluginOpinions([on('a')]);
  assert.deepEqual(pluginOpsFor(opinions, [], ['a']).map((o) => o.type), ['deactivatePlugin']);
});

test('legacy activePlugins migrate to activations only — never inferred deactivations', () => {
  // The old array said nothing about what it omitted: deliberately off, or simply not
  // installed on that machine. Inventing "off" from an absence is the inference this
  // tier exists to stop making.
  const resolve = (x) => ({ 'builtin-freq': './plugins/freq/index.js' }[x] ?? null);
  const ops = migrateLegacyActivePlugins(['builtin-freq', 'not-installed'], new Map(), resolve);
  assert.deepEqual(ops.map((o) => [o.type, o.payload.key]), [['activatePlugin', './plugins/freq/index.js']]);
});

test('migration defers to the log: a plugin already spoken for is left alone', () => {
  const resolve = (x) => x;
  const opinions = foldPluginOpinions([off('a')]); // the log says OFF
  assert.deepEqual(migrateLegacyActivePlugins(['a'], opinions, resolve), [],
    'a stale legacy scalar must not resurrect what the log already turned off');
  assert.deepEqual(migrateLegacyActivePlugins(null, new Map(), resolve), []);
});

test('the projection folds the tier out of a mixed log', () => {
  const mixed = [on('a'), { id: 'x', hlc: 'hlc-9', owner: 'core', target: 'ds:1/rows', type: 'load' }, off('b')];
  assert.equal(PLUGIN_STATE.key, 'plugins');
  assert.deepEqual([...PLUGIN_STATE.fold(mixed.filter(PLUGIN_STATE.match))], ['a']);
});

// --- merge behaviour (#157 regression) ---------------------------------------
// Two peers each recording their own plugin set collided on EVERY plugin: the
// target-collision pass treats two independently-added ops on one target as rival
// additions. For a register that is wrong — the clock already decides.
const { threeWayLog } = await import('../core/merge.js');

test('REGRESSION: two peers writing the same plugin target is not a conflict', () => {
  const mine = [{ ...on('spatial'), id: 'op-mine', hlc: 'hlc-0001' }];
  const theirs = [{ ...off('spatial'), id: 'op-theirs', hlc: 'hlc-0002' }];
  const { conflicts, resolved } = threeWayLog([], mine, theirs, 'core');
  assert.deepEqual(conflicts, [], 'no dialog — every answer here yields the same state');
  assert.equal(resolved.length, 2, 'both ops survive; the fold picks by HLC');
  assert.deepEqual([...foldPluginState(resolved.sort((a, b) => (a.hlc < b.hlc ? -1 : 1)))], [],
    'the later deactivation stands');
});

test('…while a genuine same-target collision in another tier still asks', () => {
  // The exemption must be narrow: it is about registers, not about silencing the
  // dialog. An op that CONTRIBUTES to its target still surfaces.
  const mine = [{ id: 'op-a', hlc: 'hlc-0001', owner: 'core', target: 'ds:1/var:income', type: 'recodeVariable', payload: {} }];
  const theirs = [{ id: 'op-b', hlc: 'hlc-0002', owner: 'core', target: 'ds:1/var:income', type: 'recodeVariable', payload: {} }];
  const { conflicts } = threeWayLog([], mine, theirs, 'core');
  assert.equal(conflicts.length, 1, 'two rival recodes of one variable is a real question');
});

test('the tier is invisible to undo and History, and must stay that way', () => {
  // The project's plugin declaration is deliberately FULL — ~60 ops at a first save —
  // which is only tolerable because nothing renders it. Undo walks three tiers by
  // prefix (ds: / item: / analysis:) and History reads the same three; `plugin:` is
  // none of them. If that ever changed, Ctrl+Z after opening a project would rewind a
  // plugin instead of the user's work, sixty times over.
  const target = pluginTarget('./plugins/x/index.js');
  for (const prefix of ['ds:', 'item:', 'analysis:', 'ws:', 'coll/', 'asset:']) {
    assert.equal(target.startsWith(prefix), false, `plugin ops must not read as ${prefix}`);
  }
});
