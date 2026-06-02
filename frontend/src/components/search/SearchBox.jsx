import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import LoadableImage from '../LoadableImage'
import { getGenres, getItemKey, getMediaType, getPosterUrl, getRating, getTitle } from '../../utils/media'
import { mergeSearchResults, normalizeSearchQuery, prepareSearchCatalog, searchCatalog } from '../../utils/search'

const PREVIEW_RESULT_LIMIT = 5

function SearchBox({
  catalogItems,
  defaultQuery = '',
  onHydrateItems,
  onOpenDetail,
  onQueryChange,
  onSearchCatalog,
  onSubmit,
  placeholder = 'Search',
  query: controlledQuery,
  showPreview = true,
  variant = 'compact',
}) {
  const [isFocused, setIsFocused] = useState(false)
  const [internalQuery, setInternalQuery] = useState(defaultQuery)
  const [serverSearch, setServerSearch] = useState({ query: '', results: [], status: 'idle' })
  const requestedHydrationKey = useRef('')
  const isControlled = controlledQuery !== undefined
  const query = isControlled ? controlledQuery : internalQuery
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = normalizeSearchQuery(deferredQuery)
  const searchIndex = useMemo(() => prepareSearchCatalog(catalogItems), [catalogItems])
  const localPreviewResults = useMemo(
    () => searchCatalog(searchIndex, deferredQuery, { limit: PREVIEW_RESULT_LIMIT }),
    [deferredQuery, searchIndex],
  )
  const previewResults = useMemo(
    () => mergeSearchResults(
      localPreviewResults,
      serverSearch.query === normalizedQuery ? serverSearch.results : [],
    ).slice(0, PREVIEW_RESULT_LIMIT),
    [localPreviewResults, normalizedQuery, serverSearch],
  )
  const shouldShowPreview = showPreview && isFocused && normalizedQuery
  const isServerSearchPending = normalizedQuery.length >= 2
    && (serverSearch.query !== normalizedQuery || serverSearch.status === 'loading')
  const hydrationKey = previewResults
    .filter((item) => !getPosterUrl(item) && !item.tmdb_metadata_resolved)
    .map(getItemKey)
    .join('|')

  useEffect(() => {
    if (!showPreview || !onSearchCatalog || normalizedQuery.length < 2) return undefined

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setServerSearch({ query: normalizedQuery, results: [], status: 'loading' })
      onSearchCatalog(deferredQuery, { signal: controller.signal })
        .then((results) => setServerSearch({ query: normalizedQuery, results, status: 'ready' }))
        .catch((error) => {
          if (error.name !== 'AbortError') setServerSearch({ query: normalizedQuery, results: [], status: 'error' })
        })
    }, 90)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [deferredQuery, normalizedQuery, onSearchCatalog, showPreview])

  useEffect(() => {
    if (!hydrationKey || hydrationKey === requestedHydrationKey.current) return
    const timeoutId = window.setTimeout(() => {
      requestedHydrationKey.current = hydrationKey
      onHydrateItems?.(previewResults)
    }, 100)

    return () => window.clearTimeout(timeoutId)
  }, [hydrationKey, onHydrateItems, previewResults])

  function updateQuery(nextQuery) {
    if (!isControlled) setInternalQuery(nextQuery)
    onQueryChange?.(nextQuery)
  }

  function handleSubmit(event) {
    event.preventDefault()
    if (!normalizeSearchQuery(query)) return
    setIsFocused(false)
    onSubmit(query.trim())
  }

  function handleSearchAll() {
    setIsFocused(false)
    onSubmit(query.trim())
  }

  function handleOpenDetail(item) {
    setIsFocused(false)
    onOpenDetail(item)
  }

  return (
    <div
      className={`search-box search-box-${variant}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsFocused(false)
      }}
      onFocus={() => setIsFocused(true)}
    >
      <form className="search-box-form" onSubmit={handleSubmit} role="search">
        <Search aria-hidden="true" size={variant === 'page' ? 22 : 20} />
        <input
          aria-label="Cari film atau series"
          autoComplete="off"
          onChange={(event) => updateQuery(event.target.value)}
          placeholder={placeholder}
          type="search"
          value={query}
        />
        {query && (
          <button aria-label="Hapus pencarian" className="search-clear" onClick={() => updateQuery('')} type="button">
            <X size={16} />
          </button>
        )}
        <span className="search-filter-icon" aria-hidden="true">
          <SlidersHorizontal size={variant === 'page' ? 19 : 17} />
        </span>
      </form>

      {shouldShowPreview && (
        <div className="search-preview" aria-label={`Preview hasil pencarian untuk ${query}`}>
          <div className="search-preview-heading">
            <span>Preview hasil</span>
            <strong>{previewResults.length ? `${previewResults.length} teratas` : isServerSearchPending ? 'Mencari...' : 'Tidak ditemukan'}</strong>
          </div>
          {previewResults.length > 0 ? (
            <div className="search-preview-list">
              {previewResults.map((item) => {
                const poster = getPosterUrl(item)
                const genres = getGenres(item)
                const rating = getRating(item)

                return (
                  <button className="search-preview-card" key={`${getMediaType(item)}-${item.folder_name || getTitle(item)}`} onClick={() => handleOpenDetail(item)} type="button">
                    <span className="search-preview-poster">
                      <LoadableImage alt="" key={poster} src={poster} />
                    </span>
                    <span className="search-preview-copy">
                      <strong>{getTitle(item)}</strong>
                      <span>{getMediaType(item) === 'movie' ? 'Movie' : 'Series'}{genres[0] ? ` / ${genres[0]}` : ''}</span>
                    </span>
                    {rating > 0 && <span className="search-preview-rating">{rating.toFixed(1)}</span>}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="search-preview-empty">{isServerSearchPending ? 'Mencari di katalog...' : 'Tidak ada judul yang cocok di preview.'}</p>
          )}
          <button className="search-preview-all" onClick={handleSearchAll} type="button">
            Cari semua hasil untuk &quot;{query.trim()}&quot;
          </button>
        </div>
      )}
    </div>
  )
}

export default SearchBox
