import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, Play, Plus, Search, User } from 'lucide-react'
import './App.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space').replace(/\/$/, '')

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

function getStillUrl(item) {
  const stillPath = item.still_path
  if (!stillPath) return ''
  if (stillPath.startsWith('http')) return stillPath
  return `${API_BASE_URL}/api/tmdb-image/w500/${stillPath.replace(/^\//, '')}`
}

function getItemKey(item) {
  return `${item.type || item.media_type || 'item'}-${item.source || ''}-${item.folder_name || item.name || getTitle(item)}`
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
      tmdb_overview: item.tmdb_overview || metadata.overview,
      tmdb_rating: item.tmdb_rating || metadata.vote_average,
      media_type: mediaType,
    }
  })
}

function App() {
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
  const [newProfileName, setNewProfileName] = useState('')
  const [profileData, setProfileData] = useState({
    watchHistory: [],
    isLoading: false,
    error: null,
  })
  const [catalogData, setCatalogData] = useState({
    movies: [],
    series: [],
    isLoading: false,
    error: null,
  })

  const isRegister = mode === 'register'
  const canSubmit = username.trim().length > 0
    && password.length > 0
    && (!isRegister || accessToken.trim().length > 0)
    && !isLoading

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
          setProfiles(Array.isArray(data) ? data : [])
        }
      } catch (error) {
        if (!ignore) {
          setProfileMessage(error.message)
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

        let movies = Array.isArray(catalog.movies) ? catalog.movies : []
        let series = Array.isArray(catalog.series) ? catalog.series : []

        const itemsNeedingPoster = [
          ...movies
            .filter((item) => !getPosterUrl(item))
            .slice(0, 24)
            .map((item) => ({ media_type: 'movie', folder_name: item.folder_name || item.name })),
          ...series
            .filter((item) => !getPosterUrl(item))
            .slice(0, 24)
            .map((item) => ({ media_type: 'tv', folder_name: item.folder_name || item.name })),
        ].filter((item) => item.folder_name)

        if (itemsNeedingPoster.length) {
          const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/bulk`, {
            method: 'POST',
            headers: {
              ...headers,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ items: itemsNeedingPoster }),
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
        if (!ignore) {
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

      setProfiles((currentProfiles) => [...currentProfiles, nextProfile])
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
    const featuredItem = catalogData.movies.find((item) => getPosterUrl(item, 'w780'))
      || catalogData.series.find((item) => getPosterUrl(item, 'w780'))
      || catalogData.movies[0]
      || catalogData.series[0]
    const featuredPoster = featuredItem ? getPosterUrl(featuredItem, 'w780') : ''

    return (
      <main className="dashboard-page">
        <nav className="dashboard-topbar" aria-label="Dashboard">
          <a className="brand-mark dashboard-brand" href="/" aria-label="Mutflix dashboard">
            MUTFLIX
          </a>
          <div className="dashboard-nav">
            <button type="button">Home</button>
            <button type="button">Movies</button>
            <button type="button">Series</button>
          </div>
          <button className="dashboard-search" aria-label="Search" type="button">
            <Search size={20} />
          </button>
          <span>{selectedProfile.name}</span>
        </nav>

        <section className="dashboard-hero" aria-label="Featured title">
          {featuredPoster && <img alt="" className="dashboard-hero-poster" src={featuredPoster} />}
          <div className="dashboard-hero-shade" />
          <div className="dashboard-hero-content">
            <p className="eyebrow">Now streaming for {selectedProfile.name}</p>
            <h1>{featuredItem ? getTitle(featuredItem) : 'Mutflix'}</h1>
            <p>
              {featuredItem?.tmdb_overview
                || 'Explore movies and series from your Mutflix catalog.'}
            </p>
            <button className="play-button" type="button">
              <Play size={22} fill="currentColor" />
              <span>Play</span>
            </button>
          </div>
        </section>

        <section className="dashboard-shell" aria-label="Mutflix catalog">
          {catalogData.isLoading && (
            <div className="dashboard-state">
              <Loader2 className="spinner" size={26} />
              <span>Loading catalog...</span>
            </div>
          )}

          {catalogData.error && (
            <div className="notice error dashboard-notice" role="alert">
              <AlertCircle size={18} />
              <span>{catalogData.error}</span>
            </div>
          )}

          {!catalogData.isLoading && !catalogData.error && (
            <>
              <HistoryRow items={profileData.watchHistory} />
              <CatalogRow items={catalogData.movies} title="Movies" />
              <CatalogRow items={catalogData.series} title="Series" />
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

function CatalogRow({ items, title }) {
  if (!items.length) return null

  return (
    <section className="catalog-row" aria-label={title}>
      <h2>{title}</h2>
      <div className="catalog-scroller">
        {items.map((item, index) => (
          <article className="catalog-card" key={`${getItemKey(item)}-${index}`}>
            <div className="poster-frame">
              {getPosterUrl(item) ? (
                <img alt={getTitle(item)} loading="lazy" src={getPosterUrl(item)} />
              ) : (
                <div className="poster-fallback">
                  <span>{getTitle(item).slice(0, 1).toUpperCase()}</span>
                </div>
              )}
            </div>
            <h3>{getTitle(item)}</h3>
          </article>
        ))}
      </div>
    </section>
  )
}

function HistoryRow({ items }) {
  if (!items.length) return null

  return (
    <section className="catalog-row" aria-label="Continue watching">
      <h2>Continue Watching</h2>
      <div className="catalog-scroller history-scroller">
        {items.map((item) => (
          <article className="catalog-card history-card" key={item.media_path}>
            <div className="history-frame">
              {getStillUrl(item) ? (
                <img alt={item.media_title || item.series_title || 'Continue watching'} loading="lazy" src={getStillUrl(item)} />
              ) : (
                <div className="poster-fallback">
                  <span>{(item.media_title || item.series_title || 'M').slice(0, 1).toUpperCase()}</span>
                </div>
              )}
            </div>
            <h3>{item.media_title || item.series_title || 'Continue Watching'}</h3>
          </article>
        ))}
      </div>
    </section>
  )
}

export default App
