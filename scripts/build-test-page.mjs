/**
 * @file scripts/build-test-page.mjs
 * Render docs/TESTING.md as a single self-contained HTML page whose checks actually
 * tick, with per-section tallies and progress kept in localStorage.
 *
 * Generated rather than hand-written so the page and the document cannot drift: edit
 * TESTING.md, re-run this, republish. The markdown stays the source of truth — it is
 * the version that lives in git and can be reviewed in a diff.
 *
 *   node scripts/build-test-page.mjs [outFile]
 *
 * Markdown understood here is only what TESTING.md actually uses: `##`/`###` headings,
 * `- [ ]` checks with six-space continuation lines, pipe tables, blockquotes, fenced
 * code, and inline bold/italic/code/links. It is not a general markdown engine, and it
 * does not need to be.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(repo, 'docs/TESTING.md');
const OUT = path.resolve(process.argv[2] || path.join(repo, 'testing.html'));

const md = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown → HTML. Code spans first, so their contents are never re-parsed. */
function inline(s) {
  const code = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  // A backslash-escaped asterisk (G\*Power) must not read as emphasis punctuation, or
  // the surrounding **bold** never closes and the markers survive into the output.
  t = t.replace(/\\\*/g, '@@AST@@');
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    (_, txt, href) => `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`);
  // `[^*]+` could not cross a nested single asterisk, so `**bold with *italic* inside**`
  // failed to match and left its markers in the output. Allow anything that is not a
  // closing `**`, non-greedily, and let the italic pass below handle the inner pair.
  t = t.replace(/\*\*((?:(?!\*\*)[\s\S])+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[+i])}</code>`);
  // The escaped asterisks, back as themselves.
  return t.replace(/@@AST@@/g, '*');
}

const lines = md.split('\n');
const sections = [];   // {num, title, count, html[]}
let intro = [];
let cur = null;
let i = 0;
let itemId = 0;

/** Flush a buffered paragraph/table/list block into a target array. */
function block(target, buf) {
  if (!buf.length) return;
  const whole = buf.join('\n');
  buf.length = 0;
  // Split into paragraphs on blank lines, keeping a fenced code block whole. Flushing
  // the whole run as ONE block (an earlier version did) meant paragraph breaks and
  // fences were never seen, so a page of prose came out as a single run-on <p>.
  const paras = [];
  let acc = [];
  let fence = false;
  for (const raw of whole.split('\n')) {
    if (/^```/.test(raw.trim())) {
      if (fence) { acc.push(raw); paras.push(acc.join('\n')); acc = []; fence = false; }
      else { if (acc.length) { paras.push(acc.join('\n')); acc = []; } acc.push(raw); fence = true; }
      continue;
    }
    if (fence) { acc.push(raw); continue; }
    if (!raw.trim()) { if (acc.length) { paras.push(acc.join('\n')); acc = []; } continue; }
    acc.push(raw);
  }
  if (acc.length) paras.push(acc.join('\n'));
  for (const para of paras) emit(target, para);
}

/** One paragraph-sized chunk of markdown → one HTML element. */
function emit(target, chunk) {
  const text = chunk.trim();
  if (!text) return;
  if (text.startsWith('```')) {
    const inner = text.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    target.push(`<pre class="scroll"><code>${esc(inner)}</code></pre>`);
    return;
  }
  if (text.startsWith('|')) {
    const rows = text.split('\n').filter((r) => r.trim().startsWith('|'));
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    target.push(`<div class="scroll"><table><thead><tr>${
      head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
      body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
    }</tbody></table></div>`);
  } else if (text.startsWith('> ')) {
    target.push(`<aside class="note">${inline(text.replace(/^> ?/gm, ''))}</aside>`);
  } else if (/^- /m.test(text) && !/^- \[/.test(text)) {
    const its = text.split(/\n(?=- )/).map((x) => x.replace(/^- /, '').replace(/\n\s+/g, ' '));
    target.push(`<ul class="plain">${its.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
  } else {
    target.push(`<p>${inline(text.replace(/\n\s*/g, ' '))}</p>`);
  }
}

let buf = [];
let inFence = false;
for (; i < lines.length; i++) {
  const ln = lines[i];

  // Fences are handled HERE, ahead of everything else, because the intro's fence shows
  // the shape of a check — including a literal `- [ ] **Name**` line. Letting the item
  // parser below see that line turned the example into a 261st check AND broke the
  // fence pairing, so the closing ``` opened a second fence that swallowed the rest of
  // the intro into a <pre>.
  if (/^```/.test(ln)) { inFence = !inFence; buf.push(ln); continue; }
  if (inFence) { buf.push(ln); continue; }

  const h2 = ln.match(/^## (?:(\d+)\. )?(.+)$/);
  if (h2) {
    block(cur ? cur.html : intro, buf);
    cur = { num: h2[1] || '', title: h2[2], count: 0, html: [] };
    sections.push(cur);
    continue;
  }
  const h3 = ln.match(/^### (.+)$/);
  if (h3) {
    block(cur ? cur.html : intro, buf);
    (cur ? cur.html : intro).push(`<h3>${inline(h3[1])}</h3>`);
    continue;
  }
  if (/^---\s*$/.test(ln)) { block(cur ? cur.html : intro, buf); continue; }
  if (/^# /.test(ln)) { continue; }

  // A checklist item: "- [ ] **Label** — rest", with continuation lines indented.
  const item = ln.match(/^- \[ \] (.*)$/);
  if (item) {
    block(cur ? cur.html : intro, buf);
    const body = [item[1]];
    while (i + 1 < lines.length && /^ {6}\S/.test(lines[i + 1])) body.push(lines[++i].trim());
    const joined = body.join(' ');
    const id = `c${++itemId}`;
    if (cur) cur.count++;

    // Split the body into its labelled lines.
    const parts = [];
    let rest = joined;
    const head = rest.match(/^(\*\*.+?\*\*)(?:\s+—\s+(.*))?$/s);
    let label = '';
    let tail = rest;
    // Only the real labels, and only past position 0: prose legitimately opens with
    // "Then …", and treating that as a label left the item with an empty name and its
    // text orphaned in the body.
    const firstLab = rest.search(/(Recipe:|Then:|Expect(?:,\s*exactly)?:|Reference:|Syntax:|⚠️)/);
    const headEnd = firstLab > 0 ? firstLab : rest.length;
    const headText = rest.slice(0, headEnd).trim();
    tail = rest.slice(headEnd).trim();
    const lm = headText.match(/^\*\*(.+?)\*\*\s*(?:—\s*(.*))?$/s);
    label = lm ? lm[1] : headText;
    const where = lm && lm[2] ? lm[2].trim() : '';

    // Break the tail on the known labels.
    const segs = [];
    // `Then:` marks a second step inside one check ("…now change it from the toolbar
    // instead"). Matched with its colon so the much commoner mid-sentence "Then run it
    // again…" is left alone.
    const re = /(Recipe:|Then:|Expect, exactly:|Expect too:|Expect for [^:]+:|Expect:|Reference:|Syntax:|⚠️)/g;
    let m; let last = 0; let lastKey = null;
    while ((m = re.exec(tail))) {
      if (lastKey !== null) segs.push([lastKey, tail.slice(last, m.index).trim()]);
      else if (m.index > 0) segs.push(['', tail.slice(0, m.index).trim()]);
      lastKey = m[1]; last = m.index + m[1].length;
    }
    if (lastKey !== null) segs.push([lastKey, tail.slice(last).trim()]);
    else if (tail) segs.push(['', tail]);

    const rowsHtml = segs.filter(([, v]) => v).map(([k, v]) => {
      if (k === '⚠️') return `<div class="trap"><span class="trap__i" aria-hidden="true">⚠</span><div>${inline(v)}</div></div>`;
      const key = k.replace(/:$/, '');
      if (!key) return `<p class="free">${inline(v)}</p>`;
      const cls = /^Expect/.test(key) ? 'expect'
        : key === 'Reference' ? 'ref'
          : key === 'Syntax' ? 'syntax'
            : key === 'Then' ? 'then' : 'recipe';
      return `<div class="row row--${cls}"><span class="row__k">${esc(key)}</span><div class="row__v">${inline(v)}</div></div>`;
    }).join('');

    cur.html.push(
      `<li class="chk" data-id="${id}">`
      + `<input type="checkbox" id="${id}" class="chk__box">`
      + `<div class="chk__main">`
      // `label` still carries its own ** markers, so render it as-is. Wrapping it in a
      // second pair (an earlier version did) left literal asterisks in the output.
      + `<label for="${id}" class="chk__label">${inline(label)}`
      + (where ? ` <span class="chk__where">${inline(where)}</span>` : '')
      + `</label>`
      + (rowsHtml ? `<div class="chk__body">${rowsHtml}</div>` : '')
      + `</div>`
      + `<button class="flag" type="button" title="Flag a finding" aria-label="Flag a finding">⚑</button>`
      + `</li>`,
    );
    continue;
  }

  buf.push(ln);
}
block(cur ? cur.html : intro, buf);

// Wrap consecutive <li class="chk"> runs in a <ul>.
function wrapLists(html) {
  const out = [];
  let run = [];
  for (const h of html) {
    if (h.startsWith('<li class="chk"')) run.push(h);
    else { if (run.length) { out.push(`<ul class="checks">${run.join('')}</ul>`); run = []; } out.push(h); }
  }
  if (run.length) out.push(`<ul class="checks">${run.join('')}</ul>`);
  return out.join('\n');
}

const total = itemId;
const navHtml = sections.filter((s) => s.count).map((s) =>
  `<a href="#s${s.num || s.title.replace(/\W+/g, '')}"><span class="nav__t">${
    esc((s.num ? s.num + '. ' : '') + s.title.replace(/\s*\*\(.*/, ''))
  }</span><span class="nav__n" data-sec="${s.num || s.title.replace(/\W+/g, '')}">0/${s.count}</span></a>`).join('');

const bodyHtml = sections.map((s) => {
  const anchor = s.num || s.title.replace(/\W+/g, '');
  const t = s.title.replace(/\s*\*\((\d+) items?\)\*/, '');
  const n = s.title.match(/\*\((\d+) items?\)\*/);
  return `<section id="s${anchor}" data-sec="${anchor}">`
    + `<h2>${s.num ? `<span class="h2__n">${s.num}</span>` : ''}${inline(t)}`
    + (n ? `<span class="h2__c">${n[1]} items</span>` : '')
    + (s.count ? `<span class="h2__p" data-secp="${anchor}"></span>` : '')
    + `</h2>${wrapLists(s.html)}</section>`;
}).join('\n');

const page = `<title>CrossTab Test Sweep</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --paper:#f6f7f9; --card:#ffffff; --ink:#15181f; --ink-2:#39404d; --muted:#5a6472;
  --line:#dfe3e9; --line-2:#eceff3;
  --accent:#0b5d6b; --accent-soft:#e3f0f1; --accent-ink:#084650;
  --warn:#9a5b06; --warn-soft:#fdf2e2; --done:#2c6a4c; --flagc:#a13a2f; --flag-soft:#fdeeec;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Times New Roman",serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#101318; --card:#171b22; --ink:#e8ebf0; --ink-2:#c3cad5; --muted:#8f99a8;
  --line:#2a303a; --line-2:#20262e;
  --accent:#5bb8c4; --accent-soft:#132a2e; --accent-ink:#8fd4dd;
  --warn:#e0a860; --warn-soft:#2a2113; --done:#6cc096; --flagc:#e58979; --flag-soft:#2d1a17;
}}
:root[data-theme="dark"]{
  --paper:#101318; --card:#171b22; --ink:#e8ebf0; --ink-2:#c3cad5; --muted:#8f99a8;
  --line:#2a303a; --line-2:#20262e;
  --accent:#5bb8c4; --accent-soft:#132a2e; --accent-ink:#8fd4dd;
  --warn:#e0a860; --warn-soft:#2a2113; --done:#6cc096; --flagc:#e58979; --flag-soft:#2d1a17;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.6 var(--sans);
  font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-underline-offset:2px}
code{font:500 .875em/1.4 var(--mono);background:var(--line-2);color:var(--ink-2);
  padding:.12em .36em;border-radius:3px;word-break:break-word}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 80px;display:grid;
  grid-template-columns:232px minmax(0,1fr);gap:0 44px;align-items:start}

/* --- progress header ---------------------------------------------------- */
.top{position:sticky;top:0;z-index:20;grid-column:1/-1;background:var(--paper);
  border-bottom:1px solid var(--line);padding:14px 0 12px;margin-bottom:28px}
.top__in{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
.top h1{font:600 20px/1.2 var(--serif);margin:0;letter-spacing:-.01em}
.top__sub{color:var(--muted);font-size:13px;margin:0}
.meter{flex:1 1 220px;min-width:180px;display:flex;align-items:center;gap:10px}
.meter__bar{flex:1;height:7px;background:var(--line);border-radius:99px;overflow:hidden}
.meter__fill{height:100%;width:0;background:var(--accent);border-radius:99px;transition:width .25s}
.meter__n{font:600 13px var(--mono);color:var(--ink-2);white-space:nowrap}
.acts{display:flex;gap:8px;flex-wrap:wrap}
.btn{font:500 12.5px var(--sans);color:var(--ink-2);background:var(--card);
  border:1px solid var(--line);border-radius:6px;padding:5px 11px;cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-ink)}
.btn:focus-visible,a:focus-visible,input:focus-visible,.flag:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

/* --- side rail ---------------------------------------------------------- */
nav{position:sticky;top:96px;font-size:13px;max-height:calc(100vh - 120px);overflow-y:auto}
nav a{display:flex;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:5px;
  color:var(--ink-2);text-decoration:none;line-height:1.3}
nav a:hover{background:var(--line-2);color:var(--accent)}
.nav__n{font:500 11.5px var(--mono);color:var(--muted);white-space:nowrap}
.nav__n.full{color:var(--done)}
.rail-h{font:600 11px var(--sans);letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);padding:0 8px;margin:0 0 8px}

/* --- sections ----------------------------------------------------------- */
main{min-width:0}
section{margin:0 0 44px;scroll-margin-top:96px}
h2{font:600 23px/1.25 var(--serif);margin:0 0 14px;padding-bottom:9px;
  border-bottom:2px solid var(--line);display:flex;align-items:baseline;gap:10px;
  flex-wrap:wrap;text-wrap:balance;letter-spacing:-.01em}
.h2__n{font:600 13px var(--mono);color:var(--accent);background:var(--accent-soft);
  padding:2px 7px;border-radius:4px;align-self:center}
.h2__c{font:500 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.h2__p{margin-left:auto;font:600 12px var(--mono);color:var(--muted)}
.h2__p.full{color:var(--done)}
h3{font:600 15px/1.35 var(--sans);margin:26px 0 10px;color:var(--ink);
  letter-spacing:.005em}
main p{margin:0 0 12px;max-width:68ch;color:var(--ink-2)}
.note{margin:0 0 16px;padding:12px 15px;background:var(--card);border:1px solid var(--line);
  border-left:3px solid var(--accent);border-radius:0 6px 6px 0;font-size:14.5px;color:var(--ink-2)}
.note p{margin:0 0 6px}.note p:last-child{margin:0}
ul.plain{margin:0 0 14px;padding-left:20px;max-width:68ch;color:var(--ink-2)}
ul.plain li{margin:0 0 6px}

/* --- checks ------------------------------------------------------------- */
ul.checks{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:9px}
.chk{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:0 12px;
  background:var(--card);border:1px solid var(--line);border-radius:7px;padding:12px 13px;
  align-items:start}
.chk__box{appearance:none;width:17px;height:17px;margin:3px 0 0;border:1.5px solid var(--muted);
  border-radius:4px;cursor:pointer;background:transparent;flex:none;position:relative}
.chk__box:checked{background:var(--done);border-color:var(--done)}
.chk__box:checked::after{content:"";position:absolute;left:4.5px;top:1px;width:5px;height:9.5px;
  border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.chk__main{min-width:0}
.chk__label{font-weight:600;color:var(--ink);cursor:pointer;display:block;line-height:1.45}
.chk__where{font:500 12.5px var(--mono);color:var(--accent);font-weight:500}
.chk__where code{background:none;padding:0;color:var(--accent)}
.chk__body{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.row{display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;font-size:14.5px}
.row__k{font:600 10.5px var(--sans);letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);padding-top:4px}
.row--expect .row__k{color:var(--accent)}
.row--then .row__k{color:var(--muted)}
.row--syntax .row__k{color:var(--muted)}
.row--syntax .row__v{font-size:13.5px}
.row--then{padding-top:2px;border-top:1px dashed var(--line);margin-top:2px}
.row--ref .row__k{color:var(--muted)}
.row__v{color:var(--ink-2);min-width:0}
.row--ref .row__v{font-size:13.5px}
.free{font-size:14.5px;margin:0!important;color:var(--ink-2)}
.trap{display:grid;grid-template-columns:auto minmax(0,1fr);gap:9px;background:var(--warn-soft);
  border-radius:5px;padding:9px 11px;font-size:14px;color:var(--ink-2)}
.trap__i{color:var(--warn);font-weight:700;line-height:1.5}
.flag{appearance:none;background:none;border:1px solid transparent;border-radius:5px;
  color:var(--line);font-size:15px;cursor:pointer;padding:2px 6px;line-height:1.4}
.flag:hover{color:var(--flagc);border-color:var(--line)}
.chk.flagged{border-color:var(--flagc);background:var(--flag-soft)}
.chk.flagged .flag{color:var(--flagc)}
.chk.done{opacity:.6}
.chk.done .chk__body{display:none}
body.hide-done .chk.done{display:none}

/* --- tables ------------------------------------------------------------- */
.scroll{overflow-x:auto;margin:0 0 18px;border:1px solid var(--line);border-radius:7px;
  background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:560px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-2);vertical-align:top}
th{font:600 10.5px var(--sans);letter-spacing:.07em;text-transform:uppercase;
  color:var(--muted);background:var(--line-2);white-space:nowrap}
tr:last-child td{border-bottom:none}

@media (max-width:900px){
  .wrap{grid-template-columns:minmax(0,1fr);gap:0}
  nav{position:static;max-height:none;margin-bottom:28px;
    columns:2;column-gap:20px;border:1px solid var(--line);border-radius:7px;padding:12px;
    background:var(--card)}
  .rail-h{column-span:all}
}
@media (max-width:560px){
  .row{grid-template-columns:minmax(0,1fr);gap:1px}
  .row__k{padding-top:0}
  nav{columns:1}
  .chk{padding:11px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
  <header class="top">
    <div class="top__in">
      <div>
        <h1>CrossTab Test Sweep</h1>
        <p class="top__sub">${total} checks &middot; 116 plugin menu items &middot; expected values from desktop R</p>
      </div>
      <div class="meter">
        <div class="meter__bar"><div class="meter__fill" id="fill"></div></div>
        <span class="meter__n" id="count">0 / ${total}</span>
      </div>
      <div class="acts">
        <button class="btn" id="toggleDone" type="button" aria-pressed="false">Hide done</button>
        <button class="btn" id="jump" type="button">Next unchecked</button>
        <button class="btn" id="reset" type="button">Reset</button>
      </div>
    </div>
  </header>

  <nav aria-label="Sections">
    <p class="rail-h">Sections</p>
    ${navHtml}
  </nav>

  <main>
    ${wrapLists(intro)}
    ${bodyHtml}
  </main>
</div>

<script>
(() => {
  const KEY = 'crosstab-test-sweep-v1';
  const boxes = [...document.querySelectorAll('.chk__box')];
  const fill = document.getElementById('fill');
  const count = document.getElementById('count');
  const total = boxes.length;

  let state = { done: {}, flagged: {} };
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}
  state.done = state.done || {}; state.flagged = state.flagged || {};

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };

  function paint() {
    let n = 0;
    for (const b of boxes) {
      const li = b.closest('.chk');
      const on = !!state.done[b.id];
      b.checked = on; li.classList.toggle('done', on);
      li.classList.toggle('flagged', !!state.flagged[b.id]);
      if (on) n++;
    }
    fill.style.width = total ? (n / total * 100) + '%' : '0';
    count.textContent = n + ' / ' + total;
    // Per-section tallies, in the rail and on each heading.
    for (const sec of document.querySelectorAll('section[data-sec]')) {
      const bs = [...sec.querySelectorAll('.chk__box')];
      if (!bs.length) continue;
      const d = bs.filter((x) => state.done[x.id]).length;
      const txt = d + '/' + bs.length;
      const full = d === bs.length;
      const key = sec.dataset.sec;
      const railN = document.querySelector('.nav__n[data-sec="' + key + '"]');
      if (railN) { railN.textContent = txt; railN.classList.toggle('full', full); }
      const hp = document.querySelector('.h2__p[data-secp="' + key + '"]');
      if (hp) { hp.textContent = txt; hp.classList.toggle('full', full); }
    }
  }

  for (const b of boxes) {
    b.addEventListener('change', () => {
      if (b.checked) state.done[b.id] = 1; else delete state.done[b.id];
      save(); paint();
    });
  }
  for (const f of document.querySelectorAll('.flag')) {
    f.addEventListener('click', () => {
      const id = f.closest('.chk').querySelector('.chk__box').id;
      if (state.flagged[id]) delete state.flagged[id]; else state.flagged[id] = 1;
      save(); paint();
    });
  }

  const td = document.getElementById('toggleDone');
  td.addEventListener('click', () => {
    const on = document.body.classList.toggle('hide-done');
    td.setAttribute('aria-pressed', String(on));
    td.textContent = on ? 'Show done' : 'Hide done';
  });

  document.getElementById('jump').addEventListener('click', () => {
    const next = boxes.find((b) => !state.done[b.id]);
    if (next) {
      next.closest('.chk').scrollIntoView({ behavior: 'smooth', block: 'center' });
      next.focus({ preventScroll: true });
    }
  });

  document.getElementById('reset').addEventListener('click', () => {
    if (!confirm('Clear every tick and flag on this device?')) return;
    state = { done: {}, flagged: {} }; save(); paint();
  });

  paint();
})();
</script>
`;

writeFileSync(OUT, page);
console.log(`sections: ${sections.length}   checks: ${total}`);
console.log(`bytes: ${page.length}`);
const unlabelled = sections.filter((s) => !s.count).map((s) => s.title);
console.log('sections with no checks:', unlabelled.join(' | ') || '(none)');
