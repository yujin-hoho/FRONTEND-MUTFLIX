import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'

/** Same default as `WatchPage` / `api.js` — backend yang mem-proxy stream (bukan host static Render). */
const DEFAULT_API_BASE = 'https://melancholia112-mutflix.hf.space'

/**
 * dns-prefetch + preconnect ke API backend supaya TLS/DNS mulai lebih awal (bantu sedikit setelah deploy).
 */
function apiPreconnectPlugin(apiBase) {
  const origin = apiBase.replace(/\/$/, '')
  return {
    name: 'api-preconnect',
    transformIndexHtml(html) {
      const inject = `  <link rel="dns-prefetch" href="${origin}" />\n  <link rel="preconnect" href="${origin}" crossorigin />\n`
      return html.replace('</head>', `${inject}</head>`)
    }
  }
}

/**
 * Custom Vite plugin that proxies GDrive video streams.
 * Runs server-side in the Vite dev server — no CORS restrictions.
 * 
 * Frontend sets video.src = /gdrive-proxy/{fileId}?alt=media&access_token=TOKEN
 * This middleware fetches from Google Drive with proper Authorization header
 * and streams the response back. Supports Range headers for seeking.
 */
function gdriveProxyPlugin() {
  return {
    name: 'gdrive-proxy',
    configureServer(server) {
      server.middlewares.use('/gdrive-proxy', (req, res) => {
        const parsed = new URL(req.url, 'http://localhost');
        const fileId = parsed.pathname.replace(/^\//, '');
        const token = parsed.searchParams.get('access_token');

        if (!fileId || !token) {
          res.statusCode = 400;
          res.end('Missing fileId or access_token');
          return;
        }

        const gdriveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        const headers = {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mutflix/1.0'
        };

        // Forward Range header for seeking support
        if (req.headers.range) {
          headers['Range'] = req.headers.range;
        }

        const gdriveReq = https.get(gdriveUrl, { headers }, (gdriveRes) => {
          // Forward status code and relevant headers
          res.statusCode = gdriveRes.statusCode;
          const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
          for (const h of forwardHeaders) {
            if (gdriveRes.headers[h]) res.setHeader(h, gdriveRes.headers[h]);
          }
          // Stream the response
          gdriveRes.pipe(res);
        });

        gdriveReq.on('error', (err) => {
          console.error('[gdrive-proxy] Error:', err.message);
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end('Proxy error');
          }
        });

        req.on('close', () => gdriveReq.destroy());
      });
    }
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE_URL || DEFAULT_API_BASE

  return {
    plugins: [react(), gdriveProxyPlugin(), apiPreconnectPlugin(apiBase)],
    build: {
      target: 'es2020',
      sourcemap: false,
      cssMinify: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('lucide-react')) return 'lucide';
            if (id.includes('react-router')) return 'router';
            if (id.includes('react-dom') || id.includes('/react/')) return 'react-vendor';
          },
        },
      },
    },
  }
})
