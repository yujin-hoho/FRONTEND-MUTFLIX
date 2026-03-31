import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, ArrowRight } from 'lucide-react';
import Navbar from '../components/Navbar';
import HeroBanner from '../components/HeroBanner';
import MovieCarousel from '../components/MovieCarousel';
import LoginModal from '../components/LoginModal';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';
import TmdbPosterEditModal from '../components/TmdbPosterEditModal';
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

const SectionDivider = () => (
  <div className="w-full max-w-[1400px] mx-auto px-6 md:px-[60px] py-3 md:py-4">
    <div className="h-px w-full bg-gradient-to-r from-transparent via-white/[0.09] to-transparent" />
  </div>
);

const BrowseMoreStrip = ({ onNavigate }) => (
  <div className="max-w-[1400px] mx-auto px-6 md:px-[60px] mb-8">
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br from-[#12151c] via-[#0c0e12] to-[#10131a] px-5 py-4 md:px-8 md:py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_80%_at_100%_0%,rgba(0,220,65,0.09),transparent_50%)]" />
      <div className="relative flex gap-3 items-start">
        <div className="mt-0.5 p-2 rounded-xl bg-[#00dc41]/10 border border-[#00dc41]/18">
          <Compass className="w-5 h-5 text-[#00dc41]" strokeWidth={2} />
        </div>
        <div>
          <p className="text-white text-[15px] font-semibold tracking-tight">Jelajahi koleksi</p>
          <p className="text-gray-500 text-[13px] mt-1 max-w-md leading-relaxed">
            Atur region, genre, dan urutkan rating di halaman filter — lebih lega dari deretan kartu tanpa henti.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => onNavigate('/filter')}
        className="relative shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#00dc41] to-[#00b837] text-black font-bold text-sm hover:brightness-110 transition shadow-[0_0_22px_rgba(0,220,65,0.22)]"
      >
        Buka filter
        <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
      </button>
    </div>
  </div>
);

const backdropOrPosterUrl = (item) => {
  const raw = item.tmdb_backdrop_path || item.tmdb_poster_path || item.poster_path || item.poster;
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  // Must match the rendition used by HeroBanner to get a cache hit.
  return `https://image.tmdb.org/t/p/w500${p}`;
};

/** Preload gambar di background (jangan await — jangan blokir paint) */
const preloadDashboardImages = (resolvedItems, continueWatchingItems, topActors = []) => {
  const urls = [];
  const push = (u) => {
    if (u && typeof u === 'string') urls.push(u);
  };
  resolvedItems.slice(0, 8).forEach((item) => push(backdropOrPosterUrl(item)));
  continueWatchingItems.slice(0, 8).forEach((h) => {
    if (h.poster && String(h.poster).startsWith('http')) push(h.poster);
    else push(backdropOrPosterUrl(h));
  });
  topActors.slice(0, 12).forEach((a) => push(a.profile_path));
  const unique = [...new Set(urls)];
  const run = () => {
    unique.forEach((url) => {
      const img = new Image();
      img.src = url;
    });
  };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 0);
  }
};

const tmdbOptsFromItem = (it) => {
  if (!it?.tmdb_query) return {};
  const o = {
    query: it.tmdb_query,
    mediaType: it.tmdb_override_media_type === 'movie' ? 'movie' : 'tv',
  };
  if (it.override_year != null && it.override_year !== '') o.year = Number(it.override_year);
  if (it.override_region) o.region = it.override_region;
  if (it.include_adult) o.includeAdult = true;
  return o;
};

const enrichFeaturedFast = async (items) => {
  const picks = (items || []).slice(0, 6);
  const jobs = picks.map(async (item) => {
    const title = item.tmdb_query || item.tmdb_title || item.folder_name || item.name;
    if (!title) return item;
    try {
      const data = await getTMDBInfo(title, { ...tmdbOptsFromItem(item), light: true });
      if (!data) return item;
      return {
        ...item,
          tmdb_title: data.tmdb_title || data.title || item.tmdb_title,
        tmdb_poster_path: item.tmdb_poster_path || item.poster_path || data.poster_path || data.backdrop_path,
        tmdb_backdrop_path: item.tmdb_backdrop_path || data.backdrop_path || data.poster_path,
        tmdb_overview: item.tmdb_overview || data.overview,
        tmdb_rating: item.tmdb_rating || data.rating,
        tmdb_genre_ids: item.tmdb_genre_ids?.length ? item.tmdb_genre_ids : (data.genre_ids || []),
      };
    } catch {
      return item;
    }
  });
  const resolved = await Promise.all(jobs);
  return [...resolved, ...items.slice(6)];
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
  const [posterEditItem, setPosterEditItem] = useState(null);

  const fetchIdRef = useRef(0);
  const isAdmin = authUser?.role === 'admin';

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

  // Hanya baris genre TMDB (tanpa Trending / New Releases / Discover).
  // Item tanpa tmdb_genre_ids tidak masuk map genre (tetap bisa di Hero & Top 10).
  const buildSections = useCallback((items) => {
    const tempGenreMap = {};
    items.forEach(item => {
      const genreIds = item.tmdb_genre_ids || [];
      const genres = genreIds.map(id => TMDB_GENRES[id]).filter(Boolean);
      if (genres.length === 0) return;

      genres.slice(0, 2).forEach(g => {
        if (!tempGenreMap[g]) tempGenreMap[g] = [];
        const itemName = (item.folder_name || item.name || '').trim().toLowerCase();
        if (itemName && !tempGenreMap[g].find(i => (i.folder_name || i.name || '').trim().toLowerCase() === itemName)) {
          tempGenreMap[g].push(item);
        }
      });
    });

    const genreRowsForMin = (min) =>
      Object.keys(tempGenreMap)
        .filter((k) => tempGenreMap[k].length >= min)
        .map((k) => ({ title: k, items: tempGenreMap[k] }))
        .sort((a, b) => b.items.length - a.items.length);

    let genreSections = genreRowsForMin(4);
    if (genreSections.length === 0) genreSections = genreRowsForMin(3);
    if (genreSections.length === 0) genreSections = genreRowsForMin(2);
    if (genreSections.length === 0) genreSections = genreRowsForMin(1);

    const top10Items = [...items]
      .sort((a, b) => (b.tmdb_rating || 0) - (a.tmdb_rating || 0))
      .slice(0, 10);

    const top10Section = { title: 'Top 10', items: top10Items, tagType: 'top' };
    const sections = [top10Section, ...genreSections];

    // Top 10 + lebih banyak baris genre (sebelumnya 8 total = hanya ~7 genre)
    return sections.slice(0, 22);
  }, []);

  // Phase 2: TMDB enrichment
  const enrichWithTMDB = useCallback(async (items, currentFetchId) => {
    const resolvedItems = [...items]; // Copy so we can update in-place
    const tmdbPromises = [];
    let apiFetchCount = 0;
    const MAX_API_CALLS = 120;

    const enrichPriority = (it) => {
      if (it.tmdb_query) return -1;
      const hasGenres = Array.isArray(it.tmdb_genre_ids) && it.tmdb_genre_ids.length > 0;
      const hasPoster = !!(it.tmdb_poster_path || it.poster_path);
      if (!hasGenres && !hasPoster) return 0;
      if (!hasGenres) return 1;
      return 3;
    };

    const candidateIndices = items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => {
        const searchTitle = item.tmdb_query || item.tmdb_title || item.folder_name || item.name;
        if (!searchTitle) return false;
        const hasOverride = !!item.tmdb_query;
        const hasBaseInfo = (item.tmdb_poster_path || item.poster_path) && item.tmdb_genre_ids && item.tmdb_genre_ids.length > 0;
        return !(hasBaseInfo && !hasOverride);
      })
      .sort((a, b) => enrichPriority(a.item) - enrichPriority(b.item))
      .map(({ idx }) => idx);

    for (const idx of candidateIndices) {
      if (apiFetchCount >= MAX_API_CALLS) break;
      const item = items[idx];
      const searchTitle = item.tmdb_query || item.tmdb_title || item.folder_name || item.name;

      apiFetchCount++;
      const opts = tmdbOptsFromItem(item);
      tmdbPromises.push(
        getTMDBInfo(searchTitle, opts).then(apiData => {
          if (apiData) {
            const resolvedItem = { ...item };
            resolvedItem.tmdb_title = apiData.tmdb_title || apiData.title || item.tmdb_title;
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

    await Promise.allSettled(tmdbPromises);

    if (fetchIdRef.current !== currentFetchId) return null;

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

    return { resolvedItems, topActors };
  }, [buildSections]);
  const loadData = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current;

    try {
      setLoading(true);

      // Fast path: serve cache instantly (if available), then refresh in background.
      // We intentionally skip onUpdate callback to avoid recursive reload loops.
      const foldersResp = await fetchFolders();

      if (fetchIdRef.current !== currentFetchId) return;

      // Check for unauthorized error
      if (foldersResp?.status === 401) {
        console.warn("Unauthorized API access - dashboard items may be limited.");
      }

      const shuffledData = processData(foldersResp);

      const historyPromise = authUser ? (async () => {
        try {
          const profiles = await fetchProfiles();
          if (profiles.length === 0 || fetchIdRef.current !== currentFetchId) return [];

          const allHistories = await Promise.all(
            profiles.map(p => fetchHistory(p.id))
          );

          if (fetchIdRef.current !== currentFetchId) return [];

          const flatHistory = allHistories.flat();
          const uniqueHistoryMap = new Map();
          flatHistory.sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));

          flatHistory.forEach(h => {
            const dur = Number(h.duration_ms) || 0;
            const progress = dur > 0 ? (Number(h.position_ms) / dur) * 100 : 0;
            const okProgress = Number.isFinite(progress);
            if (!uniqueHistoryMap.has(h.media_path) && h.position_ms >= 5000 && okProgress && progress < 95) {
              uniqueHistoryMap.set(h.media_path, {
                ...h,
                name: h.series_title || h.media_title,
                poster: h.still_path,
                folder_name: h.series_title || h.media_title,
                progress: progress
              });
            }
          });

          return Array.from(uniqueHistoryMap.values())
            .filter(h => !hiddenHistory.includes(h.media_path))
            .filter((item, index, self) =>
              index === self.findIndex((t) => (t.folder_name === item.folder_name))
            )
            .slice(0, 15);
        } catch (e) {
          console.error("History fetch error:", e);
          return [];
        }
      })() : Promise.resolve([]);

      const cwList = await historyPromise;
      if (fetchIdRef.current !== currentFetchId) return;

      // Paint cepat: data folder + history — tanpa tunggu ratusan panggilan TMDB
      setFeaturedList(shuffledData.slice(0, 6));
      setGenreSections(buildSections(shuffledData));
      setContinueWatching(cwList);
      setCelebrities([]);
      // Preload banner/posters immediately on phase 1.
      // This prevents HeroBanner background from staying blank until phase 2 enrichment completes.
      preloadDashboardImages(shuffledData, cwList, []);
      setLoading(false);

      // Make hero metadata arrive early (poster/backdrop/synopsis/rating) before full enrichment.
      void enrichFeaturedFast(shuffledData).then((featuredQuick) => {
        if (fetchIdRef.current !== currentFetchId) return;
        setFeaturedList(featuredQuick.slice(0, 6));
      });

      const enrichResult = await enrichWithTMDB(shuffledData, currentFetchId);
      if (fetchIdRef.current !== currentFetchId) return;
      if (!enrichResult) return;

      setCelebrities(enrichResult.topActors);
      setFeaturedList(enrichResult.resolvedItems.slice(0, 6));
      setGenreSections(buildSections(enrichResult.resolvedItems));
      preloadDashboardImages(enrichResult.resolvedItems, cwList, enrichResult.topActors);

    } catch (error) {
      console.error("Error loading dashboard data:", error);
      if (fetchIdRef.current === currentFetchId) setLoading(false);
    }
  }, [processData, buildSections, enrichWithTMDB, authUser, hiddenHistory]);

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
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-darkBG font-sans flex flex-col overflow-x-hidden scroll-pt-20">
      <Navbar
        onMeClick={() => setShowLoginModal(true)}
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />

      <main className="w-full pt-0">
        <HeroBanner
          items={featuredList}
          isAdmin={isAdmin}
          onEditPoster={(it) => setPosterEditItem(it)}
        />

        <div className="mt-4 pb-12">
          {genreSections.length > 0 && (
            <div className="mb-4">
              <MovieCarousel
                title={genreSections[0].title}
                items={genreSections[0].items}
                tagType={genreSections[0].tagType || 'top'}
                isAdmin={isAdmin}
                onEditPoster={(it) => setPosterEditItem(it)}
              />
            </div>
          )}

          <SectionDivider />

          {/* Continue Watching should appear under Top 10 */}
          {continueWatching.length > 0 && (
            <>
              <div className="mb-8 -mt-2">
                <MovieCarousel
                  title="Continue Watching"
                  items={continueWatching}
                  variant="horizontal"
                  onDelete={handleDeleteHistory}
                  removingId={removingItemPath}
                  isAdmin={false}
                />
              </div>
              <SectionDivider />
            </>
          )}


          {genreSections.length > 0 && (
            <div className="px-6 md:px-[60px] mb-6 -mt-2 w-full">
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

          {genreSections.slice(1).map((section, idx) => {
            const rest = genreSections.slice(1);
            const isLast = idx === rest.length - 1;
            return (
              <React.Fragment key={section.title}>
                <div className="mb-4">
                  <MovieCarousel
                    title={section.title}
                    items={section.items}
                    tagType={section.tagType || ((idx + 1) % 3 === 0 ? 'free' : null)}
                    isAdmin={isAdmin}
                    onEditPoster={(it) => setPosterEditItem(it)}
                  />
                </div>

                {/* 👇 SISIPIN DI SINI */}
                {idx === 2 && (
                  <>
                    <SectionDivider />
                    <BrowseMoreStrip onNavigate={navigate} />
                  </>
                )}

                {idx === Math.min(4, Math.max(0, rest.length - 1)) && celebrities.length > 0 && (
                  <CelebrityCarousel castList={celebrities} />
                )}

                {!isLast && <SectionDivider />}
              </React.Fragment>
            );
          })}
        </div>


      </main>

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={handleLoginSuccess}
      />
      {posterEditItem && (
        <TmdbPosterEditModal
          item={posterEditItem}
          onClose={() => setPosterEditItem(null)}
          onSaved={() => loadData()}
        />
      )}
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
                <img
                  src={actor.profile_path}
                  alt={actor.name}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500 bg-center"
                />
              </div>
              <p className="text-white text-[13px] md:text-[15px] font-medium text-center w-[90px] md:w-[140px] truncate group-hover:text-[#00dc41] transition-colors">{actor.name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

