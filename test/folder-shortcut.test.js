import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openFolderUrl,
  htmlShortcut,
  readmeText,
  shortcutFiles,
  SHORTCUT_HTML,
  SHORTCUT_README,
} from '../core/folder-shortcut.js';

// These lock the contract of the folder "double-click to open" file (#143). We use a
// single .html redirect rather than .url/.webloc because the File System Access API
// blocks those extensions (they left an orphan .url.tmp).

test('openFolderUrl joins origin+path and appends the deep-link flag', () => {
  assert.equal(
    openFolderUrl('https://crosstab-stats.github.io', '/crosstab/'),
    'https://crosstab-stats.github.io/crosstab/?launch=open-folder',
  );
  assert.equal(openFolderUrl('http://localhost:8080', '/'), 'http://localhost:8080/?launch=open-folder');
  assert.equal(openFolderUrl('http://localhost:8080', '/app'), 'http://localhost:8080/app?launch=open-folder');
});

test('htmlShortcut redirects to the url and offers a clickable fallback', () => {
  const s = htmlShortcut('http://x/?launch=open-folder');
  assert.match(s, /^<!doctype html>/i);
  assert.match(s, /<meta http-equiv="refresh" content="0; url=http:\/\/x\/\?launch=open-folder">/);
  assert.match(s, /<a href="http:\/\/x\/\?launch=open-folder">/);
});

test('htmlShortcut escapes the url in attributes (no raw & or quotes)', () => {
  const s = htmlShortcut('http://x/?a=1&b="two"');
  assert.match(s, /a=1&amp;b=&quot;two&quot;/);
  assert.doesNotMatch(s, /b="two"/); // the raw quotes must have been escaped
});

test('uses a non-blocklisted extension (.html), never .url/.webloc', () => {
  assert.equal(SHORTCUT_HTML, 'Open in CrossTab.html');
  const files = shortcutFiles('Proj', 'http://x', '/');
  const names = files.map((f) => f.name);
  assert.deepEqual(names, [SHORTCUT_HTML, SHORTCUT_README]);
  for (const n of names) assert.doesNotMatch(n, /\.(url|webloc|desktop)$/i);
});

test('readme mentions the project, the html file, and the passphrase caveat', () => {
  const r = readmeText('My study', 'http://x/?launch=open-folder');
  assert.match(r, /My study/);
  assert.match(r, /Open in CrossTab\.html/);
  assert.match(r, /passphrase/i);
});

test('no dropped file carries a secret — only the public app URL', () => {
  for (const f of shortcutFiles('Proj', 'http://x', '/')) {
    assert.doesNotMatch(f.text, /passphrase\s*[:=]/i, 'must not embed a passphrase value');
    assert.doesNotMatch(f.text, /\bsecret\b|\bkey=/i);
  }
});
