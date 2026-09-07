// A source identifies a server, not a title. Never use it as an item alias.
export function findCatalogItemForHistory(historyItem, catalogItems) {
  const seriesPath = normalizePath(historyItem.series_path)
  if (seriesPath) {
    const pathMatches = catalogItems.filter((item) => (
      [item.path, item.folder_name, item.name, /^(?:gdrive|gdrive_folder|telegram)\//.test(item.source || '') ? item.source : '']
        .some((path) => normalizePath(path) === seriesPath)
    ))
    if (pathMatches.length === 1) return pathMatches[0]
    if (pathMatches.length > 1) return null
  }

  const candidates = [historyItem.series_title, historyItem.media_title]
    .map(normalizeTitle)
    .filter(Boolean)
  for (const candidate of candidates) {
    const matches = catalogItems.filter((item) => (
      [item.folder_name, item.name, item.tmdb_title, item.title, item.series_title, item.media_title]
        .some((alias) => normalizeTitle(alias) === candidate)
    ))
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return null
  }
  return null
}

const HISTORY_ARTWORK_FIELDS = [
  'still_path',
  'still_url',
  'still_file_id',
  'thumbnail_url',
  'backdrop_url',
  'primary_backdrop_url',
  'backdrop_file_id',
  'all_backdrop_urls',
]

// A history refresh may briefly return an entry before its episode artwork has
// been enriched. Keep the last usable artwork for the same media path, while
// still allowing a newly resolved value to replace it.
export function preserveWatchHistoryArtwork(nextHistory = [], previousHistory = []) {
  const previousByPath = new Map(
    previousHistory
      .filter(Boolean)
      .map((entry) => [normalizePath(entry.media_path), entry]),
  )

  return nextHistory.map((entry) => {
    const previous = previousByPath.get(normalizePath(entry?.media_path))
    if (!entry || !previous) return entry

    const preservedArtwork = {}
    HISTORY_ARTWORK_FIELDS.forEach((field) => {
      if (!hasUsableArtworkValue(entry[field]) && hasUsableArtworkValue(previous[field])) {
        preservedArtwork[field] = previous[field]
      }
    })
    return Object.keys(preservedArtwork).length
      ? { ...entry, ...preservedArtwork }
      : entry
  })
}

function hasUsableArtworkValue(value) {
  if (Array.isArray(value)) return value.some(Boolean)
  return value !== null && value !== undefined && value !== ''
}

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
