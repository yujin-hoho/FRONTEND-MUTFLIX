import { ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import LoadableImage from '../LoadableImage'
import {
  getDetailArtworkUrl,
  getItemKey,
  getEpisodeHistoryLabel,
  getPosterFallbackUrl,
  getPosterUrl,
  getRating,
  getServerBackdropUrl,
  getServerStillUrl,
  getTitle,
  getWatchProgress,
} from '../../utils/media'

export const CatalogRow = memo(function CatalogRow({ emptyMessage, isAdmin = false, items, layout = 'vertical', onOpenCatalogAll, onOpenContextMenu, onOpenDetail, onOpenEdit, ranked = false, rowIndex = 0, title }) {
  const [showAll, setShowAll] = useState(false)

  if (!items.length) return emptyMessage ? <p className="empty-catalog">{emptyMessage}</p> : null
  const visibleItems = showAll ? items : items.slice(0, 15)
  const isHorizontal = layout === 'horizontal'

  return (
    <section className={`catalog-row ${isHorizontal ? 'catalog-row-horizontal' : ''}`} aria-label={title}>
      <div className="catalog-row-heading">
        <h2>{title}</h2>
        <button onClick={() => (onOpenCatalogAll ? onOpenCatalogAll() : setShowAll((isOpen) => !isOpen))} type="button">
          {onOpenCatalogAll ? 'See more' : showAll ? 'Show less' : 'See more'}
        </button>
      </div>
      <DraggableScroller className={`catalog-scroller ${isHorizontal ? 'horizontal-scroller' : ''} ${ranked ? 'ranked-scroller' : ''}`} variant={isHorizontal ? 'horizontal' : ''}>
        {visibleItems.map((item, index) => (
          <CatalogCard
            horizontal={isHorizontal}
            isAdmin={isAdmin}
            isPriority={rowIndex < 2 && index < 6}
            item={item}
            key={getItemKey(item)}
            onOpenContextMenu={onOpenContextMenu}
            onOpenDetail={onOpenDetail}
            onOpenEdit={onOpenEdit}
            rank={ranked ? index + 1 : null}
          />
        ))}
      </DraggableScroller>
    </section>
  )
})

const CatalogCard = memo(function CatalogCard({ horizontal = false, isAdmin = false, isPriority = false, item, onOpenContextMenu, onOpenDetail, onOpenEdit, rank }) {
  const artwork = horizontal ? getDetailArtworkUrl(item) : getPosterUrl(item)
  const rating = getRating(item)
  const title = getTitle(item)

  return (
    <article
      className={`catalog-card ${horizontal ? 'horizontal-card' : ''} ${rank ? 'ranked-card' : ''}`}
      onContextMenu={(event) => onOpenContextMenu?.(event, { item })}
    >
      <button className="catalog-card-surface" onClick={() => onOpenDetail(item)} type="button">
        {rank && <span className="ranked-number">{rank}</span>}
        <div className={horizontal ? 'horizontal-frame' : rank ? 'ranked-frame' : 'poster-frame'}>
          {rating > 0 && (
            <span
              aria-label={`Rating ${Math.round(rating * 10)} percent`}
              className="rating-badge rating-pie"
              style={{ '--rating-percent': `${Math.min(100, Math.max(0, rating * 10))}%` }}
            >
              {Math.round(rating * 10)}%
            </span>
          )}
          <LoadableImage
            alt={title}
            fallbackSrc={getPosterFallbackUrl(item)}
            fetchPriority={isPriority ? 'high' : 'auto'}
            key={artwork}
            loading={isPriority ? 'eager' : 'lazy'}
            src={artwork}
          />
        </div>
        <h3>{title}</h3>
      </button>
      {isAdmin && (
        <button
          aria-label={`Edit ${title}`}
          className="catalog-edit-button"
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

export const HistoryRow = memo(function HistoryRow({ catalogItems = [], items, onHide, onOpenContextMenu, onPlay }) {
  if (!items.length) return null
  const visibleItems = items.slice(0, 15)

  return (
    <section className="catalog-row" aria-label="Continue watching">
      <div className="catalog-row-heading">
        <h2>Continue Watching</h2>
      </div>
      <DraggableScroller className="catalog-scroller history-scroller" variant="history">
        {visibleItems.map((item, index) => {
          const stillUrl = getServerStillUrl(item)
          const catalogItem = findCatalogItemForHistory(item, catalogItems)
          const fallbackUrl = getServerBackdropUrl(catalogItem || item, 'w500')
          return (
            <article className="catalog-card history-card" key={item.media_path} onContextMenu={(event) => onOpenContextMenu?.(event, { historyEntry: item })}>
              <button className="history-play-surface" onClick={() => onPlay(item)} type="button">
                <div className="history-frame">
                  <LoadableImage
                    alt={item.media_title || item.series_title || 'Continue watching'}
                    fallbackSrc={fallbackUrl === stillUrl ? '' : fallbackUrl}
                    fetchPriority={index < 6 ? 'high' : 'auto'}
                    key={`${stillUrl}-${fallbackUrl}`}
                    loading={index < 6 ? 'eager' : 'lazy'}
                    showFallbackWhileLoading
                    shimmerOnError={false}
                    src={stillUrl}
                  />
                  <span className="history-progress-label">{Math.round(getWatchProgress(item))}%</span>
                  <span className="history-progress-track">
                    <span style={{ width: `${getWatchProgress(item)}%` }} />
                  </span>
                </div>
                <h3>{getEpisodeHistoryLabel(item)}</h3>
              </button>
              {onHide && (
                <button
                  aria-label="Remove from Continue Watching"
                  className="history-hide-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onHide(item)
                  }}
                  title="Remove from Continue Watching"
                  type="button"
                >
                  <X size={16} strokeWidth={3} />
                </button>
              )}
            </article>
          )
        })}
      </DraggableScroller>
    </section>
  )
})

function findCatalogItemForHistory(historyItem, catalogItems) {
  const candidates = [historyItem.series_path, historyItem.series_title, historyItem.media_title, historyItem.source]
    .map(normalizeHistoryTitle)
    .filter(Boolean)
  if (!candidates.length) return null

  return catalogItems.find((item) => {
    const aliases = [item.folder_name, item.name, getTitle(item), item.source].map(normalizeHistoryTitle)
    return candidates.some((candidate) => aliases.includes(candidate))
  }) || null
}

function normalizeHistoryTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function DraggableScroller({ children, className, variant = '' }) {
  const scrollerRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateArrowVisibility = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    setCanScrollLeft(scroller.scrollLeft > 1)
    setCanScrollRight(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return undefined

    updateArrowVisibility()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateArrowVisibility)
      return () => window.removeEventListener('resize', updateArrowVisibility)
    }

    const resizeObserver = new ResizeObserver(updateArrowVisibility)
    resizeObserver.observe(scroller)
    return () => resizeObserver.disconnect()
  }, [children, updateArrowVisibility])

  function scrollRow(direction) {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollBy({
      behavior: 'smooth',
      left: direction * Math.max(240, scroller.clientWidth * 0.82),
    })
  }

  return (
    <div className={`catalog-scroller-shell ${variant ? `catalog-scroller-shell-${variant}` : ''}`}>
      {canScrollLeft && (
        <button aria-label="Scroll row left" className="catalog-scroll-button catalog-scroll-button-left" onClick={() => scrollRow(-1)} type="button">
          <ChevronLeft size={42} strokeWidth={4} />
        </button>
      )}
      <div
        className={className}
        onScroll={updateArrowVisibility}
        ref={scrollerRef}
      >
        {children}
      </div>
      {canScrollRight && (
        <button aria-label="Scroll row right" className="catalog-scroll-button catalog-scroll-button-right" onClick={() => scrollRow(1)} type="button">
          <ChevronRight size={42} strokeWidth={4} />
        </button>
      )}
    </div>
  )
}
