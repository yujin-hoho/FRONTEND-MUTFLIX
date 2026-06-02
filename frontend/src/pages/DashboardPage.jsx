import { useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, LogOut, Play, UsersRound } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import { CatalogRow, HistoryRow } from '../components/catalog/CatalogRows'
import SearchBox from '../components/search/SearchBox'
import {
  getDetailArtworkUrl,
  getGenres,
  getItemKey,
  getPosterFallbackUrl,
  getPosterUrl,
  getProfileAvatarUrl,
  getRating,
  getRotationKey,
  getTitle,
  rotateItems,
} from '../utils/media'

function DashboardPage({
  catalogData,
  featuredItemKey,
  onChangeProfile,
  onHydrateItems,
  onLogout,
  onOpenMyList,
  onOpenDetail,
  onPlayHistory,
  onOpenSearch,
  onSearchCatalog,
  profileData,
  selectedProfile,
}) {
  const [activeNav, setActiveNav] = useState('home')
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const dashboardView = useMemo(() => buildDashboardView(catalogData, selectedProfile, featuredItemKey), [catalogData, featuredItemKey, selectedProfile])

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
          <button onClick={onOpenMyList} type="button">My List</button>
        </div>
        <div className="dashboard-actions">
          <SearchBox
            catalogItems={dashboardView.catalogItems}
            onHydrateItems={onHydrateItems}
            onOpenDetail={onOpenDetail}
            onSearchCatalog={onSearchCatalog}
            onSubmit={onOpenSearch}
          />
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
                <button onClick={onChangeProfile} type="button">
                  <UsersRound size={17} />
                  <span>Ganti profil</span>
                </button>
                <button onClick={onLogout} type="button">
                  <LogOut size={17} />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <section className="dashboard-hero" aria-label="Featured title">
        <LoadableImage
          className="dashboard-hero-poster"
          fallbackSrc={dashboardView.featuredFallback}
          fetchPriority="high"
          key={`${dashboardView.featuredBackdrop}-${dashboardView.featuredFallback}`}
          loading="eager"
          src={dashboardView.featuredBackdrop}
        />
        <div className="dashboard-hero-shade" />
        <div className="dashboard-hero-content">
          <h1>{dashboardView.featuredItem ? getTitle(dashboardView.featuredItem) : 'Mutflix'}</h1>
          <p>
            {dashboardView.featuredItem?.tmdb_overview
              || 'Explore movies and series from your Mutflix catalog.'}
          </p>
          <button className="play-button" onClick={() => dashboardView.featuredItem && onOpenDetail(dashboardView.featuredItem)} type="button">
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
            <HistoryRow items={profileData.watchHistory} onPlay={onPlayHistory} />
            {dashboardView.curatedRows.map((row) => (
              <CatalogRow items={row.items} key={row.genre} onOpenDetail={onOpenDetail} title={row.genre} />
            ))}
            {dashboardView.catalogRows.map((row) => (
              <CatalogRow items={row.items} key={row.genre} onOpenDetail={onOpenDetail} ranked={row.ranked} title={row.genre} />
            ))}
          </>
        )}
      </section>
    </main>
  )
}

function buildDashboardView(catalogData, selectedProfile, featuredItemKey) {
  const rotationKey = getRotationKey(selectedProfile.id)
  const catalogItems = [...catalogData.movies, ...catalogData.series]
  const featuredItem = catalogItems.find((item) => getItemKey(item) === featuredItemKey)
    || rotateItems(catalogItems, `${rotationKey}-hero`)[0]
    || catalogItems[0]
  const genreRows = ['Action', 'Comedy', 'Drama', 'Thriller', 'Romance', 'Crime', 'Adventure', 'Fantasy', 'Science Fiction', 'Animation', 'Documentary']
    .map((genre) => ({
      genre,
      items: rotateItems(
        catalogItems.filter((item) => getGenres(item).includes(genre)),
        `${rotationKey}-${genre}`,
      ),
    }))
    .filter((row) => row.items.length)
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
  const browseAll = rotateItems(catalogItems, `${rotationKey}-browse-all`).slice(0, 24)
  const hiddenGems = rotateItems(
    catalogItems.filter((item) => {
      const rating = getRating(item)
      return rating > 0 && rating < 7.5
    }),
    `${rotationKey}-hidden-gems`,
  ).slice(0, 24)

  return {
    catalogItems,
    catalogRows: [
      topRatedSeries.length ? { genre: 'Top Rated TV Shows', items: topRatedSeries, ranked: true } : null,
      ...rotateItems(genreRows, `${rotationKey}-genre-rows`),
      topRatedMovies.length ? { genre: 'Top Rated Movies', items: topRatedMovies, ranked: true } : null,
      mysteryRow.items.length ? mysteryRow : null,
    ].filter(Boolean),
    curatedRows: [
      browseAll.length ? { genre: 'Browse All', items: browseAll } : null,
      freshPicks.length ? { genre: 'Fresh Picks', items: freshPicks } : null,
      hiddenGems.length ? { genre: 'Hidden Gems', items: hiddenGems } : null,
    ].filter(Boolean),
    featuredBackdrop: featuredItem ? getDetailArtworkUrl(featuredItem) : '',
    featuredFallback: featuredItem ? getPosterFallbackUrl(featuredItem) : '',
    featuredItem,
  }
}

export default DashboardPage
