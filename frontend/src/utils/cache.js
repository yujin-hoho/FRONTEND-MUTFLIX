import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_CACHE_TTL,
  MAX_CACHED_ITEMS_PER_TYPE,
  MAX_CACHED_PROFILES,
  PROFILES_CACHE_KEY,
} from '../config'

export function readDashboardCache(profileId) {
  try {
    const cache = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || '{}')
    const entry = cache[profileId]
    if (!entry) return null
    if (!Array.isArray(entry.movies) || !Array.isArray(entry.series)) return null
    return {
      ...entry,
      movies: entry.movies.map((item) => ({ ...item, media_type: 'movie', type: 'movie' })),
      series: entry.series.map((item) => ({ ...item, media_type: 'tv', type: 'series' })),
    }
  } catch {
    localStorage.removeItem(DASHBOARD_CACHE_KEY)
    return null
  }
}

export function writeDashboardCache(profileId, { history, movies, series }) {
  try {
    const cache = JSON.parse(localStorage.getItem(DASHBOARD_CACHE_KEY) || '{}')
    const entries = Object.entries(cache)
      .filter(([, entry]) => entry && Date.now() - entry.cachedAt <= DASHBOARD_CACHE_TTL)
      .sort(([, a], [, b]) => b.cachedAt - a.cachedAt)
      .slice(0, MAX_CACHED_PROFILES - 1)

    const nextCache = Object.fromEntries(entries)
    nextCache[profileId] = {
      cachedAt: Date.now(),
      history: Array.isArray(history) ? history.slice(0, 20) : [],
      movies: movies.slice(0, MAX_CACHED_ITEMS_PER_TYPE),
      series: series.slice(0, MAX_CACHED_ITEMS_PER_TYPE),
    }
    localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(nextCache))
  } catch {
    localStorage.removeItem(DASHBOARD_CACHE_KEY)
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
