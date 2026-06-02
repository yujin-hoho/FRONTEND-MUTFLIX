import { ChevronLeft, ChevronRight } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import LoadableImage from '../LoadableImage'
import {
  getItemKey,
  getPosterFallbackUrl,
  getPosterUrl,
  getRating,
  getStillUrl,
  getTitle,
  getWatchProgress,
} from '../../utils/media'

export const CatalogRow = memo(function CatalogRow({ emptyMessage, items, onOpenDetail, ranked = false, title }) {
  const [showAll, setShowAll] = useState(false)

  if (!items.length) return emptyMessage ? <p className="empty-catalog">{emptyMessage}</p> : null

  return (
    <section className="catalog-row" aria-label={title}>
      <div className="catalog-row-heading">
        <h2>{title}</h2>
        <button onClick={() => setShowAll((isOpen) => !isOpen)} type="button">
          {showAll ? 'Show less' : 'See more'}
        </button>
      </div>
      <DraggableScroller className={`catalog-scroller ${ranked ? 'ranked-scroller' : ''}`}>
        {(showAll ? items : items.slice(0, 15)).map((item, index) => (
          <CatalogCard item={item} key={getItemKey(item)} onOpenDetail={onOpenDetail} rank={ranked ? index + 1 : null} />
        ))}
      </DraggableScroller>
    </section>
  )
})

const CatalogCard = memo(function CatalogCard({ item, onOpenDetail, rank }) {
  const poster = getPosterUrl(item)
  const rating = getRating(item)
  const title = getTitle(item)

  return (
    <button className={`catalog-card ${rank ? 'ranked-card' : ''}`} onClick={() => onOpenDetail(item)} type="button">
      {rank && <span className="ranked-number">{rank}</span>}
      <div className={rank ? 'ranked-frame' : 'poster-frame'}>
        {rating > 0 && <span className="rating-badge">{rating.toFixed(1)}</span>}
        <LoadableImage alt={title} fallbackSrc={getPosterFallbackUrl(item)} key={poster} src={poster} />
      </div>
      <h3>{title}</h3>
    </button>
  )
})

export const HistoryRow = memo(function HistoryRow({ items, onPlay }) {
  const [showAll, setShowAll] = useState(false)

  if (!items.length) return null

  return (
    <section className="catalog-row" aria-label="Continue watching">
      <div className="catalog-row-heading">
        <h2>Continue Watching</h2>
        <button onClick={() => setShowAll((isOpen) => !isOpen)} type="button">
          {showAll ? 'Show less' : 'See more'}
        </button>
      </div>
      <DraggableScroller className="catalog-scroller history-scroller" variant="history">
        {(showAll ? items : items.slice(0, 15)).map((item) => (
          <button className="catalog-card history-card" key={item.media_path} onClick={() => onPlay(item)} type="button">
            <div className="history-frame">
              <LoadableImage alt={item.media_title || item.series_title || 'Continue watching'} fallbackSrc={getPosterFallbackUrl(item)} key={getStillUrl(item)} src={getStillUrl(item)} />
              <span className="history-progress-label">{Math.round(getWatchProgress(item))}%</span>
              <span className="history-progress-track">
                <span style={{ width: `${getWatchProgress(item)}%` }} />
              </span>
            </div>
            <h3>{item.media_title || item.series_title || 'Continue Watching'}</h3>
          </button>
        ))}
      </DraggableScroller>
    </section>
  )
})

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
      <div className={className} onScroll={updateArrowVisibility} ref={scrollerRef}>
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
