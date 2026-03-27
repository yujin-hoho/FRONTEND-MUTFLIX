import { useEffect, useState, useCallback, useRef } from 'react';
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
  const tmdbEnrichRef = useRef(false);

  const QUICK_FILTERS = [
    { label: 'All Videos', path: '/filter' },
    { label: 'Chinese Mainland', path: '/filter?region=Chinese Mainland' },
    { label: 'South Korea', path: '/filter?region=South Korea' },
    { label: 'Southeast Asia', path: '/filter?region=Southeast Asia' },
    { label: 'America', path: '/filter?region=America' },
    { label: 'Variety Show', path: '/filter?category=Variety Show' },
  ];

  // Process raw folders+releases into display data
  const processData = useCallback((foldersResp, releasesResp) => {
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
    return shuffleArray(Array.from(uniqueDataMap.values()));
  }, []);

  // Build genre sections from items (with or without TMDB data)
  const buildSections = useCallback((items) => {
    const tempGenreMap = {};
    items.forEach(item => {
      const genreIds = item.tmdb_genre_ids || [];
      const genres = genreIds.map(id => TMDB_GENRES[id]).filter(Boolean);

      if (genres.length === 0) {
        if (!tempGenreMap["Trending"]) tempGenreMap["Trending"] = [];
        tempGenreMap["Trending"].push(item);
      } else {
        genres.slice(0, 2).forEach(g => {
          if (!tempGenreMap[g]) tempGenreMap[g] = [];
          if (!tempGenreMap[g].find(i => (i.folder_name || i.name) === (item.folder_name || item.name))) {
            tempGenreMap[g].push(item);
          }
        });
      }
    });

    let sections = Object.keys(tempGenreMap)
      .filter(k => tempGenreMap[k].length >= 4)
      .map(k => ({ title: k, items: tempGenreMap[k] }))
      .sort((a, b) => b.items.length - a.items.length);

    if (sections.length === 0 && items.length > 0) {
      sections = [
        { title: "Trending", items: items.slice(0, 10), tagType: "top" },
        { title: "New Releases", items: items.slice(10, 20), tagType: "free" },
        { title: "Discover", items: items.slice(20, 30) }
      ];
    }

    return sections.slice(0, 8);
  }, []);

  // Phase 2: TMDB enrichment (background, non-blocking)
  const enrichWithTMDB = useCallback(async (items) => {
    if (tmdbEnrichRef.current) return; // Already running
    tmdbEnrichRef.current = true;

    const sampleForGenres = items.slice(0, 30);
    const resolvedItems = [...items]; // Copy so we can update in-place

    const tmdbPromises = sampleForGenres.map(async (item, idx) => {
      const title = item.tmdb_title || item.folder_name || item.name;
      if (!title) return;

      const hasEnoughInfo = item.tmdb_poster_path && item.tmdb_genre_ids && item.tmdb_genre_ids.length > 0;
      if (hasEnoughInfo) return;

      const data = await getTMDBInfo(title);
      if (!data) return;

      const resolvedItem = { ...item };
      if (data.poster_path) resolvedItem.tmdb_poster_path = data.poster_path;
      resolvedItem.tmdb_backdrop_path = data.backdrop_path || item.tmdb_backdrop_path;
      resolvedItem.tmdb_genre_ids = data.genre_ids || item.tmdb_genre_ids || [];
      resolvedItem.tmdb_overview = data.overview || item.tmdb_overview;
      resolvedItem.tmdb_rating = data.rating || item.tmdb_rating;

      resolvedItems[idx] = resolvedItem;
    });

    await Promise.allSettled(tmdbPromises);

    // Rebuild sections with enriched data
    setFeaturedList(resolvedItems.slice(0, 6));
    setGenreSections(buildSections(resolvedItems));
    tmdbEnrichRef.current = false;
  }, [buildSections]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      const [foldersResp, releasesResp] = await Promise.all([
        fetchFolders(),
        fetchContentReleases()
      ]);

      const shuffledData = processData(foldersResp, releasesResp);

      // PHASE 1: Show content immediately (no TMDB wait)
      setFeaturedList(shuffledData.slice(0, 6));
      setGenreSections(buildSections(shuffledData));
      setLoading(false);

      // PHASE 2: Enrich with TMDB data in background (non-blocking)
      enrichWithTMDB(shuffledData);

    } catch (error) {
      console.error("Error loading dashboard data:", error);
      setLoading(false);
    }
  }, [processData, buildSections, enrichWithTMDB]);

  useEffect(() => {
    tmdbEnrichRef.current = false;
    loadData();
  }, [loadData]);

  const handleLoginSuccess = (data) => {
    setAuthUser({ username: data.username, role: data.role });
    tmdbEnrichRef.current = false;
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

