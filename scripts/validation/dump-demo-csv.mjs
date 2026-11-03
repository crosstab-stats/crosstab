/**
 * @file scripts/validation/dump-demo-csv.mjs
 * Write the two demo datasets out as CSV, so desktop R (and SPSS) can be handed exactly
 * the same cases the app works on.
 *
 * Both demo builders are deterministic — no RNG, no clock — which is what makes it
 * possible for `docs/TESTING.md` to quote exact expected values rather than telling the
 * reader to go and compare. This script also asserts that determinism rather than
 * assuming it: if a future edit introduces randomness, the quoted numbers in the test
 * checklist silently stop being true, and that is worth failing loudly over.
 *
 *   node scripts/validation/dump-demo-csv.mjs [outDir]
 *
 * Then, from that directory:
 *   Rscript scripts/validation/demo-reference.R
 *   Rscript scripts/validation/demo-reference-spatial.R
 *
 * Note the two user-missing codes on `income` (-99, -98). They are left AS-IS in the
 * CSV, because recoding them is the reference script's job and doing it here would hide
 * the one piece of metadata most worth testing. Importing the `.sav` export instead of
 * this CSV carries the codes properly into SPSS.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// fileURLToPath, not url.pathname: the repo path contains a space, and a raw pathname
// hands back the percent-encoded form, which then gets encoded a second time.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const outDir = path.resolve(process.argv[2] || process.cwd());
mkdirSync(outDir, { recursive: true });

const demo = await import(pathToFileURL(path.join(repo, 'core/demo-data.js')).href);

/** Columnar dataset → CSV text, with a determinism check against a second build. */
function toCsv(make, label) {
  const a = make();
  const b = make();
  const names = a.variables.map((v) => v.name);
  const n = a.columns[names[0]].length;
  const stable = names.every((k) => a.columns[k].every((v, i) => v === b.columns[k][i]));
  if (!stable) {
    throw new Error(
      `${label} is no longer deterministic. Every expected value quoted in `
      + 'docs/TESTING.md was computed from these exact cases, so they must be '
      + 'recomputed (and the checklist updated) before that document can be trusted.',
    );
  }
  const rows = [names.join(',')];
  for (let i = 0; i < n; i++) {
    rows.push(names.map((k) => {
      const v = a.columns[k][i];
      // Quote anything that could be read as a delimiter; the demos have none today,
      // but a string column is one edit away from containing a comma.
      return (typeof v === 'string' && /[",\n]/.test(v)) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
  return { csv: rows.join('\n') + '\n', n, names };
}

for (const [file, make, label] of [
  ['demo.csv', demo.makeDemoDataset, 'demo (quant)'],
  ['spatial.csv', demo.makeSpatialDemoDataset, 'spatial demo'],
]) {
  const { csv, n, names } = toCsv(make, label);
  writeFileSync(path.join(outDir, file), csv);
  console.log(`${file}: ${n} cases, ${names.length} variables (${names.join(', ')})`);
}
console.log(`written to ${outDir}`);
