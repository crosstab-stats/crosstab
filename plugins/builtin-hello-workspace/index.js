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
 * Styles are applied via the CSSOM (element.style.*), not <style>/style attributes,
 * because the sandbox CSP is `default-src 'none'` (inline style attributes are
 * blocked, but the CSSOM is not).
 */

/** @type {import('../../core/loader.js').PluginManifest} */
export const manifest = {
  id: 'builtin-hello-workspace',
  name: 'Hello Workspace',
  version: '0.1.0',
  apiVersion: '0.1.0',
  category: 'Workspaces',
  keywords: ['workspace', 'demo', 'reference', 'tab'],
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
    root.textContent = '';
    css(document.body, { margin: '0', font: '14px system-ui, sans-serif', color: '#1a1a1a' });

    const wrap = css(document.createElement('div'), { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '560px' });

    const h = document.createElement('h2');
    h.textContent = 'Hello, workspace 👋';
    css(h, { margin: '0', fontSize: '18px', fontWeight: '500' });

    const blurb = document.createElement('p');
    blurb.textContent =
      'This tab is a sandboxed plugin iframe. What you type is saved into the project (app.state.set) and restored when you reopen it (app.state.get).';
    css(blurb, { margin: '0', color: '#555', lineHeight: '1.5' });

    const label = document.createElement('label');
    label.textContent = 'A note (persisted with the project):';
    css(label, { fontWeight: '500' });
    const area = document.createElement('textarea');
    area.rows = 4;
    css(area, { width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: '6px', border: '1px solid #ccc', font: 'inherit' });

    const status = document.createElement('div');
    css(status, { fontSize: '12px', color: '#7a8590', minHeight: '16px' });

    const dataRow = css(document.createElement('div'), { display: 'flex', gap: '8px', alignItems: 'center' });
    const countBtn = document.createElement('button');
    countBtn.type = 'button';
    countBtn.textContent = 'Count dataset rows (proves host access)';
    css(countBtn, { padding: '6px 10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f3f6fa', cursor: 'pointer', font: 'inherit' });
    const countOut = document.createElement('span');
    css(countOut, { color: '#1d2733' });
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
