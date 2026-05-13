import { useEffect, useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { MovieCard } from '../components/MovieCarousel';
import { fetchFolders, getTMDBInfo, TMDB_GENRES, logout } from '../services/api';
import Footer from '../components/Footer';
import TmdbPosterEditModal from '../components/TmdbPosterEditModal';

const REGIONS = ['All regions', 'Chinese Mainland', 'South Korea', 'Indonesia', 'Thailand', 'Taiwan', 'Japan', 'Malaysia', 'America', 'UK'];
const CATEGORIES = ['All Genres', 'Youth', 'Mystery', 'Costume', 'Urban', 'Romance', 'Sweet Love', 'Marriage', 'Drama', 'Comedy', 'Family', 'Friendship', 'Fantasy', 'Crime', 'War', 'Novel Adaptation', 'Contemporary', 'Ancient', 'Variety Show'];

/** Genre TMDB yang dipakai untuk acara varietas / non-scripted (TV + beberapa film) */
const VARIETY_TMDB_GENRE_IDS = new Set([99, 10402, 10763, 10764, 10767]);

const VARIETY_TITLE_PATTERNS = [
  /\bvariety\b/i,
  /\breality\b/i,
  /talk\s*show/i,
  /talkshow/i,
  /game\s*show/i,
  /survival/i,
  /weekly\s+idol/i,
  /running\s+man/i,
  /knowing\s+bros/i,
  /knowing\s+brother/i,
  /infinite\s+challenge/i,
  /we\s+got\s+married/i,
  /strong\s+heart/i,
  /music\s+bank/i,
  /inkigayo/i,
  /show!?\s*music\s*core/i,
  /produce\s*101/i,
  /produce\s*x\s*101/i,
  /street\s+woman/i,
  /queendom\b/i,
  /road\s+to\s+kingdom/i,
  /kingdom\s*:\s*legendary\s+war/i,
  /2\s*days\s*1\s*night/i,
  /new\s+journey\s+to\s+the\s+west/i,
  /workman\b/i,
  /busted\b/i,
  /village\s+survival/i,
  /hangout\s+with\s+yoo/i,
  /the\s+genius\b/i,
  /the\s+voice\b/i,
  /master\s*chef/i,
  /big\s+brother\b/i,
  /amazing\s+race/i,
  /golden\s+bell/i,
  /1\s*night\s*2\s*days/i,
  /happy\s+together\b/i,
  /family\s+outing\b/i,
  /superman\s+is\s+back/i,
  /return\s+of\s+superman/i,
  /home\s+alone\b/i,
  /i\s*live\s+alone/i,
  /running\s+youth/i,
  /youth\s+over\s+flowers/i,
  /三时三餐|爸爸去哪儿|快乐大本营|天天向上|非诚勿扰|奔跑吧|极限挑战|密室|大侦探|脱口秀|演唱会/,
  /综艺/,
  /真人秀/,
];

const inferTmdbMediaType = (item) => {
  if (item.media_type === 'movie' || item.type === 'movie') return 'movie';
  if (item.media_type === 'tv' || item.type === 'series' || item.type === 'tv') return 'tv';
  if (item.episodes || item.first_air_date) return 'tv';
  return undefined;
};

const tmdbOptsFromItem = (item) => {
  if (!item?.tmdb_query) return {};
  return {
    query: item.tmdb_query,
    mediaType: item.tmdb_override_media_type === 'movie' ? 'movie' : 'tv',
    year: item.override_year != null && item.override_year !== '' ? Number(item.override_year) : undefined,
    region: item.override_region || undefined,
    includeAdult: !!item.include_adult,
  };
};

const itemMatchesVarietyShow = (item) => {
  const ids = item.tmdb_genre_ids;
  if (Array.isArray(ids) && ids.some((id) => VARIETY_TMDB_GENRE_IDS.has(Number(id)))) return true;

  const cats = item.parsedCategories || [];
  const varietyLabels = ['Talk', 'Reality', 'Documentary', 'News', 'Music'];
  if (varietyLabels.some((l) => cats.includes(l))) return true;

  const label = `${item.folder_name || ''} ${item.name || ''} ${item.tmdb_title || ''}`;
  const labelLower = label.toLowerCase();
  if (label.trim() && VARIETY_TITLE_PATTERNS.some((re) => re.test(labelLower))) return true;

  return false;
};

/** Pool agar semua item bisa di-enrich tanpa membanjiri TMDB sekaligus (TMDB ~40 req/10s — 12 aman dengan light + dedupe) */
const TMDB_FILTER_CONCURRENCY = 6;
const MAX_TMDB_ENRICH_FILTER = 600;

async function mapWithConcurrency(items, concurrency, mapper, onItemDone) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await mapper(items[i], i);
      completed += 1;
      if (onItemDone) onItemDone(i, results[i], completed);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

const getRegionMapping = (item) => {
  const lang = item.original_language || '';
  const countries = item.origin_country || [];

  if (countries.includes('KR') || lang === 'ko') return 'South Korea';
  if (countries.includes('CN') || lang === 'zh') return 'Chinese Mainland';
  if (countries.includes('ID') || lang === 'id') return 'Indonesia';
  if (countries.includes('TH') || lang === 'th') return 'Thailand';
  if (countries.includes('TW')) return 'Taiwan';
  if (countries.includes('JP') || lang === 'ja') return 'Japan';
  if (countries.includes('MY') || lang === 'ms') return 'Malaysia';
  if (countries.includes('US') || lang === 'en') return 'America';
  if (countries.includes('GB')) return 'UK';
  if (['id', 'th', 'ms'].includes(lang)) return 'Southeast Asia';

  return 'Other';
};

const filterItems = (resolved, activeType, activeRegion, activeCategory) => {
  let filtered = resolved;

  // "All" (default): jangan filter tipe — ini yang diharapkan untuk /filter & "All Videos"
  if (activeType === 'Movie') {
    filtered = filtered.filter(item => item.media_type === 'movie' || item.type === 'movie' || (!item.episodes && !item.first_air_date));
  } else if (activeType === 'Drama') {
    filtered = filtered.filter(item => item.media_type === 'tv' || item.type === 'series' || item.episodes || item.first_air_date);
  } else if (activeType === 'Anime') {
    filtered = filtered.filter(item => item.parsedCategories?.includes('Animation'));
  } else if (activeType === 'Variety Show') {
    filtered = filtered.filter(itemMatchesVarietyShow);
  }

  if (activeRegion !== 'All regions') {
    filtered = filtered.filter(item => {
      if (activeRegion === 'Southeast Asia') {
        return ['Indonesia', 'Thailand', 'Malaysia'].includes(item.parsedRegion);
      }
      return item.parsedRegion === activeRegion;
    });
  }

  if (activeCategory !== 'All Genres') {
    filtered = filtered.filter(item => {
      const cats = item.parsedCategories || [];
      if (['Youth', 'Sweet Love', 'Friendship'].includes(activeCategory)) {
        return cats.includes('Romance') || cats.includes('Family');
      }
      if (['Crime', 'Mystery', 'Urban'].includes(activeCategory)) {
        return cats.includes('Crime') || cats.includes('Mystery') || cats.includes('Thriller');
      }
      if (['Costume', 'Ancient'].includes(activeCategory)) {
        return cats.includes('History') || cats.includes('War');
      }
      if (activeCategory === 'Variety Show') {
        return itemMatchesVarietyShow(item);
      }
      if (activeCategory === 'Novel Adaptation') {
        return cats.includes('Drama') || cats.includes('Fantasy');
      }
      return cats.includes(activeCategory);
    });
  }

  return filtered;
};

/** Urutkan dari TMDB rating (field tmdb_rating) */
const applySort = (items, sortKey) => {
  if (sortKey === 'rating_desc') {
    return [...items].sort((a, b) => {
      const d = (Number(b.tmdb_rating) || 0) - (Number(a.tmdb_rating) || 0);
      if (d !== 0) return d;
      return (a.folder_name || '').localeCompare(b.folder_name || '', undefined, { sensitivity: 'base' });
    });
  }
  if (sortKey === 'rating_asc') {
    return [...items].sort((a, b) => {
      const d = (Number(a.tmdb_rating) || 0) - (Number(b.tmdb_rating) || 0);
      if (d !== 0) return d;
      return (a.folder_name || '').localeCompare(b.folder_name || '', undefined, { sensitivity: 'base' });
    });
  }
  return items;
};

const GRID_PAGE_SIZE = 24;
/** Batch pertama lebih besar supaya sentinel cepat masuk area scroll / intersection */
const INITIAL_VISIBLE = Math.min(GRID_PAGE_SIZE * 2, 200);

const FilterPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const activeType = searchParams.get('type') || 'All';
  const activeRegion = searchParams.get('region') || 'All regions';
  const activeCategory = searchParams.get('category') || 'All Genres';
  const sortBy = searchParams.get('sort') || 'default';

  const [listLoading, setListLoading] = useState(true);
  const [, setTmdbEnriching] = useState(false);
  const [allResolved, setAllResolved] = useState([]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const loadMoreSentinelRef = useRef(null);
  const filteredSortedLengthRef = useRef(0);

  const filteredSorted = useMemo(
    () => applySort(filterItems(allResolved, activeType, activeRegion, activeCategory), sortBy),
    [allResolved, activeType, activeRegion, activeCategory, sortBy]
  );

  filteredSortedLengthRef.current = filteredSorted.length;

  const visibleItems = useMemo(
    () => filteredSorted.slice(0, visibleCount),
    [filteredSorted, visibleCount]
  );

  const [, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });
  const [posterEditItem, setPosterEditItem] = useState(null);
  const isAdmin = authUser?.role === 'admin';

  const handleLogout = () => {
    logout();
    setAuthUser(null);
  };

  const handleFilterClick = (type, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value === 'All regions' || value === 'All Genres') {
      newParams.delete(type);
    } else if (type === 'type' && value === 'All') {
      newParams.delete('type');
    } else {
      newParams.set(type, value);
    }
    setSearchParams(newParams);
  };

  const handleSortClick = (value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value === 'default') {
      newParams.delete('sort');
    } else {
      newParams.set('sort', value);
    }
    setSearchParams(newParams);
  };

  useEffect(() => {
    const max = filteredSortedLengthRef.current;
    if (max === 0) return;
    setVisibleCount(Math.min(INITIAL_VISIBLE, max));
  }, [activeType, activeRegion, activeCategory, sortBy]);

  // Infinite scroll: jangan masukkan visibleCount ke deps — observer harus stabil agar intersection tidak “hilang” tiap batch
  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el) return undefined;

    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setVisibleCount((c) => {
          const max = filteredSortedLengthRef.current;
          if (c >= max) return c;
          return Math.min(c + GRID_PAGE_SIZE, max);
        });
      },
      {
        root: null,
        rootMargin: '0px 0px 2000px 0px',
        threshold: 0,
      }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [filteredSorted.length]);

  // Fetch daftar folder sekali; TMDB enrichment tidak memblokir halaman
  useEffect(() => {
    const loadData = async () => {
      setListLoading(true);
      try {
        const foldersResp = await fetchFolders();

        let foldersData = [];
        if (foldersResp && typeof foldersResp === 'object' && !Array.isArray(foldersResp)) {
          foldersData = [...(foldersResp.movies || []), ...(foldersResp.series || [])];
        } else if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
        }

        const uniqueDataList = foldersData;

        const hasPosterAndGenres = (it) => {
          const pp = it.poster_path || it.tmdb_poster_path;
          const g = it.tmdb_genre_ids;
          const t = it.tmdb_title;
          return !!(pp && Array.isArray(g) && g.length > 0 && typeof t === 'string' && t.trim().length > 0);
        };

        const quickResolved = uniqueDataList.map((item) => {
          const srcGenreIds = item.tmdb_genre_ids;
          const parsedCategories = srcGenreIds ? srcGenreIds.map((id) => TMDB_GENRES[id]).filter(Boolean) : [];
          const resolved = { ...item, parsedCategories };
          if (!resolved.tmdb_poster_path) {
            resolved.tmdb_poster_path =
              item.poster_path ||
              item.poster ||
              item.tmdb_backdrop_path ||
              item.backdrop_path ||
              null;
          }
          resolved.parsedRegion = getRegionMapping(resolved);
          return resolved;
        });

        const merged = [...quickResolved];
        setAllResolved(merged);
        setListLoading(false);
        setTmdbEnriching(true);

        // Prioritize TMDB enrichment for what the user will see first (better UX).
        const quickFilteredSorted = applySort(
          filterItems(quickResolved, activeType, activeRegion, activeCategory),
          sortBy
        );
        const priorityNames = new Set(
          quickFilteredSorted
            .slice(0, INITIAL_VISIBLE)
            .map((it) => it.folder_name || it.path || it.id)
            .filter(Boolean)
        );

        const viteTmdbKey = import.meta.env.VITE_TMDB_API_KEY;
        const canClientTmdbFetch = !!(viteTmdbKey && viteTmdbKey !== 'MASUKKAN_KEY_TMDB_ANDA_DISINI');

        const needFetchIndices = uniqueDataList
          .map((item, i) => ({ i, item }))
          .filter(({ item }) => !hasPosterAndGenres(item));
        needFetchIndices.sort((a, b) => {
          const aKey = a.item.folder_name || a.item.path || a.item.id;
          const bKey = b.item.folder_name || b.item.path || b.item.id;
          const ap = aKey && priorityNames.has(aKey) ? 0 : 1;
          const bp = bKey && priorityNames.has(bKey) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          const at = inferTmdbMediaType(a.item) === 'tv' ? 0 : 1;
          const bt = inferTmdbMediaType(b.item) === 'tv' ? 0 : 1;
          return at - bt;
        });
        const mayCallTmdb = new Set(
          needFetchIndices.slice(0, MAX_TMDB_ENRICH_FILTER).map(({ i }) => i)
        );

        // Flush more aggressively early so posters "snap" faster, then batch to reduce re-render cost.
        const EARLY_FLUSH_UNTIL = Math.min(INITIAL_VISIBLE, uniqueDataList.length);
        const FLUSH_EVERY = 14;
        const enriched = await mapWithConcurrency(
          uniqueDataList,
          TMDB_FILTER_CONCURRENCY,
          async (item, index) => {
            const title = item.tmdb_title || item.folder_name || item.name;
            if (!title) {
              const srcGenreIds = item.tmdb_genre_ids;
              const parsedCategories = srcGenreIds
                ? srcGenreIds.map((id) => TMDB_GENRES[id]).filter(Boolean)
                : [];
              const r = { ...item, parsedCategories };
              r.parsedRegion = getRegionMapping(r);
              return r;
            }

            const inferred = inferTmdbMediaType(item);
            const override = tmdbOptsFromItem(item);
            const hasEnoughInfo = hasPosterAndGenres(item);
            let tmdbData = null;
            if (!hasEnoughInfo && mayCallTmdb.has(index) && canClientTmdbFetch) {
              tmdbData = await getTMDBInfo(title, {
                ...override,
                mediaType: override.mediaType || inferred || undefined,
                light: true,
              });
            }

            const srcGenreIds =
              tmdbData?.genre_ids ||
              (tmdbData?.genres ? tmdbData.genres.map((g) => g.id) : null) ||
              item.tmdb_genre_ids;
            const parsedCategories = srcGenreIds
              ? srcGenreIds.map((id) => TMDB_GENRES[id]).filter(Boolean)
              : [];

            const resolvedItem = {
              ...item,
              tmdb_id: tmdbData?.tmdb_id || item.tmdb_id,
              media_type: tmdbData?.media_type || item.media_type,
              tmdb_poster_path:
                tmdbData?.poster_path ||
                tmdbData?.backdrop_path ||
                item.tmdb_poster_path ||
                item.poster_path ||
                item.poster ||
                item.tmdb_backdrop_path ||
                item.backdrop_path,
              tmdb_title: tmdbData?.tmdb_title || tmdbData?.title || item.tmdb_title || null,
              tmdb_rating: tmdbData?.rating || item.tmdb_rating,
              tmdb_overview: tmdbData?.overview || item.tmdb_overview,
              tmdb_genre_ids: srcGenreIds,
              original_language: tmdbData?.original_language || item.original_language,
              origin_country: tmdbData?.origin_country || item.origin_country,
              parsedCategories,
            };
            resolvedItem.parsedRegion = getRegionMapping(resolvedItem);
            return resolvedItem;
          },
          (i, resolvedItem, completed) => {
            merged[i] = resolvedItem;
            const shouldFlushEarly = completed <= EARLY_FLUSH_UNTIL;
            if (shouldFlushEarly || completed % FLUSH_EVERY === 0 || completed === uniqueDataList.length) {
              setAllResolved([...merged]);
            }
          }
        );

        setAllResolved(enriched);
      } catch (e) {
        console.error(e);
      } finally {
        setTmdbEnriching(false);
        setListLoading(false);
      }
    };
    loadData();
  }, []);

  return (
    <div className="min-h-screen bg-darkBG font-sans flex flex-col overflow-x-hidden pt-24 animate-page-enter">
      <Navbar
        onMeClick={() => setShowLoginModal(true)}
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />

      <div className="px-6 md:px-[60px] pb-12 w-full max-w-[1400px] mx-auto">
        {/* Type Tabs */}
        <div className="flex gap-8 mb-6 border-b border-white/10 w-full overflow-x-auto no-scrollbar">
          {['All', 'Drama', 'Movie', 'Variety Show', 'Anime'].map(t => {
            const isActive = activeType === t;
            return (
              <button
                key={t}
                onClick={() => handleFilterClick('type', t)}
                className={`pb-3 text-[18px] md:text-[22px] font-bold transition-colors whitespace-nowrap relative ${isActive ? 'text-white' : 'text-gray-400 hover:text-white'}`}
              >
                {t}
                {isActive && (
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[70%] h-[3px] bg-[#00dc41] rounded-t-full"></div>
                )}
              </button>
            );
          })}
        </div>

        {/* Filter Section */}
        <div className="flex flex-col gap-4 mb-10 w-full overflow-hidden">
          <div className="flex items-start">
            <div className="w-[80px] shrink-0 text-gray-400 text-[14px] font-medium pt-1.5 align-middle">
              Region
            </div>
            <div className="flex flex-wrap gap-2">
              {REGIONS.map(reg => {
                const isActive = activeRegion === reg;
                return (
                  <button
                    key={reg}
                    onClick={() => handleFilterClick('region', reg)}
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${isActive ? 'bg-[#1a2b22] text-[#00dc41]' : 'bg-[#1a1c22] text-gray-300 hover:text-white hover:bg-[#252830]'
                      }`}
                  >
                    {reg}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-start">
            <div className="w-[80px] shrink-0 text-gray-400 text-[14px] font-medium pt-1.5 align-middle">
              Category
            </div>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(cat => {
                const isActive = activeCategory === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => handleFilterClick('category', cat)}
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${isActive ? 'bg-[#1a2b22] text-[#00dc41]' : 'bg-[#1a1c22] text-gray-300 hover:text-white hover:bg-[#252830]'
                      }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-start mt-4">
            <div className="w-[80px] shrink-0 text-gray-400 text-[14px] font-medium pt-1.5 align-middle">
              Sort
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { key: 'default', label: 'Default' },
                { key: 'rating_desc', label: 'Rating (highest)' },
                { key: 'rating_asc', label: 'Rating (lowest)' },
              ].map(({ key, label }) => {
                const isOn = key === 'default' ? sortBy === 'default' : sortBy === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSortClick(key)}
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                      isOn ? 'bg-[#1a2b22] text-[#00dc41]' : 'bg-[#1a1c22] text-gray-300 hover:text-white hover:bg-[#252830]'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        

        {/* Filter Results */}
        <div className="border-t border-white/5 pt-8">
          {listLoading ? (
            <div className="flex justify-center mt-20">
              <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filteredSorted.length > 0 ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
                {visibleItems.map((item, idx) => (
                  <div
                    key={`${item.media_type || item.type || 'x'}:${item.folder_name || item.path || item.id || idx}`}
                    className="flex justify-center animate-fade-in-up"
                    style={{ animationDelay: `${Math.min(idx % GRID_PAGE_SIZE, 11) * 40}ms` }}
                  >
                    <MovieCard
                      item={item}
                      delay={idx % GRID_PAGE_SIZE}
                      posterFadeIn
                      isAdmin={isAdmin}
                      onEditPoster={(it) => setPosterEditItem(it)}
                    />
                  </div>
                ))}
              </div>
              {visibleCount < filteredSorted.length && (
                <div ref={loadMoreSentinelRef} className="h-16 w-full flex items-center justify-center py-6">
                  <div className="w-8 h-8 border-2 border-white/20 border-t-[#00dc41] rounded-full animate-spin" />
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-400 mt-10 text-center py-20 bg-[#16181d] rounded-lg border border-white/5">
              No content matches the selected filters.
            </div>
          )}
        </div>
      </div>
      {posterEditItem && (
        <TmdbPosterEditModal
          item={posterEditItem}
          onClose={() => setPosterEditItem(null)}
          onSaved={() => {
            setPosterEditItem(null);
            window.location.reload();
          }}
        />
      )}
      <Footer />
    </div>
  );
};

export default FilterPage;
