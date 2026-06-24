// STREDIO — Georgian localization glossary (forced renderings + keep-as-is terms).
//
// Google Translate (server.js: googleTranslateOne) translates each string
// independently, so a recurring brand or franchise term can come back rendered
// inconsistently across titles, with no operator control. This module is the
// admin-curated term base that fixes the cases that matter:
//
//   1) forced pairs (en -> ka): the canonical Georgian rendering of a term. When an
//      ENTIRE source string equals a pair's English side, translateToKa short-
//      circuits the translator completely (forced()) — a deterministic, instant,
//      never-"suspicious" answer.
//   2) do-not-translate (dnt): terms that must survive verbatim. A source string that
//      IS exactly a dnt term is kept as-is by forced(). (Google already leaves most
//      proper nouns alone; if it mistranslates a specific term mid-sentence, add a
//      forced pair for that whole title.) scanCache() also flags cached entries where
//      a dnt term or forced rendering wasn't honored, so an admin can re-run just those.
//
// Everything is capped (term counts + per-term length) and fails OPEN: an empty
// glossary is a complete no-op. State persists to data/glossary.json. Zero external
// dependencies; mirrors the covers.js singleton + jsonstore pattern.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJson, readJsonSafe } from './jsonstore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const FILE = join(DATA_DIR, 'glossary.json');

// Caps — the ceilings that keep the live prompt bounded.
const MAX_DNT = 200;
const MAX_PAIRS = 200;
const MAX_TERM = 80;        // per do-not-translate term / pair English side
const MAX_KA = 160;         // per forced Georgian rendering

let state = { dnt: [], pairs: [] };
let loaded = false;
let saveTimer = null;
// Derived lookups for the hot path, rebuilt on every mutation/load.
let forcedMap = new Map();  // lowercased trimmed EN -> KA (whole-string short-circuit)
let dntSet = new Set();      // lowercased do-not-translate terms (O(1) whole-string match)

const persist = () => saveJson(FILE, DATA_DIR, () => state).catch(e => console.warn('glossary.json save failed:', e.message));
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 1200);
}
export async function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persist();
}

function clean(s, max) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, max); }

function rebuild() {
  forcedMap = new Map();
  for (const p of state.pairs) {
    const en = p.en.toLowerCase();
    if (!forcedMap.has(en)) forcedMap.set(en, p.ka);
  }
  dntSet = new Set(state.dnt.map(t => t.toLowerCase()));
}

export async function init() {
  if (loaded) return;
  loaded = true;
  const raw = await readJsonSafe(FILE, null);
  if (raw) setAll(raw, false);
}

/** Replace the whole glossary (the admin UI edits the two lists and PUTs them). */
export function setAll(next = {}, save = true) {
  const dntRaw = Array.isArray(next.dnt) ? next.dnt : [];
  const pairsRaw = Array.isArray(next.pairs) ? next.pairs : [];
  // de-dupe do-not-translate terms case-insensitively, drop blanks
  const seen = new Set();
  const dnt = [];
  for (const t of dntRaw) {
    const v = clean(t, MAX_TERM);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dnt.push(v);
    if (dnt.length >= MAX_DNT) break;
  }
  const seenP = new Set();
  const pairs = [];
  for (const p of pairsRaw) {
    const en = clean(p && p.en, MAX_TERM);
    const ka = clean(p && p.ka, MAX_KA);
    if (!en || !ka) continue;
    const k = en.toLowerCase();
    if (seenP.has(k)) continue;
    seenP.add(k);
    pairs.push({ en, ka });
    if (pairs.length >= MAX_PAIRS) break;
  }
  state = { dnt, pairs };
  rebuild();
  if (save) scheduleSave();
  return list();
}

/** Public view for the admin API. */
export function list() {
  return { dnt: state.dnt.slice(), pairs: state.pairs.map(p => ({ ...p })), counts: { dnt: state.dnt.length, pairs: state.pairs.length } };
}

export function isEmpty() { return state.dnt.length === 0 && state.pairs.length === 0; }

/**
 * The whole-string forced rendering for `source`, or null. Used by translateToKa to
 * answer deterministically WITHOUT calling the translator. Whole-string, case-folded
 * match only — never a substring (a substring replace would corrupt Georgian
 * morphology mid-word). A do-not-translate term that IS the entire string resolves
 * to itself (kept verbatim).
 */
export function forced(source) {
  if (isEmpty()) return null;
  const s = String(source == null ? '' : source).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  const hit = forcedMap.get(low);
  if (hit != null) return hit;
  // an exact do-not-translate term: keep it verbatim (O(1) Set lookup)
  if (dntSet.has(low)) return s;
  return null;
}

/**
 * Scan a cache (Map of source -> ka) for entries that violate the glossary:
 *   • a source containing a do-not-translate term whose translation no longer
 *     contains that term verbatim (the model translated something it shouldn't), or
 *   • a source containing a forced English term whose canonical Georgian rendering
 *     is absent from the translation.
 * Heuristic but useful; capped. Returns [{ source, ka, term, kind }].
 */
export function scanCache(cache, limit = 300) {
  const out = [];
  if (isEmpty()) return out;
  const dntLower = state.dnt.map(t => ({ t, l: t.toLowerCase() }));
  for (const [source, ka] of cache.entries()) {
    if (out.length >= limit) break;
    const src = String(source || '');
    const low = src.toLowerCase();
    const kaStr = String(ka || '');
    for (const { t, l } of dntLower) {
      if (low.includes(l) && !kaStr.includes(t)) { out.push({ source: src, ka: kaStr, term: t, kind: 'dnt' }); break; }
    }
    if (out.length >= limit) break;
    for (const p of state.pairs) {
      if (low.includes(p.en.toLowerCase()) && !kaStr.includes(p.ka)) { out.push({ source: src, ka: kaStr, term: p.en, kind: 'pair' }); break; }
    }
  }
  return out;
}
