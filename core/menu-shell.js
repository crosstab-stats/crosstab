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

/**
 * @typedef {Object} MenuItem
 * @property {string[]} path - Menu hierarchy this item lives under, top-level
 *   first, e.g. `['Analyze', 'Descriptive Statistics']`. An empty array places
 *   the item directly on the menubar (rare).
 * @property {string} label - Visible item text, e.g. `'Frequencies…'`.
 * @property {() => void} command - Invoked when the item is chosen.
 * @property {string} [id] - Stable id (defaults to `path.join('/')+'/'+label`).
 *   Registering the same id again replaces the previous item.
 * @property {number} [order=100] - Sort weight within its submenu (lower first).
 */

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

  /**
   * @param {HTMLElement} host - Container for the menubar (e.g. a `<nav>`).
   */
  constructor(host) {
    this.#host = host;
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
    for (const node of topLevel) {
      this.#host.append(this.#renderTopLevel(node));
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
      try {
        node.item.command();
      } catch (err) {
        console.error(`Menu command "${node.item.id}" threw`, err);
      }
    });
    return el;
  }

  /** Render a nested submenu as a labelled group with an inline flyout. */
  #renderSubmenu(node) {
    const group = document.createElement('div');
    group.className = 'menu__group';
    group.setAttribute('role', 'group');

    const label = document.createElement('div');
    label.className = 'menu__group-label';
    label.textContent = node.label;

    const flyout = document.createElement('div');
    flyout.className = 'menu__flyout';
    this.#renderChildrenInto(flyout, node);

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
function byOrderThenLabel(a, b) {
  return a.order - b.order || a.label.localeCompare(b.label);
}

/** Top-level menubar order: the **host (built-in) menus** are pinned by convention
 * in a fixed order — File, Edit, Transform — and everything else (plugin-
 * contributed, e.g. Analyze, Graphs) sorts alphabetically after them. The guiding
 * idea: turn off every plugin and the base menus stay exactly where they are. */
const TOP_LEVEL_RANK = { File: 0, Edit: 1, Transform: 2 };
function byTopLevel(a, b) {
  const ra = TOP_LEVEL_RANK[a.label] ?? 100;
  const rb = TOP_LEVEL_RANK[b.label] ?? 100;
  return ra - rb || a.label.localeCompare(b.label);
}
