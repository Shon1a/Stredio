# STREDIO

**A personal media library and browser — a metadata catalog and player UI, in the spirit of [Stremio](https://www.stremio.com/).**

STREDIO is a discovery-and-playback front-end for movies and TV. It shows a rich catalog built from public metadata (TMDB), and it plays media through **add-ons that the user installs** — exactly like Stremio. STREDIO itself hosts no media and never sits in the streaming path.

> ⚖️ **STREDIO hosts no video files and stores no media on its servers.** The catalog shows descriptive metadata only. Any playable source comes from a third-party add-on that **you** choose to install, and **your browser connects to it directly** — STREDIO's servers never fetch, proxy, relay, rank, or store streams. See **[Legal posture](#-legal-posture)** below.

---

## What it is

- A **metadata catalog** (titles, posters, cast, ratings, seasons/episodes) built from **TMDB**, with optional Georgian (`ka`) machine translation.
- A **Stremio-compatible add-on client**. You install standard Stremio add-ons by URL. From then on your **browser** talks to those add-ons directly to fetch catalogs, streams, and subtitles.
- A **player** that plays the direct/HLS URL an add-on returns — including streams resolved through **your own debrid account** (Real-Debrid, TorBox, etc.) when you install a debrid-configured add-on URL. The debrid key lives only in that add-on URL; STREDIO never sees or uses it.
- **Cross-device sync** of your account (watchlist, continue-watching, installed add-on collection).

## Architecture (same model as Stremio)

```
        ┌─────────────────────────── your browser ───────────────────────────┐
        │  STREDIO UI (index.html)                                            │
        │     │                          │                                    │
        │     │ /api/* (metadata,        │ direct fetch (manifest, stream,    │
        │     │ account, add-on list)    │ subtitle, catalog) + playback      │
        ▼     ▼                          ▼                                    ▼
   ┌────────────────┐            ┌───────────────────┐              ┌──────────────────┐
   │ STREDIO server │            │ installed add-ons │  ── debrid ─▶│ your debrid acct │
   │ (Express)      │            │ (3rd-party URLs)  │              └──────────────────┘
   │ • TMDB metadata│            └───────────────────┘
   │ • account/sync │              ▲ the server is NEVER on this path
   │ • add-on LIST  │
   └────────────────┘
```

- **The server only ever fetches its own trusted upstreams:** TMDB (metadata), Google Translate (Georgian strings), and IntroDB (skip-intro timestamps). It makes **zero** requests to any add-on.
- **All add-on traffic is client-side.** The browser fetches each installed add-on's `manifest.json`, `stream/…`, `subtitles/…`, and `catalog/…` directly (add-ons send permissive CORS, like they do for Stremio Web). Subtitles are fetched, gunzipped, and converted to WebVTT in the browser.
- **The server stores only the add-on *collection*** (the list of installed URLs) so it syncs across your devices — never the streams those add-ons return.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Single `index.html` — vanilla JS, inline CSS, no build step. `hls.js` vendored at `/assets/hls.min.js`. |
| Backend | Node.js + **Express** (ESM). TMDB proxy, auth (scrypt sessions + Google OAuth), account/sync. |
| Storage | JSON files by default; **Postgres (Neon)** when `DATABASE_URL` is set (Render's FS is ephemeral). |
| Metadata | **TMDB** API. |
| Translation | Google Translate free endpoint (EN→KA), cached. |

## Getting started

```bash
cd server
npm install
cp .env.example .env     # then fill in the values below
npm start                # http://localhost:8787   (npm run dev = watch mode)
```

The **first account to register becomes the admin** (or set `ADMIN_EMAILS`). The admin dashboard lives at `/admin`.

### Environment variables (`server/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `TMDB_BEARER` *or* `TMDB_API_KEY` | ✅ | TMDB credentials for the metadata catalog. |
| `PORT` | – | Server port (default `8787`). |
| `DATABASE_URL` | – | Neon/Postgres connection string. Unset ⇒ local JSON files. |
| `GOOGLE_CLIENT_ID` | – | Enables "Sign in with Google". |
| `ADMIN_EMAILS` | – | Comma-separated admin allowlist. |
| `CORS_ORIGINS` | – | Allowed frontend origins (split deploy). |
| `TRUST_PROXY` | – | Set `1` behind a TLS proxy (e.g. Render) for secure cookies. |
| `DISABLE_KA_TRANSLATE` | – | Set `1` to turn off Georgian machine translation. |
| `KA_TRANSLATE_CONCURRENCY` | – | Translation request concurrency. |
| `IMG_CDN_BASE` | – | Optional image CDN base for posters. |

### Deployment (split)

- **Frontend** → Vercel (serve `index.html` + `/assets`).
- **Backend** → Render (`cd server && npm start`); set `DATABASE_URL`, `CORS_ORIGINS`, `TRUST_PROXY=1`.
- **Database** → Neon (Postgres). Seed once with `npm run migrate`.

The frontend auto-targets the backend via a `window.fetch` shim (or `<meta name="api-base">`).

## ⚖️ Legal posture

STREDIO is designed as a **neutral conduit**, the same posture as Stremio:

1. **No hosted media.** STREDIO does not host, store, upload, cache, transcode, or proxy any video file. Its servers never transit media bytes.
2. **No server-side streams.** The server has no stream/subtitle/catalog endpoints and makes no request to any add-on. Every add-on request is made by the user's browser, directly.
3. **Ships no stream sources.** Out of the box only metadata/subtitle add-ons are present (Cinemeta, OpenSubtitles). The platform is a pure catalog until a user installs a streaming add-on themselves.
4. **User responsibility.** Community add-ons are independent third-party software. If a user installs an add-on, the choice — and any streaming of third-party content — is the user's, on the user's side. STREDIO does not select, review, control, or endorse them.
5. **Truthful policies + DMCA.** On-site **[Terms & Conditions](#)**, **Privacy**, and a **DMCA / Takedown** policy (designated agent, takedown + counter-notification, repeat-infringer policy). The service keeps no IP logs.

This describes the **technical** posture only; it is **not legal advice**. Operators should retain counsel in their jurisdiction, register a DMCA designated agent, stand up an abuse mailbox, and keep any first-party catalog limited to genuinely licensed sources.

## License

Released under the **GNU Affero General Public License v3.0** (`AGPL-3.0`) — see [`LICENSE`](LICENSE).

AGPL-3.0 is a deliberate choice: its copyleft also reaches **hosted use**, so anyone who interacts with a deployed instance over a network is entitled to the corresponding source — and it is **compatible with the Apache-2.0** `hls.js` the project vendors (GPL-2.0-only is not).

> **AGPL §13 — network use.** If you run a modified STREDIO as a public service, you must offer its users access to the corresponding source. A "Source" link to this repository in the site footer or About page satisfies this.

### Third-party components

| Component | License |
|---|---|
| Express, compression, dotenv, pg | MIT / permissive |
| hls.js (`/assets/hls.min.js`) | Apache-2.0 (compatible with AGPL-3.0) |
| TMDB | Data via the TMDB API (attribution required; this product uses TMDB but is not endorsed or certified by TMDB) |

---

*STREDIO is an independent project and is not affiliated with Stremio, TMDB, or any add-on developer or debrid provider.*
