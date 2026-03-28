import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { MovieCard } from '../components/MovieCarousel';
import { fetchFolders, getTMDBInfo, TMDB_GENRES, logout } from '../services/api';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';

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

/** Pool agar semua item bisa di-enrich tanpa membanjiri TMDB sekaligus */
const TMDB_FILTER_CONCURRENCY = 5;
const MAX_TMDB_ENRICH_FILTER = 500;

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await mapper(items[i], i);
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

const FilterPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const activeType = searchParams.get('type') || 'All';
  const activeRegion = searchParams.get('region') || 'All regions';
  const activeCategory = searchParams.get('category') || 'All Genres';
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [allResolved, setAllResolved] = useState([]);

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });

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

  // Re-filter when filter params change (no re-fetch needed)
  useEffect(() => {
    if (allResolved.length > 0) {
      setResults(filterItems(allResolved, activeType, activeRegion, activeCategory));
    }
  }, [activeType, activeRegion, activeCategory, allResolved]);

  // Fetch data once, resolve TMDB progressively
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const foldersResp = await fetchFolders();

        let foldersData = [];
        if (foldersResp && typeof foldersResp === 'object' && !Array.isArray(foldersResp)) {
          foldersData = [...(foldersResp.movies || []), ...(foldersResp.series || [])];
        } else if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
        }

        let uniqueDataList = foldersData;

        // PHASE 1: Show results immediately with whatever data we have
        const quickResolved = uniqueDataList.map(item => {
          const srcGenreIds = item.tmdb_genre_ids;
          const parsedCategories = srcGenreIds ? srcGenreIds.map(id => TMDB_GENRES[id]).filter(Boolean) : [];
          const resolved = { ...item, parsedCategories };
          resolved.parsedRegion = getRegionMapping(resolved);
          return resolved;
        });
        setAllResolved(quickResolved);
        // setLoading(false); // We now wait for enrichment below

        // PHASE 2: Enrich seluruh daftar (urutan tetap). TV tanpa metadata diprioritaskan; max 500 hit TMDB per load.
        const needFetchIndices = uniqueDataList
          .map((item, i) => ({ i, item }))
          .filter(({ item }) => !(item.tmdb_poster_path && item.tmdb_genre_ids));
        needFetchIndices.sort((a, b) => {
          const at = inferTmdbMediaType(a.item) === 'tv' ? 0 : 1;
          const bt = inferTmdbMediaType(b.item) === 'tv' ? 0 : 1;
          return at - bt;
        });
        const mayCallTmdb = new Set(
          needFetchIndices.slice(0, MAX_TMDB_ENRICH_FILTER).map(({ i }) => i)
        );

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

            const mediaType = inferTmdbMediaType(item);
            const hasEnoughInfo = item.tmdb_poster_path && item.tmdb_genre_ids;
            let tmdbData = null;
            if (!hasEnoughInfo && mayCallTmdb.has(index)) {
              tmdbData = await getTMDBInfo(title, mediaType ? { mediaType } : {});
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
              tmdb_poster_path: tmdbData?.poster_path || item.tmdb_poster_path,
              tmdb_rating: tmdbData?.rating || item.tmdb_rating,
              tmdb_genre_ids: srcGenreIds,
              original_language: tmdbData?.original_language || item.original_language,
              origin_country: tmdbData?.origin_country || item.origin_country,
              parsedCategories,
            };
            resolvedItem.parsedRegion = getRegionMapping(resolvedItem);
            return resolvedItem;
          }
        );

        const finalResolved = enriched;

        setAllResolved(finalResolved);
        setLoading(false); // Ready!
      } catch (e) {
        console.error(e);
        setLoading(false);
      }
    };
    loadData();
  }, []);

    if (loading) return <LoadingScreen />;

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
        </div>

        {/* Filter Results */}
        <div className="border-t border-white/5 pt-8">
          {loading ? (
            <div className="flex justify-center mt-20">
              <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : results.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
              {results.map((item, idx) => (
                <div key={item.id || idx} className="flex justify-center">
                  <MovieCard item={item} />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-400 mt-10 text-center py-20 bg-[#16181d] rounded-lg border border-white/5">
              No content matches the selected filters.
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
};

export default FilterPage;

