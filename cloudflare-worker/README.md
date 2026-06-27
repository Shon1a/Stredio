# STREDIO image CDN — Cloudflare Worker

Edge cache + global delivery in front of TMDB images. Runs on Cloudflare's
**free** tier (100,000 requests/day). It does **not** convert to WebP/AVIF —
that needs Cloudflare's paid image tier. This is the free caching/CDN layer.

The Worker mimics TMDB's URL shape exactly, so adopting it is just a host swap:

```
TMDB :  https://image.tmdb.org/t/p/w500/abc.jpg
Worker:  https://stredio-img.<you>.workers.dev/t/p/w500/abc.jpg
```

---

## Step 1 — Deploy the Worker

Pick ONE of the two options.

### Option A — Cloudflare dashboard (easiest, no install)

1. Create a free account at https://dash.cloudflare.com (skip "add a domain" — you don't need one).
2. Left sidebar → **Workers & Pages** → **Create application** → **Create Worker**.
3. Name it `stredio-img` → **Deploy** (it deploys a hello-world placeholder).
4. Click **Edit code**.
5. Delete everything in the editor, then paste the entire contents of `worker.js`.
6. Click **Deploy** (top right).
7. Copy your Worker URL — it looks like:
   `https://stredio-img.YOURNAME.workers.dev`

### Option B — Wrangler CLI (if you prefer the terminal)

```bash
cd "cloudflare-worker"
npm install -g wrangler        # one-time
wrangler login                 # opens browser to authorize
wrangler deploy                # deploys worker.js using wrangler.toml
```

Wrangler prints the deployed URL, e.g. `https://stredio-img.YOURNAME.workers.dev`.

---

## Step 2 — Test it works

Open these in a browser (replace with YOUR worker host):

- Should show an image:
  `https://stredio-img.YOURNAME.workers.dev/t/p/w500/qNBAXBIQlnOThrVvA6mA2B5ggV6.jpg`
- Should return 404 (proves it's not an open proxy):
  `https://stredio-img.YOURNAME.workers.dev/anything/else`

On the first image load the response header `X-Cache` is `MISS`; reload and it
becomes `HIT` (open DevTools → Network → click the image → Headers to see it).

---

## Step 3 — Point STREDIO at the Worker

There are **5** places that build TMDB image URLs. Replace the host
`https://image.tmdb.org` with your Worker host in each. Keep the `/t/p/<size>` tail.

**Backend — `server/server.js`** (lines ~41-48):

```js
const IMG     = 'https://stredio-img.YOURNAME.workers.dev/t/p/w500';
const IMGBACK = 'https://stredio-img.YOURNAME.workers.dev/t/p/original';
const IMGFACE = 'https://stredio-img.YOURNAME.workers.dev/t/p/w185';
const IMGSTILL= 'https://stredio-img.YOURNAME.workers.dev/t/p/w300';
```

**Frontend — `index.html`** (line ~4243):

```js
const LOGO_BASE='https://stredio-img.YOURNAME.workers.dev/t/p/w300';
```

> Tip: keep the host in ONE constant so you never repeat it. See the optional
> refactor at the bottom of this file.

**Also update the dns-prefetch hint** in `index.html` (line ~28) and
`admin.html` (line ~13) from `image.tmdb.org` to your Worker host so the browser
warms the connection early.

---

## Step 4 — Deploy STREDIO as usual

- Backend: push so Render redeploys `server/server.js`.
- Frontend: push so Vercel redeploys `index.html`.

Load the site, open DevTools → Network → filter "img". Confirm posters now load
from `stredio-img.*.workers.dev` (not `image.tmdb.org`) and return `200`.

---

## Rollback

If anything looks wrong, revert the 5 host strings back to
`https://image.tmdb.org` and redeploy. Nothing else changed; TMDB still works
directly.

---

## Optional refactor — single host constant

Instead of repeating the host, define it once.

In `server/server.js`:

```js
const IMG_CDN  = process.env.IMG_CDN || 'https://image.tmdb.org';
const IMG      = IMG_CDN + '/t/p/w500';
const IMGBACK  = IMG_CDN + '/t/p/original';
const IMGFACE  = IMG_CDN + '/t/p/w185';
const IMGSTILL = IMG_CDN + '/t/p/w300';
```

Then set `IMG_CDN=https://stredio-img.YOURNAME.workers.dev` as a Render env var.
Flip between TMDB and the CDN with one variable, no code change. (The frontend
`LOGO_BASE` still needs editing directly, or expose it via a meta tag.)

---

## Notes / limits

- **Free tier:** 100k Worker requests/day. With browser + edge caching, repeat
  viewers cost almost nothing; you'd need very high traffic to exceed it.
- **No WebP/AVIF** here. To add it later, enable Cloudflare **Polish** (paid) on
  the Worker's zone, or move to Cloudflare Images. No code change needed in STREDIO.
- The Worker ignores query strings and only allows known TMDB sizes
  (`original, w92…w1280, h632`) — extend `ALLOWED_SIZES` in `worker.js` if you
  start requesting other sizes.
