import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'

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
export default defineConfig({
  plugins: [react(), gdriveProxyPlugin()],
})
