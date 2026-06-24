// STREDIO — movie cover (poster) overrides + Georgian-localization audit.
//
// TMDB posters are bitmaps with the title baked into the artwork, so a single
// poster can't serve both languages: the Georgian site wants a cover lettered in
// Georgian, the English site wants the English one. This module therefore stores
// a SEPARATE poster override per UI language ('ka' and 'en') for each movie, each
// with its own flag/status/note. server.js applies the override for whichever
// language the visitor is browsing in (getOverridePoster(id, lang)); the admin
// dashboard edits each language independently.
//
// It also caches a Georgian-localization audit (does TMDB even ship a `ka`
// poster for this title?) so the admin grid doesn't re-hit TMDB on every view.
// State persists to data/covers.json. Zero external dependencies.
//
// On-disk shape (data/covers.json):
//   overrides: {
//     "<tmdbId>": {
//       title, updatedAt,
//       ka?: { poster, status, flagged, note, updatedAt },
//       en?: { poster, status, flagged, note, updatedAt }
//     }
//   }
// Legacy files used a single top-level `poster` per movie; init() migrates those
// in place by applying that one cover to BOTH languages (so nothing visibly
// changes until the admin sets a different cover for one language).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJson, readJsonSafe } from './jsonstore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const FILE = join(DATA_DIR, 'covers.json');
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000; // re-check a movie's posters at most once a day

export const COVER_STATUSES = ['ok', 'bad_font', 'missing', 'fixed'];
export const COVER_LANGS = ['en', 'ka'];

/** Collapse any language input ("ka", "ka-GE", "en-US", undefined) to 'ka' | 'en'. */
export function normLang(l) { return String(l || '').toLowerCase().startsWith('ka') ? 'ka' : 'en'; }

/** Namespace the override key by media type so a movie id and a TV id that share
 *  the same number can never collide. Movies keep their bare id (back-compat with
 *  every existing entry in covers.json); TV ids are stored under a "tv:" prefix. */
function keyOf(id, type) { return type === 'tv' ? 'tv:' + String(id) : String(id); }

// A poster override URL is emitted verbatim into the PUBLIC catalog JSON and then
// into a CSS `url('…')` context by the frontends. Validate it here so a value
// containing a quote/paren/bracket/whitespace can never break out of that context
// (stored CSS injection). Must be a plain http(s) URL with no dangerous chars.
function safePosterUrl(raw) {
  const s = String(raw || '').trim().slice(0, 500);
  if (!s) return null;
  if (/['"()<>\\\s]/.test(s)) return null;          // chars that could escape url('…')
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return s;
}
/** True if `raw` is an acceptable poster override URL (used by the admin API to 400 early). */
export function isValidPosterUrl(raw) { return safePosterUrl(raw) !== null; }

let state = { overrides: {}, audit: {} };
let loaded = false;
let saveTimer = null;
const persist = () => saveJson(FILE, DATA_DIR, () => state).catch(e => console.warn('covers.json save failed:', e.message));

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 1200);
}
export async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persist();
}

export async function init() {
  if (loaded) return;
  loaded = true;
  const raw = await readJsonSafe(FILE, null);
  if (!raw) return;
  const rawOverrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
  let migratedAny = false;
  const overrides = {};
  for (const [id, o] of Object.entries(rawOverrides)) {
    const before = JSON.stringify(o);
    const next = migrateOverride(o);
    if (next) {
      overrides[id] = next;
      if (JSON.stringify(next) !== before) migratedAny = true;
    } else {
      migratedAny = true; // an empty/garbage entry was dropped
    }
  }
  state.overrides = overrides;
  state.audit = raw.audit && typeof raw.audit === 'object' ? raw.audit : {};
  // Upgrade the on-disk file once so we never re-migrate on every boot.
  if (migratedAny) scheduleSave();
}

// ------------------------------------------------------------------ //
//  Migration + normalisation helpers
// ------------------------------------------------------------------ //

// Sanitise one per-language block; returns null if it carries no real signal
// (so empty blocks are pruned rather than persisted as noise).
function cleanLangBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const poster = b.poster ? safePosterUrl(b.poster) : null;
  // A custom title-logo (transparent PNG) for this language, independent of the
  // poster — the hero/detail title renders this in place of the text title.
  const logo = b.logo ? safePosterUrl(b.logo) : null;
  const flagged = !!b.flagged;
  const note = String(b.note || '').slice(0, 300);
  const status = COVER_STATUSES.includes(b.status) ? b.status : (poster ? 'fixed' : 'ok');
  if (!poster && !logo && !flagged && !note && status === 'ok') return null;
  return { poster, logo, status, flagged, note, updatedAt: b.updatedAt || new Date().toISOString() };
}

function pack(title, ka, en, updatedAt) {
  const out = { title: title || '', updatedAt: updatedAt || new Date().toISOString() };
  if (ka) out.ka = ka;
  if (en) out.en = en;
  return out;
}

// Accepts either the new per-language shape or the legacy single-poster shape and
// returns the canonical new shape (or null if there's nothing worth keeping).
function migrateOverride(o) {
  if (!o || typeof o !== 'object') return null;
  const title = o.title ? String(o.title).slice(0, 200) : '';
  if ('ka' in o || 'en' in o) {            // already per-language
    const ka = cleanLangBlock(o.ka);
    const en = cleanLangBlock(o.en);
    if (!ka && !en) return null;
    return pack(title, ka, en, o.updatedAt);
  }
  // Legacy: one poster shown in both languages. Preserve that exact behaviour by
  // copying the same block into ka AND en.
  const block = cleanLangBlock(o);
  if (!block) return null;
  return pack(title, { ...block }, { ...block }, o.updatedAt);
}

// ------------------------------------------------------------------ //
//  Overrides — read by server.js on the hot path, written by the admin API
// ------------------------------------------------------------------ //

// A legacy flat record ({poster,status,...} with no ka/en) presented as a
// per-language block — so reads keep working even if an un-migrated entry slips
// in at runtime (defence in depth; init() already migrates the file on boot).
function legacyBlock(o) {
  if (!o || ('ka' in o) || ('en' in o) || !o.poster) return null;
  return { poster: o.poster, logo: o.logo || null, status: o.status || 'fixed', flagged: !!o.flagged, note: o.note || '', updatedAt: o.updatedAt };
}

/** The replacement poster URL for a movie id in a given language, or null.
 *  Called per-movie in mapMovie, so it stays a plain object lookup. A not-yet-
 *  migrated legacy poster falls back to serving BOTH languages. */
export function getOverridePoster(id, lang, type) {
  const o = state.overrides[keyOf(id, type)];
  if (!o) return null;
  const b = o[normLang(lang)];
  if (b && b.poster) return b.poster;
  return o.poster || null;   // legacy flat fallback
}

/** The admin's custom title-logo URL for a movie id in a given language, or null.
 *  No legacy fallback: logos are a newer feature, so old flat records have none. */
export function getOverrideLogo(id, lang, type) {
  const o = state.overrides[keyOf(id, type)];
  if (!o) return null;
  const b = o[normLang(lang)];
  return (b && b.logo) || null;
}

/** The whole per-movie override record (both languages), for the admin UI.
 *  A legacy flat entry is normalised to the per-language shape on the way out so
 *  the dashboard always sees ka/en. */
export function getOverride(id, type) {
  const o = state.overrides[keyOf(id, type)] || null;
  const legacy = legacyBlock(o);
  if (legacy) return { title: o.title || '', updatedAt: o.updatedAt, ka: { ...legacy }, en: { ...legacy } };
  return o;
}

/** Just one language's block, or null (legacy flat poster serves either). */
export function getLangOverride(id, lang, type) {
  const o = state.overrides[keyOf(id, type)];
  if (!o) return null;
  return o[normLang(lang)] || legacyBlock(o) || null;
}

/** Set/merge one language's cover for a movie. `patch` may carry poster, status,
 *  flagged, note (per-language) and title (movie-level). Returns the full record
 *  (or null if the movie no longer has any override after the change). */
export function setOverride(id, lang, patch = {}, type) {
  const key = keyOf(id, type);
  const L = normLang(lang);
  // Heal a legacy flat record before editing so we never leave a hybrid
  // {poster, ka, en} entry behind.
  let rec = state.overrides[key];
  if (legacyBlock(rec)) rec = migrateOverride(rec);
  rec = rec || { title: '', updatedAt: new Date().toISOString() };
  const next = { ...(rec[L] || {}) };

  if ('poster' in patch) next.poster = patch.poster ? safePosterUrl(patch.poster) : null;
  // Title-logo is set/cleared independently of the poster and does NOT touch the
  // cover status (it's not the poster being "fixed").
  if ('logo' in patch) next.logo = patch.logo ? safePosterUrl(patch.logo) : null;
  if ('flagged' in patch) next.flagged = !!patch.flagged;
  if ('status' in patch && COVER_STATUSES.includes(patch.status)) next.status = patch.status;
  if ('note' in patch) next.note = String(patch.note || '').slice(0, 300);
  // Choosing a replacement poster implicitly marks the cover "fixed" and clears a
  // prior bad-font flag (the poster IS the fix), unless an explicit status came in.
  if (patch.poster && !('status' in patch)) { next.status = 'fixed'; if (!('flagged' in patch)) next.flagged = false; }
  // Clearing the poster must drop the auto-set "fixed" status so the now-empty
  // block can be pruned below.
  if ('poster' in patch && !patch.poster && next.status === 'fixed') next.status = 'ok';
  next.updatedAt = new Date().toISOString();

  if ('title' in patch && patch.title) rec.title = String(patch.title).slice(0, 200);

  // Prune an empty language block (nothing flagged, no poster/logo/note, default status).
  if (!next.poster && !next.logo && !next.flagged && !next.note && (!next.status || next.status === 'ok')) {
    delete rec[L];
  } else {
    rec[L] = next;
  }
  rec.updatedAt = new Date().toISOString();

  // An override with neither language left is just noise.
  if (!rec.ka && !rec.en) { delete state.overrides[key]; scheduleSave(); return null; }
  state.overrides[key] = rec;
  scheduleSave();
  return rec;
}

/** Remove one language's cover (lang given) or the whole movie override (no lang).
 *  Returns true if something was actually removed. */
export function removeOverride(id, lang, type) {
  const key = keyOf(id, type);
  const rec = state.overrides[key];
  if (!rec) return false;
  if (lang) {
    const L = normLang(lang);
    const had = !!rec[L];
    delete rec[L];
    if (!rec.ka && !rec.en) delete state.overrides[key];
    else rec.updatedAt = new Date().toISOString();
    scheduleSave();
    return had;
  }
  delete state.overrides[key];
  scheduleSave();
  return true;
}

export function listOverrides() {
  return Object.entries(state.overrides).map(([key, o]) => {
    const isTv = key.startsWith('tv:');
    return { id: isTv ? key.slice(3) : key, type: isTv ? 'tv' : 'movie', ...o };
  });
}

// ------------------------------------------------------------------ //
//  Audit cache — avoids re-hitting TMDB /images for every page view
// ------------------------------------------------------------------ //
export function getAudit(id) {
  const a = state.audit[String(id)];
  if (!a) return null;
  if (Date.now() - new Date(a.checkedAt).getTime() > AUDIT_TTL_MS) return null; // stale
  return a;
}
export function setAudit(id, data) {
  state.audit[String(id)] = { ...data, checkedAt: new Date().toISOString() };
  // keep the cache from growing without bound
  const ids = Object.keys(state.audit);
  if (ids.length > 2000) {
    ids.sort((a, b) => new Date(state.audit[a].checkedAt) - new Date(state.audit[b].checkedAt));
    for (const k of ids.slice(0, ids.length - 2000)) delete state.audit[k];
  }
  scheduleSave();
}

export function stats() {
  const entries = Object.values(state.overrides);
  let kaPosters = 0, enPosters = 0, kaLogos = 0, enLogos = 0, withPoster = 0, flagged = 0;
  for (const o of entries) {
    const hasKa = !!(o.ka && o.ka.poster), hasEn = !!(o.en && o.en.poster);
    if (hasKa) kaPosters++;
    if (hasEn) enPosters++;
    if (o.ka && o.ka.logo) kaLogos++;
    if (o.en && o.en.logo) enLogos++;
    if (hasKa || hasEn) withPoster++;
    const flagKa = o.ka && (o.ka.flagged || o.ka.status === 'bad_font');
    const flagEn = o.en && (o.en.flagged || o.en.status === 'bad_font');
    if (flagKa || flagEn) flagged++;
  }
  const audited = Object.values(state.audit);
  return {
    overrides: entries.length,
    withPoster,
    kaPosters,
    enPosters,
    kaLogos,
    enLogos,
    flagged,
    fixed: withPoster,
    audited: audited.length,
    missingKa: audited.filter(a => !a.hasKa).length,
  };
}
