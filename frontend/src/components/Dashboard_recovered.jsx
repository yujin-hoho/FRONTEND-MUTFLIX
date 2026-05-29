import React, { useState, useEffect } from 'react';
import MediaDetails from './MediaDetails';

// API Helper to handle dev/prod URL matching with HuggingFace Space
const getApiUrl = (path) => {
  if (window.location.hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

export default function Dashboard({ session, activeProfile, onSwitchProfile }) {
  const [content, setContent] = useState({ series: [], movies: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isBulkLoading, setIsBulkLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all'); // 'all' | 'series' | 'movies'
  const [selectedItem, setSelectedItem] = useState(null); // Detail modal

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

  // Filters logic (Prioritizes showing the clean TMDB title over plain folder names)
  const filteredSeries = content.series.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return title.includes(searchQuery.toLowerCase());
  });

  const filteredMovies = content.movies.filter(item => {
    const title = (item.tmdb_title || item.name || '').toLowerCase();
    return title.includes(searchQuery.toLowerCase());
  });

  // Pick a featured item for the gorgeous Hero Banner (preferably one with resolved posters)
  const allItems = [...content.movies, ...content.series];
  const featuredItem = allItems.find(item => item.tmdb_overview && item.tmdb_poster_path) || allItems[0];

  const getPosterUrl = (path) => {
    if (!path) return null;
    return `https://image.tmdb.org/t/p/w500${path}`;
  };

  return (
    <div className="w-full max-w-7xl mx-auto py-6 px-4 sm:px-6 relative z-10 select-none animate-fadeIn">
      
      {/* Navigation & Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 border-b border-slate-900 pb-6">
        
        {/* Profile Info Left */}
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-green-600 flex items-center justify-center font-bold text-white text-xl shadow-lg shadow-green-950/20">
            {activeProfile.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <h2 className="text-xl font-bold text-white tracking-tight leading-none">
              {activeProfile.name}
            </h2>
            <span className="text-xs text-slate-500 font-medium tracking-wide uppercase mt-1 block">
              Menonton Mutflix
            </span>
          </div>
        </div>

        {/* Search and Category Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Search bar */}
          <div className="relative w-full sm:w-64">
            <input
              type="text"
              placeholder="Cari film atau serial..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-800 focus:border-green-500 focus:ring-1 focus:ring-green-500 rounded-xl text-sm outline-none transition-all placeholder:text-slate-600 text-slate-200"
            />
            <svg className="w-4 h-4 text-slate-600 absolute left-3.5 top-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {/* Filter Pill Tabs */}
          <div className="flex bg-slate-950 border border-slate-850 rounded-xl p-1">
            {['all', 'series', 'movies'].map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all ${
                  activeCategory === cat 
                    ? 'bg-green-600 text-white' 
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {cat === 'all' ? 'Semua' : cat === 'series' ? 'Serial TV' : 'Film'}
              </button>
            ))}
          </div>

          {/* Back to Profiles */}
          <button
            onClick={onSwitchProfile}
            className="px-4 py-2.5 bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 hover:text-white text-xs font-semibold rounded-xl uppercase tracking-wider transition-all"
          >
            Ganti Profil
          </button>
        </div>
      </div>

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
                  {[...filteredSeries, ...filteredMovies].length} Ditemukan
                </span>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                {[...filteredSeries, ...filteredMovies].map((item) => (
                  <div 
                    key={item.name}
                    onClick={() => setSelectedItem(item)}
                    className="group bg-slate-900 border border-slate-850 hover:border-green-500 rounded-xl overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:-translate-y-1"
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

                    <div className="p-3.5 space-y-1 text-left">
                      <h4 className="text-sm font-bold text-slate-200 truncate group-hover:text-white transition-colors">
                        {item.tmdb_title || item.name}
                      </h4>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-500 tracking-wider font-semibold uppercase">
                          {item.type === 'series' ? 'Serial' : 'Film'}
                        </span>
                        {item.source && item.source.startsWith("telegram/") && (
                          <span className="text-[9px] text-sky-400 font-bold uppercase">
                            Telegram
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {filteredSeries.length === 0 && filteredMovies.length === 0 && (
                <div className="text-center py-20 space-y-4 animate-fadeIn">
                  <svg className="w-16 h-16 text-slate-700 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="space-y-1">
                    <h4 className="text-lg font-bold text-slate-200">Katalog Tidak Ditemukan</h4>
                    <p className="text-slate-500 text-sm max-w-sm mx-auto">
                      Tidak ada film atau serial TV yang cocok dengan kueri "{searchQuery}".
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
                      <div 
                        key={item.name}
                        onClick={() => setSelectedItem(item)}
                        className="flex-shrink-0 w-[150px] sm:w-[180px] md:w-[200px] snap-start group bg-slate-900 border border-slate-850 hover:border-green-500 rounded-xl overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:shadow-green-950/20"
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
                          <span className="text-[10px] text-slate-500 tracking-wider font-semibold uppercase">
                            Serial TV
                          </span>
                        </div>
                      </div>
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
                      <div 
                        key={item.name}
                        onClick={() => setSelectedItem(item)}
                        className="flex-shrink-0 w-[150px] sm:w-[180px] md:w-[200px] snap-start group bg-slate-900 border border-slate-850 hover:border-green-500 rounded-xl overflow-hidden shadow-lg cursor-pointer transition-all duration-300 hover:-translate-y-1 hover:shadow-green-950/20"
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
                              Film
                            </span>
                            {item.source && item.source.startsWith("telegram/") && (
                              <span className="text-[9px] text-sky-400 font-bold uppercase">
                                Telegram
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      )}

      {/* 4. DETAIL MEDIA PANEL MODAL */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/90 backdrop-blur-md animate-fadeIn">
          <div className="w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative space-y-0">
            
            {/* Top Close Button */}
            <button 
              onClick={() => setSelectedItem(null)}
              className="absolute top-4 right-4 z-25 bg-black/60 text-slate-400 hover:text-white p-2 rounded-full hover:bg-slate-800/80 transition-all outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Poster Header */}
            <div className="relative h-64 sm:h-80 bg-slate-950 overflow-hidden">
              {selectedItem.tmdb_poster_path ? (
                <div 
                  className="absolute inset-0 bg-cover bg-center"
                  style={{ backgroundImage: `url(${getPosterUrl(selectedItem.tmdb_poster_path)})` }}
                ></div>
              ) : (
                <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center">
                  <span className="text-green-500 text-6xl font-extrabold mb-2">
                    {selectedItem.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="text-sm font-mono text-slate-600">{selectedItem.name}</span>
                </div>
              )}

              {/* Gradient Dark Backdrop Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent"></div>
            </div>

            {/* Detail Metadata panel */}
            <div className="p-6 sm:p-8 space-y-6 text-left relative z-10 bg-slate-900">
              <div className="space-y-2">
                <h3 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight leading-tight">
                  {selectedItem.tmdb_title || selectedItem.name}
                </h3>
                
                <div className="flex flex-wrap items-center gap-3">
                  {selectedItem.tmdb_rating !== undefined && (
                    <div className="flex items-center gap-1.5 bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 px-2 py-0.5 rounded text-xs font-bold">
                      ★ {selectedItem.tmdb_rating.toFixed(1)}
                    </div>
                  )}
                  <span className="text-xs text-slate-400 capitalize font-medium">
                    {selectedItem.type === 'series' ? 'Serial TV' : 'Film'}
                  </span>
                  
                  {/* Origin Tag */}
                  {selectedItem.source && selectedItem.source.startsWith("telegram/") ? (
                    <span className="text-xs bg-sky-500/10 border border-sky-500/20 text-sky-400 px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                      Telegram Source
                    </span>
                  ) : (
                    <span className="text-xs bg-green-500/10 border border-green-500/20 text-green-400 px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                      Google Drive
                    </span>
                  )}
                </div>
              </div>

              {/* Synopsis */}
              <div className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block">
                  Sinopsis / Ringkasan
                </span>
                <p className="text-slate-300 text-sm sm:text-base leading-relaxed line-clamp-4">
                  {selectedItem.tmdb_overview || 'Metadata sinopsis lengkap untuk tayangan ini tidak tersedia di database server saat ini. Namun, file video tetap dapat diputar secara lancar.'}
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  onClick={() => alert(`Memulai pemutaran konten: "${selectedItem.name}"...`)}
                  className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-green-950/20 hover:shadow-green-500/10 flex items-center justify-center gap-2 outline-none active:scale-98"
                >
                  <svg className="w-5 h-5 fill-white" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  Putar Sekarang
                </button>
                <button
                  onClick={() => setSelectedItem(null)}
                  className="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded-xl transition-all outline-none"
                >
                  Kembali ke Katalog
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
