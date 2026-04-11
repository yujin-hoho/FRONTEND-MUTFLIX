/**
 * MUTFLIX Cloudflare Worker — GDrive Streaming Proxy
 * 
 * Proxy video stream dari Google Drive melalui Cloudflare Edge Network.
 * Lebih cepat dan ringan dibanding proxy lewat server HuggingFace.
 * 
 * URL Format:
 *   GET /{fileId}?token={gdrive_access_token}
 * 
 * Features:
 *   - Range header support (seeking)
 *   - CORS headers untuk cross-origin playback
 *   - Streaming passthrough (tidak buffer seluruh file)
 *   - Health check endpoint (/health)
 */

// Allowed origins — set via wrangler.toml [vars] or CF dashboard
// Default: allow all (karena token sudah jadi auth layer)
const DEFAULT_ALLOWED_ORIGINS = '*';

export default {
  async fetch(request, env) {
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

    // Build GDrive request
    const gdriveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const gdriveHeaders = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mutflix/1.0',
    };

    // Forward Range header for seeking
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      gdriveHeaders['Range'] = rangeHeader;
    }

    try {
      const gdriveResp = await fetch(gdriveUrl, {
        headers: gdriveHeaders,
      });

      if (!gdriveResp.ok && gdriveResp.status !== 206) {
        // Forward error from GDrive
        return new Response(`GDrive error: ${gdriveResp.status} ${gdriveResp.statusText}`, {
          status: gdriveResp.status,
          headers: corsHeaders(request, env),
        });
      }

      // Build response headers
      const respHeaders = {
        'Accept-Ranges': 'bytes',
        ...corsHeaders(request, env),
      };

      // Forward relevant headers from GDrive
      const forwardHeaders = ['content-type', 'content-length', 'content-range'];
      for (const h of forwardHeaders) {
        const val = gdriveResp.headers.get(h);
        if (val) respHeaders[h] = val;
      }

      // Stream response body through (Cloudflare streams natively, no buffering)
      return new Response(gdriveResp.body, {
        status: gdriveResp.status,
        headers: respHeaders,
      });
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
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
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
