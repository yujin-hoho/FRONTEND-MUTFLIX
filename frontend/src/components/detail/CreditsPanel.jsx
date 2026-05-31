import { memo } from 'react'
import LoadableImage from '../LoadableImage'
import { getPersonFallbackUrl, getPosterUrl, getStillUrl } from '../../utils/media'

const CreditsPanel = memo(function CreditsPanel({ credits, mediaType = 'series' }) {
  const cast = credits?.cast || []
  const crew = credits?.crew || []
  const meta = credits?.meta
  const recommendations = credits?.recommendations || []
  const trailerId = credits?.trailerId || ''
  const genres = Array.isArray(meta?.genres) ? meta.genres.map((genre) => genre.name).filter(Boolean) : []
  const networks = Array.isArray(meta?.networks) ? meta.networks.map((network) => network.name).filter(Boolean) : []
  const isMovie = mediaType === 'movie'
  const type = isMovie ? 'Movie' : meta?.type || (meta?.number_of_seasons ? 'TV Show' : '')
  const status = meta?.status || ''
  const episodeRuntime = Array.isArray(meta?.episode_run_time) ? meta.episode_run_time.filter(Boolean)[0] : null
  const runtime = isMovie ? Number(meta?.runtime || 0) : episodeRuntime
  const year = (isMovie ? meta?.release_date : meta?.first_air_date)?.slice(0, 4)
  const uniqueCrew = [...crew.reduce((people, person) => {
    const key = person.id || person.name
    const role = person.job || person.department
    const existingPerson = people.get(key)

    if (existingPerson) {
      if (role && !existingPerson.roles.includes(role)) existingPerson.roles.push(role)
      return people
    }

    people.set(key, { ...person, roles: role ? [role] : [] })
    return people
  }, new Map()).values()]
  if (!cast.length && !crew.length && !meta) return null

  return (
    <aside className="credits-panel">
      {meta && (
        <section className="title-facts">
          <h2>Details</h2>
          <dl>
            {status && (
              <div>
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
            )}
            {type && (
              <div>
                <dt>Type</dt>
                <dd>{type}</dd>
              </div>
            )}
            {genres.length > 0 && (
              <div>
                <dt>Genres</dt>
                <dd>{genres.join(', ')}</dd>
              </div>
            )}
            {networks.length > 0 && (
              <div>
                <dt>Network</dt>
                <dd>{networks.join(', ')}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {meta && (
        <section className="season-facts">
          <h2>{isMovie ? 'Movie Info' : 'Season Info'}</h2>
          <div>
            {!isMovie && meta.number_of_seasons > 0 && <span><strong>{meta.number_of_seasons}</strong> seasons</span>}
            {!isMovie && meta.number_of_episodes > 0 && <span><strong>{meta.number_of_episodes}</strong> episodes</span>}
            {runtime > 0 && <span><strong>{runtime}</strong> min</span>}
            {year && <span><strong>{year}</strong> {isMovie ? 'released' : 'first aired'}</span>}
          </div>
        </section>
      )}
      {trailerId && (
        <section className="trailer-section">
          <h2>Trailer</h2>
          <div className="trailer-embed">
            <iframe
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              loading="lazy"
              src={`https://www.youtube.com/embed/${encodeURIComponent(trailerId)}?autoplay=1&mute=1&controls=1&playsinline=1&rel=0`}
              title="Trailer"
            />
          </div>
        </section>
      )}
      {cast.length > 0 && (
        <section className="cast-section">
          <h2>Cast</h2>
          <div className="cast-list">
            {cast.map((person) => (
              <article className="cast-card" key={`${person.id}-${person.character}`}>
                <div className="cast-avatar">
                  <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} key={person.profile_path} src={getStillUrl(person)} />
                </div>
                <div>
                  <h3>{person.name}</h3>
                  {person.character && <p>{person.character}</p>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {crew.length > 0 && (
        <section className="crew-section">
          <h2>Crew</h2>
          <div className="crew-list">
            {uniqueCrew.slice(0, 5).map((person, index) => (
              <article className="cast-card" key={`${person.id || person.name}-${index}`}>
                <div className="cast-avatar">
                  <LoadableImage alt={person.name} fallbackSrc={getPersonFallbackUrl(person)} key={person.profile_path} src={getStillUrl(person)} />
                </div>
                <div>
                  <h3>{person.name}</h3>
                  <p>{person.roles.join('/')}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {recommendations.length > 0 && (
        <section className="recommendations">
          <h2>More Like This</h2>
          <div>
            {(isMovie ? recommendations.slice(0, 10) : recommendations).map((recommendation) => (
              <article key={recommendation.id}>
                <div className="recommendation-poster">
                  <LoadableImage alt={recommendation.name || recommendation.title} key={recommendation.poster_path} src={getPosterUrl(recommendation)} />
                </div>
                <h3>{recommendation.name || recommendation.title}</h3>
              </article>
            ))}
          </div>
        </section>
      )}
    </aside>
  )
})

export default CreditsPanel
