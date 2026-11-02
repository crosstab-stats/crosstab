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
 * @param {{openers?: Object<string, () => void>}} [opts] `openers` maps a setting id to a
 *   function that opens its real editor. Passed in by `core/app.js` rather than imported
 *   here, because the module that DECLARES a setting cannot import the dialog that edits
 *   it — `at-rest.js` is imported by `encryption-settings.js`, so the reverse is a cycle.
 *   App wiring lives where everything else is already wired.
 * @returns {Promise<void>} resolves when the dialog closes
 */
export function showSettings({ openers = {} } = {}) {
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
    );

    const body = el('div', { class: 'ct-settings__body' });
    form.append(body);

    const render = () => {
      body.textContent = '';
      for (const { group, items } of settingsGroups()) {
        body.append(el('h3', { class: 'ct-settings__group', text: group }));
        for (const spec of items) body.append(row(spec));
      }
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
        if (spec.isSet) {
          const btn = el('button', { class: 'ct-btn', text: 'Clear' });
          btn.addEventListener('click', reset);
          control.append(btn);
        }
        // Deliberately no editor. The value holds a credential, `listSettings` refuses to
        // return it, and a form here could only write blind — which is worth building
        // when something asks for it and not before.
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
