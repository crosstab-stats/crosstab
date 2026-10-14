/**
 * @file analysis-stale.test.mjs
 * A result whose data moved after it ran says so (#191 T5).
 *
 * `staleReaders` has been in op-log.js since #166, fully documented, answering exactly the
 * question a trustworthy History has to answer — *"does something I depend on change after
 * me?"* It could not see analyses, because `runAnalysis` ops carried no `reads[]`. A result
 * computed from a variable that was recoded afterwards therefore sat in Output looking as
 * authoritative as one computed a second ago.
 *
 * Detection only, deliberately: the numbers were true of the data at the time, which is
 * what a history is for. Marking says so; re-running is the user's call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisLog } from '../core/analysis-log.js';
import { ProjectLog } from '../core/project-log.js';
import { varsNamed } from '../core/var-ref.js';

const SPECS = [{ name: 'vars', kind: 'variables' }, { name: 'title', kind: 'text' }];

function setup() {
  const projectLog = new ProjectLog();
  const log = new AnalysisLog(null, projectLog);
  const recode = (name) => projectLog.append({
    target: `ds:1/var:${name}`, owner: 'core', type: 'recodeVar',
    payload: { name, source: name, rules: [] },
  });
  const run = (label, vars) => {
    log.record({
      pluginId: 'p', run: 'go', label, datasetId: 1, specs: SPECS,
      inputs: { vars, title: 'Results: Wave 2' }, at: 0,
    });
    return log.entries().at(-1).runId;
  };
  return { log, projectLog, recode, run };
}

test('varsNamed reads variable inputs and ignores prose', () => {
  // A chart title reading "Results: Wave 2" must not be parsed as a qualified reference,
  // or an analysis would declare a dependency on a variable nobody named.
  assert.deepEqual(
    varsNamed({ vars: ['age', 'income'], title: 'Results: Wave 2' }, SPECS),
    [{ dataset: null, name: 'age' }, { dataset: null, name: 'income' }],
  );
});

test('a run declares the variables it read', () => {
  const { projectLog, run } = setup();
  const runId = run('Frequencies', ['age']);
  const op = projectLog.slice((o) => o.payload?.runId === runId).at(-1);
  assert.deepEqual(op.reads, ['ds:1/var:age']);
});

test('a run is NOT stale when nothing it used has changed since', () => {
  const { log, run, recode } = setup();
  recode('income'); // something else entirely
  const runId = run('Frequencies', ['age']);
  assert.deepEqual([...log.staleRuns()], [], 'a sibling variable is not on its path');
  void runId;
});

test('recoding a variable AFTER a run marks that run stale', () => {
  const { log, run, recode } = setup();
  const runId = run('Frequencies', ['age']);
  assert.deepEqual([...log.staleRuns()], []);
  recode('age');
  assert.deepEqual([...log.staleRuns()], [runId]);
});

test('a change BEFORE the run does not mark it — that is just its input', () => {
  const { log, run, recode } = setup();
  recode('age');
  run('Frequencies', ['age']);
  assert.deepEqual([...log.staleRuns()], []);
});

test('a re-import marks every run against that dataset', () => {
  // A source op replaces the whole dataset, but its address is a SIBLING of the variables
  // rather than an ancestor — so it has to be declared an aggregate write, exactly as
  // staleReaders documents. Without that a destructive re-import would mark nothing.
  const { log, projectLog, run } = setup();
  const a = run('Frequencies', ['age']);
  const b = run('Crosstab', ['income']);
  projectLog.append({
    target: 'ds:1/source:tok2', owner: 'core', type: 'load',
    payload: { src: { label: 'wave3.sav', meta: [] } },
  });
  assert.deepEqual([...log.staleRuns()].sort(), [a, b].sort());
});

test('a MOVED analysis is not permanently stale', () => {
  // A reposition appends a fresh `runAnalysis` for the same runId. The superseded op is
  // older than everything, so counting it would report every analysis ever moved as stale
  // for the rest of the project's life.
  const { log, run, recode } = setup();
  const runId = run('Frequencies', ['age']);
  recode('age');
  assert.deepEqual([...log.staleRuns()], [runId]);
  log.reposition(runId, 1); // re-run at a new position: a newer op, after the recode
  assert.deepEqual([...log.staleRuns()], [], 'brought up to date');
});

test('an undone run is not reported — it is not showing any numbers', () => {
  const { log, projectLog, run, recode } = setup();
  const runId = run('Frequencies', ['age']);
  recode('age');
  assert.deepEqual([...log.staleRuns()], [runId]);
  log.withdraw(runId);
  assert.deepEqual([...log.staleRuns()], []);
});

test('a run with no known dataset declares nothing rather than guessing', () => {
  // Recorded before `datasetId` was tracked. Under-reporting staleness is the safer
  // direction for a mark shown to a user.
  const projectLog = new ProjectLog();
  const log = new AnalysisLog(null, projectLog);
  log.record({ pluginId: 'p', run: 'go', label: 'Old', specs: SPECS, inputs: { vars: ['age'] }, at: 0 });
  const op = projectLog.slice(() => true).at(-1);
  assert.deepEqual(op.reads, []);
  assert.deepEqual([...log.staleRuns()], []);
});
