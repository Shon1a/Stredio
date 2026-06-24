// STREDIO — persistent document storage.
//
// The whole app keeps state as a handful of whole-JSON "documents": users,
// sessions, settings, addons, ka-cache, covers, logos, glossary, ka-locks.
// Locally each is a file under server/data/. In production on Render the
// filesystem is EPHEMERAL — wiped on every restart/redeploy — so any account,
// session or setting silently vanishes. When DATABASE_URL is set we instead
// store each document as one row in a Postgres `kv` table (Neon), which survives
// restarts. No SQL leaks into the rest of the app: callers still read and write
// whole documents by a logical name (or by their existing data-file path).
//
// Backend selection:
//   • DATABASE_URL set   → Postgres (Neon). One table: kv(key, value jsonb).
//   • DATABASE_URL unset → local JSON files (unchanged dev behavior).

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
export const dbEnabled = !!DATABASE_URL;

let pool = null;
let readyP = null;

// Connect (once) and ensure the table exists. Idempotent — every read/write
// awaits this, and concurrent callers share the single in-flight promise.
export function init() {
  if (!dbEnabled) return Promise.resolve();
  if (readyP) return readyP;
  readyP = (async () => {
    // Neon (and most hosted Postgres) require TLS. rejectUnauthorized:false keeps
    // the connection encrypted without bundling the provider's CA chain.
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS kv (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  })().catch(e => { readyP = null; throw e; });  // allow a later retry if the first connect fails
  return readyP;
}

// Map a logical name OR a data-file path to a stable kv key. Callers that already
// hold a file path (jsonstore, auth, server) can pass it straight through: we key
// on the basename without ".json", which is unique across the app's stores
// (users, sessions, settings, addons, ka-cache, covers, logos, glossary, ka-locks).
export function keyFor(nameOrPath) {
  const base = String(nameOrPath).replace(/\\/g, '/').split('/').pop() || String(nameOrPath);
  return base.replace(/\.json$/i, '');
}

export async function readDoc(nameOrPath, fallback) {
  await init();
  const key = keyFor(nameOrPath);
  const { rows } = await pool.query('SELECT value FROM kv WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;   // pg parses jsonb back into JS
}

export async function writeDoc(nameOrPath, data) {
  await init();
  const key = keyFor(nameOrPath);
  await pool.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(data)],
  );
}

// Every stored document keyed by its kv key (used by the admin backup/export).
export async function allDocs() {
  await init();
  const { rows } = await pool.query('SELECT key, value FROM kv');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
