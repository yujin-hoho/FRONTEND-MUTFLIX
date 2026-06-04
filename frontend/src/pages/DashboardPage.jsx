import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, LogOut, Play, UsersRound } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import { CatalogRow, HistoryRow } from '../components/catalog/CatalogRows'
import SearchBox from '../components/search/SearchBox'
import { createDashboardRowsSnapshot } from '../utils/cache'
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
  isCatalogItemCompleted,
  isWatchCompleted,
  rotateItems,
} from '../utils/media'

function DashboardPage({
  catalogData,
  featuredItemKey,
  onChangeProfile,
  onHydrateItems,
  onLogout,
  onOpenCatalogFilter,
  onOpenContextMenu,
  onOpenMyList,
  onOpenDetail,
  onHideHistory,
  onDashboardRowsReady,
  onPlayHistory,
  onOpenSearch,
  onSearchCatalog,
  myList = [],
  profileData,
  selectedProfile,
}) {
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const dashboardView = useMemo(
    () => buildDashboardView(catalogData, selectedProfile, featuredItemKey, profileData.watchHistory, myList),
    [catalogData, featuredItemKey, myList, profileData.watchHistory, selectedProfile],
  )
  const displayView = catalogData.isFromCache && catalogData.rows
    ? { ...dashboardView, ...catalogData.rows }
    : dashboardView

  useEffect(() => {
    if (!onDashboardRowsReady || catalogData.isLoading || catalogData.isFromCache) return
    onDashboardRowsReady(createDashboardRowsSnapshot(dashboardView))
  }, [catalogData.isFromCache, catalogData.isLoading, dashboardView, onDashboardRowsReady])

  return (
    <main className="dashboard-page">
      <nav className="dashboard-topbar" aria-label="Dashboard">
        <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="Mutflix dashboard">
          MUTFLIX
        </a>
        <div className="dashboard-nav">
          <button className="active" type="button">Home</button>
          <button onClick={() => onOpenCatalogFilter({ label: 'Movies', type: 'type', value: 'movie' })} type="button">Movies</button>
          <button onClick={() => onOpenCatalogFilter({ label: 'Series', type: 'type', value: 'series' })} type="button">Series</button>
          <button onClick={() => onOpenCatalogFilter({ label: 'Variety Show', type: 'category', value: 'variety-show' })} type="button">Variety Show</button>
          <button onClick={onOpenMyList} type="button">My List</button>
        </div>
        <div className="dashboard-actions">
          <SearchBox
            catalogItems={dashboardView.catalogItems}
            myList={myList}
            onHydrateItems={onHydrateItems}
            onFilterSelect={onOpenCatalogFilter}
            onOpenContextMenu={onOpenContextMenu}
            onOpenDetail={onOpenDetail}
            onSearchCatalog={onSearchCatalog}
            onSubmit={onOpenSearch}
            watchHistory={profileData.watchHistory}
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
          fallbackSrc={displayView.featuredFallback}
          fetchPriority="high"
          key={`${displayView.featuredBackdrop}-${displayView.featuredFallback}`}
          loading="eager"
          src={displayView.featuredBackdrop}
        />
        <div className="dashboard-hero-shade" />
        <div className="dashboard-hero-content">
          <h1>{displayView.featuredItem ? getTitle(displayView.featuredItem) : 'Mutflix'}</h1>
          <p>
            {displayView.featuredItem?.tmdb_overview
              || 'Explore movies and series from your Mutflix catalog.'}
          </p>
          <button className="play-button" onClick={() => displayView.featuredItem && onOpenDetail(displayView.featuredItem)} type="button">
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
            <HistoryRow items={getVisibleHistory(profileData.watchHistory)} onHide={onHideHistory} onOpenContextMenu={onOpenContextMenu} onPlay={onPlayHistory} />
            {displayView.curatedRows.map((row) => (
              <CatalogRow items={row.items} key={row.genre} onOpenContextMenu={onOpenContextMenu} onOpenDetail={onOpenDetail} title={row.genre} />
            ))}
            {displayView.catalogRows.map((row) => (
              <CatalogRow items={row.items} key={row.genre} onOpenContextMenu={onOpenContextMenu} onOpenDetail={onOpenDetail} ranked={row.ranked} title={row.genre} />
            ))}
          </>
        )}
      </section>
    </main>
  )
}

function buildDashboardView(catalogData, selectedProfile, featuredItemKey, watchHistory = [], myList = []) {
  const rotationKey = getRotationKey(selectedProfile.id)
  const completedContext = { myList, watchHistory }
  const catalogItems = [...catalogData.movies, ...catalogData.series]
    .filter((item) => !isCatalogItemCompleted(item, completedContext))
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

function getVisibleHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((entry) => !Number(entry.is_hidden || 0) && !isWatchCompleted(entry))
    .slice(0, 20)
}

export default DashboardPage
