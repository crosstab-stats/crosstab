/**
 * @file folder-shortcut.js
 * Builds the tiny OS-facing "double-click to open this project" shortcut files we
 * drop into a folder-backed project (#143), so a recipient who receives the folder
 * over OneDrive/Dropbox can launch CrossTab straight from the shared folder instead
 * of having to know the app URL and hunt through the File menu.
 *
 * IMPORTANT — what a shortcut can and cannot do. A `.url`/`.webloc` only opens the
 * app URL in the recipient's browser. It CANNOT auto-load the folder: the File
 * System Access API forbids a web page from opening a folder by path, and a URL
 * can't carry one. So the shortcuts deep-link to `?launch=open-folder`, which lands
 * the recipient on a focused "Open shared folder" button — one click to fire the
 * directory picker (a real user gesture, which the browser requires), then the
 * passphrase. The pick itself is the one step the browser will not let us remove.
 *
 * These files are PLAINTEXT on disk (the OS reads them, CrossTab never does) and
 * carry only the public app URL — never the passphrase or a live-collab secret.
 */

/** Files we manage in the folder. Names are stable so re-saving is idempotent. */
export const SHORTCUT_URL = 'Open in CrossTab.url'; // Windows Internet Shortcut
export const SHORTCUT_WEBLOC = 'Open in CrossTab.webloc'; // macOS Finder shortcut
export const SHORTCUT_README = 'HOW TO OPEN.txt';

/** The deep link a shortcut points at: the app's own origin+path + the open-folder
 * landing flag. Derived from where the app is actually served, so it's correct in
 * dev (localhost), on GitHub Pages, or on any institution's own host. */
export function openFolderUrl(origin, pathname) {
  const base = `${origin}${pathname || '/'}`.replace(/\/+$/, '/');
  return `${base}?launch=open-folder`;
}

/** Windows `.url` (INI-style). CRLF line endings, as Explorer expects. */
export function urlShortcut(url) {
  return ['[InternetShortcut]', `URL=${url}`, ''].join('\r\n');
}

/** macOS `.webloc` (an XML plist Finder opens in the default browser). */
export function weblocShortcut(url) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>URL</key>',
    `\t<string>${url}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** A short plaintext note, since a bare shortcut can't explain the passphrase step. */
export function readmeText(projectName, url) {
  return [
    `This folder is a CrossTab project: "${projectName}".`,
    '',
    'To open it:',
    '  • Windows — double-click "Open in CrossTab.url"',
    '  • Mac     — double-click "Open in CrossTab.webloc"',
    '  (or open CrossTab yourself and choose File ▸ Open from a folder…)',
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
 * The full set of shortcut files to drop into a folder project.
 * @param {string} projectName  display name (for the readme)
 * @param {string} origin       e.g. location.origin
 * @param {string} pathname     e.g. location.pathname
 * @returns {Array<{name: string, text: string}>}
 */
export function shortcutFiles(projectName, origin, pathname) {
  const url = openFolderUrl(origin, pathname);
  return [
    { name: SHORTCUT_URL, text: urlShortcut(url) },
    { name: SHORTCUT_WEBLOC, text: weblocShortcut(url) },
    { name: SHORTCUT_README, text: readmeText(projectName, url) },
  ];
}
