/**
 * @file plugins/builtin-hello-workspace/index.js
 * Reference WORKSPACE plugin (#93) — the spike that proves the loop end to end:
 *
 *   manifest.workspaces → host adds a tab → the plugin's UI renders in a sandboxed
 *   iframe inside that tab → it reads host data (app.data) and persists an opaque
 *   blob (app.state.set) that survives a project reopen (app.state.get on mount).
 *
 * It is NOT a real feature — just the smallest thing that exercises every seam, so
 * CAQDAS (#67) can be built on a proven primitive. Off by default; enable it in
 * Edit ▸ Plugins to see the "Hello WS" tab.
 *
 * ── State persistence: DON'T write during mount ──────────────────────────────
 * Read your saved blob with `app.state.get()` on mount; only call `app.state.set()`
 * in response to a *real user change* (see the textarea handler below — it persists
 * on input, never on mount). A mount-time write is dangerous: if the workspace ever
 * mounts before its saved state has been restored, that write persists an
 * empty/default blob OVER the user's real data. (This caused a CAQDAS codebook-loss
 * bug: an auto-guessed default column was save()d during mount and clobbered the
 * saved coding.) Deriving a default on mount is fine — just set it in memory and let
 * it persist on the first genuine edit. The host does hydrate state before mounting
 * and blocks interaction until the workspace is ready, but treat "no writes during
 * mount" as the contract so your plugin stays safe regardless of load ordering.
 *
 * ## Styling: take the standard, do not re-invent it
 *
 * This file is the one people copy, so what it demonstrates becomes what the next
 * workspace does. It used to hand-roll a `css()` helper and write `#555`, `#ccc`,
 * `#f3f6fa` — and every plugin that grew from it inherited colours no theme can move and
 * controls that fail a touch target.
 *
 * So: inject `app.std.injectStdlibStyles(document)` FIRST, then use the classes it
 * brings — `.ct-btn`, `.ct-field`, `.ct-row` — and the tokens `var(--ct-text)`,
 * `var(--ct-muted)`, `var(--ct-surface)`, `var(--ct-line)`, `var(--ct-accent)`. You get
 * the 16px that stops iOS zooming on focus and the 44px touch targets for free, which is
 * the whole reason the standard ships components and not just a palette.
 *
 * Where a style genuinely is yours (a layout, a gap), set it through the CSSOM
 * (element.style.*) rather than a style ATTRIBUTE: the sandbox CSP is
 * `default-src 'none'`, which blocks the attribute but not the object model.
 *
 * Rule of thumb: if you are typing a `#` followed by hex, stop and ask which token you
 * mean. If there genuinely isn't one, that is worth raising — a missing token is a gap
 * in the standard, not a licence to write a literal.
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-hello-workspace',
  name: 'Hello Workspace',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Workspaces',
  keywords: ['workspace', 'demo', 'reference', 'tab'],
  howto:
    'GUI: appears as a workspace tab (Hello WS) once enabled in Edit ▸ Plugins. A reference demo: type a note that persists with the project and count dataset rows.\n' +
    'Used as a workspace tab, not a run command.',
  // How-to topics (#192). The index is small and always-resident; the prose lives
  // in howto.md, which ships with the plugin and is read when a topic is opened.
  howtoFile: 'howto.md',
  howtoIndex: [
    {
      id: 'hello-workspace',
      title: 'Hello Workspace (reference demo)',
      category: 'Workspaces',
      keywords: ['hello workspace', 'demo', 'example', 'reference', 'plugin development', 'workspace tab', 'template', 'developer'],
      needs: ['builtin-hello-workspace'],
      seeAlso: ['find-an-analysis'],
    },
  ],
  workspaces: [{ id: 'hello-workspace', title: 'Hello WS' }],
};

/** Workspace surface: the host calls mount() after activate, handing the plugin
 * its `app` proxy and the (visible) iframe body to render into. */
export const workspace = {
  async mount(app, root) {
    const css = (el, styles) => {
      for (const k of Object.keys(styles)) el.style[k] = styles[k];
      return el;
    };
    // The host's base sheet: tokens, the control primitives, the no-zoom font floor and
    // the touch targets. Optional-chained because a build that failed to serve the
    // stdlib must not take the pane down with it — the pane just looks plainer.
    app.std?.injectStdlibStyles?.(document);
    root.textContent = '';
    // The sheet already sets body font and colour from the tokens; nothing to repeat.

    const wrap = css(document.createElement('div'), { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '560px' });

    const h = document.createElement('h2');
    h.textContent = 'Hello, workspace 👋';
    css(h, { margin: '0', fontSize: '18px', fontWeight: '500' });

    const blurb = document.createElement('p');
    blurb.textContent =
      'This tab is a sandboxed plugin iframe. What you type is saved into the project (app.state.set) and restored when you reopen it (app.state.get).';
    css(blurb, { margin: '0', color: 'var(--ct-muted)', lineHeight: '1.5' });

    const label = document.createElement('label');
    label.textContent = 'A note (persisted with the project):';
    css(label, { fontWeight: '500' });
    const area = document.createElement('textarea');
    area.rows = 4;
    // `.ct-field` carries the border, radius and padding — and the sizing rules that
    // keep it usable on a phone. Only what is genuinely this pane's is set here.
    area.className = 'ct-field';
    css(area, { width: '100%', boxSizing: 'border-box' });

    const status = document.createElement('div');
    css(status, { fontSize: '12px', color: 'var(--ct-muted)', minHeight: '16px' });

    // `.ct-row` is a wrapping row of controls — it wraps rather than overflowing,
    // because a control you cannot see is a control you do not have.
    const dataRow = document.createElement('div');
    dataRow.className = 'ct-row';
    const countBtn = document.createElement('button');
    countBtn.type = 'button';
    countBtn.textContent = 'Count dataset rows (proves host access)';
    countBtn.className = 'ct-btn';
    const countOut = document.createElement('span');
    css(countOut, { color: 'var(--ct-text)' });
    dataRow.append(countBtn, countOut);

    wrap.append(h, blurb, label, area, status, dataRow);
    root.append(wrap);

    // Rehydrate from the persisted blob (the whole point — survives reopen).
    const saved = await app.state.get();
    if (saved && typeof saved.note === 'string') {
      area.value = saved.note;
      status.textContent = saved.savedAt ? `restored — last saved ${new Date(saved.savedAt).toLocaleTimeString()}` : 'restored';
    }

    // Persist on every edit (debounced). The host marks the project dirty.
    let timer = null;
    area.addEventListener('input', () => {
      status.textContent = 'saving…';
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        await app.state.set({ note: area.value, savedAt: Date.now() });
        status.textContent = `saved ${new Date().toLocaleTimeString()}`;
      }, 400);
    });

    // Prove the host service bridge works from within the workspace.
    countBtn.addEventListener('click', async () => {
      try {
        const n = await app.data.getRowCount();
        countOut.textContent = `active dataset has ${Number(n).toLocaleString()} rows`;
      } catch (err) {
        countOut.textContent = `error: ${err.message}`;
      }
    });
  },
};
