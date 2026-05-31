import { getGenres, getRating, getTitle } from './media'

export function normalizeSearchQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

export function prepareSearchCatalog(items) {
  return items.map((item, index) => ({
    folderName: normalizeSearchQuery(item.folder_name || item.name),
    genres: getGenres(item).map(normalizeSearchQuery),
    index,
    item,
    rating: getRating(item),
    title: normalizeSearchQuery(getTitle(item)),
  }))
}

export function searchCatalog(entries, query, { limit = Infinity } = {}) {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return []

  return entries
    .map((entry) => ({
      ...entry,
      score: getSearchScore(entry, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.rating - a.rating || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item)
}

function getSearchScore({ folderName, genres, title }, query) {
  if (title === query) return 100
  if (title.startsWith(query)) return 80
  if (title.includes(query)) return 60
  if (folderName.startsWith(query)) return 45
  if (folderName.includes(query)) return 35
  if (genres.some((genre) => genre === query)) return 25
  if (genres.some((genre) => genre.includes(query))) return 15
  return 0
}
