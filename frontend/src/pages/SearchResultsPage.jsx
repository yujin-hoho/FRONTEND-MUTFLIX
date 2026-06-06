import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Pencil, Search } from 'lucide-react'
import SearchBox from '../components/search/SearchBox'
import LoadableImage from '../components/LoadableImage'
import ProfileMenu from '../components/ProfileMenu'
import { getGenres, getItemKey, getMediaType, getPosterUrl, getRating, getTitle, isCatalogItemCompleted } from '../utils/media'
import { filterCatalogItems, mergeSearchResults, normalizeSearchQuery, prepareSearchCatalog, searchCatalog } from '../utils/search'

export const RESULT_BATCH_SIZE = 16

function SearchResultsPage({
  catalogData,
  initialFilter,
  initialQuery,
  isAdmin = false,
  onChangeProfile,
  onFilterSelect,
  onHydrateItems,
  onLogout,
  onOpenCatalogEdit,
  onOpenDetail,
  onOpenMyList,
  onOpenContextMenu,
  onQueryChange,
  onSearchCatalog,
  myList = [],
  selectedProfile,
  watchHistory = [],
}) {
  const [query, setQuery] = useState(initialQuery)
  const [serverSearch, setServerSearch] = useState({ query: '', results: [], status: 'idle' })
  const [lazyRenderState, setLazyRenderState] = useState({ count: RESULT_BATCH_SIZE, key: '' })
  const searchPageRef = useRef(null)
  const requestedHydrationKey = useRef('')
  const lazyLoadRef = useRef(null)
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = normalizeSearchQuery(deferredQuery)
  const catalogItems = useMemo(() => [...catalogData.movies, ...catalogData.series], [catalogData.movies, catalogData.series])
  const filteredCatalogItems = useMemo(() => filterCatalogItems(catalogItems, initialFilter), [catalogItems, initialFilter])
  const searchIndex = useMemo(() => prepareSearchCatalog(filteredCatalogItems), [filteredCatalogItems])
  const localResults = useMemo(
    () => normalizedQuery ? searchCatalog(searchIndex, deferredQuery) : filteredCatalogItems,
    [deferredQuery, filteredCatalogItems, normalizedQuery, searchIndex],
  )
  const results = useMemo(
    () => mergeSearchResults(
      localResults,
      serverSearch.query === normalizedQuery ? filterCatalogItems(serverSearch.results, initialFilter) : [],
    ),
    [initialFilter, localResults, normalizedQuery, serverSearch],
  )
  const isServerSearchPending = normalizedQuery.length >= 2
    && (serverSearch.query !== normalizedQuery || serverSearch.status === 'loading')
  const resultKey = `${initialFilter?.type || 'all'}:${initialFilter?.value || 'all'}:${normalizedQuery}:${results.length}`
  const visibleCount = lazyRenderState.key === resultKey ? lazyRenderState.count : RESULT_BATCH_SIZE
  const visibleResults = useMemo(
    () => results.slice(0, visibleCount),
    [results, visibleCount],
  )
  const currentBatchResults = useMemo(
    () => visibleResults.slice(Math.max(0, visibleResults.length - RESULT_BATCH_SIZE)),
    [visibleResults],
  )
  const hasMoreResults = visibleResults.length < results.length
  const hydrationItems = useMemo(
    () => currentBatchResults.filter((item) => !getPosterUrl(item) && !item.tmdb_metadata_resolved),
    [currentBatchResults],
  )
  const hydrationKey = hydrationItems.map(getItemKey).join('|')
  const showLoadingShimmer = catalogData.isLoading && !catalogItems.length

  useEffect(() => {
    if (!onSearchCatalog || normalizedQuery.length < 2) return undefined

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setServerSearch({ query: normalizedQuery, results: [], status: 'loading' })
      onSearchCatalog(deferredQuery, { signal: controller.signal })
        .then((results) => setServerSearch({ query: normalizedQuery, results, status: 'ready' }))
        .catch((error) => {
          if (error.name !== 'AbortError') setServerSearch({ query: normalizedQuery, results: [], status: 'error' })
        })
    }, 80)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [deferredQuery, normalizedQuery, onSearchCatalog])

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
    const scrollRoot = searchPageRef.current
    if (!sentinel || !scrollRoot || !hasMoreResults) return undefined

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setLazyRenderState((currentState) => {
          const currentCount = currentState.key === resultKey ? currentState.count : RESULT_BATCH_SIZE
          return {
            count: Math.min(currentCount + RESULT_BATCH_SIZE, results.length),
            key: resultKey,
          }
        })
      },
      { root: scrollRoot, rootMargin: '280px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreResults, resultKey, results.length])

  function handleQueryChange(nextQuery) {
    setQuery(nextQuery)
  }

  return (
    <main className="search-page" ref={searchPageRef}>
      <nav className="dashboard-topbar search-topbar" aria-label="Katalog">
        <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="Mutflix dashboard">
          MUTFLIX
        </a>
        <div className="dashboard-nav">
          <a href="/dashboard">Home</a>
          <button className={isActiveFilter(initialFilter, 'type', 'movie') ? 'active' : ''} onClick={() => onFilterSelect({ label: 'Movies', type: 'type', value: 'movie' })} type="button">Movies</button>
          <button className={isActiveFilter(initialFilter, 'type', 'series') ? 'active' : ''} onClick={() => onFilterSelect({ label: 'Series', type: 'type', value: 'series' })} type="button">Series</button>
          <button className={isActiveFilter(initialFilter, 'category', 'variety-show') ? 'active' : ''} onClick={() => onFilterSelect({ label: 'Variety Show', type: 'category', value: 'variety-show' })} type="button">Variety Show</button>
          <button onClick={onOpenMyList} type="button">My List</button>
        </div>
        <div className="dashboard-actions">
          <SearchBox
            catalogItems={catalogItems}
            activeFilter={initialFilter}
            defaultQuery={initialQuery}
            myList={myList}
            onHydrateItems={onHydrateItems}
            onOpenDetail={onOpenDetail}
            onOpenContextMenu={onOpenContextMenu}
            onFilterSelect={onFilterSelect}
            onQueryChange={handleQueryChange}
            onSearchCatalog={onSearchCatalog}
            onSubmit={(nextQuery) => {
              setQuery(nextQuery)
              onQueryChange(nextQuery)
            }}
            query={query}
            showPreview={false}
            watchHistory={watchHistory}
          />
          <ProfileMenu onChangeProfile={onChangeProfile} onLogout={onLogout} selectedProfile={selectedProfile} />
        </div>
      </nav>

      <section className="search-results-shell" aria-live="polite">
        <div className="search-results-heading">
          <p>{initialFilter ? 'Filter' : 'Search'}</p>
          <h1>{getResultsTitle(initialFilter, deferredQuery)}</h1>
          <span>{showLoadingShimmer ? 'Menyiapkan katalog...' : normalizedQuery || initialFilter ? `${results.length} judul ditemukan` : 'Ketik keyword untuk menampilkan hasil.'}</span>
        </div>

        {showLoadingShimmer && <SearchResultsShimmer />}

        {!showLoadingShimmer && !normalizedQuery && !initialFilter && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Mulai ketik judul atau genre di kolom pencarian.</p>
          </div>
        )}

        {!showLoadingShimmer && normalizedQuery && results.length === 0 && isServerSearchPending && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Mencari &quot;{deferredQuery.trim()}&quot; di katalog...</p>
          </div>
        )}

        {!showLoadingShimmer && normalizedQuery && results.length === 0 && !isServerSearchPending && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Tidak ada hasil yang cocok untuk &quot;{deferredQuery.trim()}&quot;.</p>
          </div>
        )}

        {!showLoadingShimmer && !normalizedQuery && initialFilter && results.length === 0 && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Belum ada judul untuk filter {initialFilter.label}.</p>
          </div>
        )}

        {!showLoadingShimmer && results.length > 0 && (
          <>
            <div className="search-results-grid">
              {visibleResults.map((item) => (
                <SearchResultCard
                  item={item}
                  isAdmin={isAdmin}
                  key={getItemKey(item)}
                  myList={myList}
                  onOpenEdit={onOpenCatalogEdit}
                  onOpenContextMenu={onOpenContextMenu}
                  onOpenDetail={onOpenDetail}
                  watchHistory={watchHistory}
                />
              ))}
            </div>
            {hasMoreResults && <div className="search-results-sentinel" ref={lazyLoadRef} aria-hidden="true" />}
          </>
        )}
      </section>
    </main>
  )
}

export const SearchResultCard = memo(function SearchResultCard({ isAdmin = false, item, myList, onOpenContextMenu, onOpenDetail, onOpenEdit, watchHistory }) {
  const poster = getPosterUrl(item)
  const rating = getRating(item)
  const title = getTitle(item)
  const genres = getGenres(item)
  const isCompleted = isCatalogItemCompleted(item, { myList, watchHistory })

  return (
    <article
      className={`search-result-card${isCompleted ? ' item-completed' : ''}`}
      onContextMenu={(event) => onOpenContextMenu?.(event, { item })}
    >
      <button className="search-result-surface" onClick={() => onOpenDetail(item)} type="button">
        <span className={`search-result-poster${isCompleted ? ' completed-poster' : ''}`}>
          <LoadableImage alt={title} key={poster} src={poster} />
          {isCompleted && (
            <span aria-label="Selesai" className="completion-badge item-completion-badge">
              <Check size={20} strokeWidth={3.4} />
            </span>
          )}
          {rating > 0 && (
            <span
              aria-label={`Rating ${Math.round(rating * 10)} percent`}
              className="rating-badge rating-pie"
              style={{ '--rating-percent': `${Math.min(100, Math.max(0, rating * 10))}%` }}
            >
              {Math.round(rating * 10)}%
            </span>
          )}
        </span>
        <span className="search-result-copy">
          <strong>{title}</strong>
          <span>{getMediaType(item) === 'movie' ? 'Movie' : 'Series'}{genres[0] ? ` / ${genres[0]}` : ''}</span>
        </span>
      </button>
      {isAdmin && (
        <button
          aria-label={`Edit ${title}`}
          className="search-result-edit-button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onOpenEdit?.(item)
          }}
          title="Edit"
          type="button"
        >
          <Pencil size={15} strokeWidth={2.6} />
        </button>
      )}
    </article>
  )
})

function SearchResultsShimmer() {
  return (
    <div className="search-results-grid search-results-loading-grid" aria-hidden="true">
      {Array.from({ length: 18 }, (_, index) => (
        <article className="catalog-all-loading-card" key={index}>
          <span className="skeleton-block catalog-all-loading-poster" />
          <span className="skeleton-block catalog-all-loading-title" />
          <span className="skeleton-block catalog-all-loading-meta" />
        </article>
      ))}
    </div>
  )
}

function isActiveFilter(filter, type, value) {
  return filter?.type === type && filter.value === value
}

function getResultsTitle(filter, query) {
  const trimmedQuery = query.trim()
  if (filter && trimmedQuery) return `${filter.label}: "${trimmedQuery}"`
  if (filter) return filter.label
  return trimmedQuery ? `Hasil untuk "${trimmedQuery}"` : 'Cari tontonan kamu'
}

export default SearchResultsPage
