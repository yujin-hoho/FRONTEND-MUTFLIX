import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Play, Pause, Volume2, VolumeX,
    Maximize, Minimize, Subtitles, Settings,
    SkipForward, SkipBack, ChevronDown, ChevronUp,
    User, Loader2, Languages
} from 'lucide-react';
import {
    fetchVideos, getStreamDetails, fetchSubtitle,
    getTMDBInfo, getTMDBCredits, getTMDBSeasonDetails, logout, TMDB_GENRES,
    fetchProfiles, createProfile, saveHistory, fetchHistory
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
import Hls from 'hls.js';

/** Stored delay: negative = tunda (subtitle lebih lambat), positive = percepat (lebih cepat). */
const SUB_DELAY_UI_CONVENTION = 'neg-is-delay';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space';
const LOCAL_RESUME_KEY = 'mutflix_resume_positions';

const getLocalResumeMap = () => {
    try {
        const raw = localStorage.getItem(LOCAL_RESUME_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
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
        localStorage.setItem(LOCAL_RESUME_KEY, JSON.stringify(map));
    } catch {
        // ignore local cache write failures
    }
};

const WatchPage = () => {
    const { folderName } = useParams();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const decodedName = decodeURIComponent(folderName);
    const urlType = searchParams.get('type');
    const urlEp = parseInt(searchParams.get('ep')) || 1;
    const urlSeason = parseInt(searchParams.get('s')) || 1;

    const toInt = (value, fallback) => {
        const n =
            value == null || value === '' ? NaN : typeof value === 'string' ? parseInt(value, 10) : Number(value);
        return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
    };

    // Data state
    const [videos, setVideos] = useState([]);
    const [tmdbData, setTmdbData] = useState(null);
    const [credits, setCredits] = useState(null);
    const [episodeData, setEpisodeData] = useState({});
    const [loading, setLoading] = useState(true);
    const [expandedDesc, setExpandedDesc] = useState(false);

    // Player state
    const [currentVideo, setCurrentVideo] = useState(null);
    const [subtitleUrl, setSubtitleUrl] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showControls, setShowControls] = useState(true);
    const [showSubtitles, setShowSubtitles] = useState(true);
    const [playbackRate, setPlaybackRate] = useState(1);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);
    /** Trek audio native dari file (multi-audio MP4/MOV); dukungan browser bervariasi (Chrome/Edge/Safari umumnya OK). */
    const [audioTrackList, setAudioTrackList] = useState([]);
    const [selectedAudioIndex, setSelectedAudioIndex] = useState(0);
    const [showAudioMenu, setShowAudioMenu] = useState(false);
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(null);
    const [activeSeason, setActiveSeason] = useState(urlSeason);
    const fetchedSeasonStillsRef = useRef(new Set());
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
                delayConvention: SUB_DELAY_UI_CONVENTION
            };
        } catch {
            return { ...defaults, delayConvention: SUB_DELAY_UI_CONVENTION };
        }
    });

    useEffect(() => {
        localStorage.setItem(
            'mutflix_sub_settings',
            JSON.stringify({ ...subSettings, delayConvention: SUB_DELAY_UI_CONVENTION })
        );
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
    const hlsInstanceRef = useRef(null);
    const playerContainerRef = useRef(null);
    const controlsTimeoutRef = useRef(null);
    const progressBarRef = useRef(null);
    const prevSubtitleUrl = useRef(null);
    const embeddedSubCleanupRef = useRef(null);
    const [resumeTime, setResumeTime] = useState(0);
    const hasSeekedRef = useRef(false);
    const [showResumeToast, setShowResumeToast] = useState(null);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [scrubTime, setScrubTime] = useState(0);

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
    const directorName = credits?.director || '';
    const castList = credits?.cast || [];
    const currentEpisodeNum = currentVideo?.episode || 1;
    const currentEpData = episodeData[`${currentVideo?.season || 1}_${currentEpisodeNum}`];
    const currentEpisodeName = currentEpData?.name || currentVideo?.name || `Episode ${currentEpisodeNum}`;
    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
    const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
    const episodeFallbackThumb = useMemo(() => {
        const raw =
            tmdbData?.backdrop_path ||
            tmdbData?.tmdb_backdrop_path ||
            tmdbData?.poster_path ||
            tmdbData?.tmdb_poster_path ||
            null;
        if (!raw) return null;
        if (raw.startsWith('http')) return raw;
        return `https://image.tmdb.org/t/p/w500${raw.startsWith('/') ? raw : `/${raw}`}`;
    }, [tmdbData]);

    // ─── Load Data ──────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        const loadData = async () => {
            setLoading(true);
            setEpisodeData({});
            setTmdbData(null);
            setCredits(null);
            fetchedSeasonStillsRef.current = new Set();
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

                const targetVideo = videosList.find(v =>
                    (v.season || 1) === urlSeason && (v.episode || 1) === urlEp
                ) || videosList[0];

                if (targetVideo) {
                    setCurrentVideo(targetVideo);
                    setActiveSeason(targetVideo.season || 1);
                }

                // Biarkan pemutar & stream mulai lebih dulu — kredit & still episode di background
                setLoading(false);

                // Background: TMDB metadata + credits.
                void (async () => {
                    try {
                        const inferredIsSeries =
                            urlType === 'series' ||
                            videosList.length > 1 ||
                            videosList.some((v) => toInt(v.season, 1) > 1);
                        const tmdb = await getTMDBInfo(decodedName, {
                            mediaType: inferredIsSeries ? 'tv' : (urlType === 'movie' ? 'movie' : undefined),
                        });
                        if (cancelled) return;
                        setTmdbData(tmdb);
                        if (tmdb?.tmdb_id) {
                            const creditsData = await getTMDBCredits(tmdb.tmdb_id, tmdb.media_type);
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
    }, [decodedName, urlType, urlSeason, urlEp]);

    // Lazy-load TMDB episode stills + episode names per season tab.
    useEffect(() => {
        if (!tmdbData?.tmdb_id) return;
        if (tmdbData?.media_type !== 'tv') return;
        if (!isSeriesContent) return;

        const seasonNum = toInt(activeSeason, 1);
        if (!Number.isFinite(seasonNum)) return;
        if (fetchedSeasonStillsRef.current.has(seasonNum)) return;

        void getTMDBSeasonDetails(tmdbData.tmdb_id, seasonNum)
            .then((sd) => {
                if (sd?.episodes) {
                    const dataMap = {};
                    sd.episodes.forEach((ep) => {
                        dataMap[`${seasonNum}_${ep.episode_number}`] = {
                            still_path: ep.still_path
                                ? `https://image.tmdb.org/t/p/w300${ep.still_path.startsWith('/') ? ep.still_path : `/${ep.still_path}`}`
                                : null,
                            name: ep.name
                        };
                    });
                    setEpisodeData((prev) => ({ ...prev, ...dataMap }));
                }
                fetchedSeasonStillsRef.current.add(seasonNum);
            })
            .catch(() => {
                fetchedSeasonStillsRef.current.add(seasonNum);
            });
    }, [tmdbData?.tmdb_id, activeSeason, isSeriesContent]);

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

    // ─── Save History logic ─────────────────────────
    const triggerSaveHistory = useCallback(async () => {
        if (!profileId || !currentVideo || !videoRef.current) return;

        const video = videoRef.current;
        if (!video.duration) return;

        const positionMs = Math.floor(video.currentTime * 1000);
        const durationMs = Math.floor(video.duration * 1000);
        // Fast local resume cache for instant seek on next open.
        setLocalResumeForPath(currentVideo.path, positionMs, durationMs);

        await saveHistory(
            profileId,
            currentVideo.path,
            currentVideo.name || decodedName,
            isSeriesContent ? decodedName : null,
            currentVideo.source,
            currentEpData?.still_path || tmdbData?.tmdb_poster_path,
            currentVideo.subtitle_path,
            positionMs,
            durationMs,
            isSeriesContent ? (currentVideo.season ?? null) : null,
            isSeriesContent ? (currentVideo.episode ?? null) : null
        );
    }, [profileId, currentVideo, decodedName, isSeriesContent, currentEpData, tmdbData]);

    // ─── Fetch Resume Position ─────────────────────
    useEffect(() => {
        if (!profileId || !currentVideo) return;

        // Instant local seek hint while remote history is loading.
        const localMap = getLocalResumeMap();
        const localEntry = localMap[currentVideo.path];
        if (localEntry && Number(localEntry.position_ms) >= 10000) {
            const p = Number(localEntry.position_ms);
            const d = Number(localEntry.duration_ms) || 0;
            const progress = d > 0 ? (p / d) * 100 : 0;
            if (progress < 95) setResumeTime(p / 1000);
            else setResumeTime(0);
        } else {
            setResumeTime(0);
        }

        const fetchResumePosition = async () => {
            const history = await fetchHistory(profileId);
            const entry = history.find(h => h.media_path === currentVideo.path);
            if (entry && entry.position_ms >= 10000) {
                const progress = (entry.position_ms / entry.duration_ms) * 100;
                if (progress < 95) {
                    setResumeTime(entry.position_ms / 1000);
                    setLocalResumeForPath(entry.media_path, entry.position_ms, entry.duration_ms);
                } else {
                    setResumeTime(0);
                }
            } else {
                setResumeTime(0);
            }
        };
        fetchResumePosition();
    }, [profileId, currentVideo]);

    // ─── Auto-Seek Logic ────────────────────────────
    useEffect(() => {
        // Reset seek tracker on video change
        hasSeekedRef.current = false;
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
    useEffect(() => {
        if (!currentVideo) return;
        let cancelled = false;

        const loadStream = async () => {
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
            setEmbeddedSubsAvailable(false);

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

                if (details?.url && videoRef.current) {
                    // Extract file ID from the GDrive URL
                    const urlMatch = details.url.match(/files\/([^?]+)/);
                    const fileId = urlMatch ? urlMatch[1] : null;
                    const token = (details.headers?.Authorization || '').replace('Bearer ', '');

                    if (fileId && token) {
                        if (hlsInstanceRef.current) {
                            hlsInstanceRef.current.destroy();
                            hlsInstanceRef.current = null;
                        }

                        const isHls = (currentVideo.original_name || currentVideo.name || '').toLowerCase().endsWith('.m3u8');

                        let proxyPath = `/gdrive-proxy/${fileId}?alt=media&access_token=${encodeURIComponent(token)}`;
                        if (isHls) {
                            proxyPath = `/api/hls-manifest/${fileId}?access_token=${encodeURIComponent(token)}`;
                        }

                        const proxyUrl = import.meta.env.DEV ? proxyPath : `${BASE_URL}${proxyPath}`;
                        console.log('[Player] Loading:', proxyUrl.replace(token, '...'));

                        if (isHls && Hls.isSupported()) {
                            const hls = new Hls({
                                maxBufferLength: 30,
                                enableWorker: true,
                            });
                            hlsInstanceRef.current = hls;
                            hls.loadSource(proxyUrl);
                            hls.attachMedia(videoRef.current);
                            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                                const playPromise = videoRef.current.play();
                                if (playPromise !== undefined) {
                                    playPromise.catch(e => {
                                        console.warn('Autoplay prevented:', e);
                                        try {
                                            if (videoRef.current) {
                                                videoRef.current.muted = true;
                                                setIsMuted(true);
                                                videoRef.current.play().catch(() => setVideoLoading(false));
                                            }
                                        } catch { setVideoLoading(false); }
                                    });
                                }
                            });
                            hls.on(Hls.Events.ERROR, function (event, data) {
                                if (data.fatal) {
                                    switch (data.type) {
                                        case Hls.ErrorTypes.NETWORK_ERROR:
                                            hls.startLoad();
                                            break;
                                        case Hls.ErrorTypes.MEDIA_ERROR:
                                            hls.recoverMediaError();
                                            break;
                                        default:
                                            hls.destroy();
                                            setVideoError('HLS Error: ' + data.details);
                                            break;
                                    }
                                }
                            });
                        } else {
                            // Standard playback / Safari native HLS
                            videoRef.current.src = proxyUrl;
                            const playPromise = videoRef.current.play();
                            if (playPromise !== undefined) {
                                playPromise.catch(e => {
                                    console.warn('Autoplay prevented by browser:', e);
                                    try {
                                        if (videoRef.current) {
                                            videoRef.current.muted = true;
                                            setIsMuted(true);
                                            videoRef.current.play().catch(() => setVideoLoading(false));
                                        }
                                    } catch { setVideoLoading(false); }
                                });
                            }
                        }
                    } else {
                        setVideoError('Invalid video URL or token');
                    }
                } else {
                    setVideoError('Could not load video stream');
                }
            } catch (e) {
                console.error('[Player] Stream load error:', e);
                if (!cancelled) setVideoError('Error loading video');
            }

            if (!cancelled) setVideoLoading(false);
        };
        loadStream();

        return () => { cancelled = true; };
    }, [currentVideo]);

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

    const hasSubtitleSource = !!(subtitleUrl || embeddedSubsAvailable);
    const syncDelayAppliesToExternalFile = !!subtitleUrl;

    /** Sembunyikan cursor seperti Netflix/YouTube saat UI sudah auto-hide (bukan saat menu terbuka / buffering). */
    const hidePlayerCursor =
        isPlaying &&
        !showControls &&
        !videoLoading &&
        !videoError &&
        !isScrubbing &&
        !showSubSettings &&
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
            if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
            if (prevSubtitleUrl.current) revokeSubtitleBlobUrl(prevSubtitleUrl.current);
            if (hlsInstanceRef.current) hlsInstanceRef.current.destroy();
        };
    }, []);

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
                    setVolume(v => { const nv = Math.min(1, v + 0.1); video.volume = nv; return nv; });
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    setVolume(v => { const nv = Math.max(0, v - 0.1); video.volume = nv; return nv; });
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
                    setShowSpeedMenu(false);
                    break;
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [isPlaying]);

    // ─── Player controls ───────────────────────────
    const handleVideoClick = () => {
        if (showSubSettings) setShowSubSettings(false);
        if (showSpeedMenu) setShowSpeedMenu(false);
        setShowControls(false); // hide UI instead of pausing
    };

    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            video.play().catch(() => { });
        } else {
            video.pause();
            triggerSaveHistory();
        }
    };

    const toggleMute = () => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = !video.muted;
        setIsMuted(video.muted);
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
        video.currentTime = pos * video.duration;
    };

    const commitScrub = useCallback(() => {
        const video = videoRef.current;
        if (!video || !duration) return;
        const clamped = Math.max(0, Math.min(scrubTime, duration));
        if (Math.abs((video.currentTime || 0) - clamped) > 0.05) {
            video.currentTime = clamped;
        }
        setCurrentTime(clamped);
        setIsScrubbing(false);
    }, [scrubTime, duration]);

    const changePlaybackRate = (rate) => {
        const video = videoRef.current;
        if (video) video.playbackRate = rate;
        setPlaybackRate(rate);
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
        setCurrentTime(video.currentTime);
        if (video.buffered.length > 0) {
            setBuffered(video.buffered.end(video.buffered.length - 1));
        }
    };

    /** `progress` lebih sering daripada `timeupdate` — bar buffer lebih akurat saat unduhan jauh di depan playhead. */
    const handleBufferProgress = () => {
        const video = videoRef.current;
        if (!video || video.buffered.length === 0) return;
        setBuffered(video.buffered.end(video.buffered.length - 1));
    };

    const handleVideoPlay = () => setIsPlaying(true);
    const handleVideoPause = () => setIsPlaying(false);
    const handleLoadedMetadata = () => {
        const video = videoRef.current;
        if (video) {
            setDuration(video.duration);
        }
        syncAudioTracksFromVideo();
    };
    const handleVideoError = () => {
        const video = videoRef.current;
        // Ignore errors when no source is loaded yet
        if (!video || !video.src || video.src === window.location.href) return;
        const err = video.error;
        console.error('Video error:', err?.code, err?.message);
        setVideoError(`Playback error${err?.message ? ': ' + err.message : ''}. Try refreshing.`);
    };
    const handleWaiting = () => setVideoLoading(true);
    const handlePlaying = () => setVideoLoading(false);
    const handleCanPlay = () => {
        setVideoLoading(false);
        // If the browser natively paused it despite autoPlay (e.g. low power mode), we can try one more time securely.
        const video = videoRef.current;
        if (video && video.paused && !isPlaying) {
            video.play().catch(() => { });
        }
        syncAudioTracksFromVideo();
        requestAnimationFrame(() => syncAudioTracksFromVideo());
        setTimeout(syncAudioTracksFromVideo, 150);
    };

    // ─── Episode switching ─────────────────────────
    const playEpisode = (video) => {
        if (video === currentVideo) return;
        setCurrentVideo(video);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        // Update URL without full navigation
        const newParams = new URLSearchParams(searchParams);
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
                            onProgress={handleBufferProgress}
                            onPlay={handleVideoPlay}
                            onPause={handleVideoPause}
                            onPlaying={handlePlaying}
                            onLoadedMetadata={handleLoadedMetadata}
                            onLoadedData={() => {
                                setVideoLoading(false);
                                syncAudioTracksFromVideo();
                            }}
                            onError={handleVideoError}
                            onWaiting={handleWaiting}
                            onCanPlay={handleCanPlay}
                            onCanPlayThrough={() => setVideoLoading(false)}
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
                                    return (
                                        <div
                                            key={i}
                                            className="text-center px-4 py-1 rounded"
                                            style={{
                                                fontSize: `${subSettings.fontSize}px`,
                                                fontFamily: subSettings.fontFamily,
                                                color: '#ffffff',
                                                textShadow: subSettings.textShadow,
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
                                        onClick={() => { setVideoError(null); setCurrentVideo({ ...currentVideo }); }}
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
                                {title}
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
                                            <button
                                                onClick={() => setShowSubSettings(!showSubSettings)}
                                                className={`p-1 transition ${showSubSettings ? 'text-[#00dc41]' : 'text-white/50 hover:text-white'}`}
                                            >
                                                <Settings size={14} />
                                            </button>

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

                                                {/* Outline / Text Shadow */}
                                                <div className="mb-1">
                                                    <div className="text-[11px] text-gray-500 mb-1">Outline Style</div>
                                                    <select
                                                        value={subSettings.textShadow}
                                                        onChange={(e) => setSubSettings({ ...subSettings, textShadow: e.target.value })}
                                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] text-white outline-none focus:border-[#00dc41]"
                                                    >
                                                        <option value="2px 2px 4px rgba(0,0,0,0.8)">Drop Shadow</option>
                                                        <option value="-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000">Hard Outline</option>
                                                        <option value="none">None</option>
                                                    </select>
                                                </div>
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
                                                    setVolume(v);
                                                    if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
                                                    setIsMuted(v === 0);
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

                        {/* More Like This (Placeholder) */}
                        <div className="mt-8 mb-8 border-t border-white/5 pt-8">
                            <h3 className="text-white text-[18px] font-bold mb-4">More Like This</h3>
                            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {[1, 2, 3, 4, 5, 6].map(i => (
                                    <div key={i} className="aspect-[2/3] bg-[#1a1c22] rounded-md flex flex-col justify-end p-2 border border-white/5 cursor-pointer relative group overflow-hidden">
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10">
                                            <Play className="text-[#00dc41]" size={32} />
                                        </div>
                                        <div className="text-[12px] font-medium text-gray-500 group-hover:text-white transition relative z-20 truncate">Recommended {i}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
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
                                    const thumb = epData?.still_path || episodeFallbackThumb;
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
                                                        loading="lazy"
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