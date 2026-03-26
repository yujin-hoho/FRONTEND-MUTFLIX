import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
    ArrowLeft, Play, Pause, Volume2, VolumeX,
    Maximize, Minimize, Subtitles, Settings,
    SkipForward, SkipBack, ChevronDown, ChevronUp,
    User, Loader2
} from 'lucide-react';
import {
    fetchVideos, getStreamDetails, fetchSubtitle,
    getTMDBInfo, getTMDBCredits, getTMDBSeasonDetails
} from '../services/api';
import { createSubtitleBlobUrl, revokeSubtitleBlobUrl } from '../utils/subtitleParser';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://melancholia112-mutflix.hf.space';

const WatchPage = () => {
    const { folderName } = useParams();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const decodedName = decodeURIComponent(folderName);
    const urlType = searchParams.get('type');
    const urlEp = parseInt(searchParams.get('ep')) || 1;
    const urlSeason = parseInt(searchParams.get('s')) || 1;

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
    const [videoLoading, setVideoLoading] = useState(false);
    const [videoError, setVideoError] = useState(null);
    const [activeSeason, setActiveSeason] = useState(urlSeason);

    // Refs
    const videoRef = useRef(null);
    const playerContainerRef = useRef(null);
    const controlsTimeoutRef = useRef(null);
    const progressBarRef = useRef(null);
    const prevSubtitleUrl = useRef(null);

    // Derived
    const isSeriesContent = urlType === 'series' ||
        (tmdbData?.media_type === 'tv') ||
        (!urlType && videos.length > 1);

    const uniqueSeasons = [...new Set(videos.map(v => v.season || 1))].sort((a, b) => a - b);
    const filteredEpisodes = videos.filter(v => (v.season || 1) === activeSeason);

    // ─── Load Data ──────────────────────────────────
    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            const [videosResp, tmdb] = await Promise.all([
                fetchVideos(decodedName),
                getTMDBInfo(decodedName)
            ]);

            const videosList = videosResp?.videos || [];
            videosList.sort((a, b) => {
                if (a.season !== b.season) return (a.season || 1) - (b.season || 1);
                return (a.episode || 0) - (b.episode || 0);
            });

            setVideos(videosList);
            setTmdbData(tmdb);

            if (tmdb?.tmdb_id) {
                const creditsData = await getTMDBCredits(tmdb.tmdb_id, tmdb.media_type);
                setCredits(creditsData);

                if (urlType === 'series' || tmdb.media_type === 'tv' || videosList.length > 1) {
                    const seasons = [...new Set(videosList.map(v => v.season || 1))];
                    const seasonPromises = seasons.map(s => getTMDBSeasonDetails(tmdb.tmdb_id, s));
                    const seasonsData = await Promise.all(seasonPromises);
                    const dataMap = {};
                    seasonsData.forEach((sd, idx) => {
                        if (sd?.episodes) {
                            sd.episodes.forEach(ep => {
                                dataMap[`${seasons[idx]}_${ep.episode_number}`] = {
                                    still_path: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
                                    name: ep.name
                                };
                            });
                        }
                    });
                    setEpisodeData(dataMap);
                }
            }

            // Auto-select episode
            const targetVideo = videosList.find(v =>
                (v.season || 1) === urlSeason && (v.episode || 1) === urlEp
            ) || videosList[0];

            if (targetVideo) {
                setCurrentVideo(targetVideo);
                setActiveSeason(targetVideo.season || 1);
            }

            setLoading(false);
        };
        loadData();
    }, [decodedName, urlType]);

    // ─── Load Stream when currentVideo changes ──────
    useEffect(() => {
        if (!currentVideo) return;
        let cancelled = false;

        const loadStream = async () => {
            setVideoLoading(true);
            setVideoError(null);

            // Revoke old subtitle blob URL
            if (prevSubtitleUrl.current) {
                revokeSubtitleBlobUrl(prevSubtitleUrl.current);
                prevSubtitleUrl.current = null;
            }
            setSubtitleUrl(null);

            // ── Load video stream ──
            try {
                const details = await getStreamDetails(currentVideo.path);
                if (cancelled) return;

                if (details?.url && videoRef.current) {
                    // Extract file ID from the GDrive URL
                    const urlMatch = details.url.match(/files\/([^?]+)/);
                    const fileId = urlMatch ? urlMatch[1] : null;
                    const token = (details.headers?.Authorization || '').replace('Bearer ', '');

                    if (fileId && token) {
                        // Use proxy: /gdrive-proxy/{fileId}?alt=media&access_token={token}
                        // Dev: Vite proxy forwards to googleapis.com server-side (no CORS)
                        // Prod: Flask handles this route (on HF Space)
                        // The access_token is passed as URL param so the <video> element
                        // can stream without custom headers (supports Range/seeking).
                        const proxyPath = `/gdrive-proxy/${fileId}?alt=media&access_token=${encodeURIComponent(token)}`;
                        const proxyUrl = import.meta.env.DEV ? proxyPath : `${BASE_URL}${proxyPath}`;

                        console.log('[Player] Loading via proxy:', import.meta.env.DEV ? proxyPath.replace(token, '...') : `${BASE_URL}/gdrive-proxy/${fileId}?alt=media&access_token=...`);
                        videoRef.current.src = proxyUrl;
                        videoRef.current.load();
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

            // ── Load subtitles ──
            if (currentVideo.subtitle_path) {
                try {
                    const subText = await fetchSubtitle(currentVideo.subtitle_path);
                    if (!cancelled && subText) {
                        const blobUrl = createSubtitleBlobUrl(subText);
                        setSubtitleUrl(blobUrl);
                        prevSubtitleUrl.current = blobUrl;
                    }
                } catch (e) {
                    console.warn('Subtitle load failed:', e);
                }
            }

            if (!cancelled) setVideoLoading(false);
        };
        loadStream();

        return () => { cancelled = true; };
    }, [currentVideo]);

    // ─── Subtitle track management ──────────────────
    useEffect(() => {
        if (!videoRef.current) return;
        const video = videoRef.current;

        // Remove existing tracks
        const existingTracks = video.querySelectorAll('track');
        existingTracks.forEach(t => t.remove());

        if (subtitleUrl && showSubtitles) {
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = 'Subtitles';
            track.srclang = 'id';
            track.src = subtitleUrl;
            track.default = true;
            video.appendChild(track);

            // Force show the track
            setTimeout(() => {
                if (video.textTracks.length > 0) {
                    video.textTracks[0].mode = 'showing';
                }
            }, 100);
        }
    }, [subtitleUrl, showSubtitles]);

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
    const togglePlay = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) {
            video.play().catch(() => { });
        } else {
            video.pause();
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

    const changePlaybackRate = (rate) => {
        const video = videoRef.current;
        if (video) video.playbackRate = rate;
        setPlaybackRate(rate);
        setShowSpeedMenu(false);
    };

    // ─── Video event handlers ──────────────────────
    const handleTimeUpdate = () => {
        const video = videoRef.current;
        if (!video) return;
        setCurrentTime(video.currentTime);
        if (video.buffered.length > 0) {
            setBuffered(video.buffered.end(video.buffered.length - 1));
        }
    };

    const handleVideoPlay = () => setIsPlaying(true);
    const handleVideoPause = () => setIsPlaying(false);
    const handleLoadedMetadata = () => {
        const video = videoRef.current;
        if (video) {
            setDuration(video.duration);
            setVideoLoading(false);
        }
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
    const handleCanPlay = () => setVideoLoading(false);

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
        const currentIdx = videos.findIndex(v => v === currentVideo);
        if (currentIdx < videos.length - 1) {
            playEpisode(videos[currentIdx + 1]);
        }
    };

    const playPrevEpisode = () => {
        if (!currentVideo) return;
        const currentIdx = videos.findIndex(v => v === currentVideo);
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

    // ─── Derived values ────────────────────────────
    const title = decodedName;
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

    // ─── Loading state ─────────────────────────────
    if (loading) {
        return (
            <div className="min-h-screen bg-[#0a0b0f] flex flex-col items-center justify-center">
                <div className="w-14 h-14 border-4 border-[#00dc41] border-t-transparent rounded-full animate-spin mb-6 mt-[-10vh] shadow-[0_0_15px_rgba(0,220,65,0.3)]"></div>
                <div className="text-[#00dc41] font-black text-2xl tracking-[0.2em] animate-pulse">MUTFLIX</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0a0b0f] text-white font-sans">
            {/* ═══════ TOP BAR ═══════ */}
            <div className="bg-[#0a0b0f]/90 backdrop-blur-md border-b border-white/5 px-4 py-2.5 flex items-center gap-3 sticky top-0 z-50">
                <button
                    onClick={() => navigate(-1)}
                    className="text-gray-400 hover:text-white transition p-1.5 rounded-lg hover:bg-white/10"
                >
                    <ArrowLeft size={20} />
                </button>
                <div className="flex-1 min-w-0">
                    <h1 className="text-[15px] font-semibold text-white truncate">{title}</h1>
                    {isSeriesContent && (
                        <p className="text-[12px] text-gray-500 truncate">
                            Season {currentVideo?.season || 1} · Episode {currentEpisodeNum} · {currentEpisodeName}
                        </p>
                    )}
                </div>
            </div>

            {/* ═══════ MAIN CONTENT: Video + Sidebar ═══════ */}
            <div className="flex flex-col lg:flex-row">

                {/* ═══ VIDEO PLAYER ═══ */}
                <div className="flex-1 min-w-0">
                    <div
                        ref={playerContainerRef}
                        className={`relative bg-black group ${isFullscreen ? 'fixed inset-0 z-[9999]' : 'aspect-video w-full'}`}
                        onMouseMove={resetControlsTimeout}
                        onMouseLeave={() => { if (isPlaying) setShowControls(false); }}
                    >
                        {/* Video Element */}
                        <video
                            ref={videoRef}
                            className="w-full h-full object-contain bg-black"
                            onTimeUpdate={handleTimeUpdate}
                            onPlay={handleVideoPlay}
                            onPause={handleVideoPause}
                            onLoadedMetadata={handleLoadedMetadata}
                            onError={handleVideoError}
                            onWaiting={handleWaiting}
                            onCanPlay={handleCanPlay}
                            onEnded={playNextEpisode}
                            onClick={togglePlay}
                            playsInline
                        />

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
                        <div className={`absolute bottom-0 left-0 right-0 transition-all duration-300 ${showControls || !isPlaying ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
                            {/* Gradient backdrop */}
                            <div className="bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 pb-3 px-4">

                                {/* Progress Bar */}
                                <div
                                    ref={progressBarRef}
                                    className="relative h-1.5 bg-white/20 rounded-full cursor-pointer group/progress mb-3 hover:h-2.5 transition-all"
                                    onClick={handleProgressClick}
                                >
                                    {/* Buffered */}
                                    <div
                                        className="absolute top-0 left-0 h-full bg-white/20 rounded-full"
                                        style={{ width: `${bufferedPercent}%` }}
                                    />
                                    {/* Progress */}
                                    <div
                                        className="absolute top-0 left-0 h-full bg-[#00dc41] rounded-full transition-[width] duration-100"
                                        style={{ width: `${progressPercent}%` }}
                                    />
                                    {/* Thumb */}
                                    <div
                                        className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-[#00dc41] rounded-full shadow-[0_0_8px_rgba(0,220,65,0.5)] opacity-0 group-hover/progress:opacity-100 transition"
                                        style={{ left: `calc(${progressPercent}% - 7px)` }}
                                    />
                                </div>

                                {/* Controls Row */}
                                <div className="flex items-center gap-2">
                                    {/* Left controls */}
                                    <button onClick={togglePlay} className="text-white hover:text-[#00dc41] transition p-1">
                                        {isPlaying ? <Pause size={22} /> : <Play size={22} fill="white" />}
                                    </button>

                                    <button onClick={playPrevEpisode} className="text-white/70 hover:text-white transition p-1" title="Previous">
                                        <SkipBack size={18} />
                                    </button>
                                    <button onClick={playNextEpisode} className="text-white/70 hover:text-white transition p-1" title="Next">
                                        <SkipForward size={18} />
                                    </button>

                                    {/* Volume */}
                                    <div className="flex items-center gap-1 group/vol">
                                        <button onClick={toggleMute} className="text-white/70 hover:text-white transition p-1">
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
                                            className="w-0 group-hover/vol:w-20 transition-all duration-300 accent-[#00dc41] h-1 cursor-pointer opacity-0 group-hover/vol:opacity-100"
                                        />
                                    </div>

                                    {/* Time display */}
                                    <span className="text-[12px] text-gray-300 font-mono ml-1 select-none">
                                        {formatTime(currentTime)} / {formatTime(duration)}
                                    </span>

                                    {/* Spacer */}
                                    <div className="flex-1" />

                                    {/* Right controls */}

                                    {/* Speed */}
                                    <div className="relative">
                                        <button
                                            onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                                            className="text-white/70 hover:text-white transition p-1 text-[12px] font-bold min-w-[32px]"
                                        >
                                            {playbackRate}x
                                        </button>
                                        {showSpeedMenu && (
                                            <div className="absolute bottom-full right-0 mb-2 bg-[#1a1c22]/95 backdrop-blur-md rounded-lg border border-white/10 py-1 shadow-xl min-w-[80px]">
                                                {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                                                    <button
                                                        key={rate}
                                                        onClick={() => changePlaybackRate(rate)}
                                                        className={`block w-full text-left px-3 py-1.5 text-[12px] transition ${playbackRate === rate
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

                                    {/* Subtitles toggle */}
                                    <button
                                        onClick={() => setShowSubtitles(!showSubtitles)}
                                        className={`transition p-1 ${showSubtitles && subtitleUrl ? 'text-[#00dc41]' : 'text-white/40 hover:text-white/70'}`}
                                        title={subtitleUrl ? (showSubtitles ? 'Hide Subtitles' : 'Show Subtitles') : 'No subtitles'}
                                    >
                                        <Subtitles size={18} />
                                    </button>

                                    {/* Fullscreen */}
                                    <button onClick={toggleFullscreen} className="text-white/70 hover:text-white transition p-1">
                                        {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ═══ CONTENT DETAILS (Below Player) ═══ */}
                    <div className="px-4 md:px-8 py-6">
                        {/* Title + Episode */}
                        <div className="mb-4">
                            <h2 className="text-xl md:text-2xl font-bold text-white mb-1">
                                {title}
                                {isSeriesContent && (
                                    <span className="text-gray-400 font-normal text-lg"> › Episode {currentEpisodeNum}</span>
                                )}
                            </h2>
                            {isSeriesContent && currentEpisodeName && (
                                <p className="text-[14px] text-gray-400">{currentEpisodeName}</p>
                            )}
                        </div>

                        {/* Meta Row */}
                        <div className="flex items-center gap-2 text-sm text-gray-400 mb-4 flex-wrap">
                            {rating > 0 && (
                                <>
                                    <span className="text-[#00dc41] font-bold">★ {Number(rating).toFixed(1)}</span>
                                    <span className="text-gray-600">|</span>
                                </>
                            )}
                            {year && (
                                <>
                                    <span>{year}</span>
                                    <span className="text-gray-600">|</span>
                                </>
                            )}
                            {isSeriesContent && (
                                <span>{videos.length} Episodes</span>
                            )}
                            {directorName && (
                                <>
                                    <span className="text-gray-600">|</span>
                                    <span>Dir: {directorName}</span>
                                </>
                            )}
                        </div>

                        {/* Description */}
                        {overview && (
                            <div className="mb-6">
                                <p className={`text-gray-400 text-[13px] leading-relaxed ${expandedDesc ? '' : 'line-clamp-3'}`}>
                                    {overview}
                                </p>
                                <button
                                    onClick={() => setExpandedDesc(!expandedDesc)}
                                    className="text-[#00dc41] text-[12px] font-medium mt-1 flex items-center gap-0.5 hover:brightness-125 transition"
                                >
                                    {expandedDesc ? 'Less' : 'More'} {expandedDesc ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                </button>
                            </div>
                        )}

                        {/* Cast */}
                        {castList.length > 0 && (
                            <div>
                                <h3 className="text-gray-400 text-sm font-medium mb-4">Cast</h3>
                                <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                                    {castList.slice(0, 12).map(member => (
                                        <div key={member.id} className="flex flex-col items-center flex-shrink-0 group cursor-pointer">
                                            <div className="w-16 h-16 md:w-20 md:h-20 rounded-full overflow-hidden bg-[#1a1c22] mb-1.5 border-2 border-transparent group-hover:border-[#00dc41]/40 transition-all">
                                                {member.profile_path ? (
                                                    <img src={member.profile_path} alt={member.name} className="w-full h-full object-cover" />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center bg-[#22252b]">
                                                        <User size={24} className="text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-gray-300 text-center line-clamp-1 w-16 md:w-20 group-hover:text-[#00dc41] transition">{member.name}</p>
                                            {member.character && (
                                                <p className="text-[9px] text-gray-600 text-center line-clamp-1 w-16 md:w-20">{member.character}</p>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* ═══ EPISODE SIDEBAR (Right Panel) ═══ */}
                {isSeriesContent && (
                    <div className="w-full lg:w-[340px] xl:w-[380px] lg:min-w-[340px] bg-[#111319] border-t lg:border-t-0 lg:border-l border-white/5 flex flex-col max-h-[calc(100vh-52px)] lg:sticky lg:top-[52px]">
                        {/* Sidebar Header */}
                        <div className="p-4 border-b border-white/5">
                            <h3 className="text-[15px] font-bold text-white mb-1 truncate">{title}</h3>
                            <div className="flex items-center gap-2">
                                <div className="flex items-center gap-1">
                                    <span className="text-[11px] text-[#00dc41] font-semibold">Episodes</span>
                                </div>
                            </div>
                        </div>

                        {/* Season Tabs */}
                        {uniqueSeasons.length > 1 && (
                            <div className="flex items-center gap-1 px-4 py-2 border-b border-white/5 overflow-x-auto no-scrollbar">
                                {uniqueSeasons.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setActiveSeason(s)}
                                        className={`px-3 py-1 rounded-md text-[12px] font-medium transition whitespace-nowrap ${activeSeason === s
                                            ? 'bg-[#00dc41] text-black'
                                            : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                                            }`}
                                    >
                                        Season {s}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Episode count */}
                        <div className="px-4 py-2 text-[12px] text-gray-500">
                            Episodes {filteredEpisodes.length > 0 ? `1-${filteredEpisodes.length}` : '0'}
                        </div>

                        {/* Episode Grid */}
                        <div className="flex-1 overflow-y-auto px-4 pb-4 no-scrollbar">
                            <div className="grid grid-cols-5 gap-2">
                                {filteredEpisodes.map((video, idx) => {
                                    const epNum = video.episode || idx + 1;
                                    const isActive = video === currentVideo;
                                    return (
                                        <button
                                            key={idx}
                                            onClick={() => playEpisode(video)}
                                            className={`aspect-square rounded-lg text-[14px] font-bold transition-all flex items-center justify-center ${isActive
                                                ? 'bg-[#00dc41] text-black shadow-[0_0_12px_rgba(0,220,65,0.3)]'
                                                : 'bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white border border-white/5 hover:border-white/15'
                                                }`}
                                        >
                                            {epNum}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Episode Details List (below the grid) */}
                            <div className="mt-4 space-y-2">
                                {filteredEpisodes.map((video, idx) => {
                                    const epNum = video.episode || idx + 1;
                                    const epData = episodeData[`${video.season || 1}_${epNum}`];
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
                                                {epData?.still_path ? (
                                                    <img src={epData.still_path} alt="" className="w-full h-full object-cover" />
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
        </div>
    );
};

export default WatchPage;
