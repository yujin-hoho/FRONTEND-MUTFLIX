import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import { PROFILES_CACHE_KEY } from './config'
import DashboardSkeleton from './components/DashboardSkeleton'
import AdminCatalogEditPage from './pages/AdminCatalogEditPage'
import AuthPage from './pages/AuthPage'
import CatalogAllPage from './pages/CatalogAllPage'
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
  editProfile,
  enrichCatalogMetadata,
  fetchCatalogSearch,
  fetchDashboardData,
  fetchDetailData,
  fetchMyList,
  fetchProfiles,
  fetchVideoQueue,
  hideWatchHistory,
  mergeCatalogMetadataUpdates,
  saveWatchProgress,
  saveMyListItemStatus,
} from './services/api'
import {
  clearDashboardCache,
  mergeDashboardCache,
  readDashboardCache,
  readProfilesCache,
  writeLocalTmdbOverride,
  writeDashboardCache,
  writeProfilesCache,
} from './utils/cache'
import {
  createProfileId,
  getBackdropUrl,
  getCatalogIdentityKey,
  getDetailUrl,
  getEpisodeHistoryLabel,
  getItemKey,
  getItemPath,
  getMediaType,
  getPosterUrl,
  getRotationKey,
  getTitle,
  getWatchUrl,
  normalizeMediaPath,
  normalizeWatchHistory,
  rotateItems,
} from './utils/media'
import { DEFAULT_PROFILE_AVATAR_SEED } from './utils/profileAvatars'

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
  const isAdminEditRoute = location.pathname.startsWith('/admin/catalog/edit/')
  const isCatalogAllRoute = location.pathname === '/catalog'
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
  const [editingProfile, setEditingProfile] = useState(null)
  const [newProfileName, setNewProfileName] = useState('')
  const [profileAvatarSeed, setProfileAvatarSeed] = useState(DEFAULT_PROFILE_AVATAR_SEED)
  const [profileData, setProfileData] = useState(() => {
    const profile = readStoredJson('mutflix_profile')
    if (profile && profile.id) {
      const cached = readDashboardCache(profile.id)
      if (cached) {
        return {
          myList: [],
          watchHistory: cached.history || [],
          isLoading: false,
          error: null,
        }
      }
    }
    return {
      myList: [],
      watchHistory: [],
      isLoading: false,
      error: null,
    }
  })
  const [catalogData, setCatalogData] = useState(() => {
    const profile = readStoredJson('mutflix_profile')
    if (profile && profile.id) {
      const cached = readDashboardCache(profile.id)
      if (cached) {
        const cachedCatalog = mergeDashboardCache({
          movies: cached.movies || [],
          series: cached.series || [],
        }, cached)
        return {
          movies: cachedCatalog.movies,
          rows: cached.rows,
          series: cachedCatalog.series,
          totals: cached.totals || { movies: cachedCatalog.movies.length, series: cachedCatalog.series.length },
          isLoading: true, // we still fetch fresh list in background
          isFromCache: true,
          error: null,
        }
      }
    }
    return {
      movies: [],
      rows: null,
      series: [],
      totals: { movies: 0, series: 0 },
      isLoading: true,
      isFromCache: false,
      error: null,
    }
  })
  const [detailData, setDetailData] = useState(EMPTY_DETAIL_DATA)
  const [contextMenu, setContextMenu] = useState(null)
  const featuredItemKeys = useRef(new Map())
  const historyQueueRequestId = useRef(0)
  const pendingMetadataKeys = useRef(new Set())
  const pendingMyListPromotionKeys = useRef(new Set())
  const catalogDataRef = useRef(catalogData)
  const profileDataRef = useRef(profileData)
  const dashboardRowsCacheKey = useRef('')

  const isRegister = mode === 'register'
  const canSubmit = username.trim().length > 0
    && password.length > 0
    && (!isRegister || accessToken.trim().length > 0)
    && !isLoading

  catalogDataRef.current = catalogData
  profileDataRef.current = profileData

  useEffect(() => {
    if (location.pathname === '/') {
      navigate('/dashboard', { replace: true })
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    dashboardRowsCacheKey.current = ''
  }, [selectedProfile?.id])

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
      const myListRequest = fetchMyList(authToken, selectedProfile.id, isMyListRoute ? { status: 'plan_to_watch' } : undefined)
        .then((myList) => ({ myList }))
        .catch(() => ({ myList: [] }))

      setProfileData((currentData) => ({ ...currentData, isLoading: true, error: null }))
      setCatalogData((currentData) => ({ ...currentData, isLoading: true, error: null }))

      if (cachedDashboard) {
        if (!ignore) {
          setProfileData({ myList: [], watchHistory: cachedDashboard.history || [], isLoading: false, error: null })
          setCatalogData({
            movies: cachedDashboard.movies,
            rows: cachedDashboard.rows,
            series: cachedDashboard.series,
            totals: cachedDashboard.totals || { movies: cachedDashboard.movies.length, series: cachedDashboard.series.length },
            isLoading: true,
            isFromCache: true,
            error: null,
          })
        }
      }

      try {
        const { dashboard, error } = await dashboardRequest
        const { myList } = await myListRequest
        if (error) throw error

        const refreshedDashboard = mergeDashboardCache(dashboard, cachedDashboard)

        // Show data immediately — merge with current state to preserve cached metadata
        if (!ignore) {
          setProfileData({ myList, watchHistory: refreshedDashboard.history, isLoading: false, error: null })
          setCatalogData((current) => {
            const merged = mergeCatalogMetadataUpdates(
              { movies: refreshedDashboard.movies, series: refreshedDashboard.series },
              current,
            )
            return { ...merged, totals: refreshedDashboard.totals || { movies: merged.movies.length, series: merged.series.length }, rows: null, isLoading: false, isFromCache: false, error: null }
          })
        }

        // Enrich metadata progressively in background — each batch updates UI + cache
        const profileId = selectedProfile.id
        const enrichedCatalog = await enrichCatalogMetadata(authToken, refreshedDashboard, Infinity, {
          onProgress: (enrichedSoFar) => {
            if (ignore) return
            setCatalogData((current) => {
              const merged = mergeCatalogMetadataUpdates(current, enrichedSoFar)
              writeDashboardCache(profileId, { history: refreshedDashboard.history, movies: merged.movies, series: merged.series })
              return { ...merged, totals: refreshedDashboard.totals || current.totals || { movies: merged.movies.length, series: merged.series.length }, rows: null, isLoading: false, isFromCache: false, error: null }
            })
          },
        })

        // Final write — ensures cache always has the fully enriched state
        if (!ignore) {
          setCatalogData((current) => {
            const merged = mergeCatalogMetadataUpdates(current, enrichedCatalog)
            writeDashboardCache(profileId, { history: refreshedDashboard.history, movies: merged.movies, series: merged.series })
            return { ...merged, totals: refreshedDashboard.totals || current.totals || { movies: merged.movies.length, series: merged.series.length }, rows: null, isLoading: false, isFromCache: false, error: null }
          })
        }
      } catch (error) {
        if (!ignore && !cachedDashboard) {
          setProfileData({ myList: [], watchHistory: [], isLoading: false, error: error.message })
          setCatalogData({ movies: [], rows: null, series: [], totals: { movies: 0, series: 0 }, isLoading: false, isFromCache: false, error: error.message })
        } else if (!ignore) {
          setProfileData((currentData) => ({ ...currentData, isLoading: false, error: error.message }))
          setCatalogData((currentData) => ({ ...currentData, isLoading: false, error: null }))
        }
      }
    }

    loadDashboard()

    return () => {
      ignore = true
    }
  }, [authToken, currentUser, isMyListRoute, selectedProfile])

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

  const handleDashboardRowsReady = useCallback((rows) => {
    if (!selectedProfile || !rows?.signature) return
    if (dashboardRowsCacheKey.current === rows.signature) return

    const currentCatalog = catalogDataRef.current
    if (currentCatalog.isLoading || currentCatalog.isFromCache) return

    dashboardRowsCacheKey.current = rows.signature
    writeDashboardCache(selectedProfile.id, {
      history: profileData.watchHistory,
      movies: currentCatalog.movies,
      rows,
      series: currentCatalog.series,
    })
  }, [profileData.watchHistory, selectedProfile])

  const handleSaveProgress = useCallback(async (payload, playbackContext = {}) => {
    const previousProfileData = profileDataRef.current
    const nextWatchHistory = mergeWatchHistory(previousProfileData.watchHistory, payload)
    const currentMyList = previousProfileData.myList
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
    await promoteCompletedMyListItem({
      authToken,
      myList: currentMyList,
      pendingKeys: pendingMyListPromotionKeys.current,
      playbackContext,
      profileId: selectedProfile?.id,
      setProfileData,
      watchHistory: nextWatchHistory,
    })
  }, [authToken, selectedProfile])

  const handleHideHistory = useCallback(async (historyEntry) => {
    if (!selectedProfile || !historyEntry?.media_path) return

    const payload = {
      media_path: historyEntry.media_path,
      profile_id: selectedProfile.id,
    }
    let previousHistory = []
    setProfileData((currentData) => {
      previousHistory = currentData.watchHistory
      const watchHistory = hideHistoryEntry(currentData.watchHistory, historyEntry)
      const currentCatalog = catalogDataRef.current
      writeDashboardCache(selectedProfile.id, {
        history: watchHistory,
        movies: currentCatalog.movies,
        series: currentCatalog.series,
      })
      return { ...currentData, watchHistory }
    })

    try {
      await hideWatchHistory(authToken, payload)
    } catch {
      setProfileData((currentData) => {
        const currentCatalog = catalogDataRef.current
        writeDashboardCache(selectedProfile.id, {
          history: previousHistory,
          movies: currentCatalog.movies,
          series: currentCatalog.series,
        })
        return { ...currentData, watchHistory: previousHistory }
      })
    }
  }, [authToken, selectedProfile])

  const handleSearchCatalog = useCallback((query, options) => (
    fetchCatalogSearch(authToken, query, options)
  ), [authToken])

  const closeCompletedContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const openCompletedContextMenu = useCallback((event, payload) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      ...payload,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 64),
    })
  }, [])

  const handleMarkContextCompleted = useCallback(async () => {
    const menu = contextMenu
    closeCompletedContextMenu()
    if (!menu || !selectedProfile) return

    if (menu.historyEntry) {
      const durationMs = Math.max(1, Number(menu.historyEntry.duration_ms || 0))
      const payload = {
        ...menu.historyEntry,
        profile_id: selectedProfile.id,
        position_ms: durationMs,
        duration_ms: durationMs,
      }
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
      await promoteCompletedMyListItem({
        authToken,
        myList: profileData.myList,
        pendingKeys: pendingMyListPromotionKeys.current,
        playbackContext: { item: menu.item, video: menu.video, videos: detailData.videos },
        profileId: selectedProfile.id,
        setProfileData,
        watchHistory: mergeWatchHistory(profileData.watchHistory, payload),
      })
      return
    }

    if (menu.video && menu.item) {
      const durationMs = Math.max(1, Number(menu.video.duration_ms || 0))
      const payload = createCompletedHistoryPayload({
        item: menu.item,
        profileId: selectedProfile.id,
        video: menu.video,
      }, durationMs)
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
      return
    }

    if (!menu.item) return
    const completedItem = await saveMyListItemStatus(authToken, {
      item: menu.item,
      profileId: selectedProfile.id,
      status: 'completed',
    })
    setProfileData((currentData) => ({
      ...currentData,
      myList: mergeMyListItem(currentData.myList, completedItem),
    }))
  }, [authToken, closeCompletedContextMenu, contextMenu, detailData.videos, profileData.myList, profileData.watchHistory, selectedProfile])

  useEffect(() => {
    if (!contextMenu) return undefined
    window.addEventListener('click', closeCompletedContextMenu)
    window.addEventListener('scroll', closeCompletedContextMenu, true)
    window.addEventListener('resize', closeCompletedContextMenu)
    return () => {
      window.removeEventListener('click', closeCompletedContextMenu)
      window.removeEventListener('scroll', closeCompletedContextMenu, true)
      window.removeEventListener('resize', closeCompletedContextMenu)
    }
  }, [closeCompletedContextMenu, contextMenu])

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

  function openAddProfile() {
    setEditingProfile(null)
    setNewProfileName('')
    setProfileAvatarSeed(DEFAULT_PROFILE_AVATAR_SEED)
    setProfileMessage(null)
    setShowAddProfile(true)
  }

  function openEditProfile(profile) {
    setEditingProfile(profile)
    setNewProfileName(profile.name || '')
    setProfileAvatarSeed(profile.avatar_seed || DEFAULT_PROFILE_AVATAR_SEED)
    setProfileMessage(null)
    setShowAddProfile(true)
  }

  function closeProfileForm() {
    if (isAddingProfile) return
    setShowAddProfile(false)
    setEditingProfile(null)
    setNewProfileName('')
    setProfileAvatarSeed(DEFAULT_PROFILE_AVATAR_SEED)
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
    localStorage.removeItem(PROFILES_CACHE_KEY)
    sessionStorage.removeItem('mutflix_token')
    sessionStorage.removeItem('mutflix_user')
    sessionStorage.removeItem('mutflix_profile')
    clearDashboardCache()
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

  function handleOpenCatalogEdit(item) {
    const itemPath = getItemPath(item) || getTitle(item)
    if (!itemPath) return
    navigate(`/admin/catalog/edit/${encodeURIComponent(itemPath)}`, {
      state: {
        from: getCurrentRoute(location),
        fromState: location.state,
        item,
      },
    })
  }

  const handleCatalogOverrideSaved = useCallback((item, tmdbResult, mediaType) => {
    if (!item || !tmdbResult) return

    const originalKey = getCatalogIdentityKey(item)
    const updatedItem = createCatalogOverrideItem(item, tmdbResult, mediaType)
    writeLocalTmdbOverride(updatedItem)
    setCatalogData((currentData) => {
      const nextData = {
        ...currentData,
        isFromCache: false,
        rows: null,
        movies: replaceCatalogItem(currentData.movies, originalKey, updatedItem),
        series: replaceCatalogItem(currentData.series, originalKey, updatedItem),
      }

      if (selectedProfile) {
        dashboardRowsCacheKey.current = ''
        writeDashboardCache(selectedProfile.id, {
          history: profileData.watchHistory,
          movies: nextData.movies,
          rows: null,
          series: nextData.series,
        })
      }

      return nextData
    })
  }, [profileData.watchHistory, selectedProfile])

  function handleDetailBack() {
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

  function handleResumeHistory(historyEntry) {
    const historyVideo = historyEntryToVideo(historyEntry)
    const historyItem = historyEntryToItem(historyEntry)
    if (!historyEntry.series_title) {
      handleOpenWatch(historyItem, historyVideo, [historyVideo])
      return
    }

    const catalogItem = findCatalogItemForHistory(historyEntry, catalogData.series) || historyItem
    const requestId = ++historyQueueRequestId.current
    const from = getCurrentRoute(location)
    const fromState = location.state
    handleOpenWatch(catalogItem, historyVideo, [historyVideo])

    window.setTimeout(() => {
      fetchVideoQueue(authToken, catalogItem).then((detail) => {
        if (requestId !== historyQueueRequestId.current) return
        const activePath = decodeRouteValue(window.location.pathname.slice('/watch/'.length))
        if (normalizeMediaPath(activePath) !== normalizeMediaPath(historyVideo.path)) return

        const matchedVideo = findHistoryVideo(historyEntry, detail.videos)
        const video = historyVideo
        const videos = matchedVideo
          ? detail.videos.map((entry) => (entry === matchedVideo ? video : entry))
          : [video]
        const resolvedItem = detail.item || catalogItem
        navigate(getWatchUrl(video.path), {
          replace: true,
          state: {
            from,
            fromState,
            item: resolvedItem,
            video,
            videos,
          },
        })
      }).catch(() => {
        // The local history entry is enough to keep playback usable.
      })
    }, 0)
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

  function handleOpenPersonSearch(person) {
    if (!person?.name) return
    navigate(buildSearchUrl(person.name, null, { personId: person.id }), {
      state: {
        from: getCurrentRoute(location),
        fromState: location.state,
      },
    })
  }

  function handleOpenCatalogAll() {
    navigate('/catalog', {
      state: {
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
      id: editingProfile?.id || createProfileId(),
      name: profileName,
      avatar_seed: profileAvatarSeed || editingProfile?.avatar_seed || DEFAULT_PROFILE_AVATAR_SEED || `${profileName}-${Date.now()}`,
    }

    try {
      if (editingProfile) {
        await editProfile(authToken, nextProfile)
      } else {
        await addProfile(authToken, nextProfile)
      }
      setProfiles((currentProfiles) => {
        const nextProfiles = editingProfile
          ? currentProfiles.map((profile) => (profile.id === nextProfile.id ? nextProfile : profile))
          : [...currentProfiles, nextProfile]
        writeProfilesCache(nextProfiles)
        return nextProfiles
      })
      if (selectedProfile?.id === nextProfile.id) {
        const storage = localStorage.getItem('mutflix_token') ? localStorage : sessionStorage
        storage.setItem('mutflix_profile', JSON.stringify(nextProfile))
        setSelectedProfile(nextProfile)
      }
      setNewProfileName('')
      setProfileAvatarSeed(DEFAULT_PROFILE_AVATAR_SEED)
      setEditingProfile(null)
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

  function renderWithContextMenu(content) {
    return (
      <>
        {content}
        {contextMenu && (
          <div className="mutflix-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu">
            <button onClick={handleMarkContextCompleted} role="menuitem" type="button">
              Mark as completed
            </button>
          </div>
        )}
      </>
    )
  }

  if (currentUser && !selectedProfile) {
    return (
      <ProfilePage
        editingProfile={editingProfile}
        isAddingProfile={isAddingProfile}
        isProfileLoading={isProfileLoading}
        newProfileName={newProfileName}
        onAddProfile={handleAddProfile}
        onAvatarSeedChange={setProfileAvatarSeed}
        onEditProfile={openEditProfile}
        onNewProfileNameChange={setNewProfileName}
        onProfileSelect={handleProfileSelect}
        onShowAddProfileChange={openAddProfile}
        onCloseProfileForm={closeProfileForm}
        profileAvatarSeed={profileAvatarSeed}
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
          watchHistory={profileData.watchHistory}
        />
      )
    }
    if (isAdminEditRoute && currentUser?.role === 'admin') {
      const routeItemPath = decodeRouteValue(location.pathname.slice('/admin/catalog/edit/'.length))
      const editItem = location.state?.item || [...catalogData.movies, ...catalogData.series]
        .find((item) => getItemPath(item) === routeItemPath || getTitle(item) === routeItemPath)

      return (
        <AdminCatalogEditPage
          authToken={authToken}
          item={editItem || { name: routeItemPath }}
          onBack={() => navigateBackToStoredRoute(navigate, location.state)}
          onOverrideSaved={handleCatalogOverrideSaved}
        />
      )
    }
    if (isDetailRoute && detailData.item) {
      return renderWithContextMenu(
        <DetailPage
          detailData={detailData}
          onBack={handleDetailBack}
          onOpenContextMenu={openCompletedContextMenu}
          onOpenPerson={handleOpenPersonSearch}
          onPlayVideo={(video) => handleOpenWatch(detailData.item, video, detailData.videos)}
          watchHistory={profileData.watchHistory}
        />,
      )
    }
    if (isCatalogAllRoute) {
      return renderWithContextMenu(
        <CatalogAllPage
          catalogData={catalogData}
          isAdmin={currentUser?.role === 'admin'}
          myList={profileData.myList}
          onChangeProfile={handleChangeProfile}
          onFilterSelect={handleOpenCatalogFilter}
          onHydrateItems={hydrateCatalogItems}
          onLogout={handleLogout}
          onOpenCatalogEdit={handleOpenCatalogEdit}
          onOpenContextMenu={openCompletedContextMenu}
          onOpenDetail={handleOpenDetail}
          onOpenMyList={handleOpenMyList}
          onOpenSearch={handleOpenSearch}
          onSearchCatalog={handleSearchCatalog}
          selectedProfile={selectedProfile}
          watchHistory={profileData.watchHistory}
        />,
      )
    }
    if (isSearchRoute) {
      const searchFilter = readCatalogFilter(location.search)
      return renderWithContextMenu(
        <SearchResultsPage
          authToken={authToken}
          key={location.search || '__empty__'}
          catalogData={catalogData}
          initialFilter={searchFilter}
          initialQuery={new URLSearchParams(location.search).get('q') || ''}
          initialPersonId={Number(new URLSearchParams(location.search).get('person') || 0)}
          isAdmin={currentUser?.role === 'admin'}
          onChangeProfile={handleChangeProfile}
          onFilterSelect={(filter) => handleOpenCatalogFilter(filter, { replace: true })}
          onHydrateItems={hydrateCatalogItems}
          onLogout={handleLogout}
          onOpenCatalogEdit={handleOpenCatalogEdit}
          onOpenDetail={handleOpenDetail}
          onOpenMyList={handleOpenMyList}
          onOpenContextMenu={openCompletedContextMenu}
          onQueryChange={(query) => handleOpenSearch(query, { replace: true })}
          onSearchCatalog={handleSearchCatalog}
          selectedProfile={selectedProfile}
          watchHistory={profileData.watchHistory}
          myList={profileData.myList}
        />,
      )
    }
    if (isMyListRoute) {
      return renderWithContextMenu(
        <MyListPage
          authToken={authToken}
          catalogData={catalogData}
          key={selectedProfile.id}
          onChangeProfile={handleChangeProfile}
          onFilterSelect={handleOpenCatalogFilter}
          onHydrateItems={hydrateCatalogItems}
          onLogout={handleLogout}
          onOpenDetail={handleOpenDetail}
          onOpenContextMenu={openCompletedContextMenu}
          onOpenSearch={handleOpenSearch}
          onSearchCatalog={handleSearchCatalog}
          profileId={selectedProfile.id}
          profileMyList={profileData.myList}
          selectedProfile={selectedProfile}
          watchHistory={profileData.watchHistory}
        />,
      )
    }

    if (catalogData.isLoading && !catalogData.movies.length && !catalogData.series.length) return <DashboardSkeleton />

    return renderWithContextMenu(
      <DashboardPage
        catalogData={catalogData}
        isAdmin={currentUser?.role === 'admin'}
        onChangeProfile={handleChangeProfile}
        onDashboardRowsReady={handleDashboardRowsReady}
        onLogout={handleLogout}
        onHydrateItems={hydrateCatalogItems}
        onOpenCatalogFilter={handleOpenCatalogFilter}
        onOpenCatalogAll={handleOpenCatalogAll}
        onOpenCatalogEdit={handleOpenCatalogEdit}
        onOpenMyList={handleOpenMyList}
        onOpenDetail={handleOpenDetail}
        onOpenContextMenu={openCompletedContextMenu}
        onHideHistory={handleHideHistory}
        onPlayHistory={handleResumeHistory}
        onOpenSearch={handleOpenSearch}
        onSearchCatalog={handleSearchCatalog}
        myList={profileData.myList}
        profileData={profileData}
        selectedProfile={selectedProfile}
        featuredItemKey={getFeaturedItemKey(featuredItemKeys.current, selectedProfile.id, catalogData.movies, catalogData.series)}
      />,
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

async function promoteCompletedMyListItem({
  authToken,
  myList,
  pendingKeys,
  playbackContext,
  profileId,
  setProfileData,
  watchHistory,
}) {
  const item = playbackContext?.item
  if (!authToken || !profileId || !item || !isPlanToWatchMyListItem(item, myList)) return
  if (!isPlaybackContextCompleted(playbackContext, watchHistory)) return

  const itemKey = getCatalogIdentityKey(item)
  if (!itemKey || pendingKeys.has(itemKey)) return
  pendingKeys.add(itemKey)

  try {
    const completedItem = await saveMyListItemStatus(authToken, {
      item,
      profileId,
      status: 'completed',
    })
    setProfileData((currentData) => ({
      ...currentData,
      myList: mergeMyListItem(currentData.myList, completedItem),
    }))
  } finally {
    pendingKeys.delete(itemKey)
  }
}

function isPlanToWatchMyListItem(item, myList) {
  const itemKey = getCatalogIdentityKey(item)
  return (Array.isArray(myList) ? myList : []).some((entry) => (
    getCatalogIdentityKey(entry) === itemKey
    && (entry.status || entry.my_list_status || 'plan_to_watch') === 'plan_to_watch'
  ))
}

function isPlaybackContextCompleted({ item, video, videos = [] } = {}, watchHistory = []) {
  if (!item) return false
  if (getMediaType(item) === 'movie') {
    return isWatchHistoryVideoCompleted(video, watchHistory)
  }

  const episodeVideos = (Array.isArray(videos) ? videos : [])
    .filter((entry) => entry?.path)
  if (!episodeVideos.length) return false
  return episodeVideos.every((entry) => isWatchHistoryVideoCompleted(entry, watchHistory))
}

function isWatchHistoryVideoCompleted(video, watchHistory = []) {
  if (!video?.path) return false
  return (Array.isArray(watchHistory) ? watchHistory : []).some((entry) => (
    normalizeMediaPath(entry.media_path) === normalizeMediaPath(video.path)
    && Number(entry.duration_ms || 0) > 0
    && Number(entry.position_ms || 0) >= Number(entry.duration_ms || 0) * 0.9
  ))
}

function getCurrentRoute(location) {
  return `${location.pathname}${location.search}`
}

function buildSearchUrl(query, filter, { personId } = {}) {
  const params = new URLSearchParams()
  const normalizedQuery = String(query || '').trim()
  if (normalizedQuery) params.set('q', normalizedQuery)
  if (personId) params.set('person', String(personId))
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
  navigate(routeState?.from || '/dashboard', { flushSync: true, state: routeState?.fromState || null })
}

function createCatalogOverrideItem(item, tmdbResult, mediaType) {
  const nextMediaType = mediaType === 'movie' ? 'movie' : 'tv'
  return {
    ...item,
    media_type: nextMediaType,
    type: nextMediaType === 'movie' ? 'movie' : 'series',
    tmdb_backdrop_path: tmdbResult.backdrop_path || '',
    tmdb_id: tmdbResult.id || item.tmdb_id,
    tmdb_metadata_resolved: true,
    tmdb_override_id: tmdbResult.id || item.tmdb_override_id,
    tmdb_original_language: tmdbResult.original_language || '',
    tmdb_overview: tmdbResult.overview || '',
    tmdb_poster_path: tmdbResult.poster_path || '',
    tmdb_rating: Number(tmdbResult.vote_average || 0),
    tmdb_title: tmdbResult.title || tmdbResult.name || tmdbResult.original_title || tmdbResult.original_name || getTitle(item),
  }
}

function replaceCatalogItem(items, originalKey, updatedItem) {
  return items.map((item) => (
    getCatalogIdentityKey(item) === originalKey ? { ...item, ...updatedItem } : item
  ))
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

function createCompletedHistoryPayload({ item, profileId, video }, durationMs) {
  const isMovie = getMediaType(item) === 'movie'
  const episodeTitle = getEpisodeHistoryLabel({
    ...video,
    media_path: video.path,
    media_title: video.title || video.name,
  })
  return {
    profile_id: profileId,
    media_path: video.path,
    media_title: isMovie ? getTitle(item) : episodeTitle,
    series_title: isMovie ? null : getTitle(item),
    series_path: isMovie ? null : getItemPath(item),
    source: video.source || item.source || '',
    still_path: video.still_path || item.tmdb_backdrop_path || item.backdrop_path || item.tmdb_poster_path || item.poster_path || '',
    subtitle_path: video.subtitle_path || '',
    season: video.season || 1,
    episode: video.episode || 1,
    position_ms: durationMs,
    duration_ms: durationMs,
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
  if (isCompleted) {
    return normalizeWatchHistory([
      {
        ...normalizedPayload,
        is_hidden: 0,
        last_watched: new Date().toISOString(),
      },
      ...remainingHistory,
    ]).slice(0, 100)
  }
  return normalizeWatchHistory([
    {
      ...normalizedPayload,
      is_hidden: 0,
      last_watched: new Date().toISOString(),
    },
    ...remainingHistory,
  ]).slice(0, 20)
}

function mergeMyListItem(myList, item) {
  const itemKey = getCatalogIdentityKey(item)
  const nextItem = { ...item, my_list_status: 'completed' }
  const existingItems = Array.isArray(myList) ? myList : []
  if (!existingItems.some((entry) => getCatalogIdentityKey(entry) === itemKey)) return [nextItem, ...existingItems]
  return existingItems.map((entry) => (
    getCatalogIdentityKey(entry) === itemKey ? { ...entry, ...nextItem } : entry
  ))
}

function hideHistoryEntry(history, historyEntry) {
  const mediaPath = normalizeMediaPath(historyEntry.media_path)
  if (!mediaPath) return normalizeWatchHistory(history)

  return normalizeWatchHistory(history).map((entry) => (
    entry.media_path === mediaPath
      ? { ...entry, is_hidden: 1 }
      : entry
  ))
}

function appendMissingCatalogItems(items, additions) {
  const itemKeys = new Set(items.map(getCatalogIdentityKey))
  return [
    ...items,
    ...additions.filter((item) => !itemKeys.has(getCatalogIdentityKey(item))),
  ]
}

export default App
