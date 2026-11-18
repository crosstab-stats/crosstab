/**
 * @file plugin-modules.js
 * **Letting a plugin's code span several files** — the host half.
 *
 * A plugin's entry module arrives in the sandbox as source text and is imported from a blob:
 * URL, which is the only way to get an ES module into an opaque-origin frame. That works for
 * one file and fails for two: `import './util.js'` has nothing to resolve against, because
 * `blob:` URLs have an opaque path. The frame fixes that with an import map (see
 * plugin-host.html); this module works out *what to send it*.
 *
 * ## Why the module list is discovered, not declared
 *
 * The obvious design — a `modules: [...]` manifest field — cannot work, and the reason is
 * worth stating so nobody re-proposes it: the manifest lives *inside* the entry module, so
 * reading it means importing the module, and importing the module is the thing that fails
 * without its siblings. The list has to be known BEFORE the first import.
 *
 * So the host scans the source text for relative import specifiers, fetches those, scans
 * those, and repeats. Authors declare nothing; they just write `import { x } from './util.js'`.
 *
 * ## v1 is deliberately flat
 *
 * Modules must sit **beside the entry** — `./util.js`, not `./lib/util.js` or `../shared.js`.
 * That is not laziness, it is the consequence of how the frame's import map matches. A `blob:`
 * base makes a relative specifier unresolvable as a URL, so the map matches it as a LITERAL
 * STRING; two modules in different directories both written `./deep.js` would therefore be
 * one key and collide — one silently shadowing the other, which is the kind of wrong nobody
 * notices until it bites. So a non-flat specifier is refused by name, with the reason and the
 * workaround.
 *
 * **This is the end state, not a staging post** (owner's call, 2026-09-29). Supporting nested
 * paths would mean per-module resolution contexts — rewriting each module's own imports to
 * generated keys before building its blob, which is parsing and rewriting SOURCE rather than
 * scanning it. That is a permanent cost to save an author from writing `lib-util.js` instead of
 * `lib/util.js`. Plugins get creative with their naming instead.
 *
 * Pure module: the fetching is injected, so every rule here is testable without a network or
 * a browser.
 */

/** How many modules one plugin may pull in. A cap, not a target — it exists so a cycle or a
 * runaway generated file cannot turn one activation into a thousand fetches. */
export const MAX_MODULES = 50;

/**
 * Every relative specifier a source file imports, in source order, deduplicated.
 *
 * Covers the static forms (`import … from '…'`, side-effect `import '…'`, `export … from '…'`)
 * and the dynamic `import('…')` with a literal argument. A computed dynamic import cannot be
 * resolved ahead of time by anyone, so it is simply not found — and will fail loudly at run
 * time rather than silently doing the wrong thing.
 *
 * Bare and absolute specifiers are ignored: this is only about a plugin's own files.
 *
 * @param {string} source
 * @returns {string[]} specifiers exactly as written, e.g. `['./util.js']`
 */
export function scanRelativeImports(source) {
  const text = String(source ?? '');
  const found = [];
  const add = (spec) => {
    if (spec && (spec.startsWith('./') || spec.startsWith('../')) && !found.includes(spec)) found.push(spec);
  };
  // Three separate patterns rather than one alternation, because they overlap: run as one
  // regex, a side-effect `import './a.js'` gets swallowed as the clause of a following
  // `export … from './b.js'` and disappears. (It did, until this comment existed.) The clause
  // matcher also excludes quotes and semicolons so it can never cross a statement boundary.
  const fromRe = /(?:^|[\s;}])(?:import|export)\b[^'";]*?from\s*['"]([^'"]+)['"]/g;
  const bareRe = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynamicRe]) {
    let m;
    while ((m = re.exec(text))) add(m[1]);
  }
  return found;
}

/**
 * The same source with its comments blanked out.
 *
 * ## Why this exists
 *
 * Every built-in plugin carries this line:
 *
 *     /** @type {import('../../core/loader.js').PluginManifest} *\/
 *
 * which is a JSDoc TYPE import — and it matches the dynamic-`import()` pattern above
 * exactly. So every one of the 64 plugins reported:
 *
 *     [plugin ./plugins/builtin-clusterse/index.js] The plugin imports
 *     “../../core/loader.js”. A plugin's modules must sit beside its entry …
 *
 * 64 warnings per session, none of them real. Harmless on its own, except that it is
 * what buried the actual diagnostics while chasing an import failure — the owner went
 * looking for the cause of a 3.1 GiB OOM and found a screen of these instead.
 *
 * ## What it is deliberately not
 *
 * This is NOT a parser, and a regex literal containing a slash-slash — `/https:\/\//` —
 * lexes here as the start of a line comment, so the rest of that line is lost.
 *
 * That is survivable only because of HOW the result is used: it gates the warnings and
 * nothing else. Module collection still walks the raw source, so the worst a mis-lex can
 * do is withhold a complaint. Were it the other way round, the same bug would silently
 * drop a module a plugin actually needs, and the plugin would fail with its import
 * naming a file that is right there in its directory.
 *
 * @param {string} source
 * @returns {string} the source with comment bodies removed, newlines preserved
 */
export function stripComments(source) {
  const s = String(source ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // A string or template literal is copied verbatim: a URL in one is not a comment,
    // and `'/*'` must not open a block that swallows the rest of the file.
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s.slice(i, i + 2); i += 2; continue; }
        const c = s[i];
        out += c;
        i += 1;
        if (c === ch) break;
      }
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue; // the newline itself is copied by the next pass
    }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        // Newlines survive so that anything reporting a line number still can.
        if (s[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The flat filename a specifier names, or null if this version cannot support it.
 *
 * @param {string} specifier
 * @returns {string|null} e.g. `./util.js` → `util.js`
 */
export function flatName(specifier) {
  const s = String(specifier ?? '').trim();
  if (!s.startsWith('./')) return null; // `../` climbs out of the plugin
  const name = s.slice(2);
  if (!name || name.includes('/') || name.includes('\\')) return null; // a subdirectory
  if (name.includes('?') || name.includes('#')) return null; // a query/fragment is not a file
  return name;
}

/**
 * Walk a plugin's imports and collect every sibling module's source.
 *
 * @param {string} entrySource
 * @param {(name: string) => Promise<string|null>} readModule  resolves a sibling by filename,
 *   or null when there is no such file (a fetch 404, a package without it)
 * @returns {Promise<{modules: Record<string, string>, issues: Array<{specifier: string, why: string}>}>}
 */
export async function collectModuleClosure(entrySource, readModule) {
  const modules = {};
  const issues = [];
  const queue = [];
  const seen = new Set();

  const enqueue = (source, fromLabel) => {
    // Which specifiers are in real CODE rather than in a comment. This decides whether a
    // specifier is worth COMPLAINING about and nothing else — the walk below still reads
    // the raw source, so a `stripComments` mis-lex can only ever cost a warning. See
    // {@link stripComments} for why that asymmetry is the whole point.
    const inCode = new Set(scanRelativeImports(stripComments(source)));
    for (const spec of scanRelativeImports(source)) {
      const name = flatName(spec);
      if (!name) {
        if (inCode.has(spec)) {
          issues.push({
            specifier: spec,
            why: `${fromLabel} imports “${spec}”. A plugin's modules must sit beside its entry `
              + '(“./name.js”) — subdirectories and “../” are not supported, by design. Name the '
              + 'file flat instead (“lib-util.js” rather than “lib/util.js”).',
          });
        }
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push({ name, fromLabel, inCode: inCode.has(spec) });
    }
  };

  enqueue(entrySource, 'The plugin');
  while (queue.length) {
    if (Object.keys(modules).length >= MAX_MODULES) {
      issues.push({ specifier: '', why: `A plugin may import at most ${MAX_MODULES} of its own modules.` });
      break;
    }
    const { name, fromLabel, inCode } = queue.shift();
    let source = null;
    try {
      source = await readModule(name);
    } catch (err) {
      source = null;
      if (inCode) issues.push({ specifier: `./${name}`, why: `${fromLabel} imports “./${name}”, which could not be read: ${err.message}` });
      continue;
    }
    if (source == null) {
      // A commented-out `import './old.js'` is still looked for — the walk reads raw
      // source on purpose — but a stale comment is not worth a complaint about a missing
      // file. A real import of a missing file still fails, loudly, at import time.
      if (inCode) issues.push({ specifier: `./${name}`, why: `${fromLabel} imports “./${name}”, which this plugin does not include.` });
      continue;
    }
    modules[name] = source;
    // A module's own imports count too — and a cycle is fine, because `seen` stops the walk
    // while the import map still lets the modules reference each other.
    enqueue(source, `“${name}”`);
  }
  return { modules, issues };
}

/**
 * The specifier spellings an import map must carry for one module file.
 *
 * Several, because the match is on literal text: a `blob:` base makes `./util.js` unresolvable
 * as a URL, so the map key is compared as the raw string the author typed. `./util.js` and
 * `util.js` are the same file to a person and different keys to the resolver.
 *
 * @param {string} name a flat filename, e.g. `util.js`
 * @returns {string[]}
 */
export function moduleKeyAliases(name) {
  const n = String(name ?? '').trim();
  if (!n) return [];
  const aliases = [`./${n}`, n];
  // Extension-less spelling, which is how a lot of people write imports even though the
  // browser requires the extension. Harmless to accept; confusing to reject.
  const stem = n.replace(/\.m?js$/, '');
  if (stem && stem !== n) aliases.push(`./${stem}`, stem);
  return aliases;
}
