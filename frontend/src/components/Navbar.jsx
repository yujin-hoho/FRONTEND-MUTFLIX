import { Search, RotateCcw, List, User, LogOut, Trash2, X, PlayCircle, ChevronDown, Plus, Check } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { searchContent, getTMDBInfo, fetchProfiles, createProfile, tmdbImageUrl } from '../services/api';
import { detailTypeOfItem, isSeriesLike } from '../utils/mediaType';
import { cleanTitleOutsideParentheses } from '../utils/cleanTitle';
import { createDetailNavigationState } from '../utils/detailMetadata';

/** Genre singkat → `/filter?category=…` (Variety Show di ujung) */
const MORE_GENRE_LINKS = [
  { label: 'Drama', value: 'Drama' },
  { label: 'Romance', value: 'Romance' },
  { label: 'Comedy', value: 'Comedy' },
  { label: 'Action', value: 'Action' },
  { label: 'Horror', value: 'Horror' },
  { label: 'Variety Show', value: 'Variety Show' },
];

const profileInitial = (profile) => (profile?.name || 'P').trim().slice(0, 1).toUpperCase();
const profileColor = (seed = '') => {
  const colors = ['#00dc41', '#38bdf8', '#f59e0b', '#ec4899', '#a78bfa', '#f97316'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash + seed.charCodeAt(i) * (i + 1)) % colors.length;
  return colors[hash];
};

const Navbar = ({ onMeClick, isLoggedIn, username, onLogout, onProfileChange }) => {
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [activeProfileId, setActiveProfileId] = useState(() => localStorage.getItem('mutflix_last_profile_id') || '');
  const [newProfileName, setNewProfileName] = useState('');
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const moreWrapRef = useRef(null);
  const profileWrapRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

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
            if (item.tmdb_poster_path || item.poster_path) return item;
            const title = item.tmdb_title || item.folder_name || item.name;
            if (!title) return item;

            try {
              const tmdbData = await getTMDBInfo(title, { light: true });
              if (tmdbData) {
                return {
                  ...item,
                  tmdb_poster_path: tmdbData.poster_path || item.tmdb_poster_path || item.poster_path,
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

  useEffect(() => {
    const onDoc = (e) => {
      if (moreWrapRef.current && !moreWrapRef.current.contains(e.target)) setMoreOpen(false);
      if (profileWrapRef.current && !profileWrapRef.current.contains(e.target)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!isLoggedIn) {
      setProfiles([]);
      setActiveProfileId('');
      setProfileOpen(false);
      return;
    }

    let cancelled = false;
    const loadProfiles = async () => {
      const data = await fetchProfiles();
      if (cancelled) return;

      setProfiles(data);
      const savedId = localStorage.getItem('mutflix_last_profile_id');
      const active = data.find((p) => p.id === savedId) || data[0];
      if (active) {
        if (active.id !== savedId) {
          localStorage.setItem('mutflix_last_profile_id', active.id);
          onProfileChange?.(active);
          window.dispatchEvent(new CustomEvent('mutflix-profile-change', { detail: active }));
        }
        setActiveProfileId(active.id);
      }
    };

    loadProfiles();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, onProfileChange]);

  const selectProfile = (profile) => {
    localStorage.setItem('mutflix_last_profile_id', profile.id);
    setActiveProfileId(profile.id);
    setProfileOpen(false);
    onProfileChange?.(profile);
    window.dispatchEvent(new CustomEvent('mutflix-profile-change', { detail: profile }));
  };

  const handleCreateProfile = async (e) => {
    e.preventDefault();
    const name = newProfileName.trim();
    if (!name || isCreatingProfile) return;

    setIsCreatingProfile(true);
    const id = `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const avatarSeed = name.toLowerCase().replace(/\s+/g, '-') || 'web-user';
    const success = await createProfile(id, name, avatarSeed);
    setIsCreatingProfile(false);
    if (!success) return;

    const profile = { id, name, avatar_seed: avatarSeed };
    setProfiles((prev) => [...prev, profile]);
    setNewProfileName('');
    selectProfile(profile);
  };

  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  const forYouActive = location.pathname === '/dashboard';

  return (
    <nav
      className={`fixed top-0 left-0 right-0 w-full z-[9999] px-4 sm:px-6 py-3.5 flex items-center gap-4 sm:gap-6 transition-[background,box-shadow,border-color] duration-300 ${
        isScrolled
          ? 'bg-[#0a0b0f]/95 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,0.45)] border-b border-white/[0.07]'
          : 'bg-gradient-to-b from-black/90 via-black/50 to-transparent'
      }`}
    >
      <div onClick={() => navigate('/')} className="text-brand font-black text-2xl sm:text-3xl md:text-4xl tracking-tight cursor-pointer select-none shrink-0">
        MUTFLIX
      </div>
      <div className="flex gap-3 lg:gap-6 text-sm md:text-[15px] font-medium text-gray-300 whitespace-nowrap hidden md:flex items-center">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className={`px-0.5 pb-0.5 transition-colors border-b-2 ${
            forYouActive ? 'text-white font-bold border-[#00dc41]' : 'border-transparent text-gray-300 hover:text-white'
          }`}
        >
          For You
        </button>
        <div className="relative shrink-0" ref={moreWrapRef}>
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className={`flex items-center gap-1 hover:text-white transition-colors ${moreOpen ? 'text-white' : ''}`}
            aria-expanded={moreOpen}
            aria-haspopup="true"
          >
            More
            <ChevronDown className={`w-4 h-4 opacity-80 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
          </button>
          {moreOpen && (
            <div
              role="menu"
              className="absolute top-full left-0 mt-2 w-[220px] max-w-[min(220px,calc(100vw-2rem))] flex flex-col items-stretch py-2 rounded-lg bg-[#14161c] border border-white/10 shadow-2xl z-[10000] animate-slide-up whitespace-normal"
            >
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 font-semibold shrink-0">
                Browse by genre
              </div>
              {MORE_GENRE_LINKS.map(({ label, value }) => (
                <button
                  key={value}
                  type="button"
                  role="menuitem"
                  className="block w-full text-left px-3 py-2.5 text-[13px] text-gray-200 hover:bg-white/5 hover:text-[#00dc41] transition-colors shrink-0"
                  onClick={() => {
                    navigate(`/filter?category=${encodeURIComponent(value)}`);
                    setMoreOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 max-w-md xl:max-w-lg relative lg:ml-8 hidden sm:block">
        <form onSubmit={handleSearch}>
          <input
            type="text"
            placeholder="Cari judul, genre…"
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
                        onMouseDown={() => navigate(`/detail/${encodeURIComponent(item.folder_name || item.name || '')}?type=${detailTypeOfItem(item)}`, {
                          state: createDetailNavigationState(item),
                        })}
                      >
                        <div className="w-8 h-11 rounded overflow-hidden bg-white/5 flex items-center justify-center flex-shrink-0 border border-white/5 group-hover:border-white/20 transition-colors">
                          {(item.tmdb_poster_path || item.poster_path) ? (
                            <img
                              src={tmdbImageUrl(item.tmdb_poster_path || item.poster_path, 'w92')}
                              alt={cleanTitleOutsideParentheses(item.folder_name || item.name)}
                              loading="lazy"
                              decoding="async"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <PlayCircle className="w-4 h-4 text-gray-500 group-hover:text-[#00dc41] transition-colors" />
                          )}
                        </div>
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-[14px] text-gray-200 group-hover:text-white truncate font-medium">
                            {cleanTitleOutsideParentheses(item.folder_name || item.name)}
                          </span>
                          <span className="text-[11px] text-gray-500 truncate flex items-center gap-1">
                            {isSeriesLike(item) ? 'Series' : 'Movie'}
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
        <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group" onClick={() => navigate('/mylist')}>
          <List className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
          <span className="hidden lg:block">My List</span>
        </div>

        {isLoggedIn ? (
          <div className="flex items-center gap-3">
            <div className="relative" ref={profileWrapRef}>
              <button
                type="button"
                className="flex flex-col items-center cursor-pointer hover:text-brand transition group"
                onClick={() => setProfileOpen((open) => !open)}
              >
                <div
                  className="w-5 h-5 mb-0.5 rounded-full text-[11px] font-black text-black flex items-center justify-center ring-1 ring-white/20"
                  style={{ backgroundColor: profileColor(activeProfile?.avatar_seed || activeProfile?.id || username || '') }}
                >
                  {activeProfile ? profileInitial(activeProfile) : <User className="w-3.5 h-3.5" />}
                </div>
                <span className="hidden lg:block text-brand max-w-24 truncate">{activeProfile?.name || username}</span>
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-[calc(100%+12px)] w-[260px] bg-[#17191f] border border-white/10 shadow-2xl rounded-lg p-2 z-[120] animate-slide-up">
                  <div className="px-2 py-2 text-[12px] text-gray-500 font-bold uppercase tracking-wide">Profiles</div>

                  <div className="flex flex-col gap-1 max-h-[260px] overflow-y-auto no-scrollbar">
                    {profiles.map((profile) => {
                      const selected = profile.id === activeProfileId;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          onClick={() => selectProfile(profile)}
                          className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-left hover:bg-white/5 transition"
                        >
                          <span
                            className="w-8 h-8 rounded-full text-[13px] font-black text-black flex items-center justify-center shrink-0"
                            style={{ backgroundColor: profileColor(profile.avatar_seed || profile.id) }}
                          >
                            {profileInitial(profile)}
                          </span>
                          <span className="flex-1 min-w-0 text-[14px] font-semibold text-white truncate">{profile.name}</span>
                          {selected && <Check size={16} className="text-[#00dc41] shrink-0" strokeWidth={3} />}
                        </button>
                      );
                    })}
                  </div>

                  <form onSubmit={handleCreateProfile} className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2">
                    <input
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="New profile"
                      maxLength={24}
                      className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-md px-3 py-2 text-[13px] text-white placeholder:text-gray-500 outline-none focus:border-[#00dc41]/60"
                    />
                    <button
                      type="submit"
                      disabled={!newProfileName.trim() || isCreatingProfile}
                      className="w-9 h-9 rounded-md bg-[#00dc41] text-black flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
                      title="Add profile"
                    >
                      <Plus size={18} strokeWidth={3} />
                    </button>
                  </form>

                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      onMeClick?.();
                    }}
                    className="mt-2 w-full text-left px-2 py-2 rounded-md text-[13px] text-gray-400 hover:text-white hover:bg-white/5 transition"
                  >
                    Account
                  </button>
                </div>
              )}
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
