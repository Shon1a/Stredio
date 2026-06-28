// STREDIO — admin API router.
//
// Mounted at /api/admin behind requireAdmin (see server.js). Powers the admin
// dashboard (admin.html): a control surface for the things that previously had
// no UI at all — the Georgian poster/cover audit and overrides, the machine-
// translation cache (including a "bad translation" detector + live bench),
// user management, and a live system/activity view.
//
// All TMDB/cache/settings plumbing is injected from server.js via `deps` so this
// module owns no duplicate state; the cover store (covers.js) and glossary
// (glossary.js) are singletons imported directly.

import express from 'express';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  listUsers, deleteUser, setUserAdmin, countAdmins, countActiveSessions,
} from './auth.js';
import * as covers from './covers.js';
import * as glossary from './glossary.js';
import { saveJson, readJsonSafe } from './jsonstore.js';
import * as storage from './storage.js';

// ------------------------------------------------------------------ //
//  Activity ring buffer — a lightweight, in-memory event log surfaced
//  in the dashboard. server.js pushes translation events here; the admin
//  endpoints push their own mutations.
// ------------------------------------------------------------------ //
const ACTIVITY_MAX = 250;
const activity = [];
export function recordActivity(type, message, meta) {
  activity.push({ at: new Date().toISOString(), type, message, meta: meta || null });
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
}
function recentActivity(limit = 60) {
  return activity.slice(-limit).reverse();
}

// ------------------------------------------------------------------ //
//  Suspicious-translation detector
// ------------------------------------------------------------------ //
// Georgian: Mkhedruli + Mtavruli (caps) + archaic ranges.
const RE_GEORGIAN = /[Ⴀ-ჿᲐ-Ჿⴀ-⴯]/;
// Scripts that must NOT appear in a Georgian translation (a leak from the source):
// Greek, Cyrillic, Hebrew, Arabic, Devanagari, Thai, Hiragana+Katakana (+phonetic
// ext + half-width), CJK Han, Hangul. Written with \u escapes so every range is
// unambiguously ascending. Latin is intentionally NOT here — kept proper nouns are fine.
const RE_FOREIGN = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿㇰ-ㇿ一-鿿가-힯･-ﾟ]/;
const RE_REPLACEMENT = /�/;

/** Returns a reason string if a translation looks wrong, else null. */
function suspectReason(source, ka) {
  if (ka == null || ka === '') return 'empty';
  if (ka === source) return 'untranslated';
  if (RE_REPLACEMENT.test(ka)) return 'mojibake';
  if (RE_FOREIGN.test(ka)) return 'foreign-script';
  if (!RE_GEORGIAN.test(ka)) return 'no-georgian';
  return null;
}

// tiny concurrency-limited map so the cover audit doesn't fire 20 TMDB calls at once
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

// Cover-browse sources, mirroring the home-page rails. Each carries its TMDB list
// path AND its media type; the type flows through the audit, the image picker, and
// the (type-namespaced) override store, so a movie and a show that share an id never
// collide. Movies first, then shows.
const COVER_SOURCES = {
  trending:     { path: '/trending/movie/week', type: 'movie' },
  popular:      { path: '/movie/popular',       type: 'movie' },
  top_rated:    { path: '/movie/top_rated',     type: 'movie' },
  now_playing:  { path: '/movie/now_playing',   type: 'movie' },
  upcoming:     { path: '/movie/upcoming',      type: 'movie' },
  trending_tv:  { path: '/trending/tv/week',    type: 'tv' },
  popular_tv:   { path: '/tv/popular',          type: 'tv' },
  top_rated_tv: { path: '/tv/top_rated',        type: 'tv' },
  on_the_air:   { path: '/tv/on_the_air',       type: 'tv' },
};

// ------------------------------------------------------------------ //
//  Leaked-script naming — split suspectReason's catch-all "foreign-script"
//  bucket into the actual script that leaked, so the quality view can say
//  "92% of suspicious entries are Cyrillic" (i.e. the model is echoing Russian
//  metadata) instead of one opaque number. Ranges mirror RE_FOREIGN above.
// ------------------------------------------------------------------ //
const SCRIPT_RANGES = [
  ['Cyrillic', /[Ѐ-ԯ]/],
  ['Greek', /[Ͱ-Ͽ]/],
  ['Hebrew', /[֐-׿]/],
  ['Arabic', /[؀-ۿ]/],
  ['Devanagari', /[ऀ-ॿ]/],
  ['Thai', /[฀-๿]/],
  ['Japanese', /[぀-ヿㇰ-ㇿ･-ﾟ]/],
  ['CJK', /[一-鿿]/],
  ['Hangul', /[가-힯]/],
];
function leakedScript(ka) {
  for (const [name, re] of SCRIPT_RANGES) if (re.test(ka)) return name;
  return 'Other';
}
// Fine-grained bucket for the quality histogram: reason, with foreign-script
// resolved to the concrete leaked script.
function qualityBucket(source, ka) {
  const reason = suspectReason(source, ka);
  if (!reason) return null;
  if (reason === 'foreign-script') return 'leak:' + leakedScript(ka);
  return reason;
}

// ------------------------------------------------------------------ //
//  Locked translations — a flat id-set persisted to data/ka-locks.json so a
//  hand-perfected entry is excluded from the "Delete/Fix suspicious" bulk sweeps
//  (which would otherwise clobber human work on the next run).
// ------------------------------------------------------------------ //
let lockSet = null;
async function loadLocks(dataDir) {
  if (lockSet) return lockSet;
  const raw = await readJsonSafe(join(dataDir, 'ka-locks.json'), []);
  lockSet = new Set(Array.isArray(raw) ? raw : []);
  return lockSet;
}
function saveLocks(dataDir) {
  return saveJson(join(dataDir, 'ka-locks.json'), dataDir, () => [...(lockSet || [])])
    .catch(e => console.warn('ka-locks save failed:', e.message));
}

// Live-health probe result cache — probes hit external hosts, so they are
// button-triggered and cached for 60s (?refresh=1 forces a fresh run).
let healthCache = { at: 0, data: null };
const HEALTH_TTL_MS = 60 * 1000;

// A fixed synthetic batch for the translation self-check: exercises the real
// translate → Georgian-validation path on representative text WITHOUT touching
// the live cache. Never persisted.
const SELFCHECK_BATCH = [
  'Action',
  'The Lord of the Rings',
  'A retired detective is pulled back for one last case that hits too close to home.',
];

/* Computed, severity-ranked alerts derived entirely from already-available state —
   no external calls. Surfaced as a cross-view banner in the dashboard. */
function computeAlerts({ cstats, hasTmdb, reliability }) {
  const out = [];
  const push = (level, scope, message) => out.push({ level, scope, message });
  if (!hasTmdb) push('critical', 'system', 'TMDB is not configured — the catalog is offline.');
  // Georgian translation runs on Google Translate's free endpoint (no API key, no
  // quota), so translation degradation only shows up as recent English fallbacks.
  // Only alert on translation degradation that is actually recent (within the last
  // hour) — a stale boot-time fallback count shouldn't nag forever.
  const recentFallback = (reliability.fallbacks || []).some(f => Date.now() - new Date(f.at).getTime() < 3600e3);
  if (recentFallback) push('warn', 'overview', `Served English instead of Georgian ${reliability.fellBack} time(s) since boot — translation is degrading.`);
  if (cstats.flagged > 0) push('info', 'covers', `${cstats.flagged} cover(s) flagged for review.`);
  return out;
}

export function createAdminRouter(deps) {
  const {
    kaCache, scheduleCacheSave, mtTranslateBatch,
    tmdb, IMG, IMGBACK, readSettings, writeSettings, readAddons, hasTmdb, dataDir,
    translationMetrics, addons: addonDeps, serverConfig,
  } = deps;
  const router = express.Router();
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[admin]', e);
    res.status(500).json({ error: e.message || 'Admin error' });
  });

  /* ---- who am I (the dashboard confirms admin access with this) ---- */
  router.get('/me', wrap(async (req, res) => {
    res.json({ user: req.user });
  }));

  /* ---- dashboard aggregate ---- */
  router.get('/stats', wrap(async (req, res) => {
    const entries = [...kaCache.entries()];
    let suspicious = 0, bytes = 0;
    for (const [s, k] of entries) { if (suspectReason(s, k)) suspicious++; bytes += s.length + (k ? k.length : 0); }
    const [admins, sessions, addons] = await Promise.all([
      countAdmins(), countActiveSessions(), readAddons().then(a => a.length).catch(() => 0),
    ]);
    const users = await listUsers();
    const cstats = covers.stats();
    const reliability = translationMetrics ? translationMetrics() : null;
    res.json({
      users: { total: users.length, admins, sessions },
      translations: { entries: entries.length, suspicious, bytes, glossary: glossary.list().counts, reliability, engine: 'Google Translate' },
      covers: cstats,
      addons,
      system: await systemInfo(hasTmdb, dataDir),
      alerts: reliability ? computeAlerts({ cstats, hasTmdb, reliability }) : [],
    });
  }));

  /* ---- activity feed ---- */
  router.get('/activity', wrap(async (req, res) => {
    res.json({ activity: recentActivity(Math.min(+req.query.limit || 80, ACTIVITY_MAX)) });
  }));

  /* ================= Translation cache ================= */
  router.get('/translations', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const onlySuspicious = req.query.filter === 'suspicious';
    const onlyLocked = req.query.filter === 'locked';
    const page = Math.max(1, +req.query.page || 1);
    const pageSize = Math.min(200, Math.max(10, +req.query.pageSize || 50));
    const locks = await loadLocks(dataDir);
    let suspiciousTotal = 0;
    const rows = [];
    for (const [source, ka] of kaCache.entries()) {
      const reason = suspectReason(source, ka);
      if (reason) suspiciousTotal++;
      if (onlySuspicious && !reason) continue;
      if (onlyLocked && !locks.has(source)) continue;
      if (q && !source.toLowerCase().includes(q) && !String(ka).toLowerCase().includes(q)) continue;
      rows.push({ source, ka, reason, locked: locks.has(source) });
    }
    const total = rows.length;
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    res.json({ total, suspiciousTotal, lockedTotal: locks.size, cacheSize: kaCache.size, page, pageSize, items });
  }));

  router.put('/translations', wrap(async (req, res) => {
    const { source, ka } = req.body || {};
    if (!source || typeof source !== 'string') return res.status(400).json({ error: 'source is required' });
    if (typeof ka !== 'string') return res.status(400).json({ error: 'ka (translation) is required' });
    kaCache.set(source, ka);
    scheduleCacheSave();
    recordActivity('translation', `Edited: "${source.slice(0, 40)}"`);
    res.json({ source, ka, reason: suspectReason(source, ka) });
  }));

  router.delete('/translations', wrap(async (req, res) => {
    const locks = await loadLocks(dataDir);
    if (req.query.all === '1') {
      const n = kaCache.size; kaCache.clear(); scheduleCacheSave();
      if (locks.size) { locks.clear(); await saveLocks(dataDir); }   // no entries left → no locks
      recordActivity('translation', `Cleared entire cache (${n} entries)`);
      return res.json({ cleared: n });
    }
    if (req.query.suspicious === '1') {
      let n = 0, preserved = 0;
      for (const [s, k] of [...kaCache.entries()]) {
        if (!suspectReason(s, k)) continue;
        if (locks.has(s)) { preserved++; continue; }   // never nuke a human-locked entry
        kaCache.delete(s); n++;
      }
      scheduleCacheSave();
      recordActivity('translation', `Cleared ${n} suspicious entries${preserved ? ` (${preserved} locked, kept)` : ''}`);
      return res.json({ cleared: n, preserved });
    }
    const source = req.query.source || (req.body || {}).source;
    if (!source) return res.status(400).json({ error: 'source is required' });
    const had = kaCache.delete(source);
    if (locks.has(source)) { locks.delete(source); await saveLocks(dataDir); }   // drop the orphaned lock
    scheduleCacheSave();
    if (had) recordActivity('translation', `Deleted: "${String(source).slice(0, 40)}"`);
    res.json({ deleted: had ? 1 : 0 });
  }));

  // Re-translate chosen entries (explicit list, every suspicious one, or one quality
  // bucket) through Google Translate. Free, so no quota guard.
  router.post('/translations/retranslate', wrap(async (req, res) => {
    const locks = await loadLocks(dataDir);
    let sources = Array.isArray((req.body || {}).sources) ? req.body.sources.filter(s => typeof s === 'string') : [];
    if ((req.body || {}).suspicious) {
      // skip locked entries from the bulk sweep; an explicit single-source retranslate still works
      for (const [s, k] of kaCache.entries()) if (suspectReason(s, k) && !locks.has(s)) sources.push(s);
    }
    // Retranslate one quality bucket (e.g. all "leak:Cyrillic" entries), locks excluded.
    const bucket = (req.body || {}).bucket;
    if (bucket) {
      for (const [s, k] of kaCache.entries()) if (qualityBucket(s, k) === bucket && !locks.has(s)) sources.push(s);
    }
    sources = [...new Set(sources)].slice(0, 200);
    if (!sources.length) return res.status(400).json({ error: 'No sources to retranslate' });
    // Translation runs on Google Translate now (no key required) — no key guard.
    let updated = 0, failed = 0;
    const CHUNK = 25;
    for (let i = 0; i < sources.length; i += CHUNK) {
      const batch = sources.slice(i, i + CHUNK);
      try {
        const out = await mtTranslateBatch(batch);
        batch.forEach((src, j) => { if (out[j]) { kaCache.set(src, String(out[j])); updated++; } else failed++; });
      } catch (e) { failed += batch.length; recordActivity('translation', `Retranslate batch failed: ${e.message}`); }
    }
    scheduleCacheSave();
    recordActivity('translation', `Retranslated ${updated} entries (${failed} failed)`);
    res.json({ updated, failed, requested: sources.length });
  }));

  /* ================= Cover / poster audit ================= */
  // Turn a TMDB list response into per-movie audit rows. Each row carries the
  // Georgian-poster audit AND the full per-language override record, so the UI can
  // render whichever language the admin is currently editing. Shared by the
  // browse-by-source audit and the search-by-title lookup.
  // Audit one TMDB movie/show: reuse the cached poster-language audit (namespaced by
  // type so a movie and a show with the same id don't share a cache row), attach the
  // per-language override record, and tag the row with its media type for the UI.
  const auditOne = async (m, type, refresh) => {
    const id = String(m.id);
    const cacheKey = type === 'tv' ? 'tv:' + id : id;
    let audit = refresh ? null : covers.getAudit(cacheKey);
    if (!audit) {
      audit = await fetchPosterAudit(tmdb, IMG, m, type);
      // Only cache a definitive result. A transient TMDB failure must not be
      // persisted as an authoritative "no Georgian poster" for the 24h TTL.
      if (!audit.error) covers.setAudit(cacheKey, audit);
    }
    return { id, type, ...audit, override: covers.getOverride(id, type) };
  };
  // A single-type list (one home-page rail).
  const auditFromList = (list, type, refresh) =>
    mapLimit((list.results || []).filter(m => m.id).slice(0, 20), 6, m => auditOne(m, type, refresh));
  // A mixed /search/multi result — each row audited with its own media type.
  const auditMixed = (results, refresh) =>
    mapLimit(results.slice(0, 20), 6, m => auditOne(m, m.media_type === 'tv' ? 'tv' : 'movie', refresh));

  router.get('/covers', wrap(async (req, res) => {
    if (!hasTmdb) return res.status(503).json({ error: 'TMDB not configured' });
    const srcKey = COVER_SOURCES[req.query.source] ? req.query.source : 'trending';
    const src = COVER_SOURCES[srcKey];
    const page = Math.max(1, +req.query.page || 1);
    const list = await tmdb(src.path, { language: 'en-US', page });
    const items = await auditFromList(list, src.type, req.query.refresh === '1');
    res.json({ source: srcKey, type: src.type, page: list.page || page, totalPages: list.total_pages || 1, items, stats: covers.stats() });
  }));

  // Search the catalog by title so an admin can jump straight to a specific title to
  // set its cover. /search/multi returns movies AND shows in one list, so the box
  // finds both — each result keeps its own media type.
  router.get('/covers/search', wrap(async (req, res) => {
    if (!hasTmdb) return res.status(503).json({ error: 'TMDB not configured' });
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.json({ source: 'search', query: '', page: 1, totalPages: 1, items: [], stats: covers.stats() });
    const page = Math.max(1, +req.query.page || 1);
    const list = await tmdb('/search/multi', { query: q, page, include_adult: false, language: 'en-US' });
    const results = (list.results || []).filter(m => m.id && (m.media_type === 'movie' || m.media_type === 'tv'));
    const items = await auditMixed(results, req.query.refresh === '1');
    res.json({ source: 'search', query: q, page: list.page || page, totalPages: list.total_pages || 1, items, stats: covers.stats() });
  }));

  router.get('/covers/overrides', wrap(async (req, res) => {
    res.json({ overrides: covers.listOverrides() });
  }));

  // All available posters AND title-logos for one movie — feeds the override
  // "choose poster" + "choose logo" pickers.
  router.get('/covers/:id/images', wrap(async (req, res) => {
    if (!hasTmdb) return res.status(503).json({ error: 'TMDB not configured' });
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const m = await tmdb(`/${type}/${encodeURIComponent(req.params.id)}`, { append_to_response: 'images', include_image_language: 'ka,en,null' });
    const shape = p => ({ url: IMG + p.file_path, lang: p.iso_639_1 || null, vote: p.vote_average || 0, votes: p.vote_count || 0 });
    const posters = (m.images?.posters || []).map(shape);
    const logos = (m.images?.logos || []).map(shape);
    const byLang = (arr, lang) => arr.filter(p => (lang === null ? !p.lang : p.lang === lang));
    res.json({
      id: String(m.id), type, title: m.title || m.name, defaultPoster: m.poster_path ? IMG + m.poster_path : null,
      ka: byLang(posters, 'ka'),
      en: byLang(posters, 'en'),
      neutral: byLang(posters, null),
      // Title-logos (transparent PNG wordmarks), grouped the same way for the picker.
      logos: { ka: byLang(logos, 'ka'), en: byLang(logos, 'en'), neutral: byLang(logos, null) },
      override: covers.getOverride(String(m.id), type),
    });
  }));

  // Set/merge one language's cover. body: { lang:'ka'|'en', type?:'movie'|'tv', poster?, logo?, status?, flagged?, note?, title? }
  router.post('/covers/:id', wrap(async (req, res) => {
    const body = req.body || {};
    const lang = covers.normLang(body.lang);
    const type = body.type === 'tv' ? 'tv' : 'movie';
    if (body.poster && !covers.isValidPosterUrl(body.poster)) {
      return res.status(400).json({ error: 'Invalid poster URL — use a plain http(s) image link (no quotes, spaces or brackets)' });
    }
    if (body.logo && !covers.isValidPosterUrl(body.logo)) {
      return res.status(400).json({ error: 'Invalid logo URL — use a plain http(s) image link (no quotes, spaces or brackets)' });
    }
    const rec = covers.setOverride(req.params.id, lang, body, type);
    await covers.flush();
    const verb = 'logo' in body ? (body.logo ? 'logo set' : 'logo cleared')
      : 'poster' in body ? (body.poster ? 'set' : 'cleared')
      : (body.status ? '→ ' + body.status : 'updated');
    recordActivity('cover', `${lang.toUpperCase()} ${type} cover ${verb} for #${req.params.id}`);
    res.json({ override: rec });
  }));

  // Clear one language (?lang=ka|en) or the whole title override (no lang). ?type=tv for shows.
  router.delete('/covers/:id', wrap(async (req, res) => {
    const lang = req.query.lang ? covers.normLang(req.query.lang) : null;
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const existed = covers.removeOverride(req.params.id, lang, type);
    await covers.flush();
    if (existed) recordActivity('cover', `${lang ? lang.toUpperCase() + ' cover' : 'Override'} cleared for #${req.params.id}`);
    res.json({ removed: existed });
  }));

  /* ================= Featured hero (curated home banner) ================= */
  // The hero selection is a single, language-agnostic config in settings.hero:
  //   { mode:'auto'|'manual', items:[{id,type:'movie'|'tv'}] }
  // 'auto' features Trending Movies; 'manual' shows the admin's ordered pick of
  // movies AND series. The same titles serve both the KA and EN sites.
  const HERO_MODES = new Set(['auto', 'manual']);
  const HERO_MAX = 8;
  // shape a TMDB movie/tv object into a hero picker card (poster for the chooser,
  // backdrop is what actually paints the live hero)
  const heroCard = (m, type) => ({
    id: String(m.id), type,
    title: m.title || m.name || 'Untitled',
    year: (m.release_date || m.first_air_date || '').slice(0, 4) || '',
    poster: m.poster_path ? IMG + m.poster_path : null,
    backdrop: m.backdrop_path ? IMG + m.backdrop_path : null,
  });

  router.get('/hero', wrap(async (req, res) => {
    const settings = await readSettings().catch(() => ({}));
    const h = settings.hero || {};
    const mode = h.mode === 'manual' ? 'manual' : 'auto';
    const stored = (Array.isArray(h.items) ? h.items : [])
      .filter(it => it && /^\d+$/.test(String(it.id)))
      // `bg` is the per-title background-image override the admin picked; it paints
      // that slide's home-page hero. Empty/invalid → the title's TMDB backdrop.
      .map(it => ({
        id: String(it.id), type: it.type === 'tv' ? 'tv' : 'movie',
        bg: (typeof it.bg === 'string' && covers.isValidPosterUrl(it.bg)) ? it.bg : '',
      }))
      .slice(0, HERO_MAX);
    // hydrate each stored id back into a titled card so the console can show what's
    // selected; a title that no longer resolves still renders (so it can be removed).
    // `backdrop` is the TMDB default (the picker's "default"); `bg` is the override.
    let items = stored.map(it => ({ ...it, title: '#' + it.id, year: '', poster: null, backdrop: null }));
    if (hasTmdb && stored.length) {
      items = await mapLimit(stored, 6, async (it) => {
        try { return { ...heroCard(await tmdb(`/${it.type}/${it.id}`, { language: 'en-US' }), it.type), bg: it.bg }; }
        catch { return { ...it, title: '#' + it.id, year: '', poster: null, backdrop: null, missing: true }; }
      });
    }
    res.json({ mode, items });
  }));

  router.put('/hero', wrap(async (req, res) => {
    const body = req.body || {};
    const mode = HERO_MODES.has(body.mode) ? body.mode : 'auto';
    const seen = new Set();
    const items = [];
    for (const it of (Array.isArray(body.items) ? body.items : [])) {
      if (!it || !/^\d+$/.test(String(it.id))) continue;
      const rec = { id: String(it.id), type: it.type === 'tv' ? 'tv' : 'movie' };
      // Optional background-image override, validated against the same CSS-url
      // safety rules as poster overrides (it lands in a `url('…')` context).
      const bg = String(it.bg || '').trim();
      if (bg) {
        if (!covers.isValidPosterUrl(bg)) return res.status(400).json({ error: 'Invalid background image URL' });
        rec.bg = bg;
      }
      const k = rec.type + ':' + rec.id;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(rec);
      if (items.length >= HERO_MAX) break;
    }
    const s = await readSettings();
    s.hero = { mode, items };
    await writeSettings(s);
    recordActivity('cover', mode === 'manual'
      ? `Hero set to manual — ${items.length} title(s)`
      : 'Hero set to automatic (Trending Movies)');
    res.json({ mode, items });
  }));

  // Search movies AND series in one shot so the admin can feature either.
  router.get('/hero/search', wrap(async (req, res) => {
    if (!hasTmdb) return res.status(503).json({ error: 'TMDB not configured' });
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.json({ items: [] });
    const list = await tmdb('/search/multi', { query: q, page: 1, include_adult: false, language: 'en-US' });
    const items = (list.results || [])
      .filter(m => (m.media_type === 'movie' || m.media_type === 'tv') && m.id)
      .slice(0, 18)
      .map(m => heroCard(m, m.media_type));
    res.json({ items });
  }));

  // Candidate background images for one featured title — feeds the hero
  // "choose background" picker. Returns the TMDB default backdrop plus every
  // available backdrop. `thumb` (w500) keeps the grid light; `full` (original,
  // up to ~4K) is what gets stored and painted edge-to-edge on the home hero.
  router.get('/hero/images', wrap(async (req, res) => {
    if (!hasTmdb) return res.status(503).json({ error: 'TMDB not configured' });
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const id = String(req.query.id || '');
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Valid numeric id is required' });
    const m = await tmdb(`/${type}/${id}`, { append_to_response: 'images', include_image_language: 'en,null' });
    // Language-neutral (textless) backdrops first, then English; richer art ranks higher.
    const backdrops = (m.images?.backdrops || [])
      .map(p => ({ thumb: IMG + p.file_path, full: IMGBACK + p.file_path, lang: p.iso_639_1 || null, vote: p.vote_average || 0 }))
      .sort((a, b) => (a.lang === b.lang ? b.vote - a.vote : (a.lang ? 1 : -1)))
      .slice(0, 24);
    res.json({
      id: String(m.id), type, title: m.title || m.name,
      default: m.backdrop_path ? IMGBACK + m.backdrop_path : null,
      backdrops,
    });
  }));

  /* ================= Users ================= */
  router.get('/users', wrap(async (req, res) => {
    res.json({ users: await listUsers() });
  }));

  router.post('/users/:id/admin', wrap(async (req, res) => {
    const make = !!(req.body || {}).admin;
    const r = await setUserAdmin(req.params.id, make);
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    recordActivity('user', `${make ? 'Granted' : 'Revoked'} admin: ${r.user.email}`);
    res.json(r);
  }));

  router.delete('/users/:id', wrap(async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account here' });
    const r = await deleteUser(req.params.id);
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    recordActivity('user', `Deleted user #${req.params.id}`);
    res.json(r);
  }));

  /* ================= Translation Bench — live translate + pipeline self-check ===== */
  // Translate ad-hoc strings through the REAL pipeline (Google Translate + glossary
  // forced-rendering check + Georgian validation). A QA tool: nothing is auto-cached
  // — good rows are promoted one-by-one via the existing PUT /translations.
  router.post('/translate', wrap(async (req, res) => {
    let texts = (req.body || {}).texts;
    if (typeof texts === 'string') texts = texts.split('\n');
    if (!Array.isArray(texts)) return res.status(400).json({ error: 'texts (array of strings) is required' });
    texts = texts.map(s => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, 25);
    if (!texts.length) return res.status(400).json({ error: 'Provide at least one non-empty string' });
    const totalChars = texts.reduce((n, s) => n + s.length, 0);
    if (totalChars > 6000) return res.status(413).json({ error: 'Too much text — keep the batch under 6000 characters' });
    // Translation runs on Google Translate now (no key required) — no key guard.
    const started = Date.now();
    let out;
    try { out = await mtTranslateBatch(texts); }
    catch (e) { return res.status(502).json({ error: e.message || 'Translation failed' }); }
    const latencyMs = Date.now() - started;
    const items = texts.map((source, i) => {
      const ka = out[i] != null ? String(out[i]) : '';
      return { source, ka, reason: suspectReason(source, ka), cached: kaCache.has(source), forced: glossary.forced(source) != null };
    });
    res.json({ items, latencyMs, model: 'Google Translate' });
  }));

  // One-click smoke test of the whole translation path on a fixed synthetic batch.
  // Never touches the live cache — pure self-check of the live engine.
  router.post('/translations/selfcheck', wrap(async (req, res) => {
    const started = Date.now();
    let out;
    try { out = await mtTranslateBatch(SELFCHECK_BATCH); }
    catch (e) { return res.json({ ok: false, error: e.message || 'failed', latencyMs: Date.now() - started }); }
    const latencyMs = Date.now() - started;
    const items = SELFCHECK_BATCH.map((source, i) => {
      const ka = out[i] != null ? String(out[i]) : '';
      return { source, ka, reason: suspectReason(source, ka) };
    });
    const ok = items.every(it => !it.reason);
    recordActivity('translation', `Pipeline self-check ${ok ? 'passed' : 'found issues'} (${latencyMs}ms)`);
    res.json({ ok, items, latencyMs, model: 'Google Translate' });
  }));

  /* ================= Georgian glossary (house style + forced renderings) ========= */
  router.get('/glossary', wrap(async (req, res) => { res.json(glossary.list()); }));
  router.put('/glossary', wrap(async (req, res) => {
    const body = req.body || {};
    const result = glossary.setAll({ dnt: body.dnt, pairs: body.pairs });
    await glossary.flush();
    recordActivity('translation', `Glossary updated (${result.counts.dnt} keep-as-is, ${result.counts.pairs} forced)`);
    res.json(result);
  }));
  // Flag cached entries that don't follow the current glossary (term translated, or
  // forced rendering missing) — so an admin can re-run just those.
  router.get('/translations/glossary-scan', wrap(async (req, res) => {
    const violations = glossary.scanCache(kaCache, 300);
    res.json({ violations, total: violations.length });
  }));

  /* ================= Translation quality breakdown + protected human edits ======= */
  // Histogram of suspicious entries by concrete reason (foreign-script split into the
  // actual leaked script) with samples, turning one opaque number into a diagnosis.
  router.get('/translations/quality', wrap(async (req, res) => {
    const buckets = {};
    let suspicious = 0;
    for (const [s, k] of kaCache.entries()) {
      const b = qualityBucket(s, k);
      if (!b) continue;
      suspicious++;
      const e = buckets[b] || (buckets[b] = { bucket: b, count: 0, samples: [] });
      e.count++;
      if (e.samples.length < 5) e.samples.push({ source: String(s).slice(0, 80), ka: String(k).slice(0, 80) });
    }
    res.json({ total: kaCache.size, suspicious, buckets: Object.values(buckets).sort((a, b) => b.count - a.count) });
  }));
  // Lock / unlock a hand-perfected entry so the bulk "Delete/Fix suspicious" sweeps skip it.
  router.post('/translations/lock', wrap(async (req, res) => {
    const { source, locked } = req.body || {};
    if (!source || typeof source !== 'string') return res.status(400).json({ error: 'source is required' });
    if (!kaCache.has(source)) return res.status(404).json({ error: 'No such cached translation' });
    const locks = await loadLocks(dataDir);
    if (locked) locks.add(source); else locks.delete(source);
    await saveLocks(dataDir);
    res.json({ source, locked: locks.has(source), lockedTotal: locks.size });
  }));

  /* ================= Integrations: Stremio addons (shared-config management) ====== */
  router.get('/addons', wrap(async (req, res) => {
    res.json({ addons: await readAddons() });
  }));
  // Add-on INSTALL is intentionally NOT available server-side. STREDIO's server never
  // contacts an add-on — no manifest fetch, no streams. The shared default add-ons are
  // seeded in data/addons.json; users install their own in the app (browser-validated,
  // see POST /api/addons). Admins may only LIST and REMOVE here.
  router.delete('/addons/:id', wrap(async (req, res) => {
    if (!addonDeps) return res.status(501).json({ error: 'Addon management unavailable' });
    const list = await readAddons();
    const next = list.filter(a => a.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: 'Addon not found' });
    await addonDeps.writeAddons(next);
    recordActivity('addon', `Removed addon: ${req.params.id}`);
    res.json({ removed: req.params.id });
  }));

  /* ================= Live health board — concurrent probes, 60s cached =========== */
  router.get('/health', wrap(async (req, res) => {
    if (req.query.refresh !== '1' && healthCache.data && (Date.now() - healthCache.at) < HEALTH_TTL_MS) {
      return res.json({ ...healthCache.data, cached: true });
    }
    const checks = {};
    await Promise.all([
      (async () => {   // TMDB
        if (!hasTmdb) { checks.tmdb = { ok: false, status: 'not configured' }; return; }
        const t0 = Date.now();
        try { await tmdb('/configuration', {}); checks.tmdb = { ok: true, latencyMs: Date.now() - t0 }; }
        catch (e) { checks.tmdb = { ok: false, latencyMs: Date.now() - t0, error: e.message }; }
      })(),
      (async () => {   // Translation engine — one real round-trip through Google Translate
        const t0 = Date.now();
        try {
          const out = await mtTranslateBatch(['Action']);
          const ok = !!(out && out[0] && RE_GEORGIAN.test(out[0]));
          checks.translation = { ok, latencyMs: Date.now() - t0, engine: 'Google Translate', sample: ok ? out[0] : null };
        } catch (e) { checks.translation = { ok: false, latencyMs: Date.now() - t0, engine: 'Google Translate', error: e.message }; }
      })(),
      // (Add-on health probing removed: the server never contacts an add-on. Add-on
      //  reachability is something each user's browser discovers directly.)
    ]);
    const data = { checkedAt: new Date().toISOString(), checks };
    healthCache = { at: Date.now(), data };
    res.json({ ...data, cached: false });
  }));

  /* ================= Security posture + signup lockdown =========================== */
  router.get('/posture', wrap(async (req, res) => {
    const settings = await readSettings().catch(() => ({}));
    const admins = await countAdmins();
    const cfg = serverConfig || {};
    const signupOpen = settings.signupOpen !== false;
    const xf = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const secureLikely = xf ? xf === 'https' : !!req.socket?.encrypted;
    const rows = [];
    const row = (key, level, label, detail) => rows.push({ key, level, label, detail });
    row('adminEmails', cfg.adminEmailsConfigured ? 'good' : 'warn', 'Admin allowlist',
      cfg.adminEmailsConfigured ? 'ADMIN_EMAILS is set — only listed emails auto-become admin.'
        : 'ADMIN_EMAILS is not set — whoever registered first became admin (race-to-register risk).');
    row('signups', signupOpen ? (cfg.adminEmailsConfigured ? 'good' : 'warn') : 'good', 'New signups',
      signupOpen ? 'Registration is OPEN — anyone can create an account.' : 'Registration is DISABLED — no new accounts can be created.');
    row('admins', admins > 0 ? 'good' : 'bad', 'Admin accounts', `${admins} admin account(s) configured.`);
    row('https', secureLikely ? 'good' : 'warn', 'Secure cookies',
      secureLikely ? 'This request is HTTPS — the session cookie carries the Secure flag.'
        : 'This request looks like plain HTTP — the session cookie is not Secure. Behind a TLS proxy, set TRUST_PROXY=1.');
    row('proxy', 'info', 'Proxy trust', cfg.trustProxy ? 'TRUST_PROXY=1 — the rightmost X-Forwarded-For hop is trusted.'
      : 'TRUST_PROXY is off — client IPs come from the socket (correct for direct exposure).');
    row('session', 'info', 'Session lifetime', `${cfg.sessionTtlDays || 30}-day session cookies.`);
    res.json({ rows, signupOpen });
  }));
  router.patch('/posture', wrap(async (req, res) => {
    const body = req.body || {};
    if (typeof body.signupOpen !== 'boolean') return res.status(400).json({ error: 'signupOpen (boolean) is required' });
    const s = await readSettings();
    s.signupOpen = body.signupOpen;
    await writeSettings(s);
    recordActivity('user', `New signups ${body.signupOpen ? 'ENABLED' : 'DISABLED'}`);
    res.json({ signupOpen: body.signupOpen });
  }));

  /* ================= Redacted data-store backup ================================== */
  router.get('/backup', wrap(async (req, res) => {
    const files = ['users.json', 'sessions.json', 'settings.json', 'addons.json', 'ka-cache.json', 'covers.json', 'glossary.json', 'ka-locks.json'];
    const bundle = {};
    for (const name of files) {
      try {
        bundle[name] = storage.dbEnabled
          ? await storage.readDoc(name, null)
          : JSON.parse(await readFile(join(dataDir, name), 'utf8'));
      } catch { bundle[name] = null; }
    }
    redactBackup(bundle);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="stredio-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    recordActivity('system', 'Downloaded redacted data backup');
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), redacted: true, data: bundle }, null, 2));
  }));

  return router;
}

// ------------------------------------------------------------------ //
//  Helpers
// ------------------------------------------------------------------ //
async function fetchPosterAudit(tmdb, IMG, m, type) {
  const id = String(m.id);
  const title = m.title || m.name || 'Untitled';
  const defaultPoster = m.poster_path ? IMG + m.poster_path : null;
  const year = (m.release_date || m.first_air_date || '').slice(0, 4) || '—';
  try {
    const data = await tmdb(`/${type === 'tv' ? 'tv' : 'movie'}/${id}/images`, { include_image_language: 'ka,en,null' });
    const posters = data.posters || [];
    const byLang = (lang) => posters.filter(p => (p.iso_639_1 || null) === lang).map(p => IMG + p.file_path).slice(0, 6);
    const kaPosters = byLang('ka');
    return {
      title, defaultPoster,
      hasKa: kaPosters.length > 0,
      kaPosters, enPosters: byLang('en'), neutralPosters: byLang(null),
      year,
    };
  } catch {
    // error:true so the caller serves it once but does NOT persist it as a real
    // "no Georgian poster" result (a transient TMDB blip must not poison the cache).
    return { title, defaultPoster, error: true, hasKa: false, kaPosters: [], enPosters: [], neutralPosters: [], year };
  }
}

async function systemInfo(hasTmdb, dataDir) {
  const mem = process.memoryUsage();
  const names = ['users.json', 'sessions.json', 'settings.json', 'addons.json', 'ka-cache.json', 'covers.json', 'glossary.json', 'ka-locks.json'];
  let files;
  if (storage.dbEnabled) {
    // No files on disk — size each document from its stored JSON length instead.
    files = await Promise.all(names.map(async name => {
      try { const v = await storage.readDoc(name, null); return { name, sizeKB: v == null ? 0 : +(Buffer.byteLength(JSON.stringify(v)) / 1024).toFixed(1) }; }
      catch { return { name, sizeKB: 0 }; }
    }));
  } else {
    files = names.map(name => {
      try { return { name, sizeKB: +(statSync(join(dataDir, name)).size / 1024).toFixed(1) }; }
      catch { return { name, sizeKB: 0 }; }
    });
  }
  return {
    tmdb: !!hasTmdb,
    translation: 'Google Translate',
    storage: storage.dbEnabled ? 'Postgres (persistent)' : 'local files',
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
    memoryMB: +(mem.rss / 1048576).toFixed(1),
    dataFiles: files,
  };
}

// Strip every secret out of a data-store bundle before it leaves the box: password
// hashes and session tokens are masked/omitted. A backup is for config + the
// translation cache, never for credentials.
function redactBackup(b) {
  if (Array.isArray(b['users.json'])) {
    b['users.json'] = b['users.json'].map(u => ({ ...u, passwordHash: u && u.passwordHash ? '***redacted***' : undefined }));
  }
  if (b['sessions.json'] && typeof b['sessions.json'] === 'object') {
    b['sessions.json'] = { redacted: `${Object.keys(b['sessions.json']).length} session token(s) omitted` };
  }
}
