/**
 * @file encryption-settings.test.mjs
 * What the "This project" tab offers, given the project's encryption state (#181).
 *
 * This used to be three File items that were always all visible, each opening with a
 * guard that reported the state was wrong ("This project is already protected."). The
 * rule is now data, and tested here for the same reason `projectActions` is: an
 * over-generous action list looks exactly like a correct one until someone clicks it —
 * and on this dialog a wrong click means a passphrase prompt for an irreversible,
 * unrecoverable change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEncryptionOffer, ENC_TABS } from '../core/encryption-settings.js';

const ids = (state) => projectEncryptionOffer(state).actions.map((a) => a.id);

test('an unprotected project is offered exactly one verb: set a passphrase', () => {
  assert.deepEqual(ids({ scope: 'local', name: 'My study', protected: false }), ['protect']);
});

test('a protected project is offered change and remove — never protect again', () => {
  // The old menu showed "Protect this project…" here too, and protectProject() existed
  // largely to refuse it. The state now decides, so there is nothing left to refuse.
  assert.deepEqual(ids({ scope: 'local', name: 'My study', protected: true }), ['change', 'remove']);
});

test('removing protection is marked dangerous; setting one is not', () => {
  const protectedOffer = projectEncryptionOffer({ scope: 'local', name: 'x', protected: true });
  assert.equal(protectedOffer.actions.find((a) => a.id === 'remove').danger, true);
  assert.ok(!protectedOffer.actions.find((a) => a.id === 'change').danger);
  const plain = projectEncryptionOffer({ scope: 'local', name: 'x', protected: false });
  assert.ok(!plain.actions.find((a) => a.id === 'protect').danger);
});

test('no project open offers nothing, and says why', () => {
  // #158 made this a real state rather than a faked blank project, so it is shown.
  for (const s of [null, undefined, { scope: 'none' }]) {
    const offer = projectEncryptionOffer(s);
    assert.deepEqual(offer.actions, []);
    assert.match(offer.status, /No project is open/);
  }
});

test('an unsaved project is a DIFFERENT empty state from no project', () => {
  // Merging the two would print "no project is open" at someone looking at their data.
  const offer = projectEncryptionOffer({ scope: 'unsaved' });
  assert.deepEqual(offer.actions, []);
  assert.match(offer.detail, /Add some data first/);
  assert.notEqual(offer.status, projectEncryptionOffer({ scope: 'none' }).status);
});

test('a folder project says the passphrase is shared; a local one says it is not', () => {
  const folder = projectEncryptionOffer({ scope: 'folder', name: 'x', protected: true });
  assert.match(folder.detail, /everyone who opens that folder/i);
  const local = projectEncryptionOffer({ scope: 'local', name: 'x', protected: true });
  assert.match(local.detail, /this device/i);
  // The distinction is load-bearing: removing protection on a folder project unprotects
  // it for every collaborator, which is not true of a local one.
  assert.notEqual(folder.detail, local.detail);
});

test('the project tab comes first, and the tabs are named by scope', () => {
  assert.deepEqual(ENC_TABS.map((t) => t.id), ['project', 'defaults']);
  // "Globals" would not say that the second tab leaves existing projects alone; naming
  // the tabs by what they act ON is what keeps them from reading as interchangeable.
  assert.deepEqual(ENC_TABS.map((t) => t.label), ['This project', 'New projects']);
});
