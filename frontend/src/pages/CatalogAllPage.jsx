import { useEffect, useMemo, useRef, useState } from 'react'
import ProfileMenu from '../components/ProfileMenu'
import SearchBox from '../components/search/SearchBox'
import { getItemKey, getPosterUrl } from '../utils/media'
import { RESULT_BATCH_SIZE, SearchResultCard } from './SearchResultsPage'

const CATALOG_BATCH_SIZE = RESULT_BATCH_SIZE * 2

function CatalogAllPage({
  catalogData,
  isAdmin = false,
  myList = [],
  onChangeProfile,
  onFilterSelect,
  onHydrateItems,
  onLogout,
  onOpenCatalogEdit,
  onOpenContextMenu,
  onOpenDetail,
  onOpenMyList,
  onOpenSearch,
  onSearchCatalog,
  selectedProfile,
  watchHistory = [],
}) {
  const pageRef = useRef(null)
  const lazyLoadRef = useRef(null)
  const requestedHydrationKey = useRef('')
  const catalogItems = useMemo(() => [...catalogData.movies, ...catalogData.series], [catalogData.movies, catalogData.series])
  const catalogKey = useMemo(() => {
    const firstKey = catalogItems[0] ? getItemKey(catalogItems[0]) : ''
    const lastKey = catalogItems.at(-1) ? getItemKey(catalogItems.at(-1)) : ''
    return `${catalogItems.length}:${firstKey}:${lastKey}`
  }, [catalogItems])
  const [lazyRenderState, setLazyRenderState] = useState({ count: CATALOG_BATCH_SIZE, key: '' })
  const visibleCount = lazyRenderState.key === catalogKey ? lazyRenderState.count : CATALOG_BATCH_SIZE
  const visibleItems = useMemo(() => catalogItems.slice(0, visibleCount), [catalogItems, visibleCount])
  const catalogTotal = Math.max(
    catalogItems.length,
    Number(catalogData.totals?.movies || 0) + Number(catalogData.totals?.series || 0),
  )
  const currentBatchItems = useMemo(
    () => visibleItems.slice(Math.max(0, visibleItems.length - CATALOG_BATCH_SIZE)),
    [visibleItems],
  )
  const hasMoreItems = visibleItems.length < catalogItems.length
  const hydrationItems = useMemo(
    () => currentBatchItems.filter((item) => !getPosterUrl(item) && !item.tmdb_metadata_resolved),
    [currentBatchItems],
  )
  const hydrationKey = hydrationItems.map(getItemKey).join('|')
  const showLoadingShimmer = catalogData.isLoading && !catalogItems.length

  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 })
  }, [catalogKey])

  useEffect(() => {
    if (!hydrationKey || hydrationKey === requestedHydrationKey.current) return

    const timeoutId = window.setTimeout(() => {
      requestedHydrationKey.current = hydrationKey
      onHydrateItems?.(hydrationItems)
    }, 100)

    return () => window.clearTimeout(timeoutId)
  }, [hydrationItems, hydrationKey, onHydrateItems])

  useEffect(() => {
    const sentinel = lazyLoadRef.current
    const scrollRoot = pageRef.current
    if (!sentinel || !scrollRoot || !hasMoreItems) return undefined

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setLazyRenderState((currentState) => {
          const currentCount = currentState.key === catalogKey ? currentState.count : CATALOG_BATCH_SIZE
          return {
            count: Math.min(currentCount + CATALOG_BATCH_SIZE, catalogItems.length),
            key: catalogKey,
          }
        })
      },
      { root: scrollRoot, rootMargin: '420px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [catalogItems.length, catalogKey, hasMoreItems])

  return (
    <main className="search-page catalog-all-page" ref={pageRef}>
      <nav className="dashboard-topbar search-topbar" aria-label="Katalog">
        <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="Mutflix dashboard">
          MUTFLIX
        </a>
        <div className="dashboard-nav">
          <a href="/dashboard">Home</a>
          <button onClick={() => onFilterSelect({ label: 'Movies', type: 'type', value: 'movie' })} type="button">Movies</button>
          <button onClick={() => onFilterSelect({ label: 'Series', type: 'type', value: 'series' })} type="button">Series</button>
          <button onClick={() => onFilterSelect({ label: 'Variety Show', type: 'category', value: 'variety-show' })} type="button">Variety Show</button>
          <button onClick={onOpenMyList} type="button">My List</button>
        </div>
        <div className="dashboard-actions">
          <SearchBox
            catalogItems={catalogItems}
            myList={myList}
            onFilterSelect={onFilterSelect}
            onHydrateItems={onHydrateItems}
            onOpenContextMenu={onOpenContextMenu}
            onOpenDetail={onOpenDetail}
            onSearchCatalog={onSearchCatalog}
            onSubmit={onOpenSearch}
            watchHistory={watchHistory}
          />
          <ProfileMenu onChangeProfile={onChangeProfile} onLogout={onLogout} selectedProfile={selectedProfile} />
        </div>
      </nav>

      <section className="search-results-shell" aria-live="polite">
        <div className="search-results-heading">
          <p>Catalog</p>
          <h1>Semua katalog</h1>
          <span>{showLoadingShimmer ? 'Menyiapkan katalog...' : `${catalogTotal} judul tersedia`}</span>
        </div>

        {showLoadingShimmer && <CatalogAllShimmer />}

        {!showLoadingShimmer && catalogItems.length === 0 && (
          <div className="search-empty-state">
            <p>Katalog belum tersedia.</p>
          </div>
        )}

        {!showLoadingShimmer && catalogItems.length > 0 && (
          <>
            <div className="search-results-grid catalog-all-grid">
              {visibleItems.map((item) => (
                <SearchResultCard
                  item={item}
                  isAdmin={isAdmin}
                  key={getItemKey(item)}
                  myList={myList}
                  onOpenContextMenu={onOpenContextMenu}
                  onOpenDetail={onOpenDetail}
                  onOpenEdit={onOpenCatalogEdit}
                  watchHistory={watchHistory}
                />
              ))}
            </div>
            {hasMoreItems && <div className="search-results-sentinel" ref={lazyLoadRef} aria-hidden="true" />}
          </>
        )}
      </section>
    </main>
  )
}

function CatalogAllShimmer() {
  return (
    <div className="search-results-grid catalog-all-loading-grid" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => (
        <article className="catalog-all-loading-card" key={index}>
          <span className="skeleton-block catalog-all-loading-poster" />
          <span className="skeleton-block catalog-all-loading-title" />
          <span className="skeleton-block catalog-all-loading-meta" />
        </article>
      ))}
    </div>
  )
}

export default CatalogAllPage
