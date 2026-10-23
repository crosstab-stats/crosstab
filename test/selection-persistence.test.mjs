/**
 * @file selection-persistence.test.mjs
 * The data grid's variable selection survives a reload — and is NOT an op.
 *
 * ## Why this is the opposite call from the picker's
 *
 * Picker selections were ruled *"purely ephemeral to that run"*, because they are one
 * run's inputs and must not change project state. The grid's are the project's own
 * working state; they are VISIBLE, so persisting them cannot violate the
 * pre-select-never-apply-invisibly rule; and they are the pre-fill for the variable
 * picker, Compute and Recode — so losing them makes the FIRST analysis after reopening
 * cost more clicks than the second.
 *
 * ## Where it lives, and where it must not
 *
 * In `datasetMeta`, the manifest's existing "per-dataset non-log state" slot — plumbed
 * end to end and standing empty since `libraryLink` went with the building-block library.
 * NOT in the log: clicking a column header is not a change to the data, and an op would
 * put a high-frequency, zero-audit entry in History and in the exported do-file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mergeDatasetMeta } from '../core/collab-sync.js';
import { pickSelection } from '../core/dataset-manager.js';
import { decideSync } from '../core/folder-sync.js';
import { HLC, hlcEncode } from '../core/hlc.js';
import { ProjectLog } from '../core/project-log.js';

const SYNC = await readFile(new URL('../core/project-sync.js', import.meta.url), 'utf8');
const MGR = await readFile(new URL('../core/dataset-manager.js', import.meta.url), 'utf8');

/** A fixed wall time, so no test depends on the real clock. */
const BASE = 1_700_000_000_000;

/** Two stamps from one clock: A then B, so B is unambiguously later. */
const CLOCK = new HLC({ now: () => BASE });
const STAMP_A = hlcEncode(CLOCK.tick());
const STAMP_B = hlcEncode(CLOCK.tick());

/** A manifest whose only interesting field is `datasetMeta`. */
const withMeta = (datasetMeta, savedAt) => ({
  name: 'Thesis', savedAt, activeId: 1, activePlugins: null, output: null,
  collabId: 'c1', collabSecret: 's1', log: [], datasetMeta,
});

/** The smallest thing that answers `getSelectedVariables`. */
const fakeStore = (selected, at = null) => ({
  getSelectedVariables: () => selected,
  selectedAt: at,
  applied: null,
  setSelectedVariables(names) { this.applied = names; },
});

/** The two people in every co-authoring test below. `authorId` is minted per DEVICE,
 * so one person's second machine is a third author as far as this code is concerned. */
const BOB = 'author-bob';
const SALLY = 'author-sally';

/** One dataset's stored selections, as the manifest holds them. */
const sel = (...pairs) => ({ selections: Object.fromEntries(pairs.map(([who, names, at]) => [who, { selected: names, ...(at ? { at } : {}) }])) });

/** `DatasetManager#datasetMeta` without a DatasetManager — the shape under test is the
 * object it builds, and standing one up needs DuckDB. */
function buildMeta(entries, me = BOB, foreign = new Map()) {
  const out = {};
  for (const [id, ds] of entries) {
    const key = String(id);
    const selections = { ...(foreign.get(key) ?? {}) };
    const selected = ds.getSelectedVariables?.() ?? [];
    if (selected.length) selections[me] = { selected, ...(ds.selectedAt ? { at: ds.selectedAt } : {}) };
    else delete selections[me];
    if (Object.keys(selections).length) out[key] = { selections };
  }
  return out;
}

// =============================================================================
// What a save carries
// =============================================================================

test('each dataset contributes its own selection, keyed by id then by author', () => {
  const meta = buildMeta([[1, fakeStore(['age', 'sex'])], [2, fakeStore(['income'])]]);
  assert.deepEqual(meta, { 1: sel([BOB, ['age', 'sex']]), 2: sel([BOB, ['income']]) });
});

test('a save writes ONLY my author key', () => {
  // Which is the whole reason a co-author's grid cannot jump: nothing this save emits
  // can describe Sally's selection, so the merge has nothing of hers to overwrite.
  const meta = buildMeta([[1, fakeStore(['age'])]], BOB);
  assert.deepEqual(Object.keys(meta[1].selections), [BOB]);
});

test('a selection carries WHEN it changed, so two writes can be ordered', () => {
  const meta = buildMeta([[1, fakeStore(['age'], STAMP_A)]]);
  assert.deepEqual(meta, { 1: sel([BOB, ['age'], STAMP_A]) });
  // Omitted rather than written as null when there is no stamp: an entry either carries
  // one or does not, and `newerMeta` reads a missing stamp as "predates this rule".
  assert.deepEqual(buildMeta([[1, fakeStore(['age'])]]), { 1: sel([BOB, ['age']]) });
});

test('a dataset with nothing selected contributes NO key', () => {
  // Absent and "deliberately nothing" read the same here, and writing `{selected: []}`
  // for every dataset on every save would grow the manifest for no information.
  const meta = buildMeta([[1, fakeStore([])], [2, fakeStore(['a'])]]);
  assert.deepEqual(Object.keys(meta), ['2']);
});

test('the manager really builds it, and the snapshot really sends it', () => {
  // The slot was plumbed end to end and carried `{}` for weeks after its only tenant was
  // removed; a test that only checked the shape would not notice it still did.
  assert.match(MGR, /^  datasetMeta\(\) \{/m);
  assert.match(SYNC, /const datasetMeta = this\.#datasets\.datasetMeta\?\.\(\) \?\? \{\};/);
  assert.doesNotMatch(SYNC, /const datasetMeta = \{\};/, 'the empty placeholder is gone');
});

// =============================================================================
// What a load restores
// =============================================================================

test('restoring goes through setSelectedVariables, which filters unknown names', () => {
  // A variable renamed or dropped since the save falls out there, which is the right
  // outcome and needs no special case here. Assigning the array directly would keep a
  // name the dataset no longer has.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /setSelectedVariables\?\.\(pick\.selected, \{ at: pick\.at \}\)/);
  assert.doesNotMatch(restore, /#selected\s*=/);
  // And the SAVED stamp travels with it — restoring must not claim to be a change made
  // now, or merely opening the project on a second machine would outrank the selection
  // the first one is still editing.
  assert.match(MGR, /at: typeof e\.at === 'string' \? e\.at : null/);
});

test('restoring happens AFTER the datasets are reconstructed', () => {
  // `setSelectedVariables` drops names it does not recognise, so restoring before the
  // columns are known would silently discard the whole selection.
  const rebuild = MGR.indexOf('await ds.rawRestore(');
  const restore = MGR.indexOf('for (const map of [this.#datasets, this.#binned])');
  assert.ok(rebuild > 0 && restore > rebuild, 'selection restore must follow rawRestore');
});

test('a binned dataset keeps its selection too', () => {
  // Deleted is a status in the log, not a different kind of storage, and a restore after
  // a reload is meant to be free — including what was selected in it.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /this\.#binned/);
});

test('the lookup bridges the key types, which a shape test cannot see', () => {
  // The Maps are keyed by the NUMERIC dataset id; JSON object keys are always strings.
  // Iterating the meta and calling `#datasets.get(objectKey)` therefore never matched,
  // and nothing in Node noticed — the selection simply came back empty in the browser.
  // Driving from the datasets and indexing the meta with `String(id)` is what fixes it.
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /const key = String\(id\);/, 'the meta is indexed by the STRINGIFIED id');
  assert.match(restore, /datasetMeta\?\.\[key\]/);
  assert.doesNotMatch(restore, /#datasets\.get\(id\)/, 'the Map must not be indexed by a JSON key');
});

test('a meta entry with no usable selection is skipped', () => {
  for (const junk of [null, undefined, {}, { selections: null }, { selections: 'x' },
    { selections: { [BOB]: null } }, { selections: { [BOB]: { selected: 'age' } } },
    { selections: { [BOB]: { selected: [] } } }, { selected: ['old-flat-shape'] }]) {
    assert.equal(pickSelection(junk, BOB), null, JSON.stringify(junk));
  }
});

// =============================================================================
// It is saved, but it is not an op
// =============================================================================

test('a selection change marks the project dirty', () => {
  // Without this it would persist only by accident — whenever some other edit happened
  // to trigger a save afterwards, which is the most confusing possible version of
  // "sometimes it remembers".
  assert.match(SYNC, /SELECTION_CHANGED, \(\) => this\.#onChange\(null\)/);
});

test('…and marks NO dataset dirty, so no Parquet is rewritten', () => {
  // At this frequency it matters: a save that re-wrote every source because someone
  // clicked a column header would be a real cost. `null` is what says "manifest only".
  const line = SYNC.slice(SYNC.indexOf('SELECTION_CHANGED, () =>'), SYNC.indexOf('SELECTION_CHANGED, () =>') + 80);
  assert.match(line, /#onChange\(null\)/);
});

test('the selection is not written to the log', async () => {
  // Clicking a column header is not a change to the data. An op would put a
  // high-frequency, zero-audit entry in the History panel and the exported do-file.
  const store = await readFile(new URL('../core/data-store.js', import.meta.url), 'utf8');
  const at = store.indexOf('setSelectedVariables(names,');
  const setter = store.slice(at, store.indexOf('get selectedAt()', at));
  assert.doesNotMatch(setter, /#append\(|#log\.append/, 'no op is written');
  assert.match(setter, /SELECTION_CHANGED/, 'it announces itself, which is how the save is triggered');
  // It does touch the log — for a STAMP, not an op. That stamp is what lets two machines
  // order their selections instead of sorting them; see `mergeDatasetMeta`.
  assert.match(setter, /stampNow/);
});

test('restoring on load does not dirty the project', () => {
  // Otherwise merely OPENING a project would bump its savedAt — conflating "looked at"
  // with "saved", which is the exact distinction `markOpened` exists to keep.
  assert.match(SYNC, /#onChange\(summary\) \{\s*\n\s*if \(this\.#loading\) return;/);
  const open = SYNC.slice(SYNC.indexOf('async #loadProject('), SYNC.indexOf('async #loadProject(') + 3000);
  const guard = open.indexOf('this.#loading = true');
  const load = open.indexOf('loadBundle(bundle)');
  assert.ok(guard >= 0 && load > guard, 'loadBundle must run inside the loading guard');
});

// =============================================================================
// Two machines, one folder
// =============================================================================

test('the winner no longer depends on how the names sort', () => {
  // The original bug, which per-author keys do not by themselves fix — within ONE key
  // two writes still have to be ordered somehow, and the old rule `{...theirs, ...mine}`
  // ordered them by content. `mine` is the lexicographically smaller content signature,
  // so `["aaa"]` beat `["zzz"]` no matter which was newer; and since the merge result is
  // written back and reloaded, the loser could never win — every save put it back.
  const older = { 1: sel([BOB, ['aaa'], STAMP_A]) };
  const newer = { 1: sel([BOB, ['zzz'], STAMP_B]) };
  assert.deepEqual(pickSelection(mergeDatasetMeta(older, newer)[1], BOB).selected, ['zzz'], 'going up');
  const olderLate = { 1: sel([BOB, ['zzz'], STAMP_A]) };
  const newerEarly = { 1: sel([BOB, ['aaa'], STAMP_B]) };
  assert.deepEqual(pickSelection(mergeDatasetMeta(olderLate, newerEarly)[1], BOB).selected, ['aaa'], 'and down');
});

test('two peers changing DIFFERENT datasets both survive', () => {
  // Which is why this merges per dataset key rather than picking one whole map.
  const a = { 1: sel([BOB, ['age'], STAMP_A]) };
  const b = { 2: sel([SALLY, ['income'], STAMP_A]) };
  assert.deepEqual(mergeDatasetMeta(a, b), { 1: a[1], 2: b[2] });
});

test('a stamped write beats an unstamped one in the same key', () => {
  // An entry with no stamp predates the rule, so anything explicit outranks it. Not a
  // migration — just the only defensible reading of "unknown when".
  const old = { 1: sel([BOB, ['legacy']]) };
  const stamped = { 1: sel([BOB, ['fresh'], STAMP_A]) };
  assert.deepEqual(pickSelection(mergeDatasetMeta(old, stamped)[1], BOB).selected, ['fresh']);
  assert.deepEqual(pickSelection(mergeDatasetMeta(stamped, old)[1], BOB).selected, ['fresh']);
});

test('both peers compute the SAME merge - the property decideSync exists for', () => {
  // Convergence is the whole reason `decideSync` normalises the argument order. Neither
  // the per-author union nor the recency rule may cost it: ties and missing stamps have
  // to resolve the same way from either side.
  const pairs = [
    [{ 1: sel([BOB, ['a'], STAMP_A]) }, { 1: sel([BOB, ['b'], STAMP_B]) }],
    [{ 1: sel([BOB, ['a'], STAMP_A]) }, { 1: sel([BOB, ['b'], STAMP_A]) }],
    [{ 1: sel([BOB, ['a']]) }, { 1: sel([BOB, ['b']]) }],
    [{ 1: sel([BOB, ['a'], STAMP_A]) }, { 1: sel([SALLY, ['b'], STAMP_B]) }],
    [{}, { 1: sel([SALLY, ['b'], STAMP_B]) }],
  ];
  for (const [x, y] of pairs) {
    const fromX = decideSync(withMeta(x, 2000), withMeta(y, 1000)).manifest.datasetMeta;
    const fromY = decideSync(withMeta(y, 1000), withMeta(x, 2000)).manifest.datasetMeta;
    assert.deepEqual(fromX, fromY, `divergent for ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
  }
});

test('null and missing meta are not crashes', () => {
  assert.deepEqual(mergeDatasetMeta(null, null), {});
  assert.deepEqual(mergeDatasetMeta(undefined, { 1: { selected: ['a'] } }), { 1: { selected: ['a'] } });
  assert.deepEqual(mergeDatasetMeta({ 1: { selected: ['a'] } }, null), { 1: { selected: ['a'] } });
});

test('the real decideSync keeps the change the user just made', () => {
  // The end-to-end version of the original bug report: she selects something at home,
  // saves into the OneDrive folder, and the folder already holds the lab's manifest.
  // Measured at 4 of 8 reverting before the fix. Her home device is its OWN author, so
  // this now passes for two independent reasons — the keys do not collide, and within a
  // key recency decides. Both are asserted, because either alone would carry it.
  const HOME = 'author-home';
  const cases = [
    [['age', 'sex'], ['income']], [['income'], ['age', 'sex']],
    [['a'], ['b']], [['b'], ['a']],
    [['age', 'sex'], ['age', 'sex', 'income']], [['age', 'sex', 'income'], ['age', 'sex']],
    [['zzz'], ['aaa']], [['aaa'], ['zzz']],
  ];
  for (const [labSel, homeSel] of cases) {
    const label = `lab=${JSON.stringify(labSel)} home=${JSON.stringify(homeSel)}`;
    // Distinct authors (the real lab/home case — `authorId` is per device).
    const lab = withMeta({ 1: sel([SALLY, labSel, STAMP_A]) }, 1000);
    const home = withMeta({ 1: sel([HOME, homeSel, STAMP_B]) }, 2000);
    const merged = decideSync(home, lab).manifest.datasetMeta[1];
    assert.deepEqual(pickSelection(merged, HOME).selected, homeSel, label);
    assert.deepEqual(pickSelection(merged, SALLY).selected, labSel, `${label} (lab kept too)`);
    // And the same identity on both machines, where only recency can save it.
    const sameLab = withMeta({ 1: sel([HOME, labSel, STAMP_A]) }, 1000);
    const sameHome = withMeta({ 1: sel([HOME, homeSel, STAMP_B]) }, 2000);
    const m2 = decideSync(sameHome, sameLab).manifest.datasetMeta[1];
    assert.deepEqual(pickSelection(m2, HOME).selected, homeSel, `${label} (one identity)`);
  }
});

// =============================================================================
// Clock skew — the case the HLC is for
// =============================================================================

test('a loaded stamp advances the clock, so the next local change outranks it', () => {
  // The lab PC runs ten minutes fast, so its stamp is from the future. Restoring it on
  // the home machine must fold it in — otherwise the next click at home is stamped
  // BEHIND it and loses, permanently, since the merge result is written back.
  const fromLab = hlcEncode(new HLC({ now: () => BASE + 600_000 }).tick()); // +10 min

  const home = new ProjectLog({ hlc: new HLC({ now: () => BASE }) });
  home.receiveStamp(fromLab);
  const next = home.stampNow();
  assert.ok(next > fromLab, `${next} must sort after ${fromLab}`);

  // And the merge then keeps her change, which is the whole point.
  assert.deepEqual(
    mergeDatasetMeta({ 1: { selected: ['hers'], at: next } }, { 1: { selected: ['lab'], at: fromLab } })[1].selected,
    ['hers'],
  );
});

test('without folding it in, a fast peer would win forever', () => {
  // The negative control: the same scenario with the stamp NOT received. This is what
  // the code did before `receiveStamp`, and it is why a passing wall-clock-agrees test
  // was not evidence.
  const fromLab = hlcEncode(new HLC({ now: () => BASE + 600_000 }).tick());
  const naive = new ProjectLog({ hlc: new HLC({ now: () => BASE }) });
  const next = naive.stampNow();
  assert.ok(next < fromLab, 'the untouched clock really does stamp behind the fast peer');
});

test('a malformed stamp fails to advance the clock rather than breaking the load', () => {
  const log = new ProjectLog();
  for (const bad of [null, undefined, '', 'not-a-stamp', 42, {}]) {
    assert.doesNotThrow(() => log.receiveStamp(bad), String(bad));
  }
  assert.match(log.stampNow(), /^\d+:\d+$/);
});

test('the restore path is what calls it', () => {
  // The unit above proves the method works; this proves the loaded selection reaches it.
  const store = readFileSync(new URL('../core/data-store.js', import.meta.url), 'utf8');
  const at = store.indexOf('setSelectedVariables(names,');
  const setter = store.slice(at, store.indexOf('get selectedAt()', at));
  assert.match(setter, /if \(at\) this\.#log\?\.receiveStamp\?\.\(at\)/);
});

// =============================================================================
// Bob and Sally
// =============================================================================
//
// The owner's challenge: *"if two people are doing work in the same dataset in a
// co-authoring scenario the selection group for bob will change as soon as sally makes
// a new selection?"*
//
// Measured, the pre-fix answer was worse than a plain yes. A selection change appends no
// op, so `needsDataRebuild` saw identical logs and the live apply skipped `loadBundle` —
// Bob saw nothing when Sally selected. But the merged manifest he then saved carried HER
// selection, and the next time anyone touched the data the rebuild branch ran
// `loadBundle(..., datasetMeta: manifest.datasetMeta)` and his grid jumped. Stable, then
// a silent jump triggered by something unrelated.

test('Bob keeps his own selection no matter what Sally does', () => {
  const stored = sel([BOB, ['age'], STAMP_A], [SALLY, ['income'], STAMP_B]);
  // Sally's is NEWER, and Bob still sees his own. Recency decides only between writes to
  // one key; it never decides between people.
  assert.deepEqual(pickSelection(stored, BOB), { selected: ['age'], at: STAMP_A });
  assert.deepEqual(pickSelection(stored, SALLY), { selected: ['income'], at: STAMP_B });
});

test("a merge cannot drop a co-author's selection", () => {
  // Bob saving must not clobber Sally, in either argument order — `decideSync` chooses
  // which side is `mine` by content signature, not by who is saving.
  const bob = { 1: sel([BOB, ['age'], STAMP_A]) };
  const sally = { 1: sel([SALLY, ['income'], STAMP_B]) };
  for (const [x, y] of [[bob, sally], [sally, bob]]) {
    const got = mergeDatasetMeta(x, y);
    assert.deepEqual(Object.keys(got[1].selections).sort(), [BOB, SALLY].sort());
    assert.deepEqual(pickSelection(got[1], BOB).selected, ['age']);
    assert.deepEqual(pickSelection(got[1], SALLY).selected, ['income']);
  }
});

test('a peer with no selection of its own adopts the NEWEST', () => {
  // This is what makes a first open useful rather than empty, and it covers both of the
  // cases the feature exists for: a second device, and a project handed to a colleague.
  const stored = sel([BOB, ['age'], STAMP_A], [SALLY, ['income'], STAMP_B]);
  assert.deepEqual(pickSelection(stored, 'author-newcomer'), { selected: ['income'], at: STAMP_B });
});

test('…and once it makes its own choice, it never moves again', () => {
  // The owner's earlier question, now literally true of both halves: *"will the home
  // system adopt the selection choices made in the lab on first load but from then on it
  // will prefer its own selection group?"*
  const HOME = 'author-home';
  const fromLab = sel([SALLY, ['age', 'sex'], STAMP_A]);
  assert.deepEqual(pickSelection(fromLab, HOME).selected, ['age', 'sex'], 'adopted on first open');

  // She changes it at home; that save adds her home key.
  const afterHome = mergeDatasetMeta({ 1: sel([HOME, ['income'], STAMP_B]) }, { 1: fromLab })[1];
  assert.deepEqual(pickSelection(afterHome, HOME).selected, ['income'], 'and prefers its own after');
  // Even when the lab machine goes on to select something later still.
  const CLOCK2 = new HLC({ now: () => BASE + 60_000 });
  const labLater = hlcEncode(CLOCK2.tick());
  const merged = mergeDatasetMeta({ 1: sel([SALLY, ['region'], labLater]) }, { 1: afterHome })[1];
  assert.deepEqual(pickSelection(merged, HOME).selected, ['income'], 'the lab cannot reach into home');
});

test('recency still decides between two writes to the SAME key', () => {
  // One person, one device, two manifests — a replay, a restored backup, or the same
  // identity cloned. This is the only place the stamp arbitrates.
  const older = { 1: sel([BOB, ['aaa'], STAMP_A]) };
  const newer = { 1: sel([BOB, ['zzz'], STAMP_B]) };
  assert.deepEqual(pickSelection(mergeDatasetMeta(older, newer)[1], BOB).selected, ['zzz']);
  assert.deepEqual(pickSelection(mergeDatasetMeta(newer, older)[1], BOB).selected, ['zzz']);
});

test('the newest-entry fallback is deterministic when nothing is stamped', () => {
  // Legacy entries have no stamp. Picking by author key is arbitrary but STABLE, which
  // is what matters: two peers must not disagree about what an unstamped project says.
  const stored = sel([BOB, ['age']], [SALLY, ['income']]);
  const a = pickSelection(stored, 'newcomer');
  const b = pickSelection({ selections: { ...stored.selections } }, 'newcomer');
  assert.deepEqual(a, b);
  // And any stamped entry still beats every unstamped one.
  const mixed = sel([BOB, ['age']], [SALLY, ['income'], STAMP_A]);
  assert.deepEqual(pickSelection(mixed, 'newcomer').selected, ['income']);
});

test('merging datasets nobody shares keeps both', () => {
  const got = mergeDatasetMeta({ 1: sel([BOB, ['age']]) }, { 2: sel([SALLY, ['income']]) });
  assert.deepEqual(Object.keys(got).sort(), ['1', '2']);
});

test('both peers compute the same per-author merge', () => {
  const bob = { 1: sel([BOB, ['age'], STAMP_A]) };
  const sally = { 1: sel([SALLY, ['income'], STAMP_B]) };
  const fromBob = decideSync(withMeta(bob, 2000), withMeta(sally, 1000)).manifest.datasetMeta;
  const fromSally = decideSync(withMeta(sally, 1000), withMeta(bob, 2000)).manifest.datasetMeta;
  assert.deepEqual(fromBob, fromSally);
});

// =============================================================================
// A save must not drop a co-author's key
// =============================================================================
//
// `#mergeSave` — the path that unions the manifest with what a peer wrote — runs only
// when the store is `externallySynced` (a folder or a remote). A plain OPFS project with
// a LIVE co-author takes the ordinary save path, which writes the snapshot verbatim, and
// the snapshot is built from the live datasets, which know only their own selection. So
// Sally's key vanished from Bob's copy the next time Bob saved anything.

test("Bob's save carries Sally's key through", () => {
  const foreign = new Map([['1', { [SALLY]: { selected: ['income'], at: STAMP_B } }]]);
  const meta = buildMeta([[1, fakeStore(['age'], STAMP_A)]], BOB, foreign);
  assert.deepEqual(Object.keys(meta[1].selections).sort(), [BOB, SALLY].sort());
  assert.deepEqual(meta[1].selections[SALLY], { selected: ['income'], at: STAMP_B });
});

test("…including when Bob has no selection of his own", () => {
  // Otherwise the dataset would contribute no key at all and hers would be the thing
  // dropped, which is the bug in its most likely form: Bob clears his selection.
  const foreign = new Map([['1', { [SALLY]: { selected: ['income'], at: STAMP_B } }]]);
  const meta = buildMeta([[1, fakeStore([])]], BOB, foreign);
  assert.deepEqual(Object.keys(meta[1].selections), [SALLY]);
});

test('clearing MY selection really clears it, rather than resurrecting the old one', () => {
  // The retained map must never hold my own key, or deselecting everything would write
  // back the selection I just cleared. The restore filters me out for exactly this.
  const foreign = new Map([['1', { [BOB]: { selected: ['stale'], at: STAMP_A } }]]);
  const meta = buildMeta([[1, fakeStore([])]], BOB, foreign);
  assert.equal(meta[1], undefined, 'no key at all when only my stale entry remains');
});

test('the restore is what populates the retained map, and excludes me', () => {
  const restore = MGR.slice(MGR.indexOf('for (const map of [this.#datasets, this.#binned])'), MGR.indexOf('// Ops of PURGED datasets'));
  assert.match(restore, /filter\(\(\[who\]\) => who !== me\)/, 'my own key is not retained');
  assert.match(restore, /#foreignSelections\.set\(key, foreign\)/);
  // And a dataset whose meta carries nobody else clears the entry rather than keeping a
  // co-author who is no longer in the manifest.
  assert.match(restore, /#foreignSelections\.delete\(key\)/);
});

test('the builder reads the retained map', () => {
  assert.match(MGR, /const selections = \{ \.\.\.\(this\.#foreignSelections\.get\(key\) \?\? \{\}\) \};/);
});
