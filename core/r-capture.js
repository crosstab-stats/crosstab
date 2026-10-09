/**
 * @file r-capture.js
 * A one-slot sink for the R source the engine actually ran.
 *
 * ## Why this exists
 *
 * Every analysis in CrossTab is, underneath, some R that a plugin wrote and the host
 * fed to WebR along with a prelude binding the data. That R is the *provenance* of
 * every number in the Output pane, and until now it existed only for the microseconds
 * between a plugin composing it and WebR evaluating it. Nothing kept it.
 *
 * The owner's case for keeping it (2026-10-09) is an audit one, and it is the stronger
 * half: a project bundle can be opened by someone who does not have — or does not
 * trust — the plugin that produced a result. Today they see a table and an attribution
 * line and have to take both on faith. With the source recorded they can read the
 * model that was fitted. That is the same principle as "output outlives its maker",
 * applied to how a number was computed rather than to how it is drawn.
 *
 * It also happens to give the R export the other half of what it promised — the exact
 * code beside the idiomatic code — but that is the lesser reason.
 *
 * ## Why a sink rather than a return value
 *
 * The R is composed inside the plugin sandbox and evaluated three layers down
 * ({@link PluginActions} → broker → {@link WebRManager}). Threading it back up as a
 * return value would mean changing the signature of every hop, including the
 * postMessage protocol plugins are written against — a breaking change to the plugin
 * API for a diagnostic. Instead the runner says "collect anything that runs now" and
 * the manager drops what it ran into the open slot.
 *
 * **This assumes R runs are serialized**, which they are: `WebRManager` funnels every
 * evaluation through one queue (`#enqueue`), and the runner awaits each analysis before
 * starting the next. A sink is therefore only ever open for one analysis at a time. The
 * token discipline below keeps that honest: a sink can only be closed by the caller
 * that opened it, so an overlapping open cannot silently steal another's capture.
 */

/** @type {{ fn: (text: string) => void, token: object } | null} */
let open = null;

/**
 * Collect the R that runs until the returned disposer is called.
 *
 * Nesting is not supported and not needed (see the file comment): a second open while
 * one is live replaces it, and the inner disposer restores the outer, so a stray
 * un-disposed sink cannot swallow every later analysis's source.
 *
 * @param {(text: string) => void} fn called once per evaluation, with the source.
 * @returns {() => void} disposer; idempotent, and a no-op if another sink replaced this one.
 */
export function captureInto(fn) {
  const token = {};
  const previous = open;
  open = { fn, token };
  return () => {
    if (open?.token === token) open = previous;
  };
}

/**
 * Offer one evaluation's source to whatever sink is open. Never throws: a failure to
 * record provenance must not fail the analysis that produced it.
 * @param {string} text the R source as evaluated.
 */
export function noteR(text) {
  if (!open || !text) return;
  try {
    open.fn(String(text));
  } catch (err) {
    console.warn('[r-capture] sink threw; dropping this source', err);
  }
}

/** True when someone is collecting — lets a caller skip building the mirror text. */
export function capturing() {
  return open !== null;
}

/**
 * How much R one analysis may contribute to the project log.
 *
 * This is a size policy, not a safety one — nothing breaks without it. But the captured
 * source is PERSISTED (it rides in the `runAnalysis` op payload, so it is saved, merged
 * and synced), and an analysis is free to call `webr.run` in a loop. A bootstrap over a
 * thousand resamples would otherwise write a thousand near-identical copies of the same
 * model into the log. The cap keeps the common case — a handful of evaluations per
 * analysis — complete, and truncates the pathological one while SAYING SO, because a
 * silently shortened audit record is worse than an obviously shortened one.
 */
export const R_CAPTURE_MAX_CHARS = 32000;
/** And a ceiling on the number of evaluations recorded, for the same reason. */
export const R_CAPTURE_MAX_RUNS = 24;

/**
 * Open a sink that accumulates up to the caps above.
 *
 * @returns {{dispose: () => void, take: () => {runs: string[], dropped: number}|null}}
 *   `take()` returns null when nothing ran R at all — which is the common case for a
 *   charting or table plugin, and must not leave an empty field on every such entry.
 */
export function collectR() {
  const runs = [];
  let chars = 0;
  let dropped = 0;
  const dispose = captureInto((text) => {
    if (runs.length >= R_CAPTURE_MAX_RUNS || chars + text.length > R_CAPTURE_MAX_CHARS) {
      dropped += 1;
      return;
    }
    runs.push(text);
    chars += text.length;
  });
  return { dispose, take: () => (runs.length || dropped ? { runs, dropped } : null) };
}
