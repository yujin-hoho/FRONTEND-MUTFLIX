import { useEffect, useState } from 'react';
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
  
  // Southeast Asia fallback for region mapping
  if (['id', 'th', 'ms'].includes(lang)) return 'Southeast Asia';
  
  return 'Other';
};

const FilterPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const activeType = searchParams.get('type') || 'Drama';
  const activeRegion = searchParams.get('region') || 'All regions';
  const activeCategory = searchParams.get('category') || 'All Genres';
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  
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
        
        // Resolve TMDB data for filtering precision (top 150 items for speed)
        const toResolve = uniqueDataList.slice(0, 150);
        const resolved = await Promise.all(toResolve.map(async (item) => {
           const title = item.tmdb_title || item.folder_name || item.name;
           if (!title) return { ...item, parsedCategories: [], parsedRegion: 'Other' };
           const tmdbData = await getTMDBInfo(title);
           if (tmdbData) {
               const parsedCategories = tmdbData.genre_ids ? tmdbData.genre_ids.map(id => TMDB_GENRES[id]).filter(Boolean) : [];
               const resolvedItem = {
                   ...item,
                   tmdb_poster_path: tmdbData.poster_path || item.tmdb_poster_path,
                   tmdb_rating: tmdbData.rating || item.tmdb_rating,
                   tmdb_genre_ids: tmdbData.genre_ids,
                   original_language: tmdbData.original_language,
                   origin_country: tmdbData.origin_country,
                   parsedCategories
               };
               resolvedItem.parsedRegion = getRegionMapping(resolvedItem);
               return resolvedItem;
           }
           return { ...item, parsedCategories: [], parsedRegion: 'Other' };
        }));

        let filtered = resolved;

        if (activeType === 'Movie') {
          filtered = filtered.filter(item => item.media_type === 'movie' || item.type === 'movie' || (!item.episodes && !item.first_air_date));
        } else if (activeType === 'Drama') {
          filtered = filtered.filter(item => item.media_type === 'tv' || item.type === 'series' || item.episodes || item.first_air_date);
        } else if (activeType === 'Anime') {
          filtered = filtered.filter(item => item.parsedCategories.includes('Animation'));
        } else if (activeType === 'Variety Show') {
          filtered = filtered.filter(item => item.parsedCategories.includes('Talk') || item.parsedCategories.includes('Reality') || item.parsedCategories.includes('Documentary'));
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
             // For fuzzy matching specific IQIYI genres that might map differently from TMDB
             if (activeCategory === 'Youth' || activeCategory === 'Sweet Love' || activeCategory === 'Friendship') {
                 return item.parsedCategories.includes('Romance') || item.parsedCategories.includes('Family');
             }
             if (activeCategory === 'Crime' || activeCategory === 'Mystery' || activeCategory === 'Urban') {
                 return item.parsedCategories.includes('Crime') || item.parsedCategories.includes('Mystery') || item.parsedCategories.includes('Thriller');
             }
             if (activeCategory === 'Costume' || activeCategory === 'Ancient') {
                 return item.parsedCategories.includes('History') || item.parsedCategories.includes('War');
             }
             if (activeCategory === 'Variety Show') {
                 return item.parsedCategories.includes('Talk') || item.parsedCategories.includes('Reality') || item.parsedCategories.includes('Documentary');
             }
             if (activeCategory === 'Novel Adaptation') {
                 return item.parsedCategories.includes('Drama') || item.parsedCategories.includes('Fantasy');
             }
             return item.parsedCategories.includes(activeCategory);
          });
        }

        setResults(filtered);
      } catch(e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [activeRegion, activeCategory]);

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

        {/* Filter Section representing iQIYI standard UI */}
        <div className="flex flex-col gap-4 mb-10 w-full overflow-hidden">
          {/* Region Row */}
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
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                      isActive ? 'bg-[#1a2b22] text-[#00dc41]' : 'bg-[#1a1c22] text-gray-300 hover:text-white hover:bg-[#252830]'
                    }`}
                  >
                    {reg}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Category Row */}
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
                    className={`px-4 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                      isActive ? 'bg-[#1a2b22] text-[#00dc41]' : 'bg-[#1a1c22] text-gray-300 hover:text-white hover:bg-[#252830]'
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
