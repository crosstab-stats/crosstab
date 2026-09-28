/**
 * @file plugin-presets.js
 * **A working set of plugins, saved under a name** (#162).
 *
 * The picker curates on exactly one axis: `Recommended for <discipline>`, from each manifest's
 * self-declared `disciplines`. A researcher doing *qualitative psychology with a regional
 * dimension* needs CAQDAS **and** spatial **and** the usual psych set — a combination no single
 * discipline names, and one they otherwise rebuild by hand on every fresh launch. This lets
 * them save it once.
 *
 * ## Two decisions that shape the format
 *
 * **A preset stores plugins and nothing else.** The built-in launch presets conflate a data
 * source with a plugin set because they back the `?launch=` deep links; a user's preset has to
 * compose with *any* start choice — blank, a demo, a saved project — so a source would only
 * ever get in the way.
 *
 * **It records ids, with keys as a fallback.** A key is an install-location detail that will
 * not survive a repackage or a reinstall; a manifest id will ([[plugin-lifecycle-terms]]). Both
 * are written, and resolution accepts either, which is the same id-or-key matching a saved
 * project already does for its plugin list.
 *
 * ## Storage: localStorage, deliberately not the op log
 *
 * A preset is a *person's* working preference across all their projects, not a fact about any
 * one project — so it is one of the few things that correctly stays off the project log. The
 * store is injectable so every rule here is testable without a browser.
 */

/** Where presets live. */
export const PRESETS_KEY = 'crosstab.plugin.presets';

/** Longest name we will store — long enough to be descriptive, short enough for a dropdown. */
const MAX_NAME = 60;

/**
 * Every saved preset, oldest first. Never throws: a corrupt or hand-edited value reads as "no
 * presets" rather than taking the launcher down with it.
 *
 * @param {Storage} [store]
 * @returns {Array<{name: string, plugins: Array<{id: string|null, key: string|null}>}>}
 */
export function listPresets(store = globalThis.localStorage) {
  try {
    const raw = JSON.parse(store?.getItem(PRESETS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.plugins))
      .map((p) => ({
        name: p.name,
        plugins: p.plugins
          .filter((x) => x && (x.id || x.key))
          .map((x) => ({ id: x.id ?? null, key: x.key ?? null })),
      }));
  } catch {
    return [];
  }
}

/** Whether a name is already taken (case-insensitively — "Psych" and "psych" are one preset
 * to a human, and silently keeping both is how a dropdown becomes useless). */
export function presetExists(name, store = globalThis.localStorage) {
  const n = normalizeName(name);
  return !!n && listPresets(store).some((p) => normalizeName(p.name) === n);
}

/**
 * Save (or overwrite) a preset.
 *
 * @param {string} name
 * @param {Array<{id?: string|null, key?: string|null}>} plugins  the chosen plugins
 * @param {Storage} [store]
 * @returns {Array<object>} the new list
 */
export function savePreset(name, plugins, store = globalThis.localStorage) {
  const clean = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!clean) throw new Error('A preset needs a name.');
  const entries = (Array.isArray(plugins) ? plugins : [])
    .map((p) => ({ id: p?.id ?? null, key: p?.key ?? null }))
    .filter((p) => p.id || p.key);
  if (!entries.length) throw new Error('A preset needs at least one plugin.');
  const list = listPresets(store).filter((p) => normalizeName(p.name) !== normalizeName(clean));
  list.push({ name: clean, plugins: entries });
  write(list, store);
  return list;
}

/** Rename a preset. Refuses a collision rather than merging two sets under one name. */
export function renamePreset(from, to, store = globalThis.localStorage) {
  const clean = String(to ?? '').trim().slice(0, MAX_NAME);
  if (!clean) throw new Error('A preset needs a name.');
  const list = listPresets(store);
  const target = list.find((p) => normalizeName(p.name) === normalizeName(from));
  if (!target) throw new Error(`There is no preset called “${from}”.`);
  if (normalizeName(clean) !== normalizeName(from) && presetExists(clean, store)) {
    throw new Error(`A preset called “${clean}” already exists.`);
  }
  target.name = clean;
  write(list, store);
  return list;
}

/** Delete a preset. Deleting one that is already gone is not an error. */
export function deletePreset(name, store = globalThis.localStorage) {
  const list = listPresets(store).filter((p) => normalizeName(p.name) !== normalizeName(name));
  write(list, store);
  return list;
}

/**
 * Work out which plugins a preset selects, against the catalogue as it stands now.
 *
 * Three rules, and the second and third are the ones worth knowing:
 *
 *  1. **Match on id OR key**, so a reinstall that moved a plugin's file does not lose it.
 *  2. **Infrastructure is unioned in, never left to the preset.** A preset saved before the
 *     Parquet codec existed must not leave a user unable to open a Parquet file; the codecs
 *     and importers are default-on for the same reason a fresh launch has them.
 *  3. **Anything the preset names but this install does not have is REPORTED, not dropped.**
 *     The user chose those deliberately and deserves to be told they are missing — silently
 *     applying a smaller set than the one they saved is the failure to avoid.
 *
 * @param {{plugins: Array<{id?: string|null, key?: string|null}>}} preset
 * @param {Array<{key: string, id?: string|null, category?: string}>} list  `PluginManager#list()`
 * @param {{infraCategories?: Set<string>}} [opts]
 * @returns {{keys: Set<string>, missing: string[]}}
 */
export function resolvePreset(preset, list, { infraCategories } = {}) {
  const catalogue = Array.isArray(list) ? list : [];
  const wanted = Array.isArray(preset?.plugins) ? preset.plugins : [];
  const named = new Set();
  for (const p of wanted) {
    if (p?.id) named.add(p.id);
    if (p?.key) named.add(p.key);
  }
  const keys = new Set();
  for (const p of catalogue) {
    if (named.has(p.key) || (p.id && named.has(p.id))) keys.add(p.key);
    else if (infraCategories && p.category && infraCategories.has(p.category)) keys.add(p.key);
  }
  const missing = wanted
    .filter((p) => !catalogue.some((x) => (p.key && x.key === p.key) || (p.id && x.id === p.id)))
    .map((p) => p.id || p.key)
    .filter(Boolean);
  return { keys, missing };
}

/** The storable form of a chosen plugin set, from the picker's rows. */
export function presetFromSelection(list, selectedKeys) {
  const sel = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  return (Array.isArray(list) ? list : [])
    .filter((p) => sel.has(p.key))
    .map((p) => ({ id: p.id ?? null, key: p.key ?? null }));
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function write(list, store) {
  try {
    store?.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    /* quota or a private-mode store: the in-memory list still applies for this session */
  }
}

/**
 * The file form of a preset (#162 phase 2) — so a lab lead can hand one out.
 *
 * The use the owner named: a course handbook whose chapter one says *"import this file to
 * enable the plugins you'll need"*. That makes the format part of a teaching artefact, not
 * just a backup, so it is plain JSON with a version marker rather than anything clever.
 *
 * **What a preset file can and cannot do is the point.** It names plugins; it carries no
 * code and cannot install anything. Importing one selects from what this install already
 * has and REPORTS the rest — so a file from a stranger is no more dangerous than a list of
 * names, which is exactly why it is safe to hand to a class.
 *
 * IDs are what travel. A key is where the file happens to sit on the author's machine, so it
 * is written for completeness but a shared file will almost always resolve by id.
 */
export const PRESET_FILE_VERSION = 1;

/** Serialise a preset for download. */
export function exportPresetFile(preset) {
  return `${JSON.stringify({
    crosstabPreset: PRESET_FILE_VERSION,
    name: String(preset?.name ?? 'Preset'),
    plugins: (preset?.plugins || []).map((p) => ({ id: p?.id ?? null, key: p?.key ?? null })),
  }, null, 2)}
`;
}

/** A filename a student will recognise, and an LMS will not refuse. */
export function presetFileName(name) {
  const slug = String(name ?? 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `crosstab-preset-${slug || 'preset'}.json`;
}

/**
 * Read a preset file. Throws with a sentence a person can act on — this is opened from a
 * file picker, where "unexpected token" tells the reader nothing about what to do next.
 *
 * The marker is checked when present but not required: a hand-written `{name, plugins}` is
 * obviously a preset and refusing it would be pedantry.
 *
 * @param {string} text @returns {{name: string, plugins: Array<{id: string|null, key: string|null}>}}
 */
export function parsePresetFile(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('That file is not JSON, so it is not a CrossTab preset.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A preset file holds one object with a name and a list of plugins.');
  }
  if (raw.crosstabPreset != null && Number(raw.crosstabPreset) > PRESET_FILE_VERSION) {
    throw new Error('That preset was written by a newer CrossTab than this one.');
  }
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('That preset file has no name in it.');
  const plugins = (Array.isArray(raw.plugins) ? raw.plugins : [])
    .map((p) => (typeof p === 'string' ? { id: p, key: null } : { id: p?.id ?? null, key: p?.key ?? null }))
    .filter((p) => p.id || p.key);
  if (!plugins.length) throw new Error(`“${name}” lists no plugins.`);
  return { name, plugins };
}
