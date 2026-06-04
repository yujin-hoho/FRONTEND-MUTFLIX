import { useEffect, useMemo, useState } from 'react'
import { Bookmark, Check, ChevronDown, LogOut, UsersRound } from 'lucide-react'
import LoadableImage from '../components/LoadableImage'
import SearchBox from '../components/search/SearchBox'
import { fetchMyList } from '../services/api'
import { getCatalogIdentityKey, getGenres, getItemKey, getMediaType, getPosterUrl, getProfileAvatarUrl, getRating, getTitle, isCatalogItemCompleted } from '../utils/media'

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
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [myList, setMyList] = useState([])
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const catalogItems = useMemo(() => [...catalogData.movies, ...catalogData.series], [catalogData.movies, catalogData.series])
  const catalogByKey = useMemo(
    () => new Map(catalogItems.map((item) => [getCatalogIdentityKey(item), item])),
    [catalogItems],
  )
  const items = useMemo(
    () => myList.map((item) => ({
      ...catalogByKey.get(getCatalogIdentityKey(item)),
      ...item,
    })),
    [catalogByKey, myList],
  )
  const itemCounts = useMemo(
    () => items.reduce((counts, item) => ({
      ...counts,
      [item.my_list_status]: (counts[item.my_list_status] || 0) + 1,
    }), {}),
    [items],
  )
  const visibleItems = useMemo(
    () => items.filter((item) => item.my_list_status === activeStatus),
    [activeStatus, items],
  )

  useEffect(() => {
    let ignore = false

    fetchMyList(authToken, profileId)
      .then((nextItems) => {
        if (!ignore) {
          setMyList(nextItems)
          setStatus('ready')
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setError(requestError.message)
          setStatus('error')
        }
      })

    return () => {
      ignore = true
    }
  }, [authToken, profileId])

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
            myList={items}
            onFilterSelect={onFilterSelect}
            onHydrateItems={onHydrateItems}
            onOpenDetail={onOpenDetail}
            onOpenContextMenu={onOpenContextMenu}
            onSearchCatalog={onSearchCatalog}
            onSubmit={onOpenSearch}
            watchHistory={watchHistory}
          />
          <div className="profile-menu">
            <button
              aria-expanded={showProfileMenu}
              className="profile-menu-trigger"
              onClick={() => setShowProfileMenu((isOpen) => !isOpen)}
              type="button"
            >
              <span className="profile-menu-avatar" aria-hidden="true">
                <img alt="" src={getProfileAvatarUrl(selectedProfile)} />
              </span>
              <ChevronDown size={16} />
            </button>
            {showProfileMenu && (
              <div className="profile-menu-dropdown">
                <button onClick={onChangeProfile} type="button">
                  <UsersRound size={17} />
                  <span>Ganti profil</span>
                </button>
                <button onClick={onLogout} type="button">
                  <LogOut size={17} />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
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
            {status === 'ready' && <strong>{itemCounts.plan_to_watch || 0}</strong>}
          </button>
          <button className={activeStatus === 'completed' ? 'active' : ''} onClick={() => setActiveStatus('completed')} type="button">
            <span>Completed</span>
            {status === 'ready' && <strong>{itemCounts.completed || 0}</strong>}
          </button>
        </nav>

        {status === 'loading' && <MyListLoading />}
        {status === 'error' && <MyListState text={error || 'My List gagal dimuat.'} />}
        {status === 'ready' && visibleItems.length === 0 && (
          <MyListState text={activeStatus === 'completed' ? 'Belum ada judul yang selesai ditonton.' : 'Belum ada judul di Plan to Watch.'} />
        )}

        {status === 'ready' && visibleItems.length > 0 && (
          <div className="my-list-grid">
            {visibleItems.map((item) => {
              const genres = getGenres(item)
              const poster = getPosterUrl(item)
              const rating = getRating(item)
              const isCompleted = isCatalogItemCompleted(item, { myList: [...items, ...profileMyList], watchHistory })

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

export default MyListPage
