// STREDIO backend — TMDB catalog/search proxy + addon install-by-URL engine.
// Single-origin: also serves the static frontend (index.html) so the browser
// can call /api/* without any CORS configuration.

import express from 'express';
import compression from 'compression';
import dotenv from 'dotenv';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachUser, requireAuth, requireAdmin, ensureAdminBootstrap,
  createUser, authenticate, authenticateGoogle, googleConfigured, googleClientId,
  createSession, destroySession, sessionCookie, clearCookie,
  getUserLibrary, setUserLibrary,
  getUserAddonState, setUserAddonState,
} from './auth.js';
import * as covers from './covers.js';
import * as logoStore from './logos.js';
import * as glossary from './glossary.js';
import * as storage from './storage.js';
import { createAdminRouter, recordActivity } from './admin.js';

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
// Poster/backdrop CDN. Defaults to TMDB directly: image.tmdb.org is already a
// fast global CDN that serves WebP straight to browsers, so fronting it with our
// own Worker only hurt — the Worker's per-region cache starts cold, adding an
// extra hop on every miss (measurably slower on mobile) plus an error surface,
// with no WebP gain. The stredio-img Worker stays opt-in via IMG_CDN_BASE for
// any future case where a cache in front genuinely helps. Either way images go
// browser→CDN directly and never touch the origin's bandwidth.
const IMG_CDN_BASE = (process.env.IMG_CDN_BASE || 'https://image.tmdb.org').replace(/\/+$/, '');
const IMG = IMG_CDN_BASE + '/t/p/w500';
// hero backdrop at TMDB's full source resolution (`original`) — frequently true
// 4K (3840x2160) for modern titles — so the full-bleed featured hero stays crisp
// on large/retina displays. `original` is backdrop-only, so the small poster
// cards (IMG/w500) are unaffected and bandwidth stays scoped to the one hero image.
const IMGBACK = IMG_CDN_BASE + '/t/p/original';   // landscape backdrop for the hero banner
const IMGFACE = IMG_CDN_BASE + '/t/p/w185';       // compact avatars for the "Casts & Credits" rail
const IMGSTILL = IMG_CDN_BASE + '/t/p/w300';      // 16:9 episode-card stills (light — cards are ~190px wide)

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
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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
    // The browser connects to each addon's stream / metadata URL DIRECTLY — STREDIO
    // never proxies or re-hosts media bytes. hls.js fetches playlists/segments over
    // XHR, so allow cross-origin https connects; <video> direct files are covered by
    // media-src. (accounts.google.com is https, so it's already included.)
    "connect-src 'self' https:",
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

/* Browser-cache the public catalog data. These endpoints are TMDB-derived,
 * identical for every user (no req.user branch), and change slowly — yet the
 * frontend re-fetches the full JSON on every page load because nothing told the
 * browser it may reuse a copy. That repeat JSON is the bulk of this API origin's
 * egress (the HTML shell + /assets are served from the separate frontend host,
 * not here). A short max-age lets the browser serve instantly without a round
 * trip; stale-while-revalidate keeps it serving the cached copy while it
 * refreshes in the background, so updates still land within a day.
 *
 * Applied only to GET on these exact paths, and only when the handler returns a
 * success body — errors (sendErr → 5xx) and any per-user endpoint
 * (library-state, addons) are deliberately excluded so no
 * personalized or failed response ever gets cached. A handler that sets its own
 * Cache-Control (e.g. /api/subtitle) is left untouched. */
const PUBLIC_CATALOG_GET = /^\/api\/(catalog|search|genres|browse|hero|meta\/|tv\/|introdb\/)/;
app.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_CATALOG_GET.test(req.path)) {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && !res.get('Cache-Control')) {
        res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
      }
      return json(body);
    };
  }
  next();
});

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

/* (No SSRF guard here anymore: the server makes no fetch to any user- or admin-supplied
 * add-on URL. Every add-on request — manifest, stream, subtitle, catalog — is made by
 * the browser directly. The server only fetches its own trusted upstreams: TMDB,
 * Google Translate, and IntroDB.) */

/* ------------------------------------------------------------------ *
 *  Settings store — server-side config persisted in data/settings.json
 *  (or Postgres when enabled): Gemini key pool, cover overrides, etc.
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
  try { parsed = new URL(url); } catch { return null; }   // validate only
  // Keep the URL byte-for-byte: configured add-ons pack options into the path
  // (e.g. Torrentio `…|torbox=KEY|…/manifest.json`); round-tripping through
  // URL.toString() would percent-encode the `|`/`,` and mangle the config.
  if (/\.json($|\?)/i.test(parsed.pathname)) return url;
  const i = url.indexOf('?'), path = i < 0 ? url : url.slice(0, i), qs = i < 0 ? '' : url.slice(i);
  return path.replace(/\/+$/, '') + '/manifest.json' + qs;
}

app.get('/api/addons', requireAuth, async (req, res) => {
  res.json({ addons: await readAddons() });
});

app.post('/api/addons', requireAuth, installLimiter, async (req, res) => {
  // Stremio architecture: the BROWSER fetches and validates the add-on manifest
  // directly from the add-on, then posts the resulting record here ONLY so the
  // user's add-on collection syncs across their devices. STREDIO's server never
  // contacts an add-on — not for the manifest, not for streams/subtitles/catalogs.
  const url = normalizeManifestUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: 'Invalid manifest URL' });
  const manifest = req.body?.manifest;
  const problem = validateManifest(manifest);
  if (problem) return res.status(422).json({ error: problem });

  const record = {
    id: manifest.id,
    url,
    installedAt: new Date().toISOString(),
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version || '—',
      description: manifest.description || '',
      types: Array.isArray(manifest.types) ? manifest.types : [],
      resources: Array.isArray(manifest.resources)
        ? manifest.resources.map(r => (typeof r === 'string' ? r : r && r.name)).filter(Boolean)
        : [],
      catalogs: Array.isArray(manifest.catalogs)
        ? manifest.catalogs.map(c => ({ type: c.type, id: c.id, name: c.name || c.id }))
        : [],
    },
  };

  const list = await readAddons();
  if (list.some(a => a.manifest.id === record.id)) {
    return res.status(409).json({ error: `Addon "${manifest.name}" is already installed` });
  }
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
 *  Add-on resources — streams, subtitles, catalogs — are fetched by the
 *  BROWSER directly from each installed add-on (Stremio's model). STREDIO's
 *  server is never in that path: it does not list, fetch, proxy, rank, or
 *  filter streams/subtitles/catalogs, and never sees the user's debrid key
 *  (which lives only in a debrid-configured add-on URL the browser calls).
 *  The only add-on data the server holds is the user's installed-collection
 *  list (GET/POST/DELETE /api/addons above), stored so it syncs across the
 *  account's devices.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  Library state — the user's private list entries + resume positions,
 *  synced across a signed-in user's devices. The browser keeps localStorage as
 *  the instant source of truth and PUSHes here throttled (~once/25s of activity),
 *  so a couple of hours of activity is a handful of writes — gentle on the
 *  Postgres/Neon free tier. PUT MERGES with the stored doc (newest-per-id
 *  history, newest-per-key progress, tombstones for removals) so two devices
 *  never clobber.
 * ------------------------------------------------------------------ */
const LIBRARY_HISTORY_CAP = 60;
const LIBRARY_PROGRESS_CAP = 240;
const LIBRARY_TOMB_TTL = 30 * 24 * 60 * 60 * 1000;  // forget a removal after 30 days
function mergeLibraryState(stored, incoming) {
  const s = stored || {}, i = incoming || {};
  const now = Date.now();
  // tombstones (entry removals): id -> at; keep newest, prune stale
  const removed = {};
  for (const src of [s.removed || {}, i.removed || {}]) {
    for (const id of Object.keys(src)) { const at = +src[id] || 0; if (at > (removed[id] || 0)) removed[id] = at; }
  }
  for (const id of Object.keys(removed)) { if (now - removed[id] > LIBRARY_TOMB_TTL) delete removed[id]; }
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
    .slice(0, LIBRARY_HISTORY_CAP);
  // progress: union by key (newest `at`), cap to most-recent keys
  const sp = s.progress || {}, ip = i.progress || {}, pm = {};
  for (const k of new Set([...Object.keys(sp), ...Object.keys(ip)])) {
    const a = sp[k], b = ip[k];
    pm[k] = (!a || (b && (+b.at || 0) >= (+a.at || 0))) ? (b || a) : a;
  }
  const progress = {};
  Object.keys(pm).sort((a, b) => (+pm[b].at || 0) - (+pm[a].at || 0)).slice(0, LIBRARY_PROGRESS_CAP)
    .forEach(k => { progress[k] = pm[k]; });
  return { history, progress, removed, updatedAt: now };
}

app.get('/api/library-state', requireAuth, async (req, res) => {
  const d = await getUserLibrary(req.user.id);
  res.json({ history: d.history || [], progress: d.progress || {}, removed: d.removed || {} });
});

app.put('/api/library-state', requireAuth, async (req, res) => {
  const b = req.body || {};
  const incoming = {
    history: Array.isArray(b.history) ? b.history.slice(0, 200) : [],
    progress: (b.progress && typeof b.progress === 'object' && !Array.isArray(b.progress)) ? b.progress : {},
    removed: (b.removed && typeof b.removed === 'object' && !Array.isArray(b.removed)) ? b.removed : {},
  };
  const merged = mergeLibraryState(await getUserLibrary(req.user.id), incoming);
  await setUserLibrary(req.user.id, merged);
  res.json(merged);
});

/* Per-user add-on install state (which official rows are toggled on),
 * synced across the account's devices. Last-write-wins by `at` — a stale device
 * can't clobber a newer toggle. The URL-installed community add-ons stay in the
 * shared addons store; this is only the per-account on/off toggles. */
app.get('/api/addon-state', requireAuth, async (req, res) => {
  const s = await getUserAddonState(req.user.id);
  res.json((s && typeof s === 'object') ? { map: s.map || {}, at: +s.at || 0 } : { map: {}, at: 0 });
});
app.put('/api/addon-state', requireAuth, async (req, res) => {
  const b = req.body || {};
  const incoming = {
    map: (b.map && typeof b.map === 'object' && !Array.isArray(b.map)) ? b.map : {},
    at: +b.at || 0,
  };
  const stored = await getUserAddonState(req.user.id);
  if (stored && (+stored.at || 0) > incoming.at) {        // stored is newer → keep it
    return res.json({ map: stored.map || {}, at: +stored.at || 0 });
  }
  await setUserAddonState(req.user.id, incoming);
  res.json(incoming);
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
  // Add-on collection: list/remove only. The server never fetches an add-on (no manifest,
  // no streams) — not from the user surface, not from admin — so no SSRF-guarded fetch
  // primitives are handed in.
  addons: { writeAddons },
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
 * server/data/settings.json (Gemini keys) — so it is deliberately gone. The
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
