/**
 * @file conflict-ui.js
 * The host conflict-resolution modal (#143) — the visible half of the "never a
 * silent wrong merge" guarantee.
 *
 * When a sync detects genuine collisions, `mergeManifests` returns a `conflicts[]`
 * list (each with a stable `key`, a human `label`, the two sides' values, and the
 * `options` offered). This module renders them as "keep yours / keep theirs / keep
 * both" choices and returns a `resolutions` map (`key → choice`) — which fed back
 * into the merge produces a clean, deterministic result (see `resolution.test.mjs`).
 *
 * The design principle (from the collaboration plan): faculty vastly prefer being
 * asked over a plausible-but-wrong silent merge that feeds a published finding. So
 * this never auto-picks — it defaults each conflict to "yours" but shows both sides.
 *
 * DOM-only (no OS picker), so it's buildable and verifiable in-browser headlessly.
 */

/** The distinguishing payload of an op — what it actually set/changed — so the two
 * sides of a conflict read differently (both share the type+name; that's WHY they
 * collided, so it's useless to show). e.g. a setVariable's patch, a recode's rules. */
function opValue(op) {
  if (op.patch && typeof op.patch === 'object') {
    const kv = Object.entries(op.patch).map(([k, val]) => `${k} → ${fmt(val)}`).join(', ');
    if (kv) return kv;
  }
  if (op.rules != null) return `rules: ${fmt(op.rules)}`;
  if (op.value !== undefined) return `= ${fmt(op.value)}`;
  if (op.expr != null) return `= ${fmt(op.expr)}`;
  return null;
}

function fmt(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s != null && s.length > 60 ? `${s.slice(0, 57)}…` : String(s);
}

/** One-line preview of a conflict side's value for the chooser. */
function preview(v) {
  if (v == null) return '— (removed)';
  if (typeof v === 'object' && v.type) {
    // an op — lead with WHAT it set (the differing bit), not just type+name
    const detail = opValue(v);
    return detail ? `${v.name ? `${v.name}: ` : ''}${detail}` : `${v.type}${v.name ? ` ${v.name}` : ''}`;
  }
  if (typeof v === 'object' && (v.name || v.id)) return String(v.name ?? v.id); // a keyed item (e.g. a code)
  return fmt(v);
}

const OPTION_LABEL = { mine: 'Keep yours', theirs: 'Keep theirs', both: 'Keep both' };

/**
 * Build the conflict-resolution form (no modal wrapper) — returned so it can be
 * embedded and unit-tested directly. Every conflict defaults to `mine` so a
 * `getResolutions()` call is always complete, even if the user skips some.
 *
 * @param {object[]} conflicts  from `mergeManifests` / `mergeProject`
 * @returns {{element: HTMLElement, getResolutions: () => Record<string,string>}}
 */
export function buildConflictForm(conflicts) {
  const wrap = document.createElement('div');
  wrap.className = 'ct-conflicts';

  for (const c of conflicts) {
    const row = document.createElement('div');
    row.className = 'ct-conflict';
    row.dataset.key = c.key;

    const head = document.createElement('div');
    head.className = 'ct-conflict__head';
    const scope = c.dataset != null ? `dataset ${c.dataset}` : c.owner;
    head.textContent = `${c.label || `${c.kind} on ${c.target}`} (${scope})`;
    row.append(head);

    const opts = document.createElement('div');
    opts.className = 'ct-conflict__opts';
    const options = c.options?.length ? c.options : ['mine', 'theirs'];
    options.forEach((opt, i) => {
      const id = `cf_${c.key}__${opt}`;
      const label = document.createElement('label');
      label.className = 'ct-conflict__opt';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `cf_${c.key}`;
      radio.value = opt;
      radio.id = id;
      if (i === 0) radio.checked = true; // default: yours
      const txt = document.createElement('span');
      const side = opt === 'mine' ? c.mine : opt === 'theirs' ? c.theirs : null;
      txt.textContent = opt === 'both' ? OPTION_LABEL.both : `${OPTION_LABEL[opt] ?? opt}: ${preview(side)}`;
      label.append(radio, txt);
      opts.append(label);
    });
    row.append(opts);
    wrap.append(row);
  }

  const getResolutions = () => {
    const out = {};
    for (const row of wrap.querySelectorAll('.ct-conflict')) {
      const key = row.dataset.key;
      const checked = row.querySelector('input[type=radio]:checked');
      if (checked) out[key] = checked.value;
    }
    return out;
  };

  return { element: wrap, getResolutions };
}

/**
 * Show the conflict-resolution modal. Resolves to a `resolutions` map on confirm,
 * or `null` if cancelled (the caller then leaves the sync unresolved and retries).
 * A "keep all yours / all theirs" pair of quick-set buttons speeds the common case.
 *
 * Pass an `AbortSignal` to close the dialog from outside — used when a co-author
 * resolves the same conflict first (their choice arrives over the wire), so a stale
 * copy of the modal doesn't linger on every other peer. An aborted dialog resolves
 * `null` (no local choice; the remote resolution is applied instead).
 *
 * @param {object[]} conflicts
 * @param {{title?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<Record<string,string>|null>}
 */
export function showConflictDialog(conflicts, { title = 'Resolve sync conflicts', signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-conflict-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'ct-dialog__form';

    const h2 = document.createElement('h2');
    h2.className = 'ct-dialog__title';
    h2.textContent = title;
    const hint = document.createElement('p');
    hint.className = 'ct-dialog__hint';
    hint.textContent = `${conflicts.length} change${conflicts.length === 1 ? '' : 's'} collided. Pick which to keep — nothing is decided silently.`;
    form.append(h2, hint);

    const { element, getResolutions } = buildConflictForm(conflicts);
    form.append(element);

    const setAll = (side) => {
      for (const r of element.querySelectorAll(`input[type=radio][value="${side}"]`)) r.checked = true;
    };
    const quick = document.createElement('menu');
    quick.className = 'ct-dialog__buttons';
    const allMine = document.createElement('button');
    allMine.type = 'button';
    allMine.textContent = 'Keep all yours';
    allMine.addEventListener('click', () => setAll('mine'));
    const allTheirs = document.createElement('button');
    allTheirs.type = 'button';
    allTheirs.textContent = 'Keep all theirs';
    allTheirs.addEventListener('click', () => setAll('theirs'));
    quick.append(allMine, allTheirs);
    form.append(quick);

    const menu = document.createElement('menu');
    menu.className = 'ct-dialog__buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close('cancel'));
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ct-dialog__primary';
    ok.textContent = 'Apply merge';
    ok.addEventListener('click', () => {
      dialog.__resolutions = getResolutions();
      dialog.close('ok');
    });
    menu.append(cancel, ok);
    form.append(menu);

    dialog.append(form);
    let done = false;
    dialog.addEventListener('close', () => {
      if (done) return;
      done = true;
      resolve(dialog.returnValue === 'ok' ? (dialog.__resolutions ?? {}) : null);
      dialog.remove();
    });
    // A co-author resolved it first → close this now-stale copy (resolves null).
    signal?.addEventListener('abort', () => { if (!done && dialog.open) dialog.close('remote'); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
