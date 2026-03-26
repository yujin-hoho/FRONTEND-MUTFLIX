import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { MovieCard } from '../components/MovieCarousel';
import { fetchFolders, fetchContentReleases, getTMDBInfo, logout } from '../services/api';

const Search = () => {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalItems, setTotalItems] = useState(0);
  
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

  useEffect(() => {
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    const loadAndSearch = async () => {
      setLoading(true);
      try {
        // 1. Fetch all data
        const [foldersResp, releasesResp] = await Promise.all([
          fetchFolders(),
          fetchContentReleases()
        ]);

        // 2. Extract folders (shape: { series: [...], movies: [...] })
        let foldersData = [];
        if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
        } else if (foldersResp && typeof foldersResp === 'object') {
          const movies = foldersResp.movies || [];
          const series = foldersResp.series || [];
          foldersData = [...movies, ...series];
        }

        // 3. Extract releases (shape: array)
        let releasesData = Array.isArray(releasesResp) ? releasesResp : [];

        // 4. Build unified list — prefer releases (richer data) over folders
        // Key by the primary identifier (folder_name or name)
        const itemMap = new Map();
        
        // Add releases first (they have tmdb_title, poster, etc.)
        releasesData.forEach(item => {
          const key = (item.folder_name || '').toLowerCase().trim();
          if (key) itemMap.set(key, item);
        });
        
        // Add folders — only if not already in map from releases
        foldersData.forEach(item => {
          const key = (item.name || '').toLowerCase().trim();
          if (key && !itemMap.has(key)) {
            // Normalize fields to match release structure
            itemMap.set(key, { 
              ...item, 
              folder_name: item.name,
              media_type: item.type === 'tv' ? 'tv' : 'movie'
            });
          }
        });

        const allItems = Array.from(itemMap.values());
        setTotalItems(allItems.length);

        // 5. Search with simple, reliable substring matching
        const q = query.toLowerCase().trim();
        
        const scored = allItems
          .map(item => {
            const folderName = (item.folder_name || '').toLowerCase();
            const tmdbTitle = (item.tmdb_title || '').toLowerCase();
            const name = (item.name || '').toLowerCase();
            const overview = (item.tmdb_overview || '').toLowerCase();
            
            // Score: higher = better match
            let score = 0;
            
            // Exact match on any name field
            if (folderName === q || tmdbTitle === q || name === q) {
              score = 100;
            }
            // Starts with query
            else if (folderName.startsWith(q) || tmdbTitle.startsWith(q) || name.startsWith(q)) {
              score = 80;
            }
            // Contains query as substring
            else if (folderName.includes(q) || tmdbTitle.includes(q) || name.includes(q)) {
              score = 60;
            }
            // Word-level matching: check if all query words appear somewhere
            else {
              const queryWords = q.split(/\s+/).filter(w => w.length > 1);
              const haystack = `${folderName} ${tmdbTitle} ${name} ${overview}`;
              const matchCount = queryWords.filter(w => haystack.includes(w)).length;
              if (matchCount === queryWords.length) {
                score = 40; // All words match
              } else if (matchCount > 0) {
                score = 20 * (matchCount / queryWords.length); // Partial word match
              }
            }

            return { item, score };
          })
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score);

        // 6. Resolve TMDB info for top results (for poster display)
        const topResults = scored.slice(0, 50);
        const resolved = await Promise.all(
          topResults.map(async ({ item }) => {
            // Skip if already has poster
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
                  tmdb_overview: tmdbData.overview || item.tmdb_overview,
                };
              }
            } catch (e) { /* skip */ }
            return item;
          })
        );

        setResults(resolved);
      } catch (e) {
        console.error('Search error:', e);
        setResults([]);
      } finally {
        setLoading(false);
      }
    };

    loadAndSearch();
  }, [query]);

  return (
    <div className="min-h-screen bg-darkBG font-sans pb-20 overflow-x-hidden pt-24 animate-page-enter">
      <Navbar 
        onMeClick={() => setShowLoginModal(true)} 
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />
      <div className="px-6 md:px-[60px] pb-12 w-full max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-white mb-2">
          Search Results for "{query}"
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          {loading ? 'Searching...' : `${results.length} results found from ${totalItems} items`}
        </p>
        
        {loading ? (
          <div className="flex justify-center mt-20">
             <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : results.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
            {results.map((item, idx) => (
              <div key={item.folder_name || item.name || idx} className="flex justify-center">
                <MovieCard item={item} />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-gray-400 mt-10 text-center py-20 bg-[#16181d] rounded-lg border border-white/5">
            No results found for "{query}". Try another search term.
          </div>
        )}
      </div>
    </div>
  );
};

export default Search;
