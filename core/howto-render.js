/**
 * @file howto-render.js
 * Markdown → DOM for a how-to body (#192).
 *
 * ## Why this is a separate renderer
 *
 * `renderMiniMarkdown` in results-pane.js already turns plugin-authored markdown into
 * HTML, and reusing it was the obvious move. It is the wrong one: that function is what
 * every plugin's output NOTES go through, so teaching it link syntax would quietly give
 * every analysis result the power to point anywhere. The blast radius of a shared
 * renderer is the union of its callers' trust levels, not the lowest.
 *
 * ## Why it builds nodes instead of emitting HTML
 *
 * The obvious alternative is to emit `<a href=…>` and let `sanitize-html.js` vet it. The
 * owner's call was to leave the sanitiser closed — it allows no `<a>` and strips every
 * URL-bearing attribute, and widening it would relax the rules for plugin RESULT markup
 * too. Building the element here means the href is set as a property on a node we made,
 * after the scheme has been checked, and there is no HTML string anywhere for a parser to
 * disagree with us about. Text is always `textContent`.
 *
 * ## The three link kinds
 *
 *  - `[text](howto:topic-id)` — another topic, including another plugin's. This is where
 *    equality becomes visible rather than merely structural: a core topic can point at a
 *    third-party one and the reverse.
 *  - `[text](https://…)` / `http://…` — external. `http` as well as `https` because, as
 *    the owner put it, not everyone is using https. Opened in a new tab with
 *    `rel="noopener noreferrer"`, and **the destination host is shown in the link text**,
 *    which is the part that actually defeats phishing: a link captioned "SPSS
 *    documentation" pointing at `evil.tld` indicts itself.
 *  - anything else — `javascript:`, `data:`, `blob:`, `file:`, a bare word — is NOT a
 *    link. It renders as its own text, so a malformed or hostile target degrades to prose
 *    rather than to a trap.
 *
 * Images are local declared assets only (`![alt](asset:name.png)`), never a URL: an
 * external link is user-initiated, but an external image fetches the moment the topic
 * opens — a beacon that reports the reader's address and reading time to a third party,
 * and a broken box in an air-gapped deployment.
 */

import { el } from './plugin-stdlib.js';
import { currentScreenMode } from './screen-mode.js';

/** Schemes a link may use. Everything else degrades to text. */
const EXTERNAL = /^https?:\/\//i;

/** `[text](target)` and `![alt](target)`, non-greedy so two links on a line both match. */
const LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Inline code, bold, italic — the same vocabulary the results notes use, minus links. */
const CODE = /`([^`]+)`/g;

/**
 * The host a link points at, for the visible attribution. Returns null if the URL will
 * not parse, which is itself a reason not to render it as a link.
 */
export function linkHost(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Classify a link target. Exported because the rule is the security boundary, and a
 * boundary worth having is worth testing directly.
 *
 * @param {string} target
 * @returns {{kind: 'topic'|'external'|'asset'|'none', value: string, host?: string}}
 */
export function classifyTarget(target) {
  const t = String(target ?? '').trim();
  if (!t) return { kind: 'none', value: t };
  if (t.toLowerCase().startsWith('howto:')) {
    const id = t.slice(6).trim();
    return id ? { kind: 'topic', value: id } : { kind: 'none', value: t };
  }
  if (t.toLowerCase().startsWith('asset:')) {
    const name = t.slice(6).trim();
    return name ? { kind: 'asset', value: name } : { kind: 'none', value: t };
  }
  if (EXTERNAL.test(t)) {
    const host = linkHost(t);
    // A URL whose host we cannot read is a URL we cannot caption honestly, so it is not
    // offered as a link at all.
    return host ? { kind: 'external', value: t, host } : { kind: 'none', value: t };
  }
  return { kind: 'none', value: t };
}

/** Apply the inline emphasis vocabulary to a plain run of text, as DOM nodes. */
function inlineText(text, into) {
  // Code spans first: whatever is inside one is literal, including asterisks.
  let last = 0;
  CODE.lastIndex = 0;
  let m;
  while ((m = CODE.exec(text))) {
    if (m.index > last) emphasise(text.slice(last, m.index), into);
    into.append(el('code', { text: m[1] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) emphasise(text.slice(last), into);
}

/** `**bold**` and `*italic*`, as nodes. Deliberately tiny: a how-to is prose, not a
 * typesetting exercise, and every construct here is one more thing to get wrong. */
function emphasise(text, into) {
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) into.append(document.createTextNode(text.slice(last, m.index)));
    into.append(m[1] != null ? el('strong', { text: m[1] }) : el('em', { text: m[2] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) into.append(document.createTextNode(text.slice(last)));
}

/**
 * Render one line's inline content into `into`.
 * @param {string} line
 * @param {HTMLElement} into
 * @param {{onTopic?: (id: string) => void, resolveAsset?: (name: string) => Promise<string|null>, screen?: string}} opts
 */
function inlineInto(line, into, opts) {
  let last = 0;
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(line))) {
    if (m.index > last) inlineText(line.slice(last, m.index), into);
    const [, bang, label, target] = m;
    const t = classifyTarget(target);
    if (bang === '!' && t.kind === 'asset') into.append(imageFor(label, t.value, opts));
    else if (bang === '!') into.append(document.createTextNode(label || target));
    else if (t.kind === 'topic') into.append(topicLink(label || t.value, t.value, opts));
    else if (t.kind === 'external') into.append(externalLink(label || t.host, t.value, t.host));
    else inlineText(label || t.value, into); // not a link: show the words, not the target
    last = m.index + m[0].length;
  }
  if (last < line.length) inlineText(line.slice(last), into);
}

/** A link to another topic. A button, not an anchor: it navigates the overlay, not the page. */
function topicLink(label, topicId, { onTopic } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'howto__link howto__link--topic';
  b.textContent = label;
  b.dataset.topic = topicId;
  if (onTopic) b.addEventListener('click', () => onTopic(topicId));
  return b;
}

/** A link off the site. New tab, no opener, no referrer, and the host said out loud. */
function externalLink(label, href, host) {
  const a = document.createElement('a');
  a.className = 'howto__link howto__link--external';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  // The anti-phishing measure, and the reason an interstitial is not needed: the reader
  // can see where it goes before clicking, every time, without being trained to dismiss
  // a dialog. Kept as a separate span so a long host wraps rather than stretching the link.
  a.append(el('span', { text: ` (${host})`, class: 'howto__host' }));
  return a;
}

/**
 * A screenshot, resolved from the plugin's own declared assets.
 *
 * **Screen-aware by name, not by scaling.** Small-screen mode is not a narrower desktop —
 * the menubar becomes a hamburger, controls wrap, panels change shape — so a desktop
 * screenshot shown to a phone reader depicts a UI they do not have, which is worse than
 * no screenshot. An author may ship `name.png` and `name.small.png`; the host asks for
 * the one matching the current mode and falls back to the other, so shipping one image
 * still works everywhere.
 */
function imageFor(alt, name, { resolveAsset, screen } = {}) {
  const fig = el('figure', { class: 'howto__fig' });
  const img = document.createElement('img');
  img.className = 'howto__img';
  img.alt = alt || '';
  // Alt text is not optional for a reason the accessibility baseline already settled; an
  // image with none is still rendered, but it is announced as decorative rather than
  // being given a filename to read out.
  img.loading = 'lazy';
  fig.append(img);
  if (alt) fig.append(el('figcaption', { text: alt, class: 'howto__caption' }));

  const small = (screen ?? currentScreenMode()) === 'small';
  const candidates = small
    ? [name.replace(/(\.[a-z0-9]+)$/i, '.small$1'), name]
    : [name, name.replace(/(\.[a-z0-9]+)$/i, '.small$1')];

  void (async () => {
    for (const candidate of candidates) {
      try {
        const src = await resolveAsset?.(candidate); // eslint-disable-line no-await-in-loop
        if (src) { img.src = src; return; }
      } catch { /* try the next candidate */ }
    }
    // Say what is missing rather than leaving a broken-image glyph: an author reading
    // their own page is the person who can fix it.
    fig.replaceChildren(el('p', { text: `(image not found: ${name})`, class: 'howto__missing' }));
  })();
  return fig;
}

/**
 * Render a how-to body into a fresh element.
 *
 * @param {string} md
 * @param {{onTopic?: (id: string) => void, resolveAsset?: (name: string) => Promise<string|null>,
 *          screen?: string}} [opts]
 * @returns {HTMLElement}
 */
export function renderHowto(md, opts = {}) {
  const root = el('div', { class: 'howto__body' });
  const blocks = String(md ?? '').split(/\n{2,}/);
  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;

    const heading = text.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const h = el(`h${heading[1].length + 1}`, { class: 'howto__h' });
      inlineInto(heading[2], h, opts);
      root.append(h);
      continue;
    }

    // An ordered or bulleted list: the shape a how-to is usually in.
    const lines = text.split('\n');
    if (lines.every((l) => /^\s*(\d+[.)]|[-*])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      const list = el(ordered ? 'ol' : 'ul', { class: 'howto__list' });
      for (const line of lines) {
        const li = el('li');
        inlineInto(line.replace(/^\s*(\d+[.)]|[-*])\s+/, ''), li, opts);
        list.append(li);
      }
      root.append(list);
      continue;
    }

    const p = el('p', { class: 'howto__p' });
    lines.forEach((line, i) => {
      if (i) p.append(document.createElement('br'));
      inlineInto(line, p, opts);
    });
    root.append(p);
  }
  return root;
}
