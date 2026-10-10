/**
 * @file project-list.js
 * One renderer for "a list of projects you could open".
 *
 * ## Why this exists
 *
 * Three surfaces drew a project list: the launcher's rail, the sidebar's Recent zone, and
 * the project manager. The data layer was unified in August (#171, `listAllProjects()`),
 * and the sidebar and the manager both moved onto it — the launcher never did, and kept
 * its own pair of loops over `listProjects()` + `listProjectLocations()`. The visible cost
 * was that the first screen of the app showed **one list that was secretly two**: local
 * projects as a bare name, remembered locations as a glyph plus a name, in a single
 * undifferentiated column, with no date and no size while the data carried both.
 *
 * So this is not "unify three things". Two were already unified; this is the third one
 * catching up, and the row is lifted out so there is no fourth.
 *
 * ## What is shared and what is not
 *
 * Shared: the row — name, where it lives, when it was last worked on, how big it is. That
 * is the part that was diverging, and the part a reader compares across surfaces.
 *
 * Not shared, and deliberately so: **what a click means.** The sidebar opens the project
 * immediately; the launcher stages a pick that its Start button commits. That difference
 * survived a direct challenge and won on evidence — the owner, testing small-screen mode on
 * an iPhone (2026-10-10): *"I've tapped the wrong project more than once. maybe having a
 * second tap to confirm isn't such a bad thing."* A confirm step is a feature on a touch
 * target you can fat-finger, not friction to be designed away. So `onPick` is the host's,
 * and this module has no opinion about it.
 *
 * Also not shared: WHICH projects (the sidebar caps at five and drops the open one; the
 * launcher shows everything) and WHICH verbs (rename belongs to the project you are in,
 * settled 2026-10-01). Both are arguments, not branches in here.
 */

import { projectMetaLine } from './project-sync.js';

/**
 * How a row describes where it lives.
 *
 * A local project needs no marker: "in this browser" is the absence of one. Everything
 * else asks its own backend, which is what keeps this module — and the lists it draws —
 * from knowing the name of a single storage kind.
 */
export function describeProjectRow(row, makeBackend) {
  if (row.kind === 'opfs') return { kind: 'opfs', glyph: '', label: row.name, detail: '' };
  return (
    makeBackend?.(row.entry)?.describe()
    ?? { kind: 'unknown', glyph: '📍', label: row.name, detail: 'cannot reconnect' }
  );
}

/**
 * Build the list.
 *
 * @param {Array<object>} rows from `ProjectSync#listAllProjects` (or a slice of it).
 * @param {object} opts
 * @param {(entry: object) => object|null} [opts.makeBackend] to let a location describe itself.
 * @param {(row: object) => void} opts.onPick what a click on a row means to this host.
 * @param {(row: object, li: HTMLElement, nameEl: HTMLElement) => void} [opts.onRename]
 *   offered on double-click for local projects only, and only where the host passes it.
 * @param {string} [opts.emptyText] shown instead of a list when there is nothing.
 * @returns {DocumentFragment}
 */
export function renderProjectList(rows, { makeBackend, onPick, onRename, emptyText } = {}) {
  const frag = document.createDocumentFragment();
  if (!rows || !rows.length) {
    if (emptyText) {
      const p = document.createElement('div');
      p.className = 'proj__empty';
      p.textContent = emptyText;
      frag.append(p);
    }
    return frag;
  }

  const list = document.createElement('ul');
  list.className = 'proj__datasets';
  for (const row of rows) {
    const what = describeProjectRow(row, makeBackend);
    const label = row.name || what.label;
    const title = `Open ${label}${what.detail ? ` (${what.detail})` : ''}`;

    const li = document.createElement('li');
    // `--stacked` because this row carries a second line; the dataset rows elsewhere share
    // `.proj__ds` and must stay on one, so the direction is a modifier rather than a change
    // to the shared rule.
    li.className = `proj__ds proj__ds--stacked proj__ds--${what.kind}`;
    li.title = title;
    // The host's handle on a row: the launcher marks the picked one, and a test can find it.
    li.dataset.projectKey = row.key ?? '';
    const pick = () => onPick?.(row);
    li.addEventListener('click', pick);

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'proj__ds-name';
    name.textContent = what.glyph ? `${what.glyph} ${label}` : label;
    name.setAttribute('aria-label', title);
    name.addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    li.append(name);

    // The second line. All three facts are here for one reason: a list of names identifies
    // nothing when the names are "Untitled project" five times over, which is the ordinary
    // case for anyone who has not named their work. Absent parts are dropped rather than
    // shown as zero — a project saved before row counts were recorded says less, instead of
    // saying something false.
    const meta = [what.detail, projectMetaLine(row)].filter(Boolean).join(' · ');
    if (meta) {
      const m = document.createElement('span');
      m.className = 'proj__ds-meta';
      m.textContent = meta;
      li.append(m);
    }

    // Renaming a remembered location would rename the ENTRY, not the project inside it —
    // two names for one thing, and the visible one is the one that lies.
    if (onRename && row.kind === 'opfs') {
      name.addEventListener('dblclick', (e) => { e.stopPropagation(); onRename(row, li, name); });
    }

    list.append(li);
  }
  frag.append(list);
  return frag;
}

/**
 * Mark one row as the current pick, clearing any other.
 *
 * For a host whose click stages rather than opens (the launcher). Kept here so the class
 * name the list writes and the class name the host toggles cannot drift apart.
 */
export function markPickedProject(container, key) {
  for (const li of container.querySelectorAll('[data-project-key]')) {
    li.classList.toggle('is-picked', key != null && li.dataset.projectKey === String(key));
  }
}
