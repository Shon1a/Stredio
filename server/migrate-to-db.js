// One-shot migration: copy local server/data/*.json into the Postgres kv store.
//
// Use this once to seed Neon with your existing local data (admin user, cover
// overrides, the translation cache, settings, …) instead of starting empty.
//
//   DATABASE_URL=postgresql://…  node migrate-to-db.js
//
// Idempotent: re-running upserts the same keys. It NEVER deletes anything in the
// database, so a doc already present and newer in the DB is simply overwritten by
// the local copy — only run this when local is the source of truth (the usual
// case: right after setting up the database for the first time).

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as storage from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const FILES = [
  'users.json', 'sessions.json', 'settings.json', 'addons.json',
  'ka-cache.json', 'covers.json', 'logos.json', 'glossary.json', 'ka-locks.json',
];

if (!storage.dbEnabled) {
  console.error('DATABASE_URL is not set — nothing to migrate into. Set it and re-run.');
  process.exit(1);
}

await storage.init();
let migrated = 0, skipped = 0;
for (const name of FILES) {
  const path = join(DATA_DIR, name);
  if (!existsSync(path)) { console.log(`skip  ${name} (no local file)`); skipped++; continue; }
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    await storage.writeDoc(name, data);
    const count = Array.isArray(data) ? `${data.length} items` : `${Object.keys(data || {}).length} keys`;
    console.log(`ok    ${name} → kv '${storage.keyFor(name)}' (${count})`);
    migrated++;
  } catch (e) {
    console.error(`FAIL  ${name}: ${e.message}`);
  }
}
console.log(`\nDone. Migrated ${migrated} document(s), skipped ${skipped}.`);
process.exit(0);
