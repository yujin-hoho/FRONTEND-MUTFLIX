import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import HeroBanner from '../components/HeroBanner';
import MovieCarousel from '../components/MovieCarousel';
import LoginModal from '../components/LoginModal';
import Footer from '../components/Footer';
import { fetchFolders, logout, getTMDBInfo, TMDB_GENRES, fetchProfiles, fetchHistory, cacheClear } from '../services/api';

const shuffleArray = (array) => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

const getSafeArray = (resp, type) => {
  if (!resp || typeof resp.then === 'function') return [];
  if (Array.isArray(resp)) return resp;
  
  // Handle the object structure from /api/folders
  if (type === 'folders') {
    return [...(resp.movies || []), ...(resp.series || [])];
  }
  
  return [];
};

const Dashboard = () => {
  const navigate = useNavigate();
  const [featuredList, setFeaturedList] = useState([]);
  const [genreSections, setGenreSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [continueWatching, setContinueWatching] = useState([]);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });
  const [celebrities, setCelebrities] = useState([]);
  const [hiddenHistory, setHiddenHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('mutflix_hidden_history');
      return saved ? JSON.parse(saved) : [];
    } catch (e) { return []; }
  });
  const [removingItemPath, setRemovingItemPath] = useState(null);

  const fetchIdRef = useRef(0);

  const QUICK_FILTERS = [
    { label: 'All Videos', path: '/filter' },
    { label: 'Chinese Mainland', path: '/filter?region=Chinese Mainland' },
    { label: 'South Korea', path: '/filter?region=South Korea' },
    { label: 'Southeast Asia', path: '/filter?region=Southeast Asia' },
    { label: 'America', path: '/filter?region=America' },
    { label: 'Variety Show', path: '/filter?category=Variety Show' },
  ];

  // Process raw folders into display data
  const processData = useCallback((foldersResp) => {
    const foldersData = getSafeArray(foldersResp, 'folders');
    return shuffleArray(foldersData);
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
          const itemName = (item.folder_name || item.name || '').trim().toLowerCase();
          if (itemName && !tempGenreMap[g].find(i => (i.folder_name || i.name || '').trim().toLowerCase() === itemName)) {
            tempGenreMap[g].push(item);
          }
        });
      }
    });

    let sections = Object.keys(tempGenreMap)
      .filter(k => tempGenreMap[k].length >= 4)
      .map(k => ({ title: k, items: tempGenreMap[k] }))
      .sort((a, b) => b.items.length - a.items.length);

    // Top 10 section based on TMDB Rating
    const top10Items = [...items]
      .sort((a, b) => (b.tmdb_rating || 0) - (a.tmdb_rating || 0))
      .slice(0, 10);
    
    const top10Section = { title: "Top 10", items: top10Items, tagType: "top" };
    
    // Replace first section or prepend Top 10
    // The user explicitly wanted the first section (Daram/Drama) to become Top 10
    sections = [top10Section, ...sections.filter(s => s.title !== "Trending" && s.title !== "Drama" && s.title !== "Daram")];

    if (sections.length === 0 && items.length > 0) {
      sections = [
        { title: "Trending", items: items.slice(0, 10), tagType: "top" },
        { title: "New Releases", items: items.slice(10, 20), tagType: "free" },
        { title: "Discover", items: items.slice(20, 30) }
      ];
    }

    return sections.slice(0, 8);
  }, []);

  // Phase 2: TMDB enrichment
  const enrichWithTMDB = useCallback(async (items, currentFetchId) => {
    const resolvedItems = [...items]; // Copy so we can update in-place
    const tmdbPromises = [];
    let apiFetchCount = 0;
    const MAX_API_CALLS = 40;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const title = item.tmdb_title || item.folder_name || item.name;
      if (!title) continue;

      const hasBaseInfo = item.tmdb_poster_path && item.tmdb_genre_ids && item.tmdb_genre_ids.length > 0;

      const cleanTitle = title.replace(/\(\d{4}\)/g, '').trim();
      const cacheKey = `mutflix_tmdb_info_${cleanTitle.toLowerCase()}`;
      const cached = localStorage.getItem(cacheKey);
      let data = null;

      if (cached) {
        try { data = JSON.parse(cached); } catch (e) { }
      }

      if (data) {
        const resolvedItem = { ...item };
        if (data.poster_path) resolvedItem.tmdb_poster_path = data.poster_path;
        resolvedItem.tmdb_backdrop_path = data.backdrop_path || item.tmdb_backdrop_path;
        resolvedItem.tmdb_genre_ids = data.genre_ids || (data.genres ? data.genres.map(g => g.id) : null) || item.tmdb_genre_ids || [];
        resolvedItem.tmdb_overview = data.overview || item.tmdb_overview;
        resolvedItem.tmdb_rating = data.rating || item.tmdb_rating;
        resolvedItem.tmdb_cast = data.cast || [];
        resolvedItems[idx] = resolvedItem;
      } else if (!hasBaseInfo && apiFetchCount < MAX_API_CALLS) {
        apiFetchCount++;
        tmdbPromises.push(
          getTMDBInfo(title).then(apiData => {
            if (apiData) {
              const resolvedItem = { ...item };
              if (apiData.poster_path) resolvedItem.tmdb_poster_path = apiData.poster_path;
              resolvedItem.tmdb_backdrop_path = apiData.backdrop_path || item.tmdb_backdrop_path;
              resolvedItem.tmdb_genre_ids = apiData.genre_ids || (apiData.genres ? apiData.genres.map(g => g.id) : null) || item.tmdb_genre_ids || [];
              resolvedItem.tmdb_overview = apiData.overview || item.tmdb_overview;
              resolvedItem.tmdb_rating = apiData.rating || item.tmdb_rating;
              resolvedItem.tmdb_cast = apiData.cast || [];
              resolvedItems[idx] = resolvedItem;
            }
          })
        );
      }
    }

    await Promise.allSettled(tmdbPromises);

    if (fetchIdRef.current !== currentFetchId) return;

    // Extract celebrities and count appearances
    const castCounts = {};
    const castProfiles = {};
    resolvedItems.forEach(item => {
      if (item.tmdb_cast && Array.isArray(item.tmdb_cast)) {
        item.tmdb_cast.forEach(actor => {
          if (actor.profile_path) {
            castCounts[actor.id] = (castCounts[actor.id] || 0) + 1;
            castProfiles[actor.id] = actor;
          }
        });
      }
    });

    const sortedActors = Object.values(castProfiles)
      .sort((a, b) => castCounts[b.id] - castCounts[a.id]);

    // Take top 40 most relevant actors, shuffle them, then pick 15 to show
    const poolSize = Math.min(sortedActors.length, 40);
    const topActors = shuffleArray(sortedActors.slice(0, poolSize)).slice(0, 15);

    setCelebrities(topActors);

    // Rebuild sections with enriched data
    setFeaturedList(resolvedItems.slice(0, 6));
    setGenreSections(buildSections(resolvedItems));
  }, [buildSections]);
  const loadData = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current;
    
    // Helper to update dashboard state safely
    const updateVisuals = (data, id) => {
      if (id !== fetchIdRef.current) return;
      if (data && data.length > 0) {
        setFeaturedList(data.slice(0, 6));
        setGenreSections(buildSections(data));
        setLoading(false);
      }
    };

    try {
      setLoading(true);

      const foldersResp = await fetchFolders((fresh) => {
        const data = processData(fresh);
        updateVisuals(data, currentFetchId);
      });

      if (fetchIdRef.current !== currentFetchId) return;

      // Check for unauthorized error
      if (foldersResp?.status === 401) {
        console.warn("Unauthorized API access - dashboard items may be limited.");
      }

      const shuffledData = processData(foldersResp);

      // SHOW CONTENT INSTANTLY (even if empty, to stop shimmer/loading)
      updateVisuals(shuffledData, currentFetchId);
      if (shuffledData.length === 0) {
        setLoading(false);
      }

      // BACKGROUND TASKS: Always fetch history if user is logged in, and enrich metadata
      const historyPromise = authUser ? (async () => {
        try {
          const profiles = await fetchProfiles();
          if (profiles.length > 0 && fetchIdRef.current === currentFetchId) {
            const allHistories = await Promise.all(
              profiles.map(p => fetchHistory(p.id))
            );
            
            if (fetchIdRef.current !== currentFetchId) return;

            const flatHistory = allHistories.flat();
            const uniqueHistoryMap = new Map();
            flatHistory.sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));
            
            flatHistory.forEach(h => {
               const progress = (h.position_ms / h.duration_ms) * 100;
               if (!uniqueHistoryMap.has(h.media_path) && h.position_ms >= 5000 && progress < 95) {
                 uniqueHistoryMap.set(h.media_path, {
                   ...h,
                   name: h.series_title || h.media_title,
                   poster: h.still_path,
                   folder_name: h.series_title || h.media_title,
                   progress: progress
                 });
               }
            });
            
            setContinueWatching(
              Array.from(uniqueHistoryMap.values())
                .filter(h => !hiddenHistory.includes(h.media_path))
                // Extra safety: deduplicate by folder_name (title) for the UI
                .filter((item, index, self) => 
                  index === self.findIndex((t) => (t.folder_name === item.folder_name))
                )
                .slice(0, 15)
            );
          }
        } catch (e) { console.error("History fetch error:", e); }
      })() : Promise.resolve();

      // Parallel background tasks
      await Promise.allSettled([
        enrichWithTMDB(shuffledData, currentFetchId),
        historyPromise
      ]);

    } catch (error) {
      console.error("Error loading dashboard data:", error);
      if (fetchIdRef.current === currentFetchId) setLoading(false);
    }
  }, [processData, buildSections, enrichWithTMDB, authUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleLoginSuccess = (data) => {
    cacheClear(); // Clear any "Token missing" cached errors
    setAuthUser({ username: data.username, role: data.role });
    loadData();
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleDeleteHistory = async (item) => {
    if (!item.media_path) return;
    
    // Satisfying deletion effect:
    setRemovingItemPath(item.media_path);
    
    // Delay actual removal to allow animation to play
    setTimeout(() => {
      const newHidden = [...hiddenHistory, item.media_path];
      setHiddenHistory(newHidden);
      localStorage.setItem('mutflix_hidden_history', JSON.stringify(newHidden));
      
      setContinueWatching(prev => prev.filter(h => h.media_path !== item.media_path));
      setRemovingItemPath(null);
    }, 400); // match animation duration
  };


  if (loading) {
    return (
      <div className="min-h-screen bg-darkBG flex flex-col items-center justify-center">
        <div className="w-14 h-14 border-4 border-brand border-t-transparent rounded-full animate-spin mt-[-10vh] shadow-[0_0_15px_rgba(0,220,65,0.3)]"></div>
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

      <main className="w-full pt-20">
        <HeroBanner items={featuredList} />

        <div className="mt-10 pb-12">
          {genreSections.length > 0 && (
            <div className="mb-4">
              <MovieCarousel
                title={genreSections[0].title}
                items={genreSections[0].items}
                tagType={genreSections[0].tagType || 'top'}
              />
            </div>
          )}

          {/* Continue Watching should appear under Top 10 */}
          {continueWatching.length > 0 && (
            <div className="mb-8 -mt-2">
              <MovieCarousel
                title="Continue Watching"
                items={continueWatching}
                variant="horizontal"
                onDelete={handleDeleteHistory}
                removingId={removingItemPath}
              />
            </div>
          )}

          {genreSections.length > 0 && (
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

          {genreSections.slice(1).map((section, idx) => (
            <React.Fragment key={section.title}>
              <div className="mb-4">
                <MovieCarousel
                  title={section.title}
                  items={section.items}
                  tagType={section.tagType || ((idx + 1) % 3 === 0 ? 'free' : null)}
                />
              </div>

              {idx === Math.min(4, Math.max(0, genreSections.slice(1).length - 1)) && celebrities.length > 0 && (
                <CelebrityCarousel castList={celebrities} />
              )}
            </React.Fragment>
          ))}
        </div>
      </main>

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={handleLoginSuccess}
      />
      <Footer />
    </div>
  );
};

export default Dashboard;

const CelebrityCarousel = ({ castList }) => {
  const navigate = useNavigate();
  const scrollRef = useRef(null);

  if (!castList || castList.length === 0) return null;

  return (
    <div className="mb-10 px-6 md:px-[60px] w-full relative group/carousel flex flex-col items-center animate-fade-in-up">
      <div className="w-full flex items-center justify-between mb-4">
        <h2 className="text-[20px] md:text-[22px] font-bold text-[#f5f5f5] tracking-wide">Popular Celebrities</h2>
      </div>

      <div className="relative w-full">
        <button
          onClick={() => scrollRef.current?.scrollBy({ left: -300, behavior: 'smooth' })}
          className="absolute -left-5 md:-left-12 lg:-left-12 top-[35%] -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>

        <button
          onClick={() => scrollRef.current?.scrollBy({ left: 300, behavior: 'smooth' })}
          className="absolute -right-5 md:-right-12 lg:-right-12 top-[35%] -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>

        <div ref={scrollRef} className="flex gap-5 md:gap-8 overflow-x-auto no-scrollbar scroll-smooth w-full pb-4 snap-x">
          {castList.map((actor, idx) => (
            <div
              key={actor.id || idx}
              className="flex flex-col items-center cursor-pointer group snap-start shrink-0"
              onClick={() => navigate(`/search?q=${encodeURIComponent(actor.name)}`)}
            >
              <div className="w-[85px] h-[85px] md:w-[130px] md:h-[130px] rounded-full overflow-hidden bg-[#22252b] border-[3px] border-transparent group-hover:border-[#00dc41]/70 transition-all duration-300 mb-3 shadow-lg group-hover:shadow-[0_0_15px_rgba(0,220,65,0.3)] shrink-0">
                <img src={actor.profile_path} alt={actor.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500 bg-center" />
              </div>
              <p className="text-white text-[13px] md:text-[15px] font-medium text-center w-[90px] md:w-[140px] truncate group-hover:text-[#00dc41] transition-colors">{actor.name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

