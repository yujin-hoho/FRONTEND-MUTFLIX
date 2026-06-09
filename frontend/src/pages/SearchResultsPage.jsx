import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Pencil, Search } from 'lucide-react'
import SearchBox from '../components/search/SearchBox'
import LoadableImage from '../components/LoadableImage'
import ProfileMenu from '../components/ProfileMenu'
import { fetchTmdbPeopleSearch, fetchTmdbPersonCombinedCredits } from '../services/api'
import {
  getItemKey,
  getMediaType,
  getPersonFallbackUrl,
  getPosterUrl,
  getRating,
  getStillUrl,
  getTitle,
  isCatalogItemCompleted,
} from '../utils/media'
import { filterCatalogItems, mergeSearchResults, normalizeSearchQuery, prepareSearchCatalog, searchCatalog } from '../utils/search'

export const RESULT_BATCH_SIZE = 16

function SearchResultsPage({
  authToken,
  catalogData,
  initialFilter,
  initialPersonId = 0,
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
  const [peopleSearch, setPeopleSearch] = useState({ people: [], query: '', status: 'idle' })
  const [selectedPersonId, setSelectedPersonId] = useState(initialPersonId || null)
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
  const selectedPerson = useMemo(
    () => peopleSearch.people.find((person) => person.id === selectedPersonId) || null,
    [peopleSearch.people, selectedPersonId],
  )
  const displayResults = selectedPerson ? selectedPerson.projects : results
  const isPeopleSearchPending = normalizedQuery.length >= 2
    && (peopleSearch.query !== normalizedQuery || peopleSearch.status === 'loading')
  const shouldSuppressTitleEmptyState = normalizedQuery
    && !selectedPerson
    && results.length === 0
    && (peopleSearch.people.length > 0 || isPeopleSearchPending || looksLikePersonName(deferredQuery))
  const isServerSearchPending = normalizedQuery.length >= 2
    && (serverSearch.query !== normalizedQuery || serverSearch.status === 'loading')
  const resultKey = `${initialFilter?.type || 'all'}:${initialFilter?.value || 'all'}:${normalizedQuery}:${selectedPerson?.id || 'catalog'}:${displayResults.length}`
  const visibleCount = lazyRenderState.key === resultKey ? lazyRenderState.count : RESULT_BATCH_SIZE
  const visibleResults = useMemo(
    () => displayResults.slice(0, visibleCount),
    [displayResults, visibleCount],
  )
  const currentBatchResults = useMemo(
    () => visibleResults.slice(Math.max(0, visibleResults.length - RESULT_BATCH_SIZE)),
    [visibleResults],
  )
  const hasMoreResults = visibleResults.length < displayResults.length
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
    setSelectedPersonId(initialPersonId || null)
    if (!authToken || normalizedQuery.length < 2) {
      setPeopleSearch({ people: [], query: normalizedQuery, status: 'idle' })
      return undefined
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setPeopleSearch((current) => ({ ...current, query: normalizedQuery, status: 'loading' }))
      searchCatalogPeople({
        authToken,
        catalogItems: filteredCatalogItems,
        query: deferredQuery,
        signal: controller.signal,
      })
        .then((people) => setPeopleSearch({ people, query: normalizedQuery, status: 'ready' }))
        .catch((error) => {
          if (error.name !== 'AbortError') setPeopleSearch({ people: [], query: normalizedQuery, status: 'error' })
        })
    }, 180)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [authToken, deferredQuery, filteredCatalogItems, initialPersonId, normalizedQuery])

  useEffect(() => {
    if (!initialPersonId || peopleSearch.query !== normalizedQuery || peopleSearch.status !== 'ready') return
    if (peopleSearch.people.some((person) => person.id === initialPersonId)) {
      setSelectedPersonId(initialPersonId)
    }
  }, [initialPersonId, normalizedQuery, peopleSearch])

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
            count: Math.min(currentCount + RESULT_BATCH_SIZE, displayResults.length),
            key: resultKey,
          }
        })
      },
      { root: scrollRoot, rootMargin: '280px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [displayResults.length, hasMoreResults, resultKey])

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
          <span>{getSearchResultSummary({ initialFilter, normalizedQuery, results, selectedPerson, showLoadingShimmer })}</span>
        </div>

        {showLoadingShimmer && <SearchResultsShimmer />}

        {!showLoadingShimmer && !normalizedQuery && !initialFilter && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Mulai ketik judul atau genre di kolom pencarian.</p>
          </div>
        )}

        {!showLoadingShimmer && normalizedQuery && !selectedPerson && results.length === 0 && !shouldSuppressTitleEmptyState && isServerSearchPending && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Mencari &quot;{deferredQuery.trim()}&quot; di katalog...</p>
          </div>
        )}

        {!showLoadingShimmer && normalizedQuery && !selectedPerson && results.length === 0 && !shouldSuppressTitleEmptyState && !isServerSearchPending && (
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

        {!showLoadingShimmer && normalizedQuery && peopleSearch.people.length > 0 && (
          <section className="people-search-section" aria-label="People">
            <div className="people-search-heading">
              <h2>People</h2>
            </div>
            <div className="people-search-list">
              {peopleSearch.people.map((person) => (
                <button
                  className={`person-search-card ${selectedPersonId === person.id ? 'active' : ''}`}
                  key={person.id}
                  onClick={() => setSelectedPersonId(person.id)}
                  type="button"
                >
                  <span className="person-search-avatar">
                    <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} src={getStillUrl(person)} />
                  </span>
                  <span className="person-search-copy">
                    <strong>{person.name}</strong>
                    <small>{person.projects.length} project{person.projects.length === 1 ? '' : 's'}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!showLoadingShimmer && selectedPerson && displayResults.length === 0 && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Tidak ada proyek {selectedPerson.name} di katalog.</p>
          </div>
        )}

        {!showLoadingShimmer && displayResults.length > 0 && (
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

function getSearchResultSummary({ initialFilter, normalizedQuery, results, selectedPerson, showLoadingShimmer }) {
  if (showLoadingShimmer) return 'Menyiapkan katalog...'
  if (selectedPerson) return `${selectedPerson.projects.length} proyek ${selectedPerson.name} di katalog`
  if (normalizedQuery || initialFilter) return `${results.length} judul ditemukan`
  return 'Ketik keyword untuk menampilkan hasil.'
}

function getResultsTitle(filter, query) {
  const trimmedQuery = query.trim()
  if (filter && trimmedQuery) return `${filter.label}: "${trimmedQuery}"`
  if (filter) return filter.label
  return trimmedQuery ? `Hasil untuk "${trimmedQuery}"` : 'Cari tontonan kamu'
}

function looksLikePersonName(query) {
  const normalizedQuery = normalizeSearchQuery(query)
  if (!normalizedQuery) return false
  const words = normalizedQuery.split(' ').filter(Boolean)
  if (words.length >= 2 && words.length <= 4 && words.every((word) => word.length >= 2)) return true
  return words.length === 1 && words[0].length >= 4
}

async function searchCatalogPeople({ authToken, catalogItems, query, signal }) {
  const tmdbCatalog = createTmdbCatalogMap(catalogItems)
  if (!tmdbCatalog.size) return []

  const people = await fetchTmdbPeopleSearch(authToken, query, { signal })
  const candidatePeople = people
    .filter((person) => person?.id && person.name)
    .slice(0, 10)

  const peopleWithProjects = await Promise.all(candidatePeople.map(async (person) => {
    const credits = await fetchTmdbPersonCombinedCredits(authToken, person.id, { signal })
    const projects = getLocalProjectsForPersonCredits(credits, tmdbCatalog)
    if (!projects.length) return null
    return {
      ...person,
      projects,
    }
  }))

  return peopleWithProjects
    .filter(Boolean)
    .sort((first, second) => second.projects.length - first.projects.length || Number(second.popularity || 0) - Number(first.popularity || 0))
}

function createTmdbCatalogMap(items) {
  const catalog = new Map()
  items.forEach((item) => {
    const tmdbId = Number(item.tmdb_id || item.tmdb_override_id || 0)
    if (!tmdbId) return
    const mediaType = getMediaType(item) === 'movie' ? 'movie' : 'tv'
    catalog.set(`${mediaType}:${tmdbId}`, item)
  })
  return catalog
}

function getLocalProjectsForPersonCredits(credits, tmdbCatalog) {
  const seen = new Set()
  return [...(credits.cast || []), ...(credits.crew || [])]
    .flatMap((credit) => {
      const mediaType = credit.media_type === 'movie' ? 'movie' : credit.media_type === 'tv' ? 'tv' : ''
      const tmdbId = Number(credit.id || 0)
      const item = mediaType && tmdbId ? tmdbCatalog.get(`${mediaType}:${tmdbId}`) : null
      if (!item) return []
      const key = getItemKey(item)
      if (seen.has(key)) return []
      seen.add(key)
      return [item]
    })
    .sort((first, second) => getRating(second) - getRating(first) || getTitle(first).localeCompare(getTitle(second)))
}

export default SearchResultsPage
