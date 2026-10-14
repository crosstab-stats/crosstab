/**
 * @file howto-ui.js
 * The How-to overlay (#192) — index, drill-down, and a reader's position that survives
 * being closed.
 *
 * ## Shape, and why
 *
 * The owner specified it against the Syntax guide's defects: that dialog opens fully
 * expanded instead of as an index, has no top bar, puts the command reference ABOVE the
 * search box, shows one card per PLUGIN (so the pie chart's entry carries bar-chart
 * notes), and its close button is 16×19px — *"so small I missed tapping it five times in
 * a row"*. That last one is not carelessness: the button is styled INLINE, which is also
 * why no small-screen rule could ever have resized it. **Everything here is a class.**
 *
 * So: a top bar that is always visible (Index · Back · where you are · Close), the filter
 * above the index, one topic per view, and 44px controls from the start rather than
 * retrofitted.
 *
 * ## State outlives the dialog
 *
 * Closing is not finishing. The reader's whole reason for opening this is to do something
 * in the app, and they will come back for the next step — so the position is held in a
 * module-level singleton and the dialog reopens exactly where it was. A reload starts at
 * the index: a stack restored across sessions would be a promise about continuity we
 * cannot keep once the plugin set may have changed underneath it.
 */

import { el } from './plugin-stdlib.js';
import { filterTopics, groupTopics, HowtoHistory } from './howto.js';
import { renderHowto } from './howto-render.js';

/** The reader's position, kept between opens. See the file header. */
const state = {
  history: new HowtoHistory(),
  query: '',
  /** An exact-category restriction, for an entry point that means one section of the
   * index — "Syntax guide…" is the command reference, not everything matching the word
   * "syntax" (which also catches a plugin NAMED "R Syntax Export"). Shown as a chip the
   * reader can clear, because a filtered list that does not say it is filtered is how
   * someone concludes a topic does not exist. */
  category: null,
};

/** The open dialog, so a second request navigates it rather than stacking another. */
let openDialog = null;

/** Forget where the reader was — the plugin set changed under them. */
export function resetHowtoState() {
  state.history.reset();
  state.query = '';
  state.category = null;
}

/**
 * Open the guide, optionally straight to a topic.
 *
 * @param {{library: object, topicId?: string}} opts `library` is
 *   {@link createHowtoLibrary}'s return; `topicId` jumps to one page (the ⓘ on a plugin
 *   row or an analysis dialog), pushing it so Back still returns where the reader was.
 */
export function openHowto({ library, topicId, query, category } = {}) {
  // A caller may open the index pre-filtered. Either kind of filter means going TO the
  // index, since a filter applied to a page nobody is looking at would be a lie.
  if (typeof query === 'string' || typeof category === 'string') {
    state.query = typeof query === 'string' ? query : '';
    state.category = typeof category === 'string' ? category : null;
    state.history.push(null);
  }
  if (topicId) state.history.push(topicId);
  if (openDialog) {
    renderInto(openDialog, library);
    return openDialog;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'ct-dialog howto';
  const form = el('form', { class: 'howto__form' });
  form.method = 'dialog';
  dialog.append(form);

  dialog.addEventListener('close', () => {
    openDialog = null;
    dialog.remove();
    // State is deliberately NOT cleared here.
  });
  document.body.append(dialog);
  openDialog = dialog;
  renderInto(dialog, library);
  dialog.showModal();
  return dialog;
}

/** Redraw for the current position. */
function renderInto(dialog, library) {
  const form = dialog.querySelector('.howto__form');
  form.replaceChildren();

  const where = state.history.current;
  const topic = where ? library.topicById(where) : null;

  form.append(topBar(dialog, library, topic));
  const content = el('div', { class: 'howto__content' });
  form.append(content);

  if (!where) renderIndex(content, library, dialog);
  else renderTopic(content, library, dialog, where, topic);
}

/** Index · Back · where you are · Close. Always visible, always 44px. */
function topBar(dialog, library, topic) {
  const bar = el('div', { class: 'howto__bar' });

  const index = el('button', { text: 'Index', class: 'howto__nav' });
  index.type = 'button';
  index.title = 'Back to the list of topics';
  index.disabled = state.history.current === null;
  index.addEventListener('click', () => { state.history.push(null); renderInto(dialog, library); });

  const back = el('button', { text: '← Back', class: 'howto__nav' });
  back.type = 'button';
  back.title = 'The page you were on before this one';
  back.disabled = !state.history.canGoBack;
  back.addEventListener('click', () => { state.history.back(); renderInto(dialog, library); });

  // Where you are. Named rather than left implicit, because after following two or three
  // cross-links the title bar is the only thing that says which page this is.
  const whereText = topic ? topic.title : 'How to…';
  const where = el('span', { text: whereText, class: 'howto__where' });
  where.title = whereText;

  const close = el('button', { text: '✕', class: 'howto__nav howto__close' });
  close.type = 'submit';
  close.value = 'close';
  close.title = 'Close (you can come back to this page)';
  close.setAttribute('aria-label', 'Close');

  bar.append(index, back, where, close);
  return bar;
}

/** The searchable, grouped, attributed list. */
function renderIndex(content, library, dialog) {
  const all = library.topics();

  const filterBar = el('div', { class: 'howto__filterbar' });
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'howto__filter';
  input.placeholder = 'Search topics and keywords';
  input.value = state.query;
  input.setAttribute('aria-label', 'Search topics and keywords');
  // Saying the SCOPE out loud, because a reader who searches a word that lives in the
  // body of a page and gets nothing will conclude the topic does not exist. Searching
  // bodies would mean fetching every sidecar, which is the whole thing the
  // index/sidecar split exists to avoid.
  const scope = el('p', {
    text: 'Searches topic titles and keywords — not the text inside each page.',
    class: 'howto__scope',
  });
  filterBar.append(input, scope);
  // The restriction, said out loud and removable in one tap.
  if (state.category) {
    const chip = el('button', { class: 'howto__chip' });
    chip.type = 'button';
    chip.append(el('span', { text: `Showing ${state.category}` }), el('span', { text: '✕', class: 'howto__chipx' }));
    chip.title = 'Show every topic';
    chip.addEventListener('click', () => { state.category = null; renderInto(dialog, library); });
    filterBar.append(chip);
  }
  content.append(filterBar);

  const list = el('div', { class: 'howto__list' });
  content.append(list);

  const draw = () => {
    list.replaceChildren();
    // Hidden pages are dropped by filterTopics, not here — one place decides what the
    // index lists, or the two drift and only one of them is tested.
    const scoped = state.category ? all.filter((t) => t.category === state.category) : all;
    const shown = filterTopics(scoped, state.query);
    if (!all.length) {
      list.append(el('p', {
        text: 'No how-to topics are installed yet. Plugins provide these, so enabling more plugins adds more.',
        class: 'howto__empty',
      }));
      return;
    }
    if (!shown.length) {
      const why = state.category && state.query ? `“${state.query}” in ${state.category}`
        : state.category ? state.category : `“${state.query}”`;
      list.append(el('p', { text: `Nothing matches ${why}.`, class: 'howto__empty' }));
      return;
    }
    for (const [category, topics] of groupTopics(shown)) {
      list.append(el('h3', { text: category, class: 'howto__group' }));
      for (const t of topics) list.append(indexRow(t, library, dialog));
    }
  };

  input.addEventListener('input', () => { state.query = input.value; draw(); });
  draw();
}

/** One row: the title, its attribution, and nothing about where it came from in the sort. */
function indexRow(topic, library, dialog) {
  const row = el('button', { class: 'howto__row' });
  row.type = 'button';
  const main = el('span', { class: 'howto__rowmain' });
  main.append(el('span', { text: topic.title, class: 'howto__rowtitle' }));
  // Attribution, so you know whose documentation you are about to read. NOT a sort key:
  // ordering by origin is the privilege this system exists to avoid.
  if (topic.pluginName) main.append(el('span', { text: `from ${topic.pluginName}`, class: 'howto__rowfrom' }));
  row.append(main);

  const unmet = library.unmetNeeds(topic);
  if (unmet.length) row.append(el('span', { text: unmet.some((n) => !n.installed) ? 'not installed' : 'off', class: 'howto__badge' }));

  row.addEventListener('click', () => { state.history.push(topic.id); renderInto(dialog, library); });
  return row;
}

/** One page. */
function renderTopic(content, library, dialog, topicId, topic) {
  if (!topic) {
    content.append(problemBlock(
      'That topic is no longer available.',
      'The plugin that provided it may have been removed or disabled.',
    ));
    return;
  }

  const needs = library.unmetNeeds(topic);
  if (needs.length) content.append(needsBlock(needs, library, dialog));

  // What this plugin adds to the menus. Generated from the manifest, shown on the
  // plugin's FIRST page only, and the one thing the deleted About dialog knew that the
  // guide did not. It answers the question the ⓘ is actually asked: "what IS this?"
  if (library.isEntryPage?.(topic)) {
    const adds = library.menuAdds?.(topic.pluginId) ?? [];
    if (adds.length) {
      const box = el('div', { class: 'howto__adds' });
      box.append(el('h3', { text: `Adds ${adds.length} item${adds.length === 1 ? '' : 's'} to the menus`, class: 'howto__group' }));
      const ul = el('ul', { class: 'howto__list' });
      for (const label of adds) ul.append(el('li', { text: label }));
      box.append(ul);
      content.append(box);
    }
  }

  const bodyHost = el('div', { class: 'howto__loading', text: 'Loading…' });
  content.append(bodyHost);

  void (async () => {
    const result = await library.body(topicId);
    bodyHost.classList.remove('howto__loading');
    bodyHost.replaceChildren();
    if (result.error) {
      // Specific, never blank: a blank panel reads as "no documentation exists".
      bodyHost.append(problemBlock('This page could not be loaded.', result.error));
    } else if (!String(result.md ?? '').trim()) {
      // A plugin that documents nothing. Saying so plainly beats an empty page, and
      // naming the likely reason beats implying the plugin is broken.
      bodyHost.append(el('p', {
        text: `${topic.pluginName ?? 'This plugin'} has not written a how-to. It may be `
          + 'infrastructure another plugin depends on rather than something you use directly.',
        class: 'howto__empty',
      }));
    } else {
      bodyHost.append(renderHowto(result.md, {
        onTopic: (id) => { state.history.push(id); renderInto(dialog, library); },
        resolveAsset: (name) => library.assetUrl(topic.pluginId, name),
      }));
    }
    // Author mistakes in the same file, shown to whoever is reading — most likely the
    // author, and certainly the person who can report it.
    if (result.authorNotes?.length) {
      const note = el('details', { class: 'howto__authornotes' });
      note.append(el('summary', { text: `${result.authorNotes.length} problem(s) in this plugin's how-to file` }));
      const ul = el('ul');
      for (const n of result.authorNotes) ul.append(el('li', { text: n }));
      note.append(ul);
      bodyHost.append(note);
    }
    if (topic.seeAlso?.length) bodyHost.append(seeAlsoBlock(topic, library, dialog));
  })();
}

/** "Needs Crosstabs — Enable". An affordance, not a warning. */
function needsBlock(unmet, library, dialog) {
  const box = el('div', { class: 'howto__needs' });
  const missing = unmet.filter((n) => !n.installed);
  const off = unmet.filter((n) => n.installed);

  if (off.length) {
    box.append(el('span', {
      text: `Needs ${off.map((n) => n.name).join(', ')}`,
      class: 'howto__needstext',
    }));
    const btn = el('button', { text: off.length > 1 ? 'Enable them' : 'Enable', class: 'howto__enable' });
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Enabling…';
      try {
        await library.enable(off.map((n) => n.id));
      } finally {
        renderInto(dialog, library);
      }
    });
    box.append(btn);
  }
  if (missing.length) {
    box.append(el('span', {
      text: `${missing.map((n) => n.name).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not installed here.`,
      class: 'howto__needstext',
    }));
  }
  return box;
}

/** Related topics, including other plugins' — where the equality becomes visible. */
function seeAlsoBlock(topic, library, dialog) {
  const live = topic.seeAlso.map((id) => library.topicById(id)).filter(Boolean);
  if (!live.length) return el('div');
  const box = el('div', { class: 'howto__seealso' });
  box.append(el('h3', { text: 'See also', class: 'howto__group' }));
  for (const t of live) box.append(indexRow(t, library, dialog));
  return box;
}

/** A failure that says which failure it is. */
function problemBlock(title, detail) {
  const box = el('div', { class: 'howto__problem' });
  box.append(el('p', { text: title, class: 'howto__problemtitle' }));
  if (detail) box.append(el('p', { text: detail, class: 'howto__problemdetail' }));
  return box;
}
