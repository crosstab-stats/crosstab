/**
 * @file help.js
 * The **Help** menu, and the server-free bug report behind it (#175, #182).
 *
 * ## Why a bug report needs no server
 *
 * The app builds a pre-filled report and hands it to the user; the USER submits it.
 * Nothing is transmitted by CrossTab, which is what makes the privacy claim true rather
 * than a promise: "diagnostics, never data" is enforced by the reporter reading the text
 * before they press Submit, not by our good behaviour. It also means no backend, no form
 * host, no account of ours in the path — the deep link is just a URL that any public
 * GitHub repo with Issues enabled will honour.
 *
 * What goes in: build stamp, browser/OS string, whether the page is cross-origin
 * isolated (the single most common cause of "R won't start"), the SHAPE of the active
 * dataset — variable and row COUNTS — the enabled plugins, and the last uncaught error.
 * What never goes in: cell values, variable names, labels, file names, project names. A
 * GitHub issue is world-readable, so the line is drawn at counts.
 *
 * ## The URL budget is a real constraint, not a detail
 *
 * `issues/new?body=…` is a GET. Browsers and proxies cap URL length (commonly around
 * 8 KB, sometimes less), and a silently truncated URL loses the END of the body — which
 * is where a stack trace would be. So the body is assembled shortest-first-most-useful,
 * measured, and clipped with a visible marker: a report that says it was trimmed is
 * honest, one that just stops is not.
 */

import { lastError } from './debug.js';
import { formatBuildTime, runningBuildStamp } from './build-stamp.js';

/** The public repo the deep links point at. One constant, because a fork that wants its
 * own issue tracker should have exactly one line to change (and see #175's note about
 * a self-hoster's own contact route). */
export const REPO = 'crosstab-stats/crosstab';

/** Ceiling for the assembled URL. Under the ~8 KB most browsers and proxies allow, with
 * room for the origin and the query scaffolding. */
const URL_BUDGET = 6000;

/**
 * Sanitised diagnostics for a bug report — **shapes, never data**.
 *
 * Every field here is either about the app or a COUNT. The dataset contributes its
 * variable and row totals and nothing else: not a variable name, not a value, not the
 * file it came from. That rule is what lets the report be pasted into a world-readable
 * issue without a judgement call each time.
 *
 * @param {object} deps
 * @param {{all?: Function, active?: object}} [deps.datasets]
 * @param {{list?: Function}} [deps.loader] - PluginLoader: the AUTHORITY on what is
 *   actually wired. Preferred over the plugin manager's view — see below.
 * @param {{list?: Function}} [deps.plugins] - PluginManager, used only as a fallback.
 * @returns {Promise<object>} plain fields, ready to render
 */
export async function collectDiagnostics({ datasets, loader, plugins } = {}) {
  const out = {
    build: formatBuildTime(await runningBuildStamp().catch(() => null)) || 'unknown',
    browser: (navigator.userAgent || 'unknown').slice(0, 300),
    platform: navigator.platform || '',
    isolated: typeof crossOriginIsolated === 'boolean' ? String(crossOriginIsolated) : 'unknown',
    online: String(!!navigator.onLine),
    datasets: '0',
    shape: 'none open',
    plugins: '',
    error: '',
  };
  try {
    const all = datasets?.all?.() ?? [];
    out.datasets = String(all.length);
    const active = datasets?.active;
    if (active) {
      // Counts only. `getVariableMeta` returns names and labels; we take its LENGTH.
      const vars = active.getVariableMeta?.()?.length ?? null;
      const rows = active.rowCount ?? null;
      out.shape = `${vars ?? '?'} variables × ${rows ?? '?'} rows`;
      // A blank project is one EMPTY dataset, so a real session legitimately reports
      // 0 × 0 — which reads like a failed measurement rather than a fact. It fooled its
      // own author on the first report off a device, so it says which it is: a triager
      // seeing this should be asking about a blank start, not about broken diagnostics.
      if (vars === 0 && rows === 0) out.shape += ' (blank project — nothing imported yet)';
    }
  } catch {
    out.shape = 'unreadable';
  }
  try {
    // Plugin IDs are public identifiers of shipped code, not user content.
    //
    // Read from the LOADER, not the plugin manager. `PluginManager#list()` reports
    // `activated` by joining the loaded set against the persisted CATALOG, so an entry
    // the catalog has not probed yet comes back `activated: false` even while its code
    // is loaded and its menus are on screen. A CATALOG_VERSION bump clears that catalog,
    // which is exactly when someone has just installed a new build — i.e. exactly when
    // they are most likely to be filing a bug. First real report off the iPhone PWA said
    // "Plugins enabled: (none)" for a session with every core plugin running.
    //
    // `loader.list()` is the loaded manifests themselves: no catalog, no join, no lag.
    const ids = (loader?.list?.() ?? []).map((m) => m?.id).filter(Boolean);
    out.plugins = ids.length
      ? ids.join(', ')
      : (plugins?.list?.() ?? []).filter((p) => p.activated).map((p) => p.id || p.key).join(', ');
  } catch {
    out.plugins = 'unreadable';
  }
  const err = lastError();
  if (err) out.error = `${err.time} ${err.where ? `(${err.where}) ` : ''}${err.message}\n${err.stack}`.trim();
  return out;
}

/**
 * The issue body, in the order a reader of the issue wants it: what happened first,
 * machine details last.
 *
 * The three prompts are left EMPTY on purpose. A pre-filled "Steps to reproduce: 1.
 * ..." reads as already answered and gets submitted untouched; a blank line under a
 * heading reads as a question.
 *
 * @param {object} diag  from {@link collectDiagnostics}
 * @returns {string}
 */
export function bugReportBody(diag) {
  const block = [
    `- App build: ${diag.build}`,
    `- Browser: ${diag.browser}`,
    diag.platform ? `- Platform: ${diag.platform}` : '',
    `- Cross-origin isolated: ${diag.isolated}`,
    `- Online: ${diag.online}`,
    `- Datasets open: ${diag.datasets}`,
    `- Active dataset size: ${diag.shape}`,
    diag.plugins ? `- Plugins enabled: ${diag.plugins}` : '- Plugins enabled: (none)',
  ].filter(Boolean).join('\n');

  return [
    '### What happened',
    '',
    '',
    '### What you expected instead',
    '',
    '',
    '### Steps to reproduce',
    '',
    '',
    '---',
    '',
    '<details><summary>Diagnostics (filled in automatically — edit or delete anything)</summary>',
    '',
    block,
    '',
    diag.error ? `**Last error**\n\n\`\`\`\n${diag.error}\n\`\`\`\n` : '',
    '</details>',
    '',
    '_No data from your project is included — only the counts above. Please check before '
    + 'submitting: this issue will be public._',
  ].filter((x) => x !== null).join('\n');
}

/**
 * The deep link, clipped to {@link URL_BUDGET}.
 *
 * Clipping drops the diagnostics block's tail rather than the prompts, because the
 * prompts are what the reporter fills in and the tail is the stack trace — useful, but
 * not at the cost of the report arriving mangled. The marker is visible in the issue so
 * nobody wonders why it ends mid-line.
 *
 * @param {object} diag
 * @returns {{url: string, clipped: boolean}}
 */
export function bugReportUrl(diag) {
  const base = `https://github.com/${REPO}/issues/new`;
  const make = (body) => `${base}?labels=bug&title=${encodeURIComponent('')}&body=${encodeURIComponent(body)}`;
  let body = bugReportBody(diag);
  let url = make(body);
  if (url.length <= URL_BUDGET) return { url, clipped: false };
  // Too long: the error text is the only unbounded part, so shed it first.
  body = bugReportBody({ ...diag, error: '' })
    + '\n\n_(The error details were too long for this link and were left out — paste them '
    + 'here if you have them.)_';
  url = make(body);
  if (url.length <= URL_BUDGET) return { url, clipped: true };
  // Still too long (an extraordinary plugin list or UA): clip the whole body bluntly.
  const room = URL_BUDGET - make('').length;
  body = `${body.slice(0, Math.max(0, Math.floor(room / 3)))}\n\n_(Report truncated.)_`;
  return { url: make(body), clipped: true };
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * "Caveats & limits" — an honest list of the structural limits of running a whole stats
 * stack in a browser.
 *
 * Lifted out of `launcher.js` (#182) so the Help menu and the launcher footer open the
 * SAME dialog. It was previously reachable only from the launcher, which means it was
 * unreachable from the moment a project opened — the point at which someone actually
 * hits one of these limits and wants to know whether it is a bug.
 */
export function showCaveats() {
  const d = document.createElement('dialog');
  d.className = 'ct-dialog ct-dialog--wide';
  d.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">Caveats &amp; limits — the honest version</h2>
      <div class="ctl__howto-body">
        <p>CrossTab runs entirely in your browser, on your device. That's what keeps
          your data private and lets it work offline — but it also means a few real
          limits we haven't been able to engineer away. Here's what to expect.</p>
        <p><strong>Scrolling a large dataset can lag.</strong> The data grid streams
          rows from an on-disk store instead of holding the whole table in memory, so
          scrolling through a big dataset may take a second to catch up.
          <em>Your data is complete and correct — the view just paints a beat behind.</em></p>
        <p><strong>R analyses are capped at a few GB.</strong> The in-browser R engine
          is 32-bit, so any single R-based analysis can address only a few gigabytes at
          once. <em>Basic data handling scales further (the out-of-core store does that),
          but a heavy model on a very large dataset can run out of memory — work on a
          subset or a sample if you hit it.</em></p>
        <p><strong>First use needs the internet — once.</strong> The R engine and each
          stats package download the first time they're used (tens of MB).
          <em>After that they're cached; you can also pre-cache everything for offline or
          air-gapped use from the loading screen.</em></p>
        <p><strong>Speed depends on your device.</strong> Every computation runs locally,
          so a phone or tablet is slower than a desktop and a heavy model can take a while.
          <em>Nothing is sent to a server to speed it up — that's the trade-off for full
          privacy.</em></p>
      </div>
      <menu class="ct-dialog__buttons"><button value="ok" type="submit" class="ct-dialog__primary">Got it</button></menu>
    </form>`;
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/**
 * "Getting around" — the one-screen orientation: what the menubar, sidebar and
 * workspace tabs are, and how to run an analysis.
 *
 * Also lifted out of `launcher.js` (#182), where it was the "How to use →" link and, as
 * with the caveats, stopped being reachable the instant a project opened — so the one
 * moment a newcomer wants it back ("wait, which tab was Output?") was the one moment it
 * was gone.
 *
 * Renamed on the way out. It is NOT the how-to guide (#184): it is four paragraphs of
 * orientation, and calling it "How to use CrossTab" in a Help menu would promise
 * documentation that does not exist yet.
 */
export function showGettingAround() {
  const d = document.createElement('dialog');
  d.className = 'ct-dialog ct-dialog--wide';
  d.innerHTML = `
    <form method="dialog" class="ct-dialog__form">
      <h2 class="ct-dialog__title">Getting around CrossTab</h2>
      <div class="ctl__howto-body">
        <p><strong>Menubar</strong> (top) — File, Edit, and your analysis menus. The analyses you see are the plugins you switched on; add more anytime via <em>Edit ▸ Plugins…</em> or by clicking <strong>CrossTab</strong> in the corner to reopen the start screen.</p>
        <p><strong>Sidebar</strong> (left) — your project and its datasets. Import a file, or pick a demo on the start screen to explore.</p>
        <p><strong>Workspace tabs</strong> — <em>Data</em> (the grid), <em>Variables</em> (rename/recode/label), <em>Output</em> (your results), and an <em>R Console</em>.</p>
        <p><strong>Run an analysis</strong> — pick it from a menu, choose variables in the dialog, and the result appears in Output (export it from <em>File</em>).</p>
      </div>
      <menu class="ct-dialog__buttons"><button value="ok" type="submit" class="ct-dialog__primary">Got it</button></menu>
    </form>`;
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/**
 * The review step before anything leaves the app.
 *
 * Deliberately a dialog and not a straight `window.open`: the promise of this feature is
 * that the user sees what is being sent, and a link that silently carries a payload to a
 * pre-filled form has already broken it once the form is open. So the diagnostics are
 * shown here, in full, with the option to open the issue WITHOUT them.
 */
async function openBugReport(deps) {
  const diag = await collectDiagnostics(deps);
  const d = document.createElement('dialog');
  d.className = 'ct-dialog ct-dialog--wide';
  const form = el('div', 'ct-dialog__form');
  form.append(el('h2', 'ct-dialog__title', 'Report a bug'));
  form.append(el('p', 'ct-dialog__hint',
    'This opens a new issue on the public CrossTab repository with the details below '
    + 'filled in. Nothing is sent from here — you review it on GitHub and press Submit '
    + 'yourself. A GitHub account is needed to post.'));

  const pre = el('pre', 'help__diag');
  pre.textContent = [
    `App build: ${diag.build}`,
    `Browser: ${diag.browser}`,
    diag.platform ? `Platform: ${diag.platform}` : '',
    `Cross-origin isolated: ${diag.isolated}`,
    `Online: ${diag.online}`,
    `Datasets open: ${diag.datasets}`,
    `Active dataset size: ${diag.shape}`,
    `Plugins enabled: ${diag.plugins || '(none)'}`,
    diag.error ? `\nLast error:\n${diag.error}` : '',
  ].filter(Boolean).join('\n');
  form.append(pre);
  form.append(el('p', 'help__note',
    'Only the counts above are included — never your variable names, values or file '
    + 'names. The issue will be public, so have a look before you submit.'));

  const buttons = el('menu', 'ct-dialog__buttons');
  const cancel = el('button', null, 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => d.close());
  const plain = el('button', null, 'Open without diagnostics');
  plain.type = 'button';
  plain.addEventListener('click', () => {
    d.close();
    window.open(`https://github.com/${REPO}/issues/new?labels=bug`, '_blank', 'noopener');
  });
  const go = el('button', 'ct-dialog__primary', 'Open GitHub issue');
  go.type = 'button';
  go.addEventListener('click', () => {
    d.close();
    window.open(bugReportUrl(diag).url, '_blank', 'noopener');
  });
  buttons.append(cancel, plain, go);
  form.append(buttons);

  injectStyles();
  d.append(form);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/**
 * Register the Help menu.
 *
 * Help earns a top-level menu because six things want to live in it, not because a bug
 * report needed a home: the report, Discussions, Caveats & limits (previously reachable
 * only from the launcher), the syntax guide (previously only from the History panel),
 * the plugin/analysis lookup (#183) and an eventual how-to guide (#184).
 *
 * @param {object} deps
 * @param {{register: Function}} deps.menus
 * @param {object} [deps.datasets]
 * @param {object} [deps.loader]
 * @param {object} [deps.plugins]
 * @param {Function} [deps.openSyntaxGuide]
 * @param {object} [deps.pluginActions]
 */
export function registerHelpMenu({ menus, datasets, loader, plugins, openSyntaxGuide, pluginActions }) {
  const link = (url) => window.open(url, '_blank', 'noopener');

  menus.register({
    id: 'core:help-around',
    path: ['Help'],
    label: 'Getting around…',
    order: 1,
    command: () => showGettingAround(),
  });
  // No "How to use CrossTab…" item yet: the guide is #184 and does not exist. "Getting
  // around" is four paragraphs of orientation and is named as such — an item promising
  // documentation and opening a blurb spends the reader's trust once and teaches them
  // the menu lies.
  if (openSyntaxGuide) {
    menus.register({
      id: 'core:help-syntax',
      path: ['Help'],
      label: 'Syntax guide…',
      order: 2,
      command: () => openSyntaxGuide({ pluginActions }),
    });
  }
  menus.register({
    id: 'core:help-caveats',
    path: ['Help'],
    label: 'Caveats & limits…',
    order: 3,
    command: () => showCaveats(),
  });
  menus.register({
    id: 'core:help-bug',
    path: ['Help'],
    label: 'Report a bug…',
    order: 4,
    command: () => void openBugReport({ datasets, loader, plugins }),
  });
  menus.register({
    id: 'core:help-discuss',
    path: ['Help'],
    label: 'Ask a question (Discussions)…',
    order: 5,
    command: () => link(`https://github.com/${REPO}/discussions`),
  });
  menus.register({
    id: 'core:help-source',
    path: ['Help'],
    label: 'Source code…',
    order: 6,
    command: () => link(`https://github.com/${REPO}`),
  });
}

let styled = false;
function injectStyles() {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = `
    .help__diag { background: #f6f8fa; border: 1px solid #e2e7ec; border-radius: 6px;
      padding: 10px 12px; font-size: 12px; line-height: 1.5; max-height: 40vh;
      overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
    .help__note { font-size: .85em; color: #5a6470; margin: 0 0 4px; }
  `;
  document.head.append(s);
}
