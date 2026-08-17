import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BadgeInfo, Check, Image as ImageIcon, RefreshCw, RotateCcw, Sparkles } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import { fetchServerItemPosters } from '../services/api'
import {
  getDetailArtworkUrl,
  getGenres,
  getItemPath,
  getLocalPosterOverride,
  getMediaType,
  getPosterFallbackUrl,
  getPosterUrl,
  getRating,
  getTitle,
  removeLocalPosterOverride,
  resolveServerMediaUrl,
  setLocalPosterOverride,
} from '../utils/media'

function AdminCatalogEditPage({ authToken, item, onBack, onOverrideSaved }) {
  const title = getTitle(item)
  const mediaType = getMediaType(item)
  const genres = getGenres(item)
  const backdrop = getDetailArtworkUrl(item)
  const fallback = getPosterFallbackUrl(item)
  const ratingPercent = Math.round(getRating(item) * 10)
  const folderPath = getItemPath(item) || title

  const [localSelectedPoster, setLocalSelectedPoster] = useState(() => getLocalPosterOverride(item))
  const [serverPosters, setServerPosters] = useState(() => getInitialPosters(item))
  const [isLoadingPosters, setIsLoadingPosters] = useState(true)
  const [message, setMessage] = useState(null)

  // Fetch all posters available on server (Local filesystem + GDrive)
  useEffect(() => {
    const controller = new AbortController()
    setIsLoadingPosters(true)

    fetchServerItemPosters(authToken, item, { signal: controller.signal })
      .then((fetchedPosters) => {
        const merged = mergeUniquePosters(getInitialPosters(item), fetchedPosters)
        setServerPosters(merged)
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          console.warn('[POSTER-PICKER] Fetch server posters failed:', error)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoadingPosters(false)
        }
      })

    return () => controller.abort()
  }, [authToken, item])

  // Sync active local selection with instant resized URL
  const currentActivePosterUrl = useMemo(() => {
    const raw = localSelectedPoster || getPosterUrl(item)
    return resolveServerMediaUrl(raw, 'w342')
  }, [item, localSelectedPoster])

  function handleSelectPoster(posterUrl) {
    if (!posterUrl) return
    setLocalPosterOverride(item, posterUrl)
    setLocalSelectedPoster(posterUrl)
    setMessage({ type: 'success', text: 'Poster lokal berhasil dipilih.' })
    onOverrideSaved?.(item, posterUrl)
  }

  function handleResetToDefault() {
    removeLocalPosterOverride(item)
    setLocalSelectedPoster('')
    setMessage({ type: 'success', text: 'Pilihan poster telah di-reset ke default server.' })
    onOverrideSaved?.(item, null)
  }

  return (
    <main className="admin-edit-page">
      <nav className="admin-edit-topbar" aria-label="Poster selection">
        <button className="admin-edit-back" onClick={onBack} type="button">
          <ArrowLeft size={18} strokeWidth={2.8} />
          <span>Kembali</span>
        </button>
        <div className="admin-edit-actions">
          {localSelectedPoster && (
            <button className="admin-edit-reset-btn" onClick={handleResetToDefault} type="button">
              <RotateCcw size={15} />
              <span>Reset ke Default</span>
            </button>
          )}
          <span className="admin-edit-status">
            {isLoadingPosters ? 'Memuat poster server...' : `${serverPosters.length} poster tersedia`}
          </span>
        </div>
      </nav>

      <section className="admin-edit-hero">
        <LoadableImage className="admin-edit-backdrop" fallbackSrc={fallback} loading="eager" src={backdrop} />
        <div className="admin-edit-shade" />
        <div className="admin-edit-copy">
          <p className="admin-edit-kicker">{mediaType === 'movie' ? 'Film' : 'Serial'} &bull; Pilih Poster Server</p>
          <h1>{title}</h1>
          <div className="admin-edit-meta">
            {ratingPercent > 0 && <span>{ratingPercent}%</span>}
            {genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
            {localSelectedPoster && (
              <span className="admin-edit-custom-badge">
                <Sparkles size={13} />
                Poster Kustom Aktif
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="admin-edit-body">
        <div className="admin-edit-panel">
          <div className="admin-edit-panel-heading">
            <BadgeInfo size={20} />
            <h2>Informasi Media</h2>
          </div>
          <dl className="admin-edit-fields">
            <div>
              <dt>Judul</dt>
              <dd>{title}</dd>
            </div>
            <div>
              <dt>Folder Path</dt>
              <dd>{folderPath}</dd>
            </div>
            <div>
              <dt>Tipe Media</dt>
              <dd>{mediaType === 'movie' ? 'Movie (Film)' : 'Series (Serial)'}</dd>
            </div>
            <div>
              <dt>Penyimpanan Pilihan</dt>
              <dd>Tersimpan secara lokal di browser (LocalStorage)</dd>
            </div>
          </dl>
        </div>

        <div className="admin-edit-panel">
          <div className="admin-edit-panel-heading">
            <ImageIcon size={20} />
            <h2>Poster Aktif Saat Ini</h2>
          </div>
          <div className="admin-edit-current-preview">
            <div className="admin-edit-current-poster-box">
              <LoadableImage
                alt={title}
                fallbackSrc={fallback}
                loading="eager"
                src={currentActivePosterUrl}
              />
            </div>
            <div className="admin-edit-current-details">
              <p className="admin-edit-current-status">
                {localSelectedPoster ? 'Menggunakan poster kustom lokal' : 'Menggunakan rotasi / poster server default'}
              </p>
              {localSelectedPoster && (
                <button className="admin-edit-reset-btn" onClick={handleResetToDefault} type="button">
                  <RotateCcw size={14} />
                  <span>Kembalikan ke Rotasi Default</span>
                </button>
              )}
            </div>
          </div>
          {message && <p className={`admin-edit-message ${message.type}`}>{message.text}</p>}
        </div>
      </section>

      <section className="admin-edit-poster-section" aria-label="Daftar Poster Server">
        <div className="admin-edit-section-header">
          <h2>Semua Poster di Server ({serverPosters.length})</h2>
          <p>Klik salah satu poster di bawah untuk menyimpannya sebagai poster favorit Anda.</p>
        </div>

        {isLoadingPosters && !serverPosters.length && (
          <div className="admin-edit-loading">
            <RefreshCw className="spinner" size={20} />
            <span>Mengambil daftar poster dari server...</span>
          </div>
        )}

        {!isLoadingPosters && !serverPosters.length && (
          <p className="admin-edit-muted">Tidak ditemukan file poster di server untuk item ini.</p>
        )}

        <div className="admin-edit-poster-grid">
          {serverPosters.map((poster, index) => {
            const rawUrl = typeof poster === 'string' ? poster : poster.url
            const optimizedPreviewUrl = resolveServerMediaUrl(rawUrl, 'w342')
            const isLocalActive = localSelectedPoster ? isSamePoster(localSelectedPoster, rawUrl) : false
            const isCurrentDefault = !localSelectedPoster && isSamePoster(getPosterUrl(item), rawUrl)
            const isSelected = isLocalActive || isCurrentDefault
            const sourceLabel = getPosterSourceLabel(poster)

            return (
              <article
                className={`admin-poster-card ${isSelected ? 'selected' : ''} ${isLocalActive ? 'local-active' : ''}`}
                key={rawUrl || index}
                onClick={() => handleSelectPoster(rawUrl)}
              >
                <div className="admin-poster-thumbnail">
                  <LoadableImage
                    alt={`${title} poster ${index + 1}`}
                    fallbackSrc={fallback}
                    key={optimizedPreviewUrl}
                    src={optimizedPreviewUrl}
                  />
                  {isSelected && (
                    <div className="admin-poster-active-overlay">
                      <span className="admin-poster-check-badge">
                        <Check size={16} strokeWidth={3} />
                        {isLocalActive ? 'Pilihan Anda' : 'Aktif'}
                      </span>
                    </div>
                  )}
                </div>
                <div className="admin-poster-info">
                  <div className="admin-poster-tag-row">
                    <span className="admin-poster-source-tag">{sourceLabel}</span>
                    <span className="admin-poster-index-tag">#{index + 1}</span>
                  </div>
                  <button
                    className={`admin-poster-select-btn ${isSelected ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleSelectPoster(rawUrl)
                    }}
                    type="button"
                  >
                    {isSelected ? <Check size={15} strokeWidth={2.8} /> : null}
                    <span>{isLocalActive ? 'Tersimpan Lokal' : isSelected ? 'Sedang Aktif' : 'Pilih Poster'}</span>
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function getInitialPosters(item) {
  const posters = []
  const seen = new Set()

  const add = (url, source = 'server') => {
    if (!url) return
    const clean = String(url).trim()
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    posters.push({ url: clean, source })
  }

  if (Array.isArray(item?.all_poster_urls)) {
    item.all_poster_urls.forEach((u) => add(u, 'gdrive'))
  }
  if (item?.poster_url) add(item.poster_url, 'gdrive')
  if (item?.poster_file_id) add(`/api/gdrive-poster/${item.poster_file_id}`, 'gdrive')
  if (item?.display_poster) add(item.display_poster, 'server')
  if (item?.primary_poster_url) add(item.primary_poster_url, 'local')

  return posters
}

function mergeUniquePosters(initial, fetched) {
  const seen = new Set()
  const result = []

  const add = (p) => {
    if (!p) return
    const url = typeof p === 'string' ? p : p.url
    if (!url) return
    const clean = String(url).trim()
    if (seen.has(clean)) return
    seen.add(clean)
    result.push(typeof p === 'object' ? p : { url: clean, source: 'server' })
  }

  initial.forEach(add)
  if (Array.isArray(fetched)) {
    fetched.forEach(add)
  }
  return result
}

function getPosterSourceLabel(poster) {
  const url = typeof poster === 'string' ? poster : poster?.url || ''
  const source = typeof poster === 'object' ? poster?.source : ''
  if (source === 'gdrive' || url.includes('gdrive-poster')) return 'Google Drive'
  if (source === 'local' || url.includes('/posters/')) return 'Server Local'
  return 'Server'
}

function isSamePoster(urlA, urlB) {
  if (!urlA || !urlB) return false
  const cleanA = String(urlA).split('?')[0].trim()
  const cleanB = String(urlB).split('?')[0].trim()
  return cleanA === cleanB
}

export default AdminCatalogEditPage
