/**
 * One-shot helper: insert a `disciplines: [...]` line into each specialized
 * built-in plugin manifest (after its `keywords:` line) for the launcher's
 * field-based pinning. Idempotent — skips a plugin that already declares one.
 * The universal core (frequencies/descriptives/correlation/regression/plots) and
 * infra importers/exporters are intentionally left untagged. Vocabulary follows
 * the CSUS College of Social Sciences departments (+ kept extras); see
 * launcher-startup-screen memory.
 *
 *   node scripts/tag-disciplines.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TAGS = {
  'builtin-logistic': ['Political Science', 'Sociology', 'Psychology', 'Public Health', 'Economics', 'Criminology', 'Social Science'],
  'builtin-nonparametric': ['Psychology', 'Public Health', 'Nutrition, Food & Dietetics', 'Gerontology', 'Sociology'],
  'builtin-compare': ['Psychology', 'Public Health', 'Nutrition, Food & Dietetics', 'Education', 'Gerontology'],
  'builtin-factor': ['Psychology', 'Sociology', 'Political Science', 'Communication', "Women's & Gender Studies", 'Education', 'Liberal Studies'],
  'builtin-assumptions': ['Economics', 'Political Science', 'Psychology', 'Social Science'],
  'builtin-anova': ['Psychology', 'Nutrition, Food & Dietetics', 'Education', 'Family & Consumer Sciences', 'Gerontology', 'Public Health'],
  'builtin-timeseries': ['Economics', 'Public Policy & Administration', 'Environmental Studies'],
  'builtin-manova': ['Psychology', 'Education'],
  'builtin-bayesian': ['Psychology', 'Political Science', 'Public Health', 'Social Science'],
  'builtin-bootstrap': ['Psychology', 'Social Science', 'Public Health'],
  'builtin-reliability': ['Psychology', 'Education', 'Communication', 'Sociology', "Women's & Gender Studies", 'Liberal Studies'],
  'builtin-margins': ['Economics', 'Political Science', 'Public Policy & Administration'],
  'builtin-categorical': ['Sociology', 'Political Science', 'Public Health', 'Criminology', 'Social Science'],
  'builtin-meta': ['Public Health', 'Psychology', 'Nutrition, Food & Dietetics', 'Education'],
  'builtin-mixedanova': ['Psychology', 'Education', 'Gerontology'],
  'builtin-var': ['Economics', 'Public Policy & Administration'],
  'builtin-cointegration': ['Economics', 'Business'],
  'builtin-limdep': ['Economics', 'Public Policy & Administration'],
  'builtin-clusterse': ['Economics', 'Political Science', 'Public Policy & Administration'],
  'builtin-imputation': ['Public Health', 'Sociology', 'Psychology', 'Gerontology'],
  'builtin-inequality': ['Economics', 'Sociology', 'Ethnic Studies', 'Public Policy & Administration', 'Social Science'],
  'builtin-doe': ['Nutrition, Food & Dietetics', 'Family & Consumer Sciences', 'Business', 'Environmental Studies'],
  'builtin-sna': ['Sociology', 'Anthropology', 'Communication', 'Political Science'],
  'builtin-ordination': ['Business', 'Communication', 'Anthropology', 'Ecology', 'Environmental Studies', 'Asian Studies'],
};

const fmt = (arr) => arr.map((d) => (d.includes("'") ? `"${d}"` : `'${d}'`)).join(', ');

let changed = 0;
let skipped = 0;
for (const [dir, disciplines] of Object.entries(TAGS)) {
  const path = `plugins/${dir}/index.js`;
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    console.warn(`! missing ${path}`);
    continue;
  }
  if (/^\s*disciplines\s*:/m.test(src)) {
    skipped++;
    continue;
  }
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^\s*keywords\s*:/.test(l));
  if (i < 0) {
    console.warn(`! no keywords line in ${path}`);
    continue;
  }
  const indent = lines[i].match(/^(\s*)/)[1];
  lines.splice(i + 1, 0, `${indent}disciplines: [${fmt(disciplines)}],`);
  writeFileSync(path, lines.join('\n'));
  changed++;
  console.log(`+ ${dir}: ${disciplines.length} disciplines`);
}
console.log(`\nDone — ${changed} tagged, ${skipped} already had disciplines.`);
