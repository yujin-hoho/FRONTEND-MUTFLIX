import { memo, useState } from 'react'
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
      <div className={`catalog-scroller ${ranked ? 'ranked-scroller' : ''}`}>
        {(showAll ? items : items.slice(0, 15)).map((item, index) => (
          <CatalogCard item={item} key={getItemKey(item)} onOpenDetail={onOpenDetail} rank={ranked ? index + 1 : null} />
        ))}
      </div>
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
      <div className="catalog-scroller history-scroller">
        {(showAll ? items : items.slice(0, 15)).map((item) => (
          <button className="catalog-card history-card" key={item.media_path} onClick={() => onPlay(item)} type="button">
            <div className="history-frame">
              <LoadableImage alt={item.media_title || item.series_title || 'Continue watching'} key={getStillUrl(item)} src={getStillUrl(item)} />
              <span className="history-progress-label">{Math.round(getWatchProgress(item))}%</span>
              <span className="history-progress-track">
                <span style={{ width: `${getWatchProgress(item)}%` }} />
              </span>
            </div>
            <h3>{item.media_title || item.series_title || 'Continue Watching'}</h3>
          </button>
        ))}
      </div>
    </section>
  )
})
