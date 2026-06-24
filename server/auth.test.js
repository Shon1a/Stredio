// Basic tests for the auth primitives. Run with: npm test  (node --test)
// These cover the security-critical pure functions without touching the data
// files (createUser/sessions do real I/O and are exercised via the running
// server in the changelog's manual checklist instead).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, validateEmail, validatePassword,
  parseCookies, sessionCookie, clearCookie, COOKIE_NAME,
} from './auth.js';

test('validateEmail accepts good and rejects bad addresses', () => {
  assert.equal(validateEmail('user@example.com'), null);
  assert.equal(validateEmail('a.b-c@sub.domain.io'), null);
  assert.ok(validateEmail(''));
  assert.ok(validateEmail('notanemail'));
  assert.ok(validateEmail('missing@tld'));
  assert.ok(validateEmail('two@@at.com'));
  assert.ok(validateEmail('a@b.c'.padEnd(300, 'x'))); // too long
});

test('validatePassword enforces length + letter + number', () => {
  assert.equal(validatePassword('goodpass1'), null);
  assert.ok(validatePassword('short1'));        // < 8
  assert.ok(validatePassword('allletters'));    // no digit
  assert.ok(validatePassword('12345678'));      // no letter
  assert.ok(validatePassword(''));              // empty
});

test('hashPassword + verifyPassword round-trip', async () => {
  const stored = await hashPassword('correct horse battery 9');
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('correct horse battery 9', stored), true);
  assert.equal(await verifyPassword('wrong password 9', stored), false);
});

test('verifyPassword is salted (same password hashes differ)', async () => {
  const a = await hashPassword('samePassw0rd');
  const b = await hashPassword('samePassw0rd');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('samePassw0rd', a), true);
  assert.equal(await verifyPassword('samePassw0rd', b), true);
});

test('verifyPassword rejects malformed/tampered hashes without throwing', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'bcrypt$aa$bb'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('parseCookies reads the session cookie out of a header', () => {
  const req = { headers: { cookie: `theme=dark; ${COOKIE_NAME}=abc123; other=1` } };
  const c = parseCookies(req);
  assert.equal(c[COOKIE_NAME], 'abc123');
  assert.equal(c.theme, 'dark');
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('sessionCookie is HttpOnly + SameSite=Lax, Secure only over https', () => {
  const insecure = sessionCookie({ headers: {}, socket: {} }, 'tok', 3600);
  assert.match(insecure, new RegExp(`^${COOKIE_NAME}=tok`));
  assert.match(insecure, /HttpOnly/);
  assert.match(insecure, /SameSite=Lax/);
  assert.match(insecure, /Max-Age=3600/);
  assert.doesNotMatch(insecure, /Secure/);

  const secure = sessionCookie({ headers: { 'x-forwarded-proto': 'https' } }, 'tok', 3600);
  assert.match(secure, /Secure/);
});

test('clearCookie expires the session cookie', () => {
  const c = clearCookie({ headers: {}, socket: {} });
  assert.match(c, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(c, /Max-Age=0/);
});
