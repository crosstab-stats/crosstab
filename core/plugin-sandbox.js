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
 *
 * ## Measured properties of this cage (#154)
 *
 * Verified in Chrome against the running app, because the lifecycle design depends on
 * them and assuming would have produced the wrong architecture:
 *
 *  - The frames are genuinely **opaque-origin**: the host gets `SecurityError` touching
 *    `contentWindow.location`.
 *  - They run **out of process**. A guest burning 2 500 ms of CPU left the host ticking
 *    with a 109 ms maximum gap — so a plugin that takes minutes, or hours, does not block
 *    the host UI. Isolation and off-main-thread execution come from the same choice.
 *  - A **Worker cannot be created inside the cage**: an opaque origin's
 *    `createObjectURL` yields `blob:null/…`, which is not fetchable, so `new Worker()`
 *    constructs and then fails to load. `worker-src blob:` does not change this — the URL
 *    is the blocker, not the policy. (The `codec` capability's `worker-src` therefore
 *    only helps a worker created from a URL the sandbox can actually fetch.)
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

/** The sandbox document for a capability, as an HTML string. Fetched once (through the
 * SW, so it's cached and offline-safe) and reused. */
async function sandboxHtml(capability) {
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
  return csp === STRICT_CSP ? template : template.replace(STRICT_CSP, csp);
}

/**
 * Point an iframe at a fresh sandbox document and report what the FRAME does about it
 * (#154 stage 1).
 *
 * ## Why this replaced `sandboxBlobUrl`
 *
 * The old helper returned a URL and revoked it on a **15-second timer**, while the mount
 * handshake allowed 20/40/60 s. So a frame that had not finished loading within 15 s had
 * its source revoked out from under it and could never succeed — and the longer retries
 * were futile, because every attempt died at the same 15 s. A busy boot did not time out;
 * it was aborted. The URL now lives exactly as long as the frame that is loading it.
 *
 * It also returns the frame's own load/error signals. Those are the first two entries in
 * the envelope's failure table: a deadline is not needed to notice that a document failed
 * to load, because the platform says so.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {'strict'|'codec'|'media'} [capability]
 * @returns {Promise<{loaded: Promise<void>, release: () => void}>}
 *   `loaded` settles on the frame's own `load`/`error`; `release` revokes early (dispose).
 */
export async function attachSandbox(iframe, capability = 'strict') {
  const html = await sandboxHtml(capability);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(url);
  };

  const loaded = new Promise((resolve, reject) => {
    const onLoad = () => { cleanup(); release(); resolve(); };
    const onError = () => { cleanup(); release(); reject(new Error('sandbox document failed to load')); };
    const cleanup = () => {
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
    };
    iframe.addEventListener('load', onLoad, { once: true });
    iframe.addEventListener('error', onError, { once: true });
  });

  iframe.src = url;
  return { loaded, release };
}
