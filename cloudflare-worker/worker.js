/**
 * MUTFLIX Cloudflare Worker — GDrive Streaming Proxy (v2: Edge Cache)
 * 
 * Proxy video stream dari Google Drive melalui Cloudflare Edge Network.
 * 
 * URL Format:
 *   GET /{fileId}?token={gdrive_access_token}
 * 
 * Features:
 *   - ✅ Range header support (seeking)
 *   - ✅ Edge Cache — range responses di-cache di Cloudflare edge (POP terdekat)
 *       → Moov atom (biasanya di akhir file) cuma lambat pertama kali
 *       → Seeking ke posisi yang sama = instant dari cache
 *       → Popular content otomatis ke-cache
 *   - ✅ CORS headers untuk cross-origin playback
 *   - ✅ Streaming passthrough (tidak buffer seluruh file)
 *   - ✅ Health check endpoint (/health)
 */

// Allowed origins — set via wrangler.toml [vars] or CF dashboard
const DEFAULT_ALLOWED_ORIGINS = '*';

// Cache TTL: 24 jam. Video files rarely change.
const CACHE_TTL_SECONDS = 86400;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Preflight CORS ──
    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    // ── Health check ──
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'mutflix-stream', ts: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
      });
    }

    // ── Main: proxy GDrive stream ──
    // URL: /{fileId}?token={access_token}
    const fileId = url.pathname.replace(/^\//, '');
    const token = url.searchParams.get('token');

    if (!fileId || !token) {
      return new Response(JSON.stringify({ error: 'Missing fileId or token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
      });
    }

    // ══════════════════════════════════════════════
    // EDGE CACHE LAYER (Cloudflare Cache API)
    // ══════════════════════════════════════════════
    // Cache key = fileId + Range header (token-independent, karena token berubah tiap jam)
    // Ini bikin:
    //   1. Moov atom fetch (akhir file) cuma lambat pertama kali per-POP
    //   2. Seeking ke area yang sama = instant dari cache
    //   3. Multiple user nonton konten sama = share cache
    
    // ── Optimasi: Paksa jadi chunk (misal 15MB) agar gampang di-cache di Edge ──
    const originalRange = request.headers.get('Range') || '';
    const INITIAL_CHUNK_SIZE = 16 * 1024 * 1024; // 16MB
    const STREAM_CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
    const CACHEABLE_MAX_BYTES = 70 * 1024 * 1024;
    let modifiedRange = originalRange;

    if (!originalRange) {
      // Jika request tanpa Range (misal initial load), paksa jadi 0-CHUNK
      modifiedRange = `bytes=0-${INITIAL_CHUNK_SIZE - 1}`;
    } else {
      const match = originalRange.trim().match(/bytes=(\d+)-(.*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const endStr = match[2];
        const chunkSize = start === 0 ? INITIAL_CHUNK_SIZE : STREAM_CHUNK_SIZE;
        if (!endStr) {
          // Range terbuka, misal 'bytes=0-', kita batasi ukurannya
          modifiedRange = `bytes=${start}-${start + chunkSize - 1}`;
        } else {
          const end = parseInt(endStr, 10);
          if (end - start + 1 > chunkSize) {
            // Range dibatasi tapi masih terlalu besar
            modifiedRange = `bytes=${start}-${start + chunkSize - 1}`;
          }
        }
      }
    }

    const cacheKeyUrl = new URL(`https://cache-internal.mutflix.workers.dev/${fileId}`);
    cacheKeyUrl.searchParams.set('r', modifiedRange);
    const cacheKey = new Request(cacheKeyUrl.toString());
    const cache = caches.default;

    // Check edge cache first
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // Cache HIT — serve dari Cloudflare edge (< 5ms latency)
      const headers = new Headers(cachedResponse.headers);
      // Re-apply CORS headers (origin bisa beda dari cached request)
      for (const [k, v] of Object.entries(corsHeaders(request, env))) {
        headers.set(k, v);
      }
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers,
      });
    }

    // ══════════════════════════════════════════════
    // CACHE MISS — Fetch from Google Drive
    // ══════════════════════════════════════════════
    const gdriveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const gdriveHeaders = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mutflix/1.0',
      'Range': modifiedRange // Selalu gunakan modifiedRange
    };

    try {
      const gdriveResp = await fetch(gdriveUrl, {
        headers: gdriveHeaders,
      });

      if (!gdriveResp.ok && gdriveResp.status !== 206) {
        // Don't cache errors
        return new Response(`GDrive error: ${gdriveResp.status} ${gdriveResp.statusText}`, {
          status: gdriveResp.status,
          headers: corsHeaders(request, env),
        });
      }

      // Build response headers
      const respHeaders = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'X-Cache': 'MISS',
        ...corsHeaders(request, env),
      };

      // Forward relevant headers from GDrive
      const forwardHeaders = ['content-type', 'content-length', 'content-range'];
      for (const h of forwardHeaders) {
        const val = gdriveResp.headers.get(h);
        if (val) respHeaders[h] = val;
      }

      const response = new Response(gdriveResp.body, {
        status: gdriveResp.status,
        headers: respHeaders,
      });

      // ── Store in edge cache (non-blocking) ──
      // ctx.waitUntil ensures the cache write completes even after response is sent
      // Only cache small responses (e.g., < 25MB) to prevent stream backpressure
      // from stalling the client video player (since clone() forces both streams to be consumed).
      const contentLength = parseInt(gdriveResp.headers.get('content-length'), 10);
      if (contentLength && contentLength <= CACHEABLE_MAX_BYTES) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
      });
    }
  },
};

/**
 * CORS headers helper
 */
function corsHeaders(request, env) {
  const allowedOrigins = (env?.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(',').map(s => s.trim());
  const origin = request.headers.get('Origin') || '';

  let allowOrigin = DEFAULT_ALLOWED_ORIGINS;
  if (allowedOrigins.length && allowedOrigins[0] !== '*') {
    // Check if request origin is in the allowed list
    if (allowedOrigins.includes(origin)) {
      allowOrigin = origin;
    } else {
      // Not in allowed list — still allow (token is the real auth), but log
      allowOrigin = allowedOrigins[0]; // Use first allowed as default
    }
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, X-Cache',
  };
}

/**
 * Handle CORS preflight
 */
function handleCORS(request, env) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env),
  });
}
