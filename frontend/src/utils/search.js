import { getCatalogIdentityKey, getGenres, getMediaType, getRating } from './media'

export function normalizeSearchQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

export function prepareSearchCatalog(items) {
  return items.map((item, index) => ({
    aliases: [...new Set([
      item.tmdb_title,
      item.title,
      item.name,
      item.folder_name,
    ].map(normalizeSearchQuery).filter(Boolean))],
    genres: getGenres(item).map(normalizeSearchQuery),
    index,
    item,
    rating: getRating(item),
  }))
}

export function getCatalogFilters(items) {
  const mediaTypes = new Set(items.map(getMediaType))
  const genres = new Map()
  const hasVarietyShows = items.some(isVarietyShow)
  const hasSeries = items.some((item) => getMediaType(item) === 'series' && !isVarietyShow(item))

  items.forEach((item) => {
    getGenres(item).forEach((genre) => {
      const normalizedGenre = normalizeSearchQuery(genre)
      if (normalizedGenre && !genres.has(normalizedGenre)) genres.set(normalizedGenre, genre)
    })
  })

  return [
    mediaTypes.has('movie') ? { label: 'Movies', type: 'type', value: 'movie' } : null,
    hasSeries ? { label: 'Series', type: 'type', value: 'series' } : null,
    hasVarietyShows ? { label: 'Variety Show', type: 'category', value: 'variety-show' } : null,
    ...[...genres.entries()]
      .sort(([, firstLabel], [, secondLabel]) => firstLabel.localeCompare(secondLabel))
      .map(([value, label]) => ({ label, type: 'genre', value })),
  ].filter(Boolean)
}

export function filterCatalogItems(items, filter) {
  if (!filter?.type || !filter.value) return items
  const normalizedValue = normalizeSearchQuery(filter.value)

  if (filter.type === 'type') {
    return items.filter((item) => (
      getMediaType(item) === normalizedValue
      && (normalizedValue !== 'series' || !isVarietyShow(item))
    ))
  }
  if (filter.type === 'genre') {
    return items.filter((item) => getGenres(item).some((genre) => normalizeSearchQuery(genre) === normalizedValue))
  }
  if (filter.type === 'category' && normalizedValue === 'variety show') {
    return items.filter(isVarietyShow)
  }
  return items
}

function isVarietyShow(item) {
  if (getMediaType(item) !== 'series') return false
  const genres = getGenres(item).map(normalizeSearchQuery)
  return genres.some((genre) => ['reality', 'talk', 'variety show'].includes(genre))
}

export function searchCatalog(entries, query, { limit = Infinity } = {}) {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return []

  return entries
    .map((entry) => ({ entry, score: getSearchScore(entry, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.rating - a.entry.rating || a.entry.index - b.entry.index)
    .slice(0, limit)
    .map(({ entry }) => entry.item)
}

export function mergeSearchResults(primaryItems, fallbackItems) {
  const seen = new Set()
  return [...primaryItems, ...fallbackItems].filter((item) => {
    const key = getCatalogIdentityKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getSearchScore({ aliases, genres }, query) {
  if (aliases.some((alias) => alias === query)) return 100
  if (aliases.some((alias) => alias.startsWith(query))) return 80
  if (aliases.some((alias) => alias.includes(query))) return 60

  const queryWords = query.split(' ')
  const aliasWords = aliases.flatMap((alias) => alias.split(' '))
  if (queryWords.every((word) => aliasWords.some((aliasWord) => aliasWord.startsWith(word)))) return 50
  if (queryWords.every((word) => aliasWords.some((aliasWord) => isFuzzyWordMatch(aliasWord, word)))) return 40
  if (genres.some((genre) => genre === query)) return 25
  if (genres.some((genre) => genre.includes(query))) return 15
  return 0
}

function isFuzzyWordMatch(candidate, query) {
  if (candidate.includes(query) || query.includes(candidate)) return true
  if (query.length < 3 || Math.abs(candidate.length - query.length) > 1) return false

  let candidateIndex = 0
  let queryIndex = 0
  let edits = 0
  while (candidateIndex < candidate.length && queryIndex < query.length) {
    if (candidate[candidateIndex] === query[queryIndex]) {
      candidateIndex += 1
      queryIndex += 1
      continue
    }
    edits += 1
    if (edits > 1) return false
    if (candidate.length > query.length) candidateIndex += 1
    else if (query.length > candidate.length) queryIndex += 1
    else {
      candidateIndex += 1
      queryIndex += 1
    }
  }
  return edits + (candidateIndex < candidate.length || queryIndex < query.length ? 1 : 0) <= 1
}
