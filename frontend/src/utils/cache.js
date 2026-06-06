import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_CACHE_TTL,
  MAX_CACHED_ITEMS_PER_TYPE,
  MAX_CACHED_METADATA_ITEMS,
  MAX_CACHED_PROFILES,
  PROFILES_CACHE_KEY,
} from '../config'
import {
  getBackdropUrl,
  getCatalogIdentityKey,
  getGenres,
  getItemPath,
  getPosterUrl,
  getRating,
  normalizeWatchHistory,
} from './media'

const CATALOG_METADATA_FIELDS = [
  'tmdb_metadata_resolved',
  'tmdb_id',
  'tmdb_override_id',
  'tmdb_title',
  'tmdb_poster_path',
  'tmdb_backdrop_path',
  'tmdb_rating',
  'tmdb_genres',
  'tmdb_original_language',
  'origin_country',
  'production_countries',
  'original_language',
  'poster_path',
  'backdrop_path',
  'thumbnail_path',
  'image_url',
  'vote_average',
  'genres',
]
const LEGACY_DASHBOARD_CACHE_KEYS = ['mutflix_dashboard_cache_v1', 'mutflix_dashboard_cache_v2']
const TMDB_OVERRIDE_CACHE_KEY = 'mutflix_tmdb_override_cache_v1'

export function readDashboardCache(profileId) {
  try {
    removeLegacyDashboardCaches()
    const cache = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || '{}')
    const entry = cache[profileId]
    if (!entry) return null
    if (!Array.isArray(entry.movies) || !Array.isArray(entry.series)) return null
    return {
      ...entry,
      history: normalizeWatchHistory(entry.history),
      metadata: normalizeCatalogMetadataCache(entry.metadata),
      movies: entry.movies.map((item) => applyLocalTmdbOverride({ ...item, media_type: 'movie', type: 'movie' })),
      rows: normalizeDashboardRowsSnapshot(entry.rows),
      series: entry.series.map((item) => applyLocalTmdbOverride({ ...item, media_type: 'tv', type: 'series' })),
    }
  } catch {
    localStorage.removeItem(DASHBOARD_CACHE_KEY)
    return null
  }
}

export function writeDashboardCache(profileId, { history, movies, rows, series }) {
  try {
    removeLegacyDashboardCaches()
    const cache = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || '{}')
    const profileKey = String(profileId)
    const previousEntry = cache[profileKey] || {}
    const movieItems = Array.isArray(movies) ? movies : []
    const seriesItems = Array.isArray(series) ? series : []
    const metadata = buildCatalogMetadataCache(previousEntry.metadata, movieItems, seriesItems)
    const dashboardRows = normalizeDashboardRowsSnapshot(rows || previousEntry.rows)
    const entries = Object.entries(cache)
      .filter(([entryProfileId, entry]) => (
        entryProfileId !== profileKey
        && entry
        && Date.now() - entry.cachedAt <= DASHBOARD_CACHE_TTL
      ))
      .sort(([, a], [, b]) => b.cachedAt - a.cachedAt)
      .slice(0, MAX_CACHED_PROFILES - 1)
    const attempts = [
      { entries, itemLimit: MAX_CACHED_ITEMS_PER_TYPE, metadataLimit: MAX_CACHED_METADATA_ITEMS, rowItemLimit: 24 },
      { entries, itemLimit: MAX_CACHED_ITEMS_PER_TYPE, metadataLimit: Math.floor(MAX_CACHED_METADATA_ITEMS / 2), rowItemLimit: 24 },
      { entries: [], itemLimit: Math.max(40, Math.floor(MAX_CACHED_ITEMS_PER_TYPE / 2)), metadataLimit: Math.floor(MAX_CACHED_METADATA_ITEMS / 4), rowItemLimit: 18 },
      { entries: [], itemLimit: Math.max(20, Math.floor(MAX_CACHED_ITEMS_PER_TYPE / 4)), metadataLimit: 0, rowItemLimit: 15 },
    ]

    for (const attempt of attempts) {
      const nextCache = Object.fromEntries(attempt.entries)
      nextCache[profileKey] = createDashboardCacheEntry({
        history,
        itemLimit: attempt.itemLimit,
        metadata,
        metadataLimit: attempt.metadataLimit,
        movies: movieItems,
        previousMovies: previousEntry.movies,
        previousSeries: previousEntry.series,
        rowItemLimit: attempt.rowItemLimit,
        rows: dashboardRows,
        series: seriesItems,
      })

      try {
        localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(nextCache))
        return
      } catch {
        // Retry with a smaller payload before giving up on the dashboard cache.
      }
    }
  } catch {
    localStorage.removeItem(DASHBOARD_CACHE_KEY)
  }
}

export function mergeDashboardCache(catalog, cachedDashboard) {
  if (!cachedDashboard) return catalog

  return {
    ...catalog,
    movies: mergeCachedCatalogItems(catalog.movies, cachedDashboard, 'movie'),
    series: mergeCachedCatalogItems(catalog.series, cachedDashboard, 'series'),
  }
}

export function writeLocalTmdbOverride(item) {
  try {
    const folderName = getLocalOverrideFolderName(item)
    if (!folderName || !Number(item?.tmdb_id || 0)) return

    const cache = readLocalTmdbOverrides()
    cache[folderName] = {
      ...snapshotCatalogItem(item),
      folder_name: folderName,
      media_type: item.media_type,
      type: item.type,
      tmdb_override_id: Number(item.tmdb_id),
      _cachedAt: Date.now(),
    }
    localStorage.setItem(TMDB_OVERRIDE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    localStorage.removeItem(TMDB_OVERRIDE_CACHE_KEY)
  }
}

export function clearDashboardCache() {
  localStorage.removeItem(DASHBOARD_CACHE_KEY)
  removeLegacyDashboardCaches()
}

export function createDashboardRowsSnapshot(dashboardView) {
  const snapshot = {
    catalogRows: normalizeDashboardRows(dashboardView.catalogRows, 24),
    curatedRows: normalizeDashboardRows(dashboardView.curatedRows, 24),
    featuredBackdrop: dashboardView.featuredBackdrop || '',
    featuredFallback: dashboardView.featuredFallback || '',
    featuredItem: snapshotCatalogItem(dashboardView.featuredItem),
  }

  return {
    ...snapshot,
    signature: getDashboardRowsSignature(snapshot),
  }
}

export function readProfilesCache() {
  try {
    const profiles = JSON.parse(localStorage.getItem(PROFILES_CACHE_KEY) || '[]')
    return Array.isArray(profiles) ? profiles.slice(0, 12) : []
  } catch {
    localStorage.removeItem(PROFILES_CACHE_KEY)
    return []
  }
}

export function writeProfilesCache(profiles) {
  try {
    localStorage.setItem(PROFILES_CACHE_KEY, JSON.stringify(profiles.slice(0, 12)))
  } catch {
    localStorage.removeItem(PROFILES_CACHE_KEY)
  }
}

function createDashboardCacheEntry({
  history,
  itemLimit,
  metadata,
  metadataLimit,
  movies,
  previousMovies,
  previousSeries,
  rowItemLimit,
  rows,
  series,
}) {
  return {
    cachedAt: Date.now(),
    history: normalizeWatchHistory(history).slice(0, 100),
    metadata: limitCatalogMetadata(metadata, metadataLimit),
    movies: selectCachedCatalogItems(movies, itemLimit, previousMovies),
    rows: limitDashboardRowsSnapshot(rows, rowItemLimit),
    series: selectCachedCatalogItems(series, itemLimit, previousSeries),
  }
}

function mergeCachedCatalogItems(items = [], cachedDashboard, type) {
  const cachedItems = type === 'movie' ? cachedDashboard.movies : cachedDashboard.series
  const cachedByKey = new Map((cachedItems || []).map((item) => [getCatalogIdentityKey(item), item]))
  const metadata = cachedDashboard.metadata || {}

  return items.map((item) => {
    const typedItem = normalizeCatalogItemType(item, type)
    const itemKey = getCatalogIdentityKey(typedItem)
    const cachedItem = cachedByKey.get(itemKey) || {}
    const cachedMetadata = metadata[itemKey] || {}
    const hasMismatchedOverride = hasOverrideMetadataMismatch(typedItem, cachedItem, cachedMetadata)

    return applyLocalTmdbOverride(mergeMeaningfulValues(
      hasMismatchedOverride ? stripCatalogMetadata(cachedItem) : cachedItem,
      hasMismatchedOverride ? {} : cachedMetadata,
      typedItem,
      normalizeCatalogItemType({}, type),
    ))
  })
}

function buildCatalogMetadataCache(previousMetadata, movies, series) {
  const now = Date.now()
  const metadata = normalizeCatalogMetadataCache(previousMetadata)

  ;[...movies, ...series].forEach((item) => {
    if (!hasCacheableCatalogMetadata(item)) return

    const itemKey = getCatalogIdentityKey(item)
    if (!itemKey) return

    const existingMetadata = metadata[itemKey] || {}
    metadata[itemKey] = pickCatalogMetadata(
      item,
      hasOverrideMetadataMismatch(item, {}, existingMetadata) ? {} : existingMetadata,
      now,
    )
  })

  return metadata
}

function normalizeCatalogMetadataCache(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}

  return Object.fromEntries(
    Object.entries(metadata).flatMap(([itemKey, entry]) => {
      if (!itemKey || !entry || typeof entry !== 'object' || Array.isArray(entry)) return []

      const normalizedEntry = {}
      CATALOG_METADATA_FIELDS.forEach((field) => {
        if (!isMeaningfulValue(field, entry[field])) return
        normalizedEntry[field] = normalizeMetadataValue(field, entry[field])
      })

      const cachedAt = Number(entry._cachedAt || entry.cachedAt || 0)
      if (cachedAt > 0) normalizedEntry._cachedAt = cachedAt

      return hasCatalogMetadataFields(normalizedEntry) ? [[itemKey, normalizedEntry]] : []
    }),
  )
}

function normalizeDashboardRowsSnapshot(rows) {
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return null

  const snapshot = {
    catalogRows: normalizeDashboardRows(rows.catalogRows, 24),
    curatedRows: normalizeDashboardRows(rows.curatedRows, 24),
    featuredBackdrop: typeof rows.featuredBackdrop === 'string' ? rows.featuredBackdrop : '',
    featuredFallback: typeof rows.featuredFallback === 'string' ? rows.featuredFallback : '',
    featuredItem: snapshotCatalogItem(rows.featuredItem),
  }

  if (!snapshot.curatedRows.length && !snapshot.catalogRows.length) return null

  return {
    ...snapshot,
    signature: typeof rows.signature === 'string' ? rows.signature : getDashboardRowsSignature(snapshot),
  }
}

function normalizeDashboardRows(rows, itemLimit) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!row || typeof row !== 'object') return []

    const items = (Array.isArray(row.items) ? row.items : [])
      .slice(0, itemLimit)
      .map(snapshotCatalogItem)
      .filter(Boolean)
    if (!items.length) return []

    return [{
      genre: String(row.genre || row.title || '').trim() || 'Catalog',
      items,
      ranked: Boolean(row.ranked),
    }]
  })
}

function limitDashboardRowsSnapshot(rows, itemLimit) {
  if (!rows) return null

  const snapshot = {
    ...rows,
    catalogRows: normalizeDashboardRows(rows.catalogRows, itemLimit),
    curatedRows: normalizeDashboardRows(rows.curatedRows, itemLimit),
    featuredItem: snapshotCatalogItem(rows.featuredItem),
  }

  return {
    ...snapshot,
    signature: getDashboardRowsSignature(snapshot),
  }
}

function pickCatalogMetadata(item, existing = {}, now) {
  const entry = { _cachedAt: existing._cachedAt || now }
  let changed = false

  CATALOG_METADATA_FIELDS.forEach((field) => {
    const value = isMeaningfulValue(field, item[field])
      ? item[field]
      : existing[field]
    if (!isMeaningfulValue(field, value)) return

    const normalizedValue = normalizeMetadataValue(field, value)
    if (!areMetadataValuesEqual(existing[field], normalizedValue)) changed = true
    entry[field] = normalizedValue
  })

  if (changed) entry._cachedAt = now
  return entry
}

function selectCachedCatalogItems(items, limit, previousItems = []) {
  const previousKeys = new Set((previousItems || []).map(getCatalogIdentityKey))

  return [...items]
    .map((item, index) => ({
      index,
      item,
      score: getCatalogCacheScore(item, previousKeys),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item)
}

function limitCatalogMetadata(metadata, limit) {
  if (limit <= 0) return {}

  return Object.fromEntries(
    Object.entries(metadata)
      .sort(([, a], [, b]) => (
        getMetadataCacheScore(b) - getMetadataCacheScore(a)
        || Number(b._cachedAt || 0) - Number(a._cachedAt || 0)
      ))
      .slice(0, limit),
  )
}

function getCatalogCacheScore(item, previousKeys) {
  let score = previousKeys.has(getCatalogIdentityKey(item)) ? 3 : 0
  if (item.tmdb_metadata_resolved) score += 15
  if (getPosterUrl(item)) score += 50
  if (getBackdropUrl(item)) score += 20
  if (getGenres(item).length) score += 10
  if (getRating(item) > 0) score += 5
  return score
}

function getMetadataCacheScore(metadata) {
  let score = metadata.tmdb_metadata_resolved ? 15 : 0
  if (metadata.tmdb_poster_path || metadata.poster_path || metadata.thumbnail_path || metadata.image_url) score += 50
  if (metadata.tmdb_backdrop_path || metadata.backdrop_path) score += 20
  if ((metadata.tmdb_genres || metadata.genres || []).length) score += 10
  if (Number(metadata.tmdb_rating || metadata.vote_average || 0) > 0) score += 5
  return score
}

function hasCacheableCatalogMetadata(item) {
  return CATALOG_METADATA_FIELDS.some((field) => isMeaningfulValue(field, item[field]))
    || Boolean(getPosterUrl(item) || getBackdropUrl(item) || getGenres(item).length || getRating(item) > 0)
}

function hasCatalogMetadataFields(entry) {
  return CATALOG_METADATA_FIELDS.some((field) => isMeaningfulValue(field, entry[field]))
}

function normalizeCatalogItemType(item, type) {
  return {
    ...item,
    media_type: type === 'movie' ? 'movie' : 'tv',
    type: type === 'movie' ? 'movie' : 'series',
  }
}

function normalizeMetadataValue(field, value) {
  if (field === 'tmdb_metadata_resolved') return value === true
  if (field === 'tmdb_id' || field === 'tmdb_override_id') return Number(value)
  if (field === 'tmdb_rating' || field === 'vote_average') return Number(value)
  if (field === 'tmdb_genres' || field === 'genres') {
    return (Array.isArray(value) ? value : [value])
      .map((genre) => typeof genre === 'string' ? genre : genre.name)
      .filter(Boolean)
      .slice(0, 12)
  }
  if (field === 'origin_country') {
    return (Array.isArray(value) ? value : [value])
      .map((country) => String(country || '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 8)
  }
  if (field === 'production_countries') {
    return (Array.isArray(value) ? value : [value])
      .map((country) => {
        if (typeof country === 'string') return country
        return country?.iso_3166_1 || country?.code || country?.name || ''
      })
      .map((country) => String(country || '').trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 8)
  }
  return value
}

function snapshotCatalogItem(item) {
  if (!item || typeof item !== 'object') return null

  const snapshot = {}
  ;[
    'type',
    'media_type',
    'source',
    'folder_name',
    'name',
    'title',
    ...CATALOG_METADATA_FIELDS,
  ].forEach((field) => {
    if (!isMeaningfulValue(field, item[field])) return
    snapshot[field] = normalizeMetadataValue(field, item[field])
  })

  return Object.keys(snapshot).length ? snapshot : null
}

function getDashboardRowsSignature(rows) {
  return [
    rows.featuredItem ? getDashboardItemSignature(rows.featuredItem) : '',
    ...rows.curatedRows.map(getDashboardRowSignature),
    ...rows.catalogRows.map(getDashboardRowSignature),
  ].join('|')
}

function getDashboardRowSignature(row) {
  return `${row.genre}:${row.ranked ? '1' : '0'}:${row.items.map(getDashboardItemSignature).join(',')}`
}

function getDashboardItemSignature(item) {
  return `${getCatalogIdentityKey(item)}@${getPosterUrl(item)}@${getBackdropUrl(item)}`
}

function removeLegacyDashboardCaches() {
  LEGACY_DASHBOARD_CACHE_KEYS.forEach((cacheKey) => localStorage.removeItem(cacheKey))
}

function mergeMeaningfulValues(...sources) {
  return sources.reduce((merged, source) => {
    Object.entries(source).forEach(([key, value]) => {
      if (key.startsWith('_') || !isMeaningfulValue(key, value)) return
      merged[key] = value
    })
    return merged
  }, {})
}

function isMeaningfulValue(key, value) {
  if (value === null || value === undefined || value === '') return false
  if (key === 'tmdb_metadata_resolved') return value === true
  if (key === 'tmdb_id' || key === 'tmdb_override_id') return Number(value) > 0
  if (key === 'tmdb_rating' || key === 'vote_average') return Number(value) > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function hasOverrideMetadataMismatch(item, cachedItem, cachedMetadata) {
  const overrideId = Number(item.tmdb_override_id || 0)
  if (!overrideId) return false
  const cachedTmdbId = Number(cachedItem.tmdb_id || cachedMetadata.tmdb_id || 0)
  return cachedTmdbId !== overrideId
}

function stripCatalogMetadata(item) {
  if (!item || typeof item !== 'object') return {}
  const stripped = { ...item }
  CATALOG_METADATA_FIELDS.forEach((field) => {
    if (field !== 'tmdb_override_id') delete stripped[field]
  })
  return stripped
}

function applyLocalTmdbOverride(item) {
  const folderName = getLocalOverrideFolderName(item)
  if (!folderName) return item

  const override = readLocalTmdbOverrides()[folderName]
  if (!override) return item

  const serverOverrideId = Number(item.tmdb_override_id || 0)
  const localOverrideId = Number(override.tmdb_id || override.tmdb_override_id || 0)
  if (serverOverrideId && localOverrideId && serverOverrideId !== localOverrideId) return item

  return mergeMeaningfulValues(item, override, {
    tmdb_id: localOverrideId || item.tmdb_id,
    tmdb_metadata_resolved: true,
    tmdb_override_id: serverOverrideId || localOverrideId || item.tmdb_override_id,
  })
}

function readLocalTmdbOverrides() {
  try {
    const cache = JSON.parse(localStorage.getItem(TMDB_OVERRIDE_CACHE_KEY) || '{}')
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {}
    const now = Date.now()
    return Object.fromEntries(
      Object.entries(cache).filter(([, entry]) => (
        entry
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && Number(entry.tmdb_id || entry.tmdb_override_id || 0) > 0
        && now - Number(entry._cachedAt || entry.cachedAt || now) <= DASHBOARD_CACHE_TTL
      )),
    )
  } catch {
    localStorage.removeItem(TMDB_OVERRIDE_CACHE_KEY)
    return {}
  }
}

function getLocalOverrideFolderName(item) {
  return String(getItemPath(item) || item?.folder_name || item?.name || '').trim()
}

function areMetadataValuesEqual(first, second) {
  if (Array.isArray(first) || Array.isArray(second)) {
    return JSON.stringify(first || []) === JSON.stringify(second || [])
  }
  return first === second
}
