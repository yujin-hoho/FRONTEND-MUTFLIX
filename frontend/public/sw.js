const STATIC_CACHE = 'mutflix-static-v2'
const IMAGE_CACHE = 'mutflix-images-v2'
const STATIC_ASSETS = ['/', '/index.html', '/favicon.svg', '/icons.svg']
const MAX_IMAGE_CACHE_ITEMS = 800

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => ![STATIC_CACHE, IMAGE_CACHE].includes(key))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - maxItems)).map((key) => cache.delete(key)))
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    if (cacheName === IMAGE_CACHE) await trimCache(IMAGE_CACHE, MAX_IMAGE_CACHE_ITEMS)
  }
  return response
}

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return cache.match(request) || cache.match('/index.html')
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, IMAGE_CACHE))
    return
  }

  if (url.origin === self.location.origin && ['script', 'style', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
  }
})
