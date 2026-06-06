import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BadgeInfo, Check, Clapperboard, RefreshCw, Search } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import { fetchResolvedTmdbMetadata, fetchTmdbOverride, fetchTmdbSearchResults, saveTmdbOverride } from '../services/api'
import {
  getDetailArtworkUrl,
  getGenres,
  getItemPath,
  getMediaType,
  getPosterFallbackUrl,
  getRating,
  getTmdbImageUrl,
  getTitle,
} from '../utils/media'

function AdminCatalogEditPage({ authToken, item, onBack, onOverrideSaved }) {
  const [currentMeta, setCurrentMeta] = useState(null)
  const displayItem = useMemo(() => mergeTmdbMetaIntoItem(item, currentMeta), [currentMeta, item])
  const title = getTitle(displayItem)
  const mediaType = getMediaType(displayItem)
  const tmdbMediaType = mediaType === 'movie' ? 'movie' : 'tv'
  const genres = getGenres(displayItem)
  const backdrop = getDetailArtworkUrl(displayItem)
  const fallback = getPosterFallbackUrl(displayItem)
  const ratingPercent = Math.round(getRating(displayItem) * 10)
  const folderName = getItemPath(item) || getTitle(item)
  const initialQuery = useMemo(() => cleanSearchQuery(getTitle(item) || folderName), [folderName, item])
  const [query, setQuery] = useState(initialQuery)
  const [searchType, setSearchType] = useState(tmdbMediaType)
  const [results, setResults] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [isSearching, setIsSearching] = useState(Boolean(initialQuery))
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    if (!folderName) return undefined

    const controller = new AbortController()

    let activeOverride = null

    fetchTmdbOverride(authToken, folderName)
      .then((override) => {
        activeOverride = override
        const overrideType = override?.media_type === 'movie' ? 'movie' : override?.media_type === 'tv' ? 'tv' : tmdbMediaType
        if (override?.tmdb_query) setQuery(override.tmdb_query)
        if (override?.tmdb_id) setSelectedId(Number(override.tmdb_id))
        setSearchType(overrideType)
        return fetchResolvedTmdbMetadata(authToken, {
          folderName,
          mediaType: overrideType,
          signal: controller.signal,
        })
      })
      .then((metadata) => {
        setCurrentMeta(metadata)
        if (metadata?.id) setSelectedId(Number(metadata.id))
        if (activeOverride && metadata?.id && Number(item.tmdb_id || 0) !== Number(metadata.id)) {
          onOverrideSaved?.(item, metadata, activeOverride.media_type === 'movie' ? 'movie' : 'tv')
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setCurrentMeta(null)
      })

    return () => controller.abort()
  }, [authToken, folderName, item, onOverrideSaved, tmdbMediaType])

  useEffect(() => {
    if (!query.trim()) return undefined

    const controller = new AbortController()

    fetchTmdbSearchResults(authToken, {
      mediaType: searchType,
      query,
      signal: controller.signal,
    })
      .then((nextResults) => {
        setResults(nextResults)
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setResults([])
          setMessage({ type: 'error', text: error.message })
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsSearching(false)
      })

    return () => controller.abort()
  }, [authToken, query, searchType])

  async function handleUseResult(result) {
    const resultTitle = getTmdbResultTitle(result)
    if (!folderName || !resultTitle || isSaving) return

    setIsSaving(true)
    setSelectedId(result.id)
    setMessage(null)

    try {
      await saveTmdbOverride(authToken, {
        folder_name: folderName,
        tmdb_id: result.id,
        tmdb_query: resultTitle,
        media_type: searchType,
        override_year: getTmdbResultYear(result),
      })
      setCurrentMeta(result)
      onOverrideSaved?.(item, result, searchType)
      setMessage({ type: 'success', text: 'TMDB data selected. Catalog cards updated.' })
    } catch (error) {
      setMessage({ type: 'error', text: error.message })
    } finally {
      setIsSaving(false)
    }
  }

  function handleQueryChange(event) {
    const nextQuery = event.target.value
    setQuery(nextQuery)
    setMessage(null)
    setIsSearching(Boolean(nextQuery.trim()))
    setSelectedId(null)
    if (!nextQuery.trim()) {
      setResults([])
      setSelectedId(null)
    }
  }

  function handleSearchTypeChange(nextSearchType) {
    setSearchType(nextSearchType)
    setMessage(null)
    if (query.trim()) setIsSearching(true)
  }

  return (
    <main className="admin-edit-page">
      <nav className="admin-edit-topbar" aria-label="Catalog edit">
        <button className="admin-edit-back" onClick={onBack} type="button">
          <ArrowLeft size={18} strokeWidth={2.8} />
          <span>Back</span>
        </button>
        <div className="admin-edit-actions">
          <span className="admin-edit-status">{isSearching ? 'Searching TMDB...' : `${results.length} results`}</span>
        </div>
      </nav>

      <section className="admin-edit-hero">
        <LoadableImage className="admin-edit-backdrop" fallbackSrc={fallback} key={`${backdrop}-${fallback}`} loading="eager" src={backdrop} />
        <div className="admin-edit-shade" />
        <div className="admin-edit-copy">
          <p className="admin-edit-kicker">{mediaType === 'movie' ? 'Movie' : 'Series'} editor</p>
          <h1>{title}</h1>
          <div className="admin-edit-meta">
            {ratingPercent > 0 && <span>{ratingPercent}%</span>}
            {genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
        </div>
      </section>

      <section className="admin-edit-body">
        <div className="admin-edit-panel">
          <div className="admin-edit-panel-heading">
            <BadgeInfo size={20} />
            <h2>Catalog data</h2>
          </div>
          <dl className="admin-edit-fields">
            <div>
              <dt>Title</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>Folder path</dt>
              <dd>{getItemPath(item) || '-'}</dd>
            </div>
            <div>
              <dt>Media type</dt>
              <dd>{searchType === 'movie' ? 'movie' : 'series'}</dd>
            </div>
          </dl>
        </div>

        <div className="admin-edit-panel">
          <div className="admin-edit-panel-heading">
            <Clapperboard size={20} />
            <h2>TMDB match</h2>
          </div>
          <form className="admin-edit-search" onSubmit={(event) => event.preventDefault()}>
            <label>
              <Search size={17} />
              <input
                onChange={handleQueryChange}
                placeholder="Search TMDB title"
                type="search"
                value={query}
              />
            </label>
            <div className="admin-edit-type-toggle" aria-label="TMDB media type">
              <button className={searchType === 'tv' ? 'active' : ''} onClick={() => handleSearchTypeChange('tv')} type="button">Series</button>
              <button className={searchType === 'movie' ? 'active' : ''} onClick={() => handleSearchTypeChange('movie')} type="button">Movie</button>
            </div>
          </form>
          {message && <p className={`admin-edit-message ${message.type}`}>{message.text}</p>}
        </div>
      </section>

      <section className="admin-edit-results" aria-label="TMDB search results">
        {isSearching && (
          <div className="admin-edit-loading">
            <RefreshCw className="spinner" size={20} />
            <span>Fetching TMDB data...</span>
          </div>
        )}
        {!isSearching && !results.length && (
          <p className="admin-edit-muted">No TMDB results found for this title.</p>
        )}
        {results.map((result) => {
          const resultTitle = getTmdbResultTitle(result)
          const year = getTmdbResultYear(result)
          const resultRating = Math.round(Number(result.vote_average || 0) * 10)
          const poster = getTmdbImageUrl(result.poster_path, 'w342')
          const resultFallback = getPosterFallbackUrl({ name: resultTitle })
          const isSelected = selectedId === result.id

          return (
            <article className="tmdb-result-card" key={`${searchType}-${result.id}`}>
              <div className="tmdb-result-poster">
                <LoadableImage alt={resultTitle} fallbackSrc={resultFallback} key={poster} src={poster} />
              </div>
              <div className="tmdb-result-copy">
                <div className="tmdb-result-title-row">
                  <h3>{resultTitle}</h3>
                  {year && <span>{year}</span>}
                </div>
                <div className="tmdb-result-meta">
                  <span>{searchType === 'movie' ? 'Movie' : 'Series'}</span>
                  {resultRating > 0 && <span>{resultRating}%</span>}
                  {result.original_language && <span>{String(result.original_language).toUpperCase()}</span>}
                </div>
                <p>{result.overview || 'No overview from TMDB.'}</p>
              </div>
              <button className="tmdb-result-use" disabled={isSaving && isSelected} onClick={() => handleUseResult(result)} type="button">
                {isSelected && isSaving ? <RefreshCw className="spinner" size={17} /> : isSelected && message?.type === 'success' ? <Check size={17} /> : <Check size={17} />}
                <span>{isSelected && message?.type === 'success' ? 'Selected' : 'Use this'}</span>
              </button>
            </article>
          )
        })}
      </section>
    </main>
  )
}

function cleanSearchQuery(value) {
  return String(value || '')
    .replace(/\(\d{4}\)/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTmdbResultTitle(result) {
  return result.title || result.name || result.original_title || result.original_name || ''
}

function getTmdbResultYear(result) {
  const date = result.release_date || result.first_air_date || ''
  const year = Number(String(date).slice(0, 4))
  return year > 0 ? year : null
}

function mergeTmdbMetaIntoItem(item, meta) {
  if (!meta) return item

  return {
    ...item,
    tmdb_backdrop_path: meta.backdrop_path || item.tmdb_backdrop_path,
    tmdb_genres: Array.isArray(meta.genres) && meta.genres.length ? meta.genres : item.tmdb_genres,
    tmdb_id: meta.id || item.tmdb_id,
    tmdb_metadata_resolved: true,
    tmdb_original_language: meta.original_language || item.tmdb_original_language,
    tmdb_overview: meta.overview || item.tmdb_overview,
    tmdb_poster_path: meta.poster_path || item.tmdb_poster_path,
    tmdb_rating: Number(meta.vote_average || item.tmdb_rating || 0),
    tmdb_title: getTmdbResultTitle(meta) || item.tmdb_title,
  }
}

export default AdminCatalogEditPage
