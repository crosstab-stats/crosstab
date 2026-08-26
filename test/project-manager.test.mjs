/**
 * @file project-manager.test.mjs
 * The rules behind the project manager's rows (#173).
 *
 * Extracted from the render functions on purpose: which verbs apply to a project, what
 * removing one actually offers, and whether a destination is a move or a copy are
 * DECISIONS, and decisions rot quietly when they live inside DOM code. None of these can
 * be checked by looking at the screen — an over-generous action list looks exactly like a
 * correct one until someone clicks it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectActions, removalOffer, storeVerb, TABS } from '../core/project-manager.js';

const row = (over = {}) => ({
  key: 'opfs:p1', name: 'My study', kind: 'opfs', projectId: 'p1',
  locationId: null, savedAt: 1, lastOpenedAt: 2, isOpen: false, entry: null, ...over,
});

test('the open project cannot be opened again, or deleted from under itself', () => {
  // Deleting the project you are looking at would leave the app holding a store whose
  // files have gone — every subsequent autosave failing, with the work still on screen.
  const acts = projectActions(row({ isOpen: true })).map((a) => a.id);
  assert.ok(!acts.includes('open'));
  assert.ok(!acts.includes('forget'));
  assert.deepEqual(acts, ['close', 'rename']);
});

test('a project that is not open offers open, and removal', () => {
  assert.deepEqual(projectActions(row()).map((a) => a.id), ['open', 'rename', 'forget']);
});

test('only a local project can be renamed from the list', () => {
  // A remembered location's name comes from the project inside it. Renaming the ENTRY
  // would give one thing two names, and the visible one would be the lie.
  assert.ok(!projectActions(row({ kind: 'dropbox' })).some((a) => a.id === 'rename'));
  assert.ok(!projectActions(row({ kind: 'folder' })).some((a) => a.id === 'rename'));
  assert.ok(projectActions(row()).some((a) => a.id === 'rename'));
});

test('removal is labelled for what it does — delete locally, remove elsewhere', () => {
  assert.equal(projectActions(row()).find((a) => a.id === 'forget').label, 'Delete…');
  assert.equal(projectActions(row({ kind: 'dropbox' })).find((a) => a.id === 'forget').label, 'Remove…');
});

test('destructive actions are flagged as such', () => {
  assert.equal(projectActions(row()).find((a) => a.id === 'forget').danger, true);
  assert.ok(!projectActions(row()).find((a) => a.id === 'open').danger);
});

test('a local project gets no "also delete files" checkbox', () => {
  // There is no forget-but-keep for local storage — the list IS the storage — so a
  // checkbox would do nothing when left unchecked, implying a choice that does not exist.
  const offer = removalOffer(row());
  assert.equal(offer.fileLabel, null);
  assert.match(offer.body, /deletes it/);
  assert.equal(offer.confirmLabel, 'Delete');
});

test('a remote project gets the checkbox, and it defaults OFF', () => {
  // The owner's call: removing files is always an affirmative act, never something that
  // happens because a default was left alone.
  const offer = removalOffer(row({ kind: 'dropbox' }));
  assert.ok(offer.fileLabel);
  assert.equal(offer.fileDefault, false);
  assert.match(offer.body, /files stay/);
});

test('the store button says move or copy, matching what will happen', () => {
  // The label a menu could never get right: leaving local storage removes the local copy
  // because it is ours; leaving a folder or a cloud location does not, because it is not.
  assert.equal(storeVerb('opfs').label, 'Move here');
  assert.match(storeVerb('opfs').note, /will be removed/);
  for (const kind of ['folder', 'dropbox', 'webdav']) {
    assert.equal(storeVerb(kind).label, 'Copy here', kind);
    assert.match(storeVerb(kind).note, /stays where it is/);
  }
});

test('an unknown current location is treated as local, not as a copy', () => {
  // Before anything is open there is no backend to ask. Guessing "copy" would leave a
  // stray local project behind on the first move of a fresh session.
  assert.equal(storeVerb(null).label, 'Move here');
  assert.equal(storeVerb(undefined).label, 'Move here');
});

test('there is no Save tab', () => {
  // Deliberate, and the reason is in the file header: everything autosaves, so what used
  // to be Save was naming and what used to be Save As was duplicating.
  const ids = TABS.map((t) => t.id);
  assert.ok(!ids.includes('save'));
  assert.deepEqual(ids, ['recents', 'open', 'store', 'manage']);
});
