/**
 * @file asset-seed-staging.test.mjs
 * Loading a demo must not create a project — including a demo that seeds an ASSET.
 *
 * The checklist line this pins: "load a demo and immediately reload without editing
 * anything → you are back at the launcher; a demo or blank seed is not autosaved as
 * though it were your work." Quant and qual passed; **spatial did not**, because its
 * boundary GeoJSON goes through the asset store (#152 Layer 5 — deliberately the same
 * path a loaded file takes), and `AssetStore#put` called `ensureProject()`, which
 * created an autosaving "Untitled project" regardless of `loadingSeed` having disarmed
 * auto-create. One demo click, one project in the list, no work done.
 *
 * The fix is not to take the demo off the real code path. `ensureProject` returns null
 * while auto-create is disarmed, and the asset store holds those bytes in memory until
 * a project genuinely comes into being. So the tests below are about a store with
 * nowhere to write: it must still READ back what it was given, must write nothing, and
 * must land everything the moment there is a project.
 *
 * Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AssetStore } from '../core/asset-store.js';
import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';

/** A ProjectStore stand-in that records every byte write, so "wrote nothing" is a
 *  fact rather than an absence of observation. */
function fakeStore() {
  const files = new Map(); // `${pid}/${id}` -> Blob
  const writes = [];
  return {
    files,
    writes,
    async writeAsset(pid, id, blob) { writes.push({ pid, id }); files.set(`${pid}/${id}`, blob); },
    async readAsset(pid, id, type) {
      const b = files.get(`${pid}/${id}`);
      return b ? (type ? new Blob([b], { type }) : b) : null;
    },
    async hasAsset(pid, id) { return files.has(`${pid}/${id}`); },
    async listAssets(pid) {
      return [...files.keys()].filter((k) => k.startsWith(`${pid}/`)).map((k) => k.slice(String(pid).length + 1));
    },
    async removeAsset(pid, id) { files.delete(`${pid}/${id}`); },
  };
}

/** `projectId` is a getter, so the test can let a project appear mid-flight the way a
 *  first save does. */
function makeAssets({ store = fakeStore(), projectId = null, ensure = async () => null } = {}) {
  const log = new ProjectLog({ hlc: new HLC({ now: () => 1000 }) });
  const state = { projectId };
  const assets = new AssetStore({
    store,
    log,
    bus: { emit() {} },
    projectId: () => state.projectId,
    ensureProject: ensure,
  });
  return { assets, store, log, state };
}

const bytes = (s) => new TextEncoder().encode(s);
const text = async (blob) => new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));

// --- the seed load ------------------------------------------------------------

test('a seed put writes nothing to disk when there is no project', async () => {
  const { assets, store } = makeAssets(); // ensureProject → null, as inside loadingSeed
  const info = await assets.put(bytes('{"type":"FeatureCollection"}'), {
    name: 'Sacramento ZIP codes', type: 'application/geo+json',
  });
  assert.equal(store.writes.length, 0, 'seeding a demo must not touch the project directory');
  assert.ok(info.id, 'it is still a content-addressed asset with a real id');
});

test('the seeded bytes read back, so the demo map still has its boundaries', async () => {
  const { assets } = makeAssets();
  const json = '{"type":"FeatureCollection","features":[]}';
  const { id } = await assets.put(bytes(json), { name: 'zips', type: 'application/geo+json' });

  const blob = await assets.getBlob(id);
  assert.ok(blob, 'the bytes must be readable with no project to read from');
  assert.equal(await text(blob), json);
  assert.equal(blob.type, 'application/geo+json');
  assert.equal(await assets.has(id), true);
  assert.deepEqual((await assets.list({ present: true })).map((a) => a.id), [id]);
  assert.deepEqual(await assets.missing(), [], 'we hold these — they are not a gap to fill');
});

test('the index still records the asset, so the first real save carries it', async () => {
  const { assets } = makeAssets();
  const { id } = await assets.put(bytes('x'), { name: 'zips', type: 'application/geo+json' });
  assert.deepEqual((await assets.list()).map((a) => a.id), [id]);
  assert.equal(assets.meta(id)?.name, 'zips');
  assert.equal(assets.ops().length, 1, 'one addAsset op — the log is the index');
});

// --- the first real edit ------------------------------------------------------

test('flushStaged lands the seeded bytes once a project exists', async () => {
  const { assets, store, state } = makeAssets();
  const { id } = await assets.put(bytes('geo'), { type: 'application/geo+json' });
  assert.equal(store.writes.length, 0);

  state.projectId = 'p1'; // the user did some work; #fullSave bound a project
  assert.equal(await assets.flushStaged(), 1);
  assert.deepEqual(store.writes, [{ pid: 'p1', id }]);
  assert.equal(await store.hasAsset('p1', id), true);

  assert.equal(await assets.flushStaged(), 0, 'nothing left staged — flushing twice is a no-op');
  assert.equal(store.writes.length, 1, 'and it does not rewrite what it already wrote');
  assert.equal(await text(await assets.getBlob(id)), 'geo', 'now served from the project');
});

test('a flush with nowhere to write keeps the bytes for the next save', async () => {
  const { assets, store } = makeAssets();
  const { id } = await assets.put(bytes('geo'), {});
  assert.equal(await assets.flushStaged(), 0, 'still no project');
  assert.equal(store.writes.length, 0);
  assert.ok(await assets.getBlob(id), 'and the bytes are NOT dropped on the floor');
});

// --- the negative control: a real write still goes straight to disk -----------

test('with a project, put writes through and stages nothing', async () => {
  const { assets, store, state } = makeAssets({ projectId: 'p1', ensure: async () => 'p1' });
  const { id } = await assets.put(bytes('a real interview recording'), { name: 'i1.m4a' });
  assert.deepEqual(store.writes, [{ pid: 'p1', id }], 'work goes to the project immediately');
  assert.equal(await assets.flushStaged(), 0, 'there was nothing to stage');

  // …and it is genuinely in the project, not merely readable from a staging map.
  state.projectId = 'p2';
  assert.equal(await assets.getBlob(id), null, 'a different project does not hold it');
});

test('put with no project store attached is still an error, not silent staging', async () => {
  const assets = new AssetStore();
  await assert.rejects(() => assets.put(bytes('x'), {}), /no project store attached/);
});

// --- abandoning the seed ------------------------------------------------------

test('opening a project drops staged seed bytes instead of importing them', async () => {
  const { assets, store, log, state } = makeAssets();
  const { id } = await assets.put(bytes('demo geometry'), {});

  // The user picked an existing project from the launcher instead: the asset tier is
  // replaced wholesale. The demo's geometry must not follow them in.
  state.projectId = 'p9';
  assets.restoreOps([]);
  assert.equal(await assets.getBlob(id), null);
  assert.equal(await assets.has(id), false);
  assert.equal(await assets.flushStaged(), 0);
  assert.equal(store.writes.length, 0);
  assert.equal(log.slice(() => true).length, 0, 'and the demo asset is out of the log too');
});

test('deleting a staged asset forgets its bytes', async () => {
  const { assets } = makeAssets();
  const { id } = await assets.put(bytes('oops'), {});
  await assets.delete(id);
  assert.equal(await assets.has(id), false);
  assert.equal(await assets.getBlob(id), null);
});

// --- the wiring that makes the above reachable from the app -------------------

const SYNC = readFileSync(new URL('../core/project-sync.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../core/app.js', import.meta.url), 'utf8');
// A correct comment must never be what satisfies a source assertion.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('ensureProject refuses to create while auto-create is disarmed', () => {
  const body = strip(SYNC).split('async ensureProject()')[1]?.split('\n  }')[0] ?? '';
  assert.match(body, /#armed/, 'the seed exemption has to be checked here, not only in #onChange');
  assert.match(body, /return null/);
});

test('a save flushes staged assets, and app.js supplies the flush', () => {
  const fullSave = strip(SYNC).split('async #fullSave(')[1]?.split('\n  }')[0] ?? '';
  assert.match(fullSave, /#assetBytes\?\.flush\?\.\(\)/, 'bytes must land when a project is bound');
  assert.match(strip(APP), /flush:\s*\(\)\s*=>\s*assetStore\.flushStaged\(\)/);
});
