export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space').replace(/\/$/, '')
export const DASHBOARD_CACHE_KEY = 'mutflix_dashboard_cache_v1'
export const PROFILES_CACHE_KEY = 'mutflix_profiles_cache_v1'
export const DASHBOARD_CACHE_TTL = 6 * 60 * 60 * 1000
export const MAX_CACHED_PROFILES = 3
export const MAX_CACHED_ITEMS_PER_TYPE = 80
export const EPISODES_PER_PAGE = 12
