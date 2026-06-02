import { API_BASE_URL } from '../config'

export function createProfileId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function hashString(value) {
  return [...String(value)].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0)
}

export function getTitle(item) {
  return item.tmdb_title || item.title || item.name || item.folder_name || item.series_title || item.media_title || 'Untitled'
}

export function getPosterUrl(item, size = 'w342') {
  return getTmdbImageUrl(
    item.tmdb_poster_path || item.poster_path || item.thumbnail_path || item.image_url,
    size,
  )
}

export function getBackdropUrl(item, size = 'w1280') {
  return getTmdbImageUrl(item.tmdb_backdrop_path || item.backdrop_path, size)
}

export function getDetailArtworkUrl(item) {
  return getBackdropUrl(item) || getPosterUrl(item, 'w780')
}

export function getStillUrl(item) {
  const stillPath = item.still_path || item.poster_path || item.thumbnail_path || item.profile_path
  if (!stillPath) return ''
  if (stillPath.startsWith('http')) return stillPath
  return `${API_BASE_URL}/api/tmdb-image/w500/${stillPath.replace(/^\//, '')}`
}

export function getItemKey(item) {
  return `${item.type || item.media_type || 'item'}-${item.source || ''}-${item.folder_name || item.name || getTitle(item)}`
}

export function getCatalogIdentityKey(item) {
  const source = String(item.source || '').trim().toLowerCase()
  const title = String(item.folder_name || item.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return `${getMediaType(item)}:${title || source || String(getTitle(item)).trim().toLowerCase()}`
}

export function getItemPath(item) {
  const source = item.source || ''
  if (/^(?:gdrive|gdrive_folder|telegram)\//.test(source)) return source
  return item.folder_name || item.name || source
}

export function getDetailUrl(item) {
  return `/detail/${encodeURIComponent(getTitle(item))}`
}

export function getWatchUrl(mediaPath) {
  return `/watch/${encodeURIComponent(mediaPath)}`
}

export function normalizeMediaPath(mediaPath) {
  const path = String(mediaPath || '').trim().replace(/\\/g, '/')
  const match = path.match(/^\/?(gdrive|telegram)\/(.+?)\/?$/i)
  if (!match) return path

  const suffix = match[2].replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
  return suffix ? `${match[1].toLowerCase()}/${suffix}` : ''
}

export function normalizeWatchHistory(history) {
  const seenPaths = new Set()
  return (Array.isArray(history) ? history : []).flatMap((item) => {
    const mediaPath = normalizeMediaPath(item.media_path)
    if (!mediaPath || seenPaths.has(mediaPath)) return []
    seenPaths.add(mediaPath)
    return [{ ...item, media_path: mediaPath }]
  })
}

export function getProfileAvatarUrl(profile) {
  const avatarUrl = profile.avatar_url || profile.avatar || profile.image_url
  if (avatarUrl) return avatarUrl

  const seed = hashString(profile.avatar_seed || profile.id || profile.name || 'M')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 72% 48%)"/><circle cx="32" cy="25" r="13" fill="hsl(${hue} 58% 82%)"/><path d="M8 64c2-16 11-24 24-24s22 8 24 24" fill="hsl(${hue} 62% 30%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function getPersonFallbackUrl(person = {}) {
  const seed = hashString(person.id || person.name || 'Cast')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue} 24% 18%)"/><circle cx="60" cy="44" r="25" fill="hsl(${hue} 18% 68%)"/><path d="M12 120c4-32 20-48 48-48s44 16 48 48" fill="hsl(${hue} 22% 42%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function getPosterFallbackUrl(item = {}, { onlyWhenResolved = false } = {}) {
  if (onlyWhenResolved && !item.tmdb_metadata_resolved && !getPosterUrl(item) && !getBackdropUrl(item)) return ''

  const title = getTitle(item)
  const seed = hashString(title)
  const hue = Math.abs(seed) % 360
  const accentHue = (hue + 46) % 360
  const initials = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('') || 'M'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 58% 30%)"/><stop offset="1" stop-color="hsl(${accentHue} 62% 12%)"/></linearGradient></defs><rect width="240" height="360" fill="url(#g)"/><circle cx="188" cy="74" r="92" fill="hsl(${accentHue} 72% 52% / .2)"/><path d="M0 292L240 168v192H0z" fill="hsl(${hue} 72% 8% / .46)"/><text x="120" y="188" fill="hsl(${hue} 55% 92%)" font-family="Arial,sans-serif" font-size="72" font-weight="700" text-anchor="middle">${escapeSvgText(initials)}</text><text x="120" y="326" fill="hsl(${hue} 42% 88%)" font-family="Arial,sans-serif" font-size="16" font-weight="700" text-anchor="middle">MUTFLIX</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function getMediaType(item) {
  const mediaType = String(item.media_type || item.type || '').toLowerCase()
  return mediaType === 'movie' ? 'movie' : 'series'
}

export function getGenres(item) {
  return (item.tmdb_genres || item.genres || [])
    .map((genre) => typeof genre === 'string' ? genre : genre.name)
    .filter(Boolean)
}

export function getRating(item) {
  return Number(item.tmdb_rating || item.vote_average || 0)
}

export function getWatchProgress(item) {
  const position = Number(item.position_ms || 0)
  const duration = Number(item.duration_ms || 0)
  if (duration <= 0) return 0
  return Math.min(100, Math.max(0, (position / duration) * 100))
}

export function formatDuration(video) {
  const durationMs = Number(video.duration_ms || 0)
  if (durationMs <= 0) return ''
  return `${Math.max(1, Math.round(durationMs / 60000))}m`
}

export function getRotationKey(profileId) {
  const sixHours = 6 * 60 * 60 * 1000
  return `${profileId}-${Math.floor(Date.now() / sixHours)}`
}

export function rotateItems(items, seed) {
  if (items.length < 2) return items
  return items
    .map((item, index) => ({
      index,
      item,
      itemKey: getRotationItemKey(item, index),
    }))
    .sort((a, b) => {
      const rankDifference = getUnsignedHash(`${seed}:${a.itemKey}`) - getUnsignedHash(`${seed}:${b.itemKey}`)
      return rankDifference || a.itemKey.localeCompare(b.itemKey) || a.index - b.index
    })
    .map(({ item }) => item)
}

export function preloadImage(url) {
  if (!url) return Promise.resolve()

  return new Promise((resolve) => {
    const image = new Image()
    const timeout = window.setTimeout(resolve, 16000)
    const finish = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    image.onload = finish
    image.onerror = finish
    image.src = url
  })
}

export async function preloadImages(urls, { concurrency = 12 } = {}) {
  const queue = [...new Set(urls.filter(Boolean))]
  let nextIndex = 0

  async function preloadNext() {
    while (nextIndex < queue.length) {
      const url = queue[nextIndex]
      nextIndex += 1
      await preloadImage(url)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, preloadNext),
  )
}

function getTmdbImageUrl(path, size) {
  if (!path) return ''
  if (/^(?:https?:|data:|blob:)/.test(path)) return path
  return `${API_BASE_URL}/api/tmdb-image/${size}/${path.replace(/^\//, '')}`
}

function getRotationItemKey(item, index) {
  if (!item || typeof item !== 'object') return `${typeof item}:${String(item)}`
  if (item.genre) return `genre:${item.genre}`
  return [
    item.type || item.media_type || '',
    item.source || '',
    item.folder_name || item.name || item.title || item.id || index,
  ].join(':')
}

function getUnsignedHash(value) {
  return hashString(value) >>> 0
}

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
