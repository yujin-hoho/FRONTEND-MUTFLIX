/**
 * MUTFLIX Cloudflare Worker - GDrive streaming proxy with edge caching.
 *
 * URL format:
 *   GET /{fileId}?token={gdrive_access_token}
 *
 * The backend keeps returning both the direct GDrive URL and its own proxy URL.
 * This worker is an optional faster route for ordinary video files; the player
 * can fall back to the backend proxy if the edge request fails.
 */

const DEFAULT_ALLOWED_ORIGINS = '*';
const CACHE_TTL_SECONDS = 86400;
const INITIAL_RANGE_BYTES = 4 * 1024 * 1024;
const CACHEABLE_RANGE_MAX_BYTES = INITIAL_RANGE_BYTES;
const CACHE_KEY_PREFIX = '/__mutflix_cache/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCORS(request, env);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', worker: 'mutflix-stream', ts: Date.now() }, 200, request, env);
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, request, env);
    }

    const fileId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const token = url.searchParams.get('token');
    if (!fileId || !token) {
      return jsonResponse({ error: 'Missing fileId or token' }, 400, request, env);
    }

    const rangePlan = createRangePlan(request.headers.get('Range') || '');
    const cacheKey = await createCacheKey(request, fileId, token, rangePlan.upstreamRange);
    const cache = cacheKey ? caches.default : null;

    if (cacheKey) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return responseForClient(cachedResponse, request, env, 'HIT');
      }
    }

    const gdriveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    try {
      const upstreamHeaders = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mutflix/1.0',
      };
      if (rangePlan.upstreamRange) upstreamHeaders.Range = rangePlan.upstreamRange;

      const upstreamResponse = await fetch(gdriveUrl, {
        headers: upstreamHeaders,
      });

      if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        return passthroughError(upstreamResponse, request, env);
      }

      const responseHeaders = createResponseHeaders(upstreamResponse, request, env, rangePlan.proxyMode);
      const clientResponse = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });

      const contentLength = Number.parseInt(upstreamResponse.headers.get('content-length') || '', 10);
      if (cacheKey && contentLength > 0 && contentLength <= CACHEABLE_RANGE_MAX_BYTES) {
        const cacheHeaders = new Headers(responseHeaders);
        cacheHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
        cacheHeaders.set('X-Origin-Status', String(upstreamResponse.status));
        const cacheResponse = new Response(clientResponse.clone().body, {
          // Cloudflare Cache API rejects partial-content responses. Keep the
          // cached representation internal as 200 and restore 206 on cache hit.
          status: 200,
          headers: cacheHeaders,
        });
        ctx.waitUntil(cache.put(cacheKey, cacheResponse));
      }

      return clientResponse;
    } catch (error) {
      return jsonResponse({ error: 'Upstream fetch failed', detail: error.message }, 502, request, env);
    }
  },
};

function createRangePlan(range) {
  const normalizedRange = range.trim();
  if (normalizedRange !== 'bytes=0-') {
    return {
      proxyMode: normalizedRange ? 'direct-range' : 'direct-stream',
      upstreamRange: normalizedRange,
    };
  }

  // Cache a small metadata bootstrap, then let later playback and seek ranges
  // stream continuously so the browser is not forced through chunk boundaries.
  return {
    proxyMode: 'initial-window',
    upstreamRange: `bytes=0-${INITIAL_RANGE_BYTES - 1}`,
  };
}

async function createCacheKey(request, fileId, token, range) {
  if (!isCacheableRange(range)) return null;

  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = `${CACHE_KEY_PREFIX}${encodeURIComponent(fileId)}`;
  cacheKeyUrl.search = '';
  cacheKeyUrl.searchParams.set('r', range);
  cacheKeyUrl.searchParams.set('auth', await hashToken(token));
  return new Request(cacheKeyUrl.toString());
}

function isCacheableRange(range) {
  const match = range.trim().match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return false;

  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  return end >= start && end - start + 1 <= CACHEABLE_RANGE_MAX_BYTES;
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createResponseHeaders(upstreamResponse, request, env, proxyMode) {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Cache': 'MISS',
    'X-Proxy-Mode': proxyMode,
    ...corsHeaders(request, env),
  });

  for (const header of ['content-type', 'content-length', 'content-range']) {
    const value = upstreamResponse.headers.get(header);
    if (value) headers.set(header, value);
  }
  return headers;
}

function responseForClient(cachedResponse, request, env, cacheStatus) {
  const headers = new Headers(cachedResponse.headers);
  const status = Number.parseInt(headers.get('X-Origin-Status') || '200', 10);
  headers.delete('X-Origin-Status');
  headers.set('X-Cache', cacheStatus);
  headers.set('X-Proxy-Mode', 'metadata-cache');
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(cachedResponse.body, { status, headers });
}

function passthroughError(upstreamResponse, request, env) {
  const headers = new Headers(upstreamResponse.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
}

function jsonResponse(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

function corsHeaders(request, env) {
  const allowedOrigins = String(env?.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(',').map((origin) => origin.trim());
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = allowedOrigins[0] === '*' || allowedOrigins.includes(origin) ? (allowedOrigins[0] === '*' ? '*' : origin) : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, X-Cache, X-Proxy-Mode',
  };
}

function handleCORS(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}
