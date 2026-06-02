import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import SearchBox from '../components/search/SearchBox'
import LoadableImage from '../components/LoadableImage'
import { getGenres, getItemKey, getMediaType, getPosterFallbackUrl, getPosterUrl, getRating, getTitle } from '../utils/media'
import { mergeSearchResults, normalizeSearchQuery, prepareSearchCatalog, searchCatalog } from '../utils/search'

function SearchResultsPage({ catalogData, initialQuery, onBack, onHydrateItems, onOpenDetail, onQueryChange, onSearchCatalog }) {
  const [query, setQuery] = useState(initialQuery)
  const [serverSearch, setServerSearch] = useState({ query: '', results: [] })
  const requestedHydrationKey = useRef('')
  const deferredQuery = useDeferredValue(query)
  const catalogItems = useMemo(() => [...catalogData.movies, ...catalogData.series], [catalogData.movies, catalogData.series])
  const searchIndex = useMemo(() => prepareSearchCatalog(catalogItems), [catalogItems])
  const localResults = useMemo(() => searchCatalog(searchIndex, deferredQuery), [deferredQuery, searchIndex])
  const normalizedQuery = normalizeSearchQuery(deferredQuery)
  const results = useMemo(
    () => mergeSearchResults(localResults, serverSearch.query === normalizedQuery ? serverSearch.results : []),
    [localResults, normalizedQuery, serverSearch],
  )
  const hydrationItems = useMemo(
    () => results.slice(0, 24).filter((item) => !getPosterUrl(item) && !item.tmdb_metadata_resolved),
    [results],
  )
  const hydrationKey = hydrationItems.map(getItemKey).join('|')

  useEffect(() => {
    if (!onSearchCatalog || normalizedQuery.length < 2) return undefined

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      onSearchCatalog(deferredQuery, { signal: controller.signal })
        .then((results) => setServerSearch({ query: normalizedQuery, results }))
        .catch(() => {})
    }, 180)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [deferredQuery, normalizedQuery, onSearchCatalog])

  useEffect(() => {
    if (!normalizedQuery || !hydrationKey || hydrationKey === requestedHydrationKey.current) return

    const timeoutId = window.setTimeout(() => {
      requestedHydrationKey.current = hydrationKey
      onHydrateItems?.(hydrationItems)
    }, 350)

    return () => window.clearTimeout(timeoutId)
  }, [hydrationItems, hydrationKey, normalizedQuery, onHydrateItems])

  function handleQueryChange(nextQuery) {
    setQuery(nextQuery)
  }

  return (
    <main className="search-page">
      <header className="search-page-header">
        <button aria-label="Kembali ke dashboard" className="search-back" onClick={onBack} type="button">
          <ArrowLeft size={22} />
        </button>
        <a className="brand-mark search-brand" href="/dashboard" aria-label="Mutflix dashboard">
          MUTFLIX
        </a>
        <SearchBox
          catalogItems={catalogItems}
          defaultQuery={initialQuery}
          onHydrateItems={onHydrateItems}
          onOpenDetail={onOpenDetail}
          onQueryChange={handleQueryChange}
          onSearchCatalog={onSearchCatalog}
          onSubmit={(nextQuery) => {
            setQuery(nextQuery)
            onQueryChange(nextQuery)
          }}
          placeholder="Cari film, series, atau genre"
          query={query}
          showPreview={false}
          variant="page"
        />
      </header>

      <section className="search-results-shell" aria-live="polite">
        <div className="search-results-heading">
          <p>Search</p>
          <h1>{normalizedQuery ? `Hasil untuk "${deferredQuery.trim()}"` : 'Cari tontonan kamu'}</h1>
          <span>{normalizedQuery ? `${results.length} judul ditemukan` : 'Ketik keyword untuk menampilkan hasil.'}</span>
        </div>

        {!normalizedQuery && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Mulai ketik judul atau genre di kolom pencarian.</p>
          </div>
        )}

        {normalizedQuery && results.length === 0 && (
          <div className="search-empty-state">
            <Search size={30} />
            <p>Tidak ada hasil yang cocok untuk &quot;{deferredQuery.trim()}&quot;.</p>
          </div>
        )}

        {results.length > 0 && (
          <div className="search-results-grid">
            {results.map((item) => {
              const poster = getPosterUrl(item)
              const rating = getRating(item)
              const genres = getGenres(item)

              return (
                <button className="search-result-card" key={getItemKey(item)} onClick={() => onOpenDetail(item)} type="button">
                  <span className="search-result-poster">
                    <LoadableImage alt={getTitle(item)} fallbackSrc={getPosterFallbackUrl(item)} key={poster} src={poster} />
                    {rating > 0 && <span className="rating-badge">{rating.toFixed(1)}</span>}
                  </span>
                  <span className="search-result-copy">
                    <strong>{getTitle(item)}</strong>
                    <span>{getMediaType(item) === 'movie' ? 'Movie' : 'Series'}{genres[0] ? ` / ${genres[0]}` : ''}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}

export default SearchResultsPage
