// Supervisor for the Georgian / Russian / Ukrainian dubbed Stremio addon.
//
// That addon runs as a SIBLING Node process on :7000 (see ../../georgian-stremio-addon)
// and is the ONLY source of Georgian (ge.movie) and Ukrainian (UAFlix) dub streams —
// Russian (HDRezka) too, though Russian/English also arrive via Torrentio. When that
// process is down, Georgian + Ukrainian silently disappear from the stream modal while
// everything else keeps working — the exact "ka/uk missing" symptom. It was a manually
// started, unsupervised process, so a single crash (or a forgotten launch) wiped those
// languages until someone noticed. The main server now spawns and watchdogs it so the
// two stay up together.
//
// Opt out with GEORGIAN_ADDON_SUPERVISE=0 (e.g. when running the addon yourself or on a
// host that points community.georgian.dubbed at a remote URL instead of localhost).

import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENTRY = process.env.GEORGIAN_ADDON_PATH
  || resolve(__dirname, '..', '..', 'georgian-stremio-addon', 'index.js');
const PORT = +(process.env.GEORGIAN_ADDON_PORT || 7000) || 7000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/manifest.json`;

let child = null;
let stopping = false;
let restarts = 0;

// Is something already serving the addon on :7000? (manual launch, leftover process…)
async function isUp() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

function launch() {
  // Log to files beside the addon, mirroring how it was run by hand, so a crash loop
  // is debuggable instead of vanishing into /dev/null.
  const dir = dirname(ENTRY);
  let out = 'ignore', err = 'ignore';
  try {
    out = openSync(resolve(dir, 'addon.out.log'), 'a');
    err = openSync(resolve(dir, 'addon.err.log'), 'a');
  } catch { /* unwritable dir → discard output, still run */ }

  child = spawn(process.execPath, [ENTRY], {
    cwd: dir,
    stdio: ['ignore', out, err],
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  console.log(`  Georgian addon     → spawned (pid ${child.pid}) on :${PORT}`);

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    // Exponential backoff capped at 30s. On the next attempt start() re-checks isUp(),
    // so an EADDRINUSE exit (another instance already bound :7000) is adopted, not looped.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(restarts, 5));
    restarts++;
    console.warn(`  Georgian addon     → exited (${signal || code}); restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (!stopping) start(); }, delay);
  });

  child.on('error', e => {
    console.warn(`  Georgian addon     → spawn error: ${e.message}`);
  });
}

// Best-effort: never throws, so a boot failure here can't take down the catalog.
export async function start() {
  if (String(process.env.GEORGIAN_ADDON_SUPERVISE || '') === '0') return;
  if (!existsSync(ENTRY)) {
    console.warn(`  Georgian addon     → entry not found (${ENTRY}); Georgian/Ukrainian dubs unavailable`);
    return;
  }
  if (await isUp()) {
    console.log(`  Georgian addon     → already running on :${PORT} (adopted)`);
    return;
  }
  launch();
}

// Don't orphan the child when the main server stops.
function shutdown() {
  stopping = true;
  if (child) { try { child.kill(); } catch { /* already gone */ } }
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
