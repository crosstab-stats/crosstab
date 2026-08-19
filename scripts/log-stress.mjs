/**
 * @file scripts/log-stress.mjs
 * **Log performance stress harness** — the baseline for #166.
 *
 * Deliberately NOT in `test/`: this is a benchmark, not an assertion. Timing tests are
 * flaky in CI and would slow `npm test` for no gain. Run it by hand:
 *
 *     node scripts/log-stress.mjs                # default corpus sizes
 *     node scripts/log-stress.mjs 500 5000 50000
 *
 * ## What it measures, and why these five
 *
 * A CAQDAS corpus grows the log in one direction only — one op per coding, forever
 * ([[one-true-log-explicit-ops]] accepts a spammy log on purpose). These are the five
 * costs that grow with it, each one paid at a different moment:
 *
 *  1. **append**    — coding a corpus. Paid once per coding, by the researcher, live.
 *  2. **fold**      — `foldItems` over the item tier. Paid on every load AND every
 *                     workspace refresh, so it is the one a user feels repeatedly.
 *  3. **order**     — `orderByHlc` over the whole log (every `slice()` re-sorts).
 *  4. **diff**      — the plugin's whole-collection save diff. #166 step 2 deletes this;
 *                     the number here is what deleting it is worth.
 *  5. **merge**     — `mergeProjects` over two diverged peers.
 *
 * Plus `serialize()` byte size, which is what a project file actually costs on disk.
 *
 * ## Honesty note
 *
 * (4) REPLICATES `syncState`'s algorithm rather than calling it: that function is not
 * exported from the plugin (it closes over module state). The replication is
 * byte-faithful to the original's `same`/`clone` (JSON round-trip) and its two-pass
 * shape — see `diffLikeSyncState`. If the plugin's version changes, this drifts; it is
 * a baseline, not a regression gate.
 */

import { ProjectLog } from '../core/project-log.js';
import { HLC } from '../core/hlc.js';
import { ItemStore, foldItems, isItemOp } from '../core/item-store.js';
import { mergeProjects } from '../core/collab-sync.js';

const OWNER = 'builtin-caqdas';
const SIZES = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const CORPUS = SIZES.length ? SIZES : [500, 2_000, 10_000, 25_000];

// --- fixtures ----------------------------------------------------------------

/** A realistic coded passage: ~60 chars of quoted text is what drives byte size. */
const SENTENCES = [
  'we had to wait nearly three hours before anyone came',
  'the nurse was kind but she was clearly rushed off her feet',
  'nobody explained what the medication was actually for',
  'I felt like I was being passed from person to person',
  'my daughter had to take the day off work to drive me there',
];

/** One segment record's fields, in the shape the plugin writes today. */
function segmentFields(i) {
  const text = SENTENCES[i % SENTENCES.length];
  const start = (i * 37) % 4000;
  return {
    doc: String(100000000 + (i % 400)),      // ~400 documents
    codeId: `c_${i % 60}`,                    // ~60 codes
    start,
    end: start + text.length,
    text,
    author: { authorId: 'a1', initials: 'KC', name: 'K Coder', color: '#8ecae6' },
  };
}

function makePeer(wall = 1_700_000_000_000, author = { authorId: 'a1', initials: 'KC' }) {
  let w = wall;
  const log = new ProjectLog({ hlc: new HLC({ now: () => w }), author: () => author });
  return { log, store: new ItemStore({ log }), tick: (n) => { w += n; } };
}

// --- the replicated plugin diff (see the honesty note above) -----------------

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `syncState`'s per-collection diff, reproduced: compare the live array against a
 * shadow of what was last persisted, emit a put per changed record and a remove per
 * vanished one, then re-clone the whole shadow. The final re-clone is the part that
 * makes a one-code edit cost O(all segments).
 */
function diffLikeSyncState(arr, shadow, put) {
  const now = new Map(arr.filter((x) => x && x.id).map((x) => [x.id, x]));
  let writes = 0;
  for (const [id, val] of now) {
    const prev = shadow.get(id);
    if (prev && same(prev, val)) continue;
    const { id: _drop, ...fields } = val;
    put(id, fields);
    writes++;
  }
  for (const id of shadow.keys()) if (!now.has(id)) writes++;
  return { shadow: new Map([...now].map(([k, v]) => [k, clone(v)])), writes };
}

// --- timing ------------------------------------------------------------------

const ms = (t) => `${t.toFixed(1)}ms`;
function time(fn) {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

const KB = (b) => `${(b / 1024).toFixed(0)}KB`;
const rows = [];

// --- the run -----------------------------------------------------------------

console.log('CrossTab log performance — baseline BEFORE the #166 rebuild');
console.log(`node ${process.version}  ·  ${new Date().toISOString()}\n`);

for (const N of CORPUS) {
  const peer = makePeer();

  // 1. append — writing N codings through the item tier.
  const append = time(() => {
    for (let i = 0; i < N; i++) {
      peer.tick(1);
      peer.store.put(OWNER, 'segments', `s_${i}`, segmentFields(i), { scope: { dsId: 5 } });
    }
  });

  // 2. fold — what a load and every refresh pay.
  const itemOps = peer.log.slice(isItemOp);
  const fold = time(() => foldItems(itemOps));
  const foldAgain = time(() => foldItems(itemOps)); // steady-state refresh cost

  // 3. order — every slice() re-sorts the whole log.
  const order = time(() => peer.log.ops());

  // 4. diff — the plugin's save cost for ONE edited code.
  const live = Array.from({ length: N }, (_, i) => ({ id: `s_${i}`, ...segmentFields(i) }));
  let shadow = new Map(live.map((v) => [v.id, clone(v)]));
  live[Math.floor(N / 2)].end += 2;                    // the user nudges one boundary
  const diff = time(() => diffLikeSyncState(live, shadow, () => {}));
  shadow = diff.out.shadow;

  // 5. merge — two peers that each coded 5% more after diverging.
  const bytes = Buffer.byteLength(JSON.stringify(peer.log.serialize()));
  const divergeN = Math.max(1, Math.round(N * 0.05));
  const mine = makePeer(1_700_000_000_000, { authorId: 'a1', initials: 'KC' });
  const theirs = makePeer(1_700_000_000_000, { authorId: 'a2', initials: 'RM' });
  for (let i = 0; i < N; i++) {                        // shared history
    mine.tick(1); theirs.tick(1);
    const f = segmentFields(i);
    mine.store.put(OWNER, 'segments', `s_${i}`, f, { scope: { dsId: 5 } });
    theirs.store.put(OWNER, 'segments', `s_${i}`, f, { scope: { dsId: 5 } });
  }
  for (let i = 0; i < divergeN; i++) {                 // then they diverge
    mine.tick(2); theirs.tick(3);
    mine.store.put(OWNER, 'segments', `m_${i}`, segmentFields(i), { scope: { dsId: 5 } });
    theirs.store.put(OWNER, 'segments', `t_${i}`, segmentFields(i), { scope: { dsId: 5 } });
  }
  const a = mine.log.serialize();
  const b = theirs.log.serialize();
  const merge = time(() => mergeProjects({ log: a }, { log: b }, {}));

  rows.push({
    N,
    append: append.ms,
    fold: fold.ms,
    refold: foldAgain.ms,
    order: order.ms,
    diff: diff.ms,
    merge: merge.ms,
    bytes,
    mergedOps: merge.out?.log?.length ?? merge.out?.ops?.length ?? null,
  });

  console.log(
    `${String(N).padStart(6)} codings │ ` +
    `append ${ms(append.ms).padStart(9)} │ fold ${ms(fold.ms).padStart(8)} │ ` +
    `refold ${ms(foldAgain.ms).padStart(8)} │ order ${ms(order.ms).padStart(8)} │ ` +
    `diff ${ms(diff.ms).padStart(8)} │ merge ${ms(merge.ms).padStart(9)} │ log ${KB(bytes).padStart(7)}`,
  );
}

// --- read the shape, not just the numbers ------------------------------------

console.log('\nPer-coding cost (µs) and growth factor vs the smallest run:');
const base = rows[0];
for (const r of rows) {
  const per = (r.fold / r.N) * 1000;
  const grow = (r.fold / base.fold) / (r.N / base.N);   // 1.0 = linear, >1 = worse
  console.log(
    `${String(r.N).padStart(6)} │ fold ${per.toFixed(2)}µs/coding │ ` +
    `scaling ${grow.toFixed(2)}× linear │ ` +
    `diff ${((r.diff / r.N) * 1000).toFixed(2)}µs/coding │ ` +
    `${(r.bytes / r.N).toFixed(0)} bytes/coding`,
  );
}

console.log(`
Reading this:
  · fold/refold is paid on EVERY load and workspace refresh — the number a user feels.
  · diff is the cost of saving ONE boundary nudge; #166 step 2 replaces it with a single
    narrow put, so this column should go to ~0 after the rebuild.
  · scaling >1.0 means super-linear: the corpus is getting more expensive per coding.
  · bytes/coding × your real corpus = the project-file growth to expect.
`);
