import { Search, RotateCcw, Globe, User, LogOut, Trash2, X, PlayCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchContent, getTMDBInfo } from '../services/api';

const Navbar = ({ onMeClick, isLoggedIn, username, onLogout }) => {
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const navigate = useNavigate();

  // Debounced search
  useEffect(() => {
    const term = searchTerm.trim();
    if (!term) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await searchContent(term);
        const uniqueResults = [];
        const seenNames = new Set();
        for (const item of results || []) {
          const name = item.folder_name || item.name;
          if (name && !seenNames.has(name)) {
            seenNames.add(name);
            uniqueResults.push(item);
          }
        }

        // Take top 6 results for the dropdown
        const topResults = uniqueResults.slice(0, 6);

        // Enrich with TMDB data if missing so posters show up
        const enriched = await Promise.all(
          topResults.map(async (item) => {
            if (item.tmdb_poster_path) return item;
            const title = item.tmdb_title || item.folder_name || item.name;
            if (!title) return item;

            try {
              const tmdbData = await getTMDBInfo(title);
              if (tmdbData) {
                return {
                  ...item,
                  tmdb_poster_path: tmdbData.poster_path || item.tmdb_poster_path,
                  tmdb_rating: tmdbData.rating || item.tmdb_rating,
                };
              }
            } catch { /* skip */ }
            return item;
          })
        );

        setSuggestions(enriched);
      } catch (error) {
        console.error("Search suggestion error:", error);
      } finally {
        setIsSearching(false);
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [searchTerm]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchTerm.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchTerm)}`);
      setIsSearchFocused(false);
    }
  };

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav className={`fixed top-0 w-full z-[100] px-6 py-4 flex items-center gap-6 transition-colors duration-300 ${isScrolled ? 'bg-[#111319] shadow-lg border-b border-white/5' : 'bg-gradient-to-b from-black/80 to-transparent'}`}>
      <div onClick={() => navigate('/')} className="text-brand font-black text-3xl md:text-4xl tracking-tight cursor-pointer select-none">
        MUTFLIX
      </div>
      <div className="flex gap-4 lg:gap-8 text-sm md:text-base font-medium text-gray-300 whitespace-nowrap hidden md:flex">
        <a href="#" className="text-white font-bold relative after:content-[''] after:absolute after:w-4 after:h-[3px] after:bg-brand after:-bottom-1 after:left-1/2 after:-translate-x-1/2 after:rounded-full">For You</a>
        <a href="#" className="hover:text-white transition-colors">Pursuit of Jade</a>
        <a href="#" className="hover:text-white transition-colors flex items-center gap-1">More <span className="text-[10px]">▼</span></a>
      </div>

      <div className="flex-1 max-w-md xl:max-w-lg relative lg:ml-8 hidden sm:block">
        <form onSubmit={handleSearch}>
          <input
            type="text"
            placeholder="Pursuit of Jade"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-white/10 hover:bg-white/15 text-white text-sm rounded-full py-2.5 px-5 outline-none focus:bg-white/20 transition-all border border-white/10"
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setTimeout(() => setIsSearchFocused(false), 200)}
          />
          <Search onClick={handleSearch} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5 cursor-pointer hover:text-white" />
        </form>

        {/* iQIYI-style Search Dropdown */}
        {isSearchFocused && (
          <div className="absolute top-[calc(100%+8px)] left-0 w-full lg:w-[420px] bg-[#1a1c22] border border-white/10 shadow-2xl rounded-lg py-4 z-[100] animate-slide-up overflow-hidden">

            {searchTerm.trim().length > 0 ? (
              /* Search Suggestions (Active Typing) */
              <div className="px-5">
                <div className="text-[13px] text-gray-500 font-medium mb-3 flex justify-between items-center">
                  <span>Suggestions</span>
                  {isSearching && <span className="text-[11px] text-[#00dc41] animate-pulse">Searching...</span>}
                </div>

                {suggestions.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {suggestions.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 cursor-pointer group p-2 hover:bg-white/5 rounded-lg transition-colors"
                        onMouseDown={() => navigate(`/detail/${encodeURIComponent(item.folder_name || item.name || '')}?type=${item.type === 'tv' ? 'series' : (item.type || 'movie')}`)}
                      >
                        <div className="w-8 h-11 rounded overflow-hidden bg-white/5 flex items-center justify-center flex-shrink-0 border border-white/5 group-hover:border-white/20 transition-colors">
                          {item.tmdb_poster_path ? (
                            <img
                              src={item.tmdb_poster_path.startsWith('http') ? item.tmdb_poster_path : `https://image.tmdb.org/t/p/w92${item.tmdb_poster_path}`}
                              alt={item.folder_name || item.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <PlayCircle className="w-4 h-4 text-gray-500 group-hover:text-[#00dc41] transition-colors" />
                          )}
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-[14px] text-gray-200 group-hover:text-white truncate font-medium">
                            {item.folder_name || item.name}
                          </span>
                          <span className="text-[11px] text-gray-500 truncate flex items-center gap-1">
                            {item.type === 'tv' ? 'Series' : 'Movie'}
                            {item.tmdb_rating && <span>• ⭐ {Number(item.tmdb_rating).toFixed(1)}</span>}
                          </span>
                        </div>
                      </div>
                    ))}

                    <div
                      className="mt-2 pt-3 border-t border-white/10 text-center text-[13px] text-[#00dc41] cursor-pointer hover:text-white transition"
                      onMouseDown={(e) => { e.preventDefault(); handleSearch(e); }}
                    >
                      View all results for "{searchTerm}"
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6 text-gray-500 text-[13px]">
                    {!isSearching && "No exact matches found."}
                  </div>
                )}
              </div>
            ) : (
              /* Search History & Popular (Empty State) */
              <>
                <div className="px-5 mb-5">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-[13px] text-gray-500 font-medium">Search History</span>
                    <Trash2 className="w-4 h-4 text-gray-500 cursor-pointer hover:text-white transition" />
                  </div>
                  <div className="flex justify-between items-center group cursor-pointer py-1" onMouseDown={() => navigate('/search?q=Peaceful%20Property')}>
                    <span className="text-[13px] text-gray-300 group-hover:text-[#00dc41] transition">Peaceful Property</span>
                    <X className="w-3.5 h-3.5 text-gray-600 hover:text-white" />
                  </div>
                </div>

                <div className="px-5">
                  <div className="text-[13px] text-gray-500 font-medium mb-4">Popular Searches</div>
                  <div className="flex flex-col gap-3.5">
                    {[
                      'Ashes of Love',
                      'Crash Landing on You',
                      'Vincenzo',
                      'Business Proposal',
                      'Squid Game',
                      'True Beauty',
                      'Hotel Del Luna',
                      'One Piece'
                    ].map((term, idx) => (
                      <div key={idx} className="flex items-center gap-4 cursor-pointer group" onMouseDown={() => navigate(`/search?q=${encodeURIComponent(term)}`)}>
                        <span className={`text-[14px] font-bold w-3 text-center ${idx < 3 ? 'text-[#00dc41]' : 'text-gray-500'}`}>
                          {idx + 1}
                        </span>
                        <span className="text-[13.5px] text-gray-300 group-hover:text-[#00dc41] transition font-medium">
                          {term}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

          </div>
        )}
      </div>

      <div className="flex flex-1 justify-end gap-5 sm:gap-6 items-center text-xs text-gray-300 font-medium z-40 relative">
        <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group">
          <RotateCcw className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
          <span className="hidden lg:block">History</span>
        </div>
        <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group">
          <Globe className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
          <span className="hidden lg:block">Language</span>
        </div>

        {isLoggedIn ? (
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group" onClick={onMeClick}>
              <User className="w-5 h-5 mb-0.5 text-brand" />
              <span className="hidden lg:block text-brand">{username}</span>
            </div>
            <div className="flex flex-col items-center cursor-pointer hover:text-red-400 transition group" onClick={onLogout}>
              <LogOut className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-red-400" />
              <span className="hidden lg:block">Logout</span>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center cursor-pointer hover:text-brand transition group relative"
            onClick={onMeClick}
          >
            <div className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-black"></div>
            <User className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
            <span className="hidden lg:block">Me</span>
          </div>
        )}
      </div>

      <div className="flex gap-2 sm:gap-3 ml-2 lg:ml-4 flex-shrink-0 z-40 relative">
        <button className="hidden xl:flex items-center gap-2 border border-white/20 rounded hover:bg-white/10 transition px-3 py-1.5 h-9">
          <span className="text-xs font-semibold">Enjoy on TV</span>
        </button>
        <button className="bg-gradient-to-r from-[#e3c193] to-[#d4a06b] text-black font-extrabold px-3 sm:px-4 py-1.5 rounded h-9 flex items-center gap-1.5 hover:brightness-110 transition shadow-[0_0_15px_rgba(227,193,147,0.3)]">
          <div className="w-4 h-4 rounded-full border-[1.5px] border-black flex items-center justify-center text-[10px]">V</div>
          <span className="text-sm">VIP</span>
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
