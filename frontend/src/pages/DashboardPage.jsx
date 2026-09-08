import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Plus } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import ProfileMenu from '../components/ProfileMenu'
import { CatalogRow, HistoryRow } from '../components/catalog/CatalogRows'
import SearchBox from '../components/search/SearchBox'
import { createDashboardRowsSnapshot } from '../utils/cache'
import {
  getBackdropUrl,
  getGenres,
  getItemKey,
  getPosterFallbackUrl,
  getPosterUrl,
  getRating,
  getRotationKey,
  getTitle,
  isCatalogItemCompleted,
  isWatchCompleted,
  rotateItems,
} from '../utils/media'

function DashboardPage({
  catalogData,
  featuredItemKey = '',
  isAdmin = false,
  onChangeProfile,
  onHydrateItems,
  onLogout,
  onOpenCatalogAll,
  onOpenCatalogFilter,
  onOpenCatalogEdit,
  onOpenContextMenu,
  onOpenMyList,
  onToggleMyList,
  isItemInMyList,
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
  const [rotationKey, setRotationKey] = useState(() => getRotationKey(selectedProfile.id))
  const [isSavingMyList, setIsSavingMyList] = useState(false)
  const [myListError, setMyListError] = useState('')
  useEffect(() => {
    const updateRotation = () => setRotationKey(getRotationKey(selectedProfile.id))
    updateRotation()
    const interval = window.setInterval(updateRotation, 30000)
    window.addEventListener('focus', updateRotation)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', updateRotation)
    }
  }, [selectedProfile.id])
  const dashboardView = useMemo(
    () => buildDashboardView(catalogData, rotationKey, profileData.watchHistory, myList, featuredItemKey),
    [catalogData, featuredItemKey, rotationKey, myList, profileData.watchHistory],
  )
  const displayView = catalogData.rows
    ? {
      ...dashboardView,
      catalogRows: catalogData.rows.catalogRows?.length ? catalogData.rows.catalogRows : dashboardView.catalogRows,
      curatedRows: catalogData.rows.curatedRows?.length ? catalogData.rows.curatedRows : dashboardView.curatedRows,
    }
    : dashboardView

  useEffect(() => {
    if (!onDashboardRowsReady || catalogData.isLoading) return
    onDashboardRowsReady(createDashboardRowsSnapshot(dashboardView))
  }, [catalogData.isLoading, dashboardView, onDashboardRowsReady])

  return (
    <main className="dashboard-page">
      <nav className="dashboard-topbar dashboard-topbar-overlay" aria-label="Dashboard">
        <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="RÉEL dashboard">
          <img className="brand-logo" src="/REEL-logo-red.svg" alt="RÉEL" width="486" height="202" />
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
          <ProfileMenu onChangeProfile={onChangeProfile} onLogout={onLogout} selectedProfile={selectedProfile} />
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
          <h1>{displayView.featuredItem ? getTitle(displayView.featuredItem) : 'RÉEL'}</h1>
          <p>
            {displayView.featuredItem?.description
              || displayView.featuredItem?.overview
              || displayView.featuredItem?.tmdb_overview
              || 'Explore movies and series from your RÉEL catalog.'}
          </p>
          <div className="dashboard-hero-buttons">
            <button className="play-button" onClick={() => displayView.featuredItem && onOpenDetail(displayView.featuredItem)} type="button">
              <span>Watch Now</span>
            </button>
            <button
              className="hero-my-list-button"
              aria-pressed={Boolean(isItemInMyList?.(displayView.featuredItem))}
              aria-busy={isSavingMyList}
              disabled={!displayView.featuredItem || isSavingMyList}
              onClick={async () => {
                setIsSavingMyList(true)
                setMyListError('')
                try {
                  await onToggleMyList(displayView.featuredItem)
                } catch (error) {
                  setMyListError(error.message || 'Unable to update My List. Please try again.')
                } finally {
                  setIsSavingMyList(false)
                }
              }}
              type="button"
            >
              <Plus size={22} />
              <span>My List</span>
            </button>
          </div>
          {myListError && <div className="hero-my-list-error" role="alert">{myListError}</div>}
        </div>
      </section>

      <section className="dashboard-shell" aria-label="RÉEL catalog">
        {catalogData.error && (
          <div className="notice error dashboard-notice" role="alert">
            <AlertCircle size={18} />
            <span>{catalogData.error}</span>
          </div>
        )}

        {!catalogData.error && (
          <>
            <HistoryRow catalogItems={dashboardView.catalogItems} items={getVisibleHistory(profileData.watchHistory)} onHide={onHideHistory} onOpenContextMenu={onOpenContextMenu} onPlay={onPlayHistory} />
            {[...displayView.curatedRows, ...displayView.catalogRows].map((row, index) => (
              <CatalogRow
                items={row.items}
                isAdmin={isAdmin}
                key={row.genre}
                layout={(index + 1) % 3 === 0 ? 'horizontal' : 'vertical'}
                onOpenCatalogAll={onOpenCatalogAll}
                onOpenEdit={onOpenCatalogEdit}
                onOpenContextMenu={onOpenContextMenu}
                onOpenDetail={onOpenDetail}
                ranked={row.ranked}
                rowIndex={index}
                title={row.genre}
              />
            ))}
          </>
        )}
      </section>
    </main>
  )
}

function buildDashboardView(catalogData, rotationKey, watchHistory = [], myList = [], featuredItemKey = '') {
  const completedContext = { myList, watchHistory }
  const catalogItems = [...catalogData.movies, ...catalogData.series]
    .filter((item) => !isCatalogItemCompleted(item, completedContext))
  const backdropItems = catalogItems.filter((item) => getBackdropUrl(item))
  const heroCandidates = backdropItems.length ? backdropItems : catalogItems
  const featuredItem = heroCandidates.find((item) => getItemKey(item) === featuredItemKey)
    || rotateItems(heroCandidates, `${rotationKey}-hero`)[0]
    || backdropItems[0]
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
    featuredBackdrop: featuredItem ? getBackdropUrl(featuredItem) : '',
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
