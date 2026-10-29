/**
 * @file pick-file.js
 * One native file picker, for every caller that needs one.
 *
 * ## Why this file exists
 *
 * There were five of these: `pickFile` in plugin-actions, `verbPickFile` in
 * workspace-manager (byte-identical to it), `pickFiles` in import-service, another
 * `pickFile` in plugin-manager, and `UiService#pickFile` — two names and three argument
 * conventions for the same fifteen lines.
 *
 * That alone is tidying. The reason it is a FIX is that the five had quietly diverged on
 * the thing that matters:
 *
 * A file input resolves the happy path through its `change` event, and a cancelled
 * dialog through `cancel`. But `cancel` only arrived in Safari 16.4, and four of the
 * five relied on it alone — their comments said a missing `cancel` was "harmless
 * where unsupported — change still resolves the happy path", which is true of the happy
 * path and false of the other one. On an older iPad the promise simply never settled:
 * cancel an import, a plugin install or a workspace verb's file prompt and the flow
 * stops, with no error and a busy flag still set.
 *
 * `UiService#pickFile` already knew this and carried a focus fallback. Folding the five
 * together is how that knowledge reaches the other four.
 *
 * ## The fallback, and why it is timed
 *
 * The window regains focus both when the dialog is dismissed AND after a successful
 * pick, so the fallback waits long enough for `change` to land first. Every path goes
 * through one `settled` latch, so a double fire cannot resolve twice — which is what
 * makes it safe to arm all three.
 *
 * ## Why it then WAITS instead of answering
 *
 * The first version read the input once, 400 ms after the refocus, and treated an empty
 * one as a dismissal. On an iPhone that silently threw away real picks: importing a
 * 40 MB WAV did nothing at all — no dataset, no error, not even the "how should I
 * combine this" dialog — because iOS returns focus when the picker sheet dismisses,
 * which for a large file out of Files/iCloud is well before `input.files` is populated.
 * The empty read won, the latch closed, and the `change` that arrived a moment later was
 * ignored. `import-service` reads no files as "the user cancelled" and returns without a
 * word, so there was nothing on screen to even suggest a failure.
 *
 * So an empty input on refocus is treated as what it actually is — AMBIGUOUS — and the
 * fallback keeps looking until either the file turns up or it has waited long enough to
 * be sure. Nothing is waiting on the slow path: a genuine cancellation resolves instantly
 * through the `cancel` event on every browser that has one, and on the ones that do not,
 * "the user cancelled" resolving a few seconds later is invisible, because the answer is
 * to do nothing either way.
 *
 * Feature-detecting `cancel` and skipping the fallback would be the obvious shortcut and
 * it is not safe: `oncancel` is a GlobalEventHandlers property that exists for `<dialog>`
 * on browsers whose file inputs never fire it, so the detection would claim support on
 * exactly the old Safari this fallback is for and bring the original hang back.
 */

/** How long to let `change` arrive before a refocus is worth investigating. */
const REFOCUS_GRACE_MS = 400;

/**
 * How long to keep watching an empty input after a refocus before calling it a
 * dismissal. Generous on purpose: the cost of waiting too long is nothing (a cancel
 * does nothing, slowly), and the cost of giving up too early is a silently discarded
 * import of a file the user did choose.
 */
const SLOW_CHANGE_MS = 8000;

/** How often to re-read the input while waiting for a slow `change`. */
const POLL_MS = 150;

/**
 * Open a native file picker and resolve with what the user chose.
 *
 * Must be called synchronously from a user gesture (a click handler), or the browser
 * will refuse to open the dialog — and then nothing settles this promise, because
 * nothing ever happens.
 *
 * ## Two shapes, and the trap between them
 *
 * `pickFile` resolves a `File` (or null); `pickFiles` resolves an ARRAY, always —
 * including when `multiple` is false, because `multiple` chooses what the DIALOG allows,
 * not what the caller gets back. Conflating the two is not hypothetical: folding these
 * together, the first version let `multiple: false` change the return shape, which turned
 * `pickFiles(['.enc'], false)` into a File. Both of import-service's call sites test
 * `files.length`, so encrypted import would have silently done nothing on every run.
 *
 * @param {object} [opts]
 * @param {string|string[]} [opts.accept] an `accept` string, or extensions to join into
 *   one (`['.csv', '.tsv']`).
 * @param {boolean} [opts.multiple=false] allow the DIALOG to take several files. Does
 *   not change what this function returns — use {@link pickFiles} for the array shape.
 * @param {string} [opts.hint] a `title` for the input.
 * @param {Document} [opts.doc] injectable for tests.
 * @param {Window} [opts.win] injectable for tests.
 * @param {number} [opts.patienceMs] how long to wait for a slow `change` after a
 *   refocus; injectable so tests need not sit through the real one.
 * @returns {Promise<File|null>} null if cancelled.
 */
export function pickFile(opts = {}) {
  return pickAll(opts).then((files) => files[0] ?? null);
}

/**
 * The array shape: every file chosen, `[]` if cancelled.
 *
 * @param {string|string[]} accept
 * @param {boolean} [multiple=true] what the dialog allows — the return shape is an array
 *   either way.
 * @returns {Promise<File[]>}
 */
export function pickFiles(accept, multiple = true, opts = {}) {
  return pickAll({ ...opts, accept, multiple });
}

/** The shared machinery. Always resolves an array; the exports shape it. */
function pickAll({
  accept = '', multiple = false, hint = '',
  doc = globalThis.document, win = globalThis, patienceMs = SLOW_CHANGE_MS,
} = {}) {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    const acceptStr = Array.isArray(accept) ? accept.join(',') : accept;
    if (acceptStr) input.accept = acceptStr;
    if (multiple) input.multiple = true;
    if (hint) input.title = hint;
    input.style.display = 'none';

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    const chosen = () => [...(input.files ?? [])];

    input.addEventListener('change', () => finish(chosen()));
    input.addEventListener('cancel', () => finish([]));
    // The fallback for browsers with no `cancel` event (Safari before 16.4). Reads the
    // input rather than assuming a dismissal, so if `change` is merely slow this still
    // returns the file the user picked.
    win.addEventListener(
      'focus',
      () => setTimeout(() => {
        if (settled) return;
        const picked = chosen();
        // A file is already there: the refocus followed a successful pick.
        if (picked.length) { finish(picked); return; }
        // Empty is ambiguous — either a dismissal, or a `change` still on its way for a
        // file big enough that iOS has not finished handing it over. Keep looking.
        const deadline = Date.now() + patienceMs;
        const poll = setInterval(() => {
          if (settled) { clearInterval(poll); return; }
          const late = chosen();
          if (late.length) { clearInterval(poll); finish(late); return; }
          if (Date.now() >= deadline) { clearInterval(poll); finish([]); }
        }, POLL_MS);
      }, REFOCUS_GRACE_MS),
      { once: true },
    );

    doc.body.append(input);
    input.click();
  });
}
