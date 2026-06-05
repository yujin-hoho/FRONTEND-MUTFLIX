import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Check } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import ProfileMenu from '../components/ProfileMenu'
import SearchBox from '../components/search/SearchBox'
import { fetchMyList, fetchMyListCounts } from '../services/api'
import { getCatalogIdentityKey, getGenres, getItemKey, getMediaType, getPosterUrl, getRating, getTitle, isCatalogItemCompleted } from '../utils/media'

const MY_LIST_STATUSES = ['plan_to_watch', 'completed']
const MY_LIST_BATCH_SIZE = 24

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
  const [itemCounts, setItemCounts] = useState(() => createEmptyItemCounts())
  const [statusByStatus, setStatusByStatus] = useState(() => createEmptyStatusByStatus())
  const [errorByStatus, setErrorByStatus] = useState(() => createEmptyErrorByStatus())
  const [lazyRenderState, setLazyRenderState] = useState({ count: MY_LIST_BATCH_SIZE, key: '' })
  const myListPageRef = useRef(null)
  const lazyLoadRef = useRef(null)
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
  const completedContextItems = useMemo(
    () => [...loadedItems, ...profileMyList],
    [loadedItems, profileMyList],
  )
  const searchBoxMyList = completedContextItems
  const status = statusByStatus[activeStatus]
  const error = errorByStatus[activeStatus]
  const listKey = `${profileId}:${activeStatus}:${items.length}`
  const visibleCount = lazyRenderState.key === listKey ? lazyRenderState.count : MY_LIST_BATCH_SIZE
  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  )
  const hasMoreItems = visibleItems.length < items.length

  useEffect(() => {
    let ignore = false

    fetchMyListCounts(authToken, profileId)
      .then((nextCounts) => {
        if (!ignore) setItemCounts(nextCounts)
      })
      .catch(() => {
        if (!ignore) setItemCounts(createEmptyItemCounts())
      })

    return () => {
      ignore = true
    }
  }, [authToken, profileId])

  useEffect(() => {
    if (statusByStatus[activeStatus] !== 'loading') return undefined

    let ignore = false
    const requestedStatus = activeStatus

    fetchMyList(authToken, profileId, { status: requestedStatus })
      .then((nextItems) => {
        if (!ignore) {
          setMyListByStatus((currentLists) => ({ ...currentLists, [requestedStatus]: nextItems }))
          setItemCounts((currentCounts) => ({ ...currentCounts, [requestedStatus]: nextItems.length }))
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

  useEffect(() => {
    const sentinel = lazyLoadRef.current
    const scrollRoot = myListPageRef.current
    if (!sentinel || !scrollRoot || !hasMoreItems) return undefined

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setLazyRenderState((currentState) => {
          const currentCount = currentState.key === listKey ? currentState.count : MY_LIST_BATCH_SIZE
          return {
            count: Math.min(currentCount + MY_LIST_BATCH_SIZE, items.length),
            key: listKey,
          }
        })
      },
      { root: scrollRoot, rootMargin: '520px 0px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreItems, items.length, listKey])

  function handleStatusSelect(nextStatus) {
    setActiveStatus(nextStatus)
    if (statusByStatus[nextStatus] !== 'idle') return
    setStatusByStatus((currentStatuses) => ({ ...currentStatuses, [nextStatus]: 'loading' }))
    setErrorByStatus((currentErrors) => ({ ...currentErrors, [nextStatus]: '' }))
  }

  return (
    <main className="my-list-page" ref={myListPageRef}>
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
            myList={searchBoxMyList}
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
          <button className={activeStatus === 'plan_to_watch' ? 'active' : ''} onClick={() => handleStatusSelect('plan_to_watch')} type="button">
            <span>Plan to Watch</span>
            <strong>{itemCounts.plan_to_watch || 0}</strong>
          </button>
          <button className={activeStatus === 'completed' ? 'active' : ''} onClick={() => handleStatusSelect('completed')} type="button">
            <span>Completed</span>
            <strong>{itemCounts.completed || 0}</strong>
          </button>
        </nav>

        {status === 'loading' && <MyListLoading />}
        {status === 'error' && <MyListState text={error || 'My List gagal dimuat.'} />}
        {status === 'ready' && items.length === 0 && (
          <MyListState text={activeStatus === 'completed' ? 'Belum ada judul yang selesai ditonton.' : 'Belum ada judul di Plan to Watch.'} />
        )}

        {status === 'ready' && items.length > 0 && (
          <>
            <div className="my-list-grid">
              {visibleItems.map((item) => (
                <MyListCard
                  activeStatus={activeStatus}
                  completedContextItems={completedContextItems}
                  item={item}
                  key={getItemKey(item)}
                  onOpenContextMenu={onOpenContextMenu}
                  onOpenDetail={onOpenDetail}
                  watchHistory={watchHistory}
                />
              ))}
            </div>
            {hasMoreItems && <div className="my-list-sentinel" ref={lazyLoadRef} aria-hidden="true" />}
          </>
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

const MyListCard = memo(function MyListCard({ activeStatus, completedContextItems, item, onOpenContextMenu, onOpenDetail, watchHistory }) {
  const genres = getGenres(item)
  const poster = getPosterUrl(item)
  const rating = getRating(item)
  const title = getTitle(item)
  const isCompleted = activeStatus === 'completed'
    || isCatalogItemCompleted(item, { myList: completedContextItems, watchHistory })

  return (
    <button
      className={`my-list-card${isCompleted ? ' item-completed' : ''}`}
      onClick={() => onOpenDetail(item)}
      onContextMenu={(event) => onOpenContextMenu?.(event, { item })}
      type="button"
    >
      <span className={`my-list-poster${isCompleted ? ' completed-poster' : ''}`}>
        <LoadableImage alt={title} key={poster} src={poster} />
        {isCompleted && (
          <span aria-label="Selesai" className="completion-badge item-completion-badge">
            <Check size={20} strokeWidth={3.4} />
          </span>
        )}
        {rating > 0 && <span className="rating-badge">{rating.toFixed(1)}</span>}
      </span>
      <span className="my-list-copy">
        <strong>{title}</strong>
        <span>{getMediaType(item) === 'movie' ? 'Movie' : 'Series'}{genres[0] ? ` / ${genres[0]}` : ''}</span>
      </span>
    </button>
  )
})

function createEmptyMyListByStatus() {
  return { completed: [], plan_to_watch: [] }
}

function createEmptyItemCounts() {
  return { completed: 0, plan_to_watch: 0 }
}

function createEmptyStatusByStatus() {
  return { completed: 'idle', plan_to_watch: 'loading' }
}

function createEmptyErrorByStatus() {
  return { completed: '', plan_to_watch: '' }
}

export default MyListPage
