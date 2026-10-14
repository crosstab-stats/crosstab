/**
 * @file howto-index.test.mjs
 * The how-to index, the sidecar contract, and the reader's position (#192 H1).
 *
 * The design constraint these protect is the owner's: *"if our Help ▸ How-to list only
 * covered builtin plugins that's a form of privilege. And one North Star of this project
 * is all are equal."* So nothing here may treat a plugin's origin as meaningful —
 * attribution is carried, ordering never consults it.
 *
 * The index lives in the manifest (cached in localStorage, read on every boot) and the
 * prose lives in a sidecar that ships with the plugin. Both halves of the delimiter
 * contract are checked, because an author mistake in either direction presents to a
 * reader as missing documentation rather than as an error.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTopic, collectTopics, indexProblems, parseSidecar, filterTopics, groupTopics, HowtoHistory,
} from '../core/howto.js';

const topic = (id, title, extra = {}) => ({ id, title, ...extra });
const plugin = (id, name, topics, howtoFile = 'howto.md') => ({ id, name, howtoFile, howtoIndex: topics });

// --- declarations ----------------------------------------------------------------

test('a topic needs an id and a title; everything else degrades', () => {
  assert.equal(normalizeTopic({ title: 'No id' }), null);
  assert.equal(normalizeTopic({ id: 'x' }), null);
  assert.equal(normalizeTopic({ id: 'has spaces', title: 'Bad id' }), null);
  const t = normalizeTopic(topic('recode', 'Recode a variable'), { pluginId: 'p', pluginName: 'P' });
  assert.equal(t.category, 'Other', 'an undeclared category is not an error');
  assert.deepEqual(t.keywords, []);
  assert.deepEqual(t.needs, []);
});

test('a topic inherits its plugin’s sidecar, and may override it', () => {
  // One file per plugin is the default — a packaged plugin fetches nothing at all, and
  // for a URL plugin one round trip beats one per topic — but a plugin with dozens of
  // topics may want to split, and supporting both costs nothing.
  const owner = { pluginId: 'p', pluginName: 'P', howtoFile: 'howto.md' };
  assert.equal(normalizeTopic(topic('a', 'A'), owner).file, 'howto.md');
  assert.equal(normalizeTopic(topic('b', 'B', { file: 'howto/b.md' }), owner).file, 'howto/b.md');
});

test('every topic carries its attribution', () => {
  const t = normalizeTopic(topic('a', 'A'), { pluginId: 'builtin-survival', pluginName: 'Survival Analysis' });
  assert.equal(t.pluginName, 'Survival Analysis');
  assert.equal(t.pluginId, 'builtin-survival');
});

// --- the index -------------------------------------------------------------------

test('topics sort by category then title — NEVER by origin', () => {
  // The privilege test. A third-party plugin whose topic sorts first must sort first.
  const cat = [
    plugin('builtin-a', 'Built-in A', [topic('b1', 'Zebra striping', { category: 'Graphs' })]),
    plugin('third-party', 'Someone Else', [topic('t1', 'Alpha blending', { category: 'Graphs' })]),
  ];
  assert.deepEqual(collectTopics(cat).map((t) => t.id), ['t1', 'b1']);
});

test('a plugin with no topics contributes nothing and breaks nothing', () => {
  const cat = [plugin('a', 'A', []), { id: 'b', name: 'B' }, null];
  assert.deepEqual(collectTopics(cat), []);
});

test('a duplicate topic id is dropped, not silently shadowed', () => {
  // Ids are addressed globally by `howto:` links, so two plugins cannot both own one.
  const cat = [
    plugin('first', 'First', [topic('recode', 'Recode (mine)')]),
    plugin('second', 'Second', [topic('recode', 'Recode (also mine)')]),
  ];
  assert.deepEqual(collectTopics(cat).map((t) => t.title), ['Recode (mine)']);
  const problems = indexProblems(cat);
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /already used by first/);
  assert.equal(problems[0].pluginId, 'second');
});

test('a malformed topic is reported against its plugin', () => {
  const problems = indexProblems([plugin('p', 'P', [{ title: 'no id' }])]);
  assert.deepEqual(problems, [{ pluginId: 'p', problem: 'a topic needs an id and a title' }]);
});

test('a clean catalogue reports no problems', () => {
  assert.deepEqual(indexProblems([plugin('p', 'P', [topic('a', 'A'), topic('b', 'B')])]), []);
});

// --- the sidecar contract --------------------------------------------------------

const SIDECAR = `# notes to myself, ignored

--- id: recode
Pick **Transform ▸ Recode**.

Then choose a source variable.

--- id: weights
Use *Weight cases* first.
`;

test('a sidecar splits on the delimiter, dropping anything before the first one', () => {
  const { bodies, problems } = parseSidecar(SIDECAR, ['recode', 'weights']);
  assert.deepEqual([...bodies.keys()], ['recode', 'weights']);
  assert.match(bodies.get('recode'), /^Pick \*\*Transform/);
  assert.match(bodies.get('recode'), /choose a source variable\.$/);
  assert.deepEqual(problems, []);
});

test('a body the index never declared is UNREACHABLE, and says so', () => {
  const { bodies, problems } = parseSidecar(SIDECAR, ['recode']);
  assert.deepEqual([...bodies.keys()], ['recode']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"weights" is not declared/);
});

test('a declared topic with no body is a DEAD ROW, and says so', () => {
  const { problems } = parseSidecar(SIDECAR, ['recode', 'weights', 'ghost']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"ghost" is in the index but has no section/);
});

test('one bad section does not cost the reader the rest of the file', () => {
  const text = '--- id: stray\nnope\n--- id: good\nyes\n';
  const { bodies } = parseSidecar(text, ['good']);
  assert.equal(bodies.get('good'), 'yes');
});

test('a repeated section keeps the first and reports the rest', () => {
  const { bodies, problems } = parseSidecar('--- id: a\nfirst\n--- id: a\nsecond\n', ['a']);
  assert.equal(bodies.get('a'), 'first');
  assert.match(problems[0], /appears more than once/);
});

test('an empty or missing sidecar reports every declared topic rather than throwing', () => {
  assert.deepEqual(parseSidecar('', ['a', 'b']).problems.length, 2);
  assert.deepEqual(parseSidecar(null, []).problems, []);
});

test('the delimiter tolerates extra dashes and spacing', () => {
  const { bodies } = parseSidecar('----- id:   spaced  \nbody\n', ['spaced']);
  assert.equal(bodies.get('spaced'), 'body');
});

// --- search ----------------------------------------------------------------------

test('search covers titles, categories, keywords and the plugin name — not bodies', () => {
  const topics = collectTopics([
    plugin('p', 'Survival Analysis', [
      topic('km', 'Kaplan-Meier curves', { category: 'Comparison', keywords: ['survival', 'censoring'] }),
      topic('cox', 'Cox regression', { category: 'Regression' }),
    ]),
  ]);
  assert.deepEqual(filterTopics(topics, 'kaplan').map((t) => t.id), ['km']);
  assert.deepEqual(filterTopics(topics, 'censoring').map((t) => t.id), ['km'], 'keywords are the point');
  assert.deepEqual(filterTopics(topics, 'survival analysis').map((t) => t.id).sort(), ['cox', 'km'], 'by plugin');
  assert.deepEqual(filterTopics(topics, 'regression').map((t) => t.id), ['cox'], 'by category');
});

test('search requires every term, so adding words narrows', () => {
  const topics = collectTopics([plugin('p', 'P', [
    topic('a', 'Run a crosstab', { keywords: ['weights'] }),
    topic('b', 'Run a crosstab with no weighting at all', {}),
  ])]);
  assert.deepEqual(filterTopics(topics, 'crosstab').length, 2);
  assert.deepEqual(filterTopics(topics, 'crosstab weights').map((t) => t.id), ['a']);
});

test('an empty query returns everything, unfiltered', () => {
  const topics = collectTopics([plugin('p', 'P', [topic('a', 'A')])]);
  assert.equal(filterTopics(topics, '   ').length, 1);
});

test('grouping keeps the sorted order', () => {
  const topics = collectTopics([plugin('p', 'P', [
    topic('z', 'Z', { category: 'Graphs' }),
    topic('a', 'A', { category: 'Comparison' }),
    topic('m', 'M', { category: 'Graphs' }),
  ])]);
  assert.deepEqual(groupTopics(topics).map(([c, ts]) => [c, ts.map((t) => t.id)]),
    [['Comparison', ['a']], ['Graphs', ['m', 'z']]]);
});

// --- the reader's position -------------------------------------------------------

test('the owner’s navigation case: Index→A→B→Index→C, back three times lands on A', () => {
  const h = new HowtoHistory();
  assert.equal(h.current, null, 'opens at the index');
  h.push('A'); h.push('B'); h.push(null); h.push('C');
  assert.equal(h.current, 'C');
  assert.equal(h.back(), null, 'the index, because Index PUSHES rather than clearing');
  assert.equal(h.back(), 'B');
  assert.equal(h.back(), 'A');
});

test('Back is always safe to offer: at the bottom it is a no-op', () => {
  const h = new HowtoHistory();
  assert.equal(h.canGoBack, false);
  assert.equal(h.back(), null);
  assert.equal(h.current, null);
});

test('consecutive duplicates collapse — Index twice costs one Back, not two', () => {
  const h = new HowtoHistory();
  h.push('A'); h.push(null); h.push(null); h.push(null);
  assert.deepEqual(h.trail, [null, 'A', null]);
  assert.equal(h.back(), 'A');
});

test('re-opening the topic you are already reading is not a move', () => {
  const h = new HowtoHistory();
  h.push('A'); h.push('A');
  assert.deepEqual(h.trail, [null, 'A']);
});

test('a non-consecutive repeat IS a move — you can return to where you were', () => {
  const h = new HowtoHistory();
  h.push('A'); h.push('B'); h.push('A');
  assert.deepEqual(h.trail, [null, 'A', 'B', 'A']);
  assert.equal(h.back(), 'B');
});

test('reset returns to a fresh index', () => {
  const h = new HowtoHistory();
  h.push('A'); h.push('B');
  h.reset();
  assert.deepEqual(h.trail, [null]);
  assert.equal(h.canGoBack, false);
});
