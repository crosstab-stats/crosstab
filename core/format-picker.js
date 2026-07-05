/**
 * @file format-picker.js
 * The unified File ▸ Import data… / Export data… format chooser.
 *
 * Instead of one File-menu item per format (which made the File menu overflow and
 * scaled badly as codecs were added), the host registers a single "Import data…"
 * and "Export data…" item; each opens this dialog, which lists the *currently
 * activated* formats — grouped, searchable, with their extensions shown. The list
 * is built fresh on open from whatever importers/exporters are registered, so
 * turning a codec on/off in the plugin manager changes the picker with no extra
 * wiring. This is also the cross-platform answer to the labelled OS picker: the
 * File System Access API's labelled `types` dropdown is Chromium-only, so we draw
 * our own list (works identically on iPad Safari).
 *
 * ## User-activation note
 * A file `<input>` may only be opened from a live user gesture. The row click *is*
 * that gesture, so the chosen entry's `command` is invoked **synchronously** from
 * the click handler (we don't await anything first) — the command opens the picker
 * within the same task, keeping the transient activation alive. This is why the
 * picker doesn't resolve a promise the caller then acts on; it runs the command
 * itself.
 */

/**
 * @typedef {Object} FormatEntry
 * @property {string} id - Stable id (the importer/exporter id).
 * @property {string} label - Display label, e.g. `'CSV…'` or `'SPSS / Stata / SAS…'`.
 * @property {string[]} [extensions] - Handled extensions, shown as a hint, e.g. `['.csv','.tsv']`.
 * @property {string} group - Group heading this entry sits under, e.g. `'Data files'`.
 * @property {number} [order] - Sort weight within its group (lower first).
 * @property {() => void} command - Invoked (synchronously) when the entry is chosen.
 */

/**
 * Show the format picker. Fire-and-forget: choosing a row closes the dialog and
 * runs that row's `command`; Cancel/Escape just closes it.
 *
 * @param {Object} opts
 * @param {string} opts.title - Dialog title, e.g. `'Import data'`.
 * @param {string} [opts.hint] - Sub-title hint line.
 * @param {string} [opts.emptyText] - Shown when there are no entries at all.
 * @param {FormatEntry[]} opts.entries
 */
export function showFormatPicker({ title, hint, emptyText, entries }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog ct-dialog--wide ct-fmt';
  dialog.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title"></h2>
      <p class="ct-dialog__hint"></p>
      <input type="search" class="ct-fmt__search" placeholder="Filter formats…" aria-label="Filter formats" autocomplete="off" />
      <div class="ct-fmt__list"></div>
      <menu class="ct-dialog__buttons">
        <button value="cancel" type="submit">Cancel</button>
      </menu>
    </form>`;

  dialog.querySelector('.ct-dialog__title').textContent = title;
  const hintEl = dialog.querySelector('.ct-dialog__hint');
  if (hint) hintEl.textContent = hint;
  else hintEl.remove();

  const listEl = dialog.querySelector('.ct-fmt__list');
  const searchEl = dialog.querySelector('.ct-fmt__search');

  // Group entries in the order their groups first appear (caller controls order by
  // pre-sorting `entries`), then by `order`/label within each group.
  const choose = (entry) => {
    // Close first, then run synchronously so the file picker the command opens
    // still has the click's transient user activation (see the file header).
    dialog.close();
    try {
      entry.command();
    } catch (err) {
      console.error('[format-picker]', err);
    }
  };

  const render = (query) => {
    const q = (query || '').trim().toLowerCase();
    listEl.replaceChildren();

    const groups = new Map(); // group → entries[]
    for (const e of entries) {
      if (q) {
        const hay = `${e.label} ${(e.extensions || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }

    if (groups.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'ct-fmt__empty';
      empty.textContent = q ? 'No matching formats.' : emptyText || 'No formats available.';
      listEl.append(empty);
      return;
    }

    for (const [group, items] of groups) {
      items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
      const gl = document.createElement('div');
      gl.className = 'ct-fmt__group';
      gl.textContent = group;
      listEl.append(gl);
      for (const e of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ct-fmt__row';
        const name = document.createElement('span');
        name.className = 'ct-fmt__name';
        name.textContent = e.label.replace(/…\s*$/, '');
        row.append(name);
        if (e.extensions && e.extensions.length) {
          const ext = document.createElement('span');
          ext.className = 'ct-fmt__ext';
          ext.textContent = e.extensions.join('  ');
          row.append(ext);
        }
        row.addEventListener('click', () => choose(e));
        listEl.append(row);
      }
    }
  };

  searchEl.addEventListener('input', () => render(searchEl.value));
  // Enter on the search box runs the first visible row — fast keyboard path.
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = listEl.querySelector('.ct-fmt__row');
      if (first) first.click();
    }
  });

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  render('');
  dialog.showModal();
  searchEl.focus();
}

/**
 * Promise-returning format chooser for when an extension is claimed by more than
 * one importer (e.g. a `.txt` URL — a CSV table vs text-as-data), or can't be told
 * from the URL at all. Unlike {@link showFormatPicker} (fire-and-forget, which runs
 * a command *synchronously* to keep the click's user-activation alive for a file
 * dialog), this just resolves the chosen entry — the bytes are already in hand, so
 * there is no file dialog and no activation to preserve.
 *
 * @param {Object} opts
 * @param {string} opts.title - Dialog title, e.g. `'Choose a format'`.
 * @param {string} [opts.hint] - Sub-title hint line.
 * @param {Array<{id: string, label: string, extensions?: string[]}>} opts.entries
 * @returns {Promise<{id: string, label: string}|null>} the chosen entry, or null if cancelled.
 */
export function chooseFormat({ title, hint, entries }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-dialog--wide ct-fmt';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title"></h2>
        <p class="ct-dialog__hint"></p>
        <div class="ct-fmt__list"></div>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="submit">Cancel</button>
        </menu>
      </form>`;
    dialog.querySelector('.ct-dialog__title').textContent = title;
    const hintEl = dialog.querySelector('.ct-dialog__hint');
    if (hint) hintEl.textContent = hint;
    else hintEl.remove();

    const listEl = dialog.querySelector('.ct-fmt__list');
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      dialog.close();
    };

    for (const e of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ct-fmt__row';
      const name = document.createElement('span');
      name.className = 'ct-fmt__name';
      name.textContent = e.label.replace(/…\s*$/, '');
      row.append(name);
      if (e.extensions && e.extensions.length) {
        const ext = document.createElement('span');
        ext.className = 'ct-fmt__ext';
        ext.textContent = e.extensions.join('  ');
        row.append(ext);
      }
      row.addEventListener('click', () => finish(e));
      listEl.append(row);
    }

    // Escape / Cancel / any close we didn't initiate → treat as cancelled.
    dialog.addEventListener('cancel', () => finish(null));
    dialog.addEventListener('close', () => { dialog.remove(); finish(null); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Ask the user what to name an export. A small in-app dialog — used in preference
 * to the File System Access "save" picker for the same reason {@link showFormatPicker}
 * draws its own list: `showSaveFilePicker` is Chromium-only, so a custom dialog is
 * the only thing that behaves identically on iPad Safari. The default name is kept
 * deliberately neutral (NOT the dataset name) so an export filename can't leak a
 * project/variable name, and so repeat exports don't silently overwrite each other —
 * the user names each one.
 *
 * The extension is fixed by the chosen format: it's shown as a non-editable suffix
 * and force-appended to the result, so the user can't accidentally produce a file
 * whose name disagrees with its bytes.
 *
 * @param {Object} opts
 * @param {string} [opts.title] - Dialog title, e.g. `'Export SPSS'`.
 * @param {string} [opts.defaultName] - Pre-filled base name (without extension).
 * @param {string} [opts.extension] - Fixed extension with the dot, e.g. `'.sav'`.
 * @returns {Promise<string|null>} The chosen filename (extension ensured), or null if cancelled.
 */
export function showSaveAsDialog({ title = 'Export as', defaultName = 'export', extension = '' } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ct-dialog ct-saveas';
    dialog.innerHTML = `
      <form method="dialog" class="ct-dialog__form">
        <h2 class="ct-dialog__title"></h2>
        <label class="ct-dialog__row">
          <span>File name</span>
          <span class="ct-saveas__field">
            <input type="text" class="ct-saveas__name" autocomplete="off" spellcheck="false" />
            <span class="ct-saveas__ext"></span>
          </span>
        </label>
        <menu class="ct-dialog__buttons">
          <button value="cancel" type="button" class="ct-saveas__cancel">Cancel</button>
          <button value="save" type="submit" class="ct-dialog__primary">Export</button>
        </menu>
      </form>`;

    dialog.querySelector('.ct-dialog__title').textContent = title;
    dialog.querySelector('.ct-saveas__ext').textContent = extension || '';
    const input = dialog.querySelector('.ct-saveas__name');
    input.value = defaultName;

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
      dialog.close();
    };

    dialog.querySelector('.ct-saveas__cancel').addEventListener('click', () => finish(null));
    dialog.querySelector('.ct-dialog__form').addEventListener('submit', (e) => {
      e.preventDefault();
      finish(ensureExtension(input.value, extension));
    });
    // Escape fires the dialog's native `cancel`; treat it (and any close we didn't
    // initiate) as a cancel so the promise always settles.
    dialog.addEventListener('cancel', () => finish(null));
    dialog.addEventListener('close', () => {
      dialog.remove();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

/**
 * Sanitise a user-typed export name into a safe single-segment filename and ensure
 * it carries the format's extension exactly once.
 * @param {string} name
 * @param {string} ext - Extension with the dot, e.g. `'.sav'` (may be empty).
 * @returns {string}
 */
export function ensureExtension(name, ext) {
  // Drop any directory parts a user might paste; keep the last segment.
  let base = String(name || '').trim().replace(/[\\/]+/g, '/');
  base = base.slice(base.lastIndexOf('/') + 1).trim();
  if (!base) base = 'export';
  if (ext && !base.toLowerCase().endsWith(ext.toLowerCase())) base += ext;
  return base;
}

/**
 * Classify a format into a group heading from its source/extensions. Keeps the
 * picker tidy without every plugin having to declare a group: web importers go
 * under "Online sources", statistical-software formats under "Statistical
 * software", everything else under "Data files". A spec may override with its own
 * `group`.
 *
 * @param {{ source?: string, extensions?: string[], group?: string }} spec
 * @returns {string}
 */
export function groupFor(spec) {
  if (spec.group) return spec.group;
  if (spec.source === 'web') return 'Online sources';
  const exts = (spec.extensions || []).map((e) => e.toLowerCase());
  if (exts.some((e) => STAT_EXTS.has(e))) return 'Statistical software';
  return 'Data files';
}

/** Extensions that mark a statistical-software data format (for grouping). */
const STAT_EXTS = new Set(['.sav', '.zsav', '.por', '.dta', '.sas7bdat', '.xpt', '.rdata', '.rds']);

/** Fixed display order for the inferred groups; unknown groups sort after, alpha. */
const GROUP_RANK = { 'Data files': 0, 'Statistical software': 1, 'Online sources': 9 };

/**
 * Sort comparator for grouped format entries: by group rank, then within-group
 * `order`, then label. Callers pass the result to {@link showFormatPicker} so the
 * groups render top-to-bottom in this order.
 *
 * @param {FormatEntry} a
 * @param {FormatEntry} b
 * @returns {number}
 */
export function byGroupThenOrder(a, b) {
  const ra = GROUP_RANK[a.group] ?? 5;
  const rb = GROUP_RANK[b.group] ?? 5;
  return (
    ra - rb ||
    a.group.localeCompare(b.group) ||
    (a.order ?? 100) - (b.order ?? 100) ||
    a.label.localeCompare(b.label)
  );
}
