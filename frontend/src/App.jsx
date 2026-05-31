import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, LogOut, Play, Plus, Search, User, UsersRound } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import './App.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space').replace(/\/$/, '')
const DASHBOARD_CACHE_KEY = 'mutflix_dashboard_cache_v1'
const PROFILES_CACHE_KEY = 'mutflix_profiles_cache_v1'
const DASHBOARD_CACHE_TTL = 6 * 60 * 60 * 1000
const MAX_CACHED_PROFILES = 3
const MAX_CACHED_ITEMS_PER_TYPE = 80
const EPISODES_PER_PAGE = 12

function createProfileId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getTitle(item) {
  return item.tmdb_title || item.title || item.name || item.folder_name || 'Untitled'
}

function getPosterUrl(item, size = 'w342') {
  const posterPath = item.tmdb_poster_path || item.poster_path
  if (!posterPath) return ''
  return `${API_BASE_URL}/api/tmdb-image/${size}/${posterPath.replace(/^\//, '')}`
}

function getBackdropUrl(item, size = 'original') {
  const backdropPath = item.tmdb_backdrop_path || item.backdrop_path
  if (!backdropPath) return ''
  return `${API_BASE_URL}/api/tmdb-image/${size}/${backdropPath.replace(/^\//, '')}`
}

function getStillUrl(item) {
  const stillPath = item.still_path || item.poster_path || item.thumbnail_path || item.profile_path
  if (!stillPath) return ''
  if (stillPath.startsWith('http')) return stillPath
  return `${API_BASE_URL}/api/tmdb-image/w500/${stillPath.replace(/^\//, '')}`
}

function getItemKey(item) {
  return `${item.type || item.media_type || 'item'}-${item.source || ''}-${item.folder_name || item.name || getTitle(item)}`
}

function getItemPath(item) {
  const source = item.source || ''
  if (/^(?:gdrive|gdrive_folder|telegram)\//.test(source)) return source
  return item.folder_name || item.name || source
}

function getDetailUrl(item) {
  return `/detail/${encodeURIComponent(getTitle(item))}`
}

function getProfileAvatarUrl(profile) {
  const avatarUrl = profile.avatar_url || profile.avatar || profile.image_url
  if (avatarUrl) return avatarUrl

  const seed = hashString(profile.avatar_seed || profile.id || profile.name || 'M')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 72% 48%)"/><circle cx="32" cy="25" r="13" fill="hsl(${hue} 58% 82%)"/><path d="M8 64c2-16 11-24 24-24s22 8 24 24" fill="hsl(${hue} 62% 30%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function getPersonFallbackUrl(person = {}) {
  const seed = hashString(person.id || person.name || 'Cast')
  const hue = Math.abs(seed) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="hsl(${hue} 24% 18%)"/><circle cx="60" cy="44" r="25" fill="hsl(${hue} 18% 68%)"/><path d="M12 120c4-32 20-48 48-48s44 16 48 48" fill="hsl(${hue} 22% 42%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function getMediaType(item) {
  const mediaType = String(item.media_type || item.type || '').toLowerCase()
  return mediaType === 'movie' ? 'movie' : 'series'
}

function getGenres(item) {
  return (item.tmdb_genres || item.genres || [])
    .map((genre) => typeof genre === 'string' ? genre : genre.name)
    .filter(Boolean)
}

function getRating(item) {
  return Number(item.tmdb_rating || item.vote_average || 0)
}

function getWatchProgress(item) {
  const position = Number(item.position_ms || 0)
  const duration = Number(item.duration_ms || 0)
  if (duration <= 0) return 0
  return Math.min(100, Math.max(0, (position / duration) * 100))
}

function formatDuration(video) {
  const durationMs = Number(video.duration_ms || 0)
  if (durationMs <= 0) return ''
  return `${Math.max(1, Math.round(durationMs / 60000))}m`
}

async function enrichEpisodesFromServer(item, videos, headers) {
  if (getMediaType(item) === 'movie' || !videos.length) return videos

  const folderName = item.folder_name || item.name || getItemPath(item)
  if (!folderName) return videos

  try {
    const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/tv?folder_name=${encodeURIComponent(folderName)}`, { headers })
    const meta = await metaResponse.json().catch(() => ({}))
    const tmdbId = metaResponse.ok ? meta.id : null
    if (!tmdbId) return videos

    const seasons = [...new Set(videos.map((video) => Number(video.season || 1)))]
    const seasonResponses = await Promise.all(seasons.map(async (season) => {
      const response = await fetch(`${API_BASE_URL}/api/tmdb/tv/${tmdbId}/season/${season}`, { headers })
      const data = await response.json().catch(() => ({}))
      return response.ok && Array.isArray(data.episodes) ? data.episodes : []
    }))
    const episodeMap = new Map()
    seasonResponses.flat().forEach((episode) => {
      episodeMap.set(`${episode.season_number}:${episode.episode_number}`, episode)
    })

    return videos.map((video) => {
      const episode = episodeMap.get(`${Number(video.season || 1)}:${Number(video.episode || 0)}`)
      if (!episode) return video
      return {
        ...video,
        name: episode.name || video.name,
        overview: episode.overview || '',
        still_path: episode.still_path || '',
      }
    })
  } catch {
    return videos
  }
}

async function getCreditsFromServer(item, headers) {
  const mediaType = getMediaType(item) === 'movie' ? 'movie' : 'tv'
  const folderName = item.folder_name || item.name || getItemPath(item)
  if (!folderName) return { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' }

  try {
    const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/${mediaType}?folder_name=${encodeURIComponent(folderName)}`, { headers })
    const meta = await metaResponse.json().catch(() => ({}))
    if (!metaResponse.ok || !meta.id) return { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' }

    const [creditsResponse, recommendationsResponse, videosResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/credits`, { headers }),
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/recommendations`, { headers }),
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/videos`, { headers }),
    ])
    const [credits, recommendations, videos] = await Promise.all([
      creditsResponse.json().catch(() => ({})),
      recommendationsResponse.json().catch(() => ({})),
      videosResponse.json().catch(() => ({})),
    ])
    const trailers = videosResponse.ok && Array.isArray(videos.results)
      ? videos.results.filter((video) => video.site === 'YouTube' && video.type === 'Trailer')
      : []
    const trailer = trailers.find((video) => video.official) || trailers[0]

    const crewJobs = new Set(['Director', 'Producer', 'Writer', 'Screenplay'])
    const crew = Array.isArray(credits.crew)
      ? credits.crew
        .filter((person) => crewJobs.has(person.job))
        .filter((person, index, people) => people.findIndex((candidate) => (
          candidate.id === person.id && candidate.job === person.job
        )) === index)
        .slice(0, 8)
      : []

    return {
      cast: Array.isArray(credits.cast) ? credits.cast.slice(0, 5) : [],
      crew,
      meta,
      recommendations: recommendationsResponse.ok && Array.isArray(recommendations.results)
        ? recommendations.results.slice(0, 16)
        : [],
      trailerId: trailer?.key || '',
    }
  } catch {
    return { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' }
  }
}

function hashString(value) {
  return [...String(value)].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0)
}

function getRotationKey(profileId) {
  const sixHours = 6 * 60 * 60 * 1000
  return `${profileId}-${Math.floor(Date.now() / sixHours)}`
}

function rotateItems(items, seed) {
  if (items.length < 2) return items
  const shuffledItems = [...items]
  let state = Math.abs(hashString(seed)) || 1

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swapIndex = state % (index + 1)
    ;[shuffledItems[index], shuffledItems[swapIndex]] = [shuffledItems[swapIndex], shuffledItems[index]]
  }

  return shuffledItems
}

function preloadImage(url) {
  if (!url) return Promise.resolve()

  return new Promise((resolve) => {
    const image = new Image()
    const timeout = window.setTimeout(resolve, 8000)
    const finish = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    image.onload = finish
    image.onerror = finish
    image.src = url
  })
}

function LoadableImage({ alt = '', className = '', fallbackSrc = '', loading = 'lazy', shimmerOnError = true, src }) {
  const [isLoaded, setIsLoaded] = useState(false)
  const [hasError, setHasError] = useState(false)
  const resolvedSrc = hasError ? fallbackSrc : src

  if (!resolvedSrc) return shimmerOnError ? <span className="image-shimmer" aria-hidden="true" /> : null

  return (
    <>
      {!isLoaded && <span className="image-shimmer" aria-hidden="true" />}
      <img
        alt={alt}
        className={`${className} ${isLoaded ? 'image-loaded' : 'image-loading'}`.trim()}
        loading={loading}
        onError={() => {
          if (fallbackSrc && resolvedSrc !== fallbackSrc) setHasError(true)
        }}
        onLoad={() => setIsLoaded(true)}
        src={resolvedSrc}
      />
    </>
  )
}

function DashboardSkeleton() {
  return (
    <main className="dashboard-page dashboard-skeleton-page" aria-label="Loading catalog">
      <section className="dashboard-skeleton-hero">
        <span className="image-shimmer" />
      </section>
      <section className="dashboard-skeleton-shell">
        {Array.from({ length: 4 }, (_, rowIndex) => (
          <section className="dashboard-skeleton-row" key={rowIndex}>
            <span className="skeleton-block dashboard-skeleton-title" />
            <div>
              {Array.from({ length: 7 }, (_, cardIndex) => (
                <span className="skeleton-block dashboard-skeleton-poster" key={cardIndex} />
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  )
}

function readDashboardCache(profileId) {
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

function writeDashboardCache(profileId, { history, movies, series }) {
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

function readProfilesCache() {
  try {
    const profiles = JSON.parse(localStorage.getItem(PROFILES_CACHE_KEY) || '[]')
    return Array.isArray(profiles) ? profiles.slice(0, 12) : []
  } catch {
    localStorage.removeItem(PROFILES_CACHE_KEY)
    return []
  }
}

function writeProfilesCache(profiles) {
  try {
    localStorage.setItem(PROFILES_CACHE_KEY, JSON.stringify(profiles.slice(0, 12)))
  } catch {
    localStorage.removeItem(PROFILES_CACHE_KEY)
  }
}

function mergeCatalogWithMetadata(items, metadataMap, mediaType) {
  return items.map((item) => {
    const folderName = item.folder_name || item.name
    const metadata = metadataMap.get(`${mediaType}:${folderName}`)
    if (!metadata) return item

    return {
      ...item,
      tmdb_title: item.tmdb_title || metadata.title || metadata.name,
      tmdb_poster_path: item.tmdb_poster_path || metadata.poster_path,
      tmdb_backdrop_path: item.tmdb_backdrop_path || metadata.backdrop_path,
      tmdb_overview: item.tmdb_overview || metadata.overview,
      tmdb_rating: item.tmdb_rating || metadata.vote_average,
      tmdb_genres: item.tmdb_genres || metadata.genres || [],
      media_type: mediaType,
    }
  })
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const isDetailRoute = location.pathname.startsWith('/detail/')
  const [mode, setMode] = useState('login')
  const [authToken, setAuthToken] = useState(() => (
    localStorage.getItem('mutflix_token') || sessionStorage.getItem('mutflix_token') || ''
  ))
  const [currentUser, setCurrentUser] = useState(() => {
    const savedUser = localStorage.getItem('mutflix_user') || sessionStorage.getItem('mutflix_user')
    if (!savedUser) return null

    try {
      return JSON.parse(savedUser)
    } catch {
      return null
    }
  })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [selectedProfile, setSelectedProfile] = useState(() => {
    const savedProfile = localStorage.getItem('mutflix_profile') || sessionStorage.getItem('mutflix_profile')
    if (!savedProfile) return null

    try {
      return JSON.parse(savedProfile)
    } catch {
      return null
    }
  })
  const [isProfileLoading, setIsProfileLoading] = useState(false)
  const [isAddingProfile, setIsAddingProfile] = useState(false)
  const [profileMessage, setProfileMessage] = useState(null)
  const [showAddProfile, setShowAddProfile] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeNav, setActiveNav] = useState('home')
  const [detailData, setDetailData] = useState({
    item: null,
    videos: [],
    credits: { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' },
    isLoading: false,
    error: null,
  })
  const [newProfileName, setNewProfileName] = useState('')
  const [profileData, setProfileData] = useState({
    watchHistory: [],
    isLoading: false,
    error: null,
  })
  const [catalogData, setCatalogData] = useState({
    movies: [],
    series: [],
    isLoading: true,
    error: null,
  })
  const curatedRowsCache = useRef(null)

  const isRegister = mode === 'register'
  const canSubmit = username.trim().length > 0
    && password.length > 0
    && (!isRegister || accessToken.trim().length > 0)
    && !isLoading

  useEffect(() => {
    if (location.pathname === '/') {
      navigate('/dashboard', { replace: true })
    }
  }, [location.pathname, navigate])

  function switchMode(nextMode) {
    setMode(nextMode)
    setMessage(null)
    setShowPassword(false)
  }

  useEffect(() => {
    if (!currentUser || !authToken || selectedProfile) return

    let ignore = false

    async function loadProfiles() {
      setIsProfileLoading(true)
      setProfileMessage(null)

      try {
        const response = await fetch(`${API_BASE_URL}/api/profiles`, {
          headers: { 'x-access-token': authToken },
        })
        const data = await response.json().catch(() => [])

        if (!response.ok) {
          throw new Error(data.message || data.error || 'Failed to load profiles.')
        }

        if (!ignore) {
          const nextProfiles = Array.isArray(data) ? data : []
          setProfiles(nextProfiles)
          writeProfilesCache(nextProfiles)
        }
      } catch (error) {
        if (!ignore) {
          const cachedProfiles = readProfilesCache()
          if (cachedProfiles.length) {
            setProfiles(cachedProfiles)
          } else {
            setProfileMessage(error.message)
          }
        }
      } finally {
        if (!ignore) {
          setIsProfileLoading(false)
        }
      }
    }

    loadProfiles()

    return () => {
      ignore = true
    }
  }, [authToken, currentUser, selectedProfile])

  useEffect(() => {
    if (!currentUser || !authToken || !selectedProfile) return

    let ignore = false

    async function loadDashboardData() {
      const cachedDashboard = readDashboardCache(selectedProfile.id)

      setProfileData((currentData) => ({
        ...currentData,
        isLoading: true,
        error: null,
      }))
      setCatalogData((currentData) => ({
        ...currentData,
        isLoading: true,
        error: null,
      }))

      if (cachedDashboard) {
        const rotationKey = getRotationKey(selectedProfile.id)
        const heroCandidates = [...cachedDashboard.movies, ...cachedDashboard.series]
          .filter((item) => getBackdropUrl(item))
        const heroItem = rotateItems(heroCandidates, `${rotationKey}-hero`)[0]
        await preloadImage(heroItem ? getBackdropUrl(heroItem) : '')

        if (!ignore) {
          setProfileData({
            watchHistory: cachedDashboard.history || [],
            isLoading: false,
            error: null,
          })
          setCatalogData({
            movies: cachedDashboard.movies,
            series: cachedDashboard.series,
            isLoading: false,
            error: null,
          })
        }
      }

      try {
        const headers = { 'x-access-token': authToken }
        const [historyResponse, catalogResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/api/history/get/${encodeURIComponent(selectedProfile.id)}?active_only=true&limit=20`, { headers }),
          fetch(`${API_BASE_URL}/api/folders`, { headers }),
        ])
        const historyData = await historyResponse.json().catch(() => [])
        const catalog = await catalogResponse.json().catch(() => ({}))

        if (!historyResponse.ok) {
          throw new Error(historyData.message || historyData.error || 'Failed to load profile data.')
        }

        if (!catalogResponse.ok) {
          throw new Error(catalog.message || catalog.error || 'Failed to load catalog.')
        }

        let movies = Array.isArray(catalog.movies)
          ? catalog.movies.map((item) => ({ ...item, media_type: 'movie', type: 'movie' }))
          : []
        let series = Array.isArray(catalog.series)
          ? catalog.series.map((item) => ({ ...item, media_type: 'tv', type: 'series' }))
          : []

        const itemsNeedingMetadata = [
          ...movies
            .filter((item) => !getPosterUrl(item) || !getBackdropUrl(item) || !getGenres(item).length)
            .slice(0, 60)
            .map((item) => ({ media_type: 'movie', folder_name: item.folder_name || item.name })),
          ...series
            .filter((item) => !getPosterUrl(item) || !getBackdropUrl(item) || !getGenres(item).length)
            .slice(0, 60)
            .map((item) => ({ media_type: 'tv', folder_name: item.folder_name || item.name })),
        ].filter((item) => item.folder_name)

        try {
          if (itemsNeedingMetadata.length) {
            const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/bulk`, {
              method: 'POST',
              headers: {
                ...headers,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ items: itemsNeedingMetadata }),
            })
            const metaData = await metaResponse.json().catch(() => ({}))

            if (metaResponse.ok && Array.isArray(metaData.results)) {
              const metadataMap = new Map()
              metaData.results.forEach((result) => {
                if (result.status !== 200 || !result.payload) return
                metadataMap.set(`${result.media_type}:${result.folder_name}`, result.payload)
              })

              movies = mergeCatalogWithMetadata(movies, metadataMap, 'movie')
              series = mergeCatalogWithMetadata(series, metadataMap, 'tv')
            }
          }
        } catch {
          // Keep the base catalog visible when optional TMDB enrichment is unavailable.
        }

        const rotationKey = getRotationKey(selectedProfile.id)
        const heroCandidates = [...movies, ...series].filter((item) => getBackdropUrl(item))
        const heroItem = rotateItems(heroCandidates, `${rotationKey}-hero`)[0]
        await preloadImage(heroItem ? getBackdropUrl(heroItem) : '')
        writeDashboardCache(selectedProfile.id, {
          history: historyData,
          movies,
          series,
        })

        if (!ignore) {
          setProfileData({
            watchHistory: Array.isArray(historyData) ? historyData : [],
            isLoading: false,
            error: null,
          })
          setCatalogData({
            movies,
            series,
            isLoading: false,
            error: null,
          })
        }
      } catch (error) {
        if (!ignore && !cachedDashboard) {
          setProfileData({
            watchHistory: [],
            isLoading: false,
            error: error.message,
          })
          setCatalogData({
            movies: [],
            series: [],
            isLoading: false,
            error: error.message,
          })
        }
      }
    }

    loadDashboardData()

    return () => {
      ignore = true
    }
  }, [authToken, currentUser, selectedProfile])

  function handleProfileSelect(profile) {
    const storage = localStorage.getItem('mutflix_token') ? localStorage : sessionStorage
    storage.setItem('mutflix_profile', JSON.stringify(profile))
    setSelectedProfile(profile)
  }

  function handleChangeProfile() {
    localStorage.removeItem('mutflix_profile')
    sessionStorage.removeItem('mutflix_profile')
    setShowProfileMenu(false)
    setSelectedProfile(null)
  }

  function handleLogout() {
    localStorage.removeItem('mutflix_token')
    localStorage.removeItem('mutflix_user')
    localStorage.removeItem('mutflix_profile')
    localStorage.removeItem(DASHBOARD_CACHE_KEY)
    localStorage.removeItem(PROFILES_CACHE_KEY)
    sessionStorage.removeItem('mutflix_token')
    sessionStorage.removeItem('mutflix_user')
    sessionStorage.removeItem('mutflix_profile')
    setShowProfileMenu(false)
    setAuthToken('')
    setCurrentUser(null)
    setSelectedProfile(null)
    setProfiles([])
  }

  const loadDetail = useCallback(async (item) => {
    const detailItem = { ...item, media_type: getMediaType(item) }
    const itemPath = getItemPath(detailItem)
    setDetailData({
      item: detailItem,
      videos: [],
      credits: { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' },
      isLoading: true,
      error: null,
    })

    if (!itemPath || !navigator.onLine) {
      setDetailData((currentData) => ({ ...currentData, isLoading: false }))
      return
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/videos/${encodeURIComponent(itemPath)}`, {
        headers: { 'x-access-token': authToken },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.message || data.error || 'Failed to load title details.')

      const headers = { 'x-access-token': authToken }
      const [videos, credits] = await Promise.all([
        enrichEpisodesFromServer(detailItem, Array.isArray(data.videos) ? data.videos : [], headers),
        getCreditsFromServer(detailItem, headers),
      ])

      setDetailData((currentData) => ({
        item: {
          ...currentData.item,
          ...(data.catalog_item || {}),
          media_type: currentData.item.media_type,
        },
        videos,
        credits,
        isLoading: false,
        error: null,
      }))
    } catch (error) {
      setDetailData((currentData) => ({
        ...currentData,
        isLoading: false,
        error: error.message,
      }))
    }
  }, [authToken])

  function handleOpenDetail(item) {
    const itemPath = getItemPath(item)
    if (!itemPath) return
    navigate(getDetailUrl(item), { state: { item } })
    loadDetail(item)
  }

  useEffect(() => {
    if (!currentUser || !selectedProfile || !isDetailRoute) return

    const routeTitle = decodeURIComponent(location.pathname.slice('/detail/'.length))
    const routeItem = location.state?.item || [...catalogData.movies, ...catalogData.series]
      .find((item) => getTitle(item).toLowerCase() === routeTitle.toLowerCase())
    const itemPath = getItemPath(routeItem || {}) || routeTitle
    if (!itemPath || getItemPath(detailData.item || {}) === itemPath) return

    loadDetail(routeItem || {
      folder_name: itemPath,
      name: routeTitle,
      media_type: 'tv',
    })
  }, [catalogData.movies, catalogData.series, currentUser, detailData.item, isDetailRoute, loadDetail, location.pathname, location.state, selectedProfile])

  async function handleAddProfile(event) {
    event.preventDefault()
    const profileName = newProfileName.trim()
    if (!profileName || isAddingProfile) return

    setIsAddingProfile(true)
    setProfileMessage(null)

    const nextProfile = {
      id: createProfileId(),
      name: profileName,
      avatar_seed: `${profileName}-${Date.now()}`,
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/profiles/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': authToken,
        },
        body: JSON.stringify(nextProfile),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Failed to add profile.')
      }

      setProfiles((currentProfiles) => {
        const nextProfiles = [...currentProfiles, nextProfile]
        writeProfilesCache(nextProfiles)
        return nextProfiles
      })
      setNewProfileName('')
      setShowAddProfile(false)
    } catch (error) {
      setProfileMessage(error.message)
    } finally {
      setIsAddingProfile(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!canSubmit) return

    setIsLoading(true)
    setMessage(null)

    try {
      const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login'
      const payload = isRegister
        ? {
            username: username.trim(),
            password,
            token: accessToken.trim(),
          }
        : {
            username: username.trim(),
            password,
            remember_me: rememberMe,
          }

      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(data.detail || data.message || `${isRegister ? 'Registration' : 'Login'} failed.`)
      }

      if (isRegister) {
        setMessage({
          type: 'success',
          text: 'Account created. You can sign in now.',
        })
        setMode('login')
        setAccessToken('')
        setPassword('')
      } else {
        const storage = rememberMe ? localStorage : sessionStorage
        const user = {
          username: data.username,
          role: data.role,
          expires_at: data.expires_at,
        }

        storage.setItem('mutflix_token', data.token)
        storage.setItem('mutflix_user', JSON.stringify(user))

        setAuthToken(data.token)
        setSelectedProfile(null)
        setProfiles([])
        setCurrentUser(user)
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message,
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (currentUser && !selectedProfile) {
    return (
      <main className="profile-page">
        <a className="brand-mark profile-brand" href="/" aria-label="Mutflix home">
          MUTFLIX
        </a>

        <section className="profile-selector" aria-label="Choose profile">
          <h1>Who's watching?</h1>

          {isProfileLoading && (
            <div className="profile-status">
              <Loader2 className="spinner" size={26} />
              <span>Loading profiles...</span>
            </div>
          )}

          {profileMessage && (
            <div className="notice error profile-notice" role="alert">
              <AlertCircle size={18} />
              <span>{profileMessage}</span>
            </div>
          )}

          {!isProfileLoading && !profileMessage && (
            <div className="profile-grid">
              {profiles.map((profile) => (
                <button className="profile-card" key={profile.id} onClick={() => handleProfileSelect(profile)} type="button">
                  <span className="profile-avatar">
                    {profile.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="profile-name">{profile.name}</span>
                </button>
              ))}

              {profiles.length === 0 && (
                <div className="empty-profile-card">
                  <span>No profiles yet</span>
                </div>
              )}

              <button className="add-profile-card" onClick={() => setShowAddProfile(true)} type="button">
                <span className="add-profile-icon">
                  <Plus size={42} />
                </span>
                <span className="profile-name">Add Profile</span>
              </button>
            </div>
          )}
        </section>

        {showAddProfile && (
          <div className="profile-modal-backdrop" role="presentation">
            <form className="profile-modal" onSubmit={handleAddProfile}>
              <h2>Add Profile</h2>
              <label className="field">
                <span>Profile name</span>
                <div className="input-wrap">
                  <User aria-hidden="true" size={19} />
                  <input
                    autoFocus
                    maxLength={24}
                    onChange={(event) => setNewProfileName(event.target.value)}
                    placeholder="Profile name"
                    type="text"
                    value={newProfileName}
                  />
                </div>
              </label>

              <div className="modal-actions">
                <button className="secondary-button" onClick={() => setShowAddProfile(false)} type="button">
                  Cancel
                </button>
                <button className="submit-button modal-submit" disabled={!newProfileName.trim() || isAddingProfile} type="submit">
                  {isAddingProfile ? <Loader2 className="spinner" size={20} /> : null}
                  <span>{isAddingProfile ? 'Saving...' : 'Save'}</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    )
  }

  if (currentUser && selectedProfile) {
    if (catalogData.isLoading) {
      return <DashboardSkeleton />
    }

    const rotationKey = getRotationKey(selectedProfile.id)
    const catalogItems = [...catalogData.movies, ...catalogData.series]
    const featuredCandidates = catalogItems.filter((item) => getBackdropUrl(item))
    const featuredItem = rotateItems(featuredCandidates, `${rotationKey}-hero`)[0]
      || catalogItems[0]
    const featuredBackdrop = featuredItem
      ? getBackdropUrl(featuredItem)
      : ''
    const normalizedQuery = searchQuery.trim().toLowerCase()
    const searchResults = normalizedQuery
      ? catalogItems.filter((item) => getTitle(item).toLowerCase().includes(normalizedQuery))
      : []
    const genreRows = ['Action', 'Comedy', 'Drama', 'Thriller', 'Romance', 'Crime', 'Adventure', 'Fantasy', 'Science Fiction', 'Animation', 'Documentary']
      .map((genre) => ({
        genre,
        items: rotateItems(
          catalogItems.filter((item) => getGenres(item).includes(genre)),
          `${rotationKey}-${genre}`,
        ),
      }))
      .filter((row) => row.items.length)
    const rotatedGenreRows = rotateItems(genreRows, `${rotationKey}-genre-rows`)
    const mysteryRow = {
      genre: 'Mystery',
      items: rotateItems(
        catalogItems.filter((item) => getGenres(item).includes('Mystery')),
        `${rotationKey}-Mystery`,
      ),
    }
    const topRatedMovies = [...catalogData.movies]
      .filter((item) => getRating(item) > 0)
      .sort((a, b) => getRating(b) - getRating(a))
    const topRatedSeries = [...catalogData.series]
      .filter((item) => getRating(item) > 0)
      .sort((a, b) => getRating(b) - getRating(a))
    const freshPicks = rotateItems(
      catalogItems.filter((item) => getPosterUrl(item)),
      `${rotationKey}-fresh-picks`,
    ).slice(0, 24)
    const hiddenGems = rotateItems(
      catalogItems.filter((item) => {
        const rating = getRating(item)
        return rating > 0 && rating < 7.5
      }),
      `${rotationKey}-hidden-gems`,
    ).slice(0, 24)
    const nextCuratedRows = [
      freshPicks.length ? { genre: 'Fresh Picks', items: freshPicks } : null,
      hiddenGems.length ? { genre: 'Hidden Gems', items: hiddenGems } : null,
    ].filter(Boolean)
    if (curatedRowsCache.current?.key !== rotationKey && nextCuratedRows.length) {
      curatedRowsCache.current = { key: rotationKey, rows: nextCuratedRows }
    }
    const curatedRows = curatedRowsCache.current?.key === rotationKey
      ? curatedRowsCache.current.rows
      : nextCuratedRows
    const catalogRows = [
      topRatedSeries.length ? { genre: 'Top Rated TV Shows', items: topRatedSeries, ranked: true } : null,
      ...rotatedGenreRows,
      topRatedMovies.length ? { genre: 'Top Rated Movies', items: topRatedMovies, ranked: true } : null,
      mysteryRow.items.length ? mysteryRow : null,
    ].filter(Boolean)

    if (isDetailRoute && detailData.item) {
      return (
        <DetailPage
          detailData={detailData}
          onBack={() => {
            setDetailData({ item: null, videos: [], credits: { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' }, isLoading: false, error: null })
            navigate('/dashboard')
          }}
        />
      )
    }

    return (
      <main className="dashboard-page">
        <nav className="dashboard-topbar" aria-label="Dashboard">
          <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="Mutflix dashboard">
            MUTFLIX
          </a>
          <div className="dashboard-nav">
            <button className={activeNav === 'home' ? 'active' : ''} onClick={() => setActiveNav('home')} type="button">Home</button>
            <button className={activeNav === 'movies' ? 'active' : ''} onClick={() => setActiveNav('movies')} type="button">Movies</button>
            <button className={activeNav === 'series' ? 'active' : ''} onClick={() => setActiveNav('series')} type="button">Series</button>
            <button className={activeNav === 'variety' ? 'active' : ''} onClick={() => setActiveNav('variety')} type="button">Variety Show</button>
          </div>
          <div className="dashboard-actions">
            <label className="dashboard-search" aria-label="Search catalog">
              <Search size={20} />
              <input
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search"
                type="search"
                value={searchQuery}
              />
            </label>
            <div className="profile-menu">
              <button
                aria-expanded={showProfileMenu}
                className="profile-menu-trigger"
                onClick={() => setShowProfileMenu((isOpen) => !isOpen)}
                type="button"
              >
                <span className="profile-menu-avatar" aria-hidden="true">
                  <img alt="" src={getProfileAvatarUrl(selectedProfile)} />
                </span>
                <ChevronDown size={16} />
              </button>
              {showProfileMenu && (
                <div className="profile-menu-dropdown">
                  <button onClick={handleChangeProfile} type="button">
                    <UsersRound size={17} />
                    <span>Ganti profil</span>
                  </button>
                  <button onClick={handleLogout} type="button">
                    <LogOut size={17} />
                    <span>Logout</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </nav>

        <section className="dashboard-hero" aria-label="Featured title">
          {featuredBackdrop && <LoadableImage className="dashboard-hero-poster" key={featuredBackdrop} loading="eager" shimmerOnError={false} src={featuredBackdrop} />}
          <div className="dashboard-hero-shade" />
          <div className="dashboard-hero-content">
            <h1>{featuredItem ? getTitle(featuredItem) : 'Mutflix'}</h1>
            <p>
              {featuredItem?.tmdb_overview
                || 'Explore movies and series from your Mutflix catalog.'}
            </p>
            <button className="play-button" onClick={() => featuredItem && handleOpenDetail(featuredItem)} type="button">
              <Play size={22} fill="currentColor" />
              <span>Play</span>
            </button>
          </div>
        </section>

        <section className="dashboard-shell" aria-label="Mutflix catalog">
          {catalogData.error && (
            <div className="notice error dashboard-notice" role="alert">
              <AlertCircle size={18} />
              <span>{catalogData.error}</span>
            </div>
          )}

          {!catalogData.error && (
            <>
              {normalizedQuery && (
                <CatalogRow
                  emptyMessage="No titles found."
                  items={searchResults}
                  onOpenDetail={handleOpenDetail}
                  title={`Search results for "${searchQuery.trim()}"`}
                />
              )}
              <HistoryRow items={profileData.watchHistory} />
              {curatedRows.map((row) => (
                <CatalogRow items={row.items} key={row.genre} onOpenDetail={handleOpenDetail} title={row.genre} />
              ))}
              {catalogRows.map((row) => (
                <CatalogRow items={row.items} key={row.genre} onOpenDetail={handleOpenDetail} ranked={row.ranked} title={row.genre} />
              ))}
            </>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="login-page">
      <section className="brand-panel" aria-label="Mutflix preview">
        <nav className="topbar" aria-label="Mutflix">
          <a className="brand-mark" href="/" aria-label="Mutflix home">
            MUTFLIX
          </a>
          <span className="status-pill">Private streaming</span>
        </nav>

        <div className="hero-copy">
          <p className="eyebrow">Unlimited nights. Curated watchlist.</p>
          <h1>Movies, series, and watch parties on one green screen.</h1>
          <p className="hero-text">
            Sign in to continue your queue, keep progress synced, and open your private profile.
          </p>
        </div>

        <div className="hero-footer" aria-hidden="true" />
      </section>

      <section className="auth-panel" aria-label="Authentication form">
        <div className="login-card">
          <div className="form-heading">
            <p>{isRegister ? 'Create access' : 'Welcome back'}</p>
            <h2>{isRegister ? 'Join Mutflix' : 'Sign in'}</h2>
          </div>

          <div className="mode-switch" aria-label="Choose authentication mode">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')} type="button">
              Login
            </button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')} type="button">
              Register
            </button>
          </div>

          <form onSubmit={handleSubmit} className="login-form">
            <label className="field">
              <span>Username</span>
              <div className="input-wrap">
                <User aria-hidden="true" size={19} />
                <input
                  autoComplete="username"
                  name="username"
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="username"
                  type="text"
                  value={username}
                />
              </div>
            </label>

            <label className="field">
              <span>Password</span>
              <div className="input-wrap">
                <LockKeyhole aria-hidden="true" size={19} />
                <input
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={isRegister ? 'minimum 8 characters' : 'password'}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="icon-button"
                  onClick={() => setShowPassword((current) => !current)}
                  type="button"
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
            </label>

            {isRegister && (
              <label className="field">
                <span>Registration token</span>
                <div className="input-wrap">
                  <KeyRound aria-hidden="true" size={19} />
                  <input
                    autoComplete="one-time-code"
                    name="token"
                    onChange={(event) => setAccessToken(event.target.value)}
                    placeholder="MUTFLIX-..."
                    type="text"
                    value={accessToken}
                  />
                </div>
              </label>
            )}

            {!isRegister && (
              <div className="form-options">
                <label className="remember-option">
                  <input
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Remember me</span>
                </label>
                <button className="link-button" onClick={() => switchMode('register')} type="button">
                  Need access?
                </button>
              </div>
            )}

            {message && (
              <div className={`notice ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
                {message.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                <span>{message.text}</span>
              </div>
            )}

            <button className="submit-button" disabled={!canSubmit} type="submit">
              {isLoading ? <Loader2 className="spinner" size={21} /> : null}
              <span>{isLoading ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}</span>
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}

function DetailPage({ detailData, onBack }) {
  const { credits, error, isLoading, item, videos } = detailData
  const seasons = [...new Set(videos.map((video) => Number(video.season || 1)))].sort((a, b) => a - b)
  const [activeSeason, setActiveSeason] = useState(seasons[0] || 1)
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(EPISODES_PER_PAGE)
  const selectedSeason = seasons.includes(activeSeason) ? activeSeason : seasons[0] || 1
  const isMovie = getMediaType(item) === 'movie'
  const backdrop = getBackdropUrl(item)
  const genres = getGenres(item)
  const firstVideo = videos[0]
  const visibleVideos = videos.filter((video) => Number(video.season || 1) === selectedSeason)
  const renderedVideos = visibleVideos.slice(0, visibleEpisodeCount)
  const hasMoreEpisodes = visibleEpisodeCount < visibleVideos.length
  const canShowLessEpisodes = visibleEpisodeCount > EPISODES_PER_PAGE

  return (
    <main className={`detail-page ${isMovie ? 'movie-detail-page' : ''}`}>
      <button className="detail-back" onClick={onBack} type="button">
        <span aria-hidden="true">←</span>
        <span>Back</span>
      </button>

      <section className={`detail-hero ${isMovie ? 'movie-detail-hero' : ''}`}>
        {backdrop && <LoadableImage className="detail-backdrop" key={backdrop} loading="eager" shimmerOnError={false} src={backdrop} />}
        <div className="detail-shade" />
        <div className="detail-copy">
          <p className="detail-type">{isMovie ? 'Movie' : 'Series'}</p>
          <h1>{getTitle(item)}</h1>
          <div className="detail-meta">
            {getRating(item) > 0 && <span className="detail-rating">TMDB {getRating(item).toFixed(1)}</span>}
            {genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p className="detail-overview">{item.tmdb_overview || item.overview || 'No description is available for this title yet.'}</p>
          <button className="play-button" disabled={!firstVideo || isLoading} type="button">
            <Play fill="currentColor" size={20} />
            <span>{isLoading ? 'Loading...' : firstVideo ? 'Play' : 'Unavailable offline'}</span>
          </button>
        </div>
      </section>

      {isMovie && <MovieRecommendations credits={credits} />}

      <section className="detail-body">
        {error && <p className="detail-error">{error}</p>}
        {!isMovie && (
          <>
            <div className="episode-heading">
              <h2>Episodes</h2>
              <span>{visibleVideos.length ? `${visibleVideos.length} episodes` : 'Series'}</span>
            </div>
            {seasons.length > 1 && (
              <div className="season-nav" aria-label="Choose season">
                {seasons.map((season) => (
                  <button
                    className={selectedSeason === season ? 'active' : ''}
                    key={season}
                    onClick={() => {
                      setActiveSeason(season)
                      setVisibleEpisodeCount(EPISODES_PER_PAGE)
                    }}
                    type="button"
                  >
                    Season {season}
                  </button>
                ))}
              </div>
            )}
            {isLoading && (
              <div className="episode-list episode-skeleton-list" aria-label="Loading episodes">
                {Array.from({ length: 4 }, (_, index) => (
                  <article className="episode-card episode-skeleton-card" key={index}>
                    <span className="skeleton-block skeleton-number" />
                    <span className="skeleton-block skeleton-thumbnail" />
                    <span className="skeleton-copy">
                      <span className="skeleton-block skeleton-title" />
                      <span className="skeleton-block skeleton-meta" />
                      <span className="skeleton-block skeleton-line" />
                    </span>
                  </article>
                ))}
              </div>
            )}
            {!isLoading && !videos.length && <p className="detail-muted">Episodes are unavailable offline.</p>}
            <div className="detail-content-grid">
              <div className="episode-list">
                {renderedVideos.map((video, index) => {
                const episodeNumber = video.episode || index + 1
                const thumbnail = getStillUrl(video)
                const duration = formatDuration(video)

                return (
                  <article className="episode-card" key={`${video.path || video.name}-${index}`}>
                    <span className="episode-number">{episodeNumber}</span>
                    <div className="episode-thumbnail">
                      <LoadableImage key={thumbnail} src={thumbnail} />
                      <button aria-label={`Play ${video.name || `episode ${episodeNumber}`}`} type="button">
                        <Play fill="currentColor" size={20} />
                      </button>
                    </div>
                    <div className="episode-copy">
                      <div className="episode-title-row">
                        <h3>{video.name}</h3>
                        {duration && <span>{duration}</span>}
                      </div>
                      <p className="episode-meta">Season {video.season || 1} · Episode {episodeNumber}</p>
                      {video.overview && <p className="episode-description">{video.overview}</p>}
                    </div>
                  </article>
                )
                })}
                {(hasMoreEpisodes || canShowLessEpisodes) && (
                  <div className="episode-pagination">
                    {canShowLessEpisodes && (
                      <button onClick={() => setVisibleEpisodeCount((count) => Math.max(EPISODES_PER_PAGE, count - EPISODES_PER_PAGE))} type="button">
                        <ChevronUp size={18} />
                        <span>View less</span>
                      </button>
                    )}
                    {hasMoreEpisodes && (
                      <button onClick={() => setVisibleEpisodeCount((count) => count + EPISODES_PER_PAGE)} type="button">
                        <span>View more</span>
                        <ChevronDown size={18} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <CreditsPanel credits={credits} />
            </div>
          </>
        )}
      </section>
    </main>
  )
}

function MovieRecommendations({ credits }) {
  const cast = credits?.cast || []
  const crew = credits?.crew || []
  const recommendations = credits?.recommendations || []
  if (!cast.length && !crew.length && !recommendations.length) return null

  return (
    <section className="movie-recommendations" aria-label="Cast, crew, and recommendations">
      <div className="movie-credits-grid">
        <div className="movie-credits-stack">
          {cast.length > 0 && (
            <section>
              <h2>Cast</h2>
              <div className="movie-credit-list">
                {cast.slice(0, 5).map((person) => (
                  <article key={`${person.id}-${person.character}`}>
                    <div className="movie-credit-avatar">
                      <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} key={person.profile_path} src={getStillUrl(person)} />
                    </div>
                    <div>
                      <h3>{person.name}</h3>
                      {person.character && <p>{person.character}</p>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {crew.length > 0 && (
            <section>
              <h2>Crew</h2>
              <div className="movie-credit-list">
                {crew.slice(0, 6).map((person, index) => (
                  <article key={`${person.id}-${person.job}-${index}`}>
                    <div className="movie-credit-avatar">
                      <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} key={person.profile_path} src={getStillUrl(person)} />
                    </div>
                    <div>
                      <h3>{person.name}</h3>
                      <p>{person.job || person.department}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
        {recommendations.length > 0 && (
          <section className="movie-more-like-this">
            <h2>More Like This</h2>
            <div>
              {recommendations.slice(0, 8).map((recommendation) => (
                <article key={recommendation.id}>
                  <div className="recommendation-poster">
                    <LoadableImage alt={recommendation.name || recommendation.title} key={recommendation.poster_path} src={getPosterUrl(recommendation)} />
                  </div>
                  <h3>{recommendation.name || recommendation.title}</h3>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </section>
  )
}

function CreditsPanel({ credits }) {
  const cast = credits?.cast || []
  const crew = credits?.crew || []
  const meta = credits?.meta
  const recommendations = credits?.recommendations || []
  const trailerId = credits?.trailerId || ''
  const genres = Array.isArray(meta?.genres) ? meta.genres.map((genre) => genre.name).filter(Boolean) : []
  const networks = Array.isArray(meta?.networks) ? meta.networks.map((network) => network.name).filter(Boolean) : []
  const type = meta?.type || (meta?.number_of_seasons ? 'TV Show' : '')
  const status = meta?.status || ''
  const episodeRuntime = Array.isArray(meta?.episode_run_time) ? meta.episode_run_time.filter(Boolean)[0] : null
  if (!cast.length && !crew.length && !meta) return null

  return (
    <aside className="credits-panel">
      {meta && (
        <section className="title-facts">
          <h2>Details</h2>
          <dl>
            {status && (
              <div>
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
            )}
            {type && (
              <div>
                <dt>Type</dt>
                <dd>{type}</dd>
              </div>
            )}
            {genres.length > 0 && (
              <div>
                <dt>Genres</dt>
                <dd>{genres.join(', ')}</dd>
              </div>
            )}
            {networks.length > 0 && (
              <div>
                <dt>Network</dt>
                <dd>{networks.join(', ')}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {meta && (
        <section className="season-facts">
          <h2>Season Info</h2>
          <div>
            {meta.number_of_seasons > 0 && <span><strong>{meta.number_of_seasons}</strong> seasons</span>}
            {meta.number_of_episodes > 0 && <span><strong>{meta.number_of_episodes}</strong> episodes</span>}
            {episodeRuntime > 0 && <span><strong>{episodeRuntime}</strong> min</span>}
            {meta.first_air_date && <span><strong>{meta.first_air_date.slice(0, 4)}</strong> first aired</span>}
          </div>
          {trailerId && (
            <div className="trailer-embed">
              <iframe
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                src={`https://www.youtube.com/embed/${encodeURIComponent(trailerId)}?autoplay=1&mute=1&controls=1&playsinline=1&rel=0`}
                title="Trailer"
              />
            </div>
          )}
        </section>
      )}
      {cast.length > 0 && (
        <section>
          <h2>Cast</h2>
          <div className="cast-list">
            {cast.map((person) => (
              <article className="cast-card" key={`${person.id}-${person.character}`}>
                <div className="cast-avatar">
                  <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} key={person.profile_path} src={getStillUrl(person)} />
                </div>
                <div>
                  <h3>{person.name}</h3>
                  {person.character && <p>{person.character}</p>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {crew.length > 0 && (
        <section>
          <h2>Crew</h2>
          <div className="crew-list">
            {crew.map((person, index) => (
              <article key={`${person.id}-${person.job}-${index}`}>
                <h3>{person.name}</h3>
                <p>{person.job || person.department}</p>
              </article>
            ))}
          </div>
        </section>
      )}
      {recommendations.length > 0 && (
        <section className="recommendations">
          <h2>More Like This</h2>
          <div>
            {recommendations.map((recommendation) => (
              <article key={recommendation.id}>
                <div className="recommendation-poster">
                  <LoadableImage alt={recommendation.name || recommendation.title} key={recommendation.poster_path} src={getPosterUrl(recommendation)} />
                </div>
                <h3>{recommendation.name || recommendation.title}</h3>
              </article>
            ))}
          </div>
        </section>
      )}
    </aside>
  )
}

function CatalogRow({ emptyMessage, items, onOpenDetail, ranked = false, title }) {
  const [showAll, setShowAll] = useState(false)

  if (!items.length) return emptyMessage ? <p className="empty-catalog">{emptyMessage}</p> : null

  return (
    <section className="catalog-row" aria-label={title}>
      <div className="catalog-row-heading">
        <h2>{title}</h2>
        <button onClick={() => setShowAll((isOpen) => !isOpen)} type="button">
          {showAll ? 'Show less' : 'See more'}
        </button>
      </div>
      <div className={`catalog-scroller ${ranked ? 'ranked-scroller' : ''}`}>
        {(showAll ? items : items.slice(0, 15)).map((item, index) => (
          <button className={`catalog-card ${ranked ? 'ranked-card' : ''}`} key={`${getItemKey(item)}-${index}`} onClick={() => onOpenDetail(item)} type="button">
            {ranked && <span className="ranked-number">{index + 1}</span>}
            <div className={ranked ? 'ranked-frame' : 'poster-frame'}>
              {getRating(item) > 0 && <span className="rating-badge">{getRating(item).toFixed(1)}</span>}
              <LoadableImage alt={getTitle(item)} key={getPosterUrl(item)} loading="eager" src={getPosterUrl(item)} />
            </div>
            <h3>{getTitle(item)}</h3>
          </button>
        ))}
      </div>
    </section>
  )
}

function HistoryRow({ items }) {
  const [showAll, setShowAll] = useState(false)

  if (!items.length) return null

  return (
    <section className="catalog-row" aria-label="Continue watching">
      <div className="catalog-row-heading">
        <h2>Continue Watching</h2>
        <button onClick={() => setShowAll((isOpen) => !isOpen)} type="button">
          {showAll ? 'Show less' : 'See more'}
        </button>
      </div>
      <div className="catalog-scroller history-scroller">
        {(showAll ? items : items.slice(0, 15)).map((item) => (
          <article className="catalog-card history-card" key={item.media_path}>
            <div className="history-frame">
              <LoadableImage alt={item.media_title || item.series_title || 'Continue watching'} key={getStillUrl(item)} src={getStillUrl(item)} />
              <span className="history-progress-label">{Math.round(getWatchProgress(item))}%</span>
              <span className="history-progress-track">
                <span style={{ width: `${getWatchProgress(item)}%` }} />
              </span>
            </div>
            <h3>{item.media_title || item.series_title || 'Continue Watching'}</h3>
          </article>
        ))}
      </div>
    </section>
  )
}

export default App
