import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openFolderUrl,
  urlShortcut,
  weblocShortcut,
  readmeText,
  shortcutFiles,
  SHORTCUT_URL,
  SHORTCUT_WEBLOC,
  SHORTCUT_README,
} from '../core/folder-shortcut.js';

test('openFolderUrl joins origin+path and appends the deep-link flag', () => {
  assert.equal(
    openFolderUrl('https://crosstab-stats.github.io', '/crosstab/'),
    'https://crosstab-stats.github.io/crosstab/?launch=open-folder',
  );
  // trailing-slash normalisation (no double slash, always one before the query)
  assert.equal(openFolderUrl('http://localhost:8080', '/'), 'http://localhost:8080/?launch=open-folder');
  assert.equal(openFolderUrl('http://localhost:8080', '/app'), 'http://localhost:8080/app?launch=open-folder');
});

test('urlShortcut is a CRLF Windows Internet Shortcut carrying the URL', () => {
  const s = urlShortcut('http://x/?launch=open-folder');
  assert.match(s, /^\[InternetShortcut\]\r\nURL=http:\/\/x\/\?launch=open-folder\r\n$/);
});

test('weblocShortcut is a plist with the URL', () => {
  const s = weblocShortcut('http://x/?launch=open-folder');
  assert.match(s, /<plist version="1\.0">/);
  assert.match(s, /<key>URL<\/key>/);
  assert.match(s, /<string>http:\/\/x\/\?launch=open-folder<\/string>/);
});

test('readme mentions the project, both shortcuts, and the passphrase caveat', () => {
  const r = readmeText('My study', 'http://x/?launch=open-folder');
  assert.match(r, /My study/);
  assert.match(r, /Open in CrossTab\.url/);
  assert.match(r, /Open in CrossTab\.webloc/);
  assert.match(r, /passphrase/i);
});

test('shortcutFiles bundles the three named files, none carrying a secret', () => {
  const files = shortcutFiles('Proj', 'http://x', '/');
  assert.deepEqual(files.map((f) => f.name), [SHORTCUT_URL, SHORTCUT_WEBLOC, SHORTCUT_README]);
  // The shortcut only ever contains the public app URL — never a passphrase/secret.
  for (const f of files) {
    assert.doesNotMatch(f.text, /passphrase\s*[:=]/i, 'must not embed a passphrase value');
    assert.doesNotMatch(f.text, /\bsecret\b|\bkey=/i);
  }
});
