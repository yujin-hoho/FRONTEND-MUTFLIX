import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
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
  getReleaseYear,
  getStillUrl,
  getTitle,
  isCatalogItemCompleted,
} from '../utils/media'
import { filterCatalogItems, mergeSearchResults, normalizeSearchQuery, prepareSearchCatalog, searchCatalog } from '../utils/search'

export const RESULT_BATCH_SIZE = 32
const SEARCH_SERVER_RESULT_LIMIT = 500
const PEOPLE_SEARCH_PAGE_LIMIT = 3
const PERSON_CANDIDATE_LIMIT = 24

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
  const [manualPersonSelection, setManualPersonSelection] = useState({ id: null, query: '' })
  const [lazyRenderState, setLazyRenderState] = useState({ count: RESULT_BATCH_SIZE, key: '' })
  const searchPageRef = useRef(null)
  const requestedActorLookupHydrationKey = useRef('')
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
  const selectedPersonId = manualPersonSelection.query === normalizedQuery
    ? manualPersonSelection.id
    : initialPersonId || null
  const visiblePeople = useMemo(
    () => normalizedQuery.length >= 2 && peopleSearch.query === normalizedQuery ? peopleSearch.people : [],
    [normalizedQuery, peopleSearch.people, peopleSearch.query],
  )
  const selectedPerson = useMemo(
    () => visiblePeople.find((person) => person.id === selectedPersonId) || null,
    [selectedPersonId, visiblePeople],
  )
  const displayResults = selectedPerson ? selectedPerson.projects : results
  const actorProjectGroups = useMemo(
    () => {
      if (!selectedPerson) return { completed: [], planToWatch: [] }

      return selectedPerson.projects.reduce((groups, item) => {
        const groupKey = isCatalogItemCompleted(item, { myList, watchHistory }) ? 'completed' : 'planToWatch'
        groups[groupKey].push(item)
        return groups
      }, { completed: [], planToWatch: [] })
    },
    [myList, selectedPerson, watchHistory],
  )
  const isPeopleSearchPending = normalizedQuery.length >= 2
    && (peopleSearch.query !== normalizedQuery || peopleSearch.status === 'loading')
  const shouldSuppressTitleEmptyState = normalizedQuery
    && !selectedPerson
    && results.length === 0
    && (visiblePeople.length > 0 || isPeopleSearchPending || looksLikePersonName(deferredQuery))
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
  const loadMoreResults = useCallback(() => {
    setLazyRenderState((currentState) => {
      const currentCount = currentState.key === resultKey ? currentState.count : RESULT_BATCH_SIZE
      return {
        count: Math.min(currentCount + RESULT_BATCH_SIZE, displayResults.length),
        key: resultKey,
      }
    })
  }, [displayResults.length, resultKey])
  const hydrationItems = useMemo(
    () => {
      const itemsToHydrate = selectedPerson ? displayResults : currentBatchResults
      return itemsToHydrate.filter((item) => !getPosterUrl(item) && !item.tmdb_metadata_resolved)
    },
    [currentBatchResults, displayResults, selectedPerson],
  )
  const hydrationKey = hydrationItems.map(getItemKey).join('|')
  const actorLookupHydrationItems = useMemo(
    () => {
      if (normalizedQuery.length < 2 || !looksLikePersonName(deferredQuery)) return []
      return filteredCatalogItems.filter(needsActorLookupMetadata)
    },
    [deferredQuery, filteredCatalogItems, normalizedQuery],
  )
  const actorLookupHydrationKey = actorLookupHydrationItems.map(getItemKey).join('|')
  const showLoadingShimmer = catalogData.isLoading && !catalogItems.length

  useEffect(() => {
    if (!onSearchCatalog || normalizedQuery.length < 2) return undefined

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setServerSearch({ query: normalizedQuery, results: [], status: 'loading' })
      onSearchCatalog(deferredQuery, { limit: SEARCH_SERVER_RESULT_LIMIT, signal: controller.signal })
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
    if (!authToken || normalizedQuery.length < 2) return undefined

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setPeopleSearch((current) => ({ ...current, query: normalizedQuery, status: 'loading' }))
      searchCatalogPeople({
        authToken,
        catalogItems: filteredCatalogItems,
        selectedPersonId: initialPersonId,
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
    if (!actorLookupHydrationKey || actorLookupHydrationKey === requestedActorLookupHydrationKey.current) return

    requestedActorLookupHydrationKey.current = actorLookupHydrationKey
    onHydrateItems?.(actorLookupHydrationItems)
  }, [actorLookupHydrationItems, actorLookupHydrationKey, onHydrateItems])

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
        loadMoreResults()
      },
      { root: scrollRoot, rootMargin: '280px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreResults, loadMoreResults])

  useEffect(() => {
    const scrollRoot = searchPageRef.current
    if (!scrollRoot || !hasMoreResults) return undefined

    const timeoutId = window.setTimeout(() => {
      const remainingScroll = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight
      const hasScrollableRoom = scrollRoot.scrollHeight > scrollRoot.clientHeight + 80
      if (!hasScrollableRoom || remainingScroll < 520) loadMoreResults()
    }, 120)

    return () => window.clearTimeout(timeoutId)
  }, [hasMoreResults, loadMoreResults, visibleCount])

  function handleQueryChange(nextQuery) {
    setQuery(nextQuery)
    setManualPersonSelection({ id: null, query: '' })
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
              setManualPersonSelection({ id: null, query: '' })
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

        {!showLoadingShimmer && normalizedQuery && visiblePeople.length > 0 && (
          <section className="people-search-section" aria-label="People">
            <div className="people-search-heading">
              <h2>People</h2>
            </div>
            <div className="people-search-list">
              {visiblePeople.map((person) => (
                <button
                  className={`person-search-card ${selectedPersonId === person.id ? 'active' : ''}`}
                  key={person.id}
                  onClick={() => setManualPersonSelection({ id: person.id, query: normalizedQuery })}
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

        {!showLoadingShimmer && selectedPerson && displayResults.length > 0 && (
          <div className="actor-project-sections">
            <ActorProjectSection
              emptyText={`Belum ada proyek ${selectedPerson.name} yang belum ditonton.`}
              isAdmin={isAdmin}
              items={actorProjectGroups.planToWatch}
              myList={myList}
              onOpenCatalogEdit={onOpenCatalogEdit}
              onOpenContextMenu={onOpenContextMenu}
              onOpenDetail={onOpenDetail}
              title="Belum Ditonton"
              watchHistory={watchHistory}
            />
            <ActorProjectSection
              emptyText={`Belum ada proyek ${selectedPerson.name} yang sudah ditonton.`}
              isAdmin={isAdmin}
              items={actorProjectGroups.completed}
              myList={myList}
              onOpenCatalogEdit={onOpenCatalogEdit}
              onOpenContextMenu={onOpenContextMenu}
              onOpenDetail={onOpenDetail}
              title="Sudah Ditonton"
              watchHistory={watchHistory}
            />
          </div>
        )}

        {!showLoadingShimmer && !selectedPerson && displayResults.length > 0 && (
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

function ActorProjectSection({
  emptyText,
  isAdmin,
  items,
  myList,
  onOpenCatalogEdit,
  onOpenContextMenu,
  onOpenDetail,
  title,
  watchHistory,
}) {
  return (
    <section className="actor-project-section" aria-label={title}>
      <div className="actor-project-heading">
        <h2>{title}</h2>
        <strong>{items.length}</strong>
      </div>
      {items.length > 0 ? (
        <div className="search-results-grid actor-project-grid">
          {items.map((item) => (
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
      ) : (
        <div className="actor-project-empty">
          <p>{emptyText}</p>
        </div>
      )}
    </section>
  )
}

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

async function searchCatalogPeople({ authToken, catalogItems, query, selectedPersonId, signal }) {
  const tmdbCatalog = createTmdbCatalogMap(catalogItems)
  if (!tmdbCatalog.hasEntries) return []

  const people = await fetchTmdbPeopleSearch(authToken, query, { pages: PEOPLE_SEARCH_PAGE_LIMIT, signal })
  const selectedPerson = Number(selectedPersonId || 0)
  const candidatePeople = [
    selectedPerson ? { id: selectedPerson, name: query.trim() } : null,
    ...people,
  ]
    .filter((person) => person?.id && person.name)
    .filter((person, index, candidates) => candidates.findIndex((candidate) => candidate?.id === person.id) === index)
    .slice(0, PERSON_CANDIDATE_LIMIT)

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
  const byTmdbId = new Map()
  const byTitle = new Map()

  items.forEach((item) => {
    const tmdbId = Number(item.tmdb_id || item.tmdb_override_id || 0)
    const mediaType = getMediaType(item) === 'movie' ? 'movie' : 'tv'
    if (tmdbId) byTmdbId.set(`${mediaType}:${tmdbId}`, item)

    getCatalogTitleAliases(item).forEach((alias) => {
      const key = `${mediaType}:${alias}`
      const titleMatches = byTitle.get(key) || []
      titleMatches.push(item)
      byTitle.set(key, titleMatches)
    })
  })

  return {
    byTitle,
    byTmdbId,
    hasEntries: byTmdbId.size > 0 || byTitle.size > 0,
  }
}

function getLocalProjectsForPersonCredits(credits, tmdbCatalog) {
  const seen = new Set()
  return [...(credits.cast || []), ...(credits.crew || [])]
    .flatMap((credit) => {
      const mediaType = credit.media_type === 'movie' ? 'movie' : credit.media_type === 'tv' ? 'tv' : ''
      const tmdbId = Number(credit.id || 0)
      const item = mediaType && tmdbId
        ? tmdbCatalog.byTmdbId.get(`${mediaType}:${tmdbId}`) || findCatalogItemByCreditTitle(credit, mediaType, tmdbCatalog)
        : findCatalogItemByCreditTitle(credit, mediaType, tmdbCatalog)
      if (!item) return []
      const key = getItemKey(item)
      if (seen.has(key)) return []
      seen.add(key)
      return [item]
    })
    .sort((first, second) => getRating(second) - getRating(first) || getTitle(first).localeCompare(getTitle(second)))
}

function findCatalogItemByCreditTitle(credit, mediaType, tmdbCatalog) {
  if (!mediaType) return null

  const creditYear = getCreditReleaseYear(credit)
  const matches = getCreditTitleAliases(credit)
    .flatMap((alias) => tmdbCatalog.byTitle.get(`${mediaType}:${alias}`) || [])
  if (!matches.length) return null

  const uniqueMatches = [...new Map(matches.map((item) => [getItemKey(item), item])).values()]
  if (creditYear > 0) {
    const sameYearMatch = uniqueMatches.find((item) => getReleaseYear(item) === creditYear)
    if (sameYearMatch) return sameYearMatch
  }
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null
}

function getCatalogTitleAliases(item) {
  return [...new Set([
    getTitle(item),
    item.tmdb_title,
    item.title,
    item.name,
    item.folder_name,
  ].flatMap((title) => getNormalizedTitleAliases(title)).filter(Boolean))]
}

function getCreditTitleAliases(credit) {
  return [...new Set([
    credit.title,
    credit.name,
    credit.original_title,
    credit.original_name,
  ].flatMap((title) => getNormalizedTitleAliases(title)).filter(Boolean))]
}

function getNormalizedTitleAliases(title) {
  const normalizedTitle = normalizeSearchQuery(title)
  if (!normalizedTitle) return []
  return [
    normalizedTitle,
    normalizedTitle.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim(),
  ].filter(Boolean)
}

function getCreditReleaseYear(credit) {
  const year = Number(String(credit.release_date || credit.first_air_date || '').slice(0, 4))
  return year > 0 ? year : 0
}

function needsActorLookupMetadata(item) {
  return !Number(item.tmdb_id || item.tmdb_override_id || 0) && !item.tmdb_metadata_resolved
}

export default SearchResultsPage
