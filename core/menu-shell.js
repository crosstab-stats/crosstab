/**
 * @file menu-shell.js
 * The application menubar, populated dynamically by plugins.
 *
 * The core ships an *empty* menubar. Every entry — including the built-in
 * Analyze ▸ Descriptive Statistics ▸ Frequencies item — is added by a plugin via
 * `app.menus.register(...)`. This is the Factorio/VS-Code principle made
 * concrete: there is no privileged path to put something in a menu; the official
 * analyses use exactly the same registration call third-party plugins will.
 *
 * A registration describes *where* an item lives (`path`), *what it says*
 * (`label`), and *what it does* (`command`). The shell assembles overlapping
 * paths into a shared tree, so two plugins can both contribute items under
 * "Analyze ▸ Regression" without coordinating.
 */

import { recordError } from './debug.js';
import { currentScreenMode } from './screen-mode.js';

/**
 * @typedef {Object} MenuItem
 * @property {string[]} path - Menu hierarchy this item lives under, top-level
 *   first, e.g. `['Analyze', 'Descriptive Statistics']`. An empty array places
 *   the item directly on the menubar (rare).
 * @property {string} label - Visible item text, e.g. `'Frequencies…'`.
 * @property {() => any} command - Invoked when the item is chosen. **Return the promise**
 *   when the work is async: a command written `() => void doThing()` discards it, so a
 *   rejection cannot be reported and the item looks like it did nothing.
 * @property {string} [id] - Stable id (defaults to `path.join('/')+'/'+label`).
 *   Registering the same id again replaces the previous item.
 * @property {number} [order=100] - Sort weight within its submenu (lower first).
 */

/**
 * Invoke a menu item's command and make a failure VISIBLE.
 *
 * Exists because of a bug report that is the whole argument for it (owner, 2026-10-02):
 * *"I opened a project, selected a dataset, attempted File|Copy Dataset and nothing
 * happened."* The command called a method that had been renamed, so it threw a TypeError —
 * which the shell caught and wrote to the console. On screen: nothing. A broken menu item
 * and an item that genuinely does nothing are then indistinguishable, and the only person
 * who finds out is whoever opens devtools.
 *
 * Two failure shapes, because most commands here are async:
 *  - a **synchronous throw** (a bad call, a missing method) — caught here;
 *  - a **rejected promise** — not caught by `try`, so it is handled when the command
 *    returns its promise. A command written `() => void doThing()` discards it and stays
 *    silent; that is why `command` should return what it calls.
 *
 * Also records the error for the Help-menu bug report, so a user who says "nothing
 * happened" is carrying the stack without having to reproduce it.
 *
 * @param {{id?: string, label?: string, command: () => any}} item
 * @param {(item: object, err: any) => void} [report] told about a failure, after the console
 * @returns {Promise<void>|void}
 */
export function runCommand(item, report) {
  const fail = (err) => {
    console.error(`Menu command "${item?.id ?? item?.label}" failed`, err);
    recordError(err, `menu:${item?.id ?? item?.label ?? '?'}`);
    try {
      report?.(item, err);
    } catch {
      /* reporting a failure must never be a second failure */
    }
  };
  try {
    const out = item.command();
    if (out && typeof out.then === 'function') return Promise.resolve(out).catch(fail);
  } catch (err) {
    fail(err);
  }
  return undefined;
}

/**
 * Internal tree node. Either a submenu (has `children`) or a leaf (has `item`).
 * @typedef {Object} MenuNode
 * @property {string} label
 * @property {number} order
 * @property {Map<string, MenuNode>} children
 * @property {MenuItem} [item]
 */

/**
 * Builds and manages the menubar DOM.
 */
export class MenuShell {
  /** Host element the menubar renders into. @type {HTMLElement} */
  #host;

  /** Root of the menu tree; its children are the top-level menus. @type {MenuNode} */
  #tree = makeNode('', 0);

  /** id → registered item, for replacement and removal. @type {Map<string, MenuItem>} */
  #items = new Map();

  /** Currently open top-level menu element, if any. @type {HTMLElement|null} */
  #openMenu = null;

  /** Told when a command fails, so the user hears about it. @type {?Function} */
  #onError = null;

  /**
   * @param {HTMLElement} host - Container for the menubar (e.g. a `<nav>`).
   * @param {{onError?: (item: object, err: any) => void}} [opts] - how to REPORT a failed
   *   command. Without it a failure reaches the console and nowhere else, which is how a
   *   broken menu item came to look like one that simply does nothing.
   */
  constructor(host, { onError } = {}) {
    this.#host = host;
    this.#onError = typeof onError === 'function' ? onError : null;
    // Close any open menu when clicking elsewhere or pressing Escape.
    document.addEventListener('click', (e) => {
      if (!this.#host.contains(e.target)) this.#closeOpenMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#closeOpenMenu();
    });
    // The ARIA menubar keyboard model (see #onKeydown).
    this.#host.addEventListener('keydown', (e) => this.#onKeydown(e));
  }

  /**
   * Register (or replace) a menu item. Returns a disposer that removes it again,
   * which the loader uses to tear a plugin's menus down on unload.
   *
   * @param {MenuItem} item
   * @returns {() => void} Unregister function.
   */
  register(item) {
    if (!Array.isArray(item.path)) {
      throw new TypeError('menus.register: `path` must be an array of strings');
    }
    if (typeof item.command !== 'function') {
      throw new TypeError(`menus.register: item "${item.label}" needs a command function`);
    }
    const id = item.id ?? `${item.path.join('/')}/${item.label}`;
    const normalised = { order: 100, ...item, id };

    this.#items.set(id, normalised);
    this.#rebuildTree();
    this.render();

    return () => {
      this.#items.delete(id);
      this.#rebuildTree();
      this.render();
    };
  }

  /** Render (or re-render) the whole menubar from the current tree. */
  render() {
    this.#closeOpenMenu();
    this.#host.replaceChildren();
    this.#host.setAttribute('role', 'menubar');

    const topLevel = [...this.#tree.children.values()].sort(byTopLevel);
    // Small-screen arrangement: the whole bar collapses to one button. Not a separate menu
    // — the same tree, drawn by the same group renderer (see #renderHamburger).
    if (currentScreenMode() === 'small') {
      this.#host.append(this.#renderHamburger(topLevel));
    } else {
      for (const node of topLevel) {
        this.#host.append(this.#renderTopLevel(node));
      }
    }
    // Roving tabindex: the whole menubar is ONE tab stop, and arrows move within it.
    // Previously every button — and every item of an open menu, which for Regression
    // is dozens — sat in the tab sequence, so Tab could not get past the menubar.
    this.#topButtons().forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; });
  }

  /**
   * The object exposed to plugins as `app.menus`.
   * @returns {Readonly<{ register: (item: MenuItem) => (() => void) }>}
   */
  get api() {
    return Object.freeze({
      register: (item) => this.register(item),
    });
  }

  // --- tree construction -----------------------------------------------------

  /** Rebuild the menu tree from scratch from the registered items. */
  #rebuildTree() {
    const root = makeNode('', 0);
    for (const item of this.#items.values()) {
      let node = root;
      for (const segment of item.path) {
        let child = node.children.get(segment);
        if (!child) {
          child = makeNode(segment, 100);
          node.children.set(segment, child);
        }
        node = child;
      }
      // Leaf for the item itself, keyed by label under its parent submenu.
      const leaf = makeNode(item.label, item.order);
      leaf.item = item;
      node.children.set(`leaf:${item.id}`, leaf);
    }
    this.#tree = root;
  }

  // --- rendering -------------------------------------------------------------

  /**
   * The whole menubar as ONE button, for the small-screen arrangement.
   *
   * Sixteen top-level menus at 426px wrap to four rows and take 81px of a 836px screen —
   * measured, not guessed — and the header with them reaches 167px before anything useful
   * is on screen. Collapsing keeps the bar one row tall, which matters most exactly where
   * space is tightest.
   *
   * **Nothing is removed**, which is the owner's criterion: every top-level menu becomes a
   * labelled GROUP inside the single panel, drawn by the same {@link MenuShell#renderSubmenu}
   * that already draws nested submenus. So the full tree is present, the open/close and
   * keyboard machinery is the machinery that was already there, and there is no second
   * rendering of the menu to keep in step with the first.
   */
  #renderHamburger(topLevel) {
    const wrapper = document.createElement('div');
    wrapper.className = 'menu menu--all';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu__button menu__button--all';
    button.textContent = '☰ Menu';
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.className = 'menu__panel menu__panel--all';
    panel.setAttribute('role', 'menu');
    panel.hidden = true;
    for (const node of topLevel) {
      // A top-level menu with a single leaf (rare, but possible) still reads correctly as a
      // one-item group; a leaf registered directly on the menubar stays a leaf.
      panel.append(node.item ? this.#renderLeaf(node) : this.#renderSubmenu(node));
    }

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !panel.hidden;
      this.#closeOpenMenu();
      this.#focusTop(button);
      if (!isOpen) this.#open(wrapper);
    });

    wrapper.append(button, panel);
    return wrapper;
  }

  /** Render a top-level menu button plus its dropdown panel. */
  #renderTopLevel(node) {
    const wrapper = document.createElement('div');
    wrapper.className = 'menu';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu__button';
    button.textContent = node.label;
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.className = 'menu__panel';
    panel.setAttribute('role', 'menu');
    panel.hidden = true;
    this.#renderChildrenInto(panel, node);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !panel.hidden;
      this.#closeOpenMenu();
      this.#focusTop(button);
      if (!isOpen) this.#open(wrapper);
    });

    wrapper.append(button, panel);
    return wrapper;
  }

  /** Render a submenu's children (leaves and nested submenus) into a panel. */
  #renderChildrenInto(panel, node) {
    const children = [...node.children.values()].sort(byOrderThenLabel);
    for (const child of children) {
      panel.append(child.item ? this.#renderLeaf(child) : this.#renderSubmenu(child));
    }
  }

  /** Render a clickable leaf item. */
  #renderLeaf(node) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'menu__item';
    el.textContent = node.label;
    el.setAttribute('role', 'menuitem');
    el.tabIndex = -1; // reached with arrows, not Tab (see render's roving tabindex)
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#closeOpenMenu();
      void runCommand(node.item, this.#onError);
    });
    return el;
  }

  /** Render a nested submenu as a labelled group with an inline flyout. */
  #renderSubmenu(node) {
    const group = document.createElement('div');
    group.className = 'menu__group';
    group.setAttribute('role', 'group');

    const flyout = document.createElement('div');
    flyout.className = 'menu__flyout';
    this.#renderChildrenInto(flyout, node);

    // In the small-screen arrangement every menu is a group inside ONE panel, so a flat
    // panel is 53 items of scrolling (owner, on the phone: "one long scrolling list is a bit
    // rough"). Collapsed groups turn that into nine taps-worth of headings that fit on the
    // screen at once. An ACCORDION rather than free toggling, because the point is that the
    // panel cannot grow back into a long scroll: opening one closes its siblings.
    if (currentScreenMode() === 'small') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'menu__group-label menu__group-toggle';
      toggle.setAttribute('role', 'menuitem');
      toggle.setAttribute('aria-haspopup', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.tabIndex = -1;
      toggle.append(nodeLabelWithCaret(node.label));
      flyout.hidden = true;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = toggle.getAttribute('aria-expanded') === 'true';
        // Siblings within this panel only: a nested group closing its parent's other
        // sections would make a two-level menu unusable.
        for (const sib of group.parentElement?.children ?? []) {
          const sibToggle = sib.querySelector?.(':scope > .menu__group-toggle');
          const sibFlyout = sib.querySelector?.(':scope > .menu__flyout');
          if (sibToggle && sibFlyout) {
            sibToggle.setAttribute('aria-expanded', 'false');
            sibFlyout.hidden = true;
          }
        }
        if (!open) {
          toggle.setAttribute('aria-expanded', 'true');
          flyout.hidden = false;
        }
      });
      group.append(toggle, flyout);
      return group;
    }

    const label = document.createElement('div');
    label.className = 'menu__group-label';
    label.textContent = node.label;
    group.append(label, flyout);
    return group;
  }

  #closeOpenMenu({ restoreFocus = false } = {}) {
    if (!this.#openMenu) return;
    const panel = this.#openMenu.querySelector('.menu__panel');
    const button = this.#openMenu.querySelector('.menu__button');
    if (panel) panel.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    this.#openMenu = null;
    // Escaping out of a menu must put focus back on its button, or focus is lost to
    // <body> and the keyboard user has to start again from the top of the page.
    if (restoreFocus && button) this.#focusTop(button);
  }

  // --- keyboard model --------------------------------------------------------

  /** Top-level menu buttons, in visual order. */
  #topButtons() {
    return [...this.#host.querySelectorAll('.menu__button')];
  }

  /**
   * The focusable items of a menu, in order.
   *
   * Flat on purpose: a "submenu" here renders as a labelled `role="group"` with an
   * inline flyout rather than a real nested menu, so a DOM-order query already gives
   * the sequence a reader sees. That is why this needs none of the Right-opens-child /
   * Left-returns-to-parent machinery the full APG pattern carries.
   */
  #menuItems(wrapper) {
    const panel = wrapper?.querySelector('.menu__panel');
    return panel ? [...panel.querySelectorAll('.menu__item')].filter((b) => !b.disabled) : [];
  }

  /** Move the single tab stop to `button` and focus it. */
  #focusTop(button) {
    for (const b of this.#topButtons()) b.tabIndex = b === button ? 0 : -1;
    button?.focus();
  }

  /**
   * Open a menu, optionally landing focus on its first or last item.
   * @param {HTMLElement} wrapper
   * @param {{focus?: 'first'|'last'|'none'}} [opts]
   */
  #open(wrapper, { focus = 'none' } = {}) {
    const panel = wrapper.querySelector('.menu__panel');
    const button = wrapper.querySelector('.menu__button');
    if (!panel || !button) return;
    if (this.#openMenu && this.#openMenu !== wrapper) this.#closeOpenMenu();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    this.#openMenu = wrapper;
    // Clamp the panel so a long menu (e.g. Regression) scrolls *within itself* and
    // never spills past the window bottom. Its top depends on which wrapped menubar
    // row the button sits on, so measure it live rather than assuming a fixed offset
    // (the CSS max-height is only a fallback).
    const top = panel.getBoundingClientRect().top;
    panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
    if (focus === 'none') return;
    const items = this.#menuItems(wrapper);
    const target = focus === 'last' ? items[items.length - 1] : items[0];
    target?.focus();
  }

  /** Move focus within a list, wrapping at both ends. */
  #focusAt(list, index) {
    if (!list.length) return;
    const el = list[(index + list.length) % list.length];
    el.focus();
    // Long menus scroll inside themselves; keep the focused row visible.
    el.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * Jump to the next entry starting with `char`, from `from` onward and wrapping.
   * Menus here run to dozens of plugin entries, so first-letter navigation is the
   * difference between usable and a long press-and-hold on Down.
   */
  #typeahead(list, char, from) {
    const lower = char.toLowerCase();
    for (let i = 1; i <= list.length; i++) {
      const el = list[(from + i) % list.length];
      if ((el.textContent || '').trim().toLowerCase().startsWith(lower)) return el;
    }
    return null;
  }

  /** The ARIA menubar keyboard model, delegated from the menubar element. */
  #onKeydown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    const onButton = target.classList?.contains('menu__button');
    const onItem = target.classList?.contains('menu__item');
    if (!onButton && !onItem) return;

    const wrapper = target.closest('.menu');
    const buttons = this.#topButtons();
    const button = wrapper?.querySelector('.menu__button');
    const topIndex = buttons.indexOf(button);
    const items = this.#menuItems(wrapper);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };

    /** Move to an adjacent top-level menu. From inside a menu, the new one opens. */
    const moveTop = (delta) => {
      const next = buttons[(topIndex + delta + buttons.length) % buttons.length];
      const nextWrapper = next.closest('.menu');
      const wasOpen = !!this.#openMenu;
      this.#closeOpenMenu();
      this.#focusTop(next);
      // A menu bar with something already open keeps showing menus as you arrow
      // along it — the behaviour every desktop menu bar has.
      if (wasOpen) this.#open(nextWrapper, { focus: onItem ? 'first' : 'none' });
    };

    switch (e.key) {
      case 'ArrowRight': stop(); moveTop(+1); return;
      case 'ArrowLeft': stop(); moveTop(-1); return;

      case 'ArrowDown':
        stop();
        if (onButton) this.#open(wrapper, { focus: 'first' });
        else this.#focusAt(items, items.indexOf(target) + 1);
        return;

      case 'ArrowUp':
        stop();
        if (onButton) this.#open(wrapper, { focus: 'last' });
        else this.#focusAt(items, items.indexOf(target) - 1);
        return;

      case 'Home':
        stop();
        if (onButton) this.#focusTop(buttons[0]);
        else this.#focusAt(items, 0);
        return;

      case 'End':
        stop();
        if (onButton) this.#focusTop(buttons[buttons.length - 1]);
        else this.#focusAt(items, items.length - 1);
        return;

      case 'Enter':
      case ' ':
        // Native activation is right for an item; on a closed button, open it.
        if (onButton && this.#openMenu !== wrapper) { stop(); this.#open(wrapper, { focus: 'first' }); }
        return;

      case 'Escape':
        if (this.#openMenu) { stop(); this.#closeOpenMenu({ restoreFocus: true }); }
        return;

      case 'Tab':
        // Leave the menubar entirely — but do NOT preventDefault, so Tab still moves.
        this.#closeOpenMenu();
        return;

      default: break;
    }

    if (e.key.length === 1 && /\S/.test(e.key)) {
      const list = onItem ? items : buttons;
      const from = list.indexOf(target);
      const hit = this.#typeahead(list, e.key, from < 0 ? -1 : from);
      if (!hit) return;
      stop();
      if (onItem) hit.focus();
      else this.#focusTop(hit);
    }
  }
}

/** @returns {MenuNode} */
function makeNode(label, order) {
  return { label, order, children: new Map(), item: undefined };
}

/** Sort comparator: ascending order weight, then label A→Z. */
/** A group heading with its open/closed caret. The caret is its own span so the glyph can
 * rotate on expand without a second text node, and so a translator never sees it. */
function nodeLabelWithCaret(label) {
  const frag = document.createDocumentFragment();
  const caret = document.createElement('span');
  caret.className = 'menu__caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▸';
  frag.append(caret, document.createTextNode(label));
  return frag;
}

function byOrderThenLabel(a, b) {
  return a.order - b.order || a.label.localeCompare(b.label);
}

/** Top-level menubar order: the **host (built-in) menus** are pinned by convention
 * in a fixed order — File, Edit, Transform — and everything else (plugin-
 * contributed, e.g. Analyze, Graphs) sorts alphabetically after them. The guiding
 * idea: turn off every plugin and the base menus stay exactly where they are. */
// Help is pinned LAST (999) rather than left to the alphabetical fallback, where it
// would land among the analysis menus — 'Help' sorts between 'Graphs' and 'Regression'.
// Every desktop app puts it at the right-hand end; that is where people look for it.
const TOP_LEVEL_RANK = { File: 0, Edit: 1, Transform: 2, Help: 999 };
function byTopLevel(a, b) {
  const ra = TOP_LEVEL_RANK[a.label] ?? 100;
  const rb = TOP_LEVEL_RANK[b.label] ?? 100;
  return ra - rb || a.label.localeCompare(b.label);
}
