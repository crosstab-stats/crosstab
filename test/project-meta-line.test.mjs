/**
 * @file project-meta-line.test.mjs
 * What a project row says about itself in a list.
 *
 * ## The problem it solves
 *
 * The sidebar's Recent projects list rendered the name and nothing else, so five projects
 * nobody had bothered to name read as five identical rows. The obvious fix — show the
 * dataset count, which `listAllProjects()` already carried — does not actually work, and
 * the owner said why (2026-10-10):
 *
 *   *"that kind of user is probably also doing small projects where they all have exactly
 *   one dataset, 5 'untitled project' in a row isn't much different from five 'untitled
 *   project - 1 dataset' in a row."*
 *
 * A discriminator has to VARY across the things it discriminates. Date and row count do;
 * dataset count mostly does not. So the line is "when you last worked on it, and how big
 * it is" — *5 Oct 2026 · 1 dataset, 5,456 rows*.
 *
 * ## Why "worked on" and not "opened"
 *
 * Also the owner's call, and it corrected mine. I had argued for `lastOpenedAt` on the
 * grounds that a list should show the key it is sorted by. The objection:
 *
 *   *"if a person accidentally clicks the wrong project (touch targets can be easily
 *   fat-fingered) that will suddenly change the metadata being displayed… people might
 *   think 'the one I was working on last week' rather than 'the one I quickly glanced at
 *   last week'."*
 *
 * Which is right, and worse than stated: the list was SORTED by `lastOpenedAt` too, so a
 * mis-tap also promoted that project to the top and pushed a real one down. Both the sort
 * and the label moved to `savedAt`. `lastOpenedAt` is still recorded — it cannot be
 * backfilled, and a recently-opened sort is a plausible future option.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { projectMetaLine } from '../core/project-sync.js';

const DAY = 86400000;
const NOW = 1760000000000; // fixed, so "3 days ago" is not a function of when tests run
const line = (entry, opts = {}) => projectMetaLine(entry, { now: NOW, ...opts });

// =============================================================================
// The whole line
// =============================================================================

test('the ordinary row: when, and how big', () => {
  const got = line({ savedAt: NOW - 3 * DAY, datasetCount: 1, rowCount: 5456 });
  assert.equal(got, '3 days ago · 1 dataset, 5,456 rows');
});

test('rows are grouped, because 5456 does not read at a glance and 5,456 does', () => {
  assert.match(line({ savedAt: NOW, rowCount: 1234567 }), /1,234,567 rows/);
});

test('both counts are singular when they are one', () => {
  assert.equal(line({ savedAt: NOW, datasetCount: 1, rowCount: 1 }), 'just now · 1 dataset, 1 row');
  assert.equal(line({ savedAt: NOW, datasetCount: 2, rowCount: 2 }), 'just now · 2 datasets, 2 rows');
});

// =============================================================================
// What it omits — the part that keeps it honest
// =============================================================================

test('a project saved before row counts existed says less, not something false', () => {
  // The field is simply absent on older catalog entries. "0 rows" would be a claim about
  // the data; dropping it is a claim about nothing.
  assert.equal(line({ savedAt: NOW - DAY, datasetCount: 1 }), '1 day ago · 1 dataset');
  assert.doesNotMatch(line({ savedAt: NOW, datasetCount: 1 }), /row/);
});

test('an empty project does not claim 0 rows either', () => {
  assert.equal(line({ savedAt: NOW, datasetCount: 1, rowCount: 0 }), 'just now · 1 dataset');
});

test('nulls are not numbers — a remembered location never written is just a date', () => {
  // listAllProjects fills these with null rather than 0 when it does not know.
  assert.equal(line({ savedAt: NOW, datasetCount: null, rowCount: null }), 'just now');
});

test('no date and no counts is an empty line, not a line of separators', () => {
  assert.equal(line({}), '');
  assert.equal(line(undefined), '');
  assert.equal(line({ savedAt: 0, datasetCount: null }), '');
});

test('size without a date still renders', () => {
  assert.equal(line({ datasetCount: 2, rowCount: 10 }), '2 datasets, 10 rows');
});

// =============================================================================
// The date
// =============================================================================

test('relative while that is the more useful answer', () => {
  assert.equal(line({ savedAt: NOW }), 'just now');
  assert.equal(line({ savedAt: NOW - 30 * 60000 }), '30 mins ago');
  assert.equal(line({ savedAt: NOW - 60 * 60000 }), '1 hour ago');
  assert.equal(line({ savedAt: NOW - 5 * 3600000 }), '5 hours ago');
  assert.equal(line({ savedAt: NOW - DAY }), '1 day ago');
  assert.equal(line({ savedAt: NOW - 6 * DAY }), '6 days ago');
});

test('and absolute once it stops being — a week is the hinge', () => {
  const old = line({ savedAt: NOW - 7 * DAY });
  assert.doesNotMatch(old, /ago/, 'past a week, "8 days ago" is harder to place than a date');
  assert.match(old, /\d{4}/, 'and it carries the year, since projects outlive one');
});

test('a timestamp from the future does not read as negative time', () => {
  // Clock skew between devices is ordinary, and "in -3 days" is the kind of thing that
  // makes people distrust everything else on the row.
  const future = line({ savedAt: NOW + 5 * DAY });
  assert.doesNotMatch(future, /ago/);
  assert.match(future, /\d{4}/);
});

test('the roomy surface gets the full timestamp instead', () => {
  // The Open-project modal has width the sidebar does not, and a precise time is more
  // useful when you are deliberately comparing versions.
  const got = line({ savedAt: NOW - 3 * DAY, datasetCount: 1 }, { absoluteDate: true });
  assert.doesNotMatch(got, /days ago/);
  assert.match(got, /1 dataset$/);
});

// =============================================================================
// Both surfaces use this one function
// =============================================================================

test('the Open-project modal no longer interpolates a possibly-null count', () => {
  // It used to build `${entry.datasetCount} dataset…` directly, which would have read
  // "null datasets" the first time it was handed a remembered location.
  const src = readFileSync('core/project-sync.js', 'utf8');
  assert.match(src, /meta\.textContent = projectMetaLine\(entry, \{ absoluteDate: true \}\)/);
  assert.doesNotMatch(src, /\$\{entry\.datasetCount\} dataset/);
});

test('the sidebar uses it too, so one project cannot describe itself two ways', () => {
  const src = readFileSync('core/app.js', 'utf8');
  assert.match(src, /projectMetaLine\(p\)/);
  assert.match(src, /import \{ ProjectSync, PROJECT_CHANGED, projectMetaLine \}/);
});
