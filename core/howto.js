/**
 * @file howto.js
 * The how-to system's pure core: the topic index, and the sidecar parser (#192).
 *
 * ## Why the index and the body are stored apart
 *
 * A plugin declares a small `howtoIndex` in its MANIFEST and ships the prose in a
 * markdown SIDECAR that travels with it. That split is the owner's, and the reasoning is
 * worth keeping: the manifest is cached in `localStorage` and read synchronously on every
 * boot, and re-probed in full whenever `CATALOG_VERSION` bumps — so putting guide text
 * there would put hundreds of kilobytes of prose on the startup path of a store this
 * project has already been bitten by (#150 moved plugin sources out of it for exactly
 * that reason).
 *
 * The sidecar resolves through `loader.resolveAsset`, which serves from the plugin's own
 * `.ctplugin` bundle or a same-origin sibling. So **documentation is available exactly
 * when the plugin is** — which is also the answer to the air-gap question. An earlier
 * draft argued the manifest was better *because* of air-gap; the owner corrected it:
 * telling an air-gapped user how to use a plugin they cannot reach helps nobody. Docs
 * ship with the plugin.
 *
 * ## Equality is the point
 *
 * There is ONE contributor path and core is just another client of it — the same
 * arrangement `menus.register` has. Core's own topics are declared and resolved exactly
 * the way a third-party plugin's are. An equality that lives in the mechanism cannot
 * erode the first time it is inconvenient.
 *
 * This module is DOM-free and fetch-free on purpose: ordering, validation and parsing are
 * the parts worth testing headlessly, and they are the parts a second reader of the
 * format would otherwise re-implement slightly differently.
 */

/** The sidecar's topic delimiter: a line reading `--- id: some-topic-id`.
 *
 * It MUST name a topic declared in the manifest index. That is a contract rather than a
 * convenience — an un-declared body is unreachable (nothing links to it) and a declared
 * topic with no body is a dead row in the index, so both are author errors worth
 * reporting rather than swallowing. */
const DELIM = /^-{3,}\s*id:\s*(\S+)\s*$/;

/** A topic id: the same shape as a plugin id, so it can be spoken in a `howto:` link. */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Normalise one declared index entry, or null if it cannot be trusted.
 *
 * Deliberately forgiving about what it keeps and strict about what it requires: a topic
 * with no id cannot be linked to or looked up, and a topic with no title cannot be shown,
 * so those are the only two hard requirements. Everything else degrades.
 *
 * @param {object} raw the author's entry
 * @param {{pluginId: string, pluginName?: string, howtoFile?: string}} owner
 * @returns {object|null}
 */
export function normalizeTopic(raw, owner = {}) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  if (!ID.test(id) || !title) return null;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  return {
    id,
    title,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Other',
    keywords: list(raw.keywords),
    // What must be ENABLED for this topic to be followable. Rendered as an inline
    // "Enable" rather than a warning: the owner's point was that discovering the plugin
    // you actually meant to use is the common case, not an error case.
    needs: list(raw.needs),
    seeAlso: list(raw.seeAlso),
    // Per-topic override of the plugin's single sidecar. One file per plugin is the
    // default — a packaged plugin fetches nothing at all, and for a URL plugin one round
    // trip beats one per topic — but a plugin with dozens of topics may prefer to split,
    // and that choice costs nothing to support. WATCH: if a large plugin's single file
    // ever shows up as a stall on a slow link, this is the lever.
    file: typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : (owner.howtoFile || null),
    pluginId: owner.pluginId ?? null,
    // Attribution, shown on every row. NOT a sort key: ordering by origin is precisely
    // the privilege this system exists to avoid.
    pluginName: owner.pluginName ?? owner.pluginId ?? null,
  };
}

/**
 * Every topic a catalogue declares, flattened and ordered for the index.
 *
 * Sorted by category then title, with a stable tiebreak on plugin id so two plugins
 * contributing identically-named topics do not reorder between boots. Origin never
 * enters the comparison.
 *
 * @param {Array<{id?: string, name?: string, howtoIndex?: object[], howtoFile?: string}>} catalogue
 * @returns {object[]}
 */
export function collectTopics(catalogue) {
  const out = [];
  const seen = new Set();
  for (const entry of catalogue ?? []) {
    const owner = { pluginId: entry?.id ?? null, pluginName: entry?.name ?? null, howtoFile: entry?.howtoFile };
    const declared = Array.isArray(entry?.howtoIndex) ? entry.howtoIndex : [];
    // LEGACY BRIDGE. 64 built-ins already carry a one-line `howto` written for the plugin
    // manager's magnifier, and it usually contains the GUI route and the syntax call form
    // — the two things a reader most wants. Rather than strand that content until every
    // manifest is rewritten, a plugin with a `howto` and no index contributes one topic
    // whose body is that string. An authored `howtoIndex` supersedes it entirely, which is
    // the upgrade path: write real topics and the placeholder disappears.
    //
    // Its body is INLINE, so no sidecar fetch happens for it.
    if (!declared.length && entry?.id) {
      const note = typeof entry.howto === 'string' ? entry.howto.trim() : '';
      const topic = normalizeTopic({
        id: `plugin-${entry.id}`,
        title: `Using ${entry.name ?? entry.id}`,
        category: entry.category || 'Other',
        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
        needs: [entry.id],
      }, owner);
      if (topic && !seen.has(topic.id)) {
        seen.add(topic.id);
        out.push({
          ...topic,
          file: null,
          inlineBody: note,
          // EVERY plugin has a page, because the ⓘ beside it has to lead somewhere. One
          // that documents nothing is HIDDEN from the index rather than absent from the
          // system: an infrastructure plugin (a chart-kind provider, say) would otherwise
          // pad the list with a row that teaches nobody anything.
          hidden: !note,
        });
      }
    }
    declared.forEach((raw, declaredAt) => {
      const topic = normalizeTopic(raw, owner);
      if (!topic) return;
      // A topic id has to be unique across the whole index, because `howto:` links
      // address it globally. First declaration wins and the duplicate is dropped rather
      // than silently shadowing — reported through `indexProblems`.
      const key = topic.id;
      if (seen.has(key)) return;
      seen.add(key);
      // The author's position in their own index. The global list is sorted for the
      // reader (category, then title), which loses the order the author chose — and that
      // order is intent: the first topic they listed is where they want someone starting.
      // It is what the ⓘ beside the plugin opens. Without it, Frequencies' entry page was
      // "Add a mode, median or variance" because it sorts before "Make a frequency table".
      out.push({ ...topic, declaredAt });
    });
  }
  return out.sort((a, b) =>
    a.category.localeCompare(b.category)
    || a.title.localeCompare(b.title)
    || String(a.pluginId).localeCompare(String(b.pluginId)));
}

/**
 * Author errors in a catalogue's declarations — duplicate ids, and entries too malformed
 * to show. Surfaced in the plugin manager rather than thrown: one plugin's bad manifest
 * must not cost everyone else their documentation.
 *
 * @param {Array<object>} catalogue
 * @returns {Array<{pluginId: string|null, problem: string, id?: string}>}
 */
export function indexProblems(catalogue) {
  const problems = [];
  const owners = new Map(); // topic id -> the plugin that claimed it first
  for (const entry of catalogue ?? []) {
    const pluginId = entry?.id ?? null;
    for (const raw of Array.isArray(entry?.howtoIndex) ? entry.howtoIndex : []) {
      const topic = normalizeTopic(raw, { pluginId });
      if (!topic) {
        problems.push({ pluginId, problem: 'a topic needs an id and a title' });
        continue;
      }
      if (owners.has(topic.id)) {
        problems.push({
          pluginId,
          id: topic.id,
          problem: `topic id "${topic.id}" is already used by ${owners.get(topic.id)}`,
        });
        continue;
      }
      owners.set(topic.id, pluginId);
    }
  }
  return problems;
}

/**
 * Split a sidecar into `{id: body}`, validated against the ids the manifest declared.
 *
 * Both directions are checked, because both are author mistakes that present to a reader
 * as missing documentation:
 *  - a body whose delimiter names no declared topic is **unreachable** (nothing links to
 *    an id the index does not carry);
 *  - a declared topic with no body is a **dead row** — it appears in the index, and
 *    opening it finds nothing.
 *
 * Text before the first delimiter is ignored, so a file may carry a header comment.
 *
 * @param {string} text the sidecar's contents
 * @param {string[]} declared topic ids from the manifest index
 * @returns {{bodies: Map<string, string>, problems: string[]}}
 */
export function parseSidecar(text, declared = []) {
  const want = new Set(declared);
  const bodies = new Map();
  const problems = [];
  let current = null;
  let buf = [];

  const flush = () => {
    if (!current) return;
    bodies.set(current, buf.join('\n').trim());
    buf = [];
  };

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(DELIM);
    if (!m) {
      if (current) buf.push(line);
      continue;
    }
    flush();
    const id = m[1];
    if (!want.has(id)) {
      // Keep parsing: one stray section should not cost the reader the rest of the file.
      problems.push(`"${id}" is not declared in this plugin's howtoIndex, so nothing can reach it`);
      current = null;
      continue;
    }
    if (bodies.has(id)) {
      problems.push(`"${id}" appears more than once; the first copy is used`);
      current = null;
      continue;
    }
    current = id;
  }
  flush();

  for (const id of want) {
    if (!bodies.has(id)) problems.push(`"${id}" is in the index but has no section in the file`);
  }
  return { bodies, problems };
}

/**
 * Filter the index. Titles, categories, keywords and the plugin's name — NOT bodies.
 *
 * Searching bodies would mean fetching every sidecar, which is the whole thing the
 * manifest/sidecar split exists to avoid. The UI says so in as many words, because a
 * reader who searches a word that lives in a body and gets nothing will conclude the
 * topic does not exist. It is also why authors are asked to be generous with `keywords`.
 *
 * @param {object[]} topics @param {string} query
 */
export function filterTopics(topics, query) {
  // Hidden pages are dropped FIRST, before the empty-query shortcut: they exist so the
  // ⓘ beside a plugin has a destination, not so the reader can browse their way to
  // "this plugin documents nothing". Filtering after the shortcut listed every one of
  // them in the default view, which is the view people actually see.
  const listed = (topics ?? []).filter((t) => !t.hidden);
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return listed;
  const terms = q.split(/\s+/);
  return listed.filter((t) => {
    const hay = `${t.title} ${t.category} ${t.keywords.join(' ')} ${t.pluginName ?? ''}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/** Group an ordered topic list into `[category, topics[]]` pairs, keeping the order. */
export function groupTopics(topics) {
  const groups = new Map();
  for (const t of topics ?? []) {
    if (!groups.has(t.category)) groups.set(t.category, []);
    groups.get(t.category).push(t);
  }
  return [...groups.entries()];
}

/**
 * The reader's position: a browser-style history stack over topic ids, where the index
 * is itself a position.
 *
 * The owner's spec, and it behaves like a browser because that is what people already
 * know: `Index -> A -> B -> Index -> C`, then Back three times lands on **A**. "Index"
 * therefore PUSHES rather than clearing, and only consecutive duplicates collapse (so
 * tapping Index twice does not cost two Backs).
 *
 * Kept as a plain data structure so the navigation rules are testable without a DOM —
 * they are the part that is easy to get subtly wrong and impossible to eyeball.
 */
export class HowtoHistory {
  /** @type {Array<string|null>} null is the index; a string is a topic id. */
  #stack = [null];

  /** Where the reader is now: a topic id, or null for the index. */
  get current() {
    return this.#stack[this.#stack.length - 1];
  }

  /** Whether Back would go anywhere. */
  get canGoBack() {
    return this.#stack.length > 1;
  }

  /** The stack, for tests and for a caller that wants to show a trail. */
  get trail() {
    return [...this.#stack];
  }

  /** Open a topic (or, with null, the index) as a new position. */
  push(topicId) {
    const next = topicId ?? null;
    // Consecutive duplicates collapse: re-opening what you are already reading is not a
    // move, and tapping Index twice should cost one Back, not two.
    if (this.#stack[this.#stack.length - 1] === next) return this.current;
    this.#stack.push(next);
    return this.current;
  }

  /** Go back one position. No-op at the bottom, so Back is always safe to offer. */
  back() {
    if (this.#stack.length > 1) this.#stack.pop();
    return this.current;
  }

  /** Forget everything (a project switch, a plugin set change). */
  reset() {
    this.#stack = [null];
  }
}
