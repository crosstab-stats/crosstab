/**
 * @file build-stamp.js
 * Which build of the app this device is actually running.
 *
 * Extracted from `launcher.js` when the Help menu's bug report needed the same answer
 * (#175). There is no build number to maintain: GitHub Pages re-stamps every file's
 * `Last-Modified` on each deploy, so the header IS the version, and comparing two of
 * them is comparing two deploys.
 *
 * The distinction between the two reads is the whole reason this is not one function:
 *
 *  - {@link runningBuildStamp} is a GET, so it goes **through** the service worker, and
 *    on an installed PWA (shell served cache-first) it returns the CACHED build — which
 *    is the code actually executing. It is captured once per page load and memoised,
 *    because the SW revalidates in the background: a later read could return a newer
 *    deploy the revalidate has since written into the cache, while the code running is
 *    still whatever booted.
 *  - {@link latestBuildTime} is a HEAD, which skips that cache-first path (it gates on
 *    GET) and is never stored by the Cache API, so it reads the live deploy straight
 *    from the network without disturbing the cache.
 *
 * Get those backwards and the update strip cheerfully reports you are up to date while
 * running last week's code, which is also exactly the wrong thing to put in a bug report.
 */

/** The Last-Modified of the app code this device loaded. Best-effort: null if
 * unavailable (offline, or a server that sends no such header). */
export async function loadedBuildTime() {
  try {
    const res = await fetch('core/app.js', { cache: 'no-store' });
    return res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

/** A Last-Modified header rendered for a human, or null if unparseable. */
export function formatBuildTime(lm) {
  if (!lm) return null;
  const d = new Date(lm);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** @type {Promise<string|null>|null} */
let runningStampP = null;

/** The RUNNING build's stamp, captured ONCE per page load and memoised. See the file
 * comment for why once matters on an installed PWA. */
export function runningBuildStamp() {
  if (!runningStampP) runningStampP = loadedBuildTime();
  return runningStampP;
}

/** The server's LATEST build stamp — a HEAD, so it bypasses the SW's cache-first shell
 * path and reads the live deploy. null on error/offline. */
export async function latestBuildTime() {
  try {
    const res = await fetch('core/app.js', { method: 'HEAD', cache: 'no-store' });
    return res.headers.get('last-modified') || null;
  } catch {
    return null;
  }
}

/** A Last-Modified header → epoch ms, or null if unparseable. */
export function stampMs(lm) {
  const t = lm ? new Date(lm).getTime() : NaN;
  return Number.isNaN(t) ? null : t;
}
