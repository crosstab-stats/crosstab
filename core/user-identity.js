/**
 * @file user-identity.js
 * The per-USER identity profile (#148, step 1): a display name, initials, and an
 * avatar colour, stored **per device** in localStorage so it travels across every
 * project — NOT per-project (distinct from a project's `collabId`/`collabSecret`).
 *
 * A stable minted `authorId` means attribution survives a later display-name change;
 * everything the user authors snapshots the initials/name at the time (see #148 step
 * 2). Identity is **self-asserted** — no auth, serverless by design — so attribution
 * is advisory, not forensic; inter-coder reliability needs *consistent* labels, not
 * *verified* ones.
 *
 * The header self-chip built here is also the seed for live presence (#148 step 5):
 * other editors' chips will sit next to yours once live P2P is up.
 */

import { defineSetting } from './settings.js';

const LS_KEY = 'crosstab.identity';
const EVENT = 'crosstab:identitychanged';

/** Colour-blind-safe avatar palette (Okabe–Ito). */
export const AVATAR_COLORS = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9', '#666666'];

/**
 * Declared so the Settings screen can SEE it (#198).
 *
 * The registry's boundary note used to put `crosstab.identity` on the "not a preference"
 * side, as data and lifecycle. That is half right and it is the half that hid the other:
 * `authorId` is an identifier the user never chooses, but the name, initials, avatar
 * colour and "automatically check for live collaborators" in the same blob are exactly
 * preferences — one of them a behaviour toggle that decides whether opening a project
 * reaches the network. Found by the owner working the manual pass: "username and
 * initials, colour, and 'auto check for live collab' … all seem absent from the unified
 * settings screen." They were, and the screen exists to make that impossible.
 *
 * Routed (`editedAt`), not edited inline: {@link showIdentityDialog} already is the right
 * editor — initials tracking the name, the palette, one atomic write — and a second set
 * of controls over one key is how the two drift. Routed also means the screen offers no
 * Clear, which matters here more than anywhere: clearing this key would re-mint
 * `authorId` and orphan every attribution the user has ever made.
 *
 * The accessors replace a hand-rolled load/persist pair that did the same JSON-plus-
 * try/catch the registry does for every other setting — which is the duplication the
 * registry was built to end.
 */
const identitySetting = defineSetting({
  id: 'collab.identity',
  key: LS_KEY,
  json: true,
  // Permissive on purpose: this is the only place a user's stable authorId lives, so a
  // field this module does not recognise is kept rather than dropped. Only a value with
  // no usable authorId is rejected — and `getIdentity` then mints a fresh one, which is
  // what the old `load()` did by returning null.
  coerce: (v) => (v && typeof v === 'object' && !Array.isArray(v)
    && typeof v.authorId === 'string' && v.authorId ? v : undefined),
  fallback: null,
  label: 'Your name, initials and colour',
  group: 'Collaboration',
  hint: 'Tags your edits and codes so a team can see who did what — and whether opening '
    + 'a project quietly looks for live collaborators.',
  editedAt: 'the avatar button in the top bar',
  // Never the authorId: a screen that enumerates settings should print what the user
  // chose, not the identifier the app minted for them.
  summary: (v) => {
    if (!v) return 'Not set';
    const who = v.name ? (v.initials ? `${v.name} (${v.initials})` : v.name) : 'No name set';
    return `${who} · auto-join live rooms ${v.autoLive ? 'on' : 'off'}`;
  },
});

const load = () => identitySetting.get();
const persist = (obj) => identitySetting.set(obj);

/** Stable colour pick from the authorId, so an un-customised avatar is still distinct. */
function colorFor(authorId) {
  let h = 0;
  for (let i = 0; i < authorId.length; i++) h = (h * 31 + authorId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Derive up to two initials from a display name ("Jane Q. Public" → "JP"). */
export function deriveInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * The current identity, minting a stable `authorId` + default colour on first use.
 * `name`/`initials` are empty until the user sets them; `set` is whether a name exists.
 * @returns {{authorId: string, name: string, initials: string, color: string, set: boolean}}
 */
export function getIdentity() {
  let id = load();
  if (!id || !id.authorId) {
    const authorId = globalThis.crypto?.randomUUID?.() ?? `a-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    id = { authorId, name: '', initials: '', color: colorFor(authorId) };
    persist(id);
  }
  if (!id.color) id.color = colorFor(id.authorId);
  return { ...id, autoLive: !!id.autoLive, set: !!(id.name && id.name.trim()) };
}

/**
 * Update the identity. Initials default to those derived from the name when omitted.
 * Fires a `crosstab:identitychanged` window event so the header chip refreshes.
 * @param {{name?: string, initials?: string, color?: string}} patch
 * @returns {ReturnType<typeof getIdentity>}
 */
export function setIdentity(patch = {}) {
  const cur = getIdentity();
  const name = patch.name != null ? String(patch.name).trim() : cur.name;
  const initials = (patch.initials != null ? String(patch.initials) : deriveInitials(name) || cur.initials)
    .trim()
    .slice(0, 4)
    .toUpperCase();
  const color = patch.color || cur.color;
  const autoLive = patch.autoLive != null ? !!patch.autoLive : cur.autoLive;
  const next = { authorId: cur.authorId, name, initials, color, autoLive };
  persist(next);
  try {
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
  } catch {
    /* no window (headless) */
  }
  return { ...next, set: !!name };
}

/**
 * A compact authorship snapshot to stamp onto a code/op the user creates (#148 step
 * 2). Snapshotted (not a live reference) so it survives a later rename and other
 * peers see it without the author's profile. `name`/`initials` may be empty if the
 * user hasn't set an identity — `authorId` is always present.
 * @returns {{authorId: string, initials: string, name: string, color: string}}
 */
export function currentAuthor() {
  const { authorId, initials, name, color } = getIdentity();
  return { authorId, initials, name, color };
}

/** Subscribe to identity changes. Returns an unsubscribe fn. */
export function onIdentityChange(fn) {
  const h = (e) => fn(e.detail);
  globalThis.addEventListener?.(EVENT, h);
  return () => globalThis.removeEventListener?.(EVENT, h);
}

// --- UI --------------------------------------------------------------------

/**
 * The identity editor dialog: name + initials (auto-filled from the name, editable) +
 * an avatar-colour picker. Persists on Save. Fire-and-forget.
 */
export function showIdentityDialog() {
  injectStyles();
  const cur = getIdentity();
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog ct-identity';
  dialog.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">Your name &amp; initials</h2>
      <p class="ct-dialog__hint">Tags your edits and codes so a team can see who did what
        (and run inter-coder comparisons). Stored on this device only, for all your projects.</p>
      <label class="ct-dialog__row"><span>Name</span>
        <input type="text" class="ct-input ct-identity__name" placeholder="e.g. Jane Public" autocomplete="name" /></label>
      <label class="ct-dialog__row"><span>Initials</span>
        <input type="text" class="ct-input ct-identity__initials" maxlength="4" placeholder="JP" style="width:5rem" /></label>
      <div class="ct-dialog__row"><span>Colour</span><div class="ct-identity__colors"></div></div>
      <label class="ct-identity__auto"><input type="checkbox" class="ct-identity__autolive" />
        <span><strong>Automatically check for live collaborators</strong><br>
        <span class="ct-identity__autosub">When on, opening a project quietly joins its live room so you can see who else is here (needs a connection). When off, use the “Go live” button.</span></span></label>
      <menu class="ct-dialog__buttons">
        <button type="button" class="ct-identity__cancel">Cancel</button>
        <button type="submit" class="ct-dialog__primary">Save</button>
      </menu>
    </form>`;

  const nameEl = dialog.querySelector('.ct-identity__name');
  const initEl = dialog.querySelector('.ct-identity__initials');
  const colorsEl = dialog.querySelector('.ct-identity__colors');
  const autoEl = dialog.querySelector('.ct-identity__autolive');
  nameEl.value = cur.name;
  initEl.value = cur.initials;
  autoEl.checked = cur.autoLive;
  let color = cur.color;
  let initialsEdited = !!cur.initials;

  for (const c of AVATAR_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'ct-identity__sw';
    sw.style.background = c;
    sw.setAttribute('aria-label', c);
    const mark = () => colorsEl.querySelectorAll('.ct-identity__sw').forEach((b) => b.classList.toggle('sel', b === sw));
    if (c === color) mark();
    sw.addEventListener('click', () => { color = c; mark(); });
    colorsEl.append(sw);
  }
  // Initials track the name until the user edits them by hand.
  nameEl.addEventListener('input', () => { if (!initialsEdited) initEl.value = deriveInitials(nameEl.value); });
  initEl.addEventListener('input', () => { initialsEdited = true; });

  let done = false;
  const finish = () => { if (!done) done = true; dialog.close(); };
  dialog.querySelector('.ct-identity__cancel').addEventListener('click', finish);
  dialog.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    setIdentity({ name: nameEl.value, initials: initEl.value, color, autoLive: autoEl.checked });
    finish();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  nameEl.focus();
}

/**
 * Mount the header self-chip: a small avatar showing your initials (or a prompt to
 * set them), opening the editor on click. Refreshes on identity change. This is the
 * seed for the live-presence row (#148 step 5).
 * @param {HTMLElement} headerEl
 */
export function installIdentityChip(headerEl) {
  if (!headerEl) return;
  injectStyles();
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ct-idchip';
  chip.addEventListener('click', () => showIdentityDialog());
  const render = () => {
    const id = getIdentity();
    chip.style.background = id.set ? id.color : 'transparent';
    chip.style.borderColor = id.set ? id.color : 'var(--bar-fg, #ecf0f1)';
    chip.textContent = id.set ? id.initials : '＋';
    chip.title = id.set ? `You: ${id.name}` : 'Set your name & initials';
    chip.setAttribute('aria-label', chip.title);
  };
  render();
  onIdentityChange(render);
  headerEl.append(chip);
  return chip;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .ct-idchip { flex: none; width: 30px; height: 30px; border-radius: 50%; border: 2px solid;
      color: #fff; font-size: 12px; font-weight: 700; cursor: pointer; display: flex;
      align-items: center; justify-content: center; padding: 0; line-height: 1; }
    .ct-idchip:hover { filter: brightness(1.1); }
    .ct-identity__colors { display: flex; gap: 6px; }
    .ct-identity__sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .ct-identity__sw.sel { border-color: var(--bar, #2c3e50); outline: 1px solid #fff; }
    .ct-identity__auto { display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 4px; cursor: pointer; font-size: 13px; }
    .ct-identity__auto input { margin-top: 3px; flex: none; }
    .ct-identity__autosub { font-size: 12px; color: #5a6570; line-height: 1.4; }
    /* live presence (#148 step 5) */
    .ct-peers { display: flex; align-items: center; gap: 4px; flex: none; }
    .ct-peerchip { width: 26px; height: 26px; border-radius: 50%; border: 2px solid rgba(255,255,255,.6);
      color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .ct-golive { flex: none; font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
      background: transparent; color: var(--bar-fg, #ecf0f1); border: 1px solid rgba(255,255,255,.4); }
    .ct-golive:hover { background: rgba(255,255,255,.12); }
    .ct-golive.is-live { background: #2e7d32; border-color: #2e7d32; color: #fff; }`;
  document.head.append(s);
}
