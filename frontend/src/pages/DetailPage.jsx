import { useState } from 'react'
import { ChevronDown, ChevronUp, Play } from 'lucide-react'
import { EPISODES_PER_PAGE } from '../config'
import LoadableImage from '../components/LoadableImage'
import CreditsPanel from '../components/detail/CreditsPanel'
import {
  formatDuration,
  getDetailArtworkUrl,
  getGenres,
  getMediaType,
  getRating,
  getStillUrl,
  getTitle,
} from '../utils/media'

function DetailPage({ detailData, onBack, onPlayVideo }) {
  const { credits, error, isLoading, item, videos } = detailData
  const seasons = [...new Set(videos.map((video) => Number(video.season || 1)))].sort((a, b) => a - b)
  const [activeSeason, setActiveSeason] = useState(seasons[0] || 1)
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(EPISODES_PER_PAGE)
  const selectedSeason = seasons.includes(activeSeason) ? activeSeason : seasons[0] || 1
  const isMovie = getMediaType(item) === 'movie'
  const backdrop = getDetailArtworkUrl(item)
  const genres = getGenres(item)
  const firstVideo = videos[0]
  const visibleVideos = videos.filter((video) => Number(video.season || 1) === selectedSeason)
  const renderedVideos = visibleVideos.slice(0, visibleEpisodeCount)
  const hasMoreEpisodes = visibleEpisodeCount < visibleVideos.length
  const canShowLessEpisodes = visibleEpisodeCount > EPISODES_PER_PAGE

  return (
    <main className="detail-page">
      <button className="detail-back" onClick={onBack} type="button">
        <span aria-hidden="true">&larr;</span>
        <span>Back</span>
      </button>

      <section className="detail-hero">
        {backdrop && <LoadableImage className="detail-backdrop" fetchPriority="high" key={backdrop} loading="eager" shimmerOnError={false} src={backdrop} />}
        <div className="detail-shade" />
        <div className="detail-copy">
          <p className="detail-type">{isMovie ? 'Movie' : 'Series'}</p>
          <h1>{getTitle(item)}</h1>
          <div className="detail-meta">
            {getRating(item) > 0 && <span className="detail-rating">TMDB {getRating(item).toFixed(1)}</span>}
            {genres.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
          </div>
          <p className="detail-overview">{item.tmdb_overview || item.overview || 'No description is available for this title yet.'}</p>
          <button className="play-button" disabled={!firstVideo || isLoading} onClick={() => onPlayVideo(firstVideo)} type="button">
            <Play fill="currentColor" size={20} />
            <span>{isLoading ? 'Loading...' : firstVideo ? 'Play' : 'Unavailable offline'}</span>
          </button>
        </div>
      </section>

      <section className="detail-body">
        {error && <p className="detail-error">{error}</p>}
        {isMovie && (
          <div className="detail-content-grid movie-detail-content-grid">
            <CreditsPanel credits={credits} mediaType="movie" />
          </div>
        )}
        {!isMovie && (
          <>
            <div className="episode-heading">
              <h2>Episodes</h2>
              <span>{visibleVideos.length ? `${visibleVideos.length} episodes` : 'Series'}</span>
            </div>
            {seasons.length > 1 && (
              <div className="season-nav" aria-label="Choose season">
                {seasons.map((season) => (
                  <button
                    className={selectedSeason === season ? 'active' : ''}
                    key={season}
                    onClick={() => {
                      setActiveSeason(season)
                      setVisibleEpisodeCount(EPISODES_PER_PAGE)
                    }}
                    type="button"
                  >
                    Season {season}
                  </button>
                ))}
              </div>
            )}
            {isLoading && (
              <div className="episode-list episode-skeleton-list" aria-label="Loading episodes">
                {Array.from({ length: 4 }, (_, index) => (
                  <article className="episode-card episode-skeleton-card" key={index}>
                    <span className="skeleton-block skeleton-number" />
                    <span className="skeleton-block skeleton-thumbnail" />
                    <span className="skeleton-copy">
                      <span className="skeleton-block skeleton-title" />
                      <span className="skeleton-block skeleton-meta" />
                      <span className="skeleton-block skeleton-line" />
                    </span>
                  </article>
                ))}
              </div>
            )}
            {!isLoading && !videos.length && <p className="detail-muted">Episodes are unavailable offline.</p>}
            <div className="detail-content-grid">
              <div className="episode-list">
                {renderedVideos.map((video, index) => {
                  const episodeNumber = video.episode || index + 1
                  const thumbnail = getStillUrl(video)
                  const duration = formatDuration(video)

                  return (
                    <article className="episode-card" key={`${video.path || video.name}-${index}`}>
                      <span className="episode-number">{episodeNumber}</span>
                      <div className="episode-thumbnail">
                        <LoadableImage key={thumbnail} src={thumbnail} />
                        <button aria-label={`Play ${video.name || `episode ${episodeNumber}`}`} onClick={() => onPlayVideo(video)} type="button">
                          <Play fill="currentColor" size={20} />
                        </button>
                      </div>
                      <div className="episode-copy">
                        <div className="episode-title-row">
                          <h3>{video.name}</h3>
                          {duration && <span>{duration}</span>}
                        </div>
                        <p className="episode-meta">Season {video.season || 1} &middot; Episode {episodeNumber}</p>
                        {video.overview && <p className="episode-description">{video.overview}</p>}
                      </div>
                    </article>
                  )
                })}
                {(hasMoreEpisodes || canShowLessEpisodes) && (
                  <div className="episode-pagination">
                    {canShowLessEpisodes && (
                      <button onClick={() => setVisibleEpisodeCount((count) => Math.max(EPISODES_PER_PAGE, count - EPISODES_PER_PAGE))} type="button">
                        <ChevronUp size={18} />
                        <span>View less</span>
                      </button>
                    )}
                    {hasMoreEpisodes && (
                      <button onClick={() => setVisibleEpisodeCount((count) => count + EPISODES_PER_PAGE)} type="button">
                        <span>View more</span>
                        <ChevronDown size={18} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <CreditsPanel credits={credits} />
            </div>
          </>
        )}
      </section>
    </main>
  )
}

export default DetailPage
