const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space';

export const TMDB_GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
  10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

// Token hanya dari localStorage (login flow)
const getToken = () => localStorage.getItem('token') || '';

// Mengambil info dari TMDB jika backend tidak mengirimkan poster
export const getTMDBInfo = async (title) => {
    const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
    if (!tmdbKey || !title || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;
    
    try {
        const cleanTitle = title.replace(/\(\d{4}\)/g, '').trim();
        const query = encodeURIComponent(cleanTitle);
        const res = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${query}&language=en-US`);
        const data = await res.json();
        
        if (data.results && data.results.length > 0) {
            const bestResult = data.results.find(i => i.poster_path || i.backdrop_path) || data.results[0];
            return {
                tmdb_id: bestResult.id,
                media_type: bestResult.media_type, // 'movie' or 'tv'
                poster_path: bestResult.poster_path,
                backdrop_path: bestResult.backdrop_path,
                rating: bestResult.vote_average,
                overview: bestResult.overview,
                date: bestResult.release_date || bestResult.first_air_date,
                genre_ids: bestResult.genre_ids || []
            };
        }
        return null;
    } catch (e) {
        console.error("TMDB fetch error:", e);
        return null;
    }
};

// Mengambil data cast/crew dari TMDB
export const getTMDBCredits = async (tmdbId, mediaType) => {
    const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
    if (!tmdbKey || !tmdbId || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;
    
    try {
        const type = mediaType === 'movie' ? 'movie' : 'tv';
        const res = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/credits?api_key=${tmdbKey}&language=en-US`);
        const data = await res.json();
        return {
            cast: (data.cast || []).slice(0, 20).map(c => ({
                id: c.id,
                name: c.name,
                character: c.character,
                profile_path: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
            })),
            director: (data.crew || []).find(c => c.job === 'Director')?.name || null
        };
    } catch (e) {
        console.error("TMDB credits fetch error:", e);
        return null;
    }
};

export const getTMDBSeasonDetails = async (tmdbId, seasonNumber) => {
  const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
  if (!tmdbKey || !tmdbId || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;
  try {
    const response = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${tmdbKey}&language=en-US`);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("Error fetching TMDB season details:", error);
    return null;
  }
};

export const fetchContentReleases = async () => {
    try {
        const res = await fetch(`${BASE_URL}/api/content-releases`, {
            headers: { 'x-access-token': getToken() }
        });
        if (!res.ok) throw new Error('Network error');
        return await res.json();
    } catch (error) {
        console.error("Error fetching content releases:", error);
        return [];
    }
};

export const fetchFolders = async () => {
    try {
        const res = await fetch(`${BASE_URL}/api/folders`, {
            headers: { 'x-access-token': getToken() }
        });
        if (!res.ok) throw new Error('Network error');
        return await res.json();
    } catch (error) {
        console.error("Error fetching folders:", error);
        return [];
    }
};

export const fetchVideos = async (folderName) => {
    try {
        const res = await fetch(`${BASE_URL}/api/videos/${encodeURIComponent(folderName)}`, {
            headers: { 'x-access-token': getToken() }
        });
        if (!res.ok) throw new Error('Network error');
        return await res.json();
    } catch (error) {
        console.error("Error fetching videos:", error);
        return { videos: [], has_season_folders: false };
    }
};

// ==========================================
// AUTH API
// ==========================================

export const loginUser = async (username, password, rememberMe = false) => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember_me: rememberMe })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.message || 'Login failed');
    }
    // Simpan token ke localStorage
    localStorage.setItem('token', data.token);
    localStorage.setItem('username', data.username);
    localStorage.setItem('role', data.role);
    return data;
};

export const registerUser = async (username, password, registrationToken) => {
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, token: registrationToken })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.message || 'Registration failed');
    }
    return data;
};

export const getAuthStatus = async () => {
    const token = getToken();
    if (!token) return null;
    try {
        const res = await fetch(`${BASE_URL}/api/auth/status`, {
            headers: { 'x-access-token': token }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
};

export const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
};

export const isLoggedIn = () => !!localStorage.getItem('token');
