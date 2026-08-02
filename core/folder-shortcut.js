/**
 * @file folder-shortcut.js
 * Builds the tiny OS-facing "double-click to open this project" file we drop into a
 * folder-backed project (#143), so a recipient who receives the folder over
 * OneDrive/Dropbox can launch CrossTab straight from the shared folder instead of
 * having to know the app URL and hunt through the File menu.
 *
 * WHY AN .html FILE (not a .url/.webloc shortcut). We originally wrote a Windows
 * `.url` and a Mac `.webloc`, but the File System Access API **refuses to write those
 * extensions** — they're on the browser's dangerous-file blocklist — so the write
 * threw and left an orphan `.url.tmp`. A plain **`.html` redirect** is not
 * blocklisted, is ONE file, and works everywhere: double-clicking an `.html` opens
 * the OS default browser, and a `<meta refresh>` (with a clickable fallback link)
 * bounces to the app URL. Same end result, cross-platform, no blocked extension.
 *
 * IMPORTANT — what this can and cannot do. It only opens the app URL in the
 * recipient's browser. It CANNOT auto-load the folder: the File System Access API
 * forbids a web page from opening a folder by path, and a URL can't carry one. So it
 * deep-links to `?launch=open-folder`, which lands the recipient on a focused "Open
 * shared folder" button — one click to fire the directory picker (the gesture the
 * browser requires), then the passphrase. The pick is the one step we can't remove.
 *
 * The files are PLAINTEXT on disk (the OS reads them, CrossTab never does) and carry
 * only the public app URL — never the passphrase or a live-collab secret.
 */

/** Files we manage in the folder. Names are stable so re-saving is idempotent. */
export const SHORTCUT_HTML = 'Open in CrossTab.html'; // double-click → browser → app
export const SHORTCUT_README = 'HOW TO OPEN.txt';

/** The deep link the shortcut points at: the app's own origin+path + the open-folder
 * landing flag. Derived from where the app is actually served, so it's correct in
 * dev (localhost), on GitHub Pages, or on any institution's own host. */
export function openFolderUrl(origin, pathname) {
  const base = `${origin}${pathname || '/'}`.replace(/\/+$/, '/');
  return `${base}?launch=open-folder`;
}

/** Escape a string for safe use inside a double-quoted HTML attribute / text node. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A self-contained HTML redirect. Double-clicking opens the default browser, which
 * meta-refreshes to the app (with a visible fallback link if refresh is blocked). */
export function htmlShortcut(url) {
  const u = esc(url);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0; url=${u}">`,
    '<title>Open in CrossTab</title>',
    '</head>',
    '<body style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">',
    '<h1>Opening CrossTab…</h1>',
    `<p>If nothing happens, <a href="${u}">click here to open this project</a>.</p>`,
    '<p style="color:#666">You\'ll be asked to pick this folder and enter its passphrase.</p>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A short plaintext note, since the shortcut alone can't explain the passphrase step. */
export function readmeText(projectName, url) {
  return [
    `This folder is a CrossTab project: "${projectName}".`,
    '',
    'To open it:',
    '  • Double-click "Open in CrossTab.html" (opens in your web browser).',
    '  • Or open CrossTab yourself and choose File ▸ Open from a folder…',
    '',
    'Then click "Open shared folder", pick THIS folder, and enter the',
    'passphrase. The passphrase is not stored here — ask whoever shared the',
    'folder for it.',
    '',
    `App: ${url}`,
    '',
  ].join('\n');
}

/**
 * The full set of files to drop into a folder project.
 * @param {string} projectName  display name (for the readme)
 * @param {string} origin       e.g. location.origin
 * @param {string} pathname     e.g. location.pathname
 * @returns {Array<{name: string, text: string}>}
 */
export function shortcutFiles(projectName, origin, pathname) {
  const url = openFolderUrl(origin, pathname);
  return [
    { name: SHORTCUT_HTML, text: htmlShortcut(url) },
    { name: SHORTCUT_README, text: readmeText(projectName, url) },
  ];
}
