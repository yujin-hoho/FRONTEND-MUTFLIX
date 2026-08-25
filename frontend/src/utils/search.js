import { getCatalogIdentityKey, getGenres, getMediaType, getRating, sortByNewestRelease } from './media'

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
      item.tmdb_query,
      item.title,
      item.name,
      item.folder_name,
      item.original_title,
      item.original_name,
      item.series_title,
      item.media_title,
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
    return sortByNewestRelease(items.filter((item) => (
      getMediaType(item) === normalizedValue
      && (normalizedValue !== 'series' || !isVarietyShow(item))
    )))
  }
  if (filter.type === 'genre') {
    return sortByNewestRelease(items.filter((item) => getGenres(item).some((genre) => normalizeSearchQuery(genre) === normalizedValue)))
  }
  if (filter.type === 'category' && normalizedValue === 'variety show') {
    return sortByNewestRelease(items.filter(isVarietyShow))
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

  const strictMatches = entries
    .map((entry) => ({ entry, score: getSearchScore(entry, normalizedQuery) }))
    .filter(({ score }) => score > 0)

  const matches = strictMatches.length > 0
    ? strictMatches
    : entries
      .map((entry) => ({ entry, score: getSearchScore(entry, normalizedQuery, { allowFuzzy: true }) }))
      .filter(({ score }) => score > 0)

  return matches
    .sort((a, b) => b.score - a.score || b.entry.rating - a.entry.rating || a.entry.index - b.entry.index)
    .slice(0, limit)
    .map(({ entry }) => entry.item)
}

export function mergeSearchResults(primaryItems, fallbackItems, query = '') {
  const itemIndexes = new Map()
  const mergedItems = []
  const allItems = [...primaryItems, ...fallbackItems]
  allItems.forEach((item) => {
    const key = getCatalogIdentityKey(item)
    const existingIndex = itemIndexes.get(key)
    if (existingIndex !== undefined) {
      mergedItems[existingIndex] = mergeCatalogMetadata(mergedItems[existingIndex], item)
      return
    }
    itemIndexes.set(key, mergedItems.length)
    mergedItems.push(item)
  })

  if (!normalizeSearchQuery(query)) return mergedItems
  return searchCatalog(prepareSearchCatalog(mergedItems), query)
}

function mergeCatalogMetadata(primaryItem, fallbackItem) {
  const meaningfulPrimaryFields = Object.fromEntries(
    Object.entries(primaryItem).filter(([, value]) => (
      value !== undefined
      && value !== null
      && value !== ''
      && (!Array.isArray(value) || value.length > 0)
    )),
  )
  return { ...fallbackItem, ...meaningfulPrimaryFields }
}

function getSearchScore({ aliases, genres }, query, { allowFuzzy = false } = {}) {
  const queryWords = query.split(' ')
  const aliasScore = aliases.reduce((bestScore, alias) => {
    const aliasWords = alias.split(' ')
    if (alias === query) return Math.max(bestScore, 1000)
    if (alias.startsWith(`${query} `)) return Math.max(bestScore, 900)
    if (containsWordSequence(aliasWords, queryWords)) return Math.max(bestScore, 800)

    if (queryWords.every((word) => aliasWords.includes(word))) {
      const coverageBonus = Math.round((queryWords.length / aliasWords.length) * 50)
      return Math.max(bestScore, 700 + coverageBonus)
    }

    if (
      queryWords.every((word) => word.length >= 2)
      && queryWords.every((word) => aliasWords.some((aliasWord) => aliasWord.startsWith(word)))
    ) return Math.max(bestScore, 550)

    if (allowFuzzy && (
      queryWords.every((word) => word.length >= 3)
      && queryWords.every((word) => aliasWords.some((aliasWord) => isFuzzyWordMatch(aliasWord, word)))
    )) return Math.max(bestScore, 400)

    return bestScore
  }, 0)

  if (aliasScore) return aliasScore
  if (genres.some((genre) => genre === query)) return 100
  return 0
}

function containsWordSequence(candidateWords, queryWords) {
  if (queryWords.length > candidateWords.length) return false
  return candidateWords.some((_, startIndex) => (
    queryWords.every((word, queryIndex) => candidateWords[startIndex + queryIndex] === word)
  ))
}

function isFuzzyWordMatch(candidate, query) {
  if (candidate === query) return true
  if (query.length < 3 || candidate.length < 3 || Math.abs(candidate.length - query.length) > 1) return false

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
