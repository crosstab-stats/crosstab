#!/usr/bin/env node
/**
 * @file scripts/dev-server.mjs
 * Minimal static dev server for running CrossTab locally — the one contributors
 * (and our own testing) should use, in place of `python -m http.server`.
 *
 * Two things a plain static server gets wrong for this app:
 *
 *  1. **Cross-origin isolation.** CrossTab's fast paths (WebR + DuckDB threaded
 *     WASM) need `SharedArrayBuffer`, which the browser only grants to a
 *     cross-origin-isolated page. That requires COOP `same-origin` + COEP on
 *     every response. The deployed site gets these from `sw.js` (GitHub Pages
 *     sends no headers), but relying on the service-worker reload dance in dev is
 *     flakier than just sending real headers — so this server sends them directly.
 *     COEP is `credentialless` (Chrome-friendly, lenient toward the WebR CDN);
 *     CORP is `cross-origin` so same-origin subresources load under COEP.
 *
 *  2. **Correct MIME types.** Python's `http.server` serves `.js`/`.mjs` with a
 *     non-JavaScript content type on Windows, so the browser refuses to load them
 *     as ES modules and the app never boots. This maps the extensions the app
 *     actually ships explicitly.
 *
 * `Cache-Control: no-store` so edits show on a plain reload. Static files only —
 * no build step, no dependencies (Node's built-in `http`/`fs`).
 *
 * Usage:  node scripts/dev-server.mjs [port]      (default port 8080)
 *         npm run dev
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url))); // repo root (scripts/..)
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;

/** Extension → Content-Type. Covers what CrossTab ships; unknowns fall back to
 *  application/octet-stream. `.mjs`/`.js` MUST be a JS type or ES modules fail. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wat': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Headers that make the page cross-origin-isolated (SharedArrayBuffer). */
function setIsolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

const server = createServer(async (req, res) => {
  try {
    // Path from the URL, minus query/hash; default to index.html.
    let pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve within ROOT and reject any traversal that escapes it.
    const filePath = normalize(join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let info;
    try {
      info = await stat(filePath);
    } catch {
      setIsolationHeaders(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    if (info.isDirectory()) {
      // Redirect a bare directory to its trailing-slash form so relative URLs resolve.
      res.writeHead(301, { Location: pathname + '/' }).end();
      return;
    }

    const body = await readFile(filePath);
    setIsolationHeaders(res);
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.writeHead(200).end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`500 ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`CrossTab dev server → http://localhost:${PORT}/`);
  console.log(`  serving ${ROOT}`);
  console.log('  cross-origin isolated (COOP same-origin + COEP credentialless), no-store');
});
