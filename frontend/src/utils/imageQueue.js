/**
 * imageQueue.js
 *
 * Concurrent image load limiter.
 * GDrive poster requests are expensive (each hits the server -> GDrive API -> resize).
 * When many posters appear at once, the browser fires 20-40 parallel requests,
 * causing server thread pool exhaustion and all images loading slowly together.
 *
 * This module queues load requests and dispatches up to MAX_CONCURRENT at a time,
 * so early-visible posters load fast while later ones wait their turn.
 */

const MAX_CONCURRENT = 8 // Browser per-host limit is ~6-8; match it
const GDRIVE_PROXY_PATH = '/api/gdrive-poster'
const IMAGE_LOAD_TIMEOUT_MS = 15000

let activeCount = 0
const queue = [] // [{src, resolve, reject}]

function dispatch() {
  while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
    const { src, resolve, reject } = queue.shift()
    activeCount++
    loadImage(src).then(resolve, reject).finally(() => {
      activeCount--
      dispatch()
    })
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      img.onload = null
      img.onerror = null
      img.src = ''
      reject(new Error(`Image load timed out: ${src}`))
    }, IMAGE_LOAD_TIMEOUT_MS)

    img.onload = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      resolve(src)
    }
    img.onerror = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      reject(new Error(`Failed to load image: ${src}`))
    }
    img.src = src
  })
}

/**
 * Request to load an image, respecting the concurrency limit.
 * Returns a promise that resolves when the image is loaded (or rejects on error).
 * Priority images bypass the queue and load immediately.
 */
export function requestImageLoad(src, { priority = false } = {}) {
  if (!src) return Promise.reject(new Error('No src'))

  // Non-GDrive images or priority images: load immediately without queuing
  const isGdrive = src.includes(GDRIVE_PROXY_PATH)
  if (!isGdrive || priority) {
    return loadImage(src)
  }

  // GDrive images: queue and dispatch via concurrency limiter
  return new Promise((resolve, reject) => {
    queue.push({ src, resolve, reject })
    dispatch()
  })
}
