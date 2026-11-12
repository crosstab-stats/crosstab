/**
 * @file settings-screen.js
 * The Settings screen — one list of every declared setting (#198).
 *
 * ## Why it exists now, when it is not needed
 *
 * The owner's call (2026-11-02): *"I suppose it can't hurt. rather than set some
 * benchmark number of settings where having it makes sense we can just add it now when it
 * clearly isn't necessary and it will be there if the number ever does get larger."*
 *
 * Which is the right shape of argument for this particular screen. The case against was
 * never that a screen is bad — it was that eight settings do not need one and each
 * already sits beside what it affects. Both still true. But the cost of building it is
 * lowest exactly now, while there is nothing to migrate and no layout to rework, and the
 * registry it reads was already finished and already had "a Settings screen's entire data
 * source" written in its own docs. Waiting for a threshold would have meant paying more
 * later for the same thing.
 *
 * It also closed a gap nobody had filed. **`collab.relays` and `collab.turn` had no UI at
 * all** — `setRelayUrls` and `setTurnConfig` had no caller anywhere outside
 * `live-sync.js`, so two declared settings were reachable only from a console. A screen
 * that enumerates settings finds that sort of thing by construction, which is a better
 * reason to have one than the count.
 *
 * ## What it edits, and what it refuses to
 *
 * A screen that lists settings is not automatically the place to change them, and
 * pretending otherwise is how you get a control that looks like it worked and did not.
 * Three presentations, chosen from the declaration rather than per-setting here:
 *
 *  - **Edited inline** — the setting can be completely expressed by one control and the
 *    change takes effect (or is read when next needed). The three `options` settings, the
 *    debug gate, the relay list.
 *  - **Routed** (`editedAt`) — the real control lives elsewhere and this shows the value
 *    read-only beside a pointer to it. The variable-list settings are the honest case:
 *    `data-views.js` reads them into instance state, so a write from here would not show
 *    until something re-rendered. The encryption policy is routed because it has a whole
 *    dialog of its own.
 *  - **Status only** (`secret`) — whether it is configured, never its contents. The TURN
 *    entry carries a credential, and `listSettings` already refuses to return it; a
 *    screen that printed it would have made the registry's care pointless.
 *
 * A setting with **no `label`** is not shown at all. That is not a filter invented here:
 * `screen.autoNoteSeen` carries the comment *"Not offered to a Settings screen (no
 * `label`)"*, written before this file existed. A label is what marks a declaration as a
 * preference rather than a lifecycle flag.
 *
 * ## Groups
 *
 * Ordered by {@link GROUP_ORDER} rather than by declaration or alphabetically, so that
 * Appearance is first and Advanced is last — the order a reader scans, not the order the
 * modules happen to import in. An unlisted group sorts after the known ones rather than
 * being dropped: a new setting must never go missing because nobody updated a list here.
 */

import { listSettings, setSetting, clearSetting } from './settings.js';
import { el } from './plugin-stdlib.js';

/**
 * Group order. Appearance first because it is what someone opening Settings most often
 * came for; Advanced last because `debug.logging` is there and nobody should meet it on
 * the way to something else.
 */
export const GROUP_ORDER = Object.freeze([
  'Appearance', 'Variables', 'Privacy', 'Collaboration', 'Advanced',
]);

/**
 * How a setting should be presented. Derived from the declaration, in this order, because
 * the earlier answers are the more restrictive ones: a routed setting that also had
 * options must still be routed, and a secret must never fall through to a text box.
 *
 * @param {object} spec a {@link module:core/settings~SettingSpec} with its value
 * @returns {'route'|'secret'|'select'|'lines'|'text'}
 */
export function controlFor(spec) {
  if (spec.editedAt) return 'route';
  if (spec.secret) return 'secret';
  if (spec.options) return 'select';
  // An array-shaped setting is edited as one item per line. Scoped to arrays on purpose:
  // the encryption policy is a shaped OBJECT, and a generic JSON editor for it would be
  // both unpleasant and a second place for its shape to be defined.
  if (spec.json && Array.isArray(spec.value)) return 'lines';
  return 'text';
}

/**
 * The settings to show, grouped and ordered — the whole data model of this screen, pure
 * so it can be tested without a DOM.
 *
 * @param {Array<object>} [list] defaults to {@link listSettings}
 * @returns {Array<{group: string, items: Array<object>}>}
 */
export function settingsGroups(list = listSettings()) {
  const shown = list.filter((s) => s.label);
  const byGroup = new Map();
  for (const s of shown) {
    const g = s.group || 'Other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }
  const rank = (g) => {
    const i = GROUP_ORDER.indexOf(g);
    // Unknown groups after the known ones, alphabetically among themselves. Never
    // dropped: a setting going missing because a list here was not updated would be the
    // one failure a screen like this must not have.
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...byGroup.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([group, items]) => ({ group, items }));
}

/** One item per line, blanks dropped — the `lines` control's text form. */
export function linesToArray(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The inverse, for filling the textarea. */
export function arrayToLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

/**
 * Describe a value for the read-only (routed) rows.
 *
 * Shows the OPTION LABEL rather than the stored token where there is one — "Small screen"
 * is what the control that owns this setting says, and a screen reporting `small` beside
 * it would read as a different setting.
 */
export function describeValue(spec) {
  if (spec.secret) return spec.isSet ? 'Configured' : 'Not configured';
  const v = spec.value;
  if (v == null || v === '') return 'Default';
  if (spec.options) {
    const hit = spec.options.find(([val]) => val === v);
    if (hit) return hit[1];
  }
  // A shaped value the declaring module knows how to say in one line. Ahead of both the
  // array and the object cases so a module can describe either, and never derived here:
  // which fields of a blob are the PREFERENCE is the owner's knowledge (the identity
  // blob's summary deliberately omits the minted authorId).
  if (spec.summary) {
    try {
      const s = spec.summary(v);
      if (s) return String(s);
    } catch {
      /* a summary that throws must not take the screen down with it */
    }
  }
  if (Array.isArray(v)) return v.length === 1 ? '1 entry' : `${v.length} entries`;
  if (typeof v === 'object') {
    // The encryption policy. Its own dialog explains it; a one-line summary here would be
    // a second description of a shape this file does not own.
    return 'Configured';
  }
  return String(v);
}

/**
 * Show the Settings dialog.
 *
 * Three kinds of content, and only the first comes from the registry. The other two are
 * providers because their contracts differ — a device setting is written through the
 * registry, a project setting by calling the same method a menu would, and an install
 * fact is not written at all. Bending any of them into `defineSetting` would mean
 * inventing `localStorage` keys for values that have none.
 *
 * @param {{openers?: Object<string, () => void>,
 *          projectSettings?: () => Array<object>,
 *          environment?: () => Promise<Array<{label: string, value: string, hint?: string}>>,
 *          onDetails?: () => void}} [opts]
 *   `environment` supplies the read-only "This install" rows (build, deployment, whether
 *   the fast R path is available) and `onDetails` opens the full set. Async, and awaited
 *   after the first paint, so a slow network never delays what someone came to change.
 *
 *   `projectSettings` supplies the project-scoped rows (#207) — a provider rather than a
 *   store handle, so this file renders what it is given and never learns what a weight is.
 *   `openers` maps a setting id to a
 *   function that opens its real editor. Passed in by `core/app.js` rather than imported
 *   here, because the module that DECLARES a setting cannot import the dialog that edits
 *   it — `at-rest.js` is imported by `encryption-settings.js`, so the reverse is a cycle.
 *   App wiring lives where everything else is already wired.
 * @returns {Promise<void>} resolves when the dialog closes
 */
export function showSettings({ openers = {}, projectSettings = null, environment = null, onDetails = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-settings';
    const form = el('div', { class: 'ct-dialog__form' });
    form.append(
      el('h2', { class: 'ct-dialog__title', text: 'Settings' }),
      el('p', {
        class: 'ct-dialog__hint',
        text: 'Preferences stored in this browser. They apply to every project on this device.',
      }),
      // What is deliberately NOT here, because the absence is otherwise unexplained.
      //
      // The owner looked for the frequency WEIGHT and did not find it. It is not an
      // oversight and it is not a preference: a weight is a property of a DATASET, folded
      // from the project's op log like any other step. That is load-bearing rather than
      // pedantic — because setting it is an op, it is undoable, it appears in History, it
      // exports in the analysis script, and it merges to collaborators. A device
      // preference would have none of those, and there would be one weight for every
      // project rather than one per dataset.
      //
      // Named explicitly rather than described in the abstract: a reader hunting for a
      // specific missing thing needs to see that thing's name.
      el('p', {
        class: 'ct-dialog__hint ct-settings__scope',
        text: 'Settings below the line belong to the open PROJECT, not to this browser. '
          + 'Changing one here is recorded in its History and undoes like any other step, '
          + 'because it goes through exactly the path the menus use.',
      }),
    );

    const body = el('div', { class: 'ct-settings__body' });
    form.append(body);

    // Fetched ONCE per opening, not per render: `render()` runs again after every write,
    // and `collectDiagnostics` fetches the build stamp over the network. `null` means
    // "not back yet", which is a different thing from an empty list and is shown as such.
    let envRows = null;
    let envError = false;

    const render = () => {
      body.textContent = '';
      for (const { group, items } of settingsGroups()) {
        body.append(el('h3', { class: 'ct-settings__group', text: group }));
        for (const spec of items) body.append(row(spec));
      }
      // The PROJECT's own settings, last and visibly separated (#207). Last because they
      // are the ones that are not always there — a screen whose first section vanishes
      // depending on what is open reads as broken.
      if (projectSettings) {
        body.append(el('h3', { class: 'ct-settings__group ct-settings__group--project', text: 'This project' }));
        const rows = projectSettings() || [];
        if (!rows.length) {
          // The honest empty state. Not an empty section and not a disabled control:
          // there is nothing to set because there is no data open, and saying which is
          // more use than either.
          body.append(el('p', { class: 'ct-settings__hint', text: 'No dataset is open, so there is nothing project-specific to set yet.' }));
        } else {
          for (const p of rows) body.append(projectRow(p));
        }
      }
      // What this copy of the app IS, last of all and read-only.
      //
      // Not settings in the registry's sense — nobody can change them here and none is
      // stored under a key, so forcing them through `defineSetting` would mean inventing
      // keys for values that have none and breaking "one key, one owner" to do it. They
      // are settings in the other sense: details that change how the thing works. The
      // first three questions of almost every "why is my app not working" live here, and
      // the only way to see them used to be to start filing a bug report.
      //
      // Same seam as the project section above: a provider, rendered by a row function
      // whose contract differs. The screen never learns what any of these mean — see
      // `environmentRows` in help.js.
      if (environment) {
        body.append(el('h3', { class: 'ct-settings__group ct-settings__group--install', text: 'This install' }));
        body.append(el('p', {
          class: 'ct-settings__hint',
          text: 'Not settings — this is what the app is doing here. Worth quoting if you ask for help.',
        }));
        if (envError) {
          body.append(el('p', { class: 'ct-settings__hint', text: 'These details could not be read.' }));
        } else if (envRows === null) {
          // The build stamp is fetched, so this section fills a moment after the rest.
          body.append(el('p', { class: 'ct-settings__hint', text: 'Checking…' }));
        } else {
          for (const f of envRows) body.append(factRow(f));
          if (onDetails) {
            const more = el('button', { type: 'button', class: 'ct-field', text: 'Full details…' });
            more.addEventListener('click', () => onDetails());
            body.append(el('div', { class: 'ct-settings__control', children: [more] }));
          }
        }
      }
    };

    /** One read-only fact. No control, because there is nothing here to set. */
    const factRow = (f) => {
      const wrap = el('div', { class: 'ct-settings__row' });
      const head = el('div', { class: 'ct-settings__label' });
      head.append(el('span', { text: f.label }));
      if (f.hint) head.append(el('span', { class: 'ct-settings__hint', text: f.hint }));
      wrap.append(head);
      wrap.append(el('div', {
        class: 'ct-settings__control',
        children: [el('span', { class: 'ct-settings__value', text: f.value })],
      }));
      return wrap;
    };

    /**
     * One project-scoped row. Separate from `row` because the contract is different: a
     * device setting is written through the registry, a project setting is written by
     * calling the same method a menu would — and that call is ASYNC and can fail.
     */
    const projectRow = (p) => {
      const wrap = el('div', { class: 'ct-settings__row' });
      const head = el('div', { class: 'ct-settings__label' });
      head.append(el('span', { text: p.label }));
      // Which dataset this applies to. A weight is per-dataset, so a screen that said
      // only "Frequency weight" would be claiming a project-wide scope it does not have.
      if (p.scope) head.append(el('span', { class: 'ct-settings__hint', text: `Applies to ${p.scope}.` }));
      if (p.hint) head.append(el('span', { class: 'ct-settings__hint', text: p.hint }));
      wrap.append(head);

      const control = el('div', { class: 'ct-settings__control' });
      const sel = el('select', { class: 'ct-field' });
      for (const [value, label] of p.options || []) {
        const opt = new Option(label, String(value));
        if (String(p.value ?? '') === String(value)) opt.selected = true;
        sel.append(opt);
      }
      // A stored value that is no longer eligible would otherwise disappear from its own
      // control, leaving a weight in force that the screen denies exists.
      if (p.stale) {
        // The WORDING comes from the descriptor: this file renders project settings
        // without knowing what any of them are, and "no longer a usable weight" was
        // domain knowledge leaking into a generic screen. A test caught it.
        const opt = new Option(`${p.value} (${p.staleNote || 'no longer available'})`, String(p.value));
        opt.selected = true;
        sel.append(opt);
      }
      const err = el('span', { class: 'ct-settings__hint' });
      sel.addEventListener('change', async () => {
        const chosen = sel.value;
        try {
          await p.set(chosen);
          err.textContent = '';
          // Re-read rather than trust: the op may have been coerced or refused, and the
          // control must show what is actually in force.
          render();
        } catch (e) {
          // Put the control back and say why, rather than leaving it displaying a value
          // the project never accepted.
          sel.value = String(p.value ?? '');
          err.textContent = e?.message || 'That could not be set.';
        }
      });
      control.append(sel, err);
      wrap.append(control);
      return wrap;
    };

    /** One setting. Rebuilt wholesale after a write, so what is shown is what is stored. */
    const row = (spec) => {
      const wrap = el('div', { class: 'ct-settings__row' });
      const head = el('div', { class: 'ct-settings__label' });
      head.append(el('span', { text: spec.label }));
      if (spec.hint) head.append(el('span', { class: 'ct-settings__hint', text: spec.hint }));
      wrap.append(head);

      const control = el('div', { class: 'ct-settings__control' });
      const kind = controlFor(spec);

      // Writing then re-rendering, rather than trusting the control: a `coerce` may adjust
      // what was typed, and a rejected value must not be left on screen looking stored.
      const write = (value) => { setSetting(spec.id, value); render(); };
      const reset = () => { clearSetting(spec.id); render(); };

      if (kind === 'route') {
        control.append(el('span', { class: 'ct-settings__value', text: describeValue(spec) }));
        const opener = openers[spec.id];
        if (opener) {
          const btn = el('button', { class: 'ct-btn', text: 'Open…' });
          btn.addEventListener('click', () => { dialog.close(); opener(); });
          control.append(btn);
        } else {
          control.append(el('span', {
            class: 'ct-settings__hint', text: `Changed from ${spec.editedAt}.`,
          }));
        }
      } else if (kind === 'secret') {
        control.append(el('span', { class: 'ct-settings__value', text: describeValue(spec) }));
        // A secret CAN have an editor, it just cannot have an inline one (#209). The
        // first version offered status and a Clear button that was hidden until the
        // setting was set — so an unconfigured row could only ever report its own
        // emptiness, and the console stayed the only way in. That is a guard around a
        // state that should not exist, and it left open the exact gap this screen was
        // built to close.
        //
        // Routed through `openers` for the same reason the encryption policy is: the
        // module that DECLARES the setting cannot import the dialog that edits it without
        // a cycle, so app wiring supplies it.
        const opener = openers[spec.id];
        if (opener) {
          const btn = el('button', { class: 'ct-btn', text: spec.isSet ? 'Change…' : 'Configure…' });
          btn.addEventListener('click', async () => {
            dialog.close();
            await opener();
          });
          control.append(btn);
        }
        if (spec.isSet) {
          const btn = el('button', { class: 'ct-btn', text: 'Clear' });
          btn.addEventListener('click', reset);
          control.append(btn);
        }
        // Still no INLINE editor: the value holds a credential, `listSettings` refuses to
        // return it, and a field that redisplayed one would make that refusal pointless.
      } else if (kind === 'select') {
        const sel = el('select', { class: 'ct-field' });
        // A null fallback is a real third state ("nobody has said"), not a missing value —
        // for `screen.mode` it is what lets the viewport decide. So it gets an option
        // rather than being reachable only through a Reset button.
        if (spec.fallback == null) sel.append(new Option('Default', ''));
        for (const [value, label] of spec.options) {
          const opt = new Option(label, String(value));
          if (spec.value === value) opt.selected = true;
          sel.append(opt);
        }
        if (spec.value == null) sel.value = '';
        sel.addEventListener('change', () => {
          if (sel.value === '') reset();
          else write(spec.options.find(([v]) => String(v) === sel.value)?.[0] ?? sel.value);
        });
        control.append(sel);
      } else if (kind === 'lines') {
        const area = el('textarea', { class: 'ct-field ct-settings__lines' });
        area.rows = 3;
        area.value = arrayToLines(spec.value);
        area.spellcheck = false;
        const save = el('button', { class: 'ct-btn', text: 'Save' });
        save.addEventListener('click', () => {
          const next = linesToArray(area.value);
          // An empty list MEANS "no override" and says so by clearing, rather than
          // leaning on an empty array being rejected — which reads the same and means
          // something else. `setRelayUrls` makes the same distinction for the same reason.
          if (next.length) write(next);
          else reset();
        });
        control.append(area, save);
      } else {
        const input = el('input', { class: 'ct-field' });
        input.type = 'text';
        input.value = spec.value == null ? '' : String(spec.value);
        const save = el('button', { class: 'ct-btn', text: 'Save' });
        save.addEventListener('click', () => {
          if (input.value.trim()) write(input.value.trim());
          else reset();
        });
        control.append(input, save);
      }

      // Only where the row can write at all, and only when there is something to undo.
      if (kind !== 'route' && kind !== 'secret' && spec.isSet) {
        const def = el('button', { class: 'ct-btn ct-settings__reset', text: 'Default' });
        def.addEventListener('click', reset);
        control.append(def);
      }

      wrap.append(control);
      return wrap;
    };

    render();

    // Kicked off after the first paint, so a slow or absent network delays nothing a
    // person came here to change. A failure fills in a line, never an empty section.
    if (environment) {
      (async () => {
        try {
          envRows = (await environment()) || [];
        } catch {
          envError = true;
        }
        if (dialog.open) render();
      })();
    }

    const footer = el('menu', { class: 'ct-dialog__buttons' });
    const done = el('button', { class: 'ct-dialog__primary', text: 'Done' });
    done.addEventListener('click', () => dialog.close());
    footer.append(done);
    form.append(footer);

    dialog.append(form);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
