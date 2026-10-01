/**
 * @file plugin-picker.js
 * **One** plugin-adjusting surface, mounted by two hosts.
 *
 * The launcher's centre column and Edit ▸ Plugins were the same screen built twice: two class
 * hierarchies, two renderers, two glyphs for "what does this add?", and capabilities that
 * existed on exactly one of them for no stated reason (the launcher had presets and
 * select-all; the manager had add-from-file/URL and the per-row action icons). That is the
 * shape that has already cost this project three bugs — #177's tooltip that existed on one
 * picker and not the other, #171's project list rendered twice, #185's deploy issues counted
 * twice — so the fix is a component, not a tidier copy:
 *
 *   *"I like the plugin section in the launcher, two columns, filter box with disciplines,
 *   preset support. I just think we need to fold in the few items that Edit|Plugins has (load
 *   from file/url and the support for the additional icons on each row) and make that entire
 *   plugin UI a module that Edit|Plugins can also call as a standalone modal."* — owner,
 *   2026-10-01
 *
 * So the launcher's layout won, the manager's row won, and everything appears on both.
 *
 * ## The one real difference: a MODE, not a second component
 *
 * The two hosts act on different lifecycle states (see the plugin lifecycle terms):
 *
 *  - `'select'` — the launcher. Nothing is running yet; ticking a box edits a *desired*
 *    activated set that the host commits on Start / Apply changes.
 *  - `'live'` — Edit ▸ Plugins. Ticking a box activates or deactivates there and then, in a
 *    session with data loaded and workspaces possibly mounted.
 *
 * Everything else — the search, the discipline filter, the grouping, the presets, the row and
 * its icons — is identical, which is why this is one component with a mode rather than two
 * renderers that happen to agree today.
 *
 * ## Decisions, extracted on purpose
 *
 * {@link rowActions}, {@link rowMeta} and {@link pickerSections} are pure and tested
 * separately, for the reason #173 did the same to the project manager: *which* affordances a
 * row offers is a decision, and decisions rot quietly inside DOM code — an over-generous
 * action list looks exactly like a correct one until someone clicks it.
 *
 * Host-owned; not a plugin.
 */

import {
  addsTooltip, matchPlugin, openPluginAbout, originMeta,
} from './plugin-manager.js';
import {
  deletePreset, exportPresetFile, listPresets, parsePresetFile, presetExists, presetFileName,
  presetFromSelection, renamePreset, resolvePreset, savePreset,
} from './plugin-presets.js';
import { downloadFile } from './export-service.js';

/** File-I/O categories a preset always unions in — see the launcher's copy of this list. */
const INFRA_CATEGORIES = new Set(['Import', 'Export', 'Data']);

/** Above this many live changes at once, the bulk links ask first. */
const BULK_CONFIRM_AT = 8;

// --- decisions (pure) --------------------------------------------------------

/**
 * Which per-row actions a plugin offers, in render order.
 *
 * The same ids in BOTH modes, which is the entire point of the unification: there was no
 * argument for the launcher withholding "make an editable copy" or "export this plugin", only
 * an accident of which file grew the feature. The list still shrinks per PLUGIN, and that is
 * what keeps a two-column grid readable — a built-in offers three icons (about, fork, export),
 * and only a user-added plugin carries all six.
 *
 * `about` is unconditional and first: it is the only path to "what does this add?" on a touch
 * screen (#177, and the owner on a phone, 2026-09-26).
 *
 * @param {object} p row from `PluginManager#list`
 * @param {{hasCreator?: boolean}} [opts]
 * @returns {string[]} any of 'about' | 'web' | 'fork' | 'export' | 'edit' | 'remove'
 */
export function rowActions(p, { hasCreator = true } = {}) {
  const out = ['about'];
  if (p.webAllowed && p.id) out.push('web');
  if (hasCreator) out.push('fork');
  out.push('export');
  if (p.editable && hasCreator) out.push('edit');
  if (p.removable) out.push('remove');
  return out;
}

/**
 * The small monospace note at the right of a row — or null, which is the common case.
 *
 * The manager used to print `built-in` on fifty rows, which is noise that also cost the width
 * the action icons now need. Provenance is only worth saying when it is *not* ours, because
 * then it is a trust question; and in live mode the two states that contradict the checkbox
 * ("on but never loaded", "off") have to be visible or a failed plugin looks enabled.
 *
 * @param {object} p row from `PluginManager#list`
 * @param {'select'|'live'} mode
 * @returns {?string}
 */
export function rowMeta(p, mode) {
  if (mode === 'live') {
    if (!p.enabled) return 'disabled';
    if (!p.activated) return 'failed';
  }
  // 'built-in' is the default and says nothing; a deployment's own plugin, a URL, a file or
  // something authored here all change how much you should trust the row.
  return p.origin && p.origin !== 'built-in' ? originMeta(p) : null;
}

/**
 * The list, cut into sections — the search and discipline behaviour, without the DOM.
 *
 * Takes the manager's analysis-aware matching rather than the launcher's substring test, so
 * typing *Levene* reaches the plugin that has Levene's test and not merely the ones with the
 * word in their keywords (#183). A query that named an analysis outranks the discipline
 * dropdown: the plugins that actually PROVIDE what was typed lead.
 *
 * @param {object[]} list
 * @param {{query?: string, discipline?: string}} [opts]
 * @returns {{sections: {title: string, items: object[]}[], hits: Map<string,string[]>}}
 */
export function pickerSections(list, { query = '', discipline = 'All' } = {}) {
  const q = String(query || '').trim();
  const hits = new Map();
  const items = (list || []).filter((p) => {
    const m = matchPlugin(p, q);
    if (m.hit && m.items.length) hits.set(p.key, m.items);
    return m.hit;
  });
  if (!items.length) return { sections: [], hits };

  const providers = items.filter((p) => hits.has(p.key));
  if (q && providers.length && providers.length < items.length) {
    return {
      sections: [
        { title: 'Adds what you searched for', items: providers },
        { title: 'Other matches', items: items.filter((p) => !hits.has(p.key)) },
      ],
      hits,
    };
  }
  if (discipline && discipline !== 'All') {
    const inField = (p) => (p.disciplines || []).includes(discipline);
    const pinned = items.filter(inField);
    const rest = items.filter((p) => !inField(p));
    const sections = [];
    if (pinned.length) sections.push({ title: `Recommended for ${discipline}`, items: pinned });
    sections.push({ title: pinned.length ? 'All other plugins' : 'All plugins', items: rest });
    return { sections, hits };
  }
  return { sections: [{ title: 'All plugins', items }], hits };
}

/** Group rows by category, each group's plugins sorted by name. */
export function groupByCategory(items) {
  const byCat = new Map();
  for (const p of items) {
    const c = p.category || 'Other';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  return [...byCat.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({
      category: c,
      items: byCat.get(c).sort((x, y) => (x.name || '').localeCompare(y.name || '')),
    }));
}

// --- the component -----------------------------------------------------------

export class PluginPicker {
  #plugins;
  #mode;
  /** @type {Set<string>} the desired set — `'select'` mode only. */
  #selected = new Set();
  #onChange = null;
  #headLead = null;
  #root = null;
  #listBox = null;
  #searchEl = null;
  #discSel = null;
  #noteEl = null;
  #errEl = null;
  #discipline = 'All';
  #hits = new Map();
  /** The catalogue this render is working from — re-read on {@link PluginPicker#refresh}. */
  #list = [];

  /**
   * @param {object} o
   * @param {import('./plugin-manager.js').PluginManager} o.plugins
   * @param {'select'|'live'} [o.mode]
   * @param {Iterable<string>} [o.selected] initial desired set (`'select'` mode)
   * @param {(selected: Set<string>) => void} [o.onChange] fired on every selection edit
   * @param {?Node} [o.headLead] a host node to sit first in the filter row (the launcher's
   *   "Cataloguing plugins…" indicator, which belongs to the loading screen, not here)
   */
  constructor({ plugins, mode = 'live', selected = null, onChange = null, headLead = null }) {
    this.#plugins = plugins;
    this.#mode = mode === 'select' ? 'select' : 'live';
    this.#selected = new Set(selected || []);
    this.#onChange = onChange;
    this.#headLead = headLead;
  }

  /** The desired set (`'select'` mode). Live, not a copy — the hosts read it on commit. */
  get selected() {
    return this.#selected;
  }

  /** Replace the desired set and re-render — how a host seeds from a project or a source. */
  setSelected(keys) {
    this.#selected = new Set(keys || []);
    this.#render();
    this.#onChange?.(this.#selected);
  }

  /** Build the UI into `container` and render. @returns {HTMLElement} the picker's root */
  mount(container) {
    injectStyles();
    this.#list = this.#plugins.list();
    const root = el('div', null, 'ctp');
    this.#root = root;

    // --- filter row -----------------------------------------------------
    const head = el('div', null, 'ctp__head');
    if (this.#headLead) head.append(this.#headLead);
    this.#discSel = document.createElement('select');
    this.#discSel.className = 'ctp__discipline';
    this.#discSel.setAttribute('aria-label', 'Field / discipline');
    const disciplines = [...new Set(this.#list.flatMap((p) => p.disciplines || []))].sort();
    this.#discSel.replaceChildren(new Option('All disciplines', 'All'));
    for (const d of disciplines) this.#discSel.append(new Option(d, d));
    this.#discSel.addEventListener('change', () => {
      this.#discipline = this.#discSel.value;
      this.#render();
    });
    head.append(this.#discSel);
    head.append(...this.#buildPresetControls());

    this.#searchEl = document.createElement('input');
    this.#searchEl.type = 'search';
    this.#searchEl.className = 'ctp__search';
    this.#searchEl.placeholder = 'Search plugins or analyses…';
    this.#searchEl.autocomplete = 'off';
    this.#searchEl.setAttribute('aria-label', 'Search plugins or analyses');
    this.#searchEl.addEventListener('input', () => this.#render());
    head.append(this.#searchEl);
    root.append(head);

    root.append(this.#buildAddRow());

    this.#noteEl = el('p', null, 'ctp__note');
    this.#noteEl.hidden = true;
    this.#noteEl.setAttribute('role', 'status');
    this.#errEl = el('div', null, 'ctp__err');
    this.#errEl.hidden = true;
    this.#errEl.setAttribute('role', 'alert');
    this.#listBox = el('div', null, 'ctp__list');
    root.append(this.#noteEl, this.#errEl, this.#listBox);

    container.append(root);
    this.#render();
    return root;
  }

  /** Re-read the catalogue and re-render (after an add, a remove, or a live toggle). */
  refresh() {
    this.#list = this.#plugins.list();
    this.#render();
  }

  focusSearch() {
    this.#searchEl?.focus();
  }

  /** The status line: preset outcomes, bulk results, anything non-fatal. */
  note(msg, warn = false) {
    if (!this.#noteEl) return undefined;
    this.#noteEl.textContent = msg || '';
    this.#noteEl.hidden = !msg;
    this.#noteEl.classList.toggle('is-warn', !!warn);
    return undefined;
  }

  /** Wipe both lines before acting. A status line that outlives the action it describes is
   * worse than none — "Deactivated 1 plugin." sitting beside a list where nothing changed
   * (a declined confirm) reads as a report of what just happened. */
  #clearStatus() {
    this.note('');
    this.setError('');
  }

  /** The error line (role=alert): a failed add, export or toggle. */
  setError(msg) {
    if (!this.#errEl) return;
    this.#errEl.textContent = msg || '';
    this.#errEl.hidden = !msg;
  }

  // --- rendering -------------------------------------------------------------

  #render() {
    if (!this.#listBox) return;
    const { sections, hits } = pickerSections(this.#list, {
      query: this.#searchEl?.value || '',
      discipline: this.#discipline,
    });
    this.#hits = hits;
    this.#listBox.replaceChildren();
    if (!sections.length) {
      this.#listBox.append(el('p', 'No plugins match your search.', 'ctp__empty'));
      return;
    }
    for (const sec of sections) this.#listBox.append(this.#section(sec));
  }

  #section({ title, items }) {
    const wrap = el('div', null, 'ctp__section');
    const head = el('div', null, 'ctp__sectionhead');
    head.append(el('span', title, 'ctp__sectiontitle'));
    const keys = items.map((p) => p.key);
    const all = el('button', 'Select all', 'ctp__linkbtn');
    const none = el('button', 'None', 'ctp__linkbtn');
    all.type = none.type = 'button';
    // Scoped to THIS section's keys, which is why they live in the section header and the
    // presets do not: a preset spans the whole picker.
    all.addEventListener('click', () => void this.#bulk(keys, true));
    none.addEventListener('click', () => void this.#bulk(keys, false));
    head.append(all, none);
    wrap.append(head);

    const grid = el('div', null, 'ctp__grid');
    for (const group of groupByCategory(items)) {
      // Keep a category label with its plugins in one column block, so a single-plugin
      // category doesn't float its lone row beside the header.
      const g = el('div', null, 'ctp__catgroup');
      g.append(el('div', group.category, 'ctp__cat'));
      for (const p of group.items) g.append(this.#row(p));
      grid.append(g);
    }
    if (!items.length) grid.append(el('div', 'None.', 'ctp__cat'));
    wrap.append(grid);
    return wrap;
  }

  #row(p) {
    // The row is a wrapper, not just the label: the action buttons have to sit OUTSIDE the
    // <label>, or tapping one would toggle the checkbox the label is bound to.
    const row = el('div', null, 'ctp__row');
    const lead = el('span', null, 'ctp__lead');
    const label = el('label', null, 'ctp__main');
    const adds = addsTooltip(p);
    if (adds) label.title = adds; // a good quick read with a pointer; never the only path
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.#mode === 'live' ? !!p.enabled : this.#selected.has(p.key);
    cb.addEventListener('change', () => void this.#toggle(p, cb));
    label.append(cb, el('span', p.name, 'ctp__name'));
    // Version badge: a visible confirmation that a freshly-deployed plugin file actually
    // loaded — bump the manifest's `version` and watch this change (#91).
    label.append(el('span', `v${p.version ?? '1'}`, 'ctp__ver'));
    lead.append(label);
    // Name the analysis that answered the search, right next to the box that enables it —
    // that is the whole of "what do I enable to do X?" (#183).
    const matched = this.#hits.get(p.key) || [];
    if (matched.length) lead.append(el('span', `adds: ${matched.join(' · ')}`, 'ctp__hit'));

    const right = el('span', null, 'ctp__right');
    const meta = rowMeta(p, this.#mode);
    if (meta) right.append(el('span', meta, 'ctp__meta'));
    // Version-mismatch badge (warn-and-allow). Live mode only: compat is known after load.
    if (this.#mode === 'live' && p.activated
        && (p.apiCompat === 'older' || p.apiCompat === 'newer')) {
      const badge = el('span', p.apiCompat === 'older' ? '⚠ old API' : '⚠ new API', 'ctp__compat');
      badge.title = p.apiCompat === 'older'
        ? 'Built for an older version of CrossTab — may not work correctly.'
        : 'Built for a newer version of CrossTab — may not work correctly.';
      right.append(badge);
    }
    for (const act of rowActions(p, { hasCreator: !!this.#plugins.creator })) {
      right.append(this.#actionButton(act, p));
    }
    row.append(lead, right);
    return row;
  }

  #actionButton(act, p) {
    const SPEC = {
      about: ['ⓘ', 'What this plugin adds, and how to use it', `What ${p.name} adds, and how to use it`],
      web: ['🌐', 'Network access allowed — click to revoke', `Revoke network access for ${p.name}`],
      fork: ['⧉', 'Make an editable copy', `Make an editable copy of ${p.name}`],
      export: ['⬇', 'Export this plugin to a file (shareable; re-add with “Add from file”). Multi-file plugins export as a .ctplugin package.', `Export ${p.name}`],
      edit: ['✎', 'Edit this plugin', `Edit ${p.name}`],
      remove: ['✕', 'Remove this plugin', `Remove ${p.name}`],
    };
    const [glyph, title, aria] = SPEC[act];
    const btn = el('button', glyph, `ctp__act ctp__act--${act}`);
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', aria);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.#runAction(act, p);
    });
    return btn;
  }

  async #runAction(act, p) {
    this.#clearStatus();
    const { creator } = this.#plugins;
    try {
      if (act === 'about') return openPluginAbout(p);
      if (act === 'web') {
        this.#plugins.revokeWeb(p.id);
        return this.refresh();
      }
      if (act === 'fork') {
        const spec = await this.#plugins.prepareFork(p.key);
        return creator?.open(spec, () => this.refresh());
      }
      if (act === 'export') return await this.#plugins.exportToFile(p.key);
      if (act === 'edit') {
        const spec = await this.#plugins.prepareEdit(p.key);
        return creator?.open(spec, () => this.refresh());
      }
      if (act === 'remove') {
        await this.#plugins.removePlugin(p.key);
        this.#selected.delete(p.key);
        return this.refresh();
      }
    } catch (err) {
      this.setError(`${p.name}: ${err.message}`);
    }
    return undefined;
  }

  /** One checkbox. In `'select'` mode it edits a set; in `'live'` mode it acts now. */
  async #toggle(p, cb) {
    this.#clearStatus();
    if (this.#mode === 'select') {
      if (cb.checked) this.#selected.add(p.key); else this.#selected.delete(p.key);
      this.#onChange?.(this.#selected);
      return;
    }
    cb.disabled = true;
    try {
      if (cb.checked) {
        await this.#plugins.setEnabled(p.key, true);
      } else {
        // Deactivating live: if the plugin holds data in the open project, ask what should
        // happen to it before anything is unloaded (#118). A cancel leaves the row as it was.
        const went = await this.#plugins.deactivateFromPicker(p);
        if (!went) {
          cb.checked = true;
          cb.disabled = false;
          return;
        }
      }
    } catch (err) {
      this.setError(`Toggle failed: ${err.message}`);
    }
    this.refresh();
  }

  /** A section's Select all / None. */
  async #bulk(keys, on) {
    this.#clearStatus();
    if (this.#mode === 'select') {
      for (const k of keys) {
        if (on) this.#selected.add(k); else this.#selected.delete(k);
      }
      this.#onChange?.(this.#selected);
      this.#render();
      return undefined;
    }
    // Live: this is dozens of activations (or unloads), not a set edit — so it says how many
    // and asks when the number is large enough to be a surprise.
    const byKey = new Map(this.#list.map((p) => [p.key, p]));
    const changing = keys.filter((k) => byKey.has(k) && !!byKey.get(k).enabled !== on);
    if (!changing.length) {
      return this.note(on ? 'Those are all on already.' : 'Those are all off already.');
    }
    if (changing.length > BULK_CONFIRM_AT
      && !confirm(`${on ? 'Activate' : 'Deactivate'} ${changing.length} plugins now?`)) {
      return undefined;
    }
    const { changed, held } = await this.#plugins.setManyEnabled(changing, on);
    this.refresh();
    return this.note(
      `${on ? 'Activated' : 'Deactivated'} ${changed.length} plugin${changed.length === 1 ? '' : 's'}.`
      + (held.length
        ? ` Left on: ${held.join(', ')} — ${held.length === 1 ? 'it holds' : 'they hold'} data in `
          + 'this project, so untick those individually to decide what happens to it.'
        : ''),
      held.length > 0,
    );
  }

  // --- add / create ----------------------------------------------------------

  #buildAddRow() {
    const wrap = el('div', null, 'ctp__add');
    const mk = (text, fn) => {
      const b = el('button', text, 'ctp__addbtn');
      b.type = 'button';
      b.addEventListener('click', () => void fn());
      return b;
    };
    // On BOTH surfaces. The owner was explicitly unconvinced that authoring belongs only
    // in-session — "an argument I'm not entirely convinced of yet" — so the default is that
    // everything appears on both, and anything omitted needs a reason written down.
    if (this.#plugins.creator) {
      wrap.append(mk('+ Create new…', () => {
        this.setError('');
        this.#plugins.creator.open(null, () => this.refresh());
      }));
    }
    wrap.append(mk('+ Add from URL…', async () => {
      this.setError('');
      try {
        const added = await this.#plugins.addFromUrlPrompt();
        if (added) this.#afterAdd(added);
      } catch (err) { this.setError(err.message); }
    }));
    wrap.append(mk('+ Add from file…', async () => {
      this.setError('');
      try {
        const added = await this.#plugins.addFromFilePrompt();
        if (added) this.#afterAdd(added);
      } catch (err) { this.setError(err.message); }
    }));
    return wrap;
  }

  /**
   * A plugin someone just added is a plugin they want. In `'select'` mode nothing is running,
   * so adding it without ticking it would leave them to hunt for it in the list they just
   * changed — tick it, and say so.
   */
  #afterAdd(key) {
    if (this.#mode === 'select') this.#selected.add(key);
    this.refresh();
    const row = this.#list.find((p) => p.key === key);
    this.note(`Added “${row?.name || key}”${this.#mode === 'select' ? ' and selected it' : ''}.`);
    this.#onChange?.(this.#selected);
  }

  // --- presets ---------------------------------------------------------------

  /**
   * The preset controls (#162): a dropdown of saved plugin sets plus Save / Rename / Delete /
   * Export / Import.
   *
   * On both surfaces now. In-session they arguably matter MORE than at launch — *"switch me to
   * the qualitative set"* mid-project is the natural use, and a course handbook whose chapter
   * one says "import this file" shouldn't require restarting the app.
   *
   * They sit beside the discipline and filter controls, NOT beside the `Select all` / `None`
   * links, which are rendered per SECTION and scoped to that section's keys. A preset spans the
   * whole picker, so putting it in a section header would claim a scope it does not have.
   *
   * @returns {HTMLElement[]} the controls, for the filter row
   */
  #buildPresetControls() {
    const sel = document.createElement('select');
    sel.className = 'ctp__preset';
    sel.setAttribute('aria-label', 'Plugin preset');
    sel.hidden = true;
    const mkLink = (text, hidden = false) => {
      const b = el('button', text, 'ctp__linkbtn');
      b.type = 'button';
      b.hidden = hidden;
      return b;
    };
    const saveBtn = mkLink('Save preset…');
    const renameBtn = mkLink('Rename', true);
    const delBtn = mkLink('Delete', true);
    const exportBtn = mkLink('Export…', true);
    const importBtn = mkLink('Import…');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;

    const fill = (keep = '') => {
      const saved = listPresets();
      sel.replaceChildren();
      sel.append(new Option('Plugin preset…', ''));
      for (const p of saved) sel.append(new Option(p.name, p.name));
      sel.value = saved.some((p) => p.name === keep) ? keep : '';
      const chosen = !!sel.value;
      renameBtn.hidden = !chosen;
      delBtn.hidden = !chosen;
      exportBtn.hidden = !chosen;
      sel.hidden = saved.length === 0; // nothing saved yet: just the Save link
    };

    sel.addEventListener('change', () => {
      const preset = listPresets().find((p) => p.name === sel.value);
      renameBtn.hidden = !preset;
      delBtn.hidden = !preset;
      exportBtn.hidden = !preset;
      if (!preset) return this.note('');
      return this.#applyPreset(preset);
    });

    saveBtn.addEventListener('click', async () => {
      const plugins = presetFromSelection(this.#list, this.#currentKeys());
      if (!plugins.length) return this.note('Nothing is selected to save.', true);
      const name = await promptText({
        title: 'Save plugin preset',
        hint: `${plugins.length} plugin${plugins.length === 1 ? '' : 's'} selected. Presets are yours, on this device, and work with any start choice.`,
        label: 'Preset name',
        value: sel.value || '',
        confirm: 'Save',
      });
      if (!name) return undefined;
      // Overwrite is offered rather than silently making a second preset with the same name.
      if (presetExists(name) && !confirm(`Replace the preset “${name}”?`)) return undefined;
      try {
        savePreset(name, plugins);
        fill(name);
        return this.note(`Saved “${name}” — ${plugins.length} plugins.`);
      } catch (err) {
        return this.note(err.message, true);
      }
    });

    renameBtn.addEventListener('click', async () => {
      const from = sel.value;
      if (!from) return undefined;
      const to = await promptText({
        title: 'Rename preset', label: 'New name', value: from, confirm: 'Rename',
      });
      if (!to || to === from) return undefined;
      try {
        renamePreset(from, to);
        fill(to);
        return this.note(`Renamed to “${to}”.`);
      } catch (err) {
        return this.note(err.message, true);
      }
    });

    delBtn.addEventListener('click', () => {
      const name = sel.value;
      if (!name || !confirm(`Delete the preset “${name}”? The plugins stay as they are.`)) return;
      deletePreset(name);
      fill('');
      this.note(`Deleted “${name}”.`);
    });

    // Export / import a preset as a small JSON file (#162 phase 2). The use the owner named is
    // a course handbook whose chapter one says "import this file to enable the plugins you'll
    // need" — so the file is a teaching artefact, and importing has to be one step.
    exportBtn.addEventListener('click', () => {
      const preset = listPresets().find((p) => p.name === sel.value);
      if (!preset) return;
      downloadFile(presetFileName(preset.name), 'application/json', exportPresetFile(preset));
      this.note(`Exported “${preset.name}” — hand that file to anyone running CrossTab.`);
    });

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // so the same file can be picked again after a fix
      if (!file) return undefined;
      let preset;
      try {
        preset = parsePresetFile(await file.text());
      } catch (err) {
        return this.note(err.message, true);
      }
      // A file cannot bring plugins with it — it names them. So importing is safe in a way
      // worth being plain about: it selects from what this install already has, and says what
      // it could not find.
      if (presetExists(preset.name)
        && !confirm(`Replace your preset “${preset.name}” with the one in this file?`)) {
        return undefined;
      }
      savePreset(preset.name, preset.plugins);
      fill(preset.name);
      // Apply it straight away: "import this file to enable the plugins you'll need" is one
      // step, not two.
      return this.#applyPreset(preset, 'Imported');
    });

    fill('');
    return [sel, saveBtn, renameBtn, delBtn, exportBtn, importBtn, fileInput];
  }

  /** The keys a preset would be saved from — the desired set, or what is live. */
  #currentKeys() {
    return this.#mode === 'select'
      ? this.#selected
      : new Set(this.#list.filter((p) => p.enabled).map((p) => p.key));
  }

  /**
   * Apply a preset. Infra (codecs/importers/exporters) is unioned in rather than left to the
   * preset: one saved before a codec existed must not leave someone unable to open that file
   * type. Missing plugins are REPORTED, never quietly dropped — the user picked them.
   */
  async #applyPreset(preset, verb = 'Applied') {
    this.#clearStatus(); // a declined switch must not leave the last one's report standing
    const { keys, missing } = resolvePreset(preset, this.#list, {
      infraCategories: INFRA_CATEGORIES,
    });
    const tail = missing.length ? ` Not installed here: ${missing.join(', ')}` : '';
    if (this.#mode === 'select') {
      // A chooser: applying immediately is right, and a second confirmation gesture would be
      // the superfluous step #161 objects to elsewhere.
      this.setSelected(keys);
      return this.note(
        `${verb} “${preset.name}” — ${keys.size} plugins selected.${tail}`, missing.length > 0,
      );
    }
    // Live, a preset switches the running toolkit — a bigger act than ticking one box, and one
    // that can unload a plugin holding project data, so it says what it will do and asks.
    const on = this.#list.filter((p) => !p.enabled && keys.has(p.key)).map((p) => p.key);
    const off = this.#list.filter((p) => p.enabled && !keys.has(p.key)).map((p) => p.key);
    if (!on.length && !off.length) {
      return this.note(`“${preset.name}” is already what's running.${tail}`, missing.length > 0);
    }
    if (!confirm(`Switch to “${preset.name}”? ${on.length} to activate, ${off.length} to deactivate.`)) {
      return undefined;
    }
    const added = await this.#plugins.setManyEnabled(on, true);
    const removed = await this.#plugins.setManyEnabled(off, false);
    this.refresh();
    return this.note(
      `${verb} “${preset.name}” — ${added.changed.length} on, ${removed.changed.length} off.`
      + (removed.held.length ? ` Left on: ${removed.held.join(', ')} (data in this project).` : '')
      + tail,
      missing.length > 0 || removed.held.length > 0,
    );
  }
}

/**
 * Open the picker as a standalone modal — Edit ▸ Plugins, and anything that hits a
 * "you don't have that plugin" wall (#156).
 *
 * @param {import('./plugin-manager.js').PluginManager} plugins
 * @returns {PluginPicker}
 */
export function openPluginModal(plugins) {
  injectStyles();
  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog ct-dialog--wide ctp-dialog';
  const form = el('form', null, 'ct-dialog__form');
  form.method = 'dialog';
  form.append(el('h2', 'Plugins', 'ct-dialog__title'));
  form.append(el('p',
    'Toggle, add, or remove plugins — changes are live and saved across sessions. Added '
    + 'plugins run sandboxed (no network of their own) but can read the data you load here, '
    + 'so only add ones you trust.', 'ct-dialog__hint'));
  form.append(el('p',
    'Looking for a particular analysis? Search for it by name — Kaplan–Meier, '
    + 'Hosmer–Lemeshow, Levene — and the plugin that adds it is listed, switched on or off.',
    'ct-dialog__hint'));
  const body = el('div', null, 'ctp-dialog__body');
  form.append(body);
  const menu = el('menu', null, 'ct-dialog__buttons');
  const done = el('button', 'Done', 'ct-dialog__primary');
  done.type = 'submit';
  done.value = 'close';
  menu.append(done);
  form.append(menu);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);

  const picker = new PluginPicker({ plugins, mode: 'live' });
  picker.mount(body);
  dialog.showModal();
  picker.focusSearch();
  return picker;
}

// --- helpers -----------------------------------------------------------------

/**
 * A one-field text prompt as a modal. Lives here because the preset controls are its only
 * callers; it moved out of the launcher with them.
 */
export function promptText({ title, label, hint = '', value = '', confirm: confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ct-dialog';
    const form = el('form', null, 'ct-dialog__form');
    form.method = 'dialog';
    form.append(el('h2', title, 'ct-dialog__title'));
    if (hint) form.append(el('p', hint, 'ct-dialog__hint'));
    const lab = el('label', null, 'ct-field');
    lab.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%; margin-top:4px;';
    lab.append(input);
    form.append(lab);
    const menu = el('menu', null, 'ct-dialog__buttons');
    const cancel = el('button', 'Cancel', null);
    cancel.value = 'cancel';
    cancel.type = 'submit';
    const ok = el('button', confirmLabel, 'ct-dialog__primary');
    ok.value = 'ok';
    ok.type = 'submit';
    menu.append(cancel, ok);
    form.append(menu);
    d.append(form);
    d.addEventListener('close', () => {
      const text = d.returnValue === 'ok' ? input.value.trim() : '';
      d.remove();
      resolve(text || null);
    });
    document.body.append(d);
    d.showModal();
    input.focus();
    input.select();
  });
}

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
}

let stylesInjected = false;
/**
 * One stylesheet for one component. Injected rather than written into index.html because the
 * module has to style itself wherever it is mounted — the launcher's card never loaded the
 * manager's CSS and vice versa, which is part of how the two surfaces drifted apart visually.
 */
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .ctp { display: flex; flex-direction: column; min-height: 0; flex: 1; }
    .ctp__head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; flex-wrap: wrap; }
    .ctp__discipline, .ctp__search, .ctp__preset { font: inherit; font-size: 13px; padding: 6px 8px;
      border: 1px solid var(--line, #d8dde2); border-radius: 6px; background: #fff; color: inherit; }
    .ctp__search { flex: 1; min-width: 140px; }
    .ctp__preset { max-width: 180px; }
    .ctp__linkbtn { font: inherit; font-size: 12px; background: none; border: 0;
      color: var(--accent, #2572a5); cursor: pointer; padding: 2px 4px; }
    .ctp__linkbtn:hover { text-decoration: underline; }
    .ctp__add { display: flex; gap: 8px; margin: 0 0 8px; flex-wrap: wrap; }
    .ctp__addbtn { font: inherit; font-size: 12.5px; padding: 5px 10px; cursor: pointer;
      border: 1px solid var(--line, #d8dde2); border-radius: 6px; background: #fff; }
    .ctp__addbtn:hover { background: #f0f7ff; }
    .ctp__note { margin: 0 0 8px; font-size: 12px; color: #41505e; }
    .ctp__note.is-warn { color: #7a4e00; }
    .ctp__err { margin: 0 0 8px; font-size: 12.5px; color: #8a1c1c; background: #fdecec;
      border: 1px solid #f0c0c0; border-radius: 6px; padding: 6px 8px; }
    .ctp__list { flex: 1; min-height: 140px; overflow-y: auto; background: #fff;
      border: 1px solid var(--line, #d8dde2); border-radius: 8px; padding: 8px 10px; }
    .ctp__section { margin: 0 0 10px; }
    .ctp__sectionhead { display: flex; align-items: center; gap: 8px; position: sticky; top: -8px;
      background: #fff; padding: 4px 0 2px; z-index: 1; }
    .ctp__sectiontitle { font-size: 12px; font-weight: 700; color: #41505e; flex: 1; }
    .ctp__grid { columns: 2; column-gap: 22px; }
    @media (max-width: 880px) { .ctp__grid { columns: 1; } }
    .ctp__catgroup { break-inside: avoid; -webkit-column-break-inside: avoid; display: block; }
    .ctp__cat { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em;
      color: #646e77; margin: 8px 0 2px; }
    .ctp__row { display: flex; align-items: center; gap: 2px; break-inside: avoid; }
    .ctp__lead { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
    .ctp__main { display: flex; align-items: center; gap: 7px; padding: 3px 2px; min-width: 0;
      font-size: 13.5px; cursor: pointer; border-radius: 4px; }
    .ctp__main:hover { background: #f4f8fc; }
    .ctp__name { color: #1a1a1a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ctp__ver { font: 11px ui-monospace, Menlo, monospace; color: #5d6771; background: #eef1f4;
      border-radius: 4px; padding: 0 5px; flex: none; }
    .ctp__hit { font-size: 12px; color: var(--accent, #2572a5); padding-left: 25px; }
    .ctp__right { display: flex; align-items: center; gap: 1px; flex: none; }
    .ctp__meta { font: 11px ui-monospace, Menlo, monospace; color: #5d6771; margin-right: 3px; }
    .ctp__act { font: inherit; font-size: 13px; line-height: 1; background: none; border: 0;
      border-radius: 5px; padding: 3px 4px; color: #5d6771; cursor: pointer; }
    .ctp__act:hover, .ctp__act:focus-visible { color: var(--accent, #2572a5); background: #eef4fa; }
    .ctp__act--remove:hover, .ctp__act--web:hover { color: #96242a; background: #fdecec; }
    .ctp__compat { color: #fff; background: #b5342b; font-size: 11px; font-weight: 600;
      padding: 1px 6px; border-radius: 8px; cursor: help; white-space: nowrap; margin-right: 3px; }
    .ctp__empty { color: #5d6771; padding: 12px 2px; }
    /* The standalone modal: wider than .ct-dialog--wide's 640px, which the two-column grid
       plus the row's action icons cannot fit. */
    .ctp-dialog.ct-dialog--wide { max-width: min(900px, 94vw); width: 94vw; }
    .ctp-dialog__body { display: flex; flex-direction: column; min-height: 0; max-height: 60vh; }
  `;
  document.head.append(style);
}
