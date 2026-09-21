/**
 * @file scripts/validation/logistic-emit-r.mjs
 * Harness (not a unit test): print the exact R source `builtin-logistic` emits for a
 * given option set, so it can be run against a real R install and compared with the
 * official packages. Usage:
 *
 *   node scripts/validation/logistic-emit-r.mjs class,ci,hl,plot,casewise first > /tmp/emitted.R
 *
 * The plugin builds its R by string interpolation, so this runs the REAL builder —
 * what R sees here is what WebR sees in the app.
 */

import { run } from '../../plugins/builtin-logistic/index.js';

const opts = (process.argv[2] || 'class').split(',').filter(Boolean);
const ref = process.argv[3] || 'first';
const cats = (process.argv[4] || '').split(',').filter(Boolean);

let captured = null;
const noop = async () => {};
const app = {
  data: {
    getVariableMeta: async () => [
      { name: 'SCHOOL_ATTEND', type: 'factor', label: 'Attends school' },
      { name: 'LANGUAGE', type: 'numeric', label: 'Language at home' },
      { name: 'AGE', type: 'numeric', label: 'Age' },
    ],
  },
  webr: {
    run: async (code) => {
      captured = code;
      return { result: null };
    },
  },
  results: { appendTable: noop, appendText: noop, appendChart: noop, appendError: noop },
};

try {
  await run(app, { dv: 'SCHOOL_ATTEND', ivs: ['LANGUAGE', 'AGE'], cats, ref, opts });
} catch {
  /* expected: the stub returns no result, which is as far as we need to get */
}
process.stdout.write(captured ?? '');
