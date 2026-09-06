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
