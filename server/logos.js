// STREDIO — TMDB title-logo lookup cache.
//
// The hero banner and the detail modal show a transparent-PNG title "logo" from
// TMDB in place of the plain text title whenever one exists (e.g. the stylised
// "The Boys" wordmark). TMDB serves these from /{movie|tv}/{id}/images.logos,
// each tagged with a language (iso_639_1) — "en", "ka", or none (neutral).
//
// Resolving a logo means hitting /images, which we must NOT do on every hero /
// meta render. This module caches the best per-language logo *file_path* per
// title on disk (data/logos.json) with a weekly TTL (logos rarely change). The
// per-language ADMIN OVERRIDE (a hand-picked custom logo) lives in covers.js;
// this module is only the automatic TMDB fallback cache. Zero dependencies.
//
// On-disk shape (data/logos.json):
//   { cache: { "<type>:<id>": { ka, en, neutral, checkedAt } } }
// where ka/en/neutral are TMDB file_paths ("/abc.png") or null.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJson, readJsonSafe } from './jsonstore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const FILE = join(DATA_DIR, 'logos.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check a title's logos at most once a week
const MAX_ENTRIES = 3000;               // bound the cache; evict oldest beyond this

let state = { cache: {} };
let loaded = false;
let saveTimer = null;

const persist = () => saveJson(FILE, DATA_DIR, () => state).catch(e => console.warn('logos.json save failed:', e.message));
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
  if (raw && raw.cache && typeof raw.cache === 'object') state.cache = raw.cache;
}

const keyFor = (id, type) => `${type === 'tv' ? 'tv' : 'movie'}:${id}`;

/** Best per-language logo paths for a title, or null if not cached / stale. */
export function getCached(id, type) {
  const e = state.cache[keyFor(id, type)];
  if (!e) return null;
  if (Date.now() - new Date(e.checkedAt).getTime() > TTL_MS) return null;
  return e;
}

/** Cache the chosen per-language logo paths (any of ka/en/neutral may be null). */
export function setCached(id, type, langs = {}) {
  state.cache[keyFor(id, type)] = {
    ka: langs.ka || null,
    en: langs.en || null,
    neutral: langs.neutral || null,
    checkedAt: new Date().toISOString(),
  };
  const ids = Object.keys(state.cache);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => new Date(state.cache[a].checkedAt) - new Date(state.cache[b].checkedAt));
    for (const k of ids.slice(0, ids.length - MAX_ENTRIES)) delete state.cache[k];
  }
  scheduleSave();
}
