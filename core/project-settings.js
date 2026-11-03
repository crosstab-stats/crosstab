/**
 * @file project-settings.js
 * The settings that belong to a PROJECT rather than to this browser (#207).
 *
 * ## Why these are not in the settings registry
 *
 * `core/settings.js` holds device preferences: one value per browser, stored in
 * `localStorage`, applying to every project. A project setting is a different kind of
 * thing, and the frequency weight is the clearest example — `core/data-store.js` calls it
 * *"a property of the DATASET, not of a variable and not of the reader, so it is folded
 * from the log like everything else and travels with the project."*
 *
 * That difference is load-bearing rather than taxonomic. Because setting a weight is an
 * **op**, four things are true that a `localStorage` key could not give it:
 *
 *  - it is undoable,
 *  - it shows up in History as a step,
 *  - it exports in the analysis script,
 *  - it merges to collaborators.
 *
 * And the scope is per-DATASET, not per-project: two datasets in one project routinely
 * want different weights, so a single stored value would be wrong even within one project.
 *
 * ## So why surface them on the Settings screen at all
 *
 * Because the owner went looking for the weight there and found silence, and because the
 * answer "it lives somewhere else" is only satisfying if the screen can also take you
 * there — or, better, let you do it. The owner's call (2026-11-03): *"Could we design the
 * project-level settings (such as weights) as viewable/settable in the settings screen,
 * but have a change there emit an op in the project log just like it would if set
 * elsewhere?"*
 *
 * Which is exactly right, and needs no new machinery: a descriptor's `set` calls the same
 * `DataStore#setWeight` the Data menu calls, so the op, the History row, the undo entry
 * and the merge all happen because they always did. The screen becomes a second doorway to
 * one path rather than a second path.
 *
 * ## Why a descriptor list and not a registry
 *
 * There is one of these today. A registry with a declaration schema, keys and a decode
 * step would be a framework for a single item — and the device registry already exists to
 * copy from if a second arrives. What this does provide is the ONE thing that was actually
 * needed: a shape the screen can render without knowing what a weight is, so adding the
 * second costs a descriptor rather than a dialog change.
 */

import { isQuantitative } from './var-role.js';

/** No weight — the stored absence, which is a real answer and not a missing one. */
const NONE = '';

/**
 * The project-scoped settings for what is open right now.
 *
 * Returns `[]` when there is no dataset: the caller renders its own "nothing open" line,
 * because an empty list and a list of controls that cannot act are different states and
 * only one of them should exist (see the guard-vs-missing-state rule).
 *
 * @param {{active: object|null}} datasets the dataset manager
 * @returns {Array<ProjectSetting>}
 */
export function projectSettings(datasets) {
  const ds = datasets?.active ?? null;
  if (!ds) return [];
  return [weightSetting(ds)].filter(Boolean);
}

/**
 * @typedef {Object} ProjectSetting
 * @property {string} id
 * @property {string} label
 * @property {string} hint
 * @property {'select'} control
 * @property {Array<[string, string]>} options
 * @property {string} value          currently stored value (`''` for none)
 * @property {string} scope          what the change applies to, for the row's subtitle
 * @property {(v: string) => Promise<void>} set
 */

/**
 * The active dataset's frequency weight.
 *
 * Eligibility is `isQuantitative`, which is the same test the Data ▸ Weight cases picker
 * applies — it asks for `types: ['numeric']`, and that role admits a variable the file
 * calls Scale even when the importer typed it `factor` (#188, the GSS weight that was
 * unselectable as a weight). Using the same predicate rather than re-deriving one is the
 * point: two definitions of "can this be a weight" is how a screen comes to offer a
 * variable the picker refuses.
 */
function weightSetting(ds) {
  const meta = typeof ds.getVariableMeta === 'function' ? ds.getVariableMeta() : [];
  const eligible = (Array.isArray(meta) ? meta : []).filter((m) => m && isQuantitative(m));
  const current = ds.weightVar ?? NONE;
  return {
    id: 'project.weight',
    label: 'Frequency weight',
    hint: 'Pre-filled into every analysis that takes a weight; you can still untick it for '
      + 'one run. Changing it here is recorded in History like any other step.',
    scope: `the dataset “${ds.name || 'this dataset'}”`,
    control: 'select',
    // "No weight" FIRST and always present: turning a weight off is the answer people
    // reach for most often after turning one on, and it must not require finding an empty
    // row at the bottom of 900 variables.
    options: [[NONE, 'No weight'], ...eligible.map((m) => [m.name, labelFor(m)])],
    value: current,
    // A weight that is set but no longer eligible (its measure changed, say) would
    // otherwise vanish from its own control. Keep it, marked, so the state is visible and
    // can be cleared.
    stale: !!current && !eligible.some((m) => m.name === current),
    // What to say about it, because the screen renders project settings without knowing
    // what any of them are.
    staleNote: 'no longer a usable weight',
    set: (v) => ds.setWeight(v === NONE ? null : v),
  };
}

/** `name` plus its label when it has one, which is how every other variable list reads. */
function labelFor(m) {
  return m.label && m.label !== m.name ? `${m.name} — ${m.label}` : m.name;
}
