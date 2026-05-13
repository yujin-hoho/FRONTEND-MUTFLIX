export const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space';

export const TMDB_GENRES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
    10759: "Action & Adventure", 10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

/** ISO 3166-1 alpha-2 — TMDB origin / production filter (optional) */
export const TMDB_ORIGIN_COUNTRIES = [
    { code: '', label: '— (optional)' },
    { code: 'KR', label: 'South Korea' },
    { code: 'CN', label: 'China' },
    { code: 'TW', label: 'Taiwan' },
    { code: 'HK', label: 'Hong Kong' },
    { code: 'JP', label: 'Japan' },
    { code: 'US', label: 'United States' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'TH', label: 'Thailand' },
    { code: 'ID', label: 'Indonesia' },
    { code: 'MY', label: 'Malaysia' },
    { code: 'SG', label: 'Singapore' },
    { code: 'PH', label: 'Philippines' },
    { code: 'VN', label: 'Vietnam' },
    { code: 'IN', label: 'India' },
    { code: 'FR', label: 'France' },
    { code: 'DE', label: 'Germany' },
    { code: 'ES', label: 'Spain' },
    { code: 'IT', label: 'Italy' },
    { code: 'BR', label: 'Brazil' },
    { code: 'MX', label: 'Mexico' },
    { code: 'CA', label: 'Canada' },
    { code: 'AU', label: 'Australia' },
];

// Token hanya dari localStorage (login flow)
const getToken = () => localStorage.getItem('token') || '';

// Jangan kirim header auth kalau token kosong.
const getAuthHeaders = () => {
    const token = getToken();
    return token ? { 'x-access-token': token } : {};
};

// ==========================================
// 2-TIER CLIENT CACHE (in-memory + sessionStorage)
// ==========================================
// Tier 1: In-memory — instant for SPA navigation (~0ms)
// Tier 2: sessionStorage — persists across soft navigations (~1ms)
// TTL: 5 minutes — backend BG worker refreshes every 30 min anyway

const _memCache = {};
const _memCacheTs = {};
const _swrInflight = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
    // Tier 1: memory
    if (_memCache[key] && (Date.now() - _memCacheTs[key]) < CACHE_TTL) {
        return _memCache[key];
    }
    // Tier 2: sessionStorage
    try {
        const raw = sessionStorage.getItem(`mutflix_${key}`);
        if (raw) {
            const { data, ts } = JSON.parse(raw);
            if ((Date.now() - ts) < CACHE_TTL) {
                _memCache[key] = data;
                _memCacheTs[key] = ts;
                return data;
            }
        }
    } catch { /* ignore */ }
    return null;
}

function cacheSet(key, data) {
    if (!data || data.__error) return; // [FIX] Never cache error objects
    _memCache[key] = data;
    _memCacheTs[key] = Date.now();
    try {
        sessionStorage.setItem(`mutflix_${key}`, JSON.stringify({ data, ts: Date.now() }));
    } catch { /* ignore */ }
}

export const cacheClear = () => {
    // Clear memory
    Object.keys(_memCache).forEach(k => delete _memCache[k]);
    Object.keys(_memCacheTs).forEach(k => delete _memCacheTs[k]);
    // Clear session storage
    try {
        Object.keys(sessionStorage).forEach(k => {
            if (k.startsWith('mutflix_')) sessionStorage.removeItem(k);
        });
    } catch { /* ignore */ }
};

// Stale-While-Revalidate: return cached data instantly, refresh in background
// onUpdate callback is called when fresh data arrives (so components can re-render)
async function cachedFetch(key, fetchFn, onUpdate) {
    const cached = cacheGet(key);
    if (cached) {
        // Return cached immediately, refresh in background once per key.
        if (!_swrInflight.has(key)) {
            const refresh = fetchFn()
                .then(fresh => {
                    // Only update if fresh data is valid
                    if (fresh && !fresh.__error) {
                        cacheSet(key, fresh);
                        if (onUpdate) onUpdate(fresh);
                    }
                    return fresh;
                })
                .catch(() => null)
                .finally(() => _swrInflight.delete(key));
            _swrInflight.set(key, refresh);
        }
        return cached;
    }
    // No cache — fetch synchronously
    if (_swrInflight.has(key)) return _swrInflight.get(key);
    const request = fetchFn()
        .then((data) => {
            if (data && !data.__error) {
                cacheSet(key, data);
            }
            return data;
        })
        .finally(() => _swrInflight.delete(key));
    _swrInflight.set(key, request);
    const data = await request;
    return data;
}

// ==========================================
// TMDB API (with localStorage cache — long-lived, immutable data)
// ==========================================

/** Hapus cache poster TMDB di browser (setelah admin mengubah override) */
export const clearAllTmdbInfoLocalCache = () => {
    try {
        Object.keys(localStorage).forEach((k) => {
            if (k.startsWith('mutflix_tmdb_info_')) localStorage.removeItem(k);
        });
    } catch { /* ignore */ }
};

/** Dedupe request paralel dengan judul + opsi yang sama */
const _tmdbInflight = new Map();

const mapCastFromCredits = (credits) =>
    credits?.cast
        ? credits.cast.slice(0, 15).map((c) => ({
              id: c.id,
              name: c.name,
              profile_path: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
          }))
        : [];

/**
 * Mengambil info dari TMDB. Gunakan options jika ada override dari server (admin).
 * @param {string} title - judul fallback / folder
 * @param {object} [options]
 * @param {string} [options.query] - query pencarian TMDB (override judul)
 * @param {'movie'|'tv'} [options.mediaType]
 * @param {number|null} [options.year] - tahun rilis (movie) atau tahun tayang (tv)
 * @param {string|null} [options.region] - kode negara ISO 3166-1 (opsional)
 * @param {boolean} [options.includeAdult]
 * @param {boolean} [options.light] - mode grid/filter: tanpa credits, detail minimal, 1 request jika hasil search cukup
 */
export const getTMDBInfo = async (title, options = {}) => {
    const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
    if (!tmdbKey || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;

    const queryText = (options.query || title || '').replace(/\(\d{4}\)/g, '').trim();
    if (!queryText) return null;

    const mediaType = options.mediaType;
    const year = options.year != null && options.year !== '' ? Number(options.year) : null;
    const region = (options.region || '').trim() || null;
    const includeAdult = !!options.includeAdult;
    const light = !!options.light;
    const includeCredits = !light;

    const TMDB_INFO_CACHE_VERSION = 'v4_title';
    const cacheKeyFull = `mutflix_tmdb_info_${TMDB_INFO_CACHE_VERSION}_${queryText.toLowerCase()}_ov_${mediaType || 'multi'}_${year ?? 'x'}_${region || 'x'}_${includeAdult ? 'a' : ''}`;
    const cacheKeyLite = `${cacheKeyFull}_lite`;
    const inflightKey = light ? cacheKeyLite : cacheKeyFull;

    const readLite = () => {
        try {
            const raw = localStorage.getItem(cacheKeyLite);
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return null;
    };

    const readFull = () => {
        try {
            const raw = localStorage.getItem(cacheKeyFull);
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return null;
    };

    if (light) {
        const lite = readLite();
        if (lite) return lite;
    } else {
        const full = readFull();
        if (full) return full;
    }

    if (_tmdbInflight.has(inflightKey)) {
        return _tmdbInflight.get(inflightKey);
    }

    const run = (async () => {
        const pickTvWithRegion = (results, reg) => {
            if (!reg || !results?.length) return results?.[0];
            const hit = results.find((r) => r.origin_country && r.origin_country.includes(reg));
            return hit || results[0];
        };

        const pickMovieWithRegion = async (results, reg) => {
            if (!reg || !results?.length) return results[0];
            for (const r of results.slice(0, 8)) {
                try {
                    const dr = await fetch(`https://api.themoviedb.org/3/movie/${r.id}?api_key=${tmdbKey}&language=en-US`);
                    const d = await dr.json();
                    const ok = (d.production_countries || []).some((c) => c.iso_3166_1 === reg);
                    if (ok) return r;
                } catch {
                    /* next */
                }
            }
            return results[0];
        };

        const creditsParam = includeCredits ? '&append_to_response=credits' : '';

        const save = (result) => {
            if (!result) return;
            try {
                if (light) localStorage.setItem(cacheKeyLite, JSON.stringify(result));
                else localStorage.setItem(cacheKeyFull, JSON.stringify(result));
            } catch { /* ignore */ }
        };

        try {
            if (!light) {
                const fullAgain = readFull();
                if (fullAgain) return fullAgain;
                const liteOnly = readLite();
                if (liteOnly?.tmdb_id && liteOnly?.media_type) {
                    const type = liteOnly.media_type === 'movie' ? 'movie' : 'tv';
                    const detailRes = await fetch(
                        `https://api.themoviedb.org/3/${type}/${liteOnly.tmdb_id}?api_key=${tmdbKey}&language=en-US&append_to_response=credits`
                    );
                    const details = await detailRes.json();
                    if (details?.id) {
                        const merged =
                            type === 'movie'
                                ? {
                                      tmdb_id: liteOnly.tmdb_id,
                                      media_type: 'movie',
                                      tmdb_title: details.title || details.original_title || liteOnly.tmdb_title || liteOnly.title || null,
                                      title: details.title || details.original_title || liteOnly.tmdb_title || liteOnly.title || null,
                                      poster_path: details.poster_path || liteOnly.poster_path,
                                      backdrop_path: details.backdrop_path || liteOnly.backdrop_path,
                                      rating: details.vote_average ?? liteOnly.rating,
                                      overview: details.overview || liteOnly.overview,
                                      date: details.release_date || liteOnly.date,
                                      genres: details.genres || [],
                                      genre_ids: (details.genres || []).map((g) => g.id),
                                      cast: mapCastFromCredits(details.credits),
                                      total_episodes: null,
                                      total_seasons: null,
                                      runtime: details.runtime,
                                      origin_country: details.production_countries?.map((c) => c.iso_3166_1) || [],
                                      original_language: details.original_language,
                                  }
                                : {
                                      tmdb_id: liteOnly.tmdb_id,
                                      media_type: 'tv',
                                      tmdb_title: details.name || liteOnly.tmdb_title || liteOnly.title || null,
                                      title: details.name || liteOnly.tmdb_title || liteOnly.title || null,
                                      poster_path: details.poster_path || liteOnly.poster_path,
                                      backdrop_path: details.backdrop_path || liteOnly.backdrop_path,
                                      rating: details.vote_average ?? liteOnly.rating,
                                      overview: details.overview || liteOnly.overview,
                                      date: details.first_air_date || details.last_air_date || liteOnly.date,
                                      genres: details.genres || [],
                                      genre_ids: (details.genres || []).map((g) => g.id),
                                      cast: mapCastFromCredits(details.credits),
                                      total_episodes: details.number_of_episodes || null,
                                      total_seasons: details.number_of_seasons || null,
                                      runtime: details.episode_run_time ? details.episode_run_time[0] : null,
                                      origin_country: details.origin_country || liteOnly.origin_country || [],
                                      original_language: details.original_language || liteOnly.original_language,
                                  };
                        try {
                            localStorage.setItem(cacheKeyFull, JSON.stringify(merged));
                        } catch { /* ignore */ }
                        return merged;
                    }
                }
            } else {
                const liteAgain = readLite();
                if (liteAgain) return liteAgain;
            }

            const q = encodeURIComponent(queryText);
            const adult = includeAdult ? 'true' : 'false';

            if (mediaType === 'movie') {
                let url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${q}&language=en-US&include_adult=${adult}`;
                if (year != null && !Number.isNaN(year)) url += `&year=${year}`;
                const res = await fetch(url);
                const data = await res.json();
                if (!data.results?.length) return null;
                let best = data.results.find((i) => i.poster_path || i.backdrop_path) || data.results[0];
                if (region && !light) best = await pickMovieWithRegion(data.results, region);
                else if (region && light) {
                    best = data.results.find((i) => i.poster_path || i.backdrop_path) || data.results[0];
                }

                const searchHasGenres = Array.isArray(best.genre_ids) && best.genre_ids.length > 0;
                const posterOrBack = best.poster_path || best.backdrop_path;
                if (light && posterOrBack && searchHasGenres) {
                    const result = {
                        tmdb_id: best.id,
                        media_type: 'movie',
                        tmdb_title: best.title || best.original_title || best.name || null,
                        title: best.title || best.original_title || best.name || null,
                        poster_path: best.poster_path || best.backdrop_path,
                        backdrop_path: best.backdrop_path,
                        rating: best.vote_average,
                        overview: best.overview,
                        date: best.release_date,
                        genres: [],
                        genre_ids: best.genre_ids,
                        cast: [],
                        total_episodes: null,
                        total_seasons: null,
                        runtime: best.runtime,
                        origin_country: [],
                        original_language: best.original_language,
                    };
                    save(result);
                    return result;
                }

                const detailRes = await fetch(
                    `https://api.themoviedb.org/3/movie/${best.id}?api_key=${tmdbKey}&language=en-US${creditsParam}`
                );
                const details = await detailRes.json();
                const result = {
                    tmdb_id: best.id,
                    media_type: 'movie',
                    tmdb_title: details.title || details.original_title || best.title || best.original_title || best.name || null,
                    title: details.title || details.original_title || best.title || best.original_title || best.name || null,
                    poster_path: details.poster_path || best.poster_path,
                    backdrop_path: details.backdrop_path || best.backdrop_path,
                    rating: details.vote_average || best.vote_average,
                    overview: details.overview || best.overview,
                    date: details.release_date || best.release_date,
                    genres: details.genres || [],
                    genre_ids: (details.genres || []).map((g) => g.id),
                    cast: includeCredits ? mapCastFromCredits(details.credits) : [],
                    total_episodes: null,
                    total_seasons: null,
                    runtime: details.runtime,
                    origin_country: details.production_countries?.map((c) => c.iso_3166_1) || [],
                    original_language: details.original_language,
                };
                save(result);
                return result;
            }

            if (mediaType === 'tv') {
                let url = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${q}&language=en-US&include_adult=${adult}`;
                if (year != null && !Number.isNaN(year)) url += `&first_air_date_year=${year}`;
                const res = await fetch(url);
                const data = await res.json();
                if (!data.results?.length) return null;
                const pool = data.results;
                const withPoster = pool.filter((i) => i.poster_path || i.backdrop_path);
                const searchPool = withPoster.length ? withPoster : pool;
                let best = region
                    ? pickTvWithRegion(searchPool, region)
                    : searchPool.find((i) => i.poster_path || i.backdrop_path) || searchPool[0];
                if (!best) best = pool[0];

                const searchHasGenres = Array.isArray(best.genre_ids) && best.genre_ids.length > 0;
                const posterOrBackTv = best.poster_path || best.backdrop_path;
                if (light && posterOrBackTv && searchHasGenres) {
                    const result = {
                        tmdb_id: best.id,
                        media_type: 'tv',
                        tmdb_title: best.name || best.original_name || best.title || null,
                        title: best.name || best.original_name || best.title || null,
                        poster_path: best.poster_path || best.backdrop_path,
                        backdrop_path: best.backdrop_path,
                        rating: best.vote_average,
                        overview: best.overview,
                        date: best.first_air_date,
                        genres: [],
                        genre_ids: best.genre_ids,
                        cast: [],
                        total_episodes: null,
                        total_seasons: null,
                        runtime: null,
                        origin_country: best.origin_country || [],
                        original_language: best.original_language,
                    };
                    save(result);
                    return result;
                }

                const detailRes = await fetch(
                    `https://api.themoviedb.org/3/tv/${best.id}?api_key=${tmdbKey}&language=en-US${creditsParam}`
                );
                const details = await detailRes.json();
                const result = {
                    tmdb_id: best.id,
                    media_type: 'tv',
                    tmdb_title: details.name || details.original_name || best.name || best.original_name || best.title || null,
                    title: details.name || details.original_name || best.name || best.original_name || best.title || null,
                    poster_path: details.poster_path || best.poster_path,
                    backdrop_path: details.backdrop_path || best.backdrop_path,
                    rating: details.vote_average || best.vote_average,
                    overview: details.overview || best.overview,
                    date: details.first_air_date || details.last_air_date || best.first_air_date,
                    genres: details.genres || [],
                    genre_ids: (details.genres || []).map((g) => g.id),
                    cast: includeCredits ? mapCastFromCredits(details.credits) : [],
                    total_episodes: details.number_of_episodes || null,
                    total_seasons: details.number_of_seasons || null,
                    runtime: details.episode_run_time ? details.episode_run_time[0] : null,
                    origin_country: details.origin_country || best.origin_country || [],
                    original_language: details.original_language || best.original_language,
                };
                save(result);
                return result;
            }

            const res = await fetch(
                `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${q}&language=en-US&include_adult=${adult}`
            );
            const data = await res.json();
            if (!data.results?.length) return null;

            const filtered = data.results.filter((i) => i.media_type === 'movie' || i.media_type === 'tv');
            const pool = filtered.length ? filtered : data.results;
            let bestResult = pool.find((i) => i.poster_path || i.backdrop_path) || pool[0];
            const mt = bestResult.media_type === 'movie' ? 'movie' : 'tv';
            if (region && mt === 'tv' && bestResult.origin_country) {
                bestResult = pickTvWithRegion(pool.filter((i) => i.media_type === 'tv'), region) || bestResult;
            }
            if (region && !light && mt === 'movie') {
                const movies = pool.filter((i) => i.media_type === 'movie');
                if (movies.length) bestResult = await pickMovieWithRegion(movies, region);
            }
            if (region && light && mt === 'movie') {
                const movies = pool.filter((i) => i.media_type === 'movie');
                if (movies.length) bestResult = movies.find((i) => i.poster_path || i.backdrop_path) || movies[0];
            }

            const type = bestResult.media_type === 'movie' ? 'movie' : 'tv';
            const searchHasGenres = Array.isArray(bestResult.genre_ids) && bestResult.genre_ids.length > 0;
            const posterOrBackM = bestResult.poster_path || bestResult.backdrop_path;
            if (light && posterOrBackM && searchHasGenres) {
                const result =
                    type === 'movie'
                        ? {
                              tmdb_id: bestResult.id,
                              media_type: 'movie',
                              tmdb_title: bestResult.title || bestResult.original_title || bestResult.name || null,
                              title: bestResult.title || bestResult.original_title || bestResult.name || null,
                              poster_path: bestResult.poster_path || bestResult.backdrop_path,
                              backdrop_path: bestResult.backdrop_path,
                              rating: bestResult.vote_average,
                              overview: bestResult.overview,
                              date: bestResult.release_date,
                              genres: [],
                              genre_ids: bestResult.genre_ids,
                              cast: [],
                              total_episodes: null,
                              total_seasons: null,
                              runtime: bestResult.runtime,
                              origin_country: [],
                              original_language: bestResult.original_language,
                          }
                        : {
                              tmdb_id: bestResult.id,
                              media_type: 'tv',
                              tmdb_title: bestResult.name || bestResult.original_name || bestResult.title || null,
                              title: bestResult.name || bestResult.original_name || bestResult.title || null,
                              poster_path: bestResult.poster_path || bestResult.backdrop_path,
                              backdrop_path: bestResult.backdrop_path,
                              rating: bestResult.vote_average,
                              overview: bestResult.overview,
                              date: bestResult.first_air_date,
                              genres: [],
                              genre_ids: bestResult.genre_ids,
                              cast: [],
                              total_episodes: null,
                              total_seasons: null,
                              runtime: null,
                              origin_country: bestResult.origin_country || [],
                              original_language: bestResult.original_language,
                          };
                save(result);
                return result;
            }

            const detailRes = await fetch(
                `https://api.themoviedb.org/3/${type}/${bestResult.id}?api_key=${tmdbKey}&language=en-US${creditsParam}`
            );
            const details = await detailRes.json();

            const result = {
                tmdb_id: bestResult.id,
                media_type: type,
                tmdb_title:
                    type === 'movie'
                        ? details.title || details.original_title || bestResult.title || bestResult.name || null
                        : details.name || details.original_name || bestResult.name || bestResult.title || null,
                title:
                    type === 'movie'
                        ? details.title || details.original_title || bestResult.title || bestResult.name || null
                        : details.name || details.original_name || bestResult.name || bestResult.title || null,
                poster_path: details.poster_path || bestResult.poster_path,
                backdrop_path: details.backdrop_path || bestResult.backdrop_path,
                rating: details.vote_average || bestResult.vote_average,
                overview: details.overview || bestResult.overview,
                date: details.release_date || details.first_air_date || bestResult.release_date || bestResult.first_air_date,
                genres: details.genres || [],
                genre_ids: (details.genres || []).map((g) => g.id),
                cast: includeCredits ? mapCastFromCredits(details.credits) : [],
                total_episodes: details.number_of_episodes || null,
                total_seasons: details.number_of_seasons || null,
                runtime: details.runtime || (details.episode_run_time ? details.episode_run_time[0] : null),
                origin_country: details.origin_country || bestResult.origin_country || [],
                original_language: details.original_language || bestResult.original_language,
            };
            save(result);
            return result;
        } catch (e) {
            console.error('TMDB fetch error:', e);
            return null;
        }
    })();

    _tmdbInflight.set(inflightKey, run);
    try {
        return await run;
    } finally {
        _tmdbInflight.delete(inflightKey);
    }
};
/** Simpan override query TMDB (admin — backend menyimpan di tmdb_overrides) */
export const saveTmdbOverride = async (payload) => {
    const res = await fetch(`${BASE_URL}/api/tmdb-overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Save failed');
    return data;
};

export const getTMDBCredits = async (tmdbId, mediaType) => {
    const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
    if (!tmdbKey || !tmdbId || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;

    try {
        const cacheKey = `mutflix_tmdb_credits_${tmdbId}_${mediaType}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch { /* ignore broken cache */ }
        }

        const type = mediaType === 'movie' ? 'movie' : 'tv';
        const res = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}/credits?api_key=${tmdbKey}&language=en-US`);
        const data = await res.json();
        const result = {
            cast: (data.cast || []).slice(0, 20).map(c => ({
                id: c.id,
                name: c.name,
                character: c.character,
                profile_path: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null
            })),
            director: (data.crew || []).find(c => c.job === 'Director')?.name || null
        };
        try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch { /* ignore storage quota */ }
        return result;
    } catch (e) {
        console.error("TMDB credits fetch error:", e);
        return null;
    }
};

export const getTMDBSeasonDetails = async (tmdbId, seasonNumber) => {
    const tmdbKey = import.meta.env.VITE_TMDB_API_KEY;
    if (!tmdbKey || !tmdbId || tmdbKey === 'MASUKKAN_KEY_TMDB_ANDA_DISINI') return null;
    try {
        const cacheKey = `mutflix_tmdb_season_${tmdbId}_${seasonNumber}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch { /* ignore broken cache */ }
        }

        const response = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${tmdbKey}&language=en-US`);
        if (!response.ok) return null;
        const result = await response.json();
        try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch { /* ignore storage quota */ }
        return result;
    } catch (error) {
        console.error("Error fetching TMDB season details:", error);
        return null;
    }
};


const _fetchFoldersRaw = async () => {
    try {
        const res = await fetch(`${BASE_URL}/api/folders?_=${Date.now()}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) {
            if (res.status === 401) return { __error: true, status: 401, movies: [], series: [] };
            throw new Error(`Network error (${res.status})`);
        }
        return await res.json();
    } catch (error) {
        console.error("Error fetching folders:", error);
        return { __error: true, movies: [], series: [] };
    }
};

// Cached versions — return instantly from cache, refresh in background
export const fetchFolders = (onUpdate) => cachedFetch('folders', _fetchFoldersRaw, onUpdate);

/**
 * Daftar folder untuk layar utama: selalu tunggu network dulu, lalu update cache.
 * Menghindari bug SWR di mana cache kosong/stale dipakai sekali jadi, fetch background sukses
 * tapi komponen tidak re-render (tanpa onUpdate) sehingga harus refresh manual.
 */
export const fetchFoldersFresh = async () => {
    const data = await _fetchFoldersRaw();
    if (data && !data.__error) {
        cacheSet('folders', data);
        return data;
    }
    const stale = cacheGet('folders');
    if (stale && !stale.__error) return stale;
    return data || { movies: [], series: [] };
};

export const fetchVideos = async (folderName) => {
    try {
        const res = await fetch(`${BASE_URL}/api/videos/${encodeURIComponent(folderName)}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) {
            if (res.status === 401) return { __error: true, status: 401 };
            throw new Error(`Network error (${res.status})`);
        }
        return await res.json();
    } catch (error) {
        console.error("Error fetching videos:", error);
        return { videos: [], has_season_folders: false };
    }
};

// ==========================================
// SERVER-SIDE SEARCH API
// ==========================================
export const searchContent = async (query) => {
    if (!query || query.trim().length < 1) return [];
    try {
        const res = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(query.trim())}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (error) {
        console.error("Error searching content:", error);
        return [];
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
    cacheClear(); // [FIX] Wiped cached data on logout
};

export const isLoggedIn = () => !!localStorage.getItem('token');

// ==========================================
// STREAMING & SUBTITLE API
// ==========================================

/**
 * Get GDrive stream details (URL + auth headers) for a video file.
 * @param {string} filePath - e.g. "gdrive/FILE_ID"
 * @returns {Promise<{url: string, headers: Object}|null>}
 */
export const getStreamDetails = async (filePath) => {
    try {
        const res = await fetch(`${BASE_URL}/api/gdrive-stream-details/${encodeURIComponent(filePath)}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error('Error fetching stream details:', e);
        return null;
    }
};

/**
 * Fetch raw subtitle content from the server.
 * @param {string} subtitlePath - e.g. "gdrive/FILE_ID" or "folder/file.srt"
 * @returns {Promise<string|null>} Raw subtitle text content
 */
export const fetchSubtitle = async (subtitlePath) => {
    try {
        // Always bypass browser cache. Subtitle can be replaced on server without changing the path.
        const cacheBuster = Date.now();
        const url = `${BASE_URL}/subtitle/${encodeURIComponent(subtitlePath)}?_=${cacheBuster}`;
        const res = await fetch(url, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            },
        });
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        console.error('Error fetching subtitle:', e);
        return null;
    }
};

// ==========================================
// PROFILES & HISTORY API
// ==========================================

export const fetchProfiles = async () => {
    try {
        const res = await fetch(`${BASE_URL}/api/profiles`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (error) {
        console.error("Error fetching profiles:", error);
        return [];
    }
};

export const createProfile = async (id, name, avatar_seed) => {
    try {
        const res = await fetch(`${BASE_URL}/api/profiles/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({ id, name, avatar_seed })
        });
        if (!res.ok) return false;
        return true;
    } catch (error) {
        console.error("Error creating profile:", error);
        return false;
    }
};

export const fetchHistory = async (profileId) => {
    try {
        const res = await fetch(`${BASE_URL}/api/history/get/${profileId}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return [];
        return await res.json();
    } catch (error) {
        console.error("Error fetching history:", error);
        return [];
    }
};

export const saveHistory = async (profile_id, media_path, media_title, series_title, source, still_path, subtitle_path, position_ms, duration_ms, season = null, episode = null) => {
    try {
        const res = await fetch(`${BASE_URL}/api/history/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                profile_id,
                media_path,
                media_title,
                series_title,
                source,
                still_path,
                subtitle_path,
                position_ms,
                duration_ms,
                season,
                episode
            })
        });
        if (!res.ok) return false;
        return true;
    } catch (error) {
        console.error("Error saving history:", error);
        return false;
    }
};

// ==========================================
// MY LIST (WATCHLIST) API
// ==========================================

export const fetchMyList = async (profileId) => {
    if (!profileId) return [];
    try {
        const res = await fetch(`${BASE_URL}/api/mylist?profile_id=${profileId}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error("Error fetching mylist:", error);
        return [];
    }
};

export const addToMyList = async (profileId, folderName, mediaType, meta, status = 'plan_to_watch') => {
    if (!profileId || !folderName) return false;
    try {
        const res = await fetch(`${BASE_URL}/api/mylist/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                profile_id: profileId,
                folder_name: folderName,
                media_type: mediaType,
                meta: meta,
                status: status
            })
        });
        return res.ok;
    } catch (error) {
        console.error("Error adding to mylist:", error);
        return false;
    }
};

export const removeFromMyList = async (profileId, folderName) => {
    if (!profileId || !folderName) return false;
    try {
        const res = await fetch(`${BASE_URL}/api/mylist/remove`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                profile_id: profileId,
                folder_name: folderName
            })
        });
        return res.ok;
    } catch (error) {
        console.error("Error removing from mylist:", error);
        return false;
    }
};

export const updateMyListStatus = async (profileId, folderName, status) => {
    if (!profileId || !folderName) return false;
    try {
        const res = await fetch(`${BASE_URL}/api/mylist/update-status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...getAuthHeaders()
            },
            body: JSON.stringify({
                profile_id: profileId,
                folder_name: folderName,
                status: status
            })
        });
        return res.ok;
    } catch (error) {
        console.error("Error updating mylist status:", error);
        return false;
    }
};
