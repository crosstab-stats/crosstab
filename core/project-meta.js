/**
 * @file project-meta.js
 * How a project describes itself in a list, in one voice.
 *
 * ## Why it is its own module
 *
 * Four surfaces list projects — the launcher rail, the sidebar's Recent zone, the project
 * manager, and the copy-to-project destination picker — and before this each wrote its own
 * version of the same two facts. The manager said `name · Dropbox` and no date at all;
 * copy-to-project had a private `datasetsPhrase()` ("2 datasets" / "unknown size") and a
 * private `stamp()`; the other two had nothing until 2026-10-10. Three spellings of one
 * sentence, drifting apart independently.
 *
 * The owner's reason for unifying them, which is the better statement of it than
 * "deduplicate" (2026-10-10): *"the more we can unify disparate parts of the app the easier
 * it becomes to maintain (one surface to fix instead of four) and the stronger the 'voice'
 * of the app becomes thanks to unified style."*
 *
 * It lives apart from `project-sync.js` because `copy-to-project.js` needs it and
 * project-sync imports copy-to-project — importing back would close a cycle for the sake
 * of a string formatter.
 *
 * ## What it does NOT unify
 *
 * The CONTROL each surface wraps around this text stays its own. The manager's row is a
 * button plus a verb group with an inert row for the open project; the sidebar's is a
 * clickable row; copy-to-project's is an option in a select. Pushing one component across
 * all four would have meant teaching it disabled rows, verb slots and three interaction
 * models — the point at which a shared thing becomes a configuration surface and costs more
 * than the duplication it removed. The data is shared; the widget is not.
 */

/**
 * How a project describes itself in a list: when it was last worked on, and how big it is.
 *
 * ## Why these two facts
 *
 * The job of this line is to tell apart rows whose NAMES do not. The owner's observation
 * (2026-10-10) is that the dataset count mostly cannot: somebody with five "Untitled
 * project" rows is almost certainly doing small one-dataset work, so "1 dataset" five times
 * discriminates nothing. Date and size do — "5 Oct, 5,456 rows" against "6 Jul, 56 rows" is
 * the difference between the main study and the pilot, at a glance.
 *
 * ## What it leaves out
 *
 * Every part is optional and simply absent when unknown, never rendered as a zero. A
 * project saved before row counts were recorded has none, and a remembered location not
 * written since has none either; "0 rows" would be a lie, while a date on its own is merely
 * less helpful. Shared by the sidebar's Recent list and the Open-project modal so one
 * project cannot describe itself two ways depending on which list you opened.
 *
 * @param {{savedAt?: number, datasetCount?: number|null, rowCount?: number|null}} entry
 * @param {{date?: 'relative'|'absolute'|'none', now?: number}} [opts]
 *   `relative` (the default) is relative-under-a-week, which is when "which one was I just
 *   in" is the question being asked; `absolute` suits a roomy surface where someone is
 *   deliberately comparing versions; `none` is for a row already saying something better
 *   in that slot — the manager's open project says "Open now", which beats any date.
 */
export function projectMetaLine(entry, { date = 'relative', now = Date.now() } = {}) {
  const parts = [];
  const when = Number(entry?.savedAt) || 0;
  if (when && date !== 'none') {
    parts.push(date === 'absolute' ? new Date(when).toLocaleString() : relativeDay(when, now));
  }
  const size = [];
  const ds = entry?.datasetCount;
  if (Number.isFinite(ds)) size.push(`${ds} dataset${ds === 1 ? '' : 's'}`);
  const rows = entry?.rowCount;
  if (Number.isFinite(rows) && rows > 0) size.push(`${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`);
  if (size.length) parts.push(size.join(', '));
  return parts.join(' \u00b7 ');
}

/**
 * A date a person can act on: relative while that is the more useful answer, absolute once
 * it stops being. "3 days ago" beats a date when you are hunting for what you had open this
 * week; past that, "5 Oct 2026" is the form people actually remember.
 */
function relativeDay(ts, now) {
  const abs = () => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const ms = now - ts;
  if (ms < 0) return abs(); // a clock skew or a file from the future: do not say "in -3 days"
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return abs();
}