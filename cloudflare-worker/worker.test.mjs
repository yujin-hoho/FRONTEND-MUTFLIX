import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.js';

test('forwards an open-ended media range without truncating it', async (context) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  let forwardedRange = null;
  let cacheLookupCount = 0;

  globalThis.caches = {
    default: {
      async match() {
        cacheLookupCount += 1;
        return null;
      },
    },
  };
  globalThis.fetch = async (_url, options) => {
    forwardedRange = options.headers.Range;
    return new Response('video-data', {
      status: 206,
      headers: {
        'Content-Length': '10',
        'Content-Range': 'bytes 0-9/10000000',
        'Content-Type': 'video/mp4',
      },
    });
  };
  context.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });

  const request = new Request('https://stream.example/file-id?token=secret', {
    headers: { Range: 'bytes=0-' },
  });
  const response = await worker.fetch(request, {}, { waitUntil() {} });

  assert.equal(forwardedRange, 'bytes=0-');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-9/10000000');
  assert.equal(response.headers.get('X-Proxy-Mode'), 'direct-range');
  assert.equal(cacheLookupCount, 0);
});
