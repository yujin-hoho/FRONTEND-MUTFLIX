import { useEffect, useMemo, useState } from 'react'
import { Bookmark, Check } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import ProfileMenu from '../components/ProfileMenu'
import SearchBox from '../components/search/SearchBox'
import { fetchMyList } from '../services/api'
import { getCatalogIdentityKey, getGenres, getItemKey, getMediaType, getPosterUrl, getRating, getTitle, isCatalogItemCompleted } from '../utils/media'

const MY_LIST_STATUSES = ['plan_to_watch', 'completed']

function MyListPage({
  authToken,
  catalogData,
  onChangeProfile,
  onFilterSelect,
  onHydrateItems,
  onLogout,
  onOpenDetail,
  onOpenContextMenu,
  onOpenSearch,
  onSearchCatalog,
  profileId,
  profileMyList = [],
  selectedProfile,
  watchHistory = [],
}) {
  const [activeStatus, setActiveStatus] = useState('plan_to_watch')
  const [myListByStatus, setMyListByStatus] = useState(() => createEmptyMyListByStatus())
  const [statusByStatus, setStatusByStatus] = useState(() => createEmptyStatusByStatus())
  const [errorByStatus, setErrorByStatus] = useState(() => createEmptyErrorByStatus())
  const catalogItems = useMemo(() => [...catalogData.movies, ...catalogData.series], [catalogData.movies, catalogData.series])
  const catalogByKey = useMemo(
    () => new Map(catalogItems.map((item) => [getCatalogIdentityKey(item), item])),
    [catalogItems],
  )
  const items = useMemo(
    () => myListByStatus[activeStatus].map((item) => ({
      ...catalogByKey.get(getCatalogIdentityKey(item)),
      ...item,
    })),
    [activeStatus, catalogByKey, myListByStatus],
  )
  const loadedItems = useMemo(
    () => MY_LIST_STATUSES.flatMap((nextStatus) => myListByStatus[nextStatus]),
    [myListByStatus],
  )
  const itemCounts = useMemo(
    () => loadedItems.reduce((counts, item) => ({
      ...counts,
      [item.my_list_status]: (counts[item.my_list_status] || 0) + 1,
    }), {}),
    [loadedItems],
  )
  const status = statusByStatus[activeStatus]
  const error = errorByStatus[activeStatus]

  useEffect(() => {
    setMyListByStatus(createEmptyMyListByStatus())
    setStatusByStatus(createEmptyStatusByStatus())
    setErrorByStatus(createEmptyErrorByStatus())
  }, [profileId])

  useEffect(() => {
    if (statusByStatus[activeStatus] !== 'idle') return undefined

    let ignore = false
    const requestedStatus = activeStatus

    setStatusByStatus((currentStatuses) => ({ ...currentStatuses, [requestedStatus]: 'loading' }))
    setErrorByStatus((currentErrors) => ({ ...currentErrors, [requestedStatus]: '' }))

    fetchMyList(authToken, profileId, { status: requestedStatus })
      .then((nextItems) => {
        if (!ignore) {
          setMyListByStatus((currentLists) => ({ ...currentLists, [requestedStatus]: nextItems }))
          setStatusByStatus((currentStatuses) => ({ ...currentStatuses, [requestedStatus]: 'ready' }))
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setErrorByStatus((currentErrors) => ({ ...currentErrors, [requestedStatus]: requestError.message }))
          setStatusByStatus((currentStatuses) => ({ ...currentStatuses, [requestedStatus]: 'error' }))
        }
      })

    return () => {
      ignore = true
    }
  }, [activeStatus, authToken, profileId, statusByStatus])

  return (
    <main className="my-list-page">
      <nav className="dashboard-topbar my-list-topbar" aria-label="My List">
        <a className="brand-mark dashboard-brand" href="/dashboard" aria-label="Mutflix dashboard">
          MUTFLIX
        </a>
        <div className="dashboard-nav">
          <a href="/dashboard">Home</a>
          <button onClick={() => onFilterSelect({ label: 'Movies', type: 'type', value: 'movie' })} type="button">Movies</button>
          <button onClick={() => onFilterSelect({ label: 'Series', type: 'type', value: 'series' })} type="button">Series</button>
          <button onClick={() => onFilterSelect({ label: 'Variety Show', type: 'category', value: 'variety-show' })} type="button">Variety Show</button>
          <button className="active" type="button">My List</button>
        </div>
        <div className="dashboard-actions">
          <SearchBox
            catalogItems={catalogItems}
            myList={[...loadedItems, ...profileMyList]}
            onFilterSelect={onFilterSelect}
            onHydrateItems={onHydrateItems}
            onOpenDetail={onOpenDetail}
            onOpenContextMenu={onOpenContextMenu}
            onSearchCatalog={onSearchCatalog}
            onSubmit={onOpenSearch}
            watchHistory={watchHistory}
          />
          <ProfileMenu onChangeProfile={onChangeProfile} onLogout={onLogout} selectedProfile={selectedProfile} />
        </div>
      </nav>

      <section className="my-list-shell" aria-live="polite">
        <div className="my-list-heading">
          <p>Collection</p>
          <h1>My List</h1>
          <span>{status === 'ready' ? `${items.length} judul tersimpan` : 'Koleksi tontonan kamu.'}</span>
        </div>

        <nav className="my-list-tabs" aria-label="Kategori My List">
          <button className={activeStatus === 'plan_to_watch' ? 'active' : ''} onClick={() => setActiveStatus('plan_to_watch')} type="button">
            <span>Plan to Watch</span>
            {statusByStatus.plan_to_watch === 'ready' && <strong>{itemCounts.plan_to_watch || 0}</strong>}
          </button>
          <button className={activeStatus === 'completed' ? 'active' : ''} onClick={() => setActiveStatus('completed')} type="button">
            <span>Completed</span>
            {statusByStatus.completed === 'ready' && <strong>{itemCounts.completed || 0}</strong>}
          </button>
        </nav>

        {status === 'loading' && <MyListLoading />}
        {status === 'error' && <MyListState text={error || 'My List gagal dimuat.'} />}
        {status === 'ready' && items.length === 0 && (
          <MyListState text={activeStatus === 'completed' ? 'Belum ada judul yang selesai ditonton.' : 'Belum ada judul di Plan to Watch.'} />
        )}

        {status === 'ready' && items.length > 0 && (
          <div className="my-list-grid">
            {items.map((item) => {
              const genres = getGenres(item)
              const poster = getPosterUrl(item)
              const rating = getRating(item)
              const isCompleted = isCatalogItemCompleted(item, { myList: [...loadedItems, ...profileMyList], watchHistory })

              return (
                <button
                  className={`my-list-card${isCompleted ? ' item-completed' : ''}`}
                  key={getItemKey(item)}
                  onClick={() => onOpenDetail(item)}
                  onContextMenu={(event) => onOpenContextMenu?.(event, { item })}
                  type="button"
                >
                  <span className={`my-list-poster${isCompleted ? ' completed-poster' : ''}`}>
                    <LoadableImage alt={getTitle(item)} key={poster} src={poster} />
                    {isCompleted && (
                      <span aria-label="Selesai" className="completion-badge item-completion-badge">
                        <Check size={20} strokeWidth={3.4} />
                      </span>
                    )}
                    {rating > 0 && <span className="rating-badge">{rating.toFixed(1)}</span>}
                  </span>
                  <span className="my-list-copy">
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

function MyListLoading() {
  return (
    <div className="my-list-grid my-list-loading-grid" aria-label="Memuat My List">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="my-list-loading-card" key={index}>
          <span className="skeleton-block my-list-loading-poster" />
          <span className="skeleton-block my-list-loading-title" />
          <span className="skeleton-block my-list-loading-meta" />
        </div>
      ))}
    </div>
  )
}

function MyListState({ text }) {
  return (
    <div className="my-list-state">
      <Bookmark size={30} />
      <p>{text}</p>
    </div>
  )
}

function createEmptyMyListByStatus() {
  return { completed: [], plan_to_watch: [] }
}

function createEmptyStatusByStatus() {
  return { completed: 'idle', plan_to_watch: 'idle' }
}

function createEmptyErrorByStatus() {
  return { completed: '', plan_to_watch: '' }
}

export default MyListPage
