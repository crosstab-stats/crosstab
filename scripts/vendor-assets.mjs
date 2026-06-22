/**
 * @file scripts/vendor-assets.mjs
 * Download CrossTab's heavy runtime assets into `./vendor/` so the app can run on
 * an **air-gapped** machine (no internet). Run this ONCE on a connected machine,
 * then copy the whole app directory (including `vendor/`) to the offline machine
 * and serve it locally with `?assets=local` (or set CROSSTAB_ASSETS_MODE — see
 * docs/OFFLINE.md). The asset URLs/layout here mirror core/assets.js (LOCAL).
 *
 *   node scripts/vendor-assets.mjs            # everything
 *   node scripts/vendor-assets.mjs webr duckdb arrow hyparquet packages
 *
 * No npm dependencies — uses global fetch (Node 18+) and the system `tar` (present
 * on Windows 10+, macOS, Linux) to unpack npm tarballs.
 *
 * Confidence notes:
 *  - webr / duckdb: each npm package ships a self-contained browser `dist/` that
 *    its docs explicitly support self-hosting; we extract that verbatim.
 *  - arrow / hyparquet: fetched as a single self-contained ESM bundle from esm.sh
 *    (`?bundle` inlines all deps), so there are no cross-origin sub-imports.
 *  - packages: mirrors the WebR binary repo for the dependency closure of the
 *    packages the bundled plugins declare. Re-run after adding plugins/packages.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');

// Keep these in sync with core/assets.js (CDN) and core/webr-manager.js.
const DUCKDB_VERSION = '1.33.1-dev56.0';
const ARROW_VERSION = '17.0.0';
const HYPARQUET_VERSION = '0.16.1';
// The R minor that the vendored WebR ships (its repo path is
// bin/emscripten/contrib/<this>/). WebR 0.5.x → R 4.6. Adjust if you pin a
// different WebR.
const R_VERSION_DIR = '4.6';
const WEBR_REPO = 'https://repo.r-wasm.org';

const log = (...a) => console.log('[vendor]', ...a);
const die = (m) => { console.error('[vendor] ERROR:', m); process.exitCode = 1; };

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Untar a .tgz into destDir using the system tar. */
function untar(tgzPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tgzPath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar failed (status ${r.status}) on ${tgzPath}`);
}

/** Download an npm package tarball and return the extracted `package/` dir. */
async function fetchNpmPackage(name, version, work) {
  const meta = JSON.parse(await fetchText(`https://registry.npmjs.org/${name}`));
  const ver = version === 'latest' ? meta['dist-tags'].latest : version;
  const v = meta.versions[ver];
  if (!v) throw new Error(`${name}@${ver} not found in registry`);
  log(`${name}@${ver} → ${v.dist.tarball}`);
  const tgz = join(work, `${name.replace(/[@/]/g, '_')}-${ver}.tgz`);
  writeFileSync(tgz, await fetchBuffer(v.dist.tarball));
  untar(tgz, work);
  return { dir: join(work, 'package'), version: ver };
}

async function vendorWebR(work) {
  log('WebR runtime…');
  const { dir, version } = await fetchNpmPackage('webr', 'latest', join(work, 'webr'));
  const dist = join(dir, 'dist');
  if (!existsSync(dist)) throw new Error('webr package has no dist/ — unexpected layout');
  const out = join(VENDOR, 'webr', 'dist');
  rmSync(join(VENDOR, 'webr'), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(dist, out, { recursive: true });
  writeFileSync(join(VENDOR, 'webr', 'VERSION'), `webr@${version}\n`);
  log(`  → vendor/webr/dist/ (webr@${version})`);
}

async function vendorDuckDB(work) {
  log('DuckDB-WASM…');
  const { dir } = await fetchNpmPackage('@duckdb/duckdb-wasm', DUCKDB_VERSION, join(work, 'duckdb'));
  const dist = join(dir, 'dist');
  if (!existsSync(dist)) throw new Error('duckdb-wasm package has no dist/');
  const out = join(VENDOR, 'duckdb', 'dist');
  rmSync(join(VENDOR, 'duckdb'), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Copy only the browser bundle + worker/wasm pairs assets.js references (keeps
  // vendor/ lean — the full dist also carries node + eh-mvp coi variants).
  const want = [
    'duckdb-browser.mjs',
    'duckdb-mvp.wasm', 'duckdb-browser-mvp.worker.js',
    'duckdb-eh.wasm', 'duckdb-browser-eh.worker.js',
  ];
  for (const f of want) {
    const src = join(dist, f);
    if (existsSync(src)) cpSync(src, join(out, f));
    else log(`  ! missing ${f} in dist (kept going)`);
  }
  log(`  → vendor/duckdb/dist/ (@duckdb/duckdb-wasm@${DUCKDB_VERSION})`);
}

async function vendorEsmBundle(pkg, version, outRel) {
  log(`${pkg}@${version} (esm.sh bundle)…`);
  const code = await fetchText(`https://esm.sh/${pkg}@${version}?bundle&target=es2022`);
  const out = join(VENDOR, outRel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  log(`  → vendor/${outRel}`);
}

/** Parse a CRAN-style PACKAGES file into { name: { Version, deps:Set } }. */
function parsePackages(text) {
  const out = {};
  for (const block of text.split(/\n\s*\n/)) {
    const fields = {};
    let key = null;
    for (const line of block.split('\n')) {
      const m = line.match(/^(\S[^:]*):\s?(.*)$/);
      if (m) { key = m[1]; fields[key] = m[2]; }
      else if (key && /^\s/.test(line)) fields[key] += ' ' + line.trim();
    }
    if (!fields.Package) continue;
    const deps = new Set();
    for (const f of ['Depends', 'Imports', 'LinkingTo']) {
      if (!fields[f]) continue;
      for (const d of fields[f].split(',')) {
        const name = d.trim().replace(/\s*\(.*\)\s*$/, '');
        if (name && name !== 'R') deps.add(name);
      }
    }
    out[fields.Package] = { Version: fields.Version, deps, block: block.trim() };
  }
  return out;
}

/** The R packages the bundled plugins declare (+ the host's implicit deps). */
function declaredPackages() {
  const wanted = new Set(['nanoparquet', 'svglite']); // host injection bridge + plots
  const plugins = join(ROOT, 'plugins');
  for (const d of readdirSync(plugins, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const idx = join(plugins, d.name, 'index.js');
    if (!existsSync(idx)) continue;
    const src = readFileSync(idx, 'utf8');
    const m = src.match(/rPackages\s*:\s*\[([^\]]*)\]/);
    if (!m) continue;
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) wanted.add(q[1]);
  }
  return wanted;
}

async function vendorPackages() {
  log('R package mirror…');
  const base = `${WEBR_REPO}/bin/emscripten/contrib/${R_VERSION_DIR}`;
  const index = parsePackages(await fetchText(`${base}/PACKAGES`));
  const wanted = declaredPackages();
  log(`  declared: ${[...wanted].sort().join(', ')}`);

  // Dependency closure over what the repo actually offers (base R packages like
  // 'stats'/'methods' aren't in the repo and are skipped — they ship with WebR).
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name) || !index[name]) return;
    closure.add(name);
    for (const dep of index[name].deps) visit(dep);
  };
  for (const w of wanted) {
    if (!index[w]) { log(`  ! ${w} not in repo PACKAGES (base pkg or renamed?) — skipped`); continue; }
    visit(w);
  }
  log(`  closure: ${closure.size} packages`);

  const outDir = join(VENDOR, 'webr-packages', 'bin', 'emscripten', 'contrib', R_VERSION_DIR);
  rmSync(join(VENDOR, 'webr-packages'), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let ok = 0;
  const blocks = [];
  for (const name of [...closure].sort()) {
    const { Version, block } = index[name];
    const file = `${name}_${Version}.tgz`;
    try {
      writeFileSync(join(outDir, file), await fetchBuffer(`${base}/${file}`));
      blocks.push(block);
      ok++;
    } catch (e) {
      log(`  ! ${file}: ${e.message}`);
    }
  }
  // A PACKAGES index containing just the mirrored subset, so WebR resolves installs
  // against the local repo. (No gzip needed — WebR reads plain PACKAGES.)
  writeFileSync(join(outDir, 'PACKAGES'), blocks.join('\n\n') + '\n');
  log(`  → vendor/webr-packages/ (${ok}/${closure.size} packages + PACKAGES index)`);
  log('  NOTE: re-run this after adding plugins or R packages.');
}

const STEPS = {
  webr: (w) => vendorWebR(w),
  duckdb: (w) => vendorDuckDB(w),
  arrow: () => vendorEsmBundle('apache-arrow', ARROW_VERSION, 'arrow/arrow.mjs'),
  hyparquet: () => vendorEsmBundle('hyparquet-writer', HYPARQUET_VERSION, 'hyparquet-writer/hyparquet-writer.mjs'),
  packages: () => vendorPackages(),
};

async function main() {
  const sel = process.argv.slice(2);
  const steps = sel.length ? sel : Object.keys(STEPS);
  const bad = steps.filter((s) => !STEPS[s]);
  if (bad.length) return die(`unknown step(s): ${bad.join(', ')}. Valid: ${Object.keys(STEPS).join(', ')}`);

  const work = join(tmpdir(), `crosstab-vendor-${process.pid}`);
  mkdirSync(work, { recursive: true });
  mkdirSync(VENDOR, { recursive: true });
  log(`vendoring [${steps.join(', ')}] → ${VENDOR}`);
  try {
    for (const s of steps) {
      try { await STEPS[s](work); }
      catch (e) { die(`${s}: ${e.message}`); }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log('done. Serve with ?assets=local (or set CROSSTAB_ASSETS_MODE). See docs/OFFLINE.md.');
}

main();
