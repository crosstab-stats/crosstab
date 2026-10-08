/**
 * @file screen-mode.js
 * **Small-screen mode** — a layout the user owns.
 *
 * The app's layout is driven by one state on the root element, `data-screen="small" | "full"`,
 * and this module is the only thing that sets it. Every layout rule keys off that attribute;
 * **no CSS anywhere keys off viewport width.**
 *
 * ## Why it is not a media query
 *
 * The owner's requirement, which is the whole design (2026-10-07):
 *
 *   *"I don't want it to be forced. I hate it when sites detect a small screen and then force
 *   you into their shite 'mobile friendly' design when the real site would work fine. So it
 *   needs to be a toggle the user can turn on and off. And it might be helpful on more than
 *   just phones so maybe call it 'small screen' mode. And it should be fully functional, just
 *   a repositioning/resize of elements."*
 *
 * A CSS `@media (max-width: …)` rule cannot express that: it would keep re-deciding, and the
 * moment someone switched the mode off at 390px the attribute and the query would disagree —
 * rails stacked by one, grids one-columned by the other, and no way back to the full layout.
 * So the viewport is read **once, in JS, as a default** and the attribute is the only source
 * of truth from then on.
 *
 * ## Detect as a DEFAULT, never as an override
 *
 * The preference is **tri-state**: unset / on / off. Unset means "nobody has said", so the
 * viewport supplies the initial value — which is what keeps WCAG 2.2 AA **1.4.10 Reflow**
 * satisfiable, because that criterion is about the *default* presentation at 320px: a
 * first-time visitor on a narrow screen gets a reflowed layout without having to find a
 * setting. The moment the toggle is touched, that choice wins forever — **including `off`
 * while still narrow**, which is exactly the case the owner's objection is about.
 *
 * Evaluated at load only, never on resize. Reflowing the whole app under someone's hands
 * mid-task is the same violence as detecting it in the first place, and the toggle is one
 * menu away.
 */

/** Where the choice lives. Not in the project: it describes this reader on this device, not
 * anything about the data — the same reasoning {@link module:core/var-order} gives. */
const KEY = 'crosstab.screen-mode';

/** Dismissal of the "this was turned on for you" note, so it is said once and not again. */
const NOTE_KEY = 'crosstab.screen-mode.noted';

/**
 * Below this width the FULL layout stops working, so it is where an unset preference
 * defaults to small.
 *
 * Not the 320px of the WCAG criterion: the launcher alone puts 400px of fixed rails beside
 * its plugin list, and the workspace puts a 240px sidebar beside the grid, so the full layout
 * is unusable long before 320. Width only — a landscape phone is short rather than narrow, and
 * inventing a height rule before anyone has hit one would be guessing.
 */
export const SMALL_MAX_PX = 720;

/** @typedef {'small'|'full'} ScreenMode */

/**
 * Resolve the mode from the three things that can have an opinion, in order of authority.
 *
 * Pure, and the whole policy lives here — every rule in this file's header is one case below,
 * which is why it is tested rather than described.
 *
 * @param {object} o
 * @param {?string} [o.stored] the remembered preference: 'small' | 'full' | null (unset)
 * @param {boolean} [o.narrowViewport] whether the viewport is under {@link SMALL_MAX_PX}
 * @param {?string} [o.urlFlag] `?screen=` — 'small' | 'full' | anything else (ignored)
 * @returns {ScreenMode}
 */
export function resolveScreenMode({ stored = null, narrowViewport = false, urlFlag = null } = {}) {
  // The flag wins, because it exists to override everything for a test or an escape hatch.
  // It deliberately does NOT persist (see applyScreenMode) — a URL must not silently rewrite
  // somebody's saved setting.
  if (urlFlag === 'small' || urlFlag === 'full') return urlFlag;
  // An explicit choice wins over the viewport, which is the entire point: `full` at 390px is
  // a user who has seen the small layout and does not want it.
  if (stored === 'small' || stored === 'full') return stored;
  // Nobody has said. The viewport decides, so the default presentation reflows.
  return narrowViewport ? 'small' : 'full';
}

/** The remembered preference, or null when nobody has chosen. */
export function storedScreenMode() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === 'small' || v === 'full' ? v : null;
  } catch {
    return null; // storage disabled (private mode, sandboxed frame)
  }
}

/** Remember a choice. Failing to persist is not worth interrupting anyone for. */
export function saveScreenMode(mode) {
  if (mode !== 'small' && mode !== 'full') return;
  try { globalThis.localStorage?.setItem(KEY, mode); } catch { /* storage unavailable */ }
}

/** Is the viewport narrower than the full layout can take? */
export function narrowViewport(win = globalThis) {
  try {
    if (win.matchMedia) return win.matchMedia(`(max-width: ${SMALL_MAX_PX}px)`).matches;
    return Number(win.innerWidth) > 0 && win.innerWidth <= SMALL_MAX_PX;
  } catch {
    return false; // no matchMedia and no width ⇒ assume a real screen
  }
}

/** `?screen=` from the address bar, or null. */
export function urlScreenFlag(win = globalThis) {
  try {
    return new URLSearchParams(win.location?.search ?? '').get('screen');
  } catch {
    return null;
  }
}

/** The mode in force right now, read from the DOM rather than a second copy of the state. */
export function currentScreenMode(doc = globalThis.document) {
  return doc?.documentElement?.dataset?.screen === 'small' ? 'small' : 'full';
}

/**
 * Put the mode on the root element. Always writes an explicit value — absent-means-full would
 * make every selector ambiguous and leave a brief unstyled flash before boot.
 *
 * @param {ScreenMode} mode
 * @param {{persist?: boolean, doc?: Document}} [opts] `persist` records it as the user's
 *   CHOICE; boot and the `?screen=` flag pass false, because neither is one.
 */
export function applyScreenMode(mode, { persist = false, doc = globalThis.document } = {}) {
  const value = mode === 'small' ? 'small' : 'full';
  if (doc?.documentElement) doc.documentElement.dataset.screen = value;
  if (persist) saveScreenMode(value);
  return value;
}

/**
 * Decide and apply the mode at start-up.
 *
 * @param {{win?: Window, doc?: Document}} [opts]
 * @returns {{mode: ScreenMode, auto: boolean}} `auto` is true when the viewport chose — i.e.
 *   nobody had said, and it came out small. That is the only case worth telling the user
 *   about, because it is the only one where the layout is not what they asked for.
 */
export function initScreenMode({ win = globalThis, doc = globalThis.document } = {}) {
  const stored = storedScreenMode();
  const urlFlag = urlScreenFlag(win);
  const narrow = narrowViewport(win);
  const mode = resolveScreenMode({ stored, narrowViewport: narrow, urlFlag });
  applyScreenMode(mode, { doc }); // never persist a derived value
  return { mode, auto: mode === 'small' && stored === null && urlFlag !== 'small' && urlFlag !== 'full' };
}

/** Flip the mode and remember it — the toggle. @returns {ScreenMode} the new mode */
export function toggleScreenMode({ doc = globalThis.document } = {}) {
  const next = currentScreenMode(doc) === 'small' ? 'full' : 'small';
  applyScreenMode(next, { persist: true, doc });
  dismissAutoNote();
  return next;
}

/** Has the "turned on for you" note been dismissed (or already shown)? */
export function autoNoteSeen() {
  try {
    return globalThis.localStorage?.getItem(NOTE_KEY) === '1';
  } catch {
    return true; // cannot remember a dismissal ⇒ do not nag every load
  }
}

/** Remember that the note has been seen. */
export function dismissAutoNote() {
  try { globalThis.localStorage?.setItem(NOTE_KEY, '1'); } catch { /* storage unavailable */ }
}

/**
 * The one-line note shown when the viewport turned the mode on by itself.
 *
 * It exists because a first-time visitor does not know the mode exists, that it was chosen
 * for them, or where to undo it — so detecting silently would look like the app simply being
 * a mobile app. An offer-shaped notice *after* the fact, dismissible, said once.
 *
 * Rendered into `host` (the header, so it is visible whichever surface is up) and removed on
 * dismissal or on opening the mode's own toggle.
 *
 * @param {HTMLElement} host
 * @param {{onFull?: () => void}} [opts] invoked when the user takes the "use the full layout"
 *   way out, so the caller can re-render whatever needs it.
 */
export function showAutoNote(host, { onFull } = {}) {
  if (!host || autoNoteSeen()) return null;
  const note = document.createElement('div');
  note.className = 'screennote';
  note.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'Small screen layout is on.';
  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'screennote__btn';
  full.textContent = 'Use the full layout';
  full.addEventListener('click', () => {
    applyScreenMode('full', { persist: true });
    dismissAutoNote();
    note.remove();
    onFull?.();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'screennote__x';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.addEventListener('click', () => {
    dismissAutoNote();
    note.remove();
  });
  note.append(text, full, close);
  host.append(note);
  return note;
}
