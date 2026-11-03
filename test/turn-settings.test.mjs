/**
 * @file turn-settings.test.mjs
 * The TURN relay editor (#209) — the secret setting that had no way in.
 *
 * ## The row that could only report its own emptiness
 *
 * The owner pointed at a Settings row reading *"Not configured"* with nothing beside it:
 * *"settings screen has a section for turn server but no way to act."*
 *
 * It was my own decision and it was wrong. `collab.turn` is `secret`, so the screen showed
 * status plus a Clear button — and Clear was hidden until the setting was SET. An
 * unconfigured row therefore offered nothing at all, which is a guard around a state that
 * should not exist. Worse, it left the browser console as the only way to configure a
 * relay, which is precisely the gap the Settings screen was built to close: #198's own
 * justification was that `collab.relays` and `collab.turn` had no UI anywhere.
 *
 * ## Write-only, and that is the design rather than a shortfall
 *
 * `listSettings` refuses to return a secret's value. This editor does not go around that:
 * the credential field opens EMPTY every time and saving replaces the stored entry rather
 * than editing it in place. A settings screen that redisplayed a stored password would
 * have made the registry's care pointless, and "type it again" is the ordinary price of
 * never printing it.
 *
 * What it does show is the non-secret part — which URL is configured — because a reader
 * needs to know which relay is in force to decide whether to replace it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { parseTurnInput, describeTurn } = await import('../core/turn-settings.js');

const SRC = readFileSync('core/turn-settings.js', 'utf8');
const SCREEN = readFileSync('core/settings-screen.js', 'utf8');
/** Comments stripped — an absence assertion reads code, not its own explanation. */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------------------
// What counts as a relay
// ---------------------------------------------------------------------------------------

test('a stun: URL is refused, because it is not a relay', () => {
  // The trap worth catching: STUN reports your address, it cannot carry traffic. Storing
  // one would look configured and silently fail to do the job the setting exists for —
  // on a hard NAT, which is the only situation anyone sets this up for.
  const { error } = parseTurnInput({ urls: 'stun:stun.l.google.com:19302' });
  assert.match(error, /turn:/);
  assert.match(error, /not a relay/i);
});

test('turn: and turns: are both accepted, and the URL is trimmed', () => {
  assert.deepEqual(parseTurnInput({ urls: 'turn:relay.example.edu:3478' }).entry,
    { urls: 'turn:relay.example.edu:3478' });
  assert.deepEqual(parseTurnInput({ urls: '  turns:relay.example.edu:5349  ' }).entry,
    { urls: 'turns:relay.example.edu:5349' });
});

test('an empty URL is named, not silently ignored', () => {
  assert.match(parseTurnInput({}).error, /Enter the server URL/);
  assert.match(parseTurnInput({ urls: '   ' }).error, /Enter the server URL/);
});

test('half a credential pair is refused', () => {
  // A server that wants credentials and is given one of the two fails at CONNECTION time,
  // on someone else's machine, with no hint of why. Better to refuse while the person who
  // knows the answer is still looking at the form.
  assert.match(parseTurnInput({ urls: 'turn:x', username: 'u' }).error, /go together/);
  assert.match(parseTurnInput({ urls: 'turn:x', credential: 'p' }).error, /go together/);
  // Neither is fine — an open relay is a real configuration.
  assert.deepEqual(parseTurnInput({ urls: 'turn:x' }).entry, { urls: 'turn:x' });
  // Both is fine, and both are kept.
  assert.deepEqual(parseTurnInput({ urls: 'turn:x', username: 'u', credential: 'p' }).entry,
    { urls: 'turn:x', username: 'u', credential: 'p' });
});

test('the entry shape is what buildIceServers consumes', () => {
  // `{urls, username, credential}` — and an entry with no `urls` is dropped there, which
  // is why this refuses to produce one.
  const { entry } = parseTurnInput({ urls: 'turn:x', username: 'u', credential: 'p' });
  assert.deepEqual(Object.keys(entry).sort(), ['credential', 'urls', 'username']);
});

// ---------------------------------------------------------------------------------------
// Secrecy
// ---------------------------------------------------------------------------------------

test('the description names the URL and never the credential', () => {
  assert.equal(describeTurn(null), 'Not configured');
  assert.equal(describeTurn([]), 'Not configured');
  assert.equal(describeTurn([{ urls: 'turn:a' }]), 'turn:a');
  assert.equal(describeTurn([{ urls: 'turn:a' }, { urls: 'turn:b' }]), '2 servers');
  // A single object rather than an array is accepted, as buildIceServers accepts it.
  assert.equal(describeTurn({ urls: 'turn:solo' }), 'turn:solo');
  // A distinctive username: 'u' as a probe is useless because "turn:" contains one, and
  // the first version of this assertion failed on its own test data.
  const leaky = describeTurn([{ urls: 'turn:a', username: 'alice', credential: 'SECRET' }]);
  assert.ok(!leaky.includes('SECRET'), leaky);
  assert.ok(!leaky.includes('alice'), leaky);
});

test('the credential field is a password input and is never pre-filled', () => {
  const code = codeOf(SRC);
  assert.match(code, /credential = field\('Credential', 'password'\)/);
  // Nothing reads a stored credential back into a field. Checked per INPUT and with
  // plain substrings: a blanket /\.value\s*=/ matched `cancel.value = 'cancel'` (a
  // button's dialog returnValue, not a field), and the dynamic RegExp that replaced it
  // lost its backslashes in transit and silently matched nothing. A guard that cannot
  // fail is worse than one that fails loudly.
  for (const f of ['urls', 'username', 'credential']) {
    assert.ok(!code.includes(f + '.value ='), f + ' must not be pre-filled');
    assert.ok(!code.includes(f + '.value='), f + ' must not be pre-filled');
  }
});

// ---------------------------------------------------------------------------------------
// The way in
// ---------------------------------------------------------------------------------------

test('a secret row offers its editor whether or not it is configured', () => {
  // The defect: Clear was hidden until the setting was set, so an unconfigured row had
  // no control at all. The opener must not be conditional on `isSet` — that is the whole
  // bug — and its label changes instead.
  const at = SCREEN.indexOf("} else if (kind === 'secret') {");
  const body = SCREEN.slice(at, SCREEN.indexOf('} else if (kind ===', at + 10));
  assert.match(body, /const opener = openers\[spec\.id\]/);
  assert.match(body, /spec\.isSet \? 'Change…' : 'Configure…'/);
  // Clear stays conditional, correctly: there is nothing to clear when nothing is set.
  assert.match(body, /if \(spec\.isSet\) \{/);
  // And still no inline field for a secret.
  assert.ok(!/type = 'password'/.test(body), 'no inline credential field');
});

test('the editor is wired through openers, not imported by the declaring module', () => {
  // `live-sync.js` declares the setting and cannot import a dialog without a cycle —
  // the same reason the encryption policy is routed this way.
  const wiring = readFileSync('core/project-sync.js', 'utf8');
  assert.match(wiring, /'collab\.turn': \(\) => showTurnSettings\(\)/);
  const live = codeOf(readFileSync('core/live-sync.js', 'utf8'));
  assert.ok(!/turn-settings/.test(live), 'the declaring module imports no dialog');
});

test('saving writes through the setting, and removing clears it', () => {
  const code = codeOf(SRC);
  assert.match(code, /setTurnConfig\(\[entry\]\)/, 'stored as an array');
  assert.match(code, /setTurnConfig\(null\)/, 'and cleared, not stored as empty');
});
