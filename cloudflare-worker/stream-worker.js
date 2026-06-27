/**
 * STREDIO stream proxy — Cloudflare Worker
 * ------------------------------------------------------------------
 * Plays Referer-gated CDN files and HLS in the browser WITHOUT piping the
 * video bytes through the origin server. Cloudflare does not meter Worker
 * bandwidth, so this is the byte-heavy half of the old Express
 * /api/stream-proxy moved off Render.
 *
 * Single endpoint:
 *   GET /stream-proxy?src=<encoded url>[&ref=<encoded referer>][&t=hls]
 *     src : absolute http(s) URL of the upstream media/playlist (required)
 *     ref : Referer header to inject for gated CDNs (optional)
 *     t   : "hls" → treat src as an HLS playlist; rewrite every child URI
 *           (variant/audio playlists, segments, keys) to come back through
 *           this same Worker so the whole tree inherits the Referer.
 *
 * Why this is safe to expose: src is validated by the same SSRF guard the
 * origin uses (no private/loopback/metadata hosts), and only GET/HEAD are
 * allowed. It is a media relay, not a generic open proxy for arbitrary verbs.
 * ------------------------------------------------------------------ */

const PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ---- SSRF guard: ported 1:1 from server.js (isPrivateHost / isSafeFetchUrl) ---- */
function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata (169.254.169.254)
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true; // IPv6 ULA / link-local
  const m6 = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m6) { const hi = parseInt(m6[1], 16), lo = parseInt(m6[2], 16);
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  const m6d = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (m6d) return isPrivateHost(m6d[1]);
  return false;
}
function isSafeFetchUrl(raw) {
  let u; try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isPrivateHost(u.hostname);
}

/* ---- HLS playlist rewriting (ported from server.js rewriteHlsPlaylist) ---- */
function proxify(selfOrigin, absUrl, ref, asHls) {
  return selfOrigin + '/stream-proxy?src=' + encodeURIComponent(absUrl) +
    '&ref=' + encodeURIComponent(ref) + (asHls ? '&t=hls' : '');
}
function rewriteHlsPlaylist(text, baseUrl, ref, selfOrigin) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('#')) {
      // Rewrite URI="…" attributes (EXT-X-MEDIA audio/subs = playlists; KEY/MAP = binary)
      line = line.replace(/URI="([^"]+)"/g, (_m, u) => {
        let abs; try { abs = new URL(u, baseUrl).href; } catch { return `URI="${u}"`; }
        const binary = /EXT-X-KEY|EXT-X-MAP/i.test(line);
        return `URI="${proxify(selfOrigin, abs, ref, !binary)}"`;
      });
      out.push(line);
    } else if (line.trim() === '') {
      out.push(line);
    } else {
      let abs; try { abs = new URL(line.trim(), baseUrl).href; } catch { out.push(line); continue; }
      const prev = out.length ? out[out.length - 1] : '';
      const isPlaylist = /EXT-X-STREAM-INF|EXT-X-I-FRAME-STREAM-INF/i.test(prev) || /\.(m3u8|txt)(\?|$)/i.test(line);
      out.push(proxify(selfOrigin, abs, ref, isPlaylist));
    }
  }
  return out.join('\n');
}

/* ---- CORS: the app now calls this Worker cross-origin (hls.js XHR + <video>) ---- */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // hls.js sends a Range header → triggers a CORS preflight. Answer it.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }
    if (url.pathname !== '/stream-proxy') {
      return new Response('Not Found', { status: 404, headers: corsHeaders() });
    }

    const src = url.searchParams.get('src');
    const ref = url.searchParams.get('ref') || '';
    const asHls = url.searchParams.get('t') === 'hls';
    if (!src || !isSafeFetchUrl(src)) {
      return new Response('Invalid or disallowed src', { status: 400, headers: corsHeaders() });
    }
    if (ref && !/^https?:\/\//i.test(ref)) {
      return new Response('Invalid ref', { status: 400, headers: corsHeaders() });
    }

    const upstreamHeaders = { 'User-Agent': PROXY_UA, Accept: '*/*' };
    if (ref) upstreamHeaders.Referer = ref;
    // Don't forward Range when fetching a playlist — we need the whole text to rewrite.
    const range = request.headers.get('range');
    if (range && !asHls) upstreamHeaders.Range = range;

    const selfOrigin = url.origin;

    /* HLS playlist → fetch the text fast (bounded), rewrite child URIs back here. */
    if (asHls) {
      let upstream;
      try {
        upstream = await fetch(src, {
          headers: upstreamHeaders, redirect: 'follow', signal: AbortSignal.timeout(30000),
        });
      } catch { return new Response('Upstream fetch failed', { status: 502, headers: corsHeaders() }); }
      if (!upstream.ok && upstream.status !== 206) {
        return new Response('Upstream ' + upstream.status, { status: upstream.status, headers: corsHeaders() });
      }
      let text;
      try { text = await upstream.text(); } catch { return new Response('Playlist read failed', { status: 502, headers: corsHeaders() }); }
      if (/#EXTM3U/.test(text)) {
        const body = rewriteHlsPlaylist(text, upstream.url || src, ref, selfOrigin);
        return new Response(body, {
          headers: { ...corsHeaders(), 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
        });
      }
      // Not actually a playlist — serve as-is.
      const ct = upstream.headers.get('content-type');
      return new Response(text, {
        status: upstream.status, headers: { ...corsHeaders(), ...(ct ? { 'Content-Type': ct } : {}) },
      });
    }

    /* Binary passthrough (direct file / HLS segment / key). No abort timeout:
     * the response streams for as long as the viewer watches, and a client
     * disconnect auto-cancels the upstream body pull. */
    let upstream;
    try {
      upstream = await fetch(src, { headers: upstreamHeaders, redirect: 'follow' });
    } catch { return new Response('Upstream fetch failed', { status: 502, headers: corsHeaders() }); }
    if (!upstream.ok && upstream.status !== 206) {
      return new Response('Upstream ' + upstream.status, { status: upstream.status, headers: corsHeaders() });
    }

    const out = new Headers(corsHeaders());
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!upstream.headers.get('accept-ranges')) out.set('Accept-Ranges', 'bytes');

    // Returning upstream.body IS the pipe — Cloudflare streams it through, unmetered.
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
