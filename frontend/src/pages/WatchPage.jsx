import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Play, Pause, Volume2, VolumeX,
    Maximize, Minimize, Subtitles, Settings,
    SkipForward, SkipBack, ChevronDown, ChevronUp,
    User, Loader2, Languages
} from 'lucide-react';
import {
    fetchVideos, getStreamDetails, fetchSubtitle, getEmbeddedSubtitles, fetchEmbeddedSubtitle,
    getTMDBInfo, getTMDBCredits, getTMDBSeasonDetails, logout, TMDB_GENRES,
    fetchProfiles, createProfile, saveHistory, fetchHistory, getTMDBMoreLikeThis,
    tmdbImageUrl
} from '../services/api';
import {
    createSubtitleBlobUrl,
    revokeSubtitleBlobUrl,
    clampSubtitleDelay,
    SUBTITLE_DELAY_MAX_SECONDS
} from '../utils/subtitleParser';
import Navbar from '../components/Navbar';
import LoginModal from '../components/LoginModal';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';
import { cleanTitleOutsideParentheses } from '../utils/cleanTitle';
import { EPISODE_PLACEHOLDER_IMAGE } from '../utils/placeholders';
import { mergeDetailMetadata, tmdbOptsFromCatalogItem } from '../utils/detailMetadata';

/** Stored delay: negative = tunda (subtitle lebih lambat), positive = percepat (lebih cepat). */
const SUB_DELAY_UI_CONVENTION = 'neg-is-delay';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space';
const LOCAL_RESUME_KEY = 'mutflix_resume_positions';
const WATCH_SESSION_KEY = 'mutflix_watch_sessions';
const PLAYER_PREFS_KEY = 'mutflix_player_prefs';
const MIN_RESUME_POSITION_MS = 5000;
const RECENT_LOCAL_RESUME_MS = 10 * 60 * 1000;
const STREAM_READY_TIMEOUT_MS = import.meta.env.DEV ? 15000 : 45000;
const STREAM_WATCHDOG_EXTEND_MS = 15000;

const normalizeTmdbImageUrl = (path, size = 'w300') => {
    if (!path || typeof path !== 'string') return null;
    if (path.startsWith('http')) return path;
    if (path === EPISODE_PLACEHOLDER_IMAGE) return path;
    return tmdbImageUrl(path, size);
};

const usableEpisodeImage = (path) => {
    return path && path !== EPISODE_PLACEHOLDER_IMAGE ? path : null;
};

const hasTrustedTmdbLookup = (item = {}, explicitTrust = false) => Boolean(explicitTrust || item.tmdb_id || item.tmdb_query);

const hasServerVisualMetadata = (item = {}, tmdbData = null) =>
    Boolean(
        tmdbData?.poster_path ||
        tmdbData?.backdrop_path ||
        item.tmdb_poster_path ||
        item.poster_path ||
        item.poster ||
        item.tmdb_backdrop_path ||
        item.backdrop_path
    );

const tmdbPosterUrl = (path, size = 'w342') => {
    if (!path || typeof path !== 'string') return '';
    return tmdbImageUrl(path, size) || '';
};

const pruneVolatileLocalStorage = () => {
    try {
        const removablePrefixes = [
            'mutflix_tmdb_info_',
            'mutflix_tmdb_credits_',
            'mutflix_tmdb_season_',
        ];
        Object.keys(localStorage).forEach((key) => {
            if (removablePrefixes.some((prefix) => key.startsWith(prefix))) {
                localStorage.removeItem(key);
            }
        });
    } catch {
        // ignore storage cleanup failures
    }
};

const getLocalResumeMap = () => {
    try {
        const raw = localStorage.getItem(LOCAL_RESUME_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        try { localStorage.removeItem(LOCAL_RESUME_KEY); } catch { /* ignore storage cleanup failures */ }
        return {};
    }
};

const setLocalResumeForPath = (mediaPath, positionMs, durationMs) => {
    if (!mediaPath) return;
    try {
        const map = getLocalResumeMap();
        map[mediaPath] = {
            position_ms: Number(positionMs) || 0,
            duration_ms: Number(durationMs) || 0,
            ts: Date.now(),
        };
        const entries = Object.entries(map)
            .sort(([, a], [, b]) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0))
            .slice(0, 100);
        localStorage.setItem(LOCAL_RESUME_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        pruneVolatileLocalStorage();
    }
};

const getWatchSessionMap = () => {
    try {
        const raw = localStorage.getItem(WATCH_SESSION_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        try { localStorage.removeItem(WATCH_SESSION_KEY); } catch { /* ignore storage cleanup failures */ }
        return {};
    }
};

const getWatchSessionForFolder = (folderKey) => {
    if (!folderKey) return null;
    return getWatchSessionMap()[folderKey] || null;
};

const setWatchSessionForFolder = (folderKey, video, positionMs = 0, durationMs = 0) => {
    if (!folderKey || !video?.path) return;
    try {
        const map = getWatchSessionMap();
        map[folderKey] = {
            media_path: video.path,
            season: Number(video.season) || 1,
            episode: Number(video.episode) || 1,
            position_ms: Number(positionMs) || 0,
            duration_ms: Number(durationMs) || 0,
            ts: Date.now(),
        };
        const entries = Object.entries(map)
            .sort(([, a], [, b]) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0))
            .slice(0, 50);
        localStorage.setItem(WATCH_SESSION_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        pruneVolatileLocalStorage();
    }
};

const getPlayerPrefs = () => {
    const defaults = { playbackRate: 1, volume: 1, muted: false };
    try {
        const raw = localStorage.getItem(PLAYER_PREFS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const playbackRate = Number(parsed.playbackRate);
        const volume = Number(parsed.volume);
        return {
            playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : defaults.playbackRate,
            volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : defaults.volume,
            muted: typeof parsed.muted === 'boolean' ? parsed.muted : defaults.muted,
        };
    } catch {
        try { localStorage.removeItem(PLAYER_PREFS_KEY); } catch { /* ignore storage cleanup failures */ }
        return defaults;
    }
};

const setPlayerPrefs = (patch) => {
    try {
        localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify({ ...getPlayerPrefs(), ...patch }));
    } catch {
        pruneVolatileLocalStorage();
    }
};

const WatchPage = () => {
    const { folderName } = useParams();
    const [searchParams] = useSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const decodedName = decodeURIComponent(folderName);
    const urlType = searchParams.get('type');
    const hasEpisodeQuery = searchParams.has('ep') || searchParams.has('s');
    const urlEp = parseInt(searchParams.get('ep')) || 1;
    const urlSeason = parseInt(searchParams.get('s')) || 1;
    const urlTime = parseInt(searchParams.get('t'));
    const navigationWatchMeta = location.state?.watchMeta;
    const navigationTmdbData = navigationWatchMeta?.tmdbData || null;
    const navigationCatalogItem = navigationWatchMeta?.catalogItem || null;
    const navigationTrustedTmdbLookup = Boolean(navigationWatchMeta?.trustedTmdbLookup);
    const trustedSeasonMetadata = Boolean(
        navigationTrustedTmdbLookup ||
        navigationCatalogItem?.tmdb_id ||
        navigationCatalogItem?.tmdb_query
    );
    const navigationEpisodeData = useMemo(
        () =>
            navigationWatchMeta?.episodeData && typeof navigationWatchMeta.episodeData === 'object'
                ? navigationWatchMeta.episodeData
                : {},
        [navigationWatchMeta]
    );

    const toInt = (value, fallback) => {
        const n =
            value == null || value === '' ? NaN : typeof value === 'string' ? parseInt(value, 10) : Number(value);
        return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
    };

    // Data state
    const [videos, setVideos] = useState([]);
    const [tmdbData, setTmdbData] = useState(() =>
        mergeDetailMetadata(navigationCatalogItem || { folder_name: decodedName, name: decodedName }, navigationTmdbData, decodedName, urlType)
    );
    const [credits, setCredits] = useState(null);
    const [episodeData, setEpisodeData] = useState(() => navigationEpisodeData);
    const [recommendations, setRecommendations] = useState([]);
    const [recommendationsLoading, setRecommendationsLoading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [expandedDesc, setExpandedDesc] = useState(false);

    // Player state
    const [currentVideo, setCurrentVideo] = useState(null);
    const [subtitleUrl, setSubtitleUrl] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(() => getPlayerPrefs().muted);
    const [volume, setVolume] = useState(() => getPlayerPrefs().volume);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [showSubtitles, setShowSubtitles] = useState(true);
    const [playbackRate, setPlaybackRate] = useState(() => getPlayerPrefs().playbackRate);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);
    /** Trek audio native dari file (multi-audio MP4/MOV); dukungan browser bervariasi (Chrome/Edge/Safari umumnya OK). */
    const [audioTrackList, setAudioTrackList] = useState([]);
    const [selectedAudioIndex, setSelectedAudioIndex] = useState(0);
    const [showAudioMenu, setShowAudioMenu] = useState(false);
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(null);
    const [streamReloadNonce, setStreamReloadNonce] = useState(0);
    const [activeSeason, setActiveSeason] = useState(urlSeason);
    const fetchedSeasonStillsRef = useRef(new Set());
    const fetchingSeasonStillsRef = useRef(new Set());
    const [profileId, setProfileId] = useState(localStorage.getItem('mutflix_last_profile_id'));

    // Auth state for Navbar
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [authUser, setAuthUser] = useState(() => {
        const username = localStorage.getItem('username');
        const role = localStorage.getItem('role');
        return username ? { username, role } : null;
    });

    // Subtitle Customizer
    const [rawSubtitleText, setRawSubtitleText] = useState(null);
    const [embeddedSubtitleTracks, setEmbeddedSubtitleTracks] = useState([]);
    const [selectedEmbeddedSubtitleIndex, setSelectedEmbeddedSubtitleIndex] = useState(null);
    const [embeddedSubtitleLoading, setEmbeddedSubtitleLoading] = useState(false);
    const [showSubtitleTrackMenu, setShowSubtitleTrackMenu] = useState(false);
    /** Subtitle mux di dalam file (textTracks), hanya jika tidak ada file .srt/.vtt terpisah */
    const [embeddedSubsAvailable, setEmbeddedSubsAvailable] = useState(false);
    const [activeCues, setActiveCues] = useState([]);
    const [showSubSettings, setShowSubSettings] = useState(false);
    const [subSettings, setSubSettings] = useState(() => {
        const defaults = {
            fontSize: 24,
            fontFamily: 'Poppins, sans-serif',
            backgroundOpacity: 0.7,
            backgroundColor: '#000000',
            textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
            outlineStyle: 'drop-shadow',
            outlineThickness: 2,
            marginBottom: 8,
            delay: 0
        };
        const saved = localStorage.getItem('mutflix_sub_settings');
        if (!saved) return { ...defaults, delayConvention: SUB_DELAY_UI_CONVENTION };
        try {
            const parsed = JSON.parse(saved);
            let delay = clampSubtitleDelay(parsed.delay ?? 0);
            // Migrasi: dulu positif = tunda; sekarang negatif = tunda
            if (parsed.delayConvention !== SUB_DELAY_UI_CONVENTION) {
                delay = clampSubtitleDelay(-delay);
            }
            return {
                ...defaults,
                ...parsed,
                delay,
                outlineStyle: parsed.outlineStyle ?? defaults.outlineStyle,
                outlineThickness: parsed.outlineThickness ?? defaults.outlineThickness,
                delayConvention: SUB_DELAY_UI_CONVENTION
            };
        } catch {
            try { localStorage.removeItem('mutflix_sub_settings'); } catch { /* ignore storage cleanup failures */ }
            return { ...defaults, delayConvention: SUB_DELAY_UI_CONVENTION };
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(
                'mutflix_sub_settings',
                JSON.stringify({ ...subSettings, delayConvention: SUB_DELAY_UI_CONVENTION })
            );
        } catch {
            pruneVolatileLocalStorage();
            // Storage can be full/corrupt; subtitle UI should not crash playback.
        }
    }, [subSettings]);

    const handleLoginSuccess = (data) => {
        setAuthUser({ username: data.username, role: data.role });
    };

    const handleLogout = () => {
        logout();
        setAuthUser(null);
    };

    // Refs
    const videoRef = useRef(null);
    const playerPrefsRef = useRef({ playbackRate, volume, isMuted });
    const hlsInstanceRef = useRef(null);
    const playerContainerRef = useRef(null);
    const controlsTimeoutRef = useRef(null);
    const progressBarRef = useRef(null);
    const prevSubtitleUrl = useRef(null);
    const embeddedSubCleanupRef = useRef(null);
    const lastPlaybackUiTickRef = useRef(0);
    const lastBufferUiTickRef = useRef(0);
    const lastResumeCacheTickRef = useRef(0);
    const currentTimeRef = useRef(0);
    const currentVideoPathRef = useRef(null);
    const pendingStreamSeekRef = useRef(0);
    const streamRecoveryRef = useRef({ videoPath: null, attempts: 0, lastAt: 0 });
    const streamLoadSeqRef = useRef(0);
    const streamReadyWatchdogRef = useRef(null);
    const autoplayMutedRef = useRef(false);
    const [resumeTime, setResumeTime] = useState(0);
    const hasSeekedRef = useRef(false);
    const [, setShowResumeToast] = useState(null);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubTime, setScrubTime] = useState(0);

    useEffect(() => {
        playerPrefsRef.current = { playbackRate, volume, isMuted };
    }, [isMuted, playbackRate, volume]);

    useEffect(() => {
        currentVideoPathRef.current = currentVideo?.path || null;
    }, [currentVideo?.path]);

    // Derived
    // Important: if TMDB API key missing (tmdbData=null) and `type` query param is wrong,
    // Episodes sidebar should still show based on number of videos.
    const isSeriesContent = urlType === 'series' || (tmdbData?.media_type === 'tv') || videos.length > 1;

    const uniqueSeasons = [...new Set(videos.map(v => toInt(v.season, 1)))].sort((a, b) => a - b);
    const filteredEpisodes = videos.filter(v => toInt(v.season, 1) === toInt(activeSeason, 1));
    const episodesToShow = filteredEpisodes.length > 0 ? filteredEpisodes : videos;

    // ─── Derived values ────────────────────────────
    const title = cleanTitleOutsideParentheses(tmdbData?.tmdb_title || tmdbData?.title || decodedName) || (tmdbData?.tmdb_title || tmdbData?.title || decodedName);
    const rating = tmdbData?.rating;
    const overview = tmdbData?.overview || '';
    const year = (tmdbData?.date || '').substring(0, 4) || '';
    const castList = credits?.cast || [];
    const currentSeasonNum = toInt(currentVideo?.season, 1);
    const currentEpisodeNum = toInt(currentVideo?.episode, 1);
    const currentEpData = episodeData[`${currentSeasonNum}_${currentEpisodeNum}`];
    const currentEpName = typeof currentEpData?.name === 'string' ? currentEpData.name.trim() : '';
    const currentVideoName = typeof currentVideo?.name === 'string' ? currentVideo.name.trim() : '';
    const hasTmdbEpisodeTitle = Boolean(currentEpData?.isTmdbName || (currentEpName && currentEpName !== currentVideoName));
    const currentEpisodeTitle = hasTmdbEpisodeTitle ? currentEpName : `Episode ${currentEpisodeNum}`;
    const playerHeaderTitle = isSeriesContent
        ? `S${currentSeasonNum}E${currentEpisodeNum} | ${currentEpisodeTitle}`
        : title;
    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
    const episodeFallbackThumb = useMemo(() => {
        if (!isSeriesContent) return null;
        return (
            normalizeTmdbImageUrl(tmdbData?.backdrop_path || tmdbData?.tmdb_backdrop_path, 'w500') ||
            normalizeTmdbImageUrl(tmdbData?.poster_path || tmdbData?.tmdb_poster_path, 'w500') ||
            EPISODE_PLACEHOLDER_IMAGE
        );
    }, [isSeriesContent, tmdbData?.backdrop_path, tmdbData?.tmdb_backdrop_path, tmdbData?.poster_path, tmdbData?.tmdb_poster_path]);

    const createImmediateEpisodeData = useCallback((videosList, seededEpisodeData = {}) => {
        const dataMap = { ...seededEpisodeData };
        videosList.forEach((video, idx) => {
            const season = toInt(video.season, 1);
            const episode = toInt(video.episode, idx + 1);
            const key = `${season}_${episode}`;
            const existing = dataMap[key] || {};
            const still =
                video.still_path ||
                video.thumbnail ||
                video.thumbnail_path ||
                video.backdrop_path ||
                null;
            dataMap[key] = {
                ...existing,
                still_path: usableEpisodeImage(existing.still_path) || normalizeTmdbImageUrl(still),
                name: existing.name || video.name || `Episode ${episode}`,
                isTmdbName: Boolean(existing.isTmdbName),
            };
        });
        return dataMap;
    }, []);

    const loadSeasonEpisodeData = useCallback((tmdbId, seasonNum) => {
        const season = toInt(seasonNum, 1);
        if (!tmdbId || !Number.isFinite(season)) return;
        const key = `${tmdbId}_${season}`;
        if (fetchedSeasonStillsRef.current.has(key) || fetchingSeasonStillsRef.current.has(key)) return;

        fetchingSeasonStillsRef.current.add(key);
        void getTMDBSeasonDetails(tmdbId, season)
            .then((sd) => {
                if (sd?.episodes) {
                    const dataMap = {};
                    sd.episodes.forEach((ep) => {
                        dataMap[`${season}_${ep.episode_number}`] = {
                            still_path: ep.still_path
                                ? tmdbImageUrl(ep.still_path, 'w300')
                                : null,
                            name: ep.name,
                            isTmdbName: Boolean(ep.name),
                        };
                    });
                    setEpisodeData((prev) => ({ ...prev, ...dataMap }));
                }
                fetchedSeasonStillsRef.current.add(key);
            })
            .catch(() => {
                fetchedSeasonStillsRef.current.add(key);
            })
            .finally(() => {
                fetchingSeasonStillsRef.current.delete(key);
            });
    }, []);

    // ─── Load Data ──────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        const loadData = async () => {
            setLoading(true);
            setEpisodeData(navigationEpisodeData);
            const baseCatalogItem = navigationCatalogItem || { folder_name: decodedName, name: decodedName };
            const baseMetadata = mergeDetailMetadata(baseCatalogItem, navigationTmdbData, decodedName, urlType);
            const trustedLookup = hasTrustedTmdbLookup(baseCatalogItem, navigationTrustedTmdbLookup);
            setTmdbData(baseMetadata);
            setCredits(null);
            fetchedSeasonStillsRef.current = new Set();
            fetchingSeasonStillsRef.current = new Set();
            try {
                // Critical path: videos only. TMDB metadata loads in background.
                const videosResp = await fetchVideos(decodedName);
                if (cancelled) return;

                const videosListRaw = videosResp?.videos || [];
                const videosList = videosListRaw.map((v) => ({
                    ...v,
                    season: toInt(v.season, 1),
                    episode: toInt(v.episode, 1),
                }));
                videosList.sort((a, b) => {
                    if (a.season !== b.season) return (a.season || 1) - (b.season || 1);
                    return (a.episode || 0) - (b.episode || 0);
                });

                setVideos(videosList);
                setEpisodeData((prev) => createImmediateEpisodeData(videosList, { ...navigationEpisodeData, ...prev }));

                const session = getWatchSessionForFolder(decodedName);
                const sessionVideo = session
                    ? (session.media_path
                        ? videosList.find(v => v.path === session.media_path)
                        : videosList.find(v =>
                        (v.season || 1) === (Number(session?.season) || 1) &&
                        (v.episode || 1) === (Number(session?.episode) || 1)
                    ))
                    : null;
                const queryVideo = videosList.find(v =>
                    (v.season || 1) === urlSeason && (v.episode || 1) === urlEp
                );
                const targetVideo = (hasEpisodeQuery ? queryVideo : sessionVideo) || queryVideo || sessionVideo || videosList[0];

                if (targetVideo) {
                    setCurrentVideo(targetVideo);
                    setActiveSeason(targetVideo.season || 1);
                    const isSameSessionVideo = session?.media_path && session.media_path === targetVideo.path;
                    setWatchSessionForFolder(
                        decodedName,
                        targetVideo,
                        isSameSessionVideo ? Number(session?.position_ms) || 0 : 0,
                        isSameSessionVideo ? Number(session?.duration_ms) || 0 : 0
                    );
                }

                // Biarkan pemutar & stream mulai lebih dulu — kredit & still episode di background
                const seasonToPrefetch = targetVideo?.season || urlSeason || 1;
                if (trustedLookup && baseMetadata?.tmdb_id && baseMetadata?.media_type === 'tv') {
                    loadSeasonEpisodeData(baseMetadata.tmdb_id, seasonToPrefetch);
                }

                setLoading(false);

                // Background: TMDB metadata + credits.
                if (!trustedLookup && hasServerVisualMetadata(baseCatalogItem, baseMetadata)) {
                    return;
                }

                void (async () => {
                    try {
                        const inferredIsSeries =
                            urlType === 'series' ||
                            videosList.length > 1 ||
                            videosList.some((v) => toInt(v.season, 1) > 1);
                        const tmdbOptions = {
                            ...tmdbOptsFromCatalogItem(baseCatalogItem, urlType),
                            mediaType:
                                tmdbOptsFromCatalogItem(baseCatalogItem, urlType).mediaType ||
                                (inferredIsSeries ? 'tv' : (urlType === 'movie' ? 'movie' : undefined)),
                        };
                        const tmdbSearchTitle = baseCatalogItem.tmdb_query || baseCatalogItem.tmdb_title || baseCatalogItem.folder_name || baseCatalogItem.name || decodedName;
                        const lightTmdb = await getTMDBInfo(tmdbSearchTitle, { ...tmdbOptions, light: true });
                        if (cancelled) return;
                        const lightResolvedTmdb = mergeDetailMetadata(baseCatalogItem, lightTmdb || navigationTmdbData, decodedName, urlType);
                        setTmdbData(lightResolvedTmdb);
                        if (trustedLookup && lightResolvedTmdb?.tmdb_id && lightResolvedTmdb?.media_type === 'tv') {
                            loadSeasonEpisodeData(lightResolvedTmdb.tmdb_id, seasonToPrefetch);
                        }

                        const tmdb = await getTMDBInfo(tmdbSearchTitle, tmdbOptions);
                        if (cancelled) return;
                        const resolvedTmdb = mergeDetailMetadata(baseCatalogItem, tmdb || lightTmdb || navigationTmdbData, decodedName, urlType);
                        setTmdbData(resolvedTmdb);
                        if (trustedLookup && resolvedTmdb?.tmdb_id) {
                            const creditsData = await getTMDBCredits(resolvedTmdb.tmdb_id, resolvedTmdb.media_type);
                            if (!cancelled) setCredits(creditsData);
                        }
                    } catch (e) {
                        console.warn('Watch page TMDB extras failed:', e);
                    }
                })();
            } catch (e) {
                console.error('Watch page load failed:', e);
                setLoading(false);
            }
        };
        loadData();
        return () => { cancelled = true; };
    }, [decodedName, urlType, urlSeason, urlEp, hasEpisodeQuery, navigationWatchMeta, navigationCatalogItem, navigationTmdbData, navigationEpisodeData, navigationTrustedTmdbLookup, createImmediateEpisodeData, loadSeasonEpisodeData]);

    // Lazy-load TMDB episode stills + episode names per season tab.
    useEffect(() => {
        if (!trustedSeasonMetadata) return;
        if (!tmdbData?.tmdb_id) return;
        if (tmdbData?.media_type !== 'tv') return;
        if (!isSeriesContent) return;

        const seasonNum = toInt(activeSeason, 1);
        if (!Number.isFinite(seasonNum)) return;
        loadSeasonEpisodeData(tmdbData.tmdb_id, seasonNum);
    }, [trustedSeasonMetadata, tmdbData?.tmdb_id, tmdbData?.media_type, activeSeason, isSeriesContent, loadSeasonEpisodeData]);

    useEffect(() => {
        if (!tmdbData?.tmdb_id || !tmdbData?.media_type) {
            setRecommendations([]);
            setRecommendationsLoading(false);
            return;
        }

        let cancelled = false;
        setRecommendationsLoading(true);
        getTMDBMoreLikeThis(tmdbData.tmdb_id, tmdbData.media_type, { limit: 12 })
            .then((items) => {
                if (!cancelled) setRecommendations(items);
            })
            .catch(() => {
                if (!cancelled) setRecommendations([]);
            })
            .finally(() => {
                if (!cancelled) setRecommendationsLoading(false);
            });

        return () => { cancelled = true; };
    }, [tmdbData?.tmdb_id, tmdbData?.media_type]);

    // ─── Fetch/Create Profile ───────────────────────
    useEffect(() => {
        if (!authUser || profileId) return;

        const setupProfile = async () => {
            const profiles = await fetchProfiles();
            if (profiles.length > 0) {
                setProfileId(profiles[0].id);
                localStorage.setItem('mutflix_last_profile_id', profiles[0].id);
            } else {
                const newId = `p_${Math.random().toString(36).substr(2, 9)}`;
                const success = await createProfile(newId, 'Web User', 'bottts');
                if (success) {
                    setProfileId(newId);
                    localStorage.setItem('mutflix_last_profile_id', newId);
                }
            }
        };
        setupProfile();
    }, [authUser, profileId]);

    useEffect(() => {
        const onProfileChange = (event) => {
            if (event.detail?.id) setProfileId(event.detail.id);
        };
        window.addEventListener('mutflix-profile-change', onProfileChange);
        return () => window.removeEventListener('mutflix-profile-change', onProfileChange);
    }, []);

    // ─── Save History logic ─────────────────────────
    const cacheCurrentResume = useCallback((timeSeconds = null) => {
        if (!currentVideo || !videoRef.current) return;

        const video = videoRef.current;
        const durationSeconds = Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : duration;
        if (!durationSeconds || !Number.isFinite(durationSeconds)) return;

        const resolvedTime = timeSeconds == null ? video.currentTime : timeSeconds;
        if (!Number.isFinite(resolvedTime)) return;

        const positionMs = Math.max(0, Math.floor(resolvedTime * 1000));
        const durationMs = Math.floor(durationSeconds * 1000);
        if (resumeTime > 0 && !hasSeekedRef.current && positionMs < MIN_RESUME_POSITION_MS) return;
        setLocalResumeForPath(currentVideo.path, positionMs, durationMs);
        setWatchSessionForFolder(decodedName, currentVideo, positionMs, durationMs);
    }, [currentVideo, decodedName, duration, resumeTime]);

    const triggerSaveHistory = useCallback(async () => {
        if (!profileId || !currentVideo || !videoRef.current) return;

        const video = videoRef.current;
        if (!video.duration) return;

        const positionMs = Math.floor(video.currentTime * 1000);
        const durationMs = Math.floor(video.duration * 1000);
        cacheCurrentResume();

        await saveHistory(
            profileId,
            currentVideo.path,
            currentVideo.name || decodedName,
            isSeriesContent ? decodedName : null,
            currentVideo.source,
            usableEpisodeImage(currentEpData?.still_path) || episodeFallbackThumb,
            currentVideo.subtitle_path,
            positionMs,
            durationMs,
            isSeriesContent ? (currentVideo.season ?? null) : null,
            isSeriesContent ? (currentVideo.episode ?? null) : null
        );
    }, [profileId, currentVideo, decodedName, isSeriesContent, currentEpData, episodeFallbackThumb, cacheCurrentResume]);

    // ─── Fetch Resume Position ─────────────────────
    useEffect(() => {
        if (!currentVideo) return;

        let hasLocalResume = false;
        let localResumeTs = 0;
        let cancelled = false;
        const numericUrlTime = Number(urlTime);

        if (Number.isFinite(numericUrlTime) && numericUrlTime > 0 && !hasSeekedRef.current) {
            setResumeTime(numericUrlTime);
            // Instant local seek hint override
        } else {
            const localMap = getLocalResumeMap();
            const localEntry = localMap[currentVideo.path];
            if (localEntry && Number(localEntry.position_ms) >= MIN_RESUME_POSITION_MS) {
                const p = Number(localEntry.position_ms);
                const d = Number(localEntry.duration_ms) || 0;
                const progress = d > 0 ? (p / d) * 100 : 0;
                if (progress < 95) {
                    hasLocalResume = true;
                    localResumeTs = Number(localEntry.ts) || 0;
                    setResumeTime(p / 1000);
                } else {
                    setResumeTime(0);
                }
            } else {
                setResumeTime(0);
            }
        }

        if (!profileId) {
            return () => { cancelled = true; };
        }

        const fetchResumePosition = async () => {
            const history = await fetchHistory(profileId);
            if (cancelled) return;
            const entry = history.find(h => h.media_path === currentVideo.path);
            if (entry && entry.position_ms >= MIN_RESUME_POSITION_MS) {
                const progress = (entry.position_ms / entry.duration_ms) * 100;
                if (progress < 95) {
                    const serverResumeTs = Date.parse(entry.last_watched || '') || 0;
                    const hasRecentLocalResume = localResumeTs > 0 && Date.now() - localResumeTs < RECENT_LOCAL_RESUME_MS;
                    const localResumeIsNewer = localResumeTs > 0 && (!serverResumeTs || localResumeTs >= serverResumeTs);
                    if (!numericUrlTime && hasLocalResume && (hasRecentLocalResume || localResumeIsNewer)) return;

                    if (!numericUrlTime) setResumeTime(entry.position_ms / 1000);
                    setLocalResumeForPath(entry.media_path, entry.position_ms, entry.duration_ms);
                    setWatchSessionForFolder(decodedName, currentVideo, entry.position_ms, entry.duration_ms);
                } else {
                    const serverResumeTs = Date.parse(entry.last_watched || '') || 0;
                    const hasRecentLocalResume = localResumeTs > 0 && Date.now() - localResumeTs < RECENT_LOCAL_RESUME_MS;
                    const localResumeIsNewer = localResumeTs > 0 && (!serverResumeTs || localResumeTs >= serverResumeTs);
                    if (!numericUrlTime && hasLocalResume && (hasRecentLocalResume || localResumeIsNewer)) return;

                    if (!numericUrlTime) setResumeTime(0);
                }
            } else {
                if (!numericUrlTime && !hasLocalResume) setResumeTime(0);
            }
        };
        fetchResumePosition();
        return () => { cancelled = true; };
    }, [profileId, currentVideo, decodedName, urlTime]);

    // ─── Auto-Seek Logic ────────────────────────────
    useEffect(() => {
        // Reset seek tracker on video change
        hasSeekedRef.current = false;
        pendingStreamSeekRef.current = 0;
        streamRecoveryRef.current = { videoPath: currentVideo?.path || null, attempts: 0, lastAt: 0 };
    }, [currentVideo]);

    useEffect(() => {
        const video = videoRef.current;
        if (video && duration > 0 && resumeTime > 0 && !hasSeekedRef.current) {
            video.currentTime = resumeTime;
            hasSeekedRef.current = true;

            const minutes = Math.floor(resumeTime / 60);
            const seconds = Math.floor(resumeTime % 60);
            setShowResumeToast(`${minutes}:${seconds.toString().padStart(2, '0')}`);
            setTimeout(() => setShowResumeToast(null), 3000);
        }
    }, [duration, resumeTime, currentVideo]);

    useEffect(() => {
        if (!isPlaying || !profileId) return;

        const interval = setInterval(() => {
            triggerSaveHistory();
        }, 15000); // Save every 15s

        return () => clearInterval(interval);
    }, [isPlaying, profileId, triggerSaveHistory]);

    // Save on tab close / navigation
    useEffect(() => {
        const handleUnload = () => {
            if (profileId && currentVideo && videoRef.current) {
                triggerSaveHistory();
            }
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                handleUnload();
            }
        };

        window.addEventListener('beforeunload', handleUnload);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('beforeunload', handleUnload);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [profileId, currentVideo, triggerSaveHistory]);

    // ─── Load Stream when currentVideo changes ──────
    const clearStreamWatchdog = useCallback(() => {
        if (streamReadyWatchdogRef.current) {
            clearTimeout(streamReadyWatchdogRef.current);
            streamReadyWatchdogRef.current = null;
        }
    }, []);

    const resetVideoElement = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        try {
            video.pause();
        } catch {
            /* ignore */
        }
        video.removeAttribute('src');
        video.querySelectorAll('track').forEach((t) => t.remove());
        try {
            video.load();
        } catch {
            /* ignore */
        }
    }, []);

    const addStreamCacheBuster = useCallback((url) => {
        if (!url) return url;
        if (streamReloadNonce <= 0) return url;
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}_=${Date.now()}_${streamReloadNonce}`;
    }, [streamReloadNonce]);

    const resolveBackendUrl = useCallback((url) => {
        if (!url) return url;
        if (/^https?:\/\//i.test(url)) return url;
        return `${BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
    }, []);

    const requestStreamRecovery = useCallback((reason = 'playback-error') => {
        const video = videoRef.current;
        if (!currentVideo || !video) return false;

        const now = Date.now();
        const recovery = streamRecoveryRef.current;
        if (recovery.videoPath !== currentVideo.path || now - recovery.lastAt > 120000) {
            recovery.videoPath = currentVideo.path;
            recovery.attempts = 0;
        }
        if (recovery.attempts >= 3) return false;

        recovery.attempts += 1;
        recovery.lastAt = now;
        const lastKnownTime = Number.isFinite(video.currentTime) && video.currentTime > 0
            ? video.currentTime
            : currentTimeRef.current;
        pendingStreamSeekRef.current = lastKnownTime > 1 ? Math.max(0, lastKnownTime - 0.5) : 0;

        console.warn(`[Player] Recovering stream after ${reason}. Attempt ${recovery.attempts}/3`);
        clearStreamWatchdog();
        resetVideoElement();
        setVideoLoading(true);
        setVideoError(null);
        setStreamReloadNonce((value) => value + 1);
        return true;
    }, [clearStreamWatchdog, currentVideo, resetVideoElement]);

    const applyPlayerPrefsToVideo = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        const prefs = playerPrefsRef.current;
        video.defaultPlaybackRate = prefs.playbackRate;
        video.playbackRate = prefs.playbackRate;
        video.volume = prefs.volume;
        video.muted = autoplayMutedRef.current || prefs.isMuted || prefs.volume === 0;
    }, []);

    const restoreSoundAfterUserGesture = useCallback(() => {
        const video = videoRef.current;
        const prefs = playerPrefsRef.current;
        if (!video || !autoplayMutedRef.current || prefs.isMuted || prefs.volume === 0) return false;

        autoplayMutedRef.current = false;
        video.volume = prefs.volume;
        video.muted = false;
        setIsMuted(false);
        return true;
    }, []);

    const playWithAutoplayFallback = useCallback((reason = 'play') => {
        const video = videoRef.current;
        if (!video) return;
        const playPromise = video.play();
        if (playPromise === undefined) return;

        playPromise.catch((error) => {
            console.warn(`${reason} prevented by browser:`, error);
            const current = videoRef.current;
            if (!current) {
                setVideoLoading(false);
                return;
            }

            const prefs = playerPrefsRef.current;
            if (prefs.volume > 0 && !prefs.isMuted) {
                autoplayMutedRef.current = true;
                current.muted = true;
                setIsMuted(true);
                current.play().catch(() => setVideoLoading(false));
                return;
            }

            setVideoLoading(false);
        });
    }, []);

    const loadEmbeddedSubtitleTrack = useCallback(async (track) => {
        if (!currentVideo?.path || !track?.supported || track.stream_index == null) return false;
        const expectedPath = currentVideo.path;
        setEmbeddedSubtitleLoading(true);
        try {
            const text = await fetchEmbeddedSubtitle(expectedPath, track.stream_index);
            if (currentVideoPathRef.current !== expectedPath) return false;
            if (!text) return false;
            setRawSubtitleText(text);
            setSelectedEmbeddedSubtitleIndex(track.stream_index);
            setShowSubtitles(true);
            return true;
        } catch (e) {
            console.error('Embedded subtitle load error:', e);
            return false;
        } finally {
            if (currentVideoPathRef.current === expectedPath) {
                setEmbeddedSubtitleLoading(false);
            }
        }
    }, [currentVideo?.path]);

    useEffect(() => {
        applyPlayerPrefsToVideo();
    }, [applyPlayerPrefsToVideo, currentVideo?.path]);

    const armStreamReadyWatchdog = useCallback((loadSeq, reason) => {
        clearStreamWatchdog();
        const checkStream = (timeoutMs) => {
            const video = videoRef.current;
            if (streamLoadSeqRef.current !== loadSeq || !currentVideo || !video) return;
            if (videoError) return;
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
            if (video.networkState === HTMLMediaElement.NETWORK_LOADING) {
                streamReadyWatchdogRef.current = setTimeout(() => checkStream(STREAM_WATCHDOG_EXTEND_MS), STREAM_WATCHDOG_EXTEND_MS);
                return;
            }
            console.warn(`[Player] Stream did not produce video data after ${timeoutMs}ms (${reason})`);
            requestStreamRecovery(`stalled-${reason}`);
        };
        streamReadyWatchdogRef.current = setTimeout(() => checkStream(STREAM_READY_TIMEOUT_MS), STREAM_READY_TIMEOUT_MS);
    }, [clearStreamWatchdog, currentVideo, requestStreamRecovery, videoError]);

    useEffect(() => {
        if (!currentVideo) return;
        let cancelled = false;

        const loadStream = async () => {
            const loadSeq = streamLoadSeqRef.current + 1;
            streamLoadSeqRef.current = loadSeq;
            clearStreamWatchdog();
            resetVideoElement();
            setVideoLoading(true);
            setVideoError(null);
            setAudioTrackList([]);
            setSelectedAudioIndex(0);
            setShowAudioMenu(false);

            // Revoke old subtitle blob URL
            if (prevSubtitleUrl.current) {
                revokeSubtitleBlobUrl(prevSubtitleUrl.current);
                prevSubtitleUrl.current = null;
            }
            setSubtitleUrl(null);
            setRawSubtitleText(null);
            setEmbeddedSubtitleTracks([]);
            setSelectedEmbeddedSubtitleIndex(null);
            setEmbeddedSubtitleLoading(false);
            setShowSubtitleTrackMenu(false);
            setEmbeddedSubsAvailable(false);

            if (hlsInstanceRef.current) {
                hlsInstanceRef.current.destroy();
                hlsInstanceRef.current = null;
            }

            // ── Load video stream + subtitle file paralel (kurangi waktu tunggu) ──
            try {
                const [details, subText] = await Promise.all([
                    getStreamDetails(currentVideo.path),
                    currentVideo.subtitle_path
                        ? fetchSubtitle(currentVideo.subtitle_path)
                        : Promise.resolve(null)
                ]);
                if (cancelled) return;

                if (subText && !cancelled) {
                    setRawSubtitleText(subText);
                }

                if (currentVideo.path?.startsWith('gdrive/')) {
                    void getEmbeddedSubtitles(currentVideo.path)
                        .then((embeddedSubInfo) => {
                            if (cancelled || currentVideoPathRef.current !== currentVideo.path) return;
                            const embeddedTracks = Array.isArray(embeddedSubInfo?.tracks)
                                ? embeddedSubInfo.tracks.filter((track) => track?.stream_index != null)
                                : [];
                            const supportedEmbeddedTracks = embeddedTracks.filter((track) => track?.supported);
                            setEmbeddedSubtitleTracks(embeddedTracks);
                            if (!subText && supportedEmbeddedTracks.length > 0) {
                                const defaultTrack =
                                    supportedEmbeddedTracks.find((track) => track.default) ||
                                    supportedEmbeddedTracks.find((track) => /^(ind|id)$/i.test(track.language || '')) ||
                                    supportedEmbeddedTracks[0];
                                void loadEmbeddedSubtitleTrack(defaultTrack);
                            }
                        })
                        .catch((e) => {
                            if (!cancelled) console.error('Embedded subtitle probe error:', e);
                        });
                }

                if (details?.url && videoRef.current) {
                    // Extract file ID from the GDrive URL
                    const urlMatch = details.url.match(/files\/([^?]+)/);
                    const fileId = urlMatch ? urlMatch[1] : null;
                    const token = (details.headers?.Authorization || '').replace('Bearer ', '');

                    if (fileId && (details.stream_url || token)) {
                        if (hlsInstanceRef.current) {
                            hlsInstanceRef.current.destroy();
                            hlsInstanceRef.current = null;
                        }

                        const isHls = (currentVideo.original_name || currentVideo.name || '').toLowerCase().endsWith('.m3u8');

                        // Primary stream goes through backend so GDrive token refreshes stay invisible to the player.
                        const fallbackProxyPath = token
                            ? `/gdrive-proxy/${fileId}?alt=media&access_token=${encodeURIComponent(token)}`
                            : null;
                        const fallbackProxyUrl = fallbackProxyPath
                            ? (import.meta.env.DEV ? fallbackProxyPath : `${BASE_URL}${fallbackProxyPath}`)
                            : null;

                        let streamUrl;
                        if (isHls) {
                            // HLS manifest is rewritten by backend to stable segment proxy URLs.
                            const hlsUrl = details.hls_manifest_url || `/api/hls-manifest/${fileId}?access_token=${encodeURIComponent(token)}`;
                            streamUrl = addStreamCacheBuster(resolveBackendUrl(hlsUrl));
                        } else if (details.stream_url) {
                            streamUrl = addStreamCacheBuster(resolveBackendUrl(details.stream_url));
                        } else {
                            // Legacy backend response fallback.
                            streamUrl = addStreamCacheBuster(fallbackProxyUrl);
                        }

                        console.log('[Player] Loading via backend proxy:', token ? streamUrl.replace(token, '...') : streamUrl);

                        /**
                         * Helper: coba play video, dengan fallback lama untuk backend lama
                         * yang belum mengirim stream_url.
                         */
                        const usingStableBackendProxy = !!(!isHls && details.stream_url && fallbackProxyUrl);

                        const tryPlayWithFallback = (videoSrc) => {
                            if (!videoRef.current) return;
                            videoRef.current.src = videoSrc;
                            applyPlayerPrefsToVideo();
                            videoRef.current.load();
                            armStreamReadyWatchdog(loadSeq, 'backend-proxy');

                            const onErrorFallback = () => {
                                if (!usingStableBackendProxy || cancelled) return;
                                // Stable proxy gagal -> fallback lama untuk kompatibilitas.
                                console.warn('[Player] Stable backend stream failed, falling back to legacy proxy');
                                videoRef.current.removeEventListener('error', onErrorFallback);
                                videoRef.current.src = addStreamCacheBuster(fallbackProxyUrl);
                                applyPlayerPrefsToVideo();
                                videoRef.current.load();
                                armStreamReadyWatchdog(loadSeq, 'proxy-fallback');
                                playWithAutoplayFallback('Fallback autoplay');
                            };

                            if (usingStableBackendProxy) {
                                videoRef.current.addEventListener('error', onErrorFallback, { once: true });
                            }

                            playWithAutoplayFallback('Autoplay');
                        };

                        if (isHls) {
                            const { default: Hls } = await import('hls.js');
                            if (cancelled) return;
                            if (!Hls.isSupported()) {
                                tryPlayWithFallback(streamUrl);
                                return;
                            }
                            const hls = new Hls({
                                maxBufferLength: 90,
                                maxMaxBufferLength: 180,
                                backBufferLength: 30,
                                maxBufferHole: 0.5,
                                highBufferWatchdogPeriod: 3,
                                fragLoadingTimeOut: 30000,
                                fragLoadingMaxRetry: 8,
                                fragLoadingRetryDelay: 800,
                                fragLoadingMaxRetryTimeout: 12000,
                                manifestLoadingTimeOut: 20000,
                                manifestLoadingMaxRetry: 4,
                                lowLatencyMode: false,
                                enableWorker: true,
                            });
                            hlsInstanceRef.current = hls;
                            hls.loadSource(streamUrl);
                            hls.attachMedia(videoRef.current);
                            applyPlayerPrefsToVideo();
                            armStreamReadyWatchdog(loadSeq, 'hls');
                            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                                playWithAutoplayFallback('HLS autoplay');
                            });
                            hls.on(Hls.Events.ERROR, function (event, data) {
                                if (data.fatal) {
                                    switch (data.type) {
                                        case Hls.ErrorTypes.NETWORK_ERROR:
                                            if (!requestStreamRecovery(`hls-network-${data.details}`)) {
                                                hls.startLoad();
                                            }
                                            break;
                                        case Hls.ErrorTypes.MEDIA_ERROR:
                                            hls.recoverMediaError();
                                            break;
                                        default:
                                            hls.destroy();
                                            if (!requestStreamRecovery(`hls-${data.details}`)) {
                                                setVideoError('HLS Error: ' + data.details);
                                            }
                                            break;
                                    }
                                }
                            });
                        } else {
                            // Standard playback / Safari native HLS — with CF fallback
                            tryPlayWithFallback(streamUrl);
                        }
                    } else {
                        setVideoError('Invalid video URL or token');
                        setVideoLoading(false);
                    }
                } else {
                    setVideoError('Could not load video stream');
                    setVideoLoading(false);
                }
            } catch (e) {
                console.error('[Player] Stream load error:', e);
                if (!cancelled) {
                    setVideoError('Error loading video');
                    setVideoLoading(false);
                }
            }
        };
        loadStream();

        return () => {
            cancelled = true;
            clearStreamWatchdog();
            if (hlsInstanceRef.current) {
                hlsInstanceRef.current.destroy();
                hlsInstanceRef.current = null;
            }
            resetVideoElement();
        };
    }, [addStreamCacheBuster, applyPlayerPrefsToVideo, armStreamReadyWatchdog, clearStreamWatchdog, currentVideo, loadEmbeddedSubtitleTrack, playWithAutoplayFallback, requestStreamRecovery, resetVideoElement, resolveBackendUrl, streamReloadNonce]);

    // ─── Handle Subtitle Delay/Text Changes ─────────
    useEffect(() => {
        if (!rawSubtitleText) return;
        if (prevSubtitleUrl.current) {
            revokeSubtitleBlobUrl(prevSubtitleUrl.current);
        }
        // Parser: positif = geser timestamp maju (subtitle lebih lambat). UI negatif = tunda → negasi.
        const blobUrl = createSubtitleBlobUrl(rawSubtitleText, -(subSettings.delay || 0));
        setSubtitleUrl(blobUrl);
        prevSubtitleUrl.current = blobUrl;
    }, [rawSubtitleText, subSettings.delay]);

    // ─── Subtitle: file eksternal (blob VTT) ────────
    useEffect(() => {
        if (!videoRef.current) return;
        const video = videoRef.current;

        video.querySelectorAll('track').forEach((t) => t.remove());
        setActiveCues([]);

        if (subtitleUrl && showSubtitles) {
            const trackEl = document.createElement('track');
            trackEl.setAttribute('data-mutflix', 'external');
            trackEl.kind = 'subtitles';
            trackEl.label = 'Mutflix external';
            trackEl.srclang = 'id';
            trackEl.src = subtitleUrl;
            trackEl.default = true;
            video.appendChild(trackEl);

            let bound = false;
            const bindExternal = () => {
                if (bound) return;
                const tt = trackEl.track;
                if (!tt) return;
                bound = true;
                tt.mode = 'hidden';
                tt.oncuechange = () => {
                    if (tt.activeCues && tt.activeCues.length > 0) {
                        setActiveCues(Array.from(tt.activeCues).map((c) => c.text));
                    } else {
                        setActiveCues([]);
                    }
                };
                tt.oncuechange();
            };
            trackEl.addEventListener('load', bindExternal);
            if (trackEl.readyState === 2) queueMicrotask(bindExternal);
        }
    }, [subtitleUrl, showSubtitles]);

    // ─── Subtitle: tersemat di kontainer video (in-band) — tanpa file terpisah
    useEffect(() => {
        if (subtitleUrl) {
            if (embeddedSubCleanupRef.current) {
                embeddedSubCleanupRef.current();
                embeddedSubCleanupRef.current = null;
            }
            setEmbeddedSubsAvailable(false);
            return;
        }
        if (!showSubtitles) {
            if (embeddedSubCleanupRef.current) {
                embeddedSubCleanupRef.current();
                embeddedSubCleanupRef.current = null;
            }
            setEmbeddedSubsAvailable(false);
            setActiveCues([]);
            return;
        }
        const video = videoRef.current;
        if (!video || !currentVideo?.path) return;

        let cancelled = false;

        const tryBindEmbedded = () => {
            if (cancelled || subtitleUrl) return;
            if (embeddedSubCleanupRef.current) {
                embeddedSubCleanupRef.current();
                embeddedSubCleanupRef.current = null;
            }

            const list = video.textTracks;
            const subs = [];
            for (let i = 0; i < list.length; i++) {
                const t = list[i];
                if (t.kind === 'subtitles' || t.kind === 'captions') subs.push(t);
            }
            if (subs.length === 0) {
                setEmbeddedSubsAvailable(false);
                return;
            }

            subs.forEach((t) => { t.mode = 'disabled'; });
            const chosen = subs[0];
            chosen.mode = 'hidden';
            const onCue = () => {
                if (cancelled) return;
                if (chosen.activeCues && chosen.activeCues.length > 0) {
                    setActiveCues(Array.from(chosen.activeCues).map((c) => c.text));
                } else {
                    setActiveCues([]);
                }
            };
            chosen.addEventListener('cuechange', onCue);
            embeddedSubCleanupRef.current = () => {
                chosen.removeEventListener('cuechange', onCue);
                chosen.mode = 'disabled';
            };
            setEmbeddedSubsAvailable(true);
            onCue();
        };

        const onMedia = () => tryBindEmbedded();
        video.addEventListener('loadedmetadata', onMedia);
        video.addEventListener('loadeddata', onMedia);
        video.addEventListener('canplay', onMedia);
        const delays = [0, 120, 400, 1000, 2500, 5000].map((ms) => setTimeout(tryBindEmbedded, ms));
        const poll = setInterval(tryBindEmbedded, 400);
        const stopPoll = setTimeout(() => clearInterval(poll), 10000);

        return () => {
            cancelled = true;
            delays.forEach(clearTimeout);
            clearInterval(poll);
            clearTimeout(stopPoll);
            video.removeEventListener('loadedmetadata', onMedia);
            video.removeEventListener('loadeddata', onMedia);
            video.removeEventListener('canplay', onMedia);
            if (embeddedSubCleanupRef.current) {
                embeddedSubCleanupRef.current();
                embeddedSubCleanupRef.current = null;
            }
            setEmbeddedSubsAvailable(false);
        };
    }, [subtitleUrl, showSubtitles, currentVideo?.path]);

    const embeddedSubtitleSourceAvailable = embeddedSubtitleTracks.some((track) => track?.supported);
    const hasSubtitleSource = !!(subtitleUrl || embeddedSubsAvailable || embeddedSubtitleSourceAvailable);
    const syncDelayAppliesToExternalFile = !!subtitleUrl;

    /** Sembunyikan cursor seperti Netflix/YouTube saat UI sudah auto-hide (bukan saat menu terbuka / buffering). */
    const hidePlayerCursor =
        isPlaying &&
        !showControls &&
        !videoLoading &&
        !videoError &&
        !isScrubbing &&
        !showSubSettings &&
        !showSubtitleTrackMenu &&
        !showSpeedMenu &&
        !showAudioMenu;

    // ─── Controls auto-hide ─────────────────────────
    const resetControlsTimeout = useCallback(() => {
        setShowControls(true);
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = setTimeout(() => {
            if (isPlaying) setShowControls(false);
        }, 3000);
    }, [isPlaying]);

    useEffect(() => {
        return () => {
            clearStreamWatchdog();
            if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
            if (prevSubtitleUrl.current) revokeSubtitleBlobUrl(prevSubtitleUrl.current);
            if (hlsInstanceRef.current) hlsInstanceRef.current.destroy();
            resetVideoElement();
        };
    }, [clearStreamWatchdog, resetVideoElement]);

    // ─── Keyboard shortcuts ─────────────────────────
    useEffect(() => {
        const handleKey = (e) => {
            if (e.target.tagName === 'INPUT') return;
            const video = videoRef.current;
            if (!video) return;

            switch (e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    video.currentTime = Math.max(0, video.currentTime - 10);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    video.currentTime = Math.min(video.duration, video.currentTime + 10);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    restoreSoundAfterUserGesture();
                    setVolume(v => {
                        const nv = Math.min(1, v + 0.1);
                        video.volume = nv;
                        autoplayMutedRef.current = false;
                        if (nv > 0) {
                            video.muted = false;
                            setIsMuted(false);
                        }
                        setPlayerPrefs({ volume: nv, muted: nv === 0 ? true : false });
                        return nv;
                    });
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    setVolume(v => {
                        const nv = Math.max(0, v - 0.1);
                        video.volume = nv;
                        autoplayMutedRef.current = false;
                        video.muted = nv === 0;
                        setIsMuted(nv === 0);
                        setPlayerPrefs({ volume: nv, muted: nv === 0 });
                        return nv;
                    });
                    break;
                case 'f':
                    toggleFullscreen();
                    break;
                case 'm':
                    toggleMute();
                    break;
                case 'c':
                    setShowSubtitles(s => !s);
                    break;
                case 'Escape':
                    setShowSubtitleTrackMenu(false);
                    setShowSpeedMenu(false);
                    setShowAudioMenu(false);
                    setShowSubSettings(false);
                    break;
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isPlaying]);

    // ─── Player controls ───────────────────────────
    const handleVideoClick = () => {
        restoreSoundAfterUserGesture();
        if (showSubSettings) setShowSubSettings(false);
        if (showSubtitleTrackMenu) setShowSubtitleTrackMenu(false);
        if (showSpeedMenu) setShowSpeedMenu(false);
        if (showAudioMenu) setShowAudioMenu(false);
        setShowControls(false); // hide UI instead of pausing
    };

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        restoreSoundAfterUserGesture();
        if (video.paused) {
            playWithAutoplayFallback('User play');
        } else {
            video.pause();
            triggerSaveHistory();
        }
    };

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;
        if (autoplayMutedRef.current && playerPrefsRef.current.volume > 0 && !playerPrefsRef.current.isMuted) {
            autoplayMutedRef.current = false;
            video.muted = false;
            setIsMuted(false);
            return;
        }
        video.muted = !video.muted;
        setIsMuted(video.muted);
        setPlayerPrefs({ muted: video.muted });
    };

    const toggleFullscreen = () => {
        const container = playerContainerRef.current;
        if (!container) return;
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen();
        }
    };

    const handleProgressClick = (e) => {
        const video = videoRef.current;
        const bar = progressBarRef.current;
        if (!video || !bar) return;
        const rect = bar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        const nextTime = pos * video.duration;
        video.currentTime = nextTime;
        cacheCurrentResume(nextTime);
    };

    const commitScrub = useCallback(() => {
        const video = videoRef.current;
        if (!video || !duration) return;
        const clamped = Math.max(0, Math.min(scrubTime, duration));
        if (Math.abs((video.currentTime || 0) - clamped) > 0.05) {
            video.currentTime = clamped;
        }
        cacheCurrentResume(clamped);
        setCurrentTime(clamped);
        setIsScrubbing(false);
    }, [scrubTime, duration, cacheCurrentResume]);

    const changePlaybackRate = (rate) => {
        const video = videoRef.current;
        if (video) {
            video.defaultPlaybackRate = rate;
            video.playbackRate = rate;
        }
        setPlaybackRate(rate);
        setPlayerPrefs({ playbackRate: rate });
        setShowSpeedMenu(false);
    };

    const syncAudioTracksFromVideo = useCallback(() => {
        const v = videoRef.current;
        if (!v || typeof v.audioTracks === 'undefined' || v.audioTracks == null) {
            setAudioTrackList([]);
            return;
        }
        const n = v.audioTracks.length;
        if (n === 0) {
            setAudioTrackList([]);
            return;
        }
        const tracks = [];
        let enabledIdx = 0;
        for (let i = 0; i < n; i++) {
            const t = v.audioTracks[i];
            const lang = t.language || '';
            const raw = (t.label && String(t.label).trim()) || '';
            const label = raw || (lang ? lang.toUpperCase() : `Audio ${i + 1}`);
            tracks.push({ index: i, label, language: lang });
            if (t.enabled) enabledIdx = i;
        }
        setAudioTrackList(tracks);
        setSelectedAudioIndex(enabledIdx);
    }, []);

    const selectAudioTrack = (index) => {
        const v = videoRef.current;
        if (!v?.audioTracks || index < 0 || index >= v.audioTracks.length) return;
        for (let i = 0; i < v.audioTracks.length; i++) {
            v.audioTracks[i].enabled = i === index;
        }
        setSelectedAudioIndex(index);
        setShowAudioMenu(false);
    };

    /** Audio ter-embed: browser sering mengisi audioTracks setelah metadata — poll singkat + event */
    useEffect(() => {
        if (!currentVideo?.path) return;
        const v = videoRef.current;
        if (!v) return;
        const sync = () => syncAudioTracksFromVideo();
        const onMedia = () => sync();
        v.addEventListener('loadeddata', onMedia);
        v.addEventListener('canplaythrough', onMedia);
        const delays = [0, 50, 150, 400, 1000, 2000, 3500].map((ms) => setTimeout(sync, ms));
        const poll = setInterval(sync, 200);
        const stopPollTimer = setTimeout(() => clearInterval(poll), 6000);
        return () => {
            delays.forEach(clearTimeout);
            clearInterval(poll);
            clearTimeout(stopPollTimer);
            v.removeEventListener('loadeddata', onMedia);
            v.removeEventListener('canplaythrough', onMedia);
        };
    }, [currentVideo?.path, syncAudioTracksFromVideo]);

    // ─── Video event handlers ──────────────────────
    const handleTimeUpdate = () => {
        const video = videoRef.current;
        if (!video) return;
        const now = performance.now();
        if (now - lastResumeCacheTickRef.current >= 1000) {
            lastResumeCacheTickRef.current = now;
            cacheCurrentResume();
        }
        if (now - lastPlaybackUiTickRef.current < 250) return;
        lastPlaybackUiTickRef.current = now;
        currentTimeRef.current = video.currentTime;
        setCurrentTime(video.currentTime);
        if (video.buffered.length > 0) {
            setBuffered(video.buffered.end(video.buffered.length - 1));
        }
    };

    const handleSeeked = () => {
        cacheCurrentResume();
        void triggerSaveHistory();
    };

    /** `progress` lebih sering daripada `timeupdate` — bar buffer lebih akurat saat unduhan jauh di depan playhead. */
    const handleBufferProgress = () => {
        const video = videoRef.current;
        if (!video || video.buffered.length === 0) return;
        const now = performance.now();
        if (now - lastBufferUiTickRef.current < 500) return;
        lastBufferUiTickRef.current = now;
        setBuffered(video.buffered.end(video.buffered.length - 1));
    };

    const handleVideoPlay = () => setIsPlaying(true);
    const handleVideoPause = () => setIsPlaying(false);
    const handleLoadedMetadata = () => {
        const video = videoRef.current;
        if (video) {
            applyPlayerPrefsToVideo();
            setDuration(video.duration);
            if (pendingStreamSeekRef.current > 0 && Number.isFinite(video.duration) && video.duration > 0) {
                const recoveryTime = Math.min(pendingStreamSeekRef.current, Math.max(0, video.duration - 1));
                video.currentTime = recoveryTime;
                currentTimeRef.current = recoveryTime;
                setCurrentTime(recoveryTime);
                pendingStreamSeekRef.current = 0;
            }
        }
        syncAudioTracksFromVideo();
    };
    const handleVideoError = () => {
        clearStreamWatchdog();
        const video = videoRef.current;
        // Ignore errors when no source is loaded yet
        if (!video || !video.src || video.src === window.location.href) return;
        const err = video.error;
        console.error('Video error:', err?.code, err?.message);

        const isNearEnd =
            Number.isFinite(video.duration) &&
            video.duration > 0 &&
            Number.isFinite(video.currentTime) &&
            video.currentTime >= video.duration - 3;
        if (isNearEnd && currentVideo) {
            const currentIdx = videos.findIndex((v) => v === currentVideo);
            if (currentIdx >= 0 && currentIdx < videos.length - 1) {
                playEpisode(videos[currentIdx + 1]);
                return;
            }
        }

        if (requestStreamRecovery(`native-${err?.code || 'unknown'}`)) return;
        setVideoError(`Playback error${err?.message ? ': ' + err.message : ''}. Try refreshing.`);
    };
    const handleWaiting = () => setVideoLoading(true);
    const handlePlaying = () => {
        clearStreamWatchdog();
        setVideoLoading(false);
    };
    const handleCanPlay = () => {
        clearStreamWatchdog();
        setVideoLoading(false);
        applyPlayerPrefsToVideo();
        // If the browser natively paused it despite autoPlay (e.g. low power mode), we can try one more time securely.
        const video = videoRef.current;
        if (video && video.paused && !isPlaying) {
            playWithAutoplayFallback('CanPlay autoplay');
        }
        syncAudioTracksFromVideo();
        requestAnimationFrame(() => syncAudioTracksFromVideo());
        setTimeout(syncAudioTracksFromVideo, 150);
    };

    // ─── Episode switching ─────────────────────────
    const playEpisode = (video) => {
        if (video === currentVideo) return;
        clearStreamWatchdog();
        resetVideoElement();
        setCurrentVideo(video);
        setIsPlaying(false);
        setVideoError(null);
        setVideoLoading(true);
        setCurrentTime(0);
        setDuration(0);
        setBuffered(0);
        setWatchSessionForFolder(decodedName, video);
        // Update URL without full navigation
        const newParams = new URLSearchParams(window.location.search);
        newParams.set('ep', video.episode || 1);
        newParams.set('s', video.season || 1);
        window.history.replaceState({}, '', `/watch/${folderName}?${newParams.toString()}`);
    };

    const playNextEpisode = () => {
        if (!currentVideo) return;
        const currentIdx = videos.findIndex((v) => v === currentVideo);
        if (currentIdx < videos.length - 1) {
            playEpisode(videos[currentIdx + 1]);
        }
    };

    const playPrevEpisode = () => {
        if (!currentVideo) return;
        const currentIdx = videos.findIndex((v) => v === currentVideo);
        if (currentIdx > 0) {
            playEpisode(videos[currentIdx - 1]);
        }
    };

    // ─── Fullscreen change detection ──────────────
    useEffect(() => {
        const handler = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    // ─── Format time ───────────────────────────────
    const formatTime = (seconds) => {
        if (!seconds || isNaN(seconds)) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };


    // ─── Loading state ─────────────────────────────
    if (loading) {
        return <LoadingScreen />;
    }

    return (
        <div className="min-h-screen bg-[#0a0b0f] text-white font-sans flex flex-col pt-[72px]">
            {/* ═══════ TOP BAR ═══════ */}
            <Navbar
                onMeClick={() => setShowLoginModal(true)}
                isLoggedIn={!!authUser}
                username={authUser?.username}
                onLogout={handleLogout}
            />

            {/* ═══════ MAIN CONTENT: Video + Sidebar ═══════ */}
            <div className="flex flex-col lg:flex-row flex-1 px-4 lg:px-8 py-6 gap-6 max-w-[1600px] mx-auto w-full">

                {/* ═══ VIDEO PLAYER ═══ */}
                <div className="flex-1 min-w-0">
                    <div
                        ref={playerContainerRef}
                        className={`relative bg-black group ${isFullscreen ? 'fixed inset-0 z-[9999]' : 'aspect-video w-full'} ${hidePlayerCursor ? 'cursor-none' : ''}`}
                        onMouseMove={resetControlsTimeout}
                        onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
                    >
                        {/* Video Element */}
                        <video
                            ref={videoRef}
                            className={`w-full h-full object-contain bg-black ${hidePlayerCursor ? 'cursor-none' : ''}`}
                            preload="auto"
                            onTimeUpdate={handleTimeUpdate}
                            onSeeked={handleSeeked}
                            onProgress={handleBufferProgress}
                            onPlay={handleVideoPlay}
                            onPause={handleVideoPause}
                            onPlaying={handlePlaying}
                            onLoadedMetadata={handleLoadedMetadata}
                            onLoadedData={() => {
                                clearStreamWatchdog();
                                setVideoLoading(false);
                                applyPlayerPrefsToVideo();
                                syncAudioTracksFromVideo();
                            }}
                            onError={handleVideoError}
                            onWaiting={handleWaiting}
                            onCanPlay={handleCanPlay}
                            onCanPlayThrough={() => {
                                clearStreamWatchdog();
                                setVideoLoading(false);
                                applyPlayerPrefsToVideo();
                            }}
                            onEnded={playNextEpisode}
                            onClick={handleVideoClick}
                            autoPlay
                            playsInline
                        />

                        {/* Custom Subtitle Overlay */}
                        {showSubtitles && activeCues.length > 0 && (
                            <div
                                className="absolute left-0 right-0 pointer-events-none flex flex-col items-center justify-end z-[15] w-full"
                                style={{ bottom: `${subSettings.marginBottom}%` }}
                            >
                                {activeCues.map((text, i) => {
                                    // Build outline/text-shadow based on outlineStyle + outlineThickness
                                    const t = subSettings.outlineThickness ?? 2;
                                    let computedTextShadow = 'none';
                                    let computedStroke = 'unset';
                                    if (subSettings.outlineStyle === 'drop-shadow') {
                                        computedTextShadow = `${t}px ${t}px ${t * 2}px rgba(0,0,0,0.8)`;
                                    } else if (subSettings.outlineStyle === 'hard-outline') {
                                        // Multi-directional shadow for thick solid outline
                                        const shadows = [];
                                        for (let dx = -t; dx <= t; dx++) {
                                            for (let dy = -t; dy <= t; dy++) {
                                                if (dx === 0 && dy === 0) continue;
                                                shadows.push(`${dx}px ${dy}px 0 #000`);
                                            }
                                        }
                                        computedTextShadow = shadows.length > 0 ? shadows.join(', ') : 'none';
                                        computedStroke = t > 0 ? `${Math.min(t, 3)}px #000` : 'unset';
                                    }
                                    // outlineStyle === 'none' → both stay at initial values

                                    return (
                                        <div
                                            key={i}
                                            className="text-center px-4 py-1 rounded"
                                            style={{
                                                fontSize: `${subSettings.fontSize}px`,
                                                fontFamily: subSettings.fontFamily,
                                                color: '#ffffff',
                                                textShadow: computedTextShadow,
                                                WebkitTextStroke: computedStroke,
                                                paintOrder: 'stroke fill',
                                                backgroundColor: subSettings.backgroundColor === 'transparent' ? 'transparent' : `rgba(0,0,0,${subSettings.backgroundOpacity})`,
                                                whiteSpace: 'pre-wrap',
                                                maxWidth: '90%'
                                            }}
                                            dangerouslySetInnerHTML={{ __html: text.replace(/\n/g, '<br/>') }}
                                        />
                                    );
                                })}
                            </div>
                        )}

                        {/* Loading Spinner Overlay */}
                        {videoLoading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                                <Loader2 size={48} className="text-[#00dc41] animate-spin" />
                            </div>
                        )}

                        {/* Error Overlay */}
                        {videoError && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                                <div className="text-center">
                                    <p className="text-red-400 mb-3">{videoError}</p>
                                    <button
                                        onClick={() => {
                                            setVideoError(null);
                                            resetVideoElement();
                                            setStreamReloadNonce((value) => value + 1);
                                        }}
                                        className="bg-[#00dc41] text-black px-4 py-2 rounded-lg font-medium hover:bg-[#00f048] transition"
                                    >
                                        Retry
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ═══ TOP PLAYER OVERLAY (Title & Watermark) ═══ */}
                        <div className={`absolute top-0 left-0 right-0 pt-6 pb-12 px-6 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 pointer-events-none z-10 flex justify-between items-start ${showControls || !isPlaying ? 'opacity-100' : 'opacity-0'}`}>
                            <h2 className="text-white font-bold text-lg md:text-xl drop-shadow-md flex items-center gap-2">
                                {playerHeaderTitle}
                            </h2>
                        </div>

                        {/* Center Play Button (when paused) */}
                        {!isPlaying && !videoLoading && !videoError && (
                            <div
                                className="absolute inset-0 flex items-center justify-center cursor-pointer"
                                onClick={togglePlay}
                            >
                                <div className="bg-[#00dc41]/90 rounded-full p-5 shadow-[0_0_40px_rgba(0,220,65,0.4)] hover:scale-110 transition-transform backdrop-blur-sm">
                                    <Play fill="black" size={32} className="text-black ml-1" />
                                </div>
                            </div>
                        )}

                        {/* ═══ CONTROLS OVERLAY ═══ */}
                        <div className={`absolute bottom-0 left-0 right-0 z-30 transition-all duration-300 ${showControls || !isPlaying ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
                            {/* Gradient backdrop */}
                            <div className="bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 pb-3 px-4">

                                {/* Progress Bar */}
                                <div
                                    ref={progressBarRef}
                                    className="relative h-1.5 rounded-full cursor-pointer group/progress mb-3 hover:h-2.5 transition-all w-full flex items-center bg-white/20"
                                    onClick={handleProgressClick}
                                >
                                    {/* Buffered */}
                                    <div
                                        className="absolute top-0 left-0 h-full bg-white/20 rounded-full pointer-events-none"
                                        style={{ width: `${bufferedPercent}%` }}
                                    />
                                    {/* Progress */}
                                    <div
                                        className="absolute top-0 left-0 h-full bg-[#00dc41] rounded-full transition-[width] duration-100 pointer-events-none"
                                        style={{ width: `${progressPercent}%` }}
                                    />
                                    {/* Thumb */}
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-[#00dc41] rounded-full shadow-[0_0_8px_rgba(0,220,65,0.5)] opacity-0 group-hover/progress:opacity-100 transition pointer-events-none z-10"
                                        style={{ left: `calc(${progressPercent}% - 7px)` }}
                                    />
                                    {/* Native Scrubber */}
                                    <input
                                        type="range"
                                        min="0"
                                        max={duration || 100}
                                        value={isScrubbing ? scrubTime : currentTime}
                                        step="0.1"
                                        onChange={(e) => {
                                            const time = parseFloat(e.target.value);
                                            if (Number.isNaN(time)) return;
                                            setScrubTime(time);
                                            setCurrentTime(time);
                                            if (!isScrubbing && videoRef.current) {
                                                videoRef.current.currentTime = time;
                                            }
                                        }}
                                        onMouseDown={() => {
                                            setIsScrubbing(true);
                                            setScrubTime(currentTime);
                                        }}
                                        onTouchStart={() => {
                                            setIsScrubbing(true);
                                            setScrubTime(currentTime);
                                        }}
                                        onMouseUp={commitScrub}
                                        onTouchEnd={commitScrub}
                                        onKeyUp={(e) => {
                                            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
                                                commitScrub();
                                            }
                                        }}
                                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20 m-0 p-0"
                                    />
                                </div>

                                {/* Controls Row */}
                                <div className="flex items-center gap-2 pointer-events-auto">
                                    {/* Left controls */}
                                    <button onClick={togglePlay} className="text-white hover:text-[#00dc41] transition p-1.5">
                                        {isPlaying ? <Pause size={22} fill="currentColor" color="currentColor" /> : <Play size={22} fill="currentColor" color="currentColor" />}
                                    </button>

                                    <button onClick={playPrevEpisode} className="text-white/70 hover:text-white transition p-1.5" title="Previous">
                                        <SkipBack size={20} strokeWidth={2.5} />
                                    </button>
                                    <button onClick={playNextEpisode} className="text-white/70 hover:text-white transition p-1.5" title="Next">
                                        <SkipForward size={20} strokeWidth={2.5} />
                                    </button>

                                    {/* Time display */}
                                    <span className="text-[13px] text-gray-200 font-medium ml-3 select-none tracking-wide">
                                        {formatTime(currentTime)} <span className="text-gray-500 mx-0.5">/</span> {formatTime(duration)}
                                    </span>

                                    {/* Spacer */}
                                    <div className="flex-1" />

                                    {/* Right controls */}
                                    <div className="flex items-center gap-4">
                                        {/* Subtitles text toggle & Settings */}
                                        <div className="flex items-center gap-1.5 relative">
                                            <button
                                                onClick={() => setShowSubtitles(!showSubtitles)}
                                                className={`transition text-[13px] font-medium ${showSubtitles && hasSubtitleSource ? 'text-[#00dc41]' : 'text-white/70 hover:text-[#00dc41]'}`}
                                                title={
                                                    !hasSubtitleSource
                                                        ? 'No subtitles'
                                                        : embeddedSubsAvailable && !subtitleUrl
                                                            ? (showSubtitles ? 'Hide embedded subtitles' : 'Show embedded subtitles')
                                                            : (showSubtitles ? 'Hide Subtitles' : 'Show Subtitles')
                                                }
                                            >
                                                Subtitle
                                            </button>
                                            {embeddedSubtitleTracks.length > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setShowSubtitleTrackMenu(!showSubtitleTrackMenu);
                                                        setShowSubSettings(false);
                                                        setShowSpeedMenu(false);
                                                        setShowAudioMenu(false);
                                                    }}
                                                    className={`max-w-[150px] truncate transition text-[12px] font-medium flex items-center gap-0.5 ${showSubtitleTrackMenu ? 'text-[#00dc41]' : 'text-white/60 hover:text-white'}`}
                                                    title="Pilih subtitle embedded"
                                                >
                                                    <span className="truncate">
                                                        {embeddedSubtitleLoading
                                                            ? 'Loading...'
                                                            : embeddedSubtitleTracks.find((track) => track.stream_index === selectedEmbeddedSubtitleIndex)?.label || 'Embedded'}
                                                    </span>
                                                    <ChevronDown size={13} className="shrink-0" />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => {
                                                    setShowSubSettings(!showSubSettings);
                                                    setShowSubtitleTrackMenu(false);
                                                    setShowSpeedMenu(false);
                                                    setShowAudioMenu(false);
                                                }}
                                                className={`p-1 transition ${showSubSettings ? 'text-[#00dc41]' : 'text-white/50 hover:text-white'}`}
                                            >
                                                <Settings size={14} />
                                            </button>

                                            {showSubtitleTrackMenu && embeddedSubtitleTracks.length > 0 && (
                                                <div className="absolute bottom-full right-0 mb-3 bg-[#1a1c22]/95 backdrop-blur-md rounded-lg border border-white/10 py-1 shadow-xl min-w-[190px] max-h-56 overflow-y-auto z-50">
                                                    {embeddedSubtitleTracks.map((track) => (
                                                        <button
                                                            type="button"
                                                            key={track.stream_index}
                                                            disabled={embeddedSubtitleLoading || !track.supported}
                                                            onClick={() => {
                                                                if (!track.supported) return;
                                                                setShowSubtitleTrackMenu(false);
                                                                void loadEmbeddedSubtitleTrack(track);
                                                            }}
                                                            className={`block w-full text-left px-3 py-1.5 text-[12px] transition disabled:opacity-50 ${selectedEmbeddedSubtitleIndex === track.stream_index
                                                                ? 'text-[#00dc41] bg-[#00dc41]/10 font-bold'
                                                                : 'text-gray-300 hover:bg-white/5 hover:text-white'
                                                                }`}
                                                        >
                                                            {track.label || `Subtitle ${track.stream_index}`}
                                                            {track.codec ? (
                                                                <span className="text-gray-500 font-normal ml-1">
                                                                    {track.supported ? track.codec : `${track.codec} unsupported`}
                                                                </span>
                                                            ) : null}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Subtitle Settings Menu */}
                                            <div className={`absolute bottom-full right-0 mb-4 bg-[#1a1c22]/95 backdrop-blur-md rounded-lg border border-white/10 p-4 shadow-xl w-[280px] text-white z-50 cursor-default transition-all duration-200 origin-bottom-right ${showSubSettings ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto' : 'opacity-0 scale-95 translate-y-2 pointer-events-none'}`}>
                                                <h3 className="text-[13px] font-bold text-gray-300 mb-3 border-b border-white/10 pb-2">Subtitle Settings</h3>

                                                {/* Sync: negatif = tunda, positif = percepat (hanya file .srt/.vtt) */}
                                                <div className="mb-3">
                                                    <div className="text-[10px] text-gray-500 mb-0.5">− tunda · + percepat</div>
                                                    {!syncDelayAppliesToExternalFile && embeddedSubsAvailable && (
                                                        <p className="text-[10px] text-amber-500/90 mb-1">Sinkron tidak berlaku untuk subtitle tersemat di video (kontrol browser).</p>
                                                    )}
                                                    <div className="text-[11px] text-gray-500 mb-1 flex justify-between items-center">
                                                        <span>Sinkron</span>
                                                        <div className="flex items-center gap-2">
                                                            <span>{subSettings.delay > 0 ? '+' : ''}{subSettings.delay}s</span>
                                                            {subSettings.delay !== 0 && syncDelayAppliesToExternalFile && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setSubSettings({ ...subSettings, delay: 0 })}
                                                                    className="text-[#00dc41] hover:text-white transition px-1.5 rounded bg-white/5 border border-white/10"
                                                                >
                                                                    Reset
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min={-SUBTITLE_DELAY_MAX_SECONDS}
                                                        max={SUBTITLE_DELAY_MAX_SECONDS}
                                                        step="0.5"
                                                        value={subSettings.delay}
                                                        disabled={!syncDelayAppliesToExternalFile && embeddedSubsAvailable}
                                                        onChange={(e) =>
                                                            setSubSettings({
                                                                ...subSettings,
                                                                delay: clampSubtitleDelay(parseFloat(e.target.value))
                                                            })
                                                        }
                                                        className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00dc41] disabled:opacity-40 disabled:cursor-not-allowed"
                                                    />
                                                </div>

                                                {/* Font Size */}
                                                <div className="mb-3">
                                                    <div className="text-[11px] text-gray-500 mb-1 flex justify-between">
                                                        <span>Size</span> <span>{subSettings.fontSize}px</span>
                                                    </div>
                                                    <input
                                                        type="range" min="14" max="48" step="1"
                                                        value={subSettings.fontSize}
                                                        onChange={(e) => setSubSettings({ ...subSettings, fontSize: parseInt(e.target.value) })}
                                                        className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00dc41]"
                                                    />
                                                </div>

                                                {/* Vertical Position */}
                                                <div className="mb-3">
                                                    <div className="text-[11px] text-gray-500 mb-1 flex justify-between">
                                                        <span>Position (Bottom)</span> <span>{subSettings.marginBottom}%</span>
                                                    </div>
                                                    <input
                                                        type="range" min="0" max="80" step="1"
                                                        value={subSettings.marginBottom}
                                                        onChange={(e) => setSubSettings({ ...subSettings, marginBottom: parseInt(e.target.value) })}
                                                        className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00dc41]"
                                                    />
                                                </div>

                                                {/* Font Family */}
                                                <div className="mb-3">
                                                    <div className="text-[11px] text-gray-500 mb-1">Font Family</div>
                                                    <select
                                                        value={subSettings.fontFamily}
                                                        onChange={(e) => setSubSettings({ ...subSettings, fontFamily: e.target.value })}
                                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] text-white outline-none focus:border-[#00dc41]"
                                                    >
                                                        <option value="Poppins, sans-serif">Sans-Serif (Poppins)</option>
                                                        <option value="'Courier New', Courier, monospace">Monospace</option>
                                                        <option value="'Times New Roman', Times, serif">Serif</option>
                                                    </select>
                                                </div>

                                                {/* Background Opacity */}
                                                <div className="mb-3">
                                                    <div className="text-[11px] text-gray-500 mb-1 flex justify-between">
                                                        <span>Background Opacity</span> <span>{Math.round(subSettings.backgroundOpacity * 100)}%</span>
                                                    </div>
                                                    <input
                                                        type="range" min="0" max="1" step="0.1"
                                                        value={subSettings.backgroundOpacity}
                                                        onChange={(e) => setSubSettings({ ...subSettings, backgroundOpacity: parseFloat(e.target.value) })}
                                                        className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00dc41]"
                                                    />
                                                </div>

                                                {/* Outline Style */}
                                                <div className="mb-3">
                                                    <div className="text-[11px] text-gray-500 mb-1">Outline Style</div>
                                                    <select
                                                        value={subSettings.outlineStyle || 'drop-shadow'}
                                                        onChange={(e) => setSubSettings({ ...subSettings, outlineStyle: e.target.value })}
                                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] text-white outline-none focus:border-[#00dc41]"
                                                    >
                                                        <option value="drop-shadow">Drop Shadow</option>
                                                        <option value="hard-outline">Hard Outline</option>
                                                        <option value="none">None</option>
                                                    </select>
                                                </div>

                                                {/* Outline Thickness */}
                                                {subSettings.outlineStyle !== 'none' && (
                                                    <div className="mb-1">
                                                        <div className="text-[11px] text-gray-500 mb-1 flex justify-between">
                                                            <span>Outline Thickness</span> <span>{subSettings.outlineThickness ?? 2}px</span>
                                                        </div>
                                                        <input
                                                            type="range" min="1" max="6" step="0.5"
                                                            value={subSettings.outlineThickness ?? 2}
                                                            onChange={(e) => setSubSettings({ ...subSettings, outlineThickness: parseFloat(e.target.value) })}
                                                            className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#00dc41]"
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Audio ter-embed di file: pakai API browser video.audioTracks (bukan file terpisah) */}
                                        {audioTrackList.length > 1 && (
                                            <div className="relative">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setShowAudioMenu(!showAudioMenu);
                                                        setShowSpeedMenu(false);
                                                        setShowSubtitleTrackMenu(false);
                                                        setShowSubSettings(false);
                                                    }}
                                                    className={`transition text-[13px] font-medium flex items-center gap-1 max-w-[160px] truncate ${showAudioMenu ? 'text-[#00dc41]' : 'text-white/70 hover:text-[#00dc41]'}`}
                                                    title="Pilih trek audio (embedded)"
                                                >
                                                    <Languages size={15} className="shrink-0 opacity-90" />
                                                    <span className="truncate">{audioTrackList[selectedAudioIndex]?.label || 'Audio'}</span>
                                                </button>
                                                {showAudioMenu && (
                                                    <div className="absolute bottom-full right-0 mb-3 bg-[#1a1c22]/95 backdrop-blur-md rounded-lg border border-white/10 py-1 shadow-xl min-w-[160px] max-h-48 overflow-y-auto z-50">
                                                        {audioTrackList.map((t) => (
                                                            <button
                                                                type="button"
                                                                key={t.index}
                                                                onClick={() => selectAudioTrack(t.index)}
                                                                className={`block w-full text-left px-3 py-1.5 text-[12px] transition ${selectedAudioIndex === t.index
                                                                    ? 'text-[#00dc41] bg-[#00dc41]/10 font-bold'
                                                                    : 'text-gray-300 hover:bg-white/5 hover:text-white'
                                                                    }`}
                                                            >
                                                                {t.label}
                                                                {t.language ? (
                                                                    <span className="text-gray-500 font-normal ml-1">({t.language})</span>
                                                                ) : null}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Speed */}
                                        <div className="relative">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowSpeedMenu(!showSpeedMenu);
                                                    setShowAudioMenu(false);
                                                    setShowSubtitleTrackMenu(false);
                                                    setShowSubSettings(false);
                                                }}
                                                className={`transition text-[13px] font-medium ${playbackRate !== 1 ? 'text-[#00dc41]' : 'text-white/70 hover:text-[#00dc41]'}`}
                                            >
                                                {playbackRate.toFixed(1)}X
                                            </button>
                                            {showSpeedMenu && (
                                                <div className="absolute bottom-full right-1/2 translate-x-1/2 mb-4 bg-[#1a1c22]/95 backdrop-blur-md rounded-lg border border-white/10 py-1 shadow-xl min-w-[80px]">
                                                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                                                        <button
                                                            key={rate}
                                                            onClick={() => changePlaybackRate(rate)}
                                                            className={`block w-full text-center px-3 py-1.5 text-[12px] transition ${playbackRate === rate
                                                                ? 'text-[#00dc41] bg-[#00dc41]/10 font-bold'
                                                                : 'text-gray-300 hover:bg-white/5 hover:text-white'
                                                                }`}
                                                        >
                                                            {rate}x
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Volume */}
                                        <div className="flex items-center gap-1 group/vol ml-2">
                                            <button onClick={toggleMute} className="text-white/70 hover:text-white transition p-1.5">
                                                {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                                            </button>
                                            <input
                                                type="range"
                                                min="0"
                                                max="1"
                                                step="0.05"
                                                value={isMuted ? 0 : volume}
                                                onChange={(e) => {
                                                    const v = parseFloat(e.target.value);
                                                    autoplayMutedRef.current = false;
                                                    setVolume(v);
                                                    if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
                                                    setIsMuted(v === 0);
                                                    setPlayerPrefs({ volume: v, muted: v === 0 });
                                                }}
                                                className="w-0 group-hover/vol:w-20 transition-all duration-300 accent-[#00dc41] h-1.5 rounded-full cursor-pointer opacity-0 group-hover/vol:opacity-100"
                                            />
                                        </div>

                                        {/* Fullscreen */}
                                        <button onClick={toggleFullscreen} className="text-white/70 hover:text-white transition p-1.5">
                                            {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ═══ CONTENT DETAILS (Below Player) ═══ */}
                    <div className="py-6">
                        {/* Title Breadcrumbs */}
                        <div className="text-[22px] md:text-[26px] font-bold text-white mb-4 flex items-center flex-wrap">
                            {title}
                            {isSeriesContent && (
                                <>
                                    <span className="text-gray-500 mx-2 text-[20px]">›</span>
                                    <span>Episode {currentEpisodeNum}</span>
                                </>
                            )}
                        </div>

                        {/* Meta Stats Row */}
                        <div className="flex items-center gap-3 text-sm text-gray-300 mb-4 flex-wrap">
                            {rating > 0 && (
                                <span className="text-[#00dc41] font-bold text-[16px] flex items-center gap-1">
                                    ★ {Number(rating).toFixed(1)}
                                    <span className="text-gray-500 text-[12px] font-normal tracking-wide">
                                        ({(tmdbData?.vote_count ? (tmdbData.vote_count / 1000).toFixed(1) : '74.1')}k ratings)
                                    </span>
                                    <span className="text-[#00dc41] text-[12px] font-medium ml-1 cursor-pointer hover:underline">· Rate now</span>
                                </span>
                            )}
                            <span className="bg-[#00dc41] text-black px-1.5 py-0.5 rounded text-[11px] font-bold ml-2">TOP 1</span>
                            <span className="text-[13px] font-bold text-white">Hot Dramas</span>
                            <span className="text-gray-600">|</span>
                            <span>13+</span>
                            <span className="text-gray-600">|</span>
                            <span>{year}</span>
                            <span className="text-gray-600">|</span>
                            <span>{isSeriesContent ? videos.length : 1} Episodes</span>
                        </div>

                        {/* Tags Row */}
                        <div className="flex items-center gap-2 mb-4 flex-wrap">
                            {/* We will extract some genre tags from tmdbData if possible, or fallback */}
                            {tmdbData?.genre_ids ? tmdbData.genre_ids.map(id => TMDB_GENRES[id]).filter(Boolean).map((tag, i) => (
                                <span key={i} className="bg-white/10 text-gray-300 px-2 py-0.5 rounded text-[12px] cursor-pointer hover:bg-white/20 transition">
                                    {tag}
                                </span>
                            )) : ['Chinese Mainland', 'Romance', 'Costume', 'Mandarin'].map(tag => (
                                <span key={tag} className="bg-white/10 text-gray-300 px-2 py-0.5 rounded text-[12px] cursor-pointer hover:bg-white/20 transition">
                                    {tag}
                                </span>
                            ))}
                        </div>

                        {/* Description */}
                        {overview && (
                            <div className="mb-8">
                                <p className={`text-gray-300 text-[13px] leading-relaxed inline ${expandedDesc ? '' : 'line-clamp-2'}`}>
                                    <span className="text-gray-500">Description: </span>{overview}
                                </p>
                                <button
                                    onClick={() => setExpandedDesc(!expandedDesc)}
                                    className="text-white text-[13px] font-bold ml-1 inline-flex items-center gap-0.5 hover:text-[#00dc41] transition"
                                >
                                    {expandedDesc ? 'Less' : 'More'} {expandedDesc ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                </button>
                            </div>
                        )}

                        {/* Cast */}
                        {castList.length > 0 && (
                            <div className="mb-4">
                                <h3 className="text-white text-[18px] font-bold mb-4">Cast</h3>
                                <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                                    {castList.slice(0, 12).map(member => (
                                        <div key={member.id} className="flex flex-col items-center flex-shrink-0 group cursor-pointer w-[72px] md:w-[84px]">
                                            <div className="w-16 h-16 md:w-20 md:h-20 rounded-full overflow-hidden bg-[#1a1c22] mb-1.5 border-2 border-transparent group-hover:border-[#00dc41]/60 transition-all">
                                                {member.profile_path ? (
                                                    <img
                                                        src={member.profile_path}
                                                        alt={member.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-[#22252b]">
                                                        <User size={24} className="text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <p className="text-[12px] font-bold text-gray-200 text-center line-clamp-1 w-full group-hover:text-[#00dc41] transition">{member.name}</p>
                                            {member.character && (
                                                <p className="text-[10px] text-gray-500 text-center line-clamp-1 w-full">{member.character}</p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {(recommendationsLoading || recommendations.length > 0) && (
                            <div className="mt-8 mb-8 border-t border-white/5 pt-8">
                                <h3 className="text-white text-[18px] font-bold mb-4">More Like This</h3>
                                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                    {recommendationsLoading && recommendations.length === 0 ? (
                                        Array.from({ length: 6 }).map((_, i) => (
                                            <div key={`recommend-skeleton-${i}`} className="aspect-[2/3] bg-[#1a1c22] rounded-md border border-white/5 animate-pulse" />
                                        ))
                                    ) : (
                                        recommendations.slice(0, 12).map((item) => {
                                            const recTitle = item.tmdb_title || item.title;
                                            const poster = tmdbPosterUrl(item.poster_path || item.backdrop_path, 'w342');
                                            return (
                                                <button
                                                    key={`${item.media_type}-${item.tmdb_id}`}
                                                    type="button"
                                                    onClick={() => {
                                                        navigate(`/detail/${encodeURIComponent(recTitle)}?type=${item.media_type === 'movie' ? 'movie' : 'series'}`, {
                                                            state: {
                                                                detailItem: {
                                                                    folder_name: recTitle,
                                                                    name: recTitle,
                                                                    media_type: item.media_type === 'movie' ? 'movie' : 'tv',
                                                                    tmdb_id: item.tmdb_id,
                                                                    tmdb_title: recTitle,
                                                                    tmdb_poster_path: item.poster_path,
                                                                    tmdb_backdrop_path: item.backdrop_path,
                                                                    tmdb_rating: item.rating,
                                                                    tmdb_genre_ids: item.genre_ids,
                                                                },
                                                            },
                                                        });
                                                    }}
                                                    className="aspect-[2/3] bg-[#1a1c22] rounded-md flex flex-col justify-end p-2 border border-white/5 cursor-pointer relative group overflow-hidden text-left"
                                                    title={recTitle}
                                                >
                                                    {poster && (
                                                        <img
                                                            src={poster}
                                                            alt={recTitle}
                                                            loading="lazy"
                                                            decoding="async"
                                                            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                                        />
                                                    )}
                                                    <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/25 to-transparent" />
                                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10">
                                                        <Play className="text-[#00dc41]" size={32} />
                                                    </div>
                                                    <div className="text-[12px] font-medium text-white group-hover:text-[#00dc41] transition relative z-20 line-clamp-2">{recTitle}</div>
                                                </button>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* ═══ EPISODE SIDEBAR (Right Panel) ═══ */}
                {isSeriesContent && (
                    <div className="w-full lg:w-[340px] xl:w-[380px] lg:min-w-[340px] bg-[#0f1014] flex flex-col max-h-[calc(100vh-72px)] lg:sticky lg:top-[72px] rounded-lg overflow-hidden border border-white/5">
                        {/* Top Tabs */}
                        <div className="flex px-4 pt-4 border-b border-white/5 gap-6">
                            <button className="text-[#00dc41] font-bold text-[16px] pb-3 border-b-2 border-[#00dc41] relative">
                                Episodes
                            </button>
                            <button className="text-gray-400 font-bold text-[16px] pb-3 hover:text-white transition">
                                Highlights
                            </button>
                        </div>

                        {/* Season Tabs */}
                        {uniqueSeasons.length > 1 && (
                            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 overflow-x-auto no-scrollbar">
                                {uniqueSeasons.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setActiveSeason(s)}
                                        className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition whitespace-nowrap ${activeSeason === s
                                            ? 'bg-white/10 text-white'
                                            : 'bg-transparent text-gray-500 hover:text-white'
                                            }`}
                                    >
                                        Season {s}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Episode Grid & List */}
                        <div className="flex-1 overflow-y-auto p-4 no-scrollbar bg-[#0f1014]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-[12px] text-gray-500 font-medium">Episodes {episodesToShow.length > 0 ? `1-${episodesToShow.length}` : '0'}</span>
                            </div>

                            {/* Episode Details List */}
                            <div className="mt-4 space-y-2">
                                {episodesToShow.map((video, idx) => {
                                    const epNum = video.episode || idx + 1;
                                    const epData = episodeData[`${video.season || 1}_${epNum}`];
                                    const thumb = usableEpisodeImage(epData?.still_path) || episodeFallbackThumb;
                                    const isActive = video === currentVideo;
                                    return (
                                        <div
                                            key={`detail-${idx}`}
                                            onClick={() => playEpisode(video)}
                                            className={`flex gap-3 p-2 rounded-lg cursor-pointer transition group ${isActive
                                                ? 'bg-[#00dc41]/10 border border-[#00dc41]/30'
                                                : 'hover:bg-white/5 border border-transparent'
                                                }`}
                                        >
                                            {/* Thumbnail */}
                                            <div className="w-28 aspect-video rounded-md overflow-hidden bg-[#1a1c22] flex-shrink-0 relative">
                                                {thumb ? (
                                                    <img
                                                        src={thumb}
                                                        alt=""
                                                        loading={idx < 8 ? 'eager' : 'lazy'}
                                                        fetchPriority={idx < 8 ? 'high' : 'auto'}
                                                        decoding="async"
                                                        className="w-full h-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-[#1a1c22]">
                                                        <Play size={16} className="text-gray-600" />
                                                    </div>
                                                )}
                                                {isActive && (
                                                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                                        <div className="w-2 h-2 bg-[#00dc41] rounded-full animate-pulse" />
                                                    </div>
                                                )}
                                                <div className="absolute bottom-1 left-1 bg-black/70 text-[9px] text-white font-bold px-1 py-0.5 rounded">
                                                    EP{epNum}
                                                </div>
                                            </div>
                                            {/* Info */}
                                            <div className="flex-1 min-w-0 py-0.5">
                                                <p className={`text-[12px] font-medium line-clamp-1 ${isActive ? 'text-[#00dc41]' : 'text-gray-300 group-hover:text-white'}`}>
                                                    {epData?.name || video.name || `Episode ${epNum}`}
                                                </p>
                                                {video.subtitle_path && (
                                                    <span className="text-[9px] text-gray-600 flex items-center gap-0.5 mt-1">
                                                        <Subtitles size={10} /> SUB
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <LoginModal
                isOpen={showLoginModal}
                onClose={() => setShowLoginModal(false)}
                onLoginSuccess={handleLoginSuccess}
            />
            <Footer />
        </div >
    );
};

export default WatchPage;
