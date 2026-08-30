import { API_BASE_URL } from '../config'
import { getProfileAvatarUrlFromSeed } from './profileAvatars'

export function createProfileId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function hashString(value) {
  return [...String(value)].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0)
}

export function getTitle(item) {
  if (!item) return 'Untitled'
  return item.tmdb_title || item.title || item.name || item.folder_name || item.series_title || item.media_title || 'Untitled'
}

export function resolveServerMediaUrl(path, size = 'w342') {
  if (!path) return ''
  const trimmed = String(path).trim()
  if (!trimmed) return ''
  if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return trimmed

  const widthMatch = String(size || '').match(/(\d+)/)
  const widthParam = widthMatch ? `w=${widthMatch[1]}` : ''

  const appendSize = (url) => {
    if (!widthParam) return url
    return url.includes('?') ? `${url}&${widthParam}` : `${url}?${widthParam}`
  }

  // Extract file ID if path contains gdrive-poster pattern (e.g. /api/gdrive-poster/xyz or still path/api/gdrive-poster/xyz)
  const gdriveMatch = trimmed.match(/gdrive-poster\/([a-zA-Z0-9_-]+)/i)
  if (gdriveMatch) {
    return appendSize(`${API_BASE_URL}/api/gdrive-poster/${gdriveMatch[1]}`)
  }

  if (
    trimmed.startsWith('/api/')
    || trimmed.startsWith('/posters/')
    || trimmed.startsWith('/backdrops/')
    || trimmed.startsWith('/storage/')
  ) {
    return appendSize(`${API_BASE_URL}${trimmed}`)
  }

  if (
    trimmed.startsWith('api/')
    || trimmed.startsWith('posters/')
    || trimmed.startsWith('backdrops/')
    || trimmed.startsWith('storage/')
  ) {
    return appendSize(`${API_BASE_URL}/${trimmed}`)
  }

  // Handle standalone Google Drive file ID
  if (/^[a-zA-Z0-9_-]{20,100}$/.test(trimmed)) {
    return appendSize(`${API_BASE_URL}/api/gdrive-poster/${trimmed}`)
  }

  return ''
}

const LOCAL_POSTER_OVERRIDES_KEY = 'mutflix_local_poster_overrides'

export function getLocalPosterOverrideMap() {
  try {
    const raw = localStorage.getItem(LOCAL_POSTER_OVERRIDES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function getLocalPosterOverride(item) {
  if (!item) return ''
  try {
    const map = getLocalPosterOverrideMap()
    const keys = [
      getCatalogIdentityKey(item),
      item.folder_name,
      item.id ? String(item.id) : '',
      item.name,
      getTitle(item),
    ].filter(Boolean)

    for (const key of keys) {
      if (map[key]) return map[key]
    }
  } catch {
    return ''
  }
  return ''
}

export function setLocalPosterOverride(item, posterUrl) {
  if (!item) return
  try {
    const map = getLocalPosterOverrideMap()
    const identityKey = getCatalogIdentityKey(item) || item.folder_name || (item.id ? String(item.id) : '') || getTitle(item)
    if (!identityKey) return

    if (posterUrl) {
      map[identityKey] = posterUrl
    } else {
      delete map[identityKey]
    }
    localStorage.setItem(LOCAL_POSTER_OVERRIDES_KEY, JSON.stringify(map))
    window.dispatchEvent(new CustomEvent('mutflix:poster-override-changed', {
      detail: { identityKey, item, posterUrl },
    }))
  } catch (error) {
    console.warn('[LOCAL-POSTER] Failed to save override:', error)
  }
}

export function removeLocalPosterOverride(item) {
  setLocalPosterOverride(item, null)
}

export function getTmdbId(item) {
  if (!item) return null
  const id = item.tmdb_id
    || item.idtmdb
    || item.id_tmdb
    || item.tmdb_override_id
    || item.idTmdb
    || item.tmdbId
  const parsed = Number(id)
  return parsed > 0 ? parsed : null
}

export function getPosterUrl(item, size = 'w342') {
  if (!item) return ''

  // 1. Locally selected poster override (saved in browser localStorage)
  const localOverride = getLocalPosterOverride(item)
  if (localOverride) {
    return resolveServerMediaUrl(localOverride, size)
  }

  // 2. Multi-poster rotation
  const posters = Array.isArray(item.all_poster_urls) && item.all_poster_urls.length > 0
    ? item.all_poster_urls.filter(Boolean)
    : []

  if (posters.length > 1) {
    const sixHours = 6 * 60 * 60 * 1000
    const timeSlot = Math.floor(Date.now() / sixHours)
    const seed = hashString(item.folder_name || item.name || item.id || item.tmdb_id || 'poster')
    const index = Math.abs(timeSlot + seed) % posters.length
    return resolveServerMediaUrl(posters[index], size)
  }

  const poster = posters[0]
    || item.poster_url
    || (item.poster_file_id ? `/api/gdrive-poster/${item.poster_file_id}` : '')
    || item.display_poster
    || item.primary_poster_url
    || item.poster
    || item.thumbnail_url
    || item.image_url
    || (item.tmdb_poster_path ? getTmdbImageUrl(item.tmdb_poster_path, size) : '')
    || (item.poster_path ? getTmdbImageUrl(item.poster_path, size) : '')

  return resolveServerMediaUrl(poster, size)
}

export function getBackdropUrl(item, size = 'w1280') {
  if (!item) return ''
  const backdrops = Array.isArray(item.all_backdrop_urls) && item.all_backdrop_urls.length > 0
    ? item.all_backdrop_urls.filter(Boolean)
    : []

  if (backdrops.length > 1) {
    const sixHours = 6 * 60 * 60 * 1000
    const timeSlot = Math.floor(Date.now() / sixHours)
    const seed = hashString(item.folder_name || item.name || item.id || item.tmdb_id || 'backdrop')
    const index = Math.abs(timeSlot + seed) % backdrops.length
    return resolveServerMediaUrl(backdrops[index], size)
  }

  const backdrop = backdrops[0]
    || item.backdrop_url
    || (item.backdrop_file_id ? `/api/gdrive-poster/${item.backdrop_file_id}` : '')
    || item.primary_backdrop_url
    || item.backdrop
    || item.background_url
    || item.fanart_url
    || (item.tmdb_backdrop_path ? getTmdbImageUrl(item.tmdb_backdrop_path, size) : '')
    || (item.backdrop_path ? getTmdbImageUrl(item.backdrop_path, size) : '')

  return resolveServerMediaUrl(backdrop, size)
}

export function getDetailArtworkUrl(item) {
  return getBackdropUrl(item, 'w1280') || getPosterUrl(item, 'w780')
}

export function getStillUrl(item) {
  if (!item) return ''
  const stillPath = item.profile_url
    || item.profile_image_url
    || (item.profile_path ? getTmdbImageUrl(item.profile_path, 'w185') : '')
    || (item.tmdb_profile_path ? getTmdbImageUrl(item.tmdb_profile_path, 'w185') : '')
    || item.still_path
    || item.still_url
    || (item.still_file_id ? `/api/gdrive-poster/${item.still_file_id}` : '')
    || item.thumbnail_url
    || item.backdrop_url
    || item.primary_backdrop_url
    || (Array.isArray(item.all_backdrop_urls) && item.all_backdrop_urls[0])
    || item.poster_url
    || item.primary_poster_url
    || (Array.isArray(item.all_poster_urls) && item.all_poster_urls[0])
    || (item.tmdb_backdrop_path ? getTmdbImageUrl(item.tmdb_backdrop_path, 'w500') : '')
    || (item.tmdb_poster_path ? getTmdbImageUrl(item.tmdb_poster_path, 'w500') : '')

  return resolveServerMediaUrl(stillPath, 'w500')
}

export function getServerStillUrl(item, size = 'w500') {
  if (!item) return ''
  const stillPath = [
    item.still_path,
    item.still_url,
    item.still_file_id ? `/api/gdrive-poster/${item.still_file_id}` : '',
    item.thumbnail_url,
  ].find(isServerManagedArtworkPath)
  return resolveServerMediaUrl(stillPath, size)
}

export function getServerBackdropUrl(item, size = 'w500') {
  if (!item) return ''
  const backdropPath = [
    ...(Array.isArray(item.all_backdrop_urls) ? item.all_backdrop_urls : []),
    item.backdrop_url,
    item.backdrop_file_id ? `/api/gdrive-poster/${item.backdrop_file_id}` : '',
    item.primary_backdrop_url,
    item.backdrop,
  ].find(isServerManagedArtworkPath)
  return resolveServerMediaUrl(backdropPath, size)
}

function isServerManagedArtworkPath(path) {
  const value = String(path || '').trim()
  if (!value || value.includes('/api/tmdb-image/')) return false
  if (/^https?:/i.test(value)) return value === API_BASE_URL || value.startsWith(`${API_BASE_URL}/`)
  return /^(?:\/?(?:api\/gdrive-poster|posters|backdrops|storage)\/|[a-zA-Z0-9_-]{20,100}$)/i.test(value)
}

export function getItemKey(item) {
  if (!item) return 'item-null'
  return `${item.type || item.media_type || 'item'}-${item.source || ''}-${item.folder_name || item.name || getTitle(item)}`
}

export function getCatalogIdentityKey(item) {
  if (!item) return ''
  const source = String(item.source || '').trim().toLowerCase()
  const title = String(item.folder_name || item.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  return `${getMediaType(item)}:${title || source || String(getTitle(item)).trim().toLowerCase()}`
}

export function getItemPath(item) {
  if (!item) return ''
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
    if (!item) return []
    const mediaPath = normalizeMediaPath(item.media_path)
    if (!mediaPath || seenPaths.has(mediaPath)) return []
    seenPaths.add(mediaPath)
    return [{ ...item, media_path: mediaPath }]
  })
}

export function getProfileAvatarUrl(profile) {
  if (!profile) return ''
  const avatarUrl = profile.avatar_url || profile.avatar || profile.image_url
  if (avatarUrl) return avatarUrl

  const profileAvatarUrl = getProfileAvatarUrlFromSeed(profile.avatar_seed)
  if (profileAvatarUrl) return profileAvatarUrl

  const seed = hashString(profile.avatar_seed || profile.id || profile.name || 'M')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 72% 48%)"/><circle cx="32" cy="25" r="13" fill="hsl(${hue} 58% 82%)"/><path d="M8 64c2-16 11-24 24-24s22 8 24 24" fill="hsl(${hue} 62% 30%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function getPersonFallbackUrl(person = {}) {
  const seed = hashString(person?.id || person?.name || 'Cast')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue} 24% 18%)"/><circle cx="60" cy="44" r="25" fill="hsl(${hue} 18% 68%)"/><path d="M12 120c4-32 20-48 48-48s44 16 48 48" fill="hsl(${hue} 22% 42%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function getPosterFallbackUrl(item) {
  if (!item) return ''
  if (item.tmdb_poster_path) return getTmdbImageUrl(item.tmdb_poster_path, 'w342')
  if (item.poster_path) return getTmdbImageUrl(item.poster_path, 'w342')
  if (item.backdrop_url && !item.backdrop_url.includes('gdrive-poster')) return resolveServerMediaUrl(item.backdrop_url, 'w500')
  return ''
}

export function getMediaType(item = {}) {
  if (!item) return 'series'
  const mediaType = String(item.media_type || item.type || '').toLowerCase()
  return mediaType === 'movie' ? 'movie' : 'series'
}

export function getGenres(item = {}) {
  if (!item) return []
  const raw = item.genres || item.genre || item.tmdb_genres || []
  if (typeof raw === 'string') {
    return raw.split(',').map((genre) => genre.trim()).filter(Boolean)
  }
  return (Array.isArray(raw) ? raw : [])
    .map((genre) => (typeof genre === 'string' ? genre : genre?.name))
    .filter(Boolean)
}

export function getRating(item) {
  if (!item) return 0
  return Number(item.rating || item.tmdb_rating || item.vote_average || 0)
}

export function getReleaseSortValue(item) {
  const releaseDate = getReleaseDate(item)
  const parsedDate = Date.parse(releaseDate)
  if (Number.isFinite(parsedDate)) return parsedDate

  const year = getReleaseYear(item)
  return year > 0 ? Date.UTC(year, 0, 1) : 0
}

export function getReleaseDate(item = {}) {
  return getMediaType(item) === 'movie'
    ? item.release_date || item.first_air_date || item.tmdb_release_date || item.tmdb_first_air_date || ''
    : item.first_air_date || item.release_date || item.tmdb_first_air_date || item.tmdb_release_date || ''
}

export function getReleaseYear(item = {}) {
  const explicitYear = Number(item.override_year || item.year || item.release_year || item.tmdb_year || 0)
  if (explicitYear > 0) return explicitYear

  const dateYear = Number(String(getReleaseDate(item)).slice(0, 4))
  if (dateYear > 0) return dateYear

  const titleYear = String(item.folder_name || item.name || item.title || '').match(/\b(19|20)\d{2}\b/)
  return titleYear ? Number(titleYear[0]) : 0
}

export function sortByNewestRelease(items = []) {
  return [...items].sort((firstItem, secondItem) => (
    getReleaseSortValue(secondItem) - getReleaseSortValue(firstItem)
    || getTitle(firstItem).localeCompare(getTitle(secondItem))
  ))
}

export function getWatchProgress(item) {
  const position = Number(item.position_ms || 0)
  const duration = Number(item.duration_ms || 0)
  if (duration <= 0) return 0
  return Math.min(100, Math.max(0, (position / duration) * 100))
}

export function isWatchCompleted(item) {
  return getWatchProgress(item) >= 90
}

export function isMyListCompleted(item) {
  return item?.my_list_status === 'completed' || item?.status === 'completed'
}

export function isCatalogItemCompleted(item, { myList = [], watchHistory = [] } = {}) {
  if (!item) return false
  const catalogKey = getCatalogIdentityKey(item)
  if (myList.some((entry) => isMyListCompleted(entry) && getCatalogIdentityKey(entry) === catalogKey)) return true
  if (getMediaType(item) !== 'movie') return false

  const itemPath = normalizeMediaPath(getItemPath(item))
  const title = normalizeLookupTitle(getTitle(item))
  return watchHistory.some((entry) => (
    isWatchCompleted(entry)
    && !entry.series_title
    && (
      normalizeMediaPath(entry.media_path) === itemPath
      || normalizeLookupTitle(entry.media_title) === title
    )
  ))
}

export function getEpisodeHistoryLabel(item = {}) {
  const title = getCleanEpisodeTitle(
    item.media_title || item.title || item.name,
    item.media_path || item.path,
  )
  if (title) return title

  const season = Number(item.season || 0)
  const episode = Number(item.episode || 0)
  if (season > 0 && episode > 0) return `Season ${season} Episode ${episode}`
  if (episode > 0) return `Episode ${episode}`
  return getCleanEpisodeTitle(item.series_title, item.media_path) || 'Continue Watching'
}

function normalizeLookupTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getCleanEpisodeTitle(value, mediaPath = '') {
  const title = String(value || '').trim()
  if (!title || isTechnicalEpisodeTitle(title, mediaPath)) return ''
  return title
}

export function isTechnicalEpisodeTitle(value, mediaPath = '') {
  const title = String(value || '').trim()
  const lower = title.toLowerCase()
  const path = String(mediaPath || '').trim().replace(/\\/g, '/').toLowerCase()
  if (!lower) return true
  if (lower === path) return true
  if (/^(?:gdrive|gdrive_folder|telegram)\//.test(lower)) return true
  if (/^https?:\/\//.test(lower)) return true

  const pathTail = path.split('/').filter(Boolean).pop()
  if (pathTail && lower === pathTail) return true
  if (/^[a-z0-9_-]{20,}$/i.test(title) && path.includes(lower)) return true

  const normalized = lower.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (/^(?:s\s*\d+\s*e\s*\d+|episode\s*\d+|ep\s*\d+)$/.test(normalized)) return true
  return /\b(?:480p|720p|1080p|2160p|web\s?dl|webrip|bluray|bdrip|hdtv|x264|x265|hevc|aac|ac3|dts)\b/.test(normalized)
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

export function getTmdbImageUrl(path, size = 'w342') {
  if (!path) return ''
  const trimmed = String(path).trim()
  if (!trimmed) return ''
  if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return trimmed
  return `https://image.tmdb.org/t/p/${size}/${trimmed.replace(/^\//, '')}`
}

export function getServerTmdbImageUrl(path, size = 'w342') {
  const value = String(path || '').trim()
  if (!value) return ''

  const proxiedMatch = value.match(/\/api\/tmdb-image\/(?:original|[wh]\d+)\/(.+)$/i)
  const imagePath = proxiedMatch ? proxiedMatch[1] : value.replace(/^\//, '')
  if (!imagePath || /^https?:/i.test(imagePath)) return ''
  return `${API_BASE_URL}/api/tmdb-image/${size}/${imagePath}`
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
