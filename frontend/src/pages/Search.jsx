import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Navbar from '../components/Navbar';
import { MovieCard } from '../components/MovieCarousel';
import { searchContent, getTMDBInfo, logout, fetchFolders } from '../services/api';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';

const Search = () => {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

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

    const doSearch = async () => {
      setLoading(true);
      try {
        const [serverResults, foldersResp] = await Promise.all([
          searchContent(query),
          fetchFolders()
        ]);

        // PHASE 1: Show results immediately
        const mappedServer = serverResults.map(item => ({
          ...item,
          folder_name: item.folder_name || item.name,
          media_type: item.type === 'tv' ? 'tv' : (item.type || 'movie')
        }));

        // Augment with local localStorage cache search for Actors and Genres
        let foldersData = [];
        if (foldersResp && typeof foldersResp === 'object' && !Array.isArray(foldersResp)) {
          foldersData = [...(foldersResp.movies || []), ...(foldersResp.series || [])];
        } else if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
        }
        let releasesData = [];
        const allData = [...releasesData, ...foldersData];
        
        const localMatches = [];
        const queryLower = query.toLowerCase();

        allData.forEach(item => {
          const title = item.tmdb_title || item.folder_name || item.name;
          if (!title) return;
          const cleanTitle = title.replace(/\(\d{4}\)/g, '').trim().toLowerCase();
          
          let matched = cleanTitle.includes(queryLower);
          
          if (!matched) {
            const cacheRaw = localStorage.getItem(`mutflix_tmdb_info_${cleanTitle}`);
            if (cacheRaw) {
              try {
                const cacheData = JSON.parse(cacheRaw);
                const hasActor = cacheData.cast?.some(c => c.name.toLowerCase().includes(queryLower));
                const hasGenre = cacheData.genres?.some(g => g.name.toLowerCase().includes(queryLower));
                if (hasActor || hasGenre) {
                  matched = true;
                }
              } catch(e){}
            }
          }
           
          if (matched) {
            localMatches.push({
               ...item,
               folder_name: item.folder_name || item.name,
               media_type: item.type === 'tv' ? 'tv' : (item.type || 'movie')
            });
          }
        });

        const combined = [...localMatches, ...mappedServer];

        // Deduplicate mappedResults based on folder_name to avoid duplicate React keys
        const uniqueResults = [];
        const seenNames = new Set();
        for (const item of combined) {
          const name = item.folder_name || item.name;
          if (name && !seenNames.has(name)) {
            seenNames.add(name);
            uniqueResults.push(item);
          }
        }
        setResults(uniqueResults);
        const finalMappedResults = uniqueResults;
        // setLoading(false); // We now wait for enrichment below

        // PHASE 2: Enrich top results with TMDB posters (background)
        const topToEnrich = finalMappedResults.slice(0, 20);
        const enriched = await Promise.all(
          topToEnrich.map(async (item) => {
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
            } catch { /* skip */ }
            return item;
          })
        );

        // Merge enriched back
        const enrichedMap = new Map();
        enriched.forEach(item => {
          const name = item.folder_name || item.name;
          if (name) enrichedMap.set(name, item);
        });
        const finalResults = finalMappedResults.map(item => {
          const name = item.folder_name || item.name;
          return enrichedMap.get(name) || item;
        });

        setResults(finalResults);
        setLoading(false); // Now we are ready!
      } catch (e) {
        console.error('Search error:', e);
        setResults([]);
        setLoading(false);
      }
    };

    doSearch();
  }, [query]);

  return (
    <div className="min-h-screen bg-darkBG font-sans flex flex-col overflow-x-hidden pt-24 animate-page-enter">
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
          {loading ? 'Searching...' : `${results.length} results found`}
        </p>

        {loading ? (
          <LoadingScreen />
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
      <Footer />
    </div>
  );
};

export default Search;

