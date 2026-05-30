import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

// API Helper to handle dev/prod URL matching with HuggingFace Space
const getApiUrl = (path) => {
  const { hostname, port } = window.location;
  if (hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
    if (port === '8000') {
      return path;
    }
    // Dev mode: point to hosted backend on HuggingFace Space
    return `https://melancholia112-mutflix.hf.space${path}`;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

const DraggableRow = ({ children }) => {
  const rowRef = useRef(null);
  const isDown = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const hasDragged = useRef(false);

  const handleMouseDown = (e) => {
    isDown.current = true;
    startX.current = e.pageX - rowRef.current.offsetLeft;
    scrollLeft.current = rowRef.current.scrollLeft;
    hasDragged.current = false;
    if (rowRef.current) {
      rowRef.current.style.scrollBehavior = 'auto';
    }
  };

  const handleMouseLeave = () => {
    if (isDown.current && rowRef.current) {
      rowRef.current.style.scrollBehavior = 'smooth';
    }
    isDown.current = false;
  };

  const handleMouseUp = () => {
    if (isDown.current && rowRef.current) {
      rowRef.current.style.scrollBehavior = 'smooth';
    }
    isDown.current = false;
  };

  const handleMouseMove = (e) => {
    if (!isDown.current) return;
    const x = e.pageX - rowRef.current.offsetLeft;
    const walk = (x - startX.current) * 1.8; // slightly increased multiplier for effortless feel
    if (Math.abs(walk) > 5) {
      hasDragged.current = true;
    }
    if (rowRef.current) {
      rowRef.current.scrollLeft = scrollLeft.current - walk;
    }
  };

  const handleClickCapture = (e) => {
    if (hasDragged.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  return (
    <div
      ref={rowRef}
      onMouseDown={handleMouseDown}
      onMouseLeave={handleMouseLeave}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onClickCapture={handleClickCapture}
      className="flex overflow-x-auto overflow-y-hidden gap-4 pb-4 pt-1 scrollbar-hide select-none active:cursor-grabbing cursor-grab"
      style={{ scrollBehavior: 'smooth' }}
    >
      {children}
    </div>
  );
};

export default function Dashboard({ session, activeProfile, onSwitchProfile, onLogout }) {
  const [content, setContent] = useState({ series: [], movies: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all'); // 'all' | 'series' | 'movies' | 'variety'
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const searchInputRef = useRef(null);
  const navigate = useNavigate();

  const [myList, setMyList] = useState(() => {
    try {
      const saved = localStorage.getItem(`mutflix_mylist_${activeProfile.id}`);
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const toggleMyList = (item) => {
    const isAdded = myList.some(x => x.name === item.name);
    let updated;
    if (isAdded) {
      updated = myList.filter(x => x.name !== item.name);
    } else {
      updated = [...myList, item];
    }
    setMyList(updated);
    localStorage.setItem(`mutflix_mylist_${activeProfile.id}`, JSON.stringify(updated));
  };

  // Hover Delay state
  const [hoveredItem, setHoveredItem] = useState(null);
  const [hoveredTrailerId, setHoveredTrailerId] = useState(null);
  const hoverTimeoutRef = useRef(null);

  const CACHE_KEY = 'mutflix_catalog_cache_v2';
  const CACHE_TTL = 15 * 60 * 1000; // 15 Menit Cache

  const fetchFoldersAndMetadata = async (forceRefresh = false) => {
    setIsLoading(true);
    setError(null);
    try {
      // Check for valid local cache first
      if (!forceRefresh) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp < CACHE_TTL)) {
              setContent(parsed.data);
              setIsLoading(false);
              return;
            }
          } catch (e) {
            console.warn('Failed to read local cache catalog:', e);
          }
        }
      }

      // 1. Fetch Google Drive and Telegram folders list from server
      const response = await fetch(getApiUrl('/api/folders'), {
        headers: {
          'x-access-token': session.token
        }
      });
      if (!response.ok) {
        throw new Error('Failed to fetch catalog library from server.');
      }
      const data = await response.json();
      
      const initialSeries = data.series || [];
      const initialMovies = data.movies || [];
      
      // 2. Fetch TMDB metadata in bulk from server (aggressively resolves all items)
      const allBulkItems = [
        ...initialSeries.map(item => ({ type: 'tv', name: item.name })),
        ...initialMovies.map(item => ({ type: 'movie', name: item.name }))
      ];

      if (allBulkItems.length === 0) {
        const payload = { series: initialSeries, movies: initialMovies };
        setContent(payload);
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          timestamp: Date.now(),
          data: payload
        }));
        setIsLoading(false);
        return;
      }

      setIsBulkLoading(true);
      const bulkResponse = await fetch(getApiUrl('/api/tmdb-meta/bulk'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': session.token
        },
        body: JSON.stringify({ items: allBulkItems })
      });

      let finalSeries = [...initialSeries];
      let finalMovies = [...initialMovies];

      if (bulkResponse.ok) {
        const bulkData = await bulkResponse.json();
        const results = bulkData.results || [];
        
        // Map resolved metadata by folder name
        const metadataMap = {};
        results.forEach(res => {
          if (res.status === 200 && res.payload) {
            const key = (res.folder_name || '').toLowerCase().trim();
            metadataMap[key] = {
              tmdb_title: res.payload.title || res.payload.name,
              tmdb_poster_path: res.payload.poster_path,
              tmdb_backdrop_path: res.payload.backdrop_path,
              tmdb_overview: res.payload.overview,
              tmdb_rating: res.payload.vote_average,
              tmdb_genres: res.payload.genres,
              tmdb_credits: res.payload.credits
            };
          }
        });

        // Merge resolved metadata
        finalSeries = initialSeries.map(item => {
          const key = (item.name || '').toLowerCase().trim();
          const meta = metadataMap[key];
          return meta ? { ...item, ...meta } : item;
        });

        finalMovies = initialMovies.map(item => {
          const key = (item.name || '').toLowerCase().trim();
          const meta = metadataMap[key];
          return meta ? { ...item, ...meta } : item;
        });
      }

      const finalPayload = { series: finalSeries, movies: finalMovies };
      
      // Save merged catalog with resolved metadata to local storage cache
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: finalPayload
      }));

      // Store fully resolved state and turn off loader
      setContent(finalPayload);
      setIsLoading(false);
    } catch (err) {
      setError(err.message);
      setIsLoading(false);
    } finally {
      setIsBulkLoading(false);
    }
  };

  useEffect(() => {
    fetchFoldersAndMetadata(false);
  }, [session.token]);

  // Detail view state removed, handled in specific pages

  // Hover delay handlers
  const handleMouseEnter = (item) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(async () => {
      setHoveredItem(item);
      try {
        const query = item.tmdb_title || item.name;
        const res = await fetch(getApiUrl(`/api/search-trailer?q=${encodeURIComponent(query + ' trailer')}`), {
          headers: { 'x-access-token': session.token }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.videoId) {
            setHoveredTrailerId(data.videoId);
          }
        }
      } catch (err) {
        console.warn('Gagal mencari trailer:', err);
      }
    }, 600); // 600ms hover delay
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHoveredItem(null);
    setHoveredTrailerId(null);
  };

  // Helper function to check if item belongs to specific genre
  const hasGenre = (item, genreNames, genreIds = []) => {
    // 1. Check tmdb_genres from TMDB API
    if (item.tmdb_genres && Array.isArray(item.tmdb_genres)) {
      return item.tmdb_genres.some(g => {
        const name = (g.name || '').toLowerCase();
        const id = g.id;
        return genreNames.some(gn => name.includes(gn.toLowerCase())) || genreIds.includes(id);
      });
    }
    // 2. Check genres directly
    if (item.genres && Array.isArray(item.genres)) {
      return item.genres.some(g => {
        const name = (g.name || '').toLowerCase();
        const id = g.id;
        return genreNames.some(gn => name.includes(gn.toLowerCase())) || genreIds.includes(id);
      });
    }
    // 3. Fallback to overview keyword scan
    const overview = (item.tmdb_overview || '').toLowerCase();
    const name = (item.name || '').toLowerCase();
    const title = (item.tmdb_title || '').toLowerCase();
    return genreNames.some(gn => {
      const gLower = gn.toLowerCase();
      return overview.includes(gLower) || name.includes(gLower) || title.includes(gLower);
    });
  };

  // Helper to check if a series is a variety show
  const isVarietyShow = (item) => {
    // Check using hasGenre helper with standard variety/reality/talk genres
    const hasVarietyGenre = hasGenre(item, ['variety', 'reality', 'talk show', 'talk-show', 'stage', 'knowing bros', 'running man'], [10764, 10767]);
    if (hasVarietyGenre) return true;
    
    // Additional name/title checks just in case
    const name = (item.name || '').toLowerCase();
    const title = (item.tmdb_title || '').toLowerCase();
    return name.includes('variety') || name.includes('show') || name.includes('reality') || name.includes('talk') || name.includes('korean') || name.includes('stage') ||
           title.includes('variety') || title.includes('show') || title.includes('reality') || title.includes('talk') || title.includes('knowing bros') || title.includes('running man');
  };

  const normalizedSearchQuery = useMemo(() => searchQuery.toLowerCase(), [searchQuery]);
  const allMedia = useMemo(() => [...content.series, ...content.movies], [content.series, content.movies]);

  // Filters logic (Prioritizes showing the clean TMDB title over plain folder names)
  const filteredSeries = useMemo(() => content.series.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return item.type === 'series' && title.includes(normalizedSearchQuery);
  }), [content.series, normalizedSearchQuery]);

  const filteredMovies = useMemo(() => content.movies.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return item.type === 'movie' && title.includes(normalizedSearchQuery);
  }), [content.movies, normalizedSearchQuery]);

  const filteredVariety = useMemo(() => content.series.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return item.type === 'series' && isVarietyShow(item) && title.includes(normalizedSearchQuery);
  }), [content.series, normalizedSearchQuery]);

  const topRatedTV = useMemo(() => [...content.series]
    .filter(item => item.type === 'series' && item.tmdb_rating !== undefined)
    .sort((a, b) => b.tmdb_rating - a.tmdb_rating), [content.series]);

  const topRatedMovie = useMemo(() => [...content.movies]
    .filter(item => item.type === 'movie' && item.tmdb_rating !== undefined)
    .sort((a, b) => b.tmdb_rating - a.tmdb_rating), [content.movies]);

  const topRatedVariety = useMemo(() => [...content.series]
    .filter(item => item.type === 'series' && isVarietyShow(item) && item.tmdb_rating !== undefined)
    .sort((a, b) => b.tmdb_rating - a.tmdb_rating), [content.series]);

  const telegramCollection = useMemo(() => allMedia
    .filter(item => item.source && item.source.startsWith("telegram/")), [allMedia]);

  // Genre Filters based on TMDB genres & tmdb_overview fallback
  const actionAdventure = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['action', 'adventure', 'fight', 'war', 'battle'], [28, 12, 10759])
  ), [allMedia]);

  const dramaRomance = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['romance', 'love', 'relationship', 'drama', 'romantic'], [18, 10749])
  ), [allMedia]);

  const scifiFantasy = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['sci-fi', 'science fiction', 'fantasy', 'alien', 'space', 'magic', 'monster'], [878, 14, 10765])
  ), [allMedia]);

  const comedyShows = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['comedy', 'funny', 'humor', 'laugh'], [35])
  ), [allMedia]);

  const horrorThriller = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['horror', 'thriller', 'scary', 'ghost', 'demon', 'killer', 'murder', 'suspense'], [27, 53])
  ), [allMedia]);

  const mysteryCrime = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['mystery', 'crime', 'detective', 'police', 'investigation', 'prison', 'heist', 'thief'], [9648, 80])
  ), [allMedia]);

  const animeAnimation = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['anime', 'animation', 'cartoon', 'animated', 'manga'], [16])
  ), [allMedia]);

  const docHistory = useMemo(() => allMedia.filter(item =>
    hasGenre(item, ['documentary', 'history', 'historical', 'biography', 'true story', 'factual'], [99, 36])
  ), [allMedia]);

  // Pick a featured item for the gorgeous Hero Banner (preferably one with resolved posters)
  const allItems = useMemo(() => [...content.movies, ...content.series], [content.movies, content.series]);
  const featuredItem = useMemo(() => allItems.find(item => item.tmdb_overview && item.tmdb_poster_path) || allItems[0], [allItems]);

  const getPosterUrl = (path, size = 'w500') => {
    if (!path) return null;
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return getApiUrl(`/api/tmdb-image/${size}/${cleanPath}`);
  };

  const renderMediaCard = (item, extraClasses = "flex-shrink-0 w-[220px] sm:w-[270px] md:w-[320px]") => {
    const isHovered = hoveredItem && hoveredItem.name === item.name;
    const imageUrl = item.tmdb_backdrop_path ? getPosterUrl(item.tmdb_backdrop_path) : (item.tmdb_poster_path ? getPosterUrl(item.tmdb_poster_path) : null);
    
    return (
      <div 
        key={item.name}
        onMouseEnter={() => handleMouseEnter(item)}
        onMouseLeave={handleMouseLeave}
        onClick={() => {
          navigate(`/${item.type === 'series' || item.type === 'tv' ? 'series' : 'movie'}/${encodeURIComponent(item.name)}`, { state: { item } });
          handleMouseLeave();
        }}
        className={`relative group bg-slate-900 rounded-lg overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:scale-105 hover:shadow-black/50 ${extraClasses}`}
      >
        <div className="w-full aspect-[16/9] bg-slate-950 flex items-center justify-center relative overflow-hidden">
          {imageUrl ? (
            <img 
              src={imageUrl} 
              alt={item.tmdb_title || item.name} 
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="p-4 text-center">
              <span className="text-green-500 text-2xl block font-extrabold mb-1">
                {item.name.charAt(0).toUpperCase()}
              </span>
              <span className="text-[10px] font-semibold text-slate-500 line-clamp-2 leading-tight uppercase font-mono">
                {item.name}
              </span>
            </div>
          )}
          
          {item.tmdb_rating !== undefined && (
            <div className="absolute top-2 right-2 bg-black/75 border border-slate-800 rounded px-1.5 py-0.5 text-[9px] font-bold text-yellow-500 z-20">
              ★ {item.tmdb_rating.toFixed(1)}
            </div>
          )}

          {/* Dark gradient overlay at bottom for readability */}
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 via-black/40 to-transparent z-10 pointer-events-none" />

          {/* Title & Info overlay */}
          <div className="absolute bottom-2 left-2 right-2 z-20 text-left">
            <h4 className="text-[10px] sm:text-xs font-bold text-white line-clamp-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
              {item.tmdb_title || item.name}
            </h4>
          </div>
        </div>
      </div>
    );
  };

  const renderTop10Card = (item, index) => {
    const imageUrl = item.tmdb_poster_path ? getPosterUrl(item.tmdb_poster_path) : null;
    return (
      <div 
        key={item.name}
        onClick={() => navigate(`/${item.type === 'series' || item.type === 'tv' ? 'series' : 'movie'}/${encodeURIComponent(item.name)}`, { state: { item } })}
        className="flex-shrink-0 flex items-end relative select-none cursor-pointer pl-2 pr-2 h-48 sm:h-60 md:h-72 group"
      >
        {/* Giant outline rank number */}
        <span 
          className="absolute left-0 bottom-[-15px] sm:bottom-[-22px] md:bottom-[-30px] text-[130px] sm:text-[180px] md:text-[230px] font-black text-[#18181b] select-none leading-none font-sans z-10 transition-transform duration-300 group-hover:scale-105"
          style={{ 
            WebkitTextStroke: '4px rgba(255,255,255,0.35)',
            textShadow: '0 0 15px rgba(0,0,0,0.6)'
          }}
        >
          {index + 1}
        </span>

        {/* Vertical Poster Card with dynamic margin based on single/double digits */}
        <div className={`w-[110px] sm:w-[150px] md:w-[190px] aspect-[2/3] rounded-md overflow-hidden bg-slate-950 relative z-20 shadow-xl border border-white/5 transition-all duration-300 group-hover:scale-105 group-hover:shadow-black/80 ${
          index >= 9 
            ? 'ml-[75px] sm:ml-[110px] md:ml-[145px]' 
            : 'ml-[50px] sm:ml-[75px] md:ml-[95px]'
        }`}>
          {imageUrl ? (
            <img 
              src={imageUrl} 
              alt={item.tmdb_title || item.name} 
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="p-4 text-center h-full flex flex-col justify-center">
              <span className="text-green-500 text-lg block font-extrabold mb-1">
                {item.name.charAt(0).toUpperCase()}
              </span>
              <span className="text-[9px] font-semibold text-slate-500 line-clamp-2 uppercase font-mono">
                {item.name}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full pt-1.5 pb-6 px-4 sm:px-8 md:px-12 relative z-10 select-none animate-fadeIn">
      
      {/* Navigation & Header */}
      <header className="sticky top-0 bg-transparent z-50 pt-1.5 pb-2 px-6 md:px-8 -mx-2 sm:-mx-4 md:-mx-6 flex flex-wrap md:flex-nowrap items-center justify-between gap-4 md:gap-6 mb-2 select-none transition-all duration-300">
        {/* Left: Brand Logo */}
        <div className="flex items-center gap-1.5 cursor-pointer active:scale-98 transition-all flex-shrink-0" onClick={() => setActiveCategory('all')}>
          <span className="text-2xl md:text-3xl font-extrabold tracking-tighter text-green-500">
            MUTFLIX
          </span>
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]"></span>
        </div>
        
        {/* Center: Navbar Tabs with Animation */}
        <div className="order-3 md:order-2 w-full md:w-auto flex justify-center">
          <nav className="relative flex items-center gap-2 md:gap-6 p-0 max-w-full overflow-x-auto scrollbar-hide">
            {[
              { id: 'all', label: 'Home' },
              { id: 'series', label: 'TV Show' },
              { id: 'movies', label: 'Movie' },
              { id: 'variety', label: 'Variety Show' }
            ].map((tab) => {
              const isActive = activeCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveCategory(tab.id)}
                  className="group relative px-3 py-2 text-sm md:text-base font-bold tracking-wider transition-all duration-300 select-none cursor-pointer flex-shrink-0"
                >
                  <span className={`relative z-10 transition-colors duration-300 ${
                    isActive ? 'text-green-500 font-extrabold' : 'text-white/80 group-hover:text-green-400'
                  }`}>
                    {tab.label}
                  </span>
                  
                  {/* Underline Indicator with Hover/Active Animation */}
                  <span className={`absolute bottom-0 left-0 w-full h-[2.5px] bg-green-500 rounded-full transition-transform duration-300 origin-center ${
                    isActive 
                      ? 'scale-x-100' 
                      : 'scale-x-0 group-hover:scale-x-100'
                  }`} />
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right controls */}
        <div className="order-2 md:order-3 flex items-center gap-4 flex-shrink-0">
          {/* Search bar */}
          <div className="relative flex items-center">
            <div className={`flex items-center transition-all duration-300 rounded-full ${
              isSearchExpanded 
                ? 'w-44 sm:w-60 bg-white/5 border border-white/10 px-3.5 py-1.5 shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)] focus-within:border-green-500/50' 
                : 'w-10 h-10 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 justify-center cursor-pointer hover:scale-105 active:scale-95 shadow-md'
            }`}
            onClick={() => {
              if (!isSearchExpanded) {
                setIsSearchExpanded(true);
                setTimeout(() => searchInputRef.current?.focus(), 100);
              }
            }}
            >
              <svg 
                className={`w-4 h-4 text-slate-400 transition-colors ${!isSearchExpanded ? 'hover:text-green-400' : ''}`} 
                fill="none" 
                viewBox="0 0 24 24" 
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => {
                  if (!searchQuery) {
                    setIsSearchExpanded(false);
                  }
                }}
                className={`bg-transparent text-xs font-medium outline-none transition-all placeholder:text-slate-500 text-slate-200 ${
                  isSearchExpanded ? 'w-full ml-2 opacity-100' : 'w-0 opacity-0 pointer-events-none'
                }`}
              />
            </div>
          </div>

          {/* Profile Menu Dropdown */}
          <div className="relative">
            <button 
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 px-3 py-1.5 rounded-full cursor-pointer hover:scale-[1.02] active:scale-[0.98] transition-all duration-200 shadow-md"
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-green-500 to-emerald-400 flex items-center justify-center font-extrabold text-white text-xs shadow-[0_0_8px_rgba(34,197,94,0.3)]">
                {activeProfile.name.charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-semibold text-slate-200 hidden sm:inline">{activeProfile.name}</span>
              <svg 
                className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-300 ${isProfileOpen ? 'rotate-180 text-green-400' : ''}`}
                fill="none" 
                viewBox="0 0 24 24" 
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Dropdown Menu */}
            {isProfileOpen && (
              <>
                {/* Backdrop overlay to close when clicking outside */}
                <div className="fixed inset-0 z-40" onClick={() => setIsProfileOpen(false)} />
                <div className="absolute right-0 mt-3 w-52 bg-slate-950/90 border border-white/10 backdrop-blur-xl rounded-2xl shadow-[0_10px_35px_rgba(0,0,0,0.6)] z-50 p-1.5 animate-fadeIn text-left">
                  <div className="px-3 py-2 border-b border-white/5 mb-1.5">
                    <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Active Profile</p>
                    <p className="text-xs font-bold text-white truncate">{activeProfile.name}</p>
                  </div>
                  <button
                    onClick={() => {
                      setIsProfileOpen(false);
                      onSwitchProfile();
                    }}
                    className="w-full text-left px-3 py-2.5 hover:bg-white/5 hover:text-white rounded-xl text-xs font-semibold uppercase tracking-wider transition-all flex items-center gap-2.5 text-slate-300 cursor-pointer"
                  >
                    <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    Switch Profile
                  </button>
                  <button
                    onClick={() => {
                      setIsProfileOpen(false);
                      onLogout();
                    }}
                    className="w-full text-left px-3 py-2.5 hover:bg-red-950/30 hover:text-red-400 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all flex items-center gap-2.5 text-slate-400 cursor-pointer mt-1"
                  >
                    <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign Out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Layout */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 space-y-4">
          <svg className="animate-spin h-12 w-12 text-green-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-slate-400 text-sm tracking-widest uppercase font-semibold">Fetching Catalog Library...</span>
        </div>
      ) : error ? (
        <div className="text-center py-20 max-w-md mx-auto space-y-4">
          <p className="p-5 bg-red-500/10 border border-red-500/20 text-red-400 rounded-2xl text-sm leading-relaxed">
            {error}
          </p>
          <button 
            onClick={() => fetchFoldersAndMetadata(true)}
            className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-xl transition-colors active:scale-98 shadow-lg shadow-green-950/20"
          >
            Retry Sync
          </button>
        </div>
      ) : (
        <div className="space-y-12">
          
          {/* 1. HERO BANNER - Billboard Content */}
          {featuredItem && activeCategory === 'all' && !searchQuery && (
            <div className="relative h-[480px] md:h-[560px] -mx-2 sm:-mx-4 md:-mx-6 rounded-2xl overflow-hidden bg-[#141414] shadow-2xl">
              
              {/* Crisp Backdrop Image background */}
              {(featuredItem.tmdb_backdrop_path || featuredItem.tmdb_poster_path) ? (
                <div 
                  className="absolute inset-0 bg-cover bg-center opacity-95 scale-100 transition-all duration-500"
                  style={{ backgroundImage: `url(${getPosterUrl(featuredItem.tmdb_backdrop_path || featuredItem.tmdb_poster_path, 'original')})` }}
                ></div>
              ) : (
                <div className="absolute inset-0 bg-[#141414]"></div>
              )}

              {/* Gradient dark overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/50 to-transparent"></div>
              <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/20 to-transparent"></div>

              <div className="absolute bottom-6 sm:bottom-10 md:bottom-12 left-0 p-8 sm:p-12 max-w-3xl space-y-5 z-10 text-left">
                <span className="inline-flex px-3 py-1 rounded bg-green-600/10 border border-green-500/20 text-green-400 text-sm font-semibold tracking-wider uppercase">
                  Popular Spotlight
                </span>

                <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold text-white tracking-tight leading-none drop-shadow-md">
                  {featuredItem.tmdb_title || featuredItem.name}
                </h1>

                {featuredItem.tmdb_rating !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-yellow-500">★</span>
                    <span className="font-bold text-slate-300">
                      {featuredItem.tmdb_rating.toFixed(1)} / 10
                    </span>
                    <span className="text-slate-600">|</span>
                    <span className="text-slate-400 capitalize">
                      {featuredItem.type === 'series' ? 'TV Series' : 'Movie'}
                    </span>
                  </div>
                )}

                <p className="text-slate-300 text-base sm:text-lg leading-relaxed line-clamp-3 max-w-2xl drop-shadow">
                  {featuredItem.tmdb_overview || 'The most complete catalog available to stream instantly with zero bandwidth throttling.'}
                </p>

                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <button 
                    onClick={() => navigate(`/${featuredItem.type === 'series' || featuredItem.type === 'tv' ? 'series' : 'movie'}/${encodeURIComponent(featuredItem.name)}`, { state: { item: featuredItem } })}
                    className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white font-bold rounded-full text-sm transition-all shadow-lg shadow-green-950/30 flex items-center gap-2 active:scale-98 cursor-pointer"
                  >
                    <svg className="w-4 h-4 fill-white" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Watch Now
                  </button>
                  <button 
                    onClick={() => toggleMyList(featuredItem)}
                    className={`px-6 py-2.5 border rounded-full text-sm font-bold transition-all flex items-center gap-2 active:scale-98 cursor-pointer ${
                      myList.some(x => x.name === featuredItem.name)
                        ? 'bg-white text-black border-white shadow-lg'
                        : 'bg-white/10 hover:bg-white/20 border-white/10 hover:border-white/20 text-white'
                    }`}
                  >
                    <span>{myList.some(x => x.name === featuredItem.name) ? '✓ In My List' : '+ My List'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Custom style to hide scrollbars and style rows */}
          <style>{`
            .scrollbar-hide::-webkit-scrollbar {
              display: none;
            }
            .scrollbar-hide {
              -ms-overflow-style: none;
              scrollbar-width: none;
            }
          `}</style>

          {/* Search Result Grid View */}
          {searchQuery ? (
            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-slate-900 pb-2">
                <h3 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                  <span className="w-1.5 h-5 bg-green-500 rounded-full"></span>
                  Search Results for "{searchQuery}"
                </h3>
                <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">
                  {(activeCategory === 'all' ? [...filteredSeries, ...filteredMovies] :
                    activeCategory === 'series' ? filteredSeries :
                    activeCategory === 'movies' ? filteredMovies :
                    filteredVariety).length} Found
                </span>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {(activeCategory === 'all' ? [...filteredSeries, ...filteredMovies] :
                  activeCategory === 'series' ? filteredSeries :
                  activeCategory === 'movies' ? filteredMovies :
                  filteredVariety).map((item) => (
                  renderMediaCard(item, "w-full")
                ))}
              </div>

              {((activeCategory === 'all' && filteredSeries.length === 0 && filteredMovies.length === 0) ||
                (activeCategory === 'series' && filteredSeries.length === 0) ||
                (activeCategory === 'movies' && filteredMovies.length === 0) ||
                (activeCategory === 'variety' && filteredVariety.length === 0)) && (
                <div className="text-center py-20 space-y-4 animate-fadeIn">
                  <svg className="w-16 h-16 text-slate-700 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="space-y-1">
                    <h4 className="text-lg font-bold text-slate-200">Catalog Not Found</h4>
                    <p className="text-slate-500 text-sm max-w-sm mx-auto">
                      No shows match the query "{searchQuery}" in this category.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Premium Horizontal Scrolling Rows like Netflix */
            <div className="space-y-10 pb-16">
              
              {/* Row 1: SERIAL TV SECTION */}
              {(activeCategory === 'all' || activeCategory === 'series') && filteredSeries.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Popular TV Series
                    </h3>
                  </div>

                  <DraggableRow>
                    {filteredSeries.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row 2: MOVIES SECTION */}
              {(activeCategory === 'all' || activeCategory === 'movies') && filteredMovies.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Recommended Movies
                    </h3>
                  </div>

                  <DraggableRow>
                    {filteredMovies.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row 3: TOP 10 RATED TV SHOWS SECTION */}
              {activeCategory === 'all' && topRatedTV.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Top Rated TV Show
                    </h3>
                  </div>

                  <DraggableRow>
                    {topRatedTV.slice(0, 10).map((item, index) => (
                      renderTop10Card(item, index)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: ACTION & ADVENTURE */}
              {activeCategory === 'all' && actionAdventure.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Action & Adventure
                    </h3>
                  </div>

                  <DraggableRow>
                    {actionAdventure.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: DRAMA & ROMANCE */}
              {activeCategory === 'all' && dramaRomance.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Drama & Romance
                    </h3>
                  </div>

                  <DraggableRow>
                    {dramaRomance.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: TOP 10 RATED MOVIES SECTION */}
              {activeCategory === 'all' && topRatedMovie.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Top Rated Movie
                    </h3>
                  </div>

                  <DraggableRow>
                    {topRatedMovie.slice(0, 10).map((item, index) => (
                      renderTop10Card(item, index)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: SCI-FI & FANTASY */}
              {activeCategory === 'all' && scifiFantasy.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Sci-Fi & Fantasy
                    </h3>
                  </div>

                  <DraggableRow>
                    {scifiFantasy.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: COMEDY SHOWS */}
              {activeCategory === 'all' && comedyShows.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Comedy
                    </h3>
                  </div>

                  <DraggableRow>
                    {comedyShows.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: HORROR & THRILLER */}
              {activeCategory === 'all' && horrorThriller.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Horror & Thriller
                    </h3>
                  </div>

                  <DraggableRow>
                    {horrorThriller.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: TOP 10 RATED VARIETY SHOWS SECTION */}
              {activeCategory === 'all' && topRatedVariety.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Top Rated Variety Show
                    </h3>
                  </div>

                  <DraggableRow>
                    {topRatedVariety.slice(0, 10).map((item, index) => (
                      renderTop10Card(item, index)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: MYSTERY & CRIME */}
              {activeCategory === 'all' && mysteryCrime.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Mystery & Crime
                    </h3>
                  </div>

                  <DraggableRow>
                    {mysteryCrime.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: ANIME & ANIMATION */}
              {activeCategory === 'all' && animeAnimation.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Anime & Animation
                    </h3>
                  </div>

                  <DraggableRow>
                    {animeAnimation.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row: DOCUMENTARY & HISTORY */}
              {activeCategory === 'all' && docHistory.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Documentaries & History
                    </h3>
                  </div>

                  <DraggableRow>
                    {docHistory.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row 4: MY LIST SECTION */}
              {activeCategory === 'all' && myList.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      My List
                    </h3>
                  </div>

                  <DraggableRow>
                    {myList.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}

              {/* Row 5: TELEGRAM COLLECTION SECTION */}
              {activeCategory === 'all' && telegramCollection.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Telegram Collection
                    </h3>
                  </div>

                  <DraggableRow>
                    {telegramCollection.slice(0, 15).map((item) => (
                      renderMediaCard(item)
                    ))}
                  </DraggableRow>
                </div>
              )}



              {/* Fallback if category has no items */}
              {activeCategory === 'variety' && filteredVariety.length === 0 && (
                <div className="text-center py-20 space-y-4 animate-fadeIn">
                  <svg className="w-16 h-16 text-slate-700 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="space-y-1">
                    <h4 className="text-lg font-bold text-slate-200">No Variety Shows Found</h4>
                    <p className="text-slate-500 text-sm max-w-sm mx-auto">
                      No variety shows are available in the catalog at this time.
                    </p>
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}


    </div>
  );
}
