import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import HeroBanner from '../components/HeroBanner';
import MovieCarousel from '../components/MovieCarousel';
import LoginModal from '../components/LoginModal';
import { fetchFolders, fetchContentReleases, logout, getTMDBInfo, TMDB_GENRES } from '../services/api';

const shuffleArray = (array) => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

const Dashboard = () => {
  const navigate = useNavigate();
  const [featuredList, setFeaturedList] = useState([]);
  const [genreSections, setGenreSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });

  const QUICK_FILTERS = [
    { label: 'All Videos', path: '/filter' },
    { label: 'Chinese Mainland', path: '/filter?region=Chinese Mainland' },
    { label: 'South Korea', path: '/filter?region=South Korea' },
    { label: 'Southeast Asia', path: '/filter?region=Southeast Asia' },
    { label: 'America', path: '/filter?region=America' },
    { label: 'Variety Show', path: '/filter?category=Variety Show' },
  ];

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
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
      
      // Combine and unique
      let allData = [...releasesData, ...foldersData];
      const uniqueDataMap = new Map();
      allData.forEach(item => {
        const name = item.tmdb_title || item.folder_name || item.name;
        if (name && !uniqueDataMap.has(name)) uniqueDataMap.set(name, item);
      });
      let uniqueDataList = Array.from(uniqueDataMap.values());
      
      // Shuffle to make it dynamic every refresh
      const shuffledData = shuffleArray(uniqueDataList);
      
      // Remove loading state release here so we wait for genres
      // --- ASYNC GENRE GROUPING LOGIC ---
      // We take a sample of 50 items so we don't spam the network completely
      const sampleForGenres = shuffledData.slice(0, 50);
      const tempGenreMap = {};
      const resolvedItems = [];
      
      const tmdbPromises = sampleForGenres.map(async (item) => {
        const title = item.tmdb_title || item.folder_name || item.name;
        if (!title) {
          resolvedItems.push(item);
          return { item, genres: [] };
        }
        // We only fetch if it's missing TMDB poster/overview natively from backend
        const data = await getTMDBInfo(title);
        const resolvedItem = data?.poster_path ? { ...item, tmdb_poster_path: data.poster_path } : item;
        
        // Also add genres to the item object so HeroBanner has them
        resolvedItem.tmdb_backdrop_path = data?.backdrop_path || item.tmdb_backdrop_path;
        resolvedItem.tmdb_genre_ids = data?.genre_ids || [];
        resolvedItem.tmdb_overview = data?.overview || item.tmdb_overview;
        resolvedItem.tmdb_rating = data?.rating || item.tmdb_rating;
        
        resolvedItems.push(resolvedItem);
        return {
           item: resolvedItem, 
           genres: data?.genre_ids ? data.genre_ids.map(id => TMDB_GENRES[id]).filter(Boolean) : []
        };
      });

      const results = await Promise.allSettled(tmdbPromises);
      
      // Update featuredlist with RESOLVED items so HeroBanner doesn't need to fetch TMDB
      setFeaturedList(resolvedItems.slice(0, 6));
      
      results.forEach(res => {
        if (res.status === 'fulfilled' && res.value) {
           const { item, genres } = res.value;
           if (genres.length === 0) {
              if (!tempGenreMap["Trending"]) tempGenreMap["Trending"] = [];
              tempGenreMap["Trending"].push(item);
           } else {
              // Assign to top 2 genres
              genres.slice(0, 2).forEach(g => {
                const categoryName = g; // the user explicitly requested to drop "Movies & Series"
                if (!tempGenreMap[categoryName]) tempGenreMap[categoryName] = [];
                // Prevent duplicate insertions
                if (!tempGenreMap[categoryName].find(i => (i.folder_name || i.name) === (item.folder_name || item.name))) {
                   tempGenreMap[categoryName].push(item);
                }
              });
           }
        }
      });
      
      // Convert map to array and filter out sparse categories
      let sections = Object.keys(tempGenreMap)
         .filter(k => tempGenreMap[k].length >= 4)
         .map(k => ({ title: k, items: tempGenreMap[k] }))
         .sort((a, b) => b.items.length - a.items.length); // Sort by most items first
         
      // Fallback if no sections built
      if (sections.length === 0 && shuffledData.length > 0) {
         sections = [
           { title: "Trending", items: shuffledData.slice(0, 10), tagType: "top" },
           { title: "New Releases", items: shuffledData.slice(10, 20), tagType: "free" },
           { title: "Discover", items: shuffledData.slice(20, 30) }
         ];
      }
      
      setGenreSections(sections.slice(0, 8)); // Max 8 sections
      
      // Release loading state AFTER parsing is completely done to prevent UI shifting
      setLoading(false);

    } catch (error) {
      console.error("Error loading dashboard data:", error);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  const handleLoginSuccess = (data) => {
    setAuthUser({ username: data.username, role: data.role });
    loadData();
  };

  const handleLogout = () => {
    logout();
    setAuthUser(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-darkBG flex flex-col items-center justify-center">
        <div className="w-14 h-14 border-4 border-brand border-t-transparent rounded-full animate-spin mb-6 mt-[-10vh] shadow-[0_0_15px_rgba(0,220,65,0.3)]"></div>
        <div className="text-brand font-black text-2xl tracking-[0.2em] animate-pulse">MUTFLIX</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-darkBG font-sans pb-20 overflow-x-hidden">
      <Navbar 
        onMeClick={() => setShowLoginModal(true)} 
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />
      
      <main className="w-full animate-page-enter">
        <HeroBanner items={featuredList} />
        <div className="-mt-16 md:-mt-24 relative z-20 pb-12">
          {/* Genre Sections */}
          {genreSections.map((section, idx) => {
            const crimeIdx = genreSections.findIndex(s => s.title === 'Crime');
            const targetIdx = crimeIdx !== -1 ? crimeIdx : 1;
            
            return (
              <div key={section.title} className="mb-4">
                <MovieCarousel 
                  title={section.title} 
                  items={section.items} 
                  tagType={section.tagType || (idx === 0 ? 'top' : idx % 3 === 0 ? 'free' : null)} 
                />
                
                {idx === targetIdx && (
                  <div className="px-6 md:px-[60px] mb-4 -mt-2 w-full">
                    <div className="flex gap-3 overflow-x-auto no-scrollbar">
                      {QUICK_FILTERS.map(f => (
                        <button 
                          key={f.label} 
                          onClick={() => navigate(f.path)}
                          className="bg-[#1a1c22] hover:bg-[#2a2c33] text-gray-300 hover:text-white px-5 py-2.5 rounded-md text-[14px] font-medium whitespace-nowrap transition-colors border border-white/5 flex items-center gap-2"
                        >
                          {f.label === 'All Videos' && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                          )}
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* The original instruction had a syntax error here, assuming it meant to replace the entire genreSections rendering logic.
              However, to maintain functionality and avoid introducing new undefined variables like `genreGroups` and `regularList`,
              I'm keeping the existing `genreSections` rendering but applying the new wrapper div and styling.
              If `genreGroups` and `regularList` are intended to be new state variables, they need to be defined.
              For now, I'm interpreting the instruction as modifying the loading state and the structure around the existing content display.
          */}
        </div>
      </main>

      <LoginModal 
        isOpen={showLoginModal} 
        onClose={() => setShowLoginModal(false)} 
        onLoginSuccess={handleLoginSuccess}
      />
    </div>
  );
};

export default Dashboard;
