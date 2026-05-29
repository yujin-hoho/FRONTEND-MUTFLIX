import React, { useState, useEffect, useRef } from 'react';
import MediaDetails from './MediaDetails';

// API Helper to handle dev/prod URL matching with HuggingFace Space
const getApiUrl = (path) => {
  if (window.location.hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

export default function Dashboard({ session, activeProfile, onSwitchProfile, onLogout }) {
  const [content, setContent] = useState({ series: [], movies: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all'); // 'all' | 'series' | 'movies'
  const [selectedItem, setSelectedItem] = useState(null); // Detail modal
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const searchInputRef = useRef(null);

  // Detailed Media and custom player state
  const [selectedItemVideos, setSelectedItemVideos] = useState([]);
  const [isVideosLoading, setIsVideosLoading] = useState(false);
  const [activeSeason, setActiveSeason] = useState(1);
  const [playingVideo, setPlayingVideo] = useState(null);
  const [videoStreamDetails, setVideoStreamDetails] = useState(null);
  const [continueWatching, setContinueWatching] = useState([]);

  // Hover Delay state
  const [hoveredItem, setHoveredItem] = useState(null);
  const [hoveredTrailerId, setHoveredTrailerId] = useState(null);
  const hoverTimeoutRef = useRef(null);

  const CACHE_KEY = 'mutflix_catalog_cache';
  const CACHE_TTL = 15 * 60 * 1000; // 15 Menit Cache

  const fetchFoldersAndMetadata = async (forceRefresh = false) => {
    setIsLoading(true);
    setError(null);
    try {
      // Cek apakah ada data cache lokal yang masih valid
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
            console.warn('Gagal membaca cache lokal catalog:', e);
          }
        }
      }

      // 1. Fetch Google Drive and Telegram folders list
      const response = await fetch(getApiUrl('/api/folders'), {
        headers: {
          'x-access-token': session.token
        }
      });
      if (!response.ok) {
        throw new Error('Gagal mengambil daftar katalog dari server.');
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
              tmdb_overview: res.payload.overview,
              tmdb_rating: res.payload.vote_average
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
      
      // Simpan data hasil penggabungan ke dalam cache lokal
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: finalPayload
      }));

      // Store fully resolved state and turn off main loader
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

  // Watch History (Continue Watching)
  const fetchWatchHistory = async () => {
    if (!activeProfile || !activeProfile.id) return;
    try {
      const response = await fetch(getApiUrl(`/api/history/get/${activeProfile.id}`), {
        headers: { 'x-access-token': session.token }
      });
      if (response.ok) {
        const data = await response.json();
        setContinueWatching(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error('Gagal mengambil riwayat menonton:', err);
    }
  };

  useEffect(() => {
    fetchWatchHistory();
  }, [activeProfile]);

  // Fetch playable files for details view
  const fetchVideosForItem = async (item) => {
    setIsVideosLoading(true);
    setSelectedItemVideos([]);
    try {
      const path = item.source || item.path || `gdrive_folder/${item.name}`;
      const response = await fetch(getApiUrl(`/api/videos/${encodeURIComponent(path)}`), {
        headers: { 'x-access-token': session.token }
      });
      if (response.ok) {
        const data = await response.json();
        setSelectedItemVideos(data.videos || []);
        if (data.videos && data.videos.length > 0) {
          const seasons = data.videos.map(v => v.season).filter(s => s !== undefined && s !== null);
          if (seasons.length > 0) {
            setActiveSeason(Math.min(...seasons));
          } else {
            setActiveSeason(1);
          }
        }
      }
    } catch (err) {
      console.error('Gagal memuat video:', err);
    } finally {
      setIsVideosLoading(false);
    }
  };

  useEffect(() => {
    if (selectedItem) {
      fetchVideosForItem(selectedItem);
    }
  }, [selectedItem]);

  // Play controls
  const handlePlayVideo = async (video) => {
    setPlayingVideo(video);
    setVideoStreamDetails(null);
    try {
      if (video.path.startsWith('telegram/')) {
        const parts = video.path.split('/');
        const chat_id = parts[1];
        const message_id = parts[2];
        const url = `/api/telegram/stream/${chat_id}/${message_id}?token=${encodeURIComponent(session.token)}`;
        setVideoStreamDetails({ stream_url: url });
      } else {
        const response = await fetch(getApiUrl(`/api/gdrive-stream-details/${encodeURIComponent(video.path)}`), {
          headers: { 'x-access-token': session.token }
        });
        if (response.ok) {
          const data = await response.json();
          setVideoStreamDetails(data);
        }
      }
    } catch (err) {
      console.error('Gagal memutar video:', err);
    }
  };

  const handleClosePlayer = () => {
    setPlayingVideo(null);
    setVideoStreamDetails(null);
    fetchWatchHistory();
  };

  const handleVideoTimeUpdate = async (e) => {
    const video = e.currentTarget;
    if (!video || !playingVideo || !activeProfile) return;
    const currentTimeMs = Math.floor(video.currentTime * 1000);
    const durationMs = Math.floor(video.duration * 1000);

    // Save progress periodically
    if (video.paused || Math.floor(video.currentTime) % 10 === 0) {
      try {
        await fetch(getApiUrl('/api/history/save'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': session.token
          },
          body: JSON.stringify({
            profile_id: activeProfile.id,
            media_path: playingVideo.path,
            media_title: playingVideo.name,
            series_title: selectedItem ? selectedItem.name : playingVideo.name,
            source: playingVideo.source || (selectedItem && selectedItem.source) || 'Google Drive',
            still_path: (selectedItem && selectedItem.tmdb_poster_path) || null,
            subtitle_path: playingVideo.subtitle_path || null,
            position_ms: currentTimeMs,
            duration_ms: durationMs,
            season: playingVideo.season || null,
            episode: playingVideo.episode || null
          })
        });
      } catch (err) {
        console.error('Gagal menyimpan riwayat:', err);
      }
    }
  };

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

  // Filters logic (Prioritizes showing the clean TMDB title over plain folder names)
  const filteredSeries = content.series.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return title.includes(searchQuery.toLowerCase());
  });

  const filteredMovies = content.movies.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return title.includes(searchQuery.toLowerCase());
  });

  const filteredVariety = [...content.series, ...content.movies].filter(item => {
    const name = (item.name || '').toLowerCase();
    const title = (item.tmdb_title || '').toLowerCase();
    const isVariety = name.includes('variety') || name.includes('show') || name.includes('reality') || name.includes('talk') || name.includes('korean') || name.includes('stage') ||
                      title.includes('variety') || title.includes('show') || title.includes('reality') || title.includes('talk') || title.includes('knowing bros') || title.includes('running man');
    return isVariety && (name.includes(searchQuery.toLowerCase()) || title.includes(searchQuery.toLowerCase()));
  });

  // Pick a featured item for the gorgeous Hero Banner (preferably one with resolved posters)
  const allItems = [...content.movies, ...content.series];
  const featuredItem = allItems.find(item => item.tmdb_overview && item.tmdb_poster_path) || allItems[0];

  const getPosterUrl = (path) => {
    if (!path) return null;
    return `https://image.tmdb.org/t/p/w500${path}`;
  };

  const renderMediaCard = (item, extraClasses = "flex-shrink-0 w-[150px] sm:w-[180px] md:w-[200px] snap-start") => {
    const isHovered = hoveredItem && hoveredItem.name === item.name;
    return (
      <div 
        key={item.name}
        onMouseEnter={() => handleMouseEnter(item)}
        onMouseLeave={handleMouseLeave}
        onClick={() => {
          setSelectedItem(item);
          handleMouseLeave();
        }}
        className={`relative group bg-slate-900 border border-slate-850 hover:border-green-500 rounded-xl overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:shadow-green-950/20 ${extraClasses}`}
      >
        <div className="h-56 sm:h-64 bg-slate-950 flex items-center justify-center relative overflow-hidden">
          {item.tmdb_poster_path ? (
            <img 
              src={getPosterUrl(item.tmdb_poster_path)} 
              alt={item.tmdb_title || item.name} 
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="p-4 text-center">
              <span className="text-green-500 text-4xl block font-extrabold mb-2">
                {item.name.charAt(0).toUpperCase()}
              </span>
              <span className="text-xs font-semibold text-slate-500 line-clamp-3 leading-tight uppercase font-mono">
                {item.name}
              </span>
            </div>
          )}
          
          {item.tmdb_rating !== undefined && (
            <div className="absolute top-2 right-2 bg-black/75 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] font-bold text-yellow-500 z-10">
              ★ {item.tmdb_rating.toFixed(1)}
            </div>
          )}
        </div>

        <div className="p-3 space-y-0.5 text-left">
          <h4 className="text-xs sm:text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">
            {item.tmdb_title || item.name}
          </h4>
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] text-slate-500 tracking-wider font-semibold uppercase">
              {item.type === 'series' ? 'Serial TV' : 'Film'}
            </span>
            {item.source && item.source.startsWith("telegram/") && (
              <span className="text-[9px] text-sky-400 font-bold uppercase font-sans">
                Telegram
              </span>
            )}
          </div>
        </div>

        {/* Premium Hover Card Preview Overlay with 600ms delay */}
        {isHovered && (
          <div className="absolute inset-0 bg-slate-950 z-40 flex flex-col justify-between p-3 animate-fadeIn text-left">
            <div className="relative h-28 bg-slate-900 rounded overflow-hidden mb-2">
              {hoveredTrailerId ? (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${hoveredTrailerId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0&loop=1&playlist=${hoveredTrailerId}`}
                  className="w-full h-full object-cover"
                  allow="autoplay; encrypted-media"
                  title="Trailer"
                  frameBorder="0"
                ></iframe>
              ) : item.tmdb_poster_path ? (
                <img 
                  src={getPosterUrl(item.tmdb_poster_path)} 
                  alt={item.tmdb_title || item.name} 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-slate-900">
                  <span className="text-green-500 font-extrabold text-xl">{item.name.charAt(0).toUpperCase()}</span>
                </div>
              )}
              {item.tmdb_rating !== undefined && (
                <div className="absolute top-1.5 right-1.5 bg-black/80 rounded px-1.5 py-0.5 text-[9px] font-extrabold text-yellow-500">
                  ★ {item.tmdb_rating.toFixed(1)}
                </div>
              )}
            </div>
            
            <div className="flex-1 flex flex-col justify-between min-h-0">
              <div>
                <h4 className="text-xs font-bold text-white line-clamp-1 leading-tight mb-1">
                  {item.tmdb_title || item.name}
                </h4>
                <p className="text-[10px] text-slate-400 line-clamp-3 leading-relaxed mb-2">
                  {item.tmdb_overview || 'Metadata sinopsis untuk tayangan ini belum tersedia.'}
                </p>
              </div>
              <div className="flex items-center justify-between border-t border-slate-900 pt-2 mt-auto">
                <span className="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">
                  {item.type === 'series' ? 'TV Series' : 'Movie'}
                </span>
                <span className="text-[9px] text-green-500 font-bold uppercase tracking-wider">
                  Click to View
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full max-w-7xl mx-auto pt-0 pb-6 px-4 sm:px-6 relative z-10 select-none animate-fadeIn">
      
      {/* Navigation & Header */}
      <header className="sticky top-0 bg-[#141414]/80 backdrop-blur-xl z-50 pt-2 pb-2.5 px-6 md:px-8 -mx-4 sm:-mx-6 md:-mx-8 border-b border-white/5 flex flex-wrap md:flex-nowrap items-center justify-between gap-4 md:gap-6 mb-6 select-none transition-all duration-300">
        {/* Left: Brand Logo */}
        <div className="flex items-center gap-1.5 cursor-pointer active:scale-98 transition-all flex-shrink-0" onClick={() => setActiveCategory('all')}>
          <span className="text-2xl md:text-3xl font-extrabold tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-green-400 via-emerald-500 to-green-600">
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
                  className="group relative px-2.5 py-2 text-xs font-bold tracking-wider transition-all duration-300 select-none cursor-pointer uppercase flex-shrink-0"
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
                placeholder="Cari..."
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
                    <p className="text-[10px] uppercase font-bold tracking-wider text-slate-500">Profil Aktif</p>
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
                    Ganti Profil
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
          <span className="text-slate-400 text-sm tracking-widest uppercase font-semibold">Mengambil Berkas Katalog...</span>
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
            Coba Sinkronkan Ulang
          </button>
        </div>
      ) : (
        <div className="space-y-12">
          
          {/* 1. HERO BANNER - Billboard Content */}
          {featuredItem && activeCategory === 'all' && !searchQuery && (
            <div className="w-full relative h-[420px] rounded-2xl overflow-hidden border border-slate-900 bg-slate-950">
              
              {/* Blurred backdrop image background */}
              {featuredItem.tmdb_poster_path ? (
                <div 
                  className="absolute inset-0 bg-cover bg-center opacity-30 blur-sm scale-105"
                  style={{ backgroundImage: `url(${getPosterUrl(featuredItem.tmdb_poster_path)})` }}
                ></div>
              ) : (
                <div className="absolute inset-0 bg-slate-950"></div>
              )}

              {/* Gradient dark overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent"></div>
              <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/40 to-transparent"></div>

              {/* Content Detail Panel */}
              <div className="absolute bottom-0 left-0 p-8 sm:p-12 max-w-2xl space-y-4 z-10 text-left">
                <span className="inline-flex px-2.5 py-0.5 rounded bg-green-600/10 border border-green-500/20 text-green-400 text-xs font-semibold tracking-wider uppercase">
                  Sorotan Terpopuler
                </span>

                <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
                  {featuredItem.tmdb_title || featuredItem.name}
                </h1>

                {featuredItem.tmdb_rating !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-yellow-500 text-sm">★</span>
                    <span className="text-xs font-bold text-slate-300">
                      {featuredItem.tmdb_rating.toFixed(1)} / 10
                    </span>
                    <span className="text-xs text-slate-600">|</span>
                    <span className="text-xs text-slate-400 capitalize">
                      {featuredItem.type === 'series' ? 'Serial TV' : 'Film'}
                    </span>
                  </div>
                )}

                <p className="text-slate-300 text-sm sm:text-base leading-relaxed line-clamp-3">
                  {featuredItem.tmdb_overview || 'Katalog terlengkap dapat langsung diputar secara instan tanpa hambatan bandwidth.'}
                </p>

                <div className="pt-2">
                  <button 
                    onClick={() => setSelectedItem(featuredItem)}
                    className="px-6 py-2.5 bg-green-600 hover:bg-green-500 text-white font-bold rounded-xl text-sm transition-all shadow-lg shadow-green-950/30 flex items-center gap-2 active:scale-98"
                  >
                    <svg className="w-4 h-4 fill-white" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Tonton Sekarang
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
                  Hasil Pencarian untuk "{searchQuery}"
                </h3>
                <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">
                  {(activeCategory === 'all' ? [...filteredSeries, ...filteredMovies] :
                    activeCategory === 'series' ? filteredSeries :
                    activeCategory === 'movies' ? filteredMovies :
                    filteredVariety).length} Ditemukan
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
                    <h4 className="text-lg font-bold text-slate-200">Katalog Tidak Ditemukan</h4>
                    <p className="text-slate-500 text-sm max-w-sm mx-auto">
                      Tidak ada tayangan yang cocok dengan kueri "{searchQuery}" pada kategori ini.
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
                      Serial TV Terpopuler
                    </h3>
                  </div>

                  <div className="flex overflow-x-auto gap-4 pb-4 pt-1 scrollbar-hide snap-x snap-mandatory scroll-smooth">
                    {filteredSeries.map((item) => (
                      renderMediaCard(item)
                    ))}
                  </div>
                </div>
              )}

              {/* Row 2: MOVIES SECTION */}
              {(activeCategory === 'all' || activeCategory === 'movies') && filteredMovies.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Rekomendasi Film Terbaik
                    </h3>
                  </div>

                  <div className="flex overflow-x-auto gap-4 pb-4 pt-1 scrollbar-hide snap-x snap-mandatory scroll-smooth">
                    {filteredMovies.map((item) => (
                      renderMediaCard(item)
                    ))}
                  </div>
                </div>
              )}

              {/* Row 3: VARIETY SHOW SECTION */}
              {(activeCategory === 'all' || activeCategory === 'variety') && filteredVariety.length > 0 && (
                <div className="space-y-3 text-left">
                  <div className="flex items-center justify-between px-1">
                    <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      <span className="w-1 h-5 bg-green-500 rounded-full"></span>
                      Variety Show Terpopuler
                    </h3>
                  </div>

                  <div className="flex overflow-x-auto gap-4 pb-4 pt-1 scrollbar-hide snap-x snap-mandatory scroll-smooth">
                    {filteredVariety.map((item) => (
                      renderMediaCard(item)
                    ))}
                  </div>
                </div>
              )}

              {/* Fallback if category has no items */}
              {activeCategory === 'variety' && filteredVariety.length === 0 && (
                <div className="text-center py-20 space-y-4 animate-fadeIn">
                  <svg className="w-16 h-16 text-slate-700 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="space-y-1">
                    <h4 className="text-lg font-bold text-slate-200">Tidak ada Variety Show</h4>
                    <p className="text-slate-500 text-sm max-w-sm mx-auto">
                      Belum ada katalog variety show yang tersedia untuk saat ini.
                    </p>
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}

      {/* 4. DETAIL MEDIA PANEL MODAL */}
      {selectedItem && (
        <MediaDetails
          selectedItem={selectedItem}
          onClose={() => setSelectedItem(null)}
          selectedItemVideos={selectedItemVideos}
          isVideosLoading={isVideosLoading}
          activeSeason={activeSeason}
          setActiveSeason={setActiveSeason}
          handlePlayVideo={handlePlayVideo}
          playingVideo={playingVideo}
          videoStreamDetails={videoStreamDetails}
          handleClosePlayer={handleClosePlayer}
          handleVideoTimeUpdate={handleVideoTimeUpdate}
          continueWatching={continueWatching}
          getPosterUrl={getPosterUrl}
          getApiUrl={getApiUrl}
        />
      )}
    </div>
  );
}
