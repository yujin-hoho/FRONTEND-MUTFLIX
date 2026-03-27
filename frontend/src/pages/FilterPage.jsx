import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { MovieCard } from '../components/MovieCarousel';
import { fetchFolders, fetchContentReleases, getTMDBInfo, TMDB_GENRES, logout } from '../services/api';

const REGIONS = ['All regions', 'Chinese Mainland', 'South Korea', 'Indonesia', 'Thailand', 'Taiwan', 'Japan', 'Malaysia', 'America', 'UK'];
const CATEGORIES = ['All Genres', 'Youth', 'Mystery', 'Costume', 'Urban', 'Romance', 'Sweet Love', 'Marriage', 'Drama', 'Comedy', 'Family', 'Friendship', 'Fantasy', 'Crime', 'War', 'Novel Adaptation', 'Contemporary', 'Ancient', 'Variety Show'];

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

  if (activeType === 'Movie') {
    filtered = filtered.filter(item => item.media_type === 'movie' || item.type === 'movie' || (!item.episodes && !item.first_air_date));
  } else if (activeType === 'Drama') {
    filtered = filtered.filter(item => item.media_type === 'tv' || item.type === 'series' || item.episodes || item.first_air_date);
  } else if (activeType === 'Anime') {
    filtered = filtered.filter(item => item.parsedCategories?.includes('Animation'));
  } else if (activeType === 'Variety Show') {
    filtered = filtered.filter(item => item.parsedCategories?.includes('Talk') || item.parsedCategories?.includes('Reality') || item.parsedCategories?.includes('Documentary'));
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
        return cats.includes('Talk') || cats.includes('Reality') || cats.includes('Documentary');
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

  const activeType = searchParams.get('type') || 'Drama';
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
        const [foldersResp, releasesResp] = await Promise.all([
          fetchFolders(),
          fetchContentReleases()
        ]);

        let foldersData = [];
        if (foldersResp && typeof foldersResp === 'object' && !Array.isArray(foldersResp)) {
          foldersData = [...(foldersResp.movies || []), ...(foldersResp.series || [])];
        } else if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
        }

        let releasesData = Array.isArray(releasesResp) ? releasesResp : (releasesResp?.data || []);
        let allData = [...releasesData, ...foldersData];

        const uniqueDataMap = new Map();
        allData.forEach(item => {
          const name = item.tmdb_title || item.folder_name || item.name;
          if (name && !uniqueDataMap.has(name)) uniqueDataMap.set(name, item);
        });
        let uniqueDataList = Array.from(uniqueDataMap.values());

        // PHASE 1: Show results immediately with whatever data we have
        const quickResolved = uniqueDataList.map(item => {
          const srcGenreIds = item.tmdb_genre_ids;
          const parsedCategories = srcGenreIds ? srcGenreIds.map(id => TMDB_GENRES[id]).filter(Boolean) : [];
          const resolved = { ...item, parsedCategories };
          resolved.parsedRegion = getRegionMapping(resolved);
          return resolved;
        });
        setAllResolved(quickResolved);
        setLoading(false);

        // PHASE 2: Enrich with TMDB data in background
        const toResolve = uniqueDataList.slice(0, 80);
        const enriched = await Promise.all(toResolve.map(async (item) => {
          const title = item.tmdb_title || item.folder_name || item.name;
          if (!title) return { ...item, parsedCategories: [], parsedRegion: 'Other' };

          const hasEnoughInfo = item.tmdb_poster_path && item.tmdb_genre_ids;
          let tmdbData = null;
          if (!hasEnoughInfo) {
            tmdbData = await getTMDBInfo(title);
          }

          const srcGenreIds = tmdbData?.genre_ids || (tmdbData?.genres ? tmdbData.genres.map(g => g.id) : null) || item.tmdb_genre_ids;
          const parsedCategories = srcGenreIds ? srcGenreIds.map(id => TMDB_GENRES[id]).filter(Boolean) : [];

          const resolvedItem = {
            ...item,
            tmdb_poster_path: tmdbData?.poster_path || item.tmdb_poster_path,
            tmdb_rating: tmdbData?.rating || item.tmdb_rating,
            tmdb_genre_ids: srcGenreIds,
            original_language: tmdbData?.original_language || item.original_language,
            origin_country: tmdbData?.origin_country || item.origin_country,
            parsedCategories
          };
          resolvedItem.parsedRegion = getRegionMapping(resolvedItem);
          return resolvedItem;
        }));

        // Merge enriched items back into full list
        const enrichedMap = new Map();
        enriched.forEach(item => {
          const name = item.tmdb_title || item.folder_name || item.name;
          if (name) enrichedMap.set(name, item);
        });
        const finalResolved = uniqueDataList.map(item => {
          const name = item.tmdb_title || item.folder_name || item.name;
          return enrichedMap.get(name) || { ...item, parsedCategories: [], parsedRegion: 'Other' };
        });

        setAllResolved(finalResolved);
      } catch (e) {
        console.error(e);
        setLoading(false);
      }
    };
    loadData();
  }, []);

  return (
    <div className="min-h-screen bg-darkBG font-sans pb-20 overflow-x-hidden pt-24 animate-page-enter">
      <Navbar
        onMeClick={() => setShowLoginModal(true)}
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />

      <div className="px-6 md:px-[60px] pb-12 w-full max-w-[1400px] mx-auto">
        {/* Type Tabs */}
        <div className="flex gap-8 mb-6 border-b border-white/10 w-full overflow-x-auto no-scrollbar">
          {['Drama', 'Movie', 'Variety Show', 'Anime'].map(t => {
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
    </div>
  );
};

export default FilterPage;

