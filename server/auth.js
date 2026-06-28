// STREDIO — authentication module.
//
// Zero external dependencies on purpose: password hashing uses Node's built-in
// crypto.scrypt (platform-native, no bcrypt/argon2 native-build pain on Windows),
// sessions are opaque random tokens persisted to data/sessions.json and delivered
// as an HttpOnly cookie, and cookies are parsed by hand (~5 lines) so we don't even
// pull in cookie-parser.
//
// Auth model (documented decision): STREDIO is a single shared media-server
// config, not a multi-tenant SaaS. Multiple people may register, but everyone who
// is logged in shares the same addons configuration. Auth gates WHO may
// touch the configuration surface (Addons + Settings), it does not partition it
// per user. See OVERNIGHT_CHANGELOG.md.

import { scrypt as _scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as storage from './storage.js';

const scrypt = promisify(_scrypt);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');

export const COOKIE_NAME = 'sf_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

// Admin model: STREDIO has one shared config, so "admin" means "may touch the
// operations surface" (the /admin dashboard: cover overrides, the translation
// cache, user management). An account is admin when its persisted
// `isAdmin` flag is true. Bootstrapping (see ensureAdminBootstrap): emails listed
// in ADMIN_EMAILS become admin, and if nobody is admin yet the earliest-created
// account is promoted so the dashboard is never locked out.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const isAdminEmail = (emailLower) => ADMIN_EMAILS.has(emailLower);

// Google Sign-In. Optional: when GOOGLE_CLIENT_ID is unset the feature is dormant
// (the frontend hides its button and /api/auth/google returns 503). The same client
// id doubles as the audience we require on every verified Google token.
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
export const googleConfigured = () => !!GOOGLE_CLIENT_ID;
export const googleClientId = () => GOOGLE_CLIENT_ID;

/* ------------------------------------------------------------------ *
 *  Tiny JSON-file store (mirrors the pattern already used in server.js)
 * ------------------------------------------------------------------ */
async function readJson(file, fallback) {
  // Postgres-backed in production (durable across Render's ephemeral restarts),
  // local file in dev. See storage.js.
  if (storage.dbEnabled) {
    try { return await storage.readDoc(file, fallback); }
    catch (e) { console.warn(`KV read failed (${file}):`, e.message); return fallback; }
  }
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function writeJson(file, value) {
  if (storage.dbEnabled) return storage.writeDoc(file, value);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

const readUsers = () => readJson(USERS_FILE, []);
const writeUsers = (list) => writeJson(USERS_FILE, list);
const readSessions = () => readJson(SESSIONS_FILE, {});
const writeSessions = (map) => writeJson(SESSIONS_FILE, map);

/* ------------------------------------------------------------------ *
 *  Password hashing — scrypt with a per-user random salt
 * ------------------------------------------------------------------ */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await scrypt(password, salt, expected.length);
    // timingSafeEqual needs equal-length buffers (both are SCRYPT_KEYLEN here)
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch { return false; }
}

/* ------------------------------------------------------------------ *
 *  Validation
 * ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(email) {
  if (typeof email !== 'string') return 'Email is required';
  const e = email.trim();
  if (!e) return 'Email is required';
  if (e.length > 254) return 'Email is too long';
  if (!EMAIL_RE.test(e)) return 'Enter a valid email address';
  return null;
}
export function validatePassword(password) {
  if (typeof password !== 'string' || !password) return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 200) return 'Password is too long';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}
// Name/surname: free-form (must accept Latin, Georgian, accents, hyphens, spaces)
// so we only reject empties, over-long values, and control/markup characters.
export function validateName(value, label = 'Name') {
  if (typeof value !== 'string') return `${label} is required`;
  const v = value.trim();
  if (!v) return `${label} is required`;
  if (v.length > 80) return `${label} is too long`;
  if (/[\u0000-\u001f<>]/.test(v)) return `${label} contains invalid characters`;
  return null;
}
// Date of birth: an <input type="date"> value (YYYY-MM-DD). Reject malformed or
// impossible dates, future dates, and ages under 13 (the common minimum) or
// implausibly old (>120) to catch typos like a 0190 birth year.
export function validateDob(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Date of birth is required';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return 'Enter your date of birth';
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Round-trip check rejects impossible dates (e.g. 2023-02-31 → Mar 3).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return 'Enter a valid date of birth';
  }
  const now = new Date();
  if (dt.getTime() > now.getTime()) return 'Date of birth can’t be in the future';
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d)) age--;
  if (age < 13) return 'You must be at least 13 years old to register';
  if (age > 120) return 'Enter a valid date of birth';
  return null;
}

// "Is this a real, mail-capable email domain?" — no message is sent; we just ask
// DNS whether the domain can receive mail. A domain with MX records is deliverable;
// per RFC 5321 a bare A/AAAA record is an implicit MX, so we accept that too. Only
// a definitive "domain does not exist / has no mail records" is rejected — transient
// DNS failures stay lenient so a flaky resolver never blocks a legitimate signup.
// Bounded by a short timeout so signup never hangs on a slow lookup.
export async function checkEmailDomain(email) {
  const domain = String(email || '').trim().split('@')[1];
  if (!domain) return 'Enter a valid email address';
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000));
  const lookup = (async () => {
    try {
      const mx = await dns.resolveMx(domain);
      if (mx && mx.length && mx.some(r => r.exchange)) return 'ok';
    } catch (e) {
      if (e && e.code === 'ENOTFOUND') return 'nodomain';
      // ENODATA (domain exists, no MX) → fall through to the A/AAAA check
    }
    try {
      await dns.lookup(domain);          // implicit-MX: domain resolves, so accept
      return 'ok';
    } catch (e) {
      if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return 'nomail';
      return 'ok';                       // other DNS error → be lenient
    }
  })();
  const result = await Promise.race([lookup, timeout]);
  if (result === 'nodomain') return 'That email domain doesn’t exist';
  if (result === 'nomail') return 'That email domain can’t receive mail';
  return null;                           // 'ok' or 'timeout' → allow
}

/* ------------------------------------------------------------------ *
 *  Users
 * ------------------------------------------------------------------ */
function publicUser(u) {
  return {
    id: u.id, email: u.email,
    name: u.name || '', surname: u.surname || '', dob: u.dob || '',
    createdAt: u.createdAt, isAdmin: !!u.isAdmin,
    emailVerified: !!u.emailVerified, google: !!u.googleId,
  };
}

export async function createUser({ email, password, name, surname, dob } = {}) {
  const emailErr = validateEmail(email);
  if (emailErr) return { error: emailErr, status: 400 };
  const passErr = validatePassword(password);
  if (passErr) return { error: passErr, status: 400 };
  const nameErr = validateName(name, 'First name');
  if (nameErr) return { error: nameErr, status: 400 };
  const surnameErr = validateName(surname, 'Surname');
  if (surnameErr) return { error: surnameErr, status: 400 };
  const dobErr = validateDob(dob);
  if (dobErr) return { error: dobErr, status: 400 };

  const emailLower = email.trim().toLowerCase();
  const users = await readUsers();
  if (users.some(u => u.emailLower === emailLower)) {
    return { error: 'An account with that email already exists', status: 409 };
  }
  // Reject typo'd / non-existent email domains before creating the account. Runs
  // after the duplicate check so we never pay a DNS round-trip for a known email.
  const domainErr = await checkEmailDomain(emailLower);
  if (domainErr) return { error: domainErr, status: 400 };

  const user = {
    id: randomBytes(9).toString('hex'),
    email: email.trim(),
    emailLower,
    name: String(name).trim(),
    surname: String(surname).trim(),
    dob: String(dob).trim(),
    passwordHash: await hashPassword(password),
    // The domain is mail-capable, but we haven't proven the user owns the inbox
    // (no code was sent). Google accounts arrive pre-verified; see authenticateGoogle.
    emailVerified: false,
    createdAt: new Date().toISOString(),
    // An email listed in ADMIN_EMAILS is always admin. The "first account is admin"
    // convenience applies ONLY when no ADMIN_EMAILS are configured — otherwise the
    // operator has declared who admins are, and a stranger who happens to register
    // first must not inherit admin (race-to-register privilege escalation).
    isAdmin: isAdminEmail(emailLower) || (ADMIN_EMAILS.size === 0 && users.length === 0),
  };
  users.push(user);
  await writeUsers(users);
  return { user: publicUser(user) };
}

/* ------------------------------------------------------------------ *
 *  Google Sign-In — verify a Google ID token, then find-or-create the
 *  matching account. We verify the token server-side via Google's tokeninfo
 *  endpoint (no extra dependency): it checks the signature for us and returns
 *  the decoded claims, of which we still independently enforce audience,
 *  issuer, expiry and email_verified. The raw token never persists.
 * ------------------------------------------------------------------ */
export async function authenticateGoogle(idToken, { signupOpen = true } = {}) {
  if (!GOOGLE_CLIENT_ID) return { error: 'Google sign-in is not configured', status: 503 };
  if (!idToken || typeof idToken !== 'string') return { error: 'Missing Google credential', status: 400 };

  let claims;
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return { error: 'Could not verify Google sign-in — try again', status: 401 };
    claims = await r.json();
  } catch {
    return { error: 'Could not reach Google to verify sign-in', status: 502 };
  }

  // Defense in depth: tokeninfo already validated the signature, but we re-check the
  // claims that actually scope the token to *this* app and a real, current identity.
  if (claims.aud !== GOOGLE_CLIENT_ID) {
    return { error: 'That Google sign-in was issued for a different app', status: 401 };
  }
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) {
    return { error: 'Invalid Google token issuer', status: 401 };
  }
  if (claims.exp && Number(claims.exp) * 1000 < Date.now()) {
    return { error: 'Google sign-in expired — try again', status: 401 };
  }
  const email = String(claims.email || '').trim();
  // tokeninfo returns email_verified as the string "true"/"false".
  if (!email || claims.email_verified === 'false' || claims.email_verified === false) {
    return { error: 'Your Google account email isn’t verified', status: 401 };
  }

  const emailLower = email.toLowerCase();
  const users = await readUsers();
  let user = users.find(u => u.emailLower === emailLower);

  if (!user) {
    if (!signupOpen) return { error: 'New account registration is currently disabled', status: 403 };
    user = {
      id: randomBytes(9).toString('hex'),
      email, emailLower,
      name: String(claims.given_name || '').trim(),
      surname: String(claims.family_name || '').trim(),
      dob: '',
      passwordHash: null,             // Google-only account: no local password
      googleId: String(claims.sub || ''),
      emailVerified: true,
      createdAt: new Date().toISOString(),
      isAdmin: isAdminEmail(emailLower) || (ADMIN_EMAILS.size === 0 && users.length === 0),
    };
    users.push(user);
    await writeUsers(users);
  } else if (!user.googleId) {
    // Existing local account with the same email → link Google to it and trust the
    // Google-verified email going forward. The local password keeps working.
    user.googleId = String(claims.sub || '');
    user.emailVerified = true;
    if (!user.name && claims.given_name) user.name = String(claims.given_name).trim();
    if (!user.surname && claims.family_name) user.surname = String(claims.family_name).trim();
    await writeUsers(users);
  }
  return { user: publicUser(user) };
}

export async function authenticate(email, password) {
  const emailLower = String(email || '').trim().toLowerCase();
  const users = await readUsers();
  const user = users.find(u => u.emailLower === emailLower);
  // Always run a verify (even when the user is missing) to blunt timing-based
  // user enumeration; the dummy hash below is a throwaway.
  const stored = user
    ? user.passwordHash
    : 'scrypt$00$' + '0'.repeat(SCRYPT_KEYLEN * 2);
  const ok = await verifyPassword(password, stored);
  if (!user || !ok) return { error: 'Incorrect email or password', status: 401 };
  return { user: publicUser(user) };
}

/* ------------------------------------------------------------------ *
 *  Sessions
 * ------------------------------------------------------------------ */
function prune(sessions, now) {
  let changed = false;
  for (const [tok, s] of Object.entries(sessions)) {
    if (!s || s.expiresAt < now) { delete sessions[tok]; changed = true; }
  }
  return changed;
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const sessions = await readSessions();
  prune(sessions, now);
  sessions[token] = { userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  await writeSessions(sessions);
  return { token, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export async function destroySession(token) {
  if (!token) return;
  const sessions = await readSessions();
  if (sessions[token]) { delete sessions[token]; await writeSessions(sessions); }
}

export async function getSessionUser(token) {
  if (!token) return null;
  const now = Date.now();
  const sessions = await readSessions();
  const s = sessions[token];
  if (!s || s.expiresAt < now) {
    if (s) { delete sessions[token]; await writeSessions(sessions); }
    return null;
  }
  const users = await readUsers();
  const user = users.find(u => u.id === s.userId);
  return user ? publicUser(user) : null;
}

/* ------------------------------------------------------------------ *
 *  Cookies — parse req.headers.cookie by hand; build Set-Cookie strings
 * ------------------------------------------------------------------ */
export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function isSecure(req) {
  // Trust X-Forwarded-Proto when behind a proxy, else the socket.
  const xf = (req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return xf ? xf === 'https' : !!req.socket?.encrypted;
}
// Cross-site cookie policy: the frontend (Vercel) and this API (Render) are
// separate origins in production, so the session cookie must be SameSite=None to
// ride along on those cross-site fetches — and browsers only honor SameSite=None
// when Secure is set. Local same-origin dev runs over plain http (isSecure false),
// where Secure cookies are dropped, so fall back to SameSite=Lax there.
function sameSiteAttr(secure) { return secure ? 'SameSite=None' : 'SameSite=Lax'; }
export function sessionCookie(req, token, maxAgeSec) {
  const secure = isSecure(req);
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    sameSiteAttr(secure),
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
export function clearCookie(req) {
  const secure = isSecure(req);
  // Attributes must match the set cookie (SameSite/Secure) for the browser to clear it.
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', sameSiteAttr(secure), 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/* ------------------------------------------------------------------ *
 *  Express middleware
 * ------------------------------------------------------------------ */
// Pull the session token from an `Authorization: Bearer <token>` header.
// This is the durable path for the split deployment (frontend on Vercel, API on
// Render are separate origins): the session cookie is cross-site, and browsers
// purge cross-site cookies on restart regardless of Max-Age — so users get logged
// out every time they reopen the browser. The frontend therefore also stashes the
// token in localStorage (which survives restarts) and replays it here.
export function bearerToken(req) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}
// Attaches req.user (or null) from the Bearer header or the session cookie.
// Never throws.
export async function attachUser(req, _res, next) {
  try {
    const token = bearerToken(req) || parseCookies(req)[COOKIE_NAME];
    req.sessionToken = token || null;
    req.user = await getSessionUser(token);
  } catch { req.user = null; }
  next();
}
// Gate: 401 if not authenticated.
export function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in to continue', code: 'UNAUTHENTICATED' });
}
// Gate: 401 if signed out, 403 if signed in but not an admin.
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue', code: 'UNAUTHENTICATED' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  next();
}

/* ------------------------------------------------------------------ *
 *  Admin: bootstrap + management helpers (used by the /admin dashboard)
 * ------------------------------------------------------------------ */

// Make sure the dashboard is reachable: promote ADMIN_EMAILS accounts, and if no
// admin exists yet promote the earliest-created account. Idempotent; called once
// at boot. Returns the list of admin emails after reconciliation.
export async function ensureAdminBootstrap() {
  const users = await readUsers();
  if (!users.length) return [];
  let changed = false;
  for (const u of users) {
    if (isAdminEmail(u.emailLower) && !u.isAdmin) { u.isAdmin = true; changed = true; }
  }
  // Promote the earliest account only when no ADMIN_EMAILS are configured. With
  // ADMIN_EMAILS set, admin access waits for a listed email to register rather
  // than handing it to whoever signed up first.
  if (ADMIN_EMAILS.size === 0 && !users.some(u => u.isAdmin)) {
    const first = users.slice().sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
    if (first) { first.isAdmin = true; changed = true; }
  }
  if (changed) await writeUsers(users);
  return users.filter(u => u.isAdmin).map(u => u.email);
}

// Sanitized user list for the admin table (never exposes password hashes).
export async function listUsers() {
  const [users, sessions] = await Promise.all([readUsers(), readSessions()]);
  const now = Date.now();
  const activeByUser = {};
  for (const s of Object.values(sessions)) {
    if (s && s.expiresAt >= now) activeByUser[s.userId] = (activeByUser[s.userId] || 0) + 1;
  }
  return users.map(u => ({
    id: u.id, email: u.email, createdAt: u.createdAt,
    isAdmin: !!u.isAdmin, sessions: activeByUser[u.id] || 0,
  }));
}

export async function countAdmins() {
  return (await readUsers()).filter(u => u.isAdmin).length;
}

// Grant/revoke admin. Refuses to remove the last remaining admin so the
// dashboard can't be locked out.
export async function setUserAdmin(id, makeAdmin) {
  const users = await readUsers();
  const u = users.find(x => x.id === id);
  if (!u) return { error: 'User not found', status: 404 };
  if (!makeAdmin && u.isAdmin && users.filter(x => x.isAdmin).length <= 1) {
    return { error: 'Cannot remove the last admin', status: 409 };
  }
  u.isAdmin = !!makeAdmin;
  await writeUsers(users);
  return { user: publicUser(u) };
}

// Delete an account and revoke all of its sessions.
export async function deleteUser(id) {
  const users = await readUsers();
  const u = users.find(x => x.id === id);
  if (!u) return { error: 'User not found', status: 404 };
  if (u.isAdmin && users.filter(x => x.isAdmin).length <= 1) {
    return { error: 'Cannot delete the last admin', status: 409 };
  }
  await writeUsers(users.filter(x => x.id !== id));
  const sessions = await readSessions();
  let touched = false;
  for (const [tok, s] of Object.entries(sessions)) {
    if (s && s.userId === id) { delete sessions[tok]; touched = true; }
  }
  if (touched) await writeSessions(sessions);
  return { removed: id };
}

export async function countActiveSessions() {
  const sessions = await readSessions();
  const now = Date.now();
  return Object.values(sessions).filter(s => s && s.expiresAt >= now).length;
}

/* ------------------------------------------------------------------ *
 *  Per-user watch state — Continue Watching history + resume progress
 *
 *  Unlike addons (shared config), each account's watch history and resume
 *  timecodes are private and sync across that user's devices. Stored as its OWN
 *  per-user document (watch-<id>) rather than on the user record, so the hot
 *  readUsers() path that runs on every authed request stays small. Shape:
 *    { history:[…], progress:{ key:{pos,dur,at} }, removed:{ id:at }, updatedAt }
 *  `removed` is a tombstone map so a title deleted from the rail on one device
 *  doesn't resurrect from another device's older copy on the next sync.
 * ------------------------------------------------------------------ */
const WATCH_DEFAULT = () => ({ history: [], progress: {}, removed: {} });
const watchFile = (id) => join(DATA_DIR, 'watch-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
export async function getUserWatch(id) {
  if (!id) return WATCH_DEFAULT();
  const doc = await readJson(watchFile(id), null);
  return (doc && typeof doc === 'object') ? doc : WATCH_DEFAULT();
}
export async function setUserWatch(id, data) {
  if (!id) return null;
  await writeJson(watchFile(id), data);
  return data;
}

/* ------------------------------------------------------------------ *
 *  Per-user add-on install state — which official rows the account has toggled
 *  on. Tiny (a handful of booleans), so it rides on the user record. Shape:
 *  { map:{ id:bool }, at:ms }; the newer `at` wins across devices
 *  (last-write-wins, no merge needed for toggles).
 * ------------------------------------------------------------------ */
export async function getUserAddonState(id) {
  if (!id) return null;
  const users = await readUsers();
  return users.find(x => x.id === id)?.addonState || null;
}
export async function setUserAddonState(id, data) {
  const users = await readUsers();
  const u = users.find(x => x.id === id);
  if (!u) return null;
  u.addonState = data;
  await writeUsers(users);
  return u.addonState;
}
