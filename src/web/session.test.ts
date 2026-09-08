import test from 'node:test';
import assert from 'node:assert/strict';
import { mintSession, sessionValid, parseCookies, safeNext } from './session.js';

/**
 * The auth boundary. Everything here is a way in if it is wrong, so each case
 * is an attack rather than a feature: a forged cookie, a stale one, a session
 * that outlived the password that made it, and a login form used to send
 * someone somewhere else.
 *
 * No database and no server.
 */

const SECRET = 'correct horse battery staple';

test('a minted session verifies against the secret that made it', () => {
  assert.equal(sessionValid(mintSession(SECRET), SECRET), true);
});

test('a tampered expiry does not verify', () => {
  // The expiry lives inside the signed payload precisely so this fails.
  const token = mintSession(SECRET);
  const forged = `${Date.now() + 10 * 864e5}.${token.slice(token.lastIndexOf('.') + 1)}`;
  assert.equal(sessionValid(forged, SECRET), false);
});

test('a session does not survive a password change', () => {
  // The password is the signing key, so rotating it revokes every outstanding
  // session without anything having to track them.
  const token = mintSession(SECRET);
  assert.equal(sessionValid(token, 'a different password'), false);
});

test('an expired session is refused even though it is properly signed', () => {
  const issued = Date.now() - 40 * 864e5;      // minted forty days ago
  const token = mintSession(SECRET, issued);   // good for thirty
  assert.equal(sessionValid(token, SECRET, issued), true, 'valid the day it was made');
  assert.equal(sessionValid(token, SECRET), false, 'and not today');
});

test('junk in the cookie is refused rather than thrown', () => {
  for (const junk of ['', 'nonsense', '.', 'a.b', `${Date.now() + 1e6}.`, `${Date.now() + 1e6}`]) {
    assert.equal(sessionValid(junk, SECRET), false, `should refuse ${JSON.stringify(junk)}`);
  }
  assert.equal(sessionValid(undefined, SECRET), false);
});

test('cookies parse, and a malformed one does not take the request down', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies(undefined), {});
  // A stray percent is not valid UTF-8 escaping; the pair is dropped, and the
  // rest of the header still parses.
  assert.deepEqual(parseCookies('bad=%E0%A4%A; good=1'), { good: '1' });
});

test('the post-login redirect cannot leave the site', () => {
  assert.equal(safeNext('/slips'), '/slips');
  assert.equal(safeNext('/board?league=CS2'), '/board?league=CS2');
  // Protocol-relative: starts with a slash and still leaves the origin.
  assert.equal(safeNext('//evil.example'), '/board');
  assert.equal(safeNext('https://evil.example'), '/board');
  // Backslashes because some browsers have normalised them to forward ones.
  assert.equal(safeNext('/\\evil.example'), '/board');
  assert.equal(safeNext(null), '/board');
  assert.equal(safeNext(''), '/board');
});
