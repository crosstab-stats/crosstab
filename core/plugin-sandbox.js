/**
 * @file plugin-sandbox.js
 * One source of truth for the plugin sandbox document and its per-capability CSP.
 *
 * Every plugin iframe — the loader's hidden *compute* frame AND the workspace
 * manager's visible *workspace* frame — loads the SAME runtime, `plugin-host.html`,
 * from a **blob: URL**. blob: (not the host URL directly) because a sandboxed
 * opaque-origin iframe's navigation to a same-origin URL is not controlled by the
 * service worker (so `src=./plugin-host.html` would fail offline once the SW controls
 * the page), and because under cross-origin isolation the isolated parent requires
 * COEP/CORP on embedded frames that the raw document can't send — a blob: is
 * COEP-compatible while `sandbox="allow-scripts"` still forces an opaque origin +
 * isolated heap (#92/#91).
 *
 * The ONLY thing that varies between plugins is the Content-Security-Policy, by
 * capability:
 *   - `strict` — the default cage: no network, no WASM, no media.
 *   - `codec`  — + WASM compile + an in-sandbox worker (#98). *Compute, not reach.*
 *   - `media`  — + `media-src`/`img-src blob:` so a coding workspace can render
 *                host-provided media (#139). **blob: only** — never a remote scheme,
 *                which would reopen the `connect-src 'none'` "no phone-home" hole.
 *
 * The runtime body lives in exactly one file; this module swaps the CSP `<meta>`
 * content, so a plugin gets exactly the capability its manifest declares (least
 * privilege — a plain analysis plugin never gains WASM or media) and a *future*
 * capability is one row in {@link HOST_CSP}, not a whole copied sandbox document.
 */

/** The runtime document, resolved relative to /core (works from any page path). */
const HOST_URL = new URL('../plugin-host.html', import.meta.url).href;

/** The strict CSP exactly as written in plugin-host.html's `<meta>` — the string a
 * wider capability replaces. Keep this === the file's content attribute. A drift
 * fails **closed**: `replace` no-ops, the plugin runs under whatever the file says
 * (strict), and media/WASM simply don't work — never a silent *widening*. */
const STRICT_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'";

/** capability → the CSP that replaces {@link STRICT_CSP} in the template. */
export const HOST_CSP = Object.freeze({
  strict: STRICT_CSP,
  codec: "default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'",
  media: "default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'; media-src blob:; img-src blob:",
});

let templatePromise = null;

/**
 * A fresh blob: URL of the sandbox document for the given capability. The template
 * HTML is fetched once (through the SW, so it's cached and offline-safe) and reused;
 * each call returns a NEW object URL, revoked shortly after (the iframe loads it in
 * milliseconds).
 *
 * @param {'strict'|'codec'|'media'} [capability]
 * @returns {Promise<string>}
 */
export async function sandboxBlobUrl(capability = 'strict') {
  const csp = HOST_CSP[capability] || HOST_CSP.strict;
  if (!templatePromise) {
    templatePromise = fetch(HOST_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`plugin sandbox ${HOST_URL}: HTTP ${res.status}`);
        return res.text();
      })
      .catch((err) => {
        templatePromise = null; // don't cache a failure — allow retry
        throw err;
      });
  }
  const template = await templatePromise;
  // `replace(string, string)` swaps only the FIRST literal occurrence (the meta
  // content); the CSP strings contain no `$`, so no replacement-pattern surprises.
  const html = csp === STRICT_CSP ? template : template.replace(STRICT_CSP, csp);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return url;
}
