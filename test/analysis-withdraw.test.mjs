/**
 * @file analysis-withdraw.test.mjs
 * Withdrawing a run, and the two bugs that only showed up in the running app (#191).
 *
 * Both were invisible to the suite because they need a run with a HISTORY — several
 * `runAnalysis` ops for one runId, which is what a move, a dataset rename, or a re-run
 * each leave behind. Every unit test here had been building runs with exactly one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisLog } from '../core/analysis-log.js';
import { ProjectLog } from '../core/project-log.js';

function setup() {
  const projectLog = new ProjectLog();
  const log = new AnalysisLog(null, projectLog);
  log.record({ pluginId: 'p', run: 'go', label: 'Descriptives', datasetId: 1, specs: [], inputs: {}, at: 0 });
  const runId = log.entries()[0].runId;
  return { log, projectLog, runId };
}

test('withdrawing hides EVERY op for a run, not just the newest', () => {
  // The bug, as it appeared on screen: "Descriptives" listed twice — once live, once
  // below the cursor. `withdraw` undid the latest op, and the fold takes ANY applied op
  // as evidence the run exists, so the older one kept it alive.
  const { log, runId } = setup();
  log.touch(runId); // a re-run: now two ops for one run
  log.reposition(runId, 1); // a move: three
  assert.equal(log.entries().length, 1, 'still one run');

  log.withdraw(runId);
  assert.deepEqual(log.entries(), [], 'gone from the live list');
  assert.deepEqual(log.withdrawnEntries().map((e) => e.runId), [runId]);
});

test('admitting brings all of them back', () => {
  const { log, runId } = setup();
  log.touch(runId);
  log.withdraw(runId);
  log.admit(runId);
  assert.deepEqual(log.entries().map((e) => e.runId), [runId]);
  assert.deepEqual(log.withdrawnEntries(), []);
});

test('withdrawnEntries lists one row per RUN, with the newest payload', () => {
  // One entry per op would have drawn the same analysis several times below the cursor.
  const { log, runId } = setup();
  log.reposition(runId, 2);
  log.withdraw(runId);
  const out = log.withdrawnEntries();
  assert.equal(out.length, 1);
  assert.equal(out[0].at, 2, 'the newest payload, not the original');
});

test('a run that is still live is not reported as withdrawn', () => {
  const { log, runId } = setup();
  log.record({ pluginId: 'p', run: 'go', label: 'Other', datasetId: 1, specs: [], inputs: {}, at: 0 });
  const other = log.entries()[1].runId;
  log.withdraw(other);
  assert.deepEqual(log.entries().map((e) => e.label), ['Descriptives']);
  assert.deepEqual(log.withdrawnEntries().map((e) => e.runId), [other]);
  void runId;
});

test('touch records a re-run in place, which is what clears a stale mark', () => {
  // `reposition` returns early when the position has not changed — right for a MOVE, and
  // wrong for a re-run: with no new op the log still reads the result as older than the
  // edit that made it stale, so pressing ↻ never cleared the badge however many times you
  // pressed it. Found by pressing it.
  const { log, projectLog, runId } = setup();
  const before = projectLog.slice(() => true).length;
  assert.equal(log.reposition(runId, 0).runId, runId);
  assert.equal(projectLog.slice(() => true).length, before, 'a no-op move writes nothing');
  log.touch(runId);
  assert.equal(projectLog.slice(() => true).length, before + 1, 'a re-run is an event');
});

test('touch re-derives reads, so a re-run declares what it depends on NOW', () => {
  const projectLog = new ProjectLog();
  const log = new AnalysisLog(null, projectLog);
  const specs = [{ name: 'vars', kind: 'variables' }];
  log.record({ pluginId: 'p', run: 'go', label: 'A', datasetId: 7, specs, inputs: { vars: ['age'] }, at: 0 });
  const runId = log.entries()[0].runId;
  log.touch(runId);
  assert.deepEqual(projectLog.slice(() => true).at(-1).reads, ['ds:7/var:age']);
});

test('touch and withdraw refuse an unknown run rather than inventing one', () => {
  const { log } = setup();
  assert.equal(log.touch('nope'), null);
  assert.equal(log.withdraw('nope'), false);
  assert.equal(log.admit('nope'), false);
  assert.equal(log.withdraw(''), false);
});
