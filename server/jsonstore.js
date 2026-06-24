// STREDIO — durable JSON file writes.
//
// The data-store modules (covers, glossary, …) debounce saves and also expose
// a flush(). Naively, a flush() that fires while a debounced write is already
// in-flight issues a SECOND concurrent writeFile() to the same path; two
// overlapping truncate+writes can interleave and leave corrupt JSON, which then
// silently wipes the store on the next parse. This helper removes both hazards:
//   • per-file serialization — writes to one path run strictly one-after-another,
//   • atomic replace — write to <file>.tmp then rename() over the target, so a
//     crash or overlap can never truncate the live file.

import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dbEnabled, readDoc, writeDoc, keyFor } from './storage.js';

const chains = new Map(); // file -> Promise (tail of that file's write queue)

/**
 * Queue an atomic write of `getData()`'s JSON to `file`. `getData` is invoked at
 * write time (not call time) so a queued write always persists the latest state.
 * Returns a promise that resolves when this write lands.
 */
export function saveJson(file, dir, getData) {
  const prev = chains.get(file) || Promise.resolve();
  // Persist to Postgres (durable, atomic upsert) when configured, else to disk.
  // The per-file chain is kept in both modes so writes to one store still apply
  // strictly in call order (last-write-wins races can't reorder).
  const next = prev.catch(() => {}).then(async () => {
    if (dbEnabled) { await writeDoc(file, getData()); return; }
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(getData(), null, 2), 'utf8');
    await rename(tmp, file);
  });
  chains.set(file, next);
  // Don't let the chain hold rejections forever; callers that await get the error.
  next.finally(() => { if (chains.get(file) === next) chains.set(file, Promise.resolve()); });
  return next;
}

/**
 * Read+parse a JSON file. On a parse error, move the bad file aside to
 * <file>.corrupt-<ts> (best effort) and return `fallback`, so a corrupted store
 * is quarantined for inspection instead of being silently overwritten with empty
 * state on the next save.
 */
export async function readJsonSafe(file, fallback) {
  if (dbEnabled) {
    try { return await readDoc(file, fallback); }
    catch (e) { console.warn(`KV read failed (${keyFor(file)}): ${e.message}`); return fallback; }
  }
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    try { await rename(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    console.warn(`Corrupt JSON quarantined: ${file} (${e.message})`);
    return fallback;
  }
}
