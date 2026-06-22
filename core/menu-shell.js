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
      if (!isOpen) {
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        this.#openMenu = wrapper;
        // Clamp the panel so a long menu (e.g. Regression) scrolls *within itself*
        // and never spills past the window bottom. Its top depends on which wrapped
        // menubar row the button sits on, so measure it live rather than assuming a
        // fixed offset (the CSS max-height is only a fallback).
        const top = panel.getBoundingClientRect().top;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
      }
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

  #closeOpenMenu() {
    if (!this.#openMenu) return;
    const panel = this.#openMenu.querySelector('.menu__panel');
    const button = this.#openMenu.querySelector('.menu__button');
    if (panel) panel.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
    this.#openMenu = null;
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
