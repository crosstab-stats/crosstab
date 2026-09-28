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
 * one key and collide. Rather than ship a nested layout that is subtly wrong, a non-flat
 * specifier is refused by name, with the reason. Nested support needs per-module rewriting,
 * which is a separate piece of work.
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
    for (const spec of scanRelativeImports(source)) {
      const name = flatName(spec);
      if (!name) {
        issues.push({
          specifier: spec,
          why: `${fromLabel} imports “${spec}”. A plugin's modules must sit beside its entry `
            + '(“./name.js”) — subdirectories and “../” are not supported yet.',
        });
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push({ name, fromLabel });
    }
  };

  enqueue(entrySource, 'The plugin');
  while (queue.length) {
    if (Object.keys(modules).length >= MAX_MODULES) {
      issues.push({ specifier: '', why: `A plugin may import at most ${MAX_MODULES} of its own modules.` });
      break;
    }
    const { name, fromLabel } = queue.shift();
    let source = null;
    try {
      source = await readModule(name);
    } catch (err) {
      source = null;
      issues.push({ specifier: `./${name}`, why: `${fromLabel} imports “./${name}”, which could not be read: ${err.message}` });
      continue;
    }
    if (source == null) {
      issues.push({ specifier: `./${name}`, why: `${fromLabel} imports “./${name}”, which this plugin does not include.` });
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
