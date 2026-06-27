/**
 * STREDIO image CDN — Cloudflare Worker
 * ------------------------------------------------------------------
 * Edge cache + fast global delivery in front of TMDB's image host.
 *
 * Request shape is IDENTICAL to TMDB, so switching is a pure host swap:
 *   TMDB :  https://image.tmdb.org/t/p/w500/abc.jpg
 *   Here :  https://<your-worker-host>/t/p/w500/abc.jpg
 *
 * What it does:
 *   - Only proxies TMDB image paths (/t/p/<size>/<file>) — NOT an open proxy.
 *   - Caches every image at the Cloudflare edge for 30 days.
 *   - Adds long-lived Cache-Control so browsers cache locally too.
 *   - Survives TMDB hiccups: a cached image keeps serving.
 *
 * What it does NOT do on the free tier:
 *   - It does not re-encode JPG → WebP/AVIF (that needs Cloudflare's paid
 *     image tier / Polish). This Worker is the free caching + CDN layer.
 */

const TMDB_HOST = 'https://image.tmdb.org';

// TMDB image size segments we actually request from the app. Anything else
// is rejected so the Worker can't be abused as a generic open proxy.
const ALLOWED_SIZES = new Set([
  'original',
  'w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280',
  'h632',
]);

const EDGE_TTL = 60 * 60 * 24 * 30;      // 30 days at the edge
const BROWSER_TTL = 60 * 60 * 24 * 30;   // 30 days in the user's browser

export default {
  async fetch(request, ctx) {
    // Only safe, cacheable methods.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // ["t","p","w500","abc.jpg"]

    // Validate the path shape: /t/p/<size>/<file...>
    if (parts.length < 4 || parts[0] !== 't' || parts[1] !== 'p' || !ALLOWED_SIZES.has(parts[2])) {
      return new Response('Not Found', { status: 404 });
    }

    const upstream = TMDB_HOST + url.pathname; // ignore query string entirely

    // Edge cache: key on the normalized upstream URL (no query string).
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });

    let response = await cache.match(cacheKey);
    if (response) {
      // Edge HIT — clone so we can tag it, then return.
      response = new Response(response.body, response);
      response.headers.set('X-Cache', 'HIT');
      return response;
    }

    // Edge MISS — fetch from TMDB, ask Cloudflare to cache the subrequest too.
    const originResp = await fetch(upstream, {
      cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
      headers: { 'Accept': 'image/avif,image/webp,image/jpeg,image/png,*/*' },
    });

    if (!originResp.ok) {
      // Pass through TMDB's error (404 for a missing poster, etc.) but don't cache it.
      return new Response('Upstream error', { status: originResp.status });
    }

    response = new Response(originResp.body, originResp);
    response.headers.set('Cache-Control', `public, max-age=${BROWSER_TTL}, immutable`);
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('X-Cache', 'MISS');
    response.headers.delete('Set-Cookie');

    // Store in the edge cache without blocking the response to the user.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
