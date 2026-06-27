// STREDIO backend — TMDB catalog/search proxy + addon install-by-URL engine.
// Single-origin: also serves the static frontend (index.html) so the browser
// can call /api/* without any CORS configuration.

import express from 'express';
import compression from 'compression';
import dotenv from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachUser, requireAuth, requireAdmin, ensureAdminBootstrap,
  createUser, authenticate, authenticateGoogle, googleConfigured, googleClientId,
  createSession, destroySession, sessionCookie, clearCookie,
  getUserSaturn, setUserSaturn,
  getUserWatch, setUserWatch,
} from './auth.js';
import * as covers from './covers.js';
import * as logoStore from './logos.js';
import * as glossary from './glossary.js';
import * as storage from './storage.js';
import { createAdminRouter, recordActivity } from './admin.js';
import { start as startGeorgianAddon } from './georgian-addon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load .env from beside this file, not from process.cwd(), so the TMDB key is
// found whether the server is started as `node server.js` (cwd=server/) or
// `node server/server.js` (cwd=repo root). The latter silently dropped the
// key, leaving HAS_TMDB false → every /api/catalog & /api/search hit 503.
dotenv.config({ path: join(__dirname, '.env') });
const ROOT = join(__dirname, '..');            // the "Movie Website" folder (static frontend)
const DATA_DIR = join(__dirname, 'data');
const ADDONS_FILE = join(DATA_DIR, 'addons.json');

const PORT = process.env.PORT || 8787;
const TMDB_BEARER = process.env.TMDB_BEARER?.trim();
const TMDB_API_KEY = process.env.TMDB_API_KEY?.trim();
const HAS_TMDB = !!(TMDB_BEARER || TMDB_API_KEY);
// Poster/backdrop CDN: the Cloudflare image Worker (stredio-img) is a 30-day
// edge cache in front of TMDB with an IDENTICAL /t/p/<size>/<file> request
// shape, so this is a pure host swap. Defaults to the Worker so it's active
// without extra env config; set IMG_CDN_BASE=https://image.tmdb.org to fall
// back to TMDB directly. Cloudflare doesn't meter Worker bandwidth, and images
// never touched the origin anyway — this is purely faster + more resilient.
const IMG_CDN_BASE = (process.env.IMG_CDN_BASE || 'https://stredio-img.shonomusicofficial.workers.dev').replace(/\/+$/, '');
const IMG = IMG_CDN_BASE + '/t/p/w500';
// hero backdrop at TMDB's full source resolution (`original`) — frequently true
// 4K (3840x2160) for modern titles — so the full-bleed featured hero stays crisp
// on large/retina displays. `original` is backdrop-only, so the small poster
// cards (IMG/w500) are unaffected and bandwidth stays scoped to the one hero image.
const IMGBACK = IMG_CDN_BASE + '/t/p/original';   // landscape backdrop for the hero banner
const IMGFACE = IMG_CDN_BASE + '/t/p/w185';       // compact avatars for the "Casts & Credits" rail
const IMGSTILL = IMG_CDN_BASE + '/t/p/w300';      // 16:9 episode-card stills (light — cards are ~190px wide)

// Where the media byte-proxy lives. Production sets STREAM_PROXY_BASE to the
// Cloudflare Worker origin (e.g. https://stredio-stream.<sub>.workers.dev) so
// video bytes never transit this origin — Cloudflare doesn't meter Worker
// bandwidth (Render's free tier does, which is what got us suspended). Unset →
// same-origin Express /api/stream-proxy (local dev). Both expose the identical
// /stream-proxy?src=&ref=&t=hls request shape, so flipping the env var is the
// whole switch — and unsetting it instantly reverts to origin-proxying.
const STREAM_PROXY_BASE = (process.env.STREAM_PROXY_BASE || '').replace(/\/+$/, '');
const STREAM_PROXY_PATH = STREAM_PROXY_BASE ? STREAM_PROXY_BASE + '/stream-proxy' : '/api/stream-proxy';

const app = express();
app.disable('x-powered-by');
// gzip/deflate every text response (HTML/JS/CSS/JSON). The frontend shell is a
// single ~376KB inline-everything file; compressed it ships at ~80KB, which is
// the single biggest first-load win. Binary assets (fonts/images) are already
// compressed, so `compression` skips them via its default content-type filter.
app.use(compression());
app.use(express.json({ limit: '64kb' }));

/* ------------------------------------------------------------------ *
 *  CORS — split deployment
 *  The frontend is hosted on a DIFFERENT origin (Vercel) than this API (Render),
 *  so browsers require explicit CORS. Auth rides an HttpOnly cookie, so we must
 *  also allow credentials — which forbids the "*" wildcard and means we echo back
 *  only the specific allowed origin. Configure the allowed frontend origin(s) with
 *  CORS_ORIGINS (comma-separated); defaults to the production Vercel origin. When
 *  the backend serves the frontend itself (local dev) requests are same-origin and
 *  carry no Origin header, so this is a no-op there.
 * ------------------------------------------------------------------ */
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || 'https://stredio.vercel.app')
    .split(',').map(s => s.trim()).filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    // Authorization is required for the Bearer-token fallback: mobile browsers
    // (iOS Safari) block cross-site cookies, so the frontend replays the session
    // as `Authorization: Bearer …`. That header forces a CORS preflight, which
    // fails unless we list it here — without it, every /api call on mobile throws
    // and the backend appears unreachable while desktop (cookie auth) still works.
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '86400');
  }
  // Answer preflight before auth/rate-limit middleware so it never 401s or 429s.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------------------------------------------ *
 *  Security + cache headers
 *  CSP is pragmatic: this is a single-file app whose inline <script>/<style>
 *  are intrinsic, so 'unsafe-inline' stays — but every external origin is
 *  pinned to exactly what the app uses, and framing is denied.
 * ------------------------------------------------------------------ */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Google Identity Services ships its button + flow from accounts.google.com/gsi
    "script-src 'self' 'unsafe-inline' https://accounts.google.com",
    // hls.js offloads demuxing to a Web Worker it spawns from a blob: URL; without
    // an explicit worker-src the script-src fallback blocks it, forcing slower
    // main-thread playback (and a console error) for every HLS source.
    "worker-src 'self' blob:",
    // hls.js fetches playlists/segments via XHR (connect-src). When streams are
    // proxied through the Cloudflare Worker, its origin must be allowed here so
    // those cross-origin fetches aren't blocked. (<video> for direct files is
    // already covered by media-src's https:.) Derived from STREAM_PROXY_BASE so
    // CSP and the proxy URLs can never drift apart.
    "connect-src 'self' https://accounts.google.com" + (STREAM_PROXY_BASE ? ' ' + STREAM_PROXY_BASE : ''),
    // the detail modal embeds a muted YouTube trailer via the privacy-enhanced domain;
    // accounts.google.com renders the Google Sign-In button/consent inside an iframe
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

/* ------------------------------------------------------------------ *
 *  Auth: resolve the session cookie into req.user for every request,
 *  plus a tiny in-memory per-IP rate limiter (no dependency).
 * ------------------------------------------------------------------ */
app.use(attachUser);

// X-Forwarded-For is client-controlled, so honoring it lets anyone mint a fresh
// rate-limit bucket per request (defeating the auth brute-force limiter). Only
// trust it when explicitly behind a proxy (TRUST_PROXY=1), and then take the
// rightmost hop (the address the proxy actually saw), not the spoofable leftmost.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ipOf = req => {
  if (TRUST_PROXY) {
    const chain = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
};
const rateBuckets = new Map();
function rateLimit({ windowMs, max, scope }) {
  return (req, res, next) => {
    const now = Date.now();
    if (rateBuckets.size > 5000) {            // lazy cleanup so the map can't grow unbounded
      for (const [k, b] of rateBuckets) if (b.reset < now) rateBuckets.delete(k);
    }
    const id = scope + ':' + ipOf(req);
    let b = rateBuckets.get(id);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(id, b); }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down and try again shortly', code: 'RATE_LIMITED' });
    }
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, scope: 'auth' });
const installLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, scope: 'install' });
const resolveLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, scope: 'resolve' });
const saturnLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, scope: 'saturn-verify' });

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  // Optional admin-controlled lockdown (Security → "Disable new signups"). Defaults
  // to open; only an explicit admin toggle sets it false. Closes the documented
  // "first stranger to register becomes admin" window once the operator is set up.
  // An admin signs in via /login (not /signup), so this never locks anyone out.
  const settings = await readSettings().catch(() => ({}));
  if (settings.signupOpen === false) {
    return res.status(403).json({ error: 'New account registration is currently disabled', code: 'SIGNUP_CLOSED' });
  }
  const { email, password, name, surname, dob } = req.body || {};
  const result = await createUser({ email, password, name, surname, dob });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  const { token, maxAgeSec } = await createSession(result.user.id);
  res.append('Set-Cookie', sessionCookie(req, token, maxAgeSec));
  // Also return the token so the frontend can persist it in localStorage and
  // replay it as a Bearer header — keeps the session alive across browser restarts
  // on the split deploy, where the cross-site cookie gets purged. See auth.js.
  res.status(201).json({ user: result.user, token });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const result = await authenticate(email, password);
  if (result.error) return res.status(result.status || 401).json({ error: result.error });
  const { token, maxAgeSec } = await createSession(result.user.id);
  res.append('Set-Cookie', sessionCookie(req, token, maxAgeSec));
  res.json({ user: result.user, token });
});

// Google Sign-In — verifies the ID token from Google Identity Services, then logs
// the user in (creating the account on first use). Honors the signup lockdown for
// brand-new Google accounts, exactly like /signup.
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body || {};
  const settings = await readSettings().catch(() => ({}));
  const result = await authenticateGoogle(credential, { signupOpen: settings.signupOpen !== false });
  if (result.error) return res.status(result.status || 401).json({ error: result.error });
  const { token, maxAgeSec } = await createSession(result.user.id);
  res.append('Set-Cookie', sessionCookie(req, token, maxAgeSec));
  res.json({ user: result.user, token });
});

// Public auth config the frontend reads at boot to decide whether to show the
// "Continue with Google" button. Exposes only the (non-secret) OAuth client id.
app.get('/api/auth/config', (req, res) => {
  res.json({ google: googleConfigured(), googleClientId: googleClientId() });
});

app.post('/api/auth/logout', async (req, res) => {
  await destroySession(req.sessionToken);
  res.append('Set-Cookie', clearCookie(req));
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

/* ------------------------------------------------------------------ *
 *  TMDB helper
 * ------------------------------------------------------------------ */
/* Short-TTL in-memory cache for TMDB GETs. The catalog feeds (trending/top/discover)
 * change at most daily and title details are effectively static, so caching the raw
 * JSON for a few minutes makes repeat page loads — and the hero/first-row overlap,
 * which both pull trending — near-instant, and slashes the cold-start round-trips
 * that make the first open slow. Keyed by the fully-resolved URL (language + every
 * param), so EN/KA and each page stay distinct, and the api_key is appended AFTER
 * the key is computed so it never lands in the cache key. Per-request admin overrides
 * (covers/logos) are layered on top of this raw data downstream, so caching here can
 * never staleness them. Bounded with oldest-first eviction so it can't grow without
 * limit; callers only ever READ the returned objects, so sharing references is safe. */
const TMDB_CACHE = new Map();
const TMDB_TTL = 10 * 60 * 1000;   // 10 minutes
const TMDB_CACHE_MAX = 600;
async function tmdb(path, params = {}) {
  if (!HAS_TMDB) throw Object.assign(new Error('TMDB not configured'), { code: 'NO_TMDB' });
  const url = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const cacheKey = url.toString();
  const hit = TMDB_CACHE.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.data;

  const headers = { accept: 'application/json' };
  if (TMDB_BEARER) headers.Authorization = `Bearer ${TMDB_BEARER}`;
  else url.searchParams.set('api_key', TMDB_API_KEY);

  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw Object.assign(new Error(`TMDB ${r.status}`), { code: 'TMDB_ERR', status: r.status, body });
  }
  const data = await r.json();
  // evict the oldest entry once full (Map preserves insertion order)
  if (TMDB_CACHE.size >= TMDB_CACHE_MAX) TMDB_CACHE.delete(TMDB_CACHE.keys().next().value);
  TMDB_CACHE.set(cacheKey, { data, exp: Date.now() + TMDB_TTL });
  return data;
}

/* map the frontend's ?lang= (en|ka) onto a TMDB language tag. TMDB ships
   native Georgian (ka-GE) translations for many titles; anything untranslated
   falls back to the original (usually English) automatically. */
function tmdbLang(req) {
  return String(req.query.lang || '').toLowerCase() === 'ka' ? 'ka-GE' : 'en-US';
}

/* genre id <-> name maps (TMDB uses numeric ids). Cached after first fetch. */
let GENRE_BY_NAME = null;    // {action: 28, ...}  movie + tv merged (for display + movie discover)
let GENRE_TV_BY_NAME = null; // {comedy: 35, ...}  tv-only name→id (TV discover needs tv ids)
let GENRE_BY_ID = null;      // {28: "Action", ...}
const GENRE_ALIASES = { 'sci-fi': 'science fiction', scifi: 'science fiction' };
// TMDB splits a few genres differently for TV. Map the shared label the UI shows
// (sourced from the merged movie table) onto the TV-specific bucket so a genre
// filter still works when the user is browsing/searching Series.
const TV_GENRE_ALIASES = {
  'science fiction': 'sci-fi & fantasy', 'sci-fi': 'sci-fi & fantasy', 'fantasy': 'sci-fi & fantasy',
  'action': 'action & adventure', 'adventure': 'action & adventure', 'war': 'war & politics',
};

let genresReady = null;
async function loadGenres() {
  if (GENRE_BY_ID) return;                          // already populated
  // Memoize the in-flight load so the six concurrent /api/browse calls that paint
  // the home all await ONE real fetch. The earlier version marked the cache
  // populated (an empty {}) BEFORE awaiting, so the five piggybacking callers
  // mapped against an empty genre table and rendered "—" until the cache warmed.
  if (!genresReady) genresReady = (async () => {
    const byName = {}, byId = {}, tvByName = {};
    // Movie + TV genre tables share one display map (ids mostly don't collide). TV
    // adds its own ids (10759 Action & Adventure, 10765 Sci-Fi & Fantasy, …) so the
    // trending shows / anime rows resolve a real genre label instead of "—". The
    // TV-only name→id map is kept apart so /discover/tv gets a valid tv genre id.
    const [movieList, tvList] = await Promise.all([
      tmdb('/genre/movie/list', { language: 'en-US' }),
      tmdb('/genre/tv/list', { language: 'en-US' }).catch(() => ({ genres: [] })),
    ]);
    for (const g of movieList.genres || []) { byName[g.name.toLowerCase()] = g.id; byId[g.id] = g.name; }
    for (const g of tvList.genres || []) {
      tvByName[g.name.toLowerCase()] = g.id;
      if (!byId[g.id]) byId[g.id] = g.name;
      if (byName[g.name.toLowerCase()] === undefined) byName[g.name.toLowerCase()] = g.id;
    }
    GENRE_BY_NAME = byName; GENRE_TV_BY_NAME = tvByName; GENRE_BY_ID = byId; // publish atomically once fully built
  })().catch(() => { genresReady = null; /* allow a later retry; genre stays a no-op meanwhile */ });
  await genresReady;
}
function genreNameToId(name, type = 'movie') {
  if (!name) return undefined;
  const key = GENRE_ALIASES[name.toLowerCase()] || name.toLowerCase();
  if (type === 'tv') {
    // direct tv match, else fall back to the tv-split bucket (Action → Action & Adventure)
    return GENRE_TV_BY_NAME?.[key] ?? GENRE_TV_BY_NAME?.[TV_GENRE_ALIASES[key]];
  }
  return GENRE_BY_NAME?.[key];
}
function primaryGenre(ids = []) {
  for (const id of ids) {
    const n = GENRE_BY_ID?.[id];
    if (n) return n === 'Science Fiction' ? 'Sci-Fi' : n;
  }
  return '—';
}

/* collapse the request's ?lang= to the cover language ('ka' | 'en'). Mirrors
   tmdbLang but returns the short code covers.js stores overrides under. */
function coverLang(req) {
  return String(req.query.lang || '').toLowerCase() === 'ka' ? 'ka' : 'en';
}

/* normalise a TMDB movie OR tv object into the shape the frontend expects.
   `lang` is the cover language ('ka' | 'en') so the admin's per-language poster
   override is applied to the right audience. `type` ('movie' | 'tv') is carried
   through to the client so a poster click opens the right /api/meta lookup, and
   so TV titles (which expose `name`/`first_air_date`) map cleanly. */
function mapMovie(m, lang = 'en', type = 'movie') {
  const isTv = type === 'tv';
  return {
    id: String(m.id),
    type: isTv ? 'tv' : 'movie',
    title: m.title || m.name || 'Untitled',
    year: (m.release_date || m.first_air_date || '').slice(0, 4) || '—',
    rating: m.vote_average ? +m.vote_average.toFixed(1) : 0,
    genre: primaryGenre(m.genre_ids || (m.genres || []).map(g => g.id)),
    // Admin cover overrides win over the TMDB default — and they're per-language:
    // the Georgian site gets the Georgian-lettered cover, the English site the
    // English one (each falls back to the TMDB poster when none was chosen).
    // Overrides are namespaced by media type (movie vs tv) in covers.js so a movie
    // id and a TV id that share a number never collide.
    poster: covers.getOverridePoster(m.id, lang, type) || (m.poster_path ? IMG + m.poster_path : null),
    backdrop: m.backdrop_path ? IMGBACK + m.backdrop_path : null,
    overview: m.overview || '',
  };
}

/* Cast + crew for the detail modal's "Casts & Credits" rail. Profile photos drive
   the circular avatars; we keep up to 18 so the modal's "Show all" has something to
   reveal beyond the first handful. Character is kept verbatim (may be empty). */
function mapCast(credits = {}) {
  return (credits.cast || []).slice(0, 18).map(c => ({
    name: c.name,
    character: c.character || '',
    profile: c.profile_path ? IMGFACE + c.profile_path : null,
  }));
}
/* Lead director for a movie (TV uses created_by instead — handled at the call site). */
function findDirector(credits = {}) {
  const d = (credits.crew || []).find(c => c.job === 'Director');
  return d ? d.name : null;
}
/* Best YouTube clip for the modal's auto-playing trailer hero: prefer an official
   Trailer, then any Trailer, then a Teaser — so the hero finds a clip far more often
   than a strict type==='Trailer' match did. Returns the TMDB video object or null. */
function pickTrailer(videos) {
  const vids = (videos?.results || []).filter(v => v.site === 'YouTube');
  return vids.find(v => v.type === 'Trailer' && v.official)
      || vids.find(v => v.type === 'Trailer')
      || vids.find(v => v.type === 'Teaser')
      || null;
}

/* ------------------------------------------------------------------ *
 *  Title logos — the stylised wordmark TMDB ships per title (transparent
 *  PNG), shown in the hero + detail modal in place of the text title.
 * ------------------------------------------------------------------ */
// Pick the single best logo file_path per language from a TMDB images.logos
// array (highest vote_count wins within a language). Returns paths or null.
function bestLogoPaths(logos = []) {
  const pick = (lang) => {
    const cands = (logos || []).filter(l => (l.iso_639_1 || null) === lang && l.file_path);
    if (!cands.length) return null;
    cands.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0) || (b.vote_average || 0) - (a.vote_average || 0));
    return cands[0].file_path;
  };
  return { ka: pick('ka'), en: pick('en'), neutral: pick(null) };
}

/* Resolve the title-logo URL for a title in the given cover language ('ka'|'en'),
   or null if TMDB has none. Precedence:
     1. admin per-language override (per media type — see covers.js / getOverrideLogo)
     2. TMDB logo: requested language → English → neutral (no language)
   `imagesObj` is the append_to_response `images` block when the caller already
   fetched it (the meta endpoints); otherwise we consult the disk cache and only
   hit /images on a miss (the hero, whose list items carry no images). */
async function resolveLogo(id, type, cLang, imagesObj) {
  const ov = covers.getOverrideLogo(id, cLang, type);
  if (ov) return ov;
  let paths;
  if (imagesObj && Array.isArray(imagesObj.logos)) {
    paths = bestLogoPaths(imagesObj.logos);
    logoStore.setCached(id, type, paths);
  } else {
    paths = logoStore.getCached(id, type);
    if (!paths) {
      try {
        const data = await tmdb(`/${type === 'tv' ? 'tv' : 'movie'}/${id}/images`, { include_image_language: 'ka,en,null' });
        paths = bestLogoPaths(data.logos || []);
        logoStore.setCached(id, type, paths);
      } catch { return null; }
    }
  }
  const order = cLang === 'ka' ? ['ka', 'en', 'neutral'] : ['en', 'neutral', 'ka'];
  for (const k of order) { if (paths[k]) return IMG + paths[k]; }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Georgian machine-translation for movie text TMDB lacks
 *
 *  TMDB ships native Georgian for some titles but not most. When the client
 *  asks for ka and a title/plot comes back still in English, we translate it
 *  via Google Translate's free endpoint and cache the result on disk, so each
 *  unique string is translated once, ever. UI chrome is NOT translated here —
 *  that's the baked-in static table in the frontend. Google keeps most proper
 *  nouns and technical tokens (brand names, "4K") as-is automatically.
 *
 *  No API key is required. canTranslate() gates the feature, so it can be turned
 *  off entirely with DISABLE_KA_TRANSLATE=1 (the catalog then serves English).
 * ------------------------------------------------------------------ */
// Google Translate's free web endpoint. One request per string; the on-disk
// ka-cache makes each unique string a one-time cost, so MT_CONCURRENCY can stay
// low and gentle on the endpoint (which rate-limits aggressive callers).
const GT_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MT_ENABLED = process.env.DISABLE_KA_TRANSLATE !== '1';
const MT_CONCURRENCY = Math.max(1, Number(process.env.KA_TRANSLATE_CONCURRENCY) || 5);
const canTranslate = () => MT_ENABLED;
const KA_CACHE_FILE = join(DATA_DIR, 'ka-cache.json');
const hasGeorgian = s => /[Ⴀ-ჿ]/.test(s || '');

const kaCache = new Map();
// Awaited in boot() before app.listen — alongside the cover store and glossary
// — so the cache is fully loaded before the first request, instead of racing an
// un-awaited IIFE (which could fire redundant translate calls and overwrite the
// disk cache with a near-empty snapshot during the boot window).
async function loadKaCache() {
  try {
    const raw = storage.dbEnabled
      ? (await storage.readDoc(KA_CACHE_FILE, {}))
      : JSON.parse(await readFile(KA_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) kaCache.set(k, v);
  } catch { /* no cache yet */ }
}
let cacheSaveTimer = null;
function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(async () => {
    cacheSaveTimer = null;
    try {
      if (storage.dbEnabled) { await storage.writeDoc(KA_CACHE_FILE, Object.fromEntries(kaCache)); return; }
      await mkdir(DATA_DIR, { recursive: true }); await writeFile(KA_CACHE_FILE, JSON.stringify(Object.fromEntries(kaCache)), 'utf8');
    }
    catch (e) { console.warn('ka-cache save failed:', e.message); }
  }, 1500);
}

// in-flight de-dupe so concurrent requests don't translate the same batch twice
const inflight = new Map();

/* ------------------------------------------------------------------ *
 *  Localization reliability telemetry (in-memory, since boot).
 *
 *  translateToKa() deliberately NEVER throws: on any translation failure it serves the
 *  original English so the catalog degrades instead of breaking. The cost is that
 *  the signature feature can silently regress with nothing but a console.warn. These
 *  counters make that visible on the dashboard — cache-hit ROI, glossary short-
 *  circuits, fresh translations, and (the one that matters) how often we quietly
 *  fell back to English and why. Reset on restart by design; labelled "since boot".
 * ------------------------------------------------------------------ */
const txMetrics = {
  bootAt: new Date().toISOString(),
  cacheHit: 0,      // strings served from the on-disk ka-cache (no API call)
  glossaryHit: 0,   // strings answered by a forced glossary rendering (no API call)
  translated: 0,    // strings freshly translated by Google Translate
  fellBack: 0,      // strings served in English because translation failed
  passthrough: 0,   // strings that were already Georgian / empty (nothing to do)
  lastTranslateAt: null,
  fallbacks: [],    // [{ at, count, reason }] — most recent first, capped
};
const TX_FALLBACK_MAX = 50;
function recordFallback(count, reason) {
  txMetrics.fellBack += count;
  txMetrics.fallbacks.unshift({ at: new Date().toISOString(), count, reason: String(reason || 'unknown').slice(0, 160) });
  if (txMetrics.fallbacks.length > TX_FALLBACK_MAX) txMetrics.fallbacks.length = TX_FALLBACK_MAX;
  // Surface in the activity feed too (one entry per failed batch, not per string).
  recordActivity('fallback', `Served English for ${count} string(s): ${String(reason || 'unknown').slice(0, 80)}`);
}
// Snapshot for the admin API (defensive copy; trims the fallback list).
function translationMetrics() {
  const total = txMetrics.cacheHit + txMetrics.glossaryHit + txMetrics.translated + txMetrics.fellBack;
  const noApi = txMetrics.cacheHit + txMetrics.glossaryHit;
  return {
    bootAt: txMetrics.bootAt,
    cacheHit: txMetrics.cacheHit,
    glossaryHit: txMetrics.glossaryHit,
    translated: txMetrics.translated,
    fellBack: txMetrics.fellBack,
    passthrough: txMetrics.passthrough,
    lastTranslateAt: txMetrics.lastTranslateAt,
    served: total,
    // share of translatable strings answered without spending a translate call
    hitRate: total ? +((noApi / total) * 100).toFixed(1) : null,
    fallbacks: txMetrics.fallbacks.slice(0, 20),
  };
}

// Tiny concurrency limiter so a big batch of cache-misses doesn't fire dozens of
// requests at once (the free endpoint rate-limits aggressive callers).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

// Translate ONE string EN→KA via Google's free endpoint. Throws on any failure so
// the batch wrapper can record it as null (English fallback) for that string.
async function googleTranslateOne(text) {
  const url = `${GT_ENDPOINT}?client=gtx&sl=en&tl=ka&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; STREDIO/1.0)' },
    // Cap the wait so a slow response can't stall a catalog request — translateToKa
    // serves English for anything that fails.
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error('Google Translate ' + r.status), { status: r.status });
  const data = await r.json();
  // Shape: [ [ [translatedChunk, sourceChunk, …], … ], … ]. Google splits long text
  // into sentence chunks; rejoin them in order to rebuild the full translation.
  const chunks = data && data[0];
  if (!Array.isArray(chunks)) throw new Error('Google Translate bad response');
  const ka = chunks.map(c => (c && c[0]) || '').join('').trim();
  if (!ka) throw new Error('Google Translate empty result');
  return ka;
}

// Translate a batch of strings. Returns an array the SAME length/order; a string
// that fails comes back as null, so the caller serves (and does not cache) English
// for it and it retries on a later request. Never throws.
async function mtTranslateBatch(texts) {
  const out = await mapLimit(texts, MT_CONCURRENCY, async (t) => {
    if (!t) return t;
    try { return await googleTranslateOne(t); }
    catch { return null; }
  });
  const ok = out.filter(Boolean).length;
  if (ok) recordActivity('translation', `Translated ${ok} string(s) via Google Translate`);
  return out;
}

/* Translate a set of strings to Georgian using cache + one batched API call for
 * the misses. Never throws — on any failure the original strings are returned,
 * so the catalog degrades to English rather than breaking. */
async function translateToKa(strings) {
  const result = new Map();                       // source -> ka
  const misses = [];
  for (const s of strings) {
    if (!s || hasGeorgian(s)) { result.set(s, s); txMetrics.passthrough++; continue; }
    // Glossary forced renderings are authoritative house style and win over a
    // possibly-stale cache entry — and cost no translate call.
    const fx = glossary.forced(s);
    if (fx != null) { result.set(s, fx); txMetrics.glossaryHit++; continue; }
    if (kaCache.has(s)) { result.set(s, kaCache.get(s)); txMetrics.cacheHit++; continue; }
    misses.push(s);
  }
  if (!misses.length) return result;
  const uniq = [...new Set(misses)];
  // Feature switched off (DISABLE_KA_TRANSLATE=1) → serve English. Count it so the
  // dashboard surfaces the degradation instead of it vanishing silently.
  if (!canTranslate()) {
    recordFallback(uniq.length, 'translation disabled (DISABLE_KA_TRANSLATE)');
    uniq.forEach(src => result.set(src, src));
    return result;
  }
  const key = uniq.join(' ');
  // Only the caller that LAUNCHED the batch attributes its cost. Concurrent callers
  // that dedupe onto the same in-flight promise share one real API call, so counting
  // each joiner would inflate the reliability telemetry (translated/fellBack/hitRate).
  const existing = inflight.get(key);
  const isOwner = !existing;
  const p = existing || mtTranslateBatch(uniq);
  if (isOwner) inflight.set(key, p);
  try {
    const translated = await p.finally(() => { if (isOwner) inflight.delete(key); });
    let ok = 0, fail = 0;
    uniq.forEach((src, i) => {
      const ka = translated[i];
      // null = the translate call FAILED → serve English now but DON'T cache it, so it
      // retries on a later request. A non-null result is cached even when it stayed
      // English (Google legitimately keeps proper-noun titles like "The Matrix" as-is);
      // caching it avoids re-translating the same title on every page view. Such echoes
      // surface in the admin's "suspicious" view, where a forced glossary rendering can
      // pin a Georgian title if desired.
      if (ka == null) { result.set(src, src); fail++; }
      else { kaCache.set(src, ka); result.set(src, ka); ok++; }
    });
    if (isOwner) {
      if (ok) { txMetrics.translated += ok; txMetrics.lastTranslateAt = new Date().toISOString(); scheduleCacheSave(); }
      if (fail) recordFallback(fail, 'Google Translate request failed');
    }
  } catch (e) {
    console.warn('translate failed (' + e.message + ') — serving English');
    if (isOwner) recordFallback(uniq.length, e.message);
    uniq.forEach(src => result.set(src, src));
  }
  return result;
}

/* When serving Georgian, TMDB leaves `overview` empty for every title it has no
 * native Georgian synopsis for. Backfill those gaps in place from the English
 * version of the SAME query so localizeMovies can machine-translate a real plot —
 * otherwise the hero falls back to the generic placeholder instead of a Georgian
 * rendering of the actual English plot. One extra TMDB call, and only when at
 * least one overview is missing. Mirrors the English-backfill in /api/meta/:id. */
async function backfillOverviews(mapped, lang, fetchEnglish) {
  if (lang !== 'ka-GE' || !mapped.some(m => !m.overview)) return mapped;
  try {
    const en = (await fetchEnglish()) || [];
    const byId = new Map(en.map(m => [String(m.id), m.overview || '']));
    for (const m of mapped) { if (!m.overview) { const o = byId.get(m.id); if (o) m.overview = o; } }
  } catch { /* keep Georgian-as-is on failure; localize + client fallback still apply */ }
  return mapped;
}

/* localize an array of mapped movies in place (title + overview) when lang=ka */
async function localizeMovies(movies, lang) {
  if (lang !== 'ka-GE' || !canTranslate()) return movies;
  const strings = [];
  for (const m of movies) { if (m.title) strings.push(m.title); if (m.overview) strings.push(m.overview); }
  const map = await translateToKa(strings);
  for (const m of movies) {
    if (m.title && map.has(m.title)) m.title = map.get(m.title);
    if (m.overview && map.has(m.overview)) m.overview = map.get(m.overview);
  }
  return movies;
}

/* TMDB serves 20 results per page. The drill-down grid (top-nav TV Shows / Movies /
   New & Popular, and search) felt thin at 20 cards, so each logical page bundles a few
   consecutive TMDB pages into one response (≥50 cards) and rescales totalPages so the
   "Load more" button still walks the real catalog. makeReq(tmdbPage) -> TMDB response. */
const PAGE_BUNDLE = 3;   // 3 × 20 = 60 results per logical page
async function fetchBundle(logicalPage, makeReq) {
  const lp = Math.max(1, parseInt(logicalPage, 10) || 1);
  const first = (lp - 1) * PAGE_BUNDLE + 1;
  const nums = Array.from({ length: PAGE_BUNDLE }, (_, i) => first + i);
  const parts = await Promise.all(nums.map(p => makeReq(p).catch(() => null)));
  const tmdbTotal = Math.min(500, parts.find(Boolean)?.total_pages || 1);
  const results = [], seen = new Set();
  for (const d of parts) {
    if (!d) continue;
    for (const m of (d.results || [])) {
      const k = (m.media_type || '') + ':' + m.id;
      if (seen.has(k)) continue; seen.add(k);
      results.push(m);
    }
  }
  return { results, totalPages: Math.max(1, Math.ceil(tmdbTotal / PAGE_BUNDLE)) };
}

/* ------------------------------------------------------------------ *
 *  IMDb-availability gate for catalog/search/browse results
 *
 *  TMDB's discover/search feeds don't carry IMDb ids — those only surface from a
 *  per-title external_ids lookup (the same one /api/meta runs). Installed stream
 *  add-ons are queried by IMDb id, so a card with no IMDb id can never resolve a
 *  real stream and would dead-end on the "Showing demo streams" notice. We resolve
 *  the IMDb id for each result and drop the ones TMDB has none for, so such titles
 *  never reach the catalog rows, the drill-down grid, or search results.
 *
 *  IMDb ids are immutable, so the verdict is cached forever (a null means "TMDB
 *  has no IMDb id for this title" and is cached too, so a missing title isn't
 *  re-fetched on every page). The resolved id is also attached to the surviving
 *  card as `imdb`. */
const imdbCache = new Map();            // `${type}:${id}` -> imdb tt… | null
async function resolveImdb(id, type) {
  const key = (type === 'tv' ? 'tv' : 'movie') + ':' + id;
  if (imdbCache.has(key)) return imdbCache.get(key);
  let imdb = null;
  try {
    const data = await tmdb(`/${type === 'tv' ? 'tv' : 'movie'}/${id}/external_ids`);
    imdb = (data && typeof data.imdb_id === 'string' && /^tt\d+$/.test(data.imdb_id)) ? data.imdb_id : null;
    imdbCache.set(key, imdb);           // cache the verdict (including null) — ids never change
  } catch {
    return null;                        // transient failure: don't cache, keep the card out this time
  }
  return imdb;
}
// Drop every mapped card whose title has no IMDb id; attach the id to survivors.
async function gateByImdb(items) {
  const ids = await mapLimit(items, 8, (m) => resolveImdb(m.id, m.type));
  const kept = [];
  for (let i = 0; i < items.length; i++) { if (ids[i]) { items[i].imdb = ids[i]; kept.push(items[i]); } }
  return kept;
}

/* ------------------------------------------------------------------ *
 *  Catalog / search / meta
 * ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
  res.json({ tmdb: HAS_TMDB, source: HAS_TMDB ? 'TMDB' : 'mock' });
});

app.get('/api/catalog', async (req, res) => {
  try {
    await loadGenres();
    const { genre, year, yearGte, ratingGte, page = 1 } = req.query;
    const isTv = req.query.type === 'tv';            // Series filter → /discover/tv
    const tlang = tmdbLang(req);
    const lng = coverLang(req);
    // Movie and TV discover share the same shape but key their date/genre params
    // differently, so build the right param set for the requested media type.
    const params = isTv ? {
      include_adult: false,
      language: tlang,
      sort_by: 'popularity.desc',
      page,
      with_genres: genreNameToId(genre, 'tv'),
      first_air_date_year: year,
      'first_air_date.gte': /^\d{4}$/.test(yearGte) ? `${yearGte}-01-01` : undefined,
      'vote_average.gte': ratingGte,
      'vote_count.gte': 50,
    } : {
      include_adult: false,
      language: tlang,
      sort_by: 'popularity.desc',
      page,
      with_genres: genreNameToId(genre),
      primary_release_year: year,
      'primary_release_date.gte': /^\d{4}$/.test(yearGte) ? `${yearGte}-01-01` : undefined,
      'vote_average.gte': ratingGte,
      'vote_count.gte': 50, // keep obscure no-vote entries out
    };
    const path = isTv ? '/discover/tv' : '/discover/movie';
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const bundle = await fetchBundle(pageNum, p => tmdb(path, { ...params, page: p }));
    // Drop titles with no IMDb id (installed stream addons can't be queried for them)
    // before any translation work, so the wasted cost never lands on hidden cards.
    const mapped = await gateByImdb(bundle.results.map(m => mapMovie(m, lng, isTv ? 'tv' : 'movie')));
    // The hero plot reads `overview`; on the Georgian site TMDB leaves it blank for
    // most titles, so backfill from English and let localizeMovies translate it.
    await backfillOverviews(mapped, tlang,
      () => fetchBundle(pageNum, p => tmdb(path, { ...params, page: p, language: 'en-US' })).then(b => b.results));
    const results = await localizeMovies(mapped, tlang);
    res.json({
      source: 'TMDB',
      page: pageNum,
      totalPages: bundle.totalPages,
      results,
    });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/search', async (req, res) => {
  try {
    await loadGenres();
    const q = String(req.query.q || '').slice(0, 100);
    const page = req.query.page || 1;
    // ?type= scopes the search: 'movie' / 'tv' hit the typed endpoints; anything
    // else (default) uses /search/multi so a query like "the boys" returns the TV
    // show AND any movie of the same name in one popularity-ranked list. The old
    // movie-only endpoint silently dropped every series — this is the core fix.
    const type = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : 'all';
    if (!q.trim()) return res.json({ source: 'TMDB', results: [] });
    const tlang = tmdbLang(req), lng = coverLang(req);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    let raw, bundle;
    if (type === 'movie') {
      bundle = await fetchBundle(pageNum, p => tmdb('/search/movie', { query: q, page: p, include_adult: false, language: tlang }));
      raw = bundle.results.map(m => mapMovie(m, lng, 'movie'));
    } else if (type === 'tv') {
      bundle = await fetchBundle(pageNum, p => tmdb('/search/tv', { query: q, page: p, include_adult: false, language: tlang }));
      raw = bundle.results.map(m => mapMovie(m, lng, 'tv'));
    } else {
      bundle = await fetchBundle(pageNum, p => tmdb('/search/multi', { query: q, page: p, include_adult: false, language: tlang }));
      // multi mixes in people — keep only titles, mapped with their own media type.
      raw = bundle.results
        .filter(m => m.media_type === 'movie' || m.media_type === 'tv')
        .map(m => mapMovie(m, lng, m.media_type));
    }
    // Hide results with no IMDb id — installed stream addons can't be queried for them.
    raw = await gateByImdb(raw);
    const results = await localizeMovies(raw, tlang);
    res.json({ source: 'TMDB', page: pageNum, totalPages: bundle.totalPages, results });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/meta/:id', async (req, res) => {
  try {
    await loadGenres();
    // TV / anime detail (numeric id + ?type=tv). Movies fall through to the
    // existing path below (which also resolves IMDb ids from addon catalogs).
    if (String(req.query.type) === 'tv' && /^\d+$/.test(req.params.id)) {
      return await sendTvMeta(req, res);
    }
    let tmdbId = req.params.id;
    const imdbInput = /^tt\d+$/.test(req.params.id) ? req.params.id : null;
    if (imdbInput) {
      // addon-catalog items arrive as IMDb ids → resolve to a TMDB movie
      const found = await tmdb(`/find/${imdbInput}`, { external_source: 'imdb_id' });
      const hit = (found.movie_results || [])[0];
      if (!hit) return res.status(404).json({ error: 'Title not found on TMDB' });
      tmdbId = hit.id;
    }
    const lang = tmdbLang(req);
    const m = await tmdb(`/movie/${tmdbId}`, { language: lang, append_to_response: 'credits,videos,external_ids,images', include_image_language: 'ka,en,null' });
    const base = mapMovie(m, coverLang(req));
    const titleLogo = await resolveLogo(String(m.id), 'movie', coverLang(req), m.images);
    const trailer = pickTrailer(m.videos);
    // Georgian (or any non-English) detail pages often have an empty synopsis —
    // TMDB returns "" rather than the English text. Backfill plot/tagline from
    // the English record so the modal never shows a blank synopsis.
    let plot = m.overview || '';
    let tagline = m.tagline || '';
    if (lang !== 'en-US' && (!plot || !tagline)) {
      try {
        const en = await tmdb(`/movie/${tmdbId}`, { language: 'en-US' });
        if (!plot) plot = en.overview || '';
        if (!tagline) tagline = en.tagline || '';
      } catch { /* keep whatever we have */ }
    }
    // machine-translate any English title/plot/tagline that TMDB had no Georgian for
    if (lang === 'ka-GE' && canTranslate()) {
      const map = await translateToKa([base.title, plot, tagline]);
      if (base.title && map.has(base.title)) base.title = map.get(base.title);
      if (plot && map.has(plot)) plot = map.get(plot);
      if (tagline && map.has(tagline)) tagline = map.get(tagline);
    }
    res.json({
      ...base,
      titleLogo,
      imdb: imdbInput || m.external_ids?.imdb_id || null,
      genre: (m.genres || []).map(g => (g.name === 'Science Fiction' ? 'Sci-Fi' : g.name)),
      runtime: m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : null,
      plot,
      tagline,
      cast: mapCast(m.credits),
      director: findDirector(m.credits),
      trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      trailerKey: trailer ? trailer.key : null,
    });
  } catch (e) { sendErr(res, e); }
});

/* TV / anime detail. Mirrors the movie path: native-language record, English
   backfill for an empty synopsis/tagline, optional Georgian machine-translation,
   trailer + top cast. Series episode playback isn't wired to the addon engine, so
   the client shows demo sources for TV — but the metadata is fully real. */
async function sendTvMeta(req, res) {
  const id = req.params.id;
  const lang = tmdbLang(req);
  const m = await tmdb(`/tv/${id}`, { language: lang, append_to_response: 'credits,videos,external_ids,images', include_image_language: 'ka,en,null' });
  const base = mapMovie(m, coverLang(req), 'tv');
  const titleLogo = await resolveLogo(String(m.id), 'tv', coverLang(req), m.images);
  const trailer = pickTrailer(m.videos);
  let plot = m.overview || '';
  let tagline = m.tagline || '';
  if (lang !== 'en-US' && (!plot || !tagline)) {
    try {
      const en = await tmdb(`/tv/${id}`, { language: 'en-US' });
      if (!plot) plot = en.overview || '';
      if (!tagline) tagline = en.tagline || '';
    } catch { /* keep whatever we have */ }
  }
  if (lang === 'ka-GE' && canTranslate()) {
    const map = await translateToKa([base.title, plot, tagline]);
    if (base.title && map.has(base.title)) base.title = map.get(base.title);
    if (plot && map.has(plot)) plot = map.get(plot);
    if (tagline && map.has(tagline)) tagline = map.get(tagline);
  }
  const ep = Array.isArray(m.episode_run_time) ? m.episode_run_time[0] : null;
  res.json({
    ...base,
    titleLogo,
    imdb: m.external_ids?.imdb_id || null,
    genre: (m.genres || []).map(g => (g.name === 'Science Fiction' ? 'Sci-Fi' : g.name)),
    runtime: ep ? `${ep}m` : null,
    seasons: m.number_of_seasons || null,
    // Per-season list for the modal chooser. Drop empty seasons; keep "Specials"
    // (season 0) only when it actually has episodes.
    seasonList: (m.seasons || [])
      .filter(s => (s.episode_count || 0) > 0)
      .map(s => ({ season: s.season_number, episodes: s.episode_count, name: s.name || `Season ${s.season_number}` })),
    plot,
    tagline,
    cast: mapCast(m.credits),
    // TV has no single "director"; surface the creator(s) instead and expose a
    // `director` alias (first creator) so the client can use one label for both.
    creators: (m.created_by || []).map(c => ({ name: c.name, profile: c.profile_path ? IMGFACE + c.profile_path : null })),
    director: findDirector(m.credits) || ((m.created_by || [])[0] && m.created_by[0].name) || null,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    trailerKey: trailer ? trailer.key : null,
  });
}

/* Episode list for one season of a TV/anime title. Powers the modal's
   season+episode chooser. Lazy-loaded per season (the modal fetches a season
   only when the user opens its tab). Native-language episode names/overviews
   with optional Georgian machine-translation, mirroring sendTvMeta. */
app.get('/api/tv/:id/season/:n', async (req, res) => {
  try {
    const id = req.params.id;
    const n = parseInt(req.params.n, 10);
    if (!/^\d+$/.test(id) || !Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'Bad season request' });
    }
    const lang = tmdbLang(req);
    const s = await tmdb(`/tv/${id}/season/${n}`, { language: lang });
    let eps = (s.episodes || []).map(e => ({
      episode: e.episode_number,
      name: e.name || '',
      overview: e.overview || '',
      air_date: e.air_date || null,
      runtime: e.runtime ? `${e.runtime}m` : null,
      still: e.still_path ? IMGSTILL + e.still_path : null,
    }));
    // Backfill empty Georgian names/overviews from English, then translate gaps.
    if (lang === 'ka-GE') {
      try {
        const en = await tmdb(`/tv/${id}/season/${n}`, { language: 'en-US' });
        const byNum = new Map((en.episodes || []).map(e => [e.episode_number, e]));
        eps = eps.map(e => {
          const src = byNum.get(e.episode) || {};
          return { ...e, name: e.name || src.name || '', overview: e.overview || src.overview || '' };
        });
      } catch { /* keep whatever the ka record gave us */ }
      if (canTranslate()) {
        const strings = [];
        for (const e of eps) { if (e.name) strings.push(e.name); if (e.overview) strings.push(e.overview); }
        const map = await translateToKa(strings);
        eps = eps.map(e => ({
          ...e,
          name: e.name && map.has(e.name) ? map.get(e.name) : e.name,
          overview: e.overview && map.has(e.overview) ? map.get(e.overview) : e.overview,
        }));
      }
    }
    res.json({ season: n, name: s.name || `Season ${n}`, episodes: eps });
  } catch (e) { sendErr(res, e); }
});

/* ------------------------------------------------------------------ *
 *  IntroDB — community intro/outro skip markers (https://introdb.app)
 *
 *  The public API only sends an Access-Control-Allow-Origin for its own
 *  site, so the browser can't call it cross-origin — we proxy it here.
 *  Keyed by IMDb id + season + episode; markers are stable, so we cache
 *  the verdict for a day. The upstream `intro`/`outro` blocks carry
 *  start_sec/end_sec (or null when nobody has submitted that segment);
 *  we hand the client a slim { intro, outro } of {start,end} seconds. */
const INTRODB_CACHE = new Map();             // `tt…:s:e` -> { data, exp }
const INTRODB_TTL = 24 * 60 * 60 * 1000;     // 24h — submissions change rarely
const INTRODB_CACHE_MAX = 2000;
app.get('/api/introdb/:imdb/:season/:episode', async (req, res) => {
  const { imdb, season, episode } = req.params;
  if (!/^tt\d+$/.test(imdb) || !/^\d+$/.test(season) || !/^\d+$/.test(episode)) {
    return res.status(400).json({ error: 'Bad introdb request' });
  }
  const key = `${imdb}:${season}:${episode}`;
  const hit = INTRODB_CACHE.get(key);
  if (hit && hit.exp > Date.now()) return res.json(hit.data);
  const seg = (s) => (s && Number.isFinite(s.start_sec) && Number.isFinite(s.end_sec) && s.end_sec > s.start_sec)
    ? { start: s.start_sec, end: s.end_sec } : null;
  let out = { intro: null, outro: null };
  try {
    const url = `https://api.introdb.app/segments?imdb_id=${imdb}&season=${season}&episode=${episode}`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); out = { intro: seg(j.intro), outro: seg(j.outro) }; }
  } catch { /* network/transient: serve empty, don't cache the failure */ }
  // Only cache hits — a transient empty result shouldn't mask data that lands later.
  if (out.intro || out.outro) {
    if (INTRODB_CACHE.size >= INTRODB_CACHE_MAX) INTRODB_CACHE.delete(INTRODB_CACHE.keys().next().value);
    INTRODB_CACHE.set(key, { data: out, exp: Date.now() + INTRODB_TTL });
  }
  res.json(out);
});

app.get('/api/genres', async (req, res) => {
  try { await loadGenres(); res.json({ genres: Object.values(GENRE_BY_ID || {}) }); }
  catch (e) { sendErr(res, e); }
});

/* ------------------------------------------------------------------ *
 *  Categorised browse — trending / top-rated / anime / studio
 *
 *  One endpoint backs both the home rows (page 1) and their paginated
 *  drill-down grids (page N). Movies and TV share mapMovie() — it already
 *  falls back to name/first_air_date — and carry a `type` so the client
 *  opens the right detail lookup.
 * ------------------------------------------------------------------ */
// Studio → TMDB company id list (pipe = OR). Each list was resolved and verified
// against the live TMDB catalog so a card opens the brand's real, recognisable
// filmography: Sony = Columbia(5)|Sony(34), Fox = classic(25)|20th Century
// Studios(127928), DC = DC(429)|DC Entertainment(9993)|DC Films(128064), and
// DreamWorks spans Animation(521)|Pictures(7).
const STUDIO_COMPANIES = {
  marvel: '420', dreamworks: '521|7', pixar: '3', warner: '174',
  dc: '429|9993|128064', sony: '5|34', universal: '33', disney: '2',
  fox: '25|127928', paramount: '4',
};

// The home "Upcoming Movies & Series" marquee shows only the N most-anticipated
// future-dated titles per row; released titles drop out and the next most-wanted
// fills the slot. Kept small so the section reads as a tight, curated radar.
const UPCOMING_LIMIT = 10;

/* Resolve a category key to a TMDB request. "Trending" uses the native trending
   feeds (TMDB's own relevance order); "Top rated" uses discover sorted by score
   with a vote-count floor so a single 10/10 vote can't top the list; "Anime" is
   Japanese-origin animation (genre 16 + origin JP). */
async function fetchCategory(cat, page, tlang, full) {
  // A feed served to the drill-down grid (full=true) bundles several TMDB pages for a
  // fuller screen; the home rails (full=false) keep their single 20-item page.
  const feed = async (type, path, extra = {}) => {
    if (full) {
      const b = await fetchBundle(page, p => tmdb(path, { page: p, language: tlang, ...extra }));
      return { type, d: { results: b.results, total_pages: b.totalPages } };
    }
    return { type, d: await tmdb(path, { page, language: tlang, ...extra }) };
  };
  switch (cat) {
    case 'upcoming_movie': {
      // Page 1 of TMDB's "upcoming" feed is mostly films already in theatres, so
      // few survive the strictly-future filter. Pull several pages and merge so the
      // marquee has a healthy pool of genuinely unreleased titles.
      const pages = await Promise.all([1, 2, 3, 4, 5].map(p =>
        tmdb('/movie/upcoming', { page: p, language: tlang }).catch(() => ({ results: [] }))));
      const results = [], seen = new Set();
      for (const pg of pages) for (const m of (pg.results || [])) {
        if (seen.has(m.id)) continue; seen.add(m.id); results.push(m);
      }
      return { type: 'movie', d: { results, total_pages: 1 } };
    }
    case 'upcoming_series': {
      // TMDB has no native "upcoming TV" feed (unlike /movie/upcoming), so discover
      // shows whose first air date is still in the future, most-anticipated first —
      // popularity carries the pre-release buzz. Mirrors the upcoming-movies marquee.
      const today = new Date().toISOString().slice(0, 10);
      return { type: 'tv', d: await tmdb('/discover/tv', { page, language: tlang, 'first_air_date.gte': today, sort_by: 'popularity.desc', include_adult: false }) };
    }
    case 'trending_movie': return feed('movie', '/trending/movie/week');
    case 'trending_tv':    return feed('tv',    '/trending/tv/week');
    case 'top_movie':      return feed('movie', '/discover/movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 2000, include_adult: false });
    case 'top_tv':         return feed('tv',    '/discover/tv',    { sort_by: 'vote_average.desc', 'vote_count.gte': 800 });
    case 'trending_anime': return feed('tv',    '/discover/tv', { with_genres: 16, with_origin_country: 'JP', sort_by: 'popularity.desc', 'vote_count.gte': 50, include_adult: false });
    case 'top_anime':      return feed('tv',    '/discover/tv', { with_genres: 16, with_origin_country: 'JP', sort_by: 'vote_average.desc', 'vote_count.gte': 200, include_adult: false });
    default: return null;
  }
}

/* Studio drill-down: build ONE globally rating-ranked pool of the studio's movies
   AND shows, then page over that pool. Paging the two TMDB lists in lockstep and
   merging per-page only sorted each 40-item window, so a high-rated film on page 2
   could appear below a lower-rated show from page 1. Instead we pull a bounded pool
   from each type once, merge + dedupe + sort by rating, cache it (catalogs are
   stable), and slice — so the grid is monotonically descending across every page
   and totalPages reflects the real merged length. */
const STUDIO_PAGE = 20;
const STUDIO_PAGE_FULL = 50;   // drill-down grid wants a fuller page (matches PAGE_BUNDLE feel)
const studioPoolCache = new Map();   // `${studio}|${tlang}` -> rating-sorted [{m,type}]
async function fetchStudio(studio, page, tlang, full) {
  // Own-property check: a plain object inherits truthy members (constructor,
  // toString, __proto__…), so a bare `STUDIO_COMPANIES[studio]` lookup would let
  // ?studio=constructor slip past the guard. hasOwnProperty closes that.
  if (!Object.prototype.hasOwnProperty.call(STUDIO_COMPANIES, studio)) return null;
  const companies = STUDIO_COMPANIES[studio];
  const cacheKey = studio + '|' + tlang;
  let pool = studioPoolCache.get(cacheKey);
  if (!pool) {
    const base = { with_companies: companies, sort_by: 'vote_average.desc', language: tlang };
    const empty = { results: [] };
    const MOVIE_PAGES = 5, TV_PAGES = 3;   // bounded pool (≤160 titles) — plenty for a drill-down
    const reqs = [];
    for (let p = 1; p <= MOVIE_PAGES; p++)
      reqs.push(tmdb('/discover/movie', { ...base, page: p, 'vote_count.gte': 100, include_adult: false }).then(d => ({ d, type: 'movie' })).catch(() => ({ d: empty, type: 'movie' })));
    for (let p = 1; p <= TV_PAGES; p++)
      reqs.push(tmdb('/discover/tv', { ...base, page: p, 'vote_count.gte': 40 }).then(d => ({ d, type: 'tv' })).catch(() => ({ d: empty, type: 'tv' })));
    const parts = await Promise.all(reqs);
    const seen = new Set();
    pool = [];
    for (const { d, type } of parts) for (const m of (d.results || [])) {
      const k = type + ':' + m.id; if (seen.has(k)) continue; seen.add(k);
      pool.push({ m, type });
    }
    pool.sort((a, b) => (b.m.vote_average || 0) - (a.m.vote_average || 0));
    studioPoolCache.set(cacheKey, pool);
  }
  const size = full ? STUDIO_PAGE_FULL : STUDIO_PAGE;
  const totalPages = Math.max(1, Math.ceil(pool.length / size));
  const start = (page - 1) * size;
  return { items: pool.slice(start, start + size), totalPages };
}

/* Streaming-service rows (Netflix, Disney+, …). Each maps to a TMDB watch-provider
   id; the row is a discover feed gated to titles on that provider's flatrate
   (subscription) tier in PROVIDER_REGION. Like the studio rows, a row merges the
   service's movies AND shows into one popularity-ranked pool so the rail mirrors
   "what's on Netflix right now". watch-provider availability is region-scoped, so
   the catalog is resolved against a single region (US has the broadest coverage). */
const PROVIDERS = {
  netflix:     8,
  disney:      337,    // Disney Plus
  prime:       9,      // Amazon Prime Video
  apple:       350,    // Apple TV+
  max:         1899,   // Max (formerly HBO Max)
  paramount:   '2303|2616|531',   // Paramount+ Premium | Essential | legacy (pipe = OR)
  crunchyroll: 283,
};
const PROVIDER_REGION = 'US';
const providerPoolCache = new Map();   // `${prov}|${tlang}` -> popularity-sorted [{m,type}]
async function fetchProvider(prov, page, tlang, full) {
  // Own-property guard (same reasoning as fetchStudio): block inherited keys like
  // ?prov_constructor from reaching the lookup.
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, prov)) return null;
  const id = PROVIDERS[prov];
  const cacheKey = prov + '|' + tlang;
  let pool = providerPoolCache.get(cacheKey);
  if (!pool) {
    const base = {
      with_watch_providers: id, watch_region: PROVIDER_REGION,
      with_watch_monetization_types: 'flatrate',
      sort_by: 'popularity.desc', language: tlang,
    };
    const empty = { results: [] };
    const MOVIE_PAGES = 3, TV_PAGES = 3;   // bounded merged pool — plenty for a rail + drill-down
    const reqs = [];
    for (let p = 1; p <= MOVIE_PAGES; p++)
      reqs.push(tmdb('/discover/movie', { ...base, page: p, 'vote_count.gte': 50, include_adult: false }).then(d => ({ d, type: 'movie' })).catch(() => ({ d: empty, type: 'movie' })));
    for (let p = 1; p <= TV_PAGES; p++)
      reqs.push(tmdb('/discover/tv', { ...base, page: p, 'vote_count.gte': 20 }).then(d => ({ d, type: 'tv' })).catch(() => ({ d: empty, type: 'tv' })));
    const parts = await Promise.all(reqs);
    const seen = new Set();
    pool = [];
    for (const { d, type } of parts) for (const m of (d.results || [])) {
      const k = type + ':' + m.id; if (seen.has(k)) continue; seen.add(k);
      pool.push({ m, type });
    }
    pool.sort((a, b) => (b.m.popularity || 0) - (a.m.popularity || 0));
    providerPoolCache.set(cacheKey, pool);
  }
  const size = full ? STUDIO_PAGE_FULL : STUDIO_PAGE;
  const totalPages = Math.max(1, Math.ceil(pool.length / size));
  const start = (page - 1) * size;
  return { items: pool.slice(start, start + size), totalPages };
}

/* Translate only the card titles to Georgian. Cards never render the overview, so
   skipping it roughly halves the translation load when six home rows paint at once. */
async function localizeTitles(items, lang) {
  if (lang !== 'ka-GE' || !canTranslate()) return items;
  const map = await translateToKa(items.map(m => m.title).filter(Boolean));
  for (const m of items) if (m.title && map.has(m.title)) m.title = map.get(m.title);
  return items;
}

app.get('/api/browse', async (req, res) => {
  try {
    await loadGenres();
    const cat = String(req.query.cat || '');
    const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
    const tlang = tmdbLang(req);
    const lng = coverLang(req);
    // The drill-down grid sends &full=1 to ask for a fuller page (≥50 cards); the home
    // rails omit it and keep their single 20-item page.
    const full = req.query.full === '1' || req.query.full === 'true';
    if (cat === 'studio') {
      const out = await fetchStudio(String(req.query.studio || ''), page, tlang, full);
      if (!out) return res.status(404).json({ error: 'Unknown studio' });
      const gated = await gateByImdb(out.items.map(({ m, type }) => mapMovie(m, lng, type)));
      const results = await localizeTitles(gated, tlang);
      return res.json({ source: 'TMDB', cat, page, totalPages: out.totalPages, results });
    }
    if (cat.startsWith('prov_')) {
      // Streaming-service rows merge movies + shows into one pool, like studios.
      const out = await fetchProvider(cat.slice(5), page, tlang, full);
      if (!out) return res.status(404).json({ error: 'Unknown provider' });
      const gated = await gateByImdb(out.items.map(({ m, type }) => mapMovie(m, lng, type)));
      const results = await localizeTitles(gated, tlang);
      return res.json({ source: 'TMDB', cat, page, totalPages: out.totalPages, results });
    }
    const out = await fetchCategory(cat, page, tlang, full);
    if (!out) return res.status(400).json({ error: 'Unknown category' });
    let raw = out.d.results || [];
    let upcomingPages = Math.min(500, out.d.total_pages || 1);
    if (cat === 'upcoming_movie') {
      // TMDB's "upcoming" feed bleeds in a few films already in theatres; keep only
      // genuinely unreleased titles, comparing on the full release_date (not year).
      const today = new Date().toISOString().slice(0, 10);
      raw = raw.filter(m => m.release_date && m.release_date > today);
    }
    if (cat === 'upcoming_movie' || cat === 'upcoming_series') {
      // The home "Upcoming Movies & Series" marquee is a curated top-10 of the
      // MOST ANTICIPATED titles (popularity carries the pre-release buzz). Sort by
      // popularity and keep only the 10 with art, so the marquee shows a tight,
      // hand-picked-feeling set. This list is self-refreshing: once a title's
      // release/air date passes it falls out of the future-dated feed above and the
      // next most-wanted title automatically takes its slot (TMDB cache TTL bounds
      // the lag to a few minutes).
      raw = raw
        .filter(m => m.poster_path || m.backdrop_path)
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .slice(0, UPCOMING_LIMIT);
      upcomingPages = 1;
    }
    const isUpcoming = cat === 'upcoming_movie' || cat === 'upcoming_series';
    let mapped = raw.map(m => mapMovie(m, lng, out.type));
    // Drop titles with no IMDb id from the streamable rows (the drill-down grid and
    // home rails). The "Upcoming" marquee is exempt: those are future titles shown as
    // a coming-soon radar, not meant to resolve streams yet.
    if (!isUpcoming) mapped = await gateByImdb(mapped);
    const results = await localizeTitles(mapped, tlang);
    if (isUpcoming) {
      // attach the stylised title-logo per card (bounded concurrency; disk-cached)
      await mapLimit(results, 6, async (r) => { r.titleLogo = await resolveLogo(r.id, r.type, lng, null); });
    }
    res.json({ source: 'TMDB', cat, page, totalPages: upcomingPages, results });
  } catch (e) { sendErr(res, e); }
});

/* ------------------------------------------------------------------ *
 *  Featured hero — the big rotating banner on the home page.
 *
 *  The SELECTION is shared across both languages (stored once in
 *  settings.hero, written from the admin console); only the localisation
 *  differs per request. Two modes:
 *    • auto   (default) — this week's Trending Movies, exactly the titles
 *                         that lead the home page.
 *    • manual           — an admin-curated, ordered list of movies AND
 *                         series, hand-picked in the admin "Hero" tab.
 *  A manual mode with an empty list degrades gracefully back to auto.
 * ------------------------------------------------------------------ */
const HERO_MAX = 8;
async function heroConfig() {
  const s = await readSettings().catch(() => ({}));
  const h = s.hero || {};
  const items = (Array.isArray(h.items) ? h.items : [])
    .filter(it => it && /^\d+$/.test(String(it.id)))
    .map(it => ({ id: String(it.id), type: it.type === 'tv' ? 'tv' : 'movie',
      bg: (typeof it.bg === 'string' && covers.isValidPosterUrl(it.bg)) ? it.bg : '' }))
    .slice(0, HERO_MAX);
  return { mode: h.mode === 'manual' ? 'manual' : 'auto', items };
}
// fetch one chosen title's detail (movie or tv) for the hero, in `lang`
const heroDetail = (it, lang) => tmdb(`/${it.type}/${it.id}`, { language: lang }).catch(() => null);

/* Curated hero backgrounds are admin-uploaded to image hosts (ImgBB), and those
 * links rot: once a guest upload expires the host answers 403 with a tiny "this
 * content requires registration" placeholder, which the browser would otherwise
 * paint as the hero background. So before letting a curated bg OVERRIDE the title's
 * reliable TMDB backdrop, verify it still resolves to a real image — a 200 with an
 * image content-type and a size well above the placeholder's ~3 KB. We read only
 * the headers (the body is cancelled, so a 3 MB upload isn't downloaded just to
 * validate) and cache the verdict for an hour, so a live hero costs no extra
 * fetches after warmup and a dead link self-heals the moment it's re-uploaded. */
const bgVerdict = new Map();        // url -> { ok, exp }
const BG_TTL = 60 * 60 * 1000;      // re-check each curated bg at most hourly
const BG_MIN_BYTES = 20000;         // host placeholder is ~3 KB; real hero art is far larger
async function bgIsReal(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  const hit = bgVerdict.get(url);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(url, { headers: { accept: 'image/*' } });
    const ct = r.headers.get('content-type') || '';
    const len = Number(r.headers.get('content-length') || 0);
    ok = r.ok && ct.startsWith('image/') && len >= BG_MIN_BYTES;
    try { await r.body?.cancel(); } catch { /* nothing to drain */ }
  } catch { ok = false; }
  bgVerdict.set(url, { ok, exp: Date.now() + BG_TTL });
  return ok;
}

app.get('/api/hero', async (req, res) => {
  try {
    await loadGenres();
    const tlang = tmdbLang(req);
    const lng = coverLang(req);
    const cfg = await heroConfig();
    let mapped;
    if (cfg.mode === 'manual' && cfg.items.length) {
      // resolve each curated title in parallel, preserving the admin's order
      const details = await Promise.all(cfg.items.map(it => heroDetail(it, tlang)));
      mapped = cfg.items.map((it, i) => {
        if (!details[i]) return null;
        const mm = mapMovie(details[i], lng, it.type);
        mm._bg = it.bg || '';   // candidate override, validated below
        return mm;
      }).filter(Boolean);
      // A curated background only wins over the TMDB backdrop if it's still a live
      // image; a dead/expired upload silently keeps the reliable TMDB art instead
      // of painting the host's placeholder. (Validation is cached, so this is cheap.)
      await Promise.all(mapped.map(async mm => {
        if (mm._bg && await bgIsReal(mm._bg)) mm.backdrop = mm._bg;
        delete mm._bg;
      }));
      // Georgian detail often has a blank synopsis — backfill from English so the
      // hero plot is a real (translatable) sentence, not the generic placeholder.
      await backfillOverviews(mapped, tlang, async () =>
        (await Promise.all(cfg.items.map(it => heroDetail(it, 'en-US')))).filter(Boolean));
    } else {
      // auto: this week's trending movies (mirrors the home's first row)
      const d = await tmdb('/trending/movie/week', { page: 1, language: tlang });
      mapped = (d.results || []).map(m => mapMovie(m, lng, 'movie'));
      await backfillOverviews(mapped, tlang,
        () => tmdb('/trending/movie/week', { page: 1, language: 'en-US' }).then(x => x.results));
    }
    const results = await localizeMovies(mapped, tlang);
    // Attach the TMDB title-logo (or admin override) per slide so the hero shows
    // the stylised wordmark instead of plain text. Cached on disk, so this is a
    // one-time cost per title; bounded concurrency keeps a cold cache gentle.
    await mapLimit(results, 6, async (r) => { r.titleLogo = await resolveLogo(r.id, r.type, lng, null); });
    res.json({ source: 'TMDB', mode: cfg.mode, results });
  } catch (e) { sendErr(res, e); }
});

/* ------------------------------------------------------------------ *
 *  Addon engine — install by manifest URL (Stremio-style)
 * ------------------------------------------------------------------ */
async function readAddons() {
  if (storage.dbEnabled) {
    try { return await storage.readDoc(ADDONS_FILE, []); } catch { return []; }
  }
  if (!existsSync(ADDONS_FILE)) return [];
  try { return JSON.parse(await readFile(ADDONS_FILE, 'utf8')); }
  catch { return []; }
}
async function writeAddons(list) {
  if (storage.dbEnabled) return storage.writeDoc(ADDONS_FILE, list);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ADDONS_FILE, JSON.stringify(list, null, 2));
}
function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'Manifest is not a JSON object';
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,200}$/i.test(m.id)) return 'Manifest "id" is missing or malformed';
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 200) return 'Manifest "name" is missing or too long';
  if (!Array.isArray(m.resources) || m.resources.length === 0) return 'Manifest missing "resources"';
  if (!Array.isArray(m.types) || m.types.length === 0) return 'Manifest missing "types"';
  return null;
}

/* SSRF mitigation: block loopback / private / link-local hosts for the server-side
 * fetches that take a user-supplied URL (addon install + subtitle proxy). Real
 * Stremio addons live on public hosts, so this doesn't break them. Note: it matches
 * the literal hostname and does NOT resolve DNS, so it is a mitigation — not a
 * complete defense against DNS-rebinding — appropriate for this localhost app. */
function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata (169.254.169.254)
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true; // IPv6 ULA / link-local
  // IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1, which Node serialises to ::ffff:7f00:1) —
  // decode the embedded IPv4 and re-check it so the mapping can't smuggle a private host
  const m6 = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m6) { const hi = parseInt(m6[1], 16), lo = parseInt(m6[2], 16);
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  const m6d = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (m6d) return isPrivateHost(m6d[1]);
  return false;
}
/* Hosts explicitly trusted for server-side addon/subtitle fetches even though they
 * are loopback/private — for running an addon on the same machine during development.
 * Comma-separated list of host or host:port, e.g. ADDON_HOST_ALLOWLIST=localhost:7000.
 * Empty by default, so the SSRF guard above stays fully in force in production. */
const ADDON_HOST_ALLOWLIST = new Set(
  (process.env.ADDON_HOST_ALLOWLIST || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
function isSafeFetchUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ADDON_HOST_ALLOWLIST.has(u.host) || ADDON_HOST_ALLOWLIST.has(u.hostname)) return true;
  return !isPrivateHost(u.hostname);
}

/* ------------------------------------------------------------------ *
 *  Stremio addon protocol helpers
 *  Resource URLs are relative to the directory holding manifest.json:
 *    https://host/manifest.json          → base https://host/
 *    https://host/cfg=1/manifest.json    → base https://host/cfg=1/
 * ------------------------------------------------------------------ */
function addonBase(manifestUrl) {
  return manifestUrl.replace(/[^/]*$/, ''); // drop last path segment, keep trailing slash
}
async function fetchAddonResource(base, path) {
  if (!isSafeFetchUrl(base)) throw Object.assign(new Error('Addon host not allowed'), { status: 400 });
  const r = await fetch(base + path, {
    headers: { accept: 'application/json' },
    // 20s (was 10s): a split-deployed addon on a free host can be slow right after
    // waking, or take a moment on a heavy title. A keep-warm pinger prevents full
    // cold starts; this just stops a warm-but-slow scrape from being cut short.
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Object.assign(new Error(`Addon responded ${r.status}`), { status: r.status });
  return r.json();
}
// Torrentio source-selection tuning, applied server-side so every user benefits without
// re-installing a configured addon: sort by quality→size (with debrid, seed count is
// irrelevant — the file is served from TorBox), and drop cam/screener/unknown junk that
// never plays well. NO debrid key goes in this URL — the key stays server-side and cache
// status is checked separately via the TorBox API. streamBasesFor() pairs this configured
// base with the plain base as a fallback (see the per-addon loop).
const TORRENTIO_OPTS = 'sort=qualitysize|qualityfilter=cam,scr,unknown';
function streamBasesFor(a) {
  const plain = addonBase(a.url);
  const id = a?.manifest?.id || a?.id;
  if (id === 'com.stremio.torrentio.addon' && /(^|\/\/)([^/]*\.)?torrentio\.strem\.fun\//i.test(plain)) {
    const configured = plain.replace(/\/$/, '') + '/' + TORRENTIO_OPTS + '/';
    return [configured, plain];
  }
  return [plain];
}

const MAGNET_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];
function buildMagnet(infoHash, name) {
  const dn = name ? '&dn=' + encodeURIComponent(name) : '';
  const tr = MAGNET_TRACKERS.map(t => '&tr=' + encodeURIComponent(t)).join('');
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}${dn}${tr}`;
}
function detectQuality(text = '') {
  const t = text.toLowerCase();
  if (/(2160|\b4k\b|uhd)/.test(t)) return '4K';
  if (/1080/.test(t)) return '1080p';
  if (/720/.test(t)) return '720p';
  if (/480/.test(t)) return '480p';
  return '';
}
function extractSize(text = '') {
  const m = text.match(/(\d+(?:\.\d+)?)\s?(gb|mb)/i);
  return m ? `${m[1]} ${m[2].toUpperCase()}` : null;
}
function extractSeeds(text = '') {
  const m = text.match(/(?:👤|seeds?|seeders?)[^\d]*(\d[\d,]*)/i);
  return m ? +m[1].replace(/,/g, '') : null;
}
/* normalise a Stremio stream object into the shape the frontend renders */
function mapStream(s, addonName) {
  const label = [s.name, s.title, s.description].filter(Boolean).join(' \n ');
  const isTorrent = !!s.infoHash;
  const filename = s.behaviorHints?.filename || s.title || s.name;
  let url = s.url || (isTorrent ? buildMagnet(s.infoHash, filename) : null);
  // Addons can request that a direct file be fetched with specific headers
  // (Stremio's behaviorHints.proxyHeaders) — e.g. a Referer-gated CDN. The
  // browser can't set those, so route such streams through our same-origin
  // /api/stream-proxy, which injects the headers, follows redirects and forwards
  // Range requests. (Georgian addon → sibnet/fsst need this.)
  const proxyRef = !isTorrent && s.behaviorHints?.proxyHeaders?.request?.Referer;
  // HLS playlists (.m3u8 / .txt master / FirePlayer hls path) need an HLS-aware
  // player on the client and playlist rewriting in the proxy. The addon hints
  // streamType:'hls'; fall back to sniffing the URL.
  const isHls = !isTorrent && url &&
    (s.behaviorHints?.streamType === 'hls' || /\.(m3u8|txt)(\?|$)/i.test(url) || /\/hls\//i.test(url));
  const proxify = (u, ref, hls) => STREAM_PROXY_PATH + '?src=' + encodeURIComponent(u) +
    '&ref=' + encodeURIComponent(ref) + (hls ? '&t=hls' : '');
  // hdrezka's CDN (*.voidboost.cc) is a special case: it IP-binds its signed
  // 302 target to whoever resolves it AND blocks datacenter/Cloudflare ASNs, so
  // ANY server-side proxy (origin OR the Worker) gets a 404. But it enforces no
  // Referer and returns CORS '*', so the viewer's browser can fetch it directly:
  // the browser follows the 302 itself, binding the URL to the viewer's own IP.
  // Leave these un-proxied → they play browser-direct via <video> (CSP media-src
  // 'self' blob: https: permits it) with ZERO proxy bandwidth, instead of 404ing.
  let directHost = ''; try { directHost = new URL(url || '').hostname; } catch { /* keep '' */ }
  const playDirect = !!url && /(^|\.)voidboost\.cc$/i.test(directHost);
  // Route through the proxy (Worker in prod, same-origin in dev) when either:
  //  • the addon needs Referer-gated headers the browser can't set (proxyRef), or
  //  • it's HLS — hls.js fetches playlists/segments via XHR, which the page CSP
  //    blocks for cross-origin URLs unless the proxy host is allowed; the proxy
  //    also rewrites child URIs back through itself and adds CORS for locked CDNs.
  // Direct (non-HLS) files without proxyRef — and any playDirect host above — are
  // left as-is: they play via the <video> tag, which CSP media-src already permits.
  if (url && !playDirect && (proxyRef || isHls)) {
    url = proxify(url, proxyRef || '', isHls);
  }
  // Audio language tag → drives the modal's language tabs (GE / GB / RU):
  //  • ge.movie addon streams carry behaviorHints.lang ('ka').
  //  • torrent streams have no tag → infer from the release name (Russian if it
  //    shows Cyrillic / RUS / dub markers, otherwise treat as English original).
  let lang = s.behaviorHints?.lang || null;
  if (!lang && isTorrent) lang = detectTorrentLang(label);
  const detailText = (s.title || s.description || '').replace(/\s*\n\s*/g, ' · ').trim();
  return {
    source: addonName,
    title: (s.title || s.description || s.name || 'Stream').split('\n')[0].trim() || 'Stream',
    detail: detailText,
    quality: detectQuality(label),
    size: extractSize(label),
    seeds: extractSeeds(label),
    kind: isTorrent ? 'torrent' : (isHls ? 'hls' : 'url'),
    lang,
    // For multi-audio HLS (em.filmx.my), which audio rendition the player should
    // select for this row — so the same master plays Georgian/English/Russian.
    audioLang: s.behaviorHints?.audioLang || null,
    // Torrent infohash (lowercased) — used server-side to batch-check TorBox cache
    // status so already-cached releases (instant, never "stall, no seeds") rank first.
    infoHash: isTorrent ? String(s.infoHash || '').toLowerCase() : null,
    url,
    subtitles: Array.isArray(s.subtitles)
      ? s.subtitles.map(t => ({ url: t.url, lang: t.lang })).filter(t => t.url)
      : undefined,
  };
}
// Guess a torrent's audio language from its release name. Only treat it as Russian
// on clear markers (Cyrillic / RUS / Russian dub words) — "MULTI"/"DUAL" alone are
// too ambiguous (often Portuguese/Spanish) and would mislabel. Everything else → English.
function detectTorrentLang(text = '') {
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';                            // any Cyrillic char
  if (/\brus(sian)?\b/i.test(text)) return 'ru';
  if (/дубляж|многоголос|двухголос|на русском/i.test(text)) return 'ru';
  return 'en';
}
// Quality rank for size/quality gating of torrents (higher = better).
function qualityRank(q) {
  return q === '4K' ? 4 : q === '1080p' ? 3 : q === '720p' ? 2 : q === '480p' ? 1 : 0;
}
function sizeGB(sizeStr) {
  if (!sizeStr) return null;
  const m = String(sizeStr).match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return null;
  return /mb/i.test(m[2]) ? +m[1] / 1024 : +m[1];
}
// Score a torrent release name by how likely it is to play directly in an HTML5
// <video> (MP4 + H.264). Higher = safer. Used to surface the single most-playable
// English/Russian source instead of an MKV/HEVC one the browser can't decode.
const PLAYABLE_TAGS = /\b(x264|h\.?264|avc)\b|\bweb-?dl\b|\bweb-?rip\b|\.mp4\b|\bmp4\b/i;
const UNPLAYABLE_TAGS = /\b(x265|h\.?265|hevc|av1|10\s?bit|remux)\b|\.mkv\b|\bmkv\b|\bavi\b/i;
// Browsers decode AAC/MP3/Opus but NOT AC-3/E-AC-3/DTS/TrueHD/Atmos — those play
// VIDEO WITH NO SOUND, the exact symptom being fixed. So audio codec is weighted too.
const GOOD_AUDIO = /\b(aac|mp3|opus|vorbis)\b/i;
const BAD_AUDIO = /\b(e-?ac-?3|ac-?3|dd\+|ddp|dd5\.?1|dts(-?hd)?(-?ma)?|truehd|atmos)\b/i;
// Cam / telesync / screener = terrible video source (and usually unusable audio).
const BAD_SOURCE = /\b(telesync|hd-?ts|hd-?cam|cam-?rip|\bts\b|\bcam\b|screener|\bscr\b|workprint)\b/i;
function browserPlayScore(text = '') {
  let s = 0;
  if (/\b(yts|yify)\b/i.test(text)) s += 6;      // YTS/YIFY = MP4 + H.264 + AAC → always plays WITH sound
  if (/\.mp4\b|\bmp4\b/i.test(text)) s += 4;     // explicit MP4 container is the safest
  if (PLAYABLE_TAGS.test(text)) s += 3;          // x264/h264/web releases usually play
  if (GOOD_AUDIO.test(text)) s += 3;             // AAC/MP3 audio → sound actually works
  if (BAD_AUDIO.test(text)) s -= 4;              // AC3/EAC3/DTS/TrueHD/Atmos → silent video
  if (UNPLAYABLE_TAGS.test(text)) s -= 5;        // mkv / hevc / x265 / remux usually don't play
  if (BAD_SOURCE.test(text)) s -= 4;             // telesync / cam → avoid even if it'd "play"
  if (/\b(2160p?|4k|uhd)\b/i.test(text)) s -= 3; // 4K is almost always HEVC → won't play
  return s;
}
/* ------------------------------------------------------------------ *
 *  "Saturn" — the Georgian Dubbed addon, surfaced to the user as one card.
 *
 *  Torrentio has been retired: STREDIO no longer serves torrents, so there is
 *  no TorBox key gate anymore. The Georgian Dubbed addon now serves every audio
 *  language as a DIRECT link — ka/ru/uk dubs plus en (resolved via a self-hosted
 *  NuvioStreams instance). The only remaining per-user knob is an OPTIONAL audio-
 *  language preference (which of ka/en/ru/uk to surface); the stored config still
 *  lives in auth.js getUserSaturn/setUserSaturn.
 * ------------------------------------------------------------------ */
// Torrentio is retired — STREDIO no longer serves torrents. English now arrives as
// DIRECT links from the Georgian Dubbed addon (resolved via a self-hosted NuvioStreams
// instance) alongside its ka/ru/uk dubs. isTorrentioAddon() hard-excludes any lingering
// Torrentio install record (local file OR Postgres) from stream queries, so magnets can
// never resurface even if the addon record wasn't deleted.
const TORRENTIO_ADDON_ID = 'com.stremio.torrentio.addon';
const isTorrentioAddon = a =>
  (a?.manifest?.id || a?.id) === TORRENTIO_ADDON_ID ||
  /(^|\/\/)([^/]*\.)?torrentio\.strem\.fun\//i.test(a?.url || '');

// "Saturn" now carries only the Georgian Dubbed addon, which serves every audio language
// as a direct link (en/ka/ru/uk). Its streams are tagged so the OPTIONAL per-user
// language-preference filter can apply to them.
const SATURN_SOURCE_IDS = new Set([
  'community.georgian.dubbed',   // direct dubs (ka/ru/uk) + en (NuvioStreams)
]);
const SATURN_LANGS = ['ka', 'en', 'ru', 'uk'];
const isSaturnAddon = a => SATURN_SOURCE_IDS.has(a?.manifest?.id || a?.id);
// Keep only the recognised language codes, preserving the canonical order.
function sanitizeLangs(arr) {
  if (!Array.isArray(arr)) return null;
  return SATURN_LANGS.filter(l => arr.includes(l));
}
// Client-safe view of a user's Saturn config. Saturn no longer holds a TorBox key or
// account — only the optional audio-language preference (defaults to all languages).
function saturnPublic(s) {
  const langs = s && Array.isArray(s.langs) ? sanitizeLangs(s.langs) : null;
  return { langs: (langs && langs.length) ? langs : SATURN_LANGS.slice() };
}

/* normalise a Stremio catalog meta into the frontend movie shape (ids are IMDb tt…) */
function mapStremioMeta(m) {
  const genres = m.genres || m.genre || [];
  return {
    id: m.id,
    title: m.name || 'Untitled',
    year: String(m.releaseInfo || m.year || '').slice(0, 4) || '—',
    rating: m.imdbRating ? +parseFloat(m.imdbRating).toFixed(1) : 0,
    genre: (Array.isArray(genres) ? genres[0] : genres) || '—',
    poster: m.poster || null,
  };
}

/* ------------------------------------------------------------------ *
 *  Debrid resolver (Real-Debrid): magnet → direct streamable URL
 *  Key is stored server-side in data/settings.json so the browser
 *  never has to make the (CORS-blocked) debrid calls itself.
 * ------------------------------------------------------------------ */
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
async function readSettings() {
  if (storage.dbEnabled) {
    try { return await storage.readDoc(SETTINGS_FILE, {}); } catch { return {}; }
  }
  if (!existsSync(SETTINGS_FILE)) return {};
  try { return JSON.parse(await readFile(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeSettings(s) {
  if (storage.dbEnabled) return storage.writeDoc(SETTINGS_FILE, s);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

const RD = 'https://api.real-debrid.com/rest/1.0';
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|flv|wmv|mpg|mpeg)$/i;
// Containers/codecs an HTML5 <video> can actually decode. MKV/AVI and HEVC/x265/AV1
// generally cannot play in-browser, which is the "This file can't play" failure.
const PLAYABLE_EXT = /\.(mp4|m4v|webm|mov)$/i;
function rdErr(status) {
  const code = (status === 401 || status === 403) ? 'DEBRID_AUTH' : 'DEBRID_ERR';
  const msg = code === 'DEBRID_AUTH' ? 'Invalid or expired Real-Debrid token' : `Real-Debrid error ${status}`;
  return Object.assign(new Error(msg), { code, status });
}
async function rdFetch(token, path, opts = {}) {
  const r = await fetch(RD + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw rdErr(r.status);
  return r.status === 204 ? null : r.json();
}
async function rdUser(token) {
  return rdFetch(token, '/user'); // throws on bad token
}
const form = o => new URLSearchParams(o);
/* add magnet → select largest video file → poll until cached → unrestrict */
async function rdResolveMagnet(magnet, token, fileIdx) {
  const { id } = await rdFetch(token, '/torrents/addMagnet', { method: 'POST', body: form({ magnet }) });
  let info = await rdFetch(token, `/torrents/info/${id}`);
  const files = info.files || [];
  const videos = files.filter(f => VIDEO_EXT.test(f.path));
  // Prefer a browser-playable container (mp4/m4v/webm/mov) over a larger MKV when
  // the torrent ships both, so the resolved file actually plays in <video>.
  const playable = videos.filter(f => PLAYABLE_EXT.test(f.path));
  const pool = playable.length ? playable : (videos.length ? videos : files);
  let chosen = fileIdx != null ? files.find(f => f.id === +fileIdx) : null;
  if (!chosen) chosen = pool.slice().sort((a, b) => b.bytes - a.bytes)[0];
  if (!chosen) throw Object.assign(new Error('No playable file in this torrent'), { code: 'NO_FILE' });

  await rdFetch(token, `/torrents/selectFiles/${id}`, { method: 'POST', body: form({ files: String(chosen.id) }) });

  const deadline = Date.now() + 9000; // cached torrents flip to "downloaded" almost instantly
  while (true) {
    info = await rdFetch(token, `/torrents/info/${id}`);
    if (info.status === 'downloaded') break;
    if (['magnet_error', 'error', 'virus', 'dead'].includes(info.status)) {
      throw Object.assign(new Error('Torrent unavailable (' + info.status + ')'), { code: 'TORRENT_ERR' });
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error('Not cached on Real-Debrid yet — it is downloading on their servers. Try again in a minute.'), { code: 'NOT_CACHED' });
    }
    await new Promise(s => setTimeout(s, 1200));
  }
  const link = (info.links || [])[0];
  if (!link) throw Object.assign(new Error('Real-Debrid returned no link'), { code: 'NO_LINK' });
  const un = await rdFetch(token, '/unrestrict/link', { method: 'POST', body: form({ link }) });
  return { url: un.download, filename: un.filename, mime: un.mimeType || null };
}

/* ---- TorBox (api.torbox.app) ------------------------------------- */
const TB = 'https://api.torbox.app/v1/api';
async function tbFetch(token, path, opts = {}) {
  const r = await fetch(TB + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || (j && j.success === false)) {
    const code = (r.status === 401 || r.status === 403) ? 'DEBRID_AUTH' : 'DEBRID_ERR';
    const msg = (j && (j.detail || j.error)) ||
      (code === 'DEBRID_AUTH' ? 'Invalid or expired TorBox token' : `TorBox error ${r.status}`);
    throw Object.assign(new Error(msg), { code, status: r.status });
  }
  return j;
}
async function tbUser(token) {
  const j = await tbFetch(token, '/user/me'); // throws on bad token
  return j.data || {};
}
/* create torrent → poll until cached → request a direct download link */
async function tbResolveMagnet(magnet, token, fileIdx) {
  const fd = new FormData();
  fd.append('magnet', magnet);
  const created = await tbFetch(token, '/torrents/createtorrent', { method: 'POST', body: fd });
  const cd = created.data || {};
  const torrentId = cd.torrent_id ?? cd.id ?? cd.queued_id;
  const hash = cd.hash;
  if (torrentId == null && !hash) throw Object.assign(new Error('TorBox did not return a torrent id'), { code: 'NO_FILE' });

  const pickInfo = (data) => Array.isArray(data)
    ? data.find(t => t.id === torrentId || (hash && t.hash === hash))
    : data;

  const deadline = Date.now() + 9000;
  let info;
  while (true) {
    const list = await tbFetch(token, `/torrents/mylist?id=${encodeURIComponent(torrentId)}&bypass_cache=true`);
    info = pickInfo(list.data);
    if (info && (info.download_present || info.download_finished) && (info.files || []).length) break;
    if (info && ['error', 'stalled (no seeds)'].includes(info.download_state)) {
      throw Object.assign(new Error('Torrent unavailable (' + info.download_state + ')'), { code: 'TORRENT_ERR' });
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error('Not cached on TorBox yet — it is downloading on their servers. Try again in a minute.'), { code: 'NOT_CACHED' });
    }
    await new Promise(s => setTimeout(s, 1200));
  }
  const files = info.files || [];
  const named = f => f.name || f.short_name || '';
  const videos = files.filter(f => VIDEO_EXT.test(named(f)));
  // Prefer a browser-playable container (mp4/m4v/webm/mov) over a larger MKV when
  // the torrent ships both, so the resolved file actually plays in <video>.
  const playable = videos.filter(f => PLAYABLE_EXT.test(named(f)));
  const pool = playable.length ? playable : (videos.length ? videos : files);
  let chosen = fileIdx != null ? files.find(f => f.id === +fileIdx) : null;
  if (!chosen) chosen = pool.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!chosen) throw Object.assign(new Error('No playable file in this torrent'), { code: 'NO_FILE' });

  const dl = await tbFetch(token, `/torrents/requestdl?token=${encodeURIComponent(token)}&torrent_id=${encodeURIComponent(info.id)}&file_id=${encodeURIComponent(chosen.id)}`);
  return { url: dl.data, filename: chosen.short_name || chosen.name || null, mime: null };
}
/* Ask TorBox which of these infohashes are already cached on its servers. Cached
 * torrents stream instantly over HTTPS (no swarm, no seeders) — so they never throw
 * "stalled, no seeds" — which is why we float them to the top of each language's list.
 * Returns a Set of cached (lowercased) hashes, or null if the check is unavailable
 * (network/auth error) so callers can degrade gracefully instead of mis-ranking. */
async function tbCachedHashes(hashes, token) {
  const uniq = [...new Set((hashes || []).map(h => String(h || '').toLowerCase()).filter(Boolean))].slice(0, 100);
  if (!uniq.length) return new Set();
  try {
    const j = await tbFetch(token, `/torrents/checkcached?hash=${uniq.join(',')}&format=list&list_files=false`);
    const data = j && j.data;
    const set = new Set();
    if (Array.isArray(data)) {
      for (const d of data) { const h = d && (d.hash || d.infohash); if (h) set.add(String(h).toLowerCase()); }
    } else if (data && typeof data === 'object') {
      // format=object fallback: { "<hash>": { ... } } — a present, truthy entry = cached
      for (const k of Object.keys(data)) { if (data[k]) set.add(k.toLowerCase()); }
    }
    return set;
  } catch { return null; }
}

/* Normalise the many shapes users paste into a fetchable manifest URL:
 *   stremio://host/manifest.json   → https://host/manifest.json  (Stremio deep links)
 *   https://host                   → https://host/manifest.json  (bare base URL)
 *   https://host/                  → https://host/manifest.json
 * Returns null if it can't be made into a valid http(s) URL. */
function normalizeManifestUrl(raw) {
  let url = (raw || '').trim();
  if (!url) return null;
  if (url.startsWith('stremio://')) url = 'https://' + url.slice('stremio://'.length);
  if (!/^https?:\/\//i.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  // Only auto-append manifest.json when the path clearly isn't already a JSON endpoint.
  if (!/\.json($|\?)/i.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/manifest.json';
  }
  return parsed.toString();
}

app.get('/api/addons', requireAuth, async (req, res) => {
  res.json({ addons: await readAddons() });
});

app.post('/api/addons', requireAuth, installLimiter, async (req, res) => {
  const url = normalizeManifestUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Invalid manifest URL' });
  if (!isSafeFetchUrl(url)) return res.status(400).json({ error: 'That host is not allowed (private/loopback addresses are blocked)' });

  let manifest;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).json({ error: `Addon responded ${r.status}` });
    manifest = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Could not fetch manifest: ' + (e.message || 'network error') });
  }

  const problem = validateManifest(manifest);
  if (problem) return res.status(422).json({ error: problem });

  const list = await readAddons();
  if (list.some(a => a.manifest.id === manifest.id)) {
    return res.status(409).json({ error: `Addon "${manifest.name}" is already installed` });
  }
  const record = {
    id: manifest.id,
    url,
    installedAt: new Date().toISOString(),
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version || '—',
      description: manifest.description || '',
      types: manifest.types,
      resources: manifest.resources.map(r => (typeof r === 'string' ? r : r.name)),
      catalogs: Array.isArray(manifest.catalogs)
        ? manifest.catalogs.map(c => ({ type: c.type, id: c.id, name: c.name || c.id }))
        : [],
    },
  };
  list.push(record);
  await writeAddons(list);
  res.status(201).json({ addon: record });
});

app.delete('/api/addons/:id', requireAuth, async (req, res) => {
  const list = await readAddons();
  const next = list.filter(a => a.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: 'Addon not found' });
  await writeAddons(next);
  res.json({ removed: req.params.id });
});

/* ------------------------------------------------------------------ *
 *  Addon resources wired into the UI: streams + catalogs
 * ------------------------------------------------------------------ */

/* aggregate streams for a video id (IMDb tt…) across installed stream addons */
app.get('/api/streams/:id', async (req, res) => {
  const id = req.params.id;
  const type = String(req.query.type || 'movie');
  const all = (await readAddons()).filter(a =>
    (a.manifest?.resources || []).includes('stream') &&
    (a.manifest?.types || []).includes(type));

  // No TorBox gate anymore: every source now serves DIRECT links (no debrid needed),
  // so streams are never locked. Torrentio is hard-excluded so a lingering install
  // record can't resurface magnets. The only remaining knob is an OPTIONAL per-user
  // audio-language preference; with none set, all available languages surface.
  const addons = all.filter(a => !isTorrentioAddon(a));
  const saturnCfg = req.user ? await getUserSaturn(req.user.id) : null;
  const cfgLangs = saturnCfg && Array.isArray(saturnCfg.langs) ? sanitizeLangs(saturnCfg.langs) : null;
  const langs = (cfgLangs && cfgLangs.length) ? cfgLangs : SATURN_LANGS.slice();
  if (!addons.length) return res.json({ streams: [], addons: 0, saturn: 'none', langs });

  const perAddon = await Promise.all(addons.map(async a => {
    const path = `stream/${type}/${encodeURIComponent(id)}.json`;
    // Try the optimized base(s) first; on error OR an empty result, fall through to the
    // plain base so a Torrentio config quirk can never make a title return zero sources.
    const bases = streamBasesFor(a);
    const sat = isSaturnAddon(a);   // tag provenance so the language filter only touches Saturn
    for (let i = 0; i < bases.length; i++) {
      try {
        const data = await fetchAddonResource(bases[i], path);
        const mapped = (data.streams || []).map(s => { const m = mapStream(s, a.manifest.name); m._saturn = sat; return m; }).filter(s => s.url);
        if (mapped.length || i === bases.length - 1) return mapped;
      } catch { /* try the next base */ }
    }
    return []; // one slow/broken addon shouldn't sink the rest
  }));
  let streams = perAddon.flat();

  // Torrent ranking removed: STREDIO no longer serves magnets. Every source is now a
  // DIRECT link, already ordered best-first by its addon (NuvioStreams sorts English by
  // quality; the Georgian addon emits its best per-language row first). The client still
  // shows the single best row per language and silently cascades to the next on failure.

  // Optional audio-language preference: when the user has set one, surface only those
  // languages for our Georgian Dubbed source; otherwise show every available language.
  if (cfgLangs && cfgLangs.length) {
    streams = streams.filter(s => !s._saturn || cfgLangs.includes(s.lang || 'en'));
  }
  for (const s of streams) delete s._saturn;   // internal tag — don't leak it to the client

  res.json({ streams, addons: addons.length, saturn: 'none', langs });
});

/* list every catalog declared by installed catalog addons */
app.get('/api/addon-catalogs', async (req, res) => {
  const out = [];
  for (const a of await readAddons()) {
    if (!(a.manifest?.resources || []).includes('catalog')) continue;
    for (const c of a.manifest?.catalogs || []) {
      out.push({ addonId: a.id, addonName: a.manifest.name, type: c.type, id: c.id, name: c.name });
    }
  }
  res.json({ catalogs: out });
});

/* ---- subtitles: aggregate from installed subtitle addons, serve as VTT ---- */
const LANG_NAMES = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  'pt-br': 'Portuguese (BR)', pob: 'Portuguese (BR)', ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic',
  hi: 'Hindi', hin: 'Hindi', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese',
  chi: 'Chinese', zho: 'Chinese', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', pl: 'Polish', pol: 'Polish',
  tr: 'Turkish', tur: 'Turkish', sv: 'Swedish', swe: 'Swedish', no: 'Norwegian', nor: 'Norwegian',
  da: 'Danish', dan: 'Danish', fi: 'Finnish', fin: 'Finnish', cs: 'Czech', cze: 'Czech', el: 'Greek',
  gre: 'Greek', he: 'Hebrew', heb: 'Hebrew', ro: 'Romanian', rum: 'Romanian', hu: 'Hungarian', hun: 'Hungarian',
  th: 'Thai', tha: 'Thai', vi: 'Vietnamese', vie: 'Vietnamese', id: 'Indonesian', ind: 'Indonesian', uk: 'Ukrainian', ukr: 'Ukrainian',
  ron: 'Romanian', hrv: 'Croatian', srp: 'Serbian', bul: 'Bulgarian', slv: 'Slovenian', slo: 'Slovak', slk: 'Slovak',
  est: 'Estonian', lav: 'Latvian', lit: 'Lithuanian', spl: 'Spanish (LatAm)', ze: 'Chinese (bilingual)', fa: 'Persian', per: 'Persian', fas: 'Persian',
  ms: 'Malay', may: 'Malay', msa: 'Malay', ca: 'Catalan', cat: 'Catalan', eu: 'Basque', baq: 'Basque', gl: 'Galician', glg: 'Galician',
};
function langName(code) {
  if (!code) return null;
  const c = String(code).toLowerCase();
  return LANG_NAMES[c] || LANG_NAMES[c.split(/[-_]/)[0]] || null;
}
function srtToVtt(srt) {
  const body = srt.replace(/\r+/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return /^\s*WEBVTT/.test(body) ? body : 'WEBVTT\n\n' + body;
}

app.get('/api/subtitles/:id', async (req, res) => {
  const id = req.params.id;
  const type = String(req.query.type || 'movie');
  const addons = (await readAddons()).filter(a =>
    (a.manifest?.resources || []).includes('subtitles') &&
    (a.manifest?.types || []).includes(type));
  if (!addons.length) return res.json({ subtitles: [], addons: 0 });

  const perAddon = await Promise.all(addons.map(async a => {
    try {
      const data = await fetchAddonResource(addonBase(a.url), `subtitles/${type}/${encodeURIComponent(id)}.json`);
      return (data.subtitles || []).filter(s => s.url).map(s => ({
        lang: s.lang || s.id || 'und',
        label: (langName(s.lang) || s.lang || 'Subtitle') + (s.id && /hi|sdh/i.test(s.id) ? ' (SDH)' : ''),
        url: '/api/subtitle?src=' + encodeURIComponent(s.url),
        source: a.manifest.name,
      }));
    } catch { return []; }
  }));
  res.json({ subtitles: perAddon.flat(), addons: addons.length });
});

/* fetch a subtitle file, decompress if gzipped, convert SRT→VTT, serve as text/vtt */
app.get('/api/subtitle', async (req, res) => {
  const src = req.query.src;
  if (!src || !isSafeFetchUrl(src)) return res.status(400).send('Invalid or disallowed subtitle src');
  try {
    const r = await fetch(src, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return res.status(502).send('Subtitle fetch failed');
    let buf = Buffer.from(await r.arrayBuffer());
    if (/\.gz($|\?)/i.test(src) || (buf[0] === 0x1f && buf[1] === 0x8b)) {
      try { buf = gunzipSync(buf); } catch { /* not actually gzipped */ }
    }
    const vtt = srtToVtt(buf.toString('utf8'));
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  } catch (e) {
    res.status(502).send('Subtitle error');
  }
});

/* ------------------------------------------------------------------ *
 *  Media stream proxy: play Referer-gated CDN files in the browser.
 *  Some addon sources (e.g. the Georgian addon's sibnet/fsst mirrors and the
 *  ge.movie/em.filmx.my HLS streams) serve their media only when the request
 *  carries a specific Referer, then 30x redirect to a signed CDN URL — things a
 *  browser can't do itself. mapStream() rewrites those streams to point here; we
 *  re-issue the request server-side with the Referer, follow redirects and pipe
 *  the bytes back, forwarding Range so the player can seek. Same origin → no CORS.
 *
 *  For HLS (t=hls) we additionally rewrite every child URI in the playlist
 *  (variant + audio playlists, segments, keys) to come back through this proxy,
 *  so the whole HLS tree inherits the Referer. Georgian audio lives in a separate
 *  EXT-X-MEDIA audio track, which this preserves.
 * ------------------------------------------------------------------ */
const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
function proxify(absUrl, ref, asHls) {
  return STREAM_PROXY_PATH + '?src=' + encodeURIComponent(absUrl) + '&ref=' + encodeURIComponent(ref) + (asHls ? '&t=hls' : '');
}
function rewriteHlsPlaylist(text, baseUrl, ref) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('#')) {
      // Rewrite URI="…" attributes (EXT-X-MEDIA audio/subs = playlists; KEY/MAP = binary)
      line = line.replace(/URI="([^"]+)"/g, (_m, u) => {
        let abs; try { abs = new URL(u, baseUrl).href; } catch { return `URI="${u}"`; }
        const binary = /EXT-X-KEY|EXT-X-MAP/i.test(line);
        return `URI="${proxify(abs, ref, !binary)}"`;
      });
      out.push(line);
    } else if (line.trim() === '') {
      out.push(line);
    } else {
      let abs; try { abs = new URL(line.trim(), baseUrl).href; } catch { out.push(line); continue; }
      const prev = out.length ? out[out.length - 1] : '';
      const isPlaylist = /EXT-X-STREAM-INF|EXT-X-I-FRAME-STREAM-INF/i.test(prev) || /\.(m3u8|txt)(\?|$)/i.test(line);
      out.push(proxify(abs, ref, isPlaylist));
    }
  }
  return out.join('\n');
}

app.get('/api/stream-proxy', async (req, res) => {
  const src = req.query.src;
  const ref = req.query.ref || '';
  const asHls = req.query.t === 'hls';
  if (!src || !isSafeFetchUrl(src)) return res.status(400).send('Invalid or disallowed src');
  if (ref && !/^https?:\/\//i.test(ref)) return res.status(400).send('Invalid ref');
  const upstreamHeaders = { 'User-Agent': PROXY_UA, Accept: '*/*' };
  if (ref) upstreamHeaders.Referer = ref;
  // Don't forward Range when fetching a playlist — we need the whole text to rewrite.
  if (req.headers.range && !asHls) upstreamHeaders.Range = req.headers.range;
  let upstream;
  try {
    upstream = await fetch(src, { headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return res.status(502).send('Upstream fetch failed');
  }
  if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).send('Upstream ' + upstream.status);

  // HLS playlist → rewrite all child URIs to inherit the Referer through this proxy.
  if (asHls) {
    let text;
    try { text = await upstream.text(); } catch { return res.status(502).send('Playlist read failed'); }
    if (/#EXTM3U/.test(text)) {
      const body = rewriteHlsPlaylist(text, upstream.url || src, ref);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-store');
      return res.send(body);
    }
    // Not actually a playlist — fall through and serve as-is.
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type'); if (ct) res.set('Content-Type', ct);
    return res.send(text);
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', 'bytes');
  if (!upstream.body) return res.end();

  const node = Readable.fromWeb(upstream.body);
  // If the client aborts (closes the tab / seeks), stop pulling from upstream.
  res.on('close', () => node.destroy());
  node.on('error', () => { try { res.end(); } catch { /* already closed */ } });
  node.pipe(res);
});

/* fetch one catalog's contents, normalised to the frontend movie shape */
app.get('/api/addon-catalog/:addonId/:type/:catalogId', async (req, res) => {
  const a = (await readAddons()).find(x => x.id === req.params.addonId);
  if (!a) return res.status(404).json({ error: 'Addon not installed' });
  try {
    const data = await fetchAddonResource(
      addonBase(a.url),
      `catalog/${req.params.type}/${encodeURIComponent(req.params.catalogId)}.json`);
    // Titles come straight from the addon's secure catalog API — never from the
    // client. (We previously accepted a ?titles= override, which let a caller
    // rewrite any title; removed.)
    res.json({ source: a.manifest.name, results: (data.metas || []).map(mapStremioMeta) });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Catalog fetch failed' });
  }
});

/* ------------------------------------------------------------------ *
 *  Debrid: account status, save/validate key, resolve magnet
 * ------------------------------------------------------------------ */
const DEBRID_PROVIDERS = {
  realdebrid: {
    label: 'Real-Debrid',
    validate: async token => { const u = await rdUser(token); return { token, username: u.username, premium: u.type === 'premium', expiration: u.expiration }; },
    resolve: rdResolveMagnet,
  },
  torbox: {
    label: 'TorBox',
    validate: async token => { const u = await tbUser(token); return { token, username: u.email || u.username || null, premium: (u.plan ?? 0) > 0, expiration: u.premium_expires_at || u.cooldown_until || null }; },
    resolve: tbResolveMagnet,
  },
};
function providerStatus(rec) {
  if (!rec?.token) return { configured: false };
  return { configured: true, username: rec.username || null, premium: rec.premium ?? null, expiration: rec.expiration || null };
}

app.get('/api/debrid', requireAuth, async (req, res) => {
  const d = (await readSettings()).debrid || {};
  const out = { configured: false };
  for (const p of Object.keys(DEBRID_PROVIDERS)) {
    out[p] = providerStatus(d[p]);
    if (out[p].configured) out.configured = true;
  }
  res.json(out);
});

app.post('/api/debrid', requireAuth, async (req, res) => {
  const provider = req.body?.provider || 'realdebrid';
  const token = (req.body?.token || '').trim();
  const def = DEBRID_PROVIDERS[provider];
  if (!def) return res.status(400).json({ error: 'Unsupported debrid provider' });
  if (!token) return res.status(400).json({ error: `Paste your ${def.label} API token` });
  try {
    const rec = await def.validate(token); // validates the token upstream
    const s = await readSettings();
    s.debrid = { ...(s.debrid || {}), [provider]: rec };
    await writeSettings(s);
    res.json({ provider, ...providerStatus(rec) });
  } catch (e) {
    const status = e.code === 'DEBRID_AUTH' ? 401 : 502;
    res.status(status).json({ error: e.message || 'Could not validate token' });
  }
});

app.delete('/api/debrid', requireAuth, async (req, res) => {
  const provider = req.query.provider;
  const s = await readSettings();
  if (s.debrid) { if (provider) delete s.debrid[provider]; else s.debrid = {}; }
  await writeSettings(s);
  res.json({ removed: provider || 'all' });
});

app.post('/api/debrid/resolve', requireAuth, resolveLimiter, async (req, res) => {
  const magnet = req.body?.magnet;
  const fileIdx = req.body?.fileIdx;
  if (!magnet || !/^magnet:/i.test(magnet)) return res.status(400).json({ error: 'Missing or invalid magnet' });
  // The user's Saturn TorBox key (set when they verified the addon) takes
  // precedence — it's the key they used to unlock the very streams they're now
  // playing — and falls back to the shared debrid config for legacy setups.
  const saturnCfg = await getUserSaturn(req.user.id);
  const d = (await readSettings()).debrid || {};
  let provider, token;
  if (saturnCfg?.token) {
    provider = 'torbox';
    token = saturnCfg.token;
  } else {
    provider = req.body?.provider || Object.keys(DEBRID_PROVIDERS).find(p => d[p]?.token);
    token = provider ? d[provider]?.token : null;
  }
  if (!provider || !token) return res.status(400).json({ error: 'No debrid key set', code: 'NO_KEY' });
  try {
    const out = await DEBRID_PROVIDERS[provider].resolve(magnet, token, fileIdx);
    res.json({ provider, ...out });
  } catch (e) {
    const status = e.code === 'NOT_CACHED' ? 202 : e.code === 'DEBRID_AUTH' ? 401 : 502;
    res.status(status).json({ error: e.message || 'Resolve failed', code: e.code || 'DEBRID_ERR', provider });
  }
});

/* ------------------------------------------------------------------ *
 *  "Saturn" addon — per-user audio-language preference (no TorBox key).
 *  Torrentio is retired; every source is a direct link, so there is nothing
 *  to verify. The user just picks which of ka/en/ru/uk surface in the stream
 *  list; with no preference saved, all available languages show.
 * ------------------------------------------------------------------ */
app.get('/api/saturn', requireAuth, async (req, res) => {
  res.json(saturnPublic(await getUserSaturn(req.user.id)));
});

app.post('/api/saturn/config', requireAuth, async (req, res) => {
  const langs = sanitizeLangs(req.body?.langs);
  if (!langs || !langs.length) return res.status(400).json({ error: 'Choose at least one language' });
  const saturn = (await getUserSaturn(req.user.id)) || {};
  saturn.langs = langs;
  await setUserSaturn(req.user.id, saturn);
  res.json(saturnPublic(saturn));
});

// Reset the language preference back to "all languages".
app.delete('/api/saturn', requireAuth, async (req, res) => {
  await setUserSaturn(req.user.id, null);
  res.json(saturnPublic(null));
});

/* ------------------------------------------------------------------ *
 *  Watch state — Continue Watching history + resume progress, synced
 *  across a signed-in user's devices. The browser keeps localStorage as the
 *  instant source of truth and PUSHes here throttled (~once/25s of activity),
 *  so a 2-hour watch is a handful of writes — gentle on the Postgres/Neon
 *  free tier. PUT MERGES with the stored doc (newest-per-id history, newest-
 *  per-key progress, tombstones for removals) so two devices never clobber.
 * ------------------------------------------------------------------ */
const WATCH_HISTORY_CAP = 60;
const WATCH_PROGRESS_CAP = 240;
const WATCH_TOMB_TTL = 30 * 24 * 60 * 60 * 1000;  // forget a removal after 30 days
function mergeWatchState(stored, incoming) {
  const s = stored || {}, i = incoming || {};
  const now = Date.now();
  // tombstones (history removals): id -> at; keep newest, prune stale
  const removed = {};
  for (const src of [s.removed || {}, i.removed || {}]) {
    for (const id of Object.keys(src)) { const at = +src[id] || 0; if (at > (removed[id] || 0)) removed[id] = at; }
  }
  for (const id of Object.keys(removed)) { if (now - removed[id] > WATCH_TOMB_TTL) delete removed[id]; }
  // history: union by id (newest `at`), drop tombstoned, sort newest-first, cap
  const hMap = new Map();
  for (const e of [...(s.history || []), ...(i.history || [])]) {
    if (!e || e.id == null) continue;
    const id = String(e.id), prev = hMap.get(id);
    if (!prev || (+e.at || 0) > (+prev.at || 0)) hMap.set(id, e);
  }
  const history = [...hMap.values()]
    .filter(e => { const t = removed[String(e.id)]; return !(t && t >= (+e.at || 0)); })
    .sort((a, b) => (+b.at || 0) - (+a.at || 0))
    .slice(0, WATCH_HISTORY_CAP);
  // progress: union by key (newest `at`), cap to most-recent keys
  const sp = s.progress || {}, ip = i.progress || {}, pm = {};
  for (const k of new Set([...Object.keys(sp), ...Object.keys(ip)])) {
    const a = sp[k], b = ip[k];
    pm[k] = (!a || (b && (+b.at || 0) >= (+a.at || 0))) ? (b || a) : a;
  }
  const progress = {};
  Object.keys(pm).sort((a, b) => (+pm[b].at || 0) - (+pm[a].at || 0)).slice(0, WATCH_PROGRESS_CAP)
    .forEach(k => { progress[k] = pm[k]; });
  return { history, progress, removed, updatedAt: now };
}

app.get('/api/watch-state', requireAuth, async (req, res) => {
  const d = await getUserWatch(req.user.id);
  res.json({ history: d.history || [], progress: d.progress || {}, removed: d.removed || {} });
});

app.put('/api/watch-state', requireAuth, async (req, res) => {
  const b = req.body || {};
  const incoming = {
    history: Array.isArray(b.history) ? b.history.slice(0, 200) : [],
    progress: (b.progress && typeof b.progress === 'object' && !Array.isArray(b.progress)) ? b.progress : {},
    removed: (b.removed && typeof b.removed === 'object' && !Array.isArray(b.removed)) ? b.removed : {},
  };
  const merged = mergeWatchState(await getUserWatch(req.user.id), incoming);
  await setUserWatch(req.user.id, merged);
  res.json(merged);
});

/* ------------------------------------------------------------------ *
 *  Admin dashboard API (gated by requireAdmin). All heavy plumbing —
 *  the live ka-cache, the TMDB helper, settings/addons readers — is
 *  injected so admin.js holds no duplicate state.
 * ------------------------------------------------------------------ */
app.use('/api/admin', requireAdmin, createAdminRouter({
  kaCache,
  scheduleCacheSave,
  mtTranslateBatch,
  tmdb,
  IMG,
  IMGBACK,
  readSettings,
  writeSettings,
  readAddons,
  hasTmdb: HAS_TMDB,
  dataDir: DATA_DIR,
  // Localization reliability snapshot (the silent-English-fallback telemetry).
  translationMetrics,
  // Integrations + live health board — reuse the EXISTING SSRF-guarded primitives so
  // the admin surface inherits the same private-host/URL protections (never reinvent).
  addons: { writeAddons, normalizeManifestUrl, isSafeFetchUrl, validateManifest, addonBase, fetchAddonResource },
  debrid: { providers: DEBRID_PROVIDERS, providerStatus },
  // Read-only posture introspection (booleans only — never the actual admin emails).
  serverConfig: {
    adminEmailsConfigured: !!String(process.env.ADMIN_EMAILS || '').trim(),
    trustProxy: TRUST_PROXY,
    sessionTtlDays: 30,
  },
}));

/* ------------------------------------------------------------------ *
 *  Static frontend + boot
 * ------------------------------------------------------------------ */
function sendErr(res, e) {
  if (e.code === 'NO_TMDB') {
    return res.status(503).json({ error: 'TMDB not configured', hint: 'Add TMDB_BEARER to server/.env' });
  }
  console.error(e);
  res.status(502).json({ error: e.message || 'Upstream error' });
}

/* Serve ONLY the frontend file. The previous express.static(ROOT) exposed the
 * entire project folder over HTTP — including server/.env (TMDB token) and
 * server/data/settings.json (debrid token) — so it is deliberately gone. The
 * frontend needs no local assets besides itself (fonts/images load from the
 * CDNs allowed by the CSP above), so an explicit allowlist is both safe and
 * sufficient. Anything else under / returns 404. */
function sendFrontend(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(ROOT, 'index.html'));
}
app.get('/', sendFrontend);
app.get('/index.html', sendFrontend);
// Keep the old path working so existing bookmarks/links to /stredio.html still load.
app.get('/stredio.html', sendFrontend);
/* Admin dashboard shell. The HTML carries no secrets — every data call goes
 * through /api/admin, which requireAdmin gates — so serving the static file to
 * anyone is safe; a non-admin just sees the "access denied" state. */
function sendAdmin(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(ROOT, 'admin.html'));
}
app.get('/admin', sendAdmin);
app.get('/admin.html', sendAdmin);
/* Public assets (self-hosted fonts, etc.). Scoped to ROOT/assets only — never
 * ROOT itself — so no server/.env or data files are reachable. express.static
 * already blocks path traversal and only serves files that exist under here. */
app.use('/assets', express.static(join(ROOT, 'assets'), {
  immutable: true, maxAge: '30d', index: false, redirect: false,
}));
// Catch-all: never leak repo files; JSON for /api, plain 404 otherwise.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).type('txt').send('Not found');
});

/* Clean JSON errors — never leak stack traces to the client (this also catches
 * malformed-JSON body-parser failures, which previously dumped a stack trace). */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : (err?.message || 'Request failed') });
});

/* Boot: load the translation cache, cover overrides, and glossary, and ensure at
 * least one admin exists — then listen. Each init is best-effort: a failure logs
 * and continues so the catalog still serves even if, say, an admin promotion
 * write fails. */
async function boot() {
  // Connect + create the kv table before any store reads. If DATABASE_URL is set
  // but unreachable, fail loudly here rather than silently degrading to empty
  // (ephemeral) state — that would look like "all my data vanished" in prod.
  if (storage.dbEnabled) {
    try { await storage.init(); console.log('  Storage            → Postgres (persistent) ✓'); }
    catch (e) { console.error('  Storage            → Postgres connect FAILED:', e.message); throw e; }
  } else {
    console.log('  Storage            → local JSON files (set DATABASE_URL for persistence)');
  }
  await Promise.all([
    loadKaCache(),
    covers.init().catch(e => console.warn('covers init:', e.message)),
    logoStore.init().catch(e => console.warn('logos init:', e.message)),
    glossary.init().catch(e => console.warn('glossary init:', e.message)),
  ]);
  const admins = await ensureAdminBootstrap().catch(e => (console.warn('admin bootstrap:', e.message), []));
  const hasAdminEmails = !!String(process.env.ADMIN_EMAILS || '').trim();
  // Keep the dubbed-streams addon (:7000) alive alongside us — it's the only source
  // of Georgian + Ukrainian dubs, so if it's down those languages vanish from the modal.
  startGeorgianAddon().catch(e => console.warn('georgian addon supervise:', e.message));
  app.listen(PORT, () => {
    console.log(`\n  STREDIO backend → http://localhost:${PORT}`);
    console.log(`  Frontend           → http://localhost:${PORT}/`);
    console.log(`  Admin              → http://localhost:${PORT}/admin`);
    console.log(`  TMDB               → ${HAS_TMDB ? 'configured ✓' : 'NOT set (catalog falls back to mock data)'}`);
    console.log(`  Translation        → Google Translate (free, no key) ${MT_ENABLED ? '✓' : '— DISABLED (DISABLE_KA_TRANSLATE)'}`);
    console.log(`  Admin accounts     → ${admins.length ? admins.join(', ') : (hasAdminEmails ? 'none yet — waiting for an ADMIN_EMAILS address to register' : 'none yet (first signup becomes admin)')}`);
    if (!admins.length && !hasAdminEmails) {
      console.warn('  ⚠  No admin and no ADMIN_EMAILS set — on a PUBLIC deployment the first stranger to sign up becomes admin.');
      console.warn('     Set ADMIN_EMAILS=you@example.com in server/.env, or register before exposing the server.');
    }
    console.log('');
  });
}
boot();
