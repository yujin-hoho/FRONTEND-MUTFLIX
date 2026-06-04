const LOADED_IMAGE_CACHE_KEY = 'mutflix_loaded_image_urls_v1'
const MAX_LOADED_IMAGE_URLS = 1600

let loadedImageUrls

export function hasLoadedImageUrl(url) {
  return getLoadedImageUrls().has(normalizeImageUrl(url))
}

export function rememberLoadedImageUrl(url) {
  const normalizedUrl = normalizeImageUrl(url)
  if (!isCacheableImageUrl(normalizedUrl)) return

  const urls = getLoadedImageUrls()
  if (urls.has(normalizedUrl)) return

  urls.add(normalizedUrl)
  const nextUrls = Array.from(urls).slice(-MAX_LOADED_IMAGE_URLS)
  loadedImageUrls = new Set(nextUrls)

  try {
    localStorage.setItem(LOADED_IMAGE_CACHE_KEY, JSON.stringify(nextUrls))
  } catch {
    loadedImageUrls = new Set(nextUrls.slice(-Math.floor(MAX_LOADED_IMAGE_URLS / 2)))
    try {
      localStorage.setItem(LOADED_IMAGE_CACHE_KEY, JSON.stringify(Array.from(loadedImageUrls)))
    } catch {
      localStorage.removeItem(LOADED_IMAGE_CACHE_KEY)
    }
  }
}

function getLoadedImageUrls() {
  if (loadedImageUrls) return loadedImageUrls

  try {
    const urls = JSON.parse(localStorage.getItem(LOADED_IMAGE_CACHE_KEY) || '[]')
    loadedImageUrls = new Set(Array.isArray(urls) ? urls.map(normalizeImageUrl).filter(isCacheableImageUrl) : [])
  } catch {
    localStorage.removeItem(LOADED_IMAGE_CACHE_KEY)
    loadedImageUrls = new Set()
  }

  return loadedImageUrls
}

function normalizeImageUrl(url) {
  return String(url || '').trim()
}

function isCacheableImageUrl(url) {
  return Boolean(url) && !/^(?:data:|blob:)/i.test(url)
}
