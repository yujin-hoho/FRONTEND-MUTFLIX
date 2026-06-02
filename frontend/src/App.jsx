import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import { DASHBOARD_CACHE_KEY, PROFILES_CACHE_KEY } from './config'
import DashboardSkeleton from './components/DashboardSkeleton'
import AuthPage from './pages/AuthPage'
import DashboardPage from './pages/DashboardPage'
import DetailPage from './pages/DetailPage'
import MyListPage from './pages/MyListPage'
import ProfilePage from './pages/ProfilePage'
import SearchResultsPage from './pages/SearchResultsPage'
import WatchPage from './pages/watchpage'
import {
  addProfile,
  authenticate,
  createEmptyCredits,
  enrichCatalogMetadata,
  fetchCatalogSearch,
  fetchDashboardData,
  fetchDetailData,
  fetchProfiles,
  mergeCatalogMetadataUpdates,
  saveWatchProgress,
} from './services/api'
import {
  readDashboardCache,
  readProfilesCache,
  writeDashboardCache,
  writeProfilesCache,
} from './utils/cache'
import {
  createProfileId,
  getBackdropUrl,
  getCatalogIdentityKey,
  getDetailArtworkUrl,
  getDetailUrl,
  getItemKey,
  getItemPath,
  getMediaType,
  getPosterUrl,
  getRotationKey,
  getStillUrl,
  getTitle,
  getWatchUrl,
  normalizeMediaPath,
  normalizeWatchHistory,
  preloadImages,
  rotateItems,
} from './utils/media'

const EMPTY_DETAIL_DATA = {
  item: null,
  videos: [],
  credits: createEmptyCredits(),
  isLoading: false,
  error: null,
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const isDetailRoute = location.pathname.startsWith('/detail/')
  const isMyListRoute = location.pathname === '/my-list'
  const isSearchRoute = location.pathname === '/search'
  const isWatchRoute = location.pathname.startsWith('/watch/')
  const [mode, setMode] = useState('login')
  const [authToken, setAuthToken] = useState(() => (
    localStorage.getItem('mutflix_token') || sessionStorage.getItem('mutflix_token') || ''
  ))
  const [currentUser, setCurrentUser] = useState(() => readStoredJson('mutflix_user'))
  const [selectedProfile, setSelectedProfile] = useState(() => readStoredJson('mutflix_profile'))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [isProfileLoading, setIsProfileLoading] = useState(false)
  const [isAddingProfile, setIsAddingProfile] = useState(false)
  const [profileMessage, setProfileMessage] = useState(null)
  const [showAddProfile, setShowAddProfile] = useState(false)
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
  const [detailData, setDetailData] = useState(EMPTY_DETAIL_DATA)
  const featuredItemKeys = useRef(new Map())
  const pendingMetadataKeys = useRef(new Set())
  const catalogDataRef = useRef(catalogData)

  const isRegister = mode === 'register'
  const canSubmit = username.trim().length > 0
    && password.length > 0
    && (!isRegister || accessToken.trim().length > 0)
    && !isLoading

  catalogDataRef.current = catalogData

  useEffect(() => {
    if (location.pathname === '/') {
      navigate('/dashboard', { replace: true })
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    if (!currentUser || !authToken || selectedProfile) return

    let ignore = false

    async function loadProfiles() {
      setIsProfileLoading(true)
      setProfileMessage(null)

      try {
        const nextProfiles = await fetchProfiles(authToken)
        if (!ignore) {
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
        if (!ignore) setIsProfileLoading(false)
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

    async function loadDashboard() {
      const cachedDashboard = readDashboardCache(selectedProfile.id)
      const dashboardRequest = fetchDashboardData(authToken, selectedProfile.id)
        .then((dashboard) => ({ dashboard }))
        .catch((error) => ({ error }))

      setProfileData((currentData) => ({ ...currentData, isLoading: true, error: null }))
      setCatalogData((currentData) => ({ ...currentData, isLoading: true, error: null }))

      if (cachedDashboard) {
        await preloadDashboardAssets(featuredItemKeys.current, selectedProfile.id, cachedDashboard)
        if (!ignore) {
          setProfileData({ watchHistory: cachedDashboard.history || [], isLoading: false, error: null })
          setCatalogData({ movies: cachedDashboard.movies, series: cachedDashboard.series, isLoading: false, error: null })
        }
      }

      try {
        const { dashboard, error } = await dashboardRequest
        if (error) throw error

        const refreshedDashboard = cachedDashboard
          ? mergeCatalogMetadataUpdates(dashboard, cachedDashboard)
          : dashboard
        const enrichedDashboard = await enrichCatalogMetadata(authToken, refreshedDashboard)
        writeDashboardCache(selectedProfile.id, enrichedDashboard)
        await preloadDashboardAssets(featuredItemKeys.current, selectedProfile.id, enrichedDashboard)

        if (!ignore) {
          setProfileData({ watchHistory: enrichedDashboard.history, isLoading: false, error: null })
          setCatalogData({ movies: enrichedDashboard.movies, series: enrichedDashboard.series, isLoading: false, error: null })
        }
      } catch (error) {
        if (!ignore && !cachedDashboard) {
          setProfileData({ watchHistory: [], isLoading: false, error: error.message })
          setCatalogData({ movies: [], series: [], isLoading: false, error: error.message })
        }
      }
    }

    loadDashboard()

    return () => {
      ignore = true
    }
  }, [authToken, currentUser, selectedProfile])

  const loadDetail = useCallback(async (item) => {
    const detailItem = { ...item, media_type: getMediaType(item) }
    setDetailData({
      item: detailItem,
      videos: [],
      credits: createEmptyCredits(),
      isLoading: true,
      error: null,
    })

    try {
      const nextDetail = await fetchDetailData(authToken, detailItem)
      setDetailData({ ...nextDetail, isLoading: false, error: null })
    } catch (error) {
      setDetailData((currentData) => ({ ...currentData, isLoading: false, error: error.message }))
    }
  }, [authToken])

  const hydrateCatalogItems = useCallback(async (items) => {
    const pendingItems = items.filter((item) => {
      const itemKey = getCatalogIdentityKey(item)
      return !getPosterUrl(item) && !item.tmdb_metadata_resolved && !pendingMetadataKeys.current.has(itemKey)
    })
    if (!pendingItems.length) return

    pendingItems.forEach((item) => pendingMetadataKeys.current.add(getCatalogIdentityKey(item)))

    try {
      const enrichedItems = await enrichCatalogMetadata(authToken, {
        history: [],
        movies: pendingItems.filter((item) => getMediaType(item) === 'movie'),
        series: pendingItems.filter((item) => getMediaType(item) !== 'movie'),
      })
      setCatalogData((currentData) => {
        const mergedData = mergeCatalogMetadataUpdates(currentData, enrichedItems)
        const nextData = {
          ...mergedData,
          movies: appendMissingCatalogItems(mergedData.movies, enrichedItems.movies),
          series: appendMissingCatalogItems(mergedData.series, enrichedItems.series),
        }
        if (selectedProfile) {
          writeDashboardCache(selectedProfile.id, { history: profileData.watchHistory, movies: nextData.movies, series: nextData.series })
        }
        return nextData
      })
    } finally {
      pendingItems.forEach((item) => pendingMetadataKeys.current.delete(getCatalogIdentityKey(item)))
    }
  }, [authToken, profileData.watchHistory, selectedProfile])

  const handleSaveProgress = useCallback(async (payload) => {
    setProfileData((currentData) => {
      const watchHistory = mergeWatchHistory(currentData.watchHistory, payload)
      const currentCatalog = catalogDataRef.current
      writeDashboardCache(selectedProfile.id, {
        history: watchHistory,
        movies: currentCatalog.movies,
        series: currentCatalog.series,
      })
      return { ...currentData, watchHistory }
    })
    await saveWatchProgress(authToken, payload)
  }, [authToken, selectedProfile])

  const handleSearchCatalog = useCallback((query, options) => (
    fetchCatalogSearch(authToken, query, options)
  ), [authToken])

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

  function switchMode(nextMode) {
    setMode(nextMode)
    setMessage(null)
    setShowPassword(false)
  }

  function handleProfileSelect(profile) {
    const storage = localStorage.getItem('mutflix_token') ? localStorage : sessionStorage
    storage.setItem('mutflix_profile', JSON.stringify(profile))
    setSelectedProfile(profile)
  }

  function handleChangeProfile() {
    localStorage.removeItem('mutflix_profile')
    sessionStorage.removeItem('mutflix_profile')
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
    setAuthToken('')
    setCurrentUser(null)
    setSelectedProfile(null)
    setProfiles([])
    featuredItemKeys.current.clear()
  }

  function handleOpenDetail(item) {
    const itemPath = getItemPath(item)
    if (!itemPath) return
    navigate(getDetailUrl(item), {
      state: {
        from: getCurrentRoute(location),
        fromState: location.state,
        item,
      },
    })
    loadDetail(item)
  }

  function handleDetailBack() {
    setDetailData(EMPTY_DETAIL_DATA)
    navigateBackToStoredRoute(navigate, location.state)
  }

  function handleOpenWatch(item, video, videos = [video]) {
    if (!video?.path) return
    navigate(getWatchUrl(video.path), {
      state: {
        from: getCurrentRoute(location),
        fromState: location.state,
        item,
        video,
        videos,
      },
    })
  }

  async function handleResumeHistory(historyEntry) {
    const historyVideo = historyEntryToVideo(historyEntry)
    const historyItem = historyEntryToItem(historyEntry)
    if (!historyEntry.series_title) {
      handleOpenWatch(historyItem, historyVideo, [historyVideo])
      return
    }

    const catalogItem = findCatalogItemForHistory(historyEntry, catalogData.series) || historyItem
    try {
      const detail = await fetchDetailData(authToken, catalogItem)
      const videos = detail.videos.length ? detail.videos : [historyVideo]
      const video = findHistoryVideo(historyEntry, videos) || historyVideo
      handleOpenWatch(detail.item, video, videos)
    } catch {
      handleOpenWatch(catalogItem, historyVideo, [historyVideo])
    }
  }

  function handleWatchBack() {
    navigateBackToStoredRoute(navigate, location.state)
  }

  function handleOpenSearch(query, { replace = false } = {}) {
    const searchUrl = buildSearchUrl(query, isSearchRoute ? readCatalogFilter(location.search) : null)
    navigate(searchUrl, {
      replace,
      state: replace && isSearchRoute
        ? location.state
        : {
            from: getCurrentRoute(location),
            fromState: location.state,
          },
    })
  }

  function handleOpenCatalogFilter(filter, { replace = false } = {}) {
    const query = isSearchRoute ? new URLSearchParams(location.search).get('q') || '' : ''
    navigate(buildSearchUrl(query, filter), {
      replace,
      state: replace && isSearchRoute
        ? location.state
        : {
            from: getCurrentRoute(location),
            fromState: location.state,
          },
    })
  }

  function handleOpenMyList() {
    navigate('/my-list', {
      state: {
        from: getCurrentRoute(location),
        fromState: location.state,
      },
    })
  }

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
      await addProfile(authToken, nextProfile)
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
      const data = await authenticate({ accessToken, isRegister, password, rememberMe, username })

      if (isRegister) {
        setMessage({ type: 'success', text: 'Account created. You can sign in now.' })
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
      setMessage({ type: 'error', text: error.message })
    } finally {
      setIsLoading(false)
    }
  }

  if (currentUser && !selectedProfile) {
    return (
      <ProfilePage
        isAddingProfile={isAddingProfile}
        isProfileLoading={isProfileLoading}
        newProfileName={newProfileName}
        onAddProfile={handleAddProfile}
        onNewProfileNameChange={setNewProfileName}
        onProfileSelect={handleProfileSelect}
        onShowAddProfileChange={setShowAddProfile}
        profileMessage={profileMessage}
        profiles={profiles}
        showAddProfile={showAddProfile}
      />
    )
  }

  if (currentUser && selectedProfile) {
    if (isWatchRoute) {
      const mediaPath = decodeRouteValue(location.pathname.slice('/watch/'.length))
      const historyEntry = profileData.watchHistory.find((entry) => normalizeMediaPath(entry.media_path) === normalizeMediaPath(mediaPath))
      const video = location.state?.video || historyEntryToVideo(historyEntry || { media_path: mediaPath })
      const item = location.state?.item || historyEntryToItem(historyEntry || {})
      const videos = location.state?.videos?.length ? location.state.videos : [video]

      return (
        <WatchPage
          authToken={authToken}
          item={item}
          key={video.path}
          onBack={handleWatchBack}
          onOpenVideo={(nextVideo) => {
            navigate(getWatchUrl(nextVideo.path), {
              replace: true,
              state: {
                ...location.state,
                item,
                video: nextVideo,
                videos,
              },
            })
          }}
          onSaveProgress={handleSaveProgress}
          profileId={selectedProfile.id}
          resumeEntry={historyEntry}
          video={video}
          videos={videos}
        />
      )
    }
    if (isDetailRoute && detailData.item) {
      return (
        <DetailPage
          detailData={detailData}
          onBack={handleDetailBack}
          onPlayVideo={(video) => handleOpenWatch(detailData.item, video, detailData.videos)}
          watchHistory={profileData.watchHistory}
        />
      )
    }
    if (catalogData.isLoading) return <DashboardSkeleton />
    if (isSearchRoute) {
      const searchFilter = readCatalogFilter(location.search)
      return (
        <SearchResultsPage
          key={location.search || '__empty__'}
          catalogData={catalogData}
          initialFilter={searchFilter}
          initialQuery={new URLSearchParams(location.search).get('q') || ''}
          onChangeProfile={handleChangeProfile}
          onFilterSelect={(filter) => handleOpenCatalogFilter(filter, { replace: true })}
          onHydrateItems={hydrateCatalogItems}
          onLogout={handleLogout}
          onOpenDetail={handleOpenDetail}
          onOpenMyList={handleOpenMyList}
          onQueryChange={(query) => handleOpenSearch(query, { replace: true })}
          onSearchCatalog={handleSearchCatalog}
          selectedProfile={selectedProfile}
        />
      )
    }
    if (isMyListRoute) {
      return (
        <MyListPage
          authToken={authToken}
          catalogData={catalogData}
          onChangeProfile={handleChangeProfile}
          onFilterSelect={handleOpenCatalogFilter}
          onHydrateItems={hydrateCatalogItems}
          onLogout={handleLogout}
          onOpenDetail={handleOpenDetail}
          onOpenSearch={handleOpenSearch}
          onSearchCatalog={handleSearchCatalog}
          profileId={selectedProfile.id}
          selectedProfile={selectedProfile}
        />
      )
    }

    return (
      <DashboardPage
        catalogData={catalogData}
        onChangeProfile={handleChangeProfile}
        onLogout={handleLogout}
        onHydrateItems={hydrateCatalogItems}
        onOpenCatalogFilter={handleOpenCatalogFilter}
        onOpenMyList={handleOpenMyList}
        onOpenDetail={handleOpenDetail}
        onPlayHistory={handleResumeHistory}
        onOpenSearch={handleOpenSearch}
        onSearchCatalog={handleSearchCatalog}
        profileData={profileData}
        selectedProfile={selectedProfile}
        featuredItemKey={getFeaturedItemKey(featuredItemKeys.current, selectedProfile.id, catalogData.movies, catalogData.series)}
      />
    )
  }

  return (
    <AuthPage
      accessToken={accessToken}
      canSubmit={canSubmit}
      isLoading={isLoading}
      isRegister={isRegister}
      message={message}
      mode={mode}
      onAccessTokenChange={setAccessToken}
      onPasswordChange={setPassword}
      onRememberMeChange={setRememberMe}
      onShowPasswordChange={setShowPassword}
      onSubmit={handleSubmit}
      onSwitchMode={switchMode}
      onUsernameChange={setUsername}
      password={password}
      rememberMe={rememberMe}
      showPassword={showPassword}
      username={username}
    />
  )
}

function readStoredJson(key) {
  const value = localStorage.getItem(key) || sessionStorage.getItem(key)
  if (!value) return null

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function preloadDashboardAssets(featuredKeys, profileId, { history = [], movies = [], series = [] }) {
  const catalogItems = [...movies, ...series]
  const itemKey = getFeaturedItemKey(featuredKeys, profileId, movies, series)
  const heroItem = catalogItems.find((item) => getItemKey(item) === itemKey)

  await preloadImages([
    heroItem ? getDetailArtworkUrl(heroItem) : '',
    ...catalogItems.map((item) => getPosterUrl(item)),
    ...history.map((item) => getStillUrl(item)),
  ])
}

function getCurrentRoute(location) {
  return `${location.pathname}${location.search}`
}

function buildSearchUrl(query, filter) {
  const params = new URLSearchParams()
  const normalizedQuery = String(query || '').trim()
  if (normalizedQuery) params.set('q', normalizedQuery)
  if (filter?.type && filter.value) {
    params.set('filter', filter.type)
    params.set('value', filter.value)
    if (filter.label) params.set('label', filter.label)
  }
  const search = params.toString()
  return search ? `/search?${search}` : '/search'
}

function readCatalogFilter(search) {
  const params = new URLSearchParams(search)
  const type = params.get('filter')
  const value = params.get('value')
  if (!['category', 'genre', 'type'].includes(type) || !value) return null
  return {
    label: params.get('label') || value,
    type,
    value,
  }
}

function navigateBackToStoredRoute(navigate, routeState) {
  navigate(routeState?.from || '/dashboard', { state: routeState?.fromState || null })
}

function getFeaturedItemKey(featuredKeys, profileId, movies, series) {
  const rotationKey = getRotationKey(profileId)
  const catalogItems = [...movies, ...series]
  const currentFeatured = featuredKeys.get(profileId)
  if (
    currentFeatured?.rotationKey === rotationKey
    && catalogItems.some((item) => getItemKey(item) === currentFeatured.itemKey)
  ) {
    return currentFeatured.itemKey
  }

  const backdropItems = catalogItems.filter((item) => getBackdropUrl(item))
  const posterItems = catalogItems.filter((item) => getPosterUrl(item))
  const heroItems = backdropItems.length ? backdropItems : posterItems.length ? posterItems : catalogItems
  const heroItem = rotateItems(heroItems, `${rotationKey}-hero`)[0]
  const itemKey = heroItem ? getItemKey(heroItem) : ''
  if (itemKey) featuredKeys.set(profileId, { itemKey, rotationKey })
  return itemKey
}

function decodeRouteValue(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function historyEntryToVideo(entry) {
  return {
    path: entry.media_path || '',
    name: entry.media_title || entry.series_title || 'Video',
    source: entry.source || '',
    still_path: entry.still_path || '',
    subtitle_path: entry.subtitle_path || '',
    season: entry.season || 1,
    episode: entry.episode || 1,
  }
}

function historyEntryToItem(entry) {
  const isSeries = Boolean(entry.series_title)
  return {
    name: entry.series_title || entry.media_title || 'Video',
    folder_name: isSeries ? entry.series_path || '' : '',
    source: entry.source || '',
    media_type: isSeries ? 'tv' : 'movie',
    type: isSeries ? 'series' : 'movie',
  }
}

function findCatalogItemForHistory(historyEntry, series) {
  const historyPath = String(historyEntry.series_path || '').toLowerCase()
  const historyTitle = normalizeHistoryLookupValue(historyEntry.series_title)
  return series.find((item) => (
    historyPath && [getItemPath(item), item.folder_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === historyPath)
    || historyTitle && [getTitle(item), item.name, item.folder_name]
      .filter(Boolean)
      .map(normalizeHistoryLookupValue)
      .some((value) => value === historyTitle || value.startsWith(`${historyTitle} `))
  ))
}

function normalizeHistoryLookupValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findHistoryVideo(historyEntry, videos) {
  return videos.find((video) => normalizeMediaPath(video.path) === normalizeMediaPath(historyEntry.media_path))
    || videos.find((video) => (
      Number(video.season || 1) === Number(historyEntry.season || 1)
      && Number(video.episode || 1) === Number(historyEntry.episode || 1)
    ))
}

function mergeWatchHistory(history, payload) {
  const normalizedPayload = { ...payload, media_path: normalizeMediaPath(payload.media_path) }
  const remainingHistory = normalizeWatchHistory(history)
    .filter((entry) => entry.media_path !== normalizedPayload.media_path)
  const isCompleted = payload.duration_ms > 0 && payload.position_ms >= payload.duration_ms * 0.9
  if (isCompleted) return remainingHistory
  return normalizeWatchHistory([
    {
      ...normalizedPayload,
      is_hidden: 0,
      last_watched: new Date().toISOString(),
    },
    ...remainingHistory,
  ]).slice(0, 20)
}

function appendMissingCatalogItems(items, additions) {
  const itemKeys = new Set(items.map(getCatalogIdentityKey))
  return [
    ...items,
    ...additions.filter((item) => !itemKeys.has(getCatalogIdentityKey(item))),
  ]
}

export default App
