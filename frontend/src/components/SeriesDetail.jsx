import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

// API Helper
const getApiUrl = (path) => {
  const { hostname, port } = window.location;
  if (hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
    if (port === '8000') {
      return path;
    }
    return `https://melancholia112-mutflix.hf.space${path}`;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

const getPosterUrl = (path, size = 'w500') => {
  if (!path) return null;
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return getApiUrl(`/api/tmdb-image/${size}/${cleanPath}`);
};

// Custom Video Player component
function VideoPlayer({ playingVideo, videoStreamDetails, onClose, onTimeUpdate, continueWatching, getApiUrl }) {
  const videoRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  useEffect(() => {
    let timeoutId;
    const handleMouseMove = () => {
      setShowControls(true);
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (isPlaying) {
          setShowControls(false);
        }
      }, 3000);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearTimeout(timeoutId);
    };
  }, [isPlaying]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(err => console.warn(err));
    } else {
      video.pause();
    }
  };

  const handleSeekChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const val = parseFloat(e.target.value);
    video.currentTime = val;
    setCurrentTime(val);
  };

  const handleVolumeChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const val = parseFloat(e.target.value);
    video.volume = val;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => console.warn(err));
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const formatTime = (secs) => {
    if (isNaN(secs)) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) {
      return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration);
    
    const hist = continueWatching.find(h => h.media_path === playingVideo.path);
    if (hist && hist.position_ms) {
      const resumeTime = hist.position_ms / 1000;
      if (resumeTime < (video.duration - 10)) {
        video.currentTime = resumeTime;
      }
    }
    video.play().catch(err => console.warn(err));
  };

  return (
    <div 
      ref={containerRef}
      className={`fixed inset-0 z-[60] bg-black flex items-center justify-center overflow-hidden ${
        showControls ? 'cursor-default' : 'cursor-none'
      }`}
    >
      {!videoStreamDetails ? (
        <div className="flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-slate-400 font-bold tracking-wide">Preparing stream...</span>
        </div>
      ) : (
        <div className="relative w-full h-full">
          <video
            ref={videoRef}
            src={videoStreamDetails.stream_url ? (videoStreamDetails.stream_url.startsWith('http') ? videoStreamDetails.stream_url : getApiUrl(videoStreamDetails.stream_url)) : ''}
            className="w-full h-full object-contain"
            crossOrigin="anonymous"
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={(e) => {
              setCurrentTime(e.currentTarget.currentTime);
              onTimeUpdate(e);
            }}
            onLoadedMetadata={handleLoadedMetadata}
            onClick={togglePlay}
          >
            {playingVideo.subtitle_path && (
              <track
                kind="subtitles"
                src={playingVideo.subtitle_path.startsWith('http') ? playingVideo.subtitle_path : getApiUrl(playingVideo.subtitle_path)}
                srcLang="id"
                label="Indonesian"
                default
              />
            )}
          </video>

          {/* Controls Overlay */}
          <div 
            className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/60 flex flex-col justify-between p-6 transition-opacity duration-300 ${
              showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {/* Top Bar */}
            <div className="flex items-center justify-between">
              <button 
                onClick={onClose}
                className="flex items-center gap-2 bg-slate-900/60 hover:bg-slate-800/80 text-white px-4 py-2 rounded-xl transition-all outline-none"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                </svg>
                <span className="font-semibold text-sm">Back</span>
              </button>
              <div className="text-center font-bold text-white text-sm sm:text-base tracking-wide truncate max-w-[60%]">
                {playingVideo.name}
              </div>
              <div className="w-14"></div>
            </div>

            {/* Center big play/pause button */}
            <div 
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              onClick={togglePlay}
            >
              <button className={`w-20 h-20 bg-green-600/90 text-white rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shadow-lg shadow-green-950/20 pointer-events-auto ${showControls ? 'opacity-100' : 'opacity-0'}`}>
                {isPlaying ? (
                  <svg className="w-10 h-10 fill-current" viewBox="0 0 24 24">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg className="w-10 h-10 fill-current translate-x-0.5" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            </div>

            {/* Bottom Controls Bar */}
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <span className="text-xs text-slate-300 font-mono select-none">{formatTime(currentTime)}</span>
                <input 
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={handleSeekChange}
                  className="flex-1 accent-green-500 h-1.5 rounded-lg appearance-none bg-slate-700/80 cursor-pointer outline-none transition-all hover:h-2"
                />
                <span className="text-xs text-slate-300 font-mono select-none">{formatTime(duration)}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={togglePlay}
                    className="text-white hover:text-green-400 transition-colors p-1"
                  >
                    {isPlaying ? (
                      <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  <div className="flex items-center gap-2 group/volume">
                    <button 
                      onClick={toggleMute}
                      className="text-white hover:text-green-400 transition-colors p-1"
                    >
                      {isMuted ? (
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                        </svg>
                      ) : volume < 0.5 ? (
                        <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                          <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                        </svg>
                      ) : (
                        <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                          <path d="M3 9v6h4l5 5V4L9 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                        </svg>
                      )}
                    </button>
                    <input 
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      className="w-0 group-hover/volume:w-20 transition-all accent-green-500 h-1 rounded-lg appearance-none bg-slate-700/80 cursor-pointer outline-none"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <button 
                    onClick={toggleFullscreen}
                    className="text-white hover:text-green-400 transition-colors p-1"
                  >
                    {isFullscreen ? (
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    ) : (
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V6a2 2 0 012-2h2M3 16v2a2 2 0 002 2h2m10-16h2a2 2 0 012 2v2m-4 14h2a2 2 0 002-2v-2" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SeriesDetail({ session, activeProfile }) {
  const { state } = useLocation();
  const { id } = useParams();
  const navigate = useNavigate();

  const [selectedItem, setSelectedItem] = useState(state?.item || null);
  const [selectedItemVideos, setSelectedItemVideos] = useState([]);
  const [isVideosLoading, setIsVideosLoading] = useState(false);
  const [playingVideo, setPlayingVideo] = useState(null);
  const [videoStreamDetails, setVideoStreamDetails] = useState(null);
  const [continueWatching, setContinueWatching] = useState([]);
  const [activeSeason, setActiveSeason] = useState(1);
  const [tmdbId, setTmdbId] = useState(null);
  const [tmdbEpisodeMap, setTmdbEpisodeMap] = useState({});
  const [tmdbServerMeta, setTmdbServerMeta] = useState(null);
  const [isTmdbMetaLoading, setIsTmdbMetaLoading] = useState(true);
  const [tmdbMetaError, setTmdbMetaError] = useState(null);

  useEffect(() => {
    if (!selectedItem && id) {
      const cached = localStorage.getItem('mutflix_catalog_cache_v2');
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          const allItems = [...(parsed.data.movies || []), ...(parsed.data.series || [])];
          const found = allItems.find(item => item.name === id || encodeURIComponent(item.name) === id);
          if (found) {
            setSelectedItem(found);
          } else {
            navigate('/dashboard', { replace: true });
          }
        } catch(e) {
           navigate('/dashboard', { replace: true });
        }
      } else {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [id, selectedItem, navigate]);

  const fetchWatchHistory = async () => {
    if (!activeProfile || !activeProfile.id) return;
    try {
      const response = await fetch(getApiUrl(`/api/history/get/${activeProfile.id}`), {
        headers: { 'x-access-token': session.token }
      });
      if (response.ok) {
        const data = await response.json();
        setContinueWatching(Array.isArray(data) ? data : []);
      }
    } catch (err) {}
  };

  useEffect(() => {
    fetchWatchHistory();
  }, [activeProfile]);

  useEffect(() => {
    const fetchVideos = async () => {
      if (!selectedItem) return;
      setIsVideosLoading(true);
      try {
        const decodedId = id ? decodeURIComponent(id) : '';
        const candidates = [
          selectedItem.source,
          selectedItem.path,
          `gdrive_folder/${selectedItem.name}`,
          selectedItem.name,
          decodedId && `gdrive_folder/${decodedId}`,
          decodedId
        ].filter(Boolean);

        let resolvedVideos = [];
        for (const candidate of candidates) {
          const response = await fetch(getApiUrl(`/api/videos/${encodeURIComponent(candidate)}?refresh=true`), {
            headers: { 'x-access-token': session.token }
          });
          if (!response.ok) continue;
          const data = await response.json();
          const videos = Array.isArray(data?.videos) ? data.videos : [];
          if (videos.length > 0) {
            resolvedVideos = videos;
            break;
          }
        }

        setSelectedItemVideos(resolvedVideos);
        const seasons = resolvedVideos.map(v => v.season).filter(s => s !== undefined && s !== null);
        setActiveSeason(seasons.length > 0 ? Math.min(...seasons) : 1);
      } catch (err) {
      } finally {
        setIsVideosLoading(false);
      }
    };
    fetchVideos();
  }, [selectedItem, session.token, id]);

  useEffect(() => {
    const fetchTmdbMetadata = async () => {
      if (!selectedItem) return;
      setIsTmdbMetaLoading(true);
      setTmdbMetaError(null);
      try {
        const folderName = selectedItem.folder_name || selectedItem.name || selectedItem.tmdb_title || (id ? decodeURIComponent(id) : '');
        if (!folderName) {
          setTmdbMetaError('Nama folder untuk metadata TMDB tidak ditemukan.');
          return;
        }

        const res = await fetch(getApiUrl(`/api/tmdb-meta/tv?folder_name=${encodeURIComponent(folderName)}`), {
          headers: { 'x-access-token': session.token }
        });
        if (!res.ok) {
          setTmdbMetaError('Metadata TMDB belum tersedia untuk series ini.');
          return;
        }
        const data = await res.json();

        const nextMeta = {
          tmdb_id: data.id || data.tmdb_id || null,
          tmdb_title: data.name || data.title || selectedItem.tmdb_title,
          tmdb_poster_path: data.poster_path || selectedItem.tmdb_poster_path,
          tmdb_backdrop_path: data.backdrop_path || selectedItem.tmdb_backdrop_path,
          tmdb_overview: data.overview || selectedItem.tmdb_overview,
          tmdb_rating: data.vote_average ?? selectedItem.tmdb_rating,
          tmdb_genres: data.genres || selectedItem.tmdb_genres,
          tmdb_credits: data.credits || selectedItem.tmdb_credits
        };

        setTmdbServerMeta(nextMeta);
        setTmdbId(nextMeta.tmdb_id);
        setSelectedItem(prev => prev ? { ...prev, ...nextMeta } : prev);
      } catch (_) {
        setTmdbMetaError('Gagal memuat metadata TMDB dari server.');
      } finally {
        setIsTmdbMetaLoading(false);
      }
    };
    fetchTmdbMetadata();
  }, [selectedItem?.name, selectedItem?.folder_name, selectedItem?.tmdb_title, selectedItem?.tmdb_poster_path, selectedItem?.tmdb_backdrop_path, selectedItem?.tmdb_overview, selectedItem?.tmdb_rating, session.token, id]);

  useEffect(() => {
    const fetchSeasonEpisodes = async () => {
      const seasonNums = Array.from(
        new Set(
          selectedItemVideos
            .map((v) => v.season)
            .filter((s) => s !== undefined && s !== null)
        )
      ).sort((a, b) => a - b);
      if (!tmdbId || !seasonNums.length) return;
      const nextMap = {};
      await Promise.all(
        seasonNums.map(async (seasonNum) => {
          try {
            const res = await fetch(getApiUrl(`/api/tmdb/tv/${tmdbId}/season/${seasonNum}`), {
              headers: { 'x-access-token': session.token }
            });
            if (!res.ok) return;
            const data = await res.json();
            const eps = Array.isArray(data?.episodes) ? data.episodes : [];
            eps.forEach((ep) => {
              nextMap[`${seasonNum}-${ep.episode_number}`] = {
                name: ep.name,
                still_path: ep.still_path,
                overview: ep.overview
              };
            });
          } catch (_) {}
        })
      );
      setTmdbEpisodeMap(nextMap);
    };
    fetchSeasonEpisodes();
  }, [tmdbId, selectedItemVideos, session.token]);

  const handlePlayVideo = async (video) => {
    setPlayingVideo(video);
    setVideoStreamDetails(null);
    try {
      if (video.path.startsWith('telegram/')) {
        const parts = video.path.split('/');
        const chat_id = parts[1];
        const message_id = parts[2];
        const url = `/api/telegram/stream/${chat_id}/${message_id}?token=${encodeURIComponent(session.token)}`;
        setVideoStreamDetails({ stream_url: url });
      } else {
        const response = await fetch(getApiUrl(`/api/gdrive-stream-details/${encodeURIComponent(video.path)}`), {
          headers: { 'x-access-token': session.token }
        });
        if (response.ok) {
          const data = await response.json();
          setVideoStreamDetails(data);
        }
      }
    } catch (err) {}
  };

  const handleClosePlayer = () => {
    setPlayingVideo(null);
    setVideoStreamDetails(null);
    fetchWatchHistory();
  };

  const handleVideoTimeUpdate = async (e) => {
    const video = e.currentTarget;
    if (!video || !playingVideo || !activeProfile) return;
    const currentTimeMs = Math.floor(video.currentTime * 1000);
    const durationMs = Math.floor(video.duration * 1000);

    if (video.paused || Math.floor(video.currentTime) % 10 === 0) {
      try {
        await fetch(getApiUrl('/api/history/save'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': session.token
          },
          body: JSON.stringify({
            profile_id: activeProfile.id,
            media_path: playingVideo.path,
            media_title: playingVideo.name,
            series_title: tmdbServerMeta?.tmdb_title || selectedItem.tmdb_title || selectedItem.name,
            source: playingVideo.source || selectedItem.source || 'Google Drive',
            still_path: tmdbServerMeta?.tmdb_backdrop_path || selectedItem.tmdb_backdrop_path || tmdbServerMeta?.tmdb_poster_path || selectedItem.tmdb_poster_path || null,
            subtitle_path: playingVideo.subtitle_path || null,
            position_ms: currentTimeMs,
            duration_ms: durationMs,
            season: playingVideo.season || null,
            episode: playingVideo.episode || null
          })
        });
      } catch (err) {}
    }
  };

  const onClose = () => navigate(-1);

  const seasons = useMemo(() => {
    const sSet = new Set();
    selectedItemVideos.forEach(v => {
      if (v.season !== undefined && v.season !== null) {
        sSet.add(v.season);
      }
    });
    return Array.from(sSet).sort((a, b) => a - b);
  }, [selectedItemVideos]);

  const currentSeasonVideos = useMemo(() => {
    if (!selectedItem) return [];
    return selectedItemVideos.filter(v => (v.season || 1) === activeSeason);
  }, [selectedItemVideos, activeSeason, selectedItem]);

  const getVideoProgress = (videoPath) => {
    const hist = continueWatching.find(h => h.media_path === videoPath);
    if (hist && hist.duration_ms > 0) {
      return (hist.position_ms / hist.duration_ms) * 100;
    }
    return 0;
  };

  if (!selectedItem || isTmdbMetaLoading) {
    return (
      <div className="fixed inset-0 z-50 bg-[#141414] text-slate-100 flex flex-col items-center justify-center gap-4 font-bold">
        <div className="w-12 h-12 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div>
        <span className="text-sm text-neutral-400">Loading TMDB metadata...</span>
      </div>
    );
  }

  if (tmdbMetaError || !tmdbServerMeta) {
    return (
      <div className="fixed inset-0 z-50 bg-[#141414] text-slate-100 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-black text-white">Metadata belum siap</h1>
        <p className="max-w-md text-sm text-neutral-400">
          {tmdbMetaError || 'Metadata TMDB dari server belum berhasil dimuat.'}
        </p>
        <button
          onClick={onClose}
          className="rounded bg-white px-5 py-2 text-sm font-bold text-black transition hover:bg-white/85"
        >
          Back
        </button>
      </div>
    );
  }

  const cast = selectedItem.tmdb_credits?.cast || [];
  const crew = selectedItem.tmdb_credits?.crew || [];
  const firstEpisode = selectedItemVideos[0];
  const activeSeasonLabel = seasons.length > 0 ? `Season ${activeSeason}` : 'Episodes';
  const displayTitle = tmdbServerMeta?.tmdb_title || selectedItem.tmdb_title || selectedItem.name;
  const displayOverview = tmdbServerMeta?.tmdb_overview || selectedItem.tmdb_overview || 'Detailed synopsis is currently unavailable. The video remains fully playable.';
  const backdropPath = tmdbServerMeta?.tmdb_backdrop_path || selectedItem.tmdb_backdrop_path;
  const posterPath = tmdbServerMeta?.tmdb_poster_path || selectedItem.tmdb_poster_path;
  const heroImagePath = backdropPath || posterPath;
  const episodeThumbnailPath = backdropPath || posterPath;

  return (
    <>
      <div className="min-h-screen w-full bg-[#141414] text-slate-100 flex flex-col animate-fadeIn">
        <div className="flex-1 w-full space-y-0">
          <div className="relative overflow-hidden bg-black min-h-[78vh] sm:min-h-[84vh] group">
            {heroImagePath ? (
              <div 
                className="absolute inset-0 bg-cover bg-center transition-transform duration-1000 group-hover:scale-105"
                style={{ backgroundImage: `url(${getPosterUrl(heroImagePath, 'original')})` }}
              ></div>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-900 to-slate-950 flex flex-col items-center justify-center">
                <span className="text-green-500 text-6xl font-black mb-2 select-none">
                  {displayTitle.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            
            <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/45 to-transparent"></div>
            <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/45 to-transparent"></div>
            <div className="absolute inset-0 bg-black/15"></div>

            <button
              onClick={onClose}
              className="absolute left-4 top-4 sm:left-8 sm:top-8 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/80"
              aria-label="Back"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <div className="absolute inset-x-0 bottom-0 px-5 pb-12 pt-28 sm:px-10 lg:px-14">
              <div className="max-w-3xl space-y-5">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-black tracking-[-0.03em] text-red-600">M</span>
                  <span className="text-xs font-bold uppercase tracking-[0.35em] text-slate-200">Series</span>
                </div>

                <h1 className="max-w-3xl text-4xl font-black leading-none tracking-normal text-white drop-shadow-2xl sm:text-6xl lg:text-7xl">
                  {displayTitle}
                </h1>

                <div className="flex flex-wrap items-center gap-3 text-sm font-semibold text-slate-200">
                  {selectedItem.tmdb_rating !== undefined && (
                    <span className="text-green-400">{Math.round(selectedItem.tmdb_rating * 10)}% Match</span>
                  )}
                  <span>TV Series</span>
                  {seasons.length > 0 && (
                    <span>{seasons.length} Season{seasons.length > 1 ? 's' : ''}</span>
                  )}
                  <span className="border border-white/40 px-1.5 py-0.5 text-xs uppercase leading-none text-white/90">
                    HD
                  </span>
                </div>

                <p className="max-w-2xl text-sm leading-relaxed text-slate-100 drop-shadow-lg sm:text-base">
                  {displayOverview}
                </p>

                <div className="flex flex-wrap gap-3 pt-1">
                  {firstEpisode ? (
                    <button
                      onClick={() => handlePlayVideo(firstEpisode)}
                      className="flex items-center gap-2 rounded bg-white px-6 py-2.5 text-sm font-extrabold text-black transition hover:bg-white/85 active:scale-95 sm:text-base"
                    >
                      <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      Play
                    </button>
                  ) : (
                    <button
                      disabled
                      className="flex cursor-not-allowed items-center gap-2 rounded bg-white/25 px-6 py-2.5 text-sm font-extrabold text-white/70 sm:text-base"
                    >
                      No playable files
                    </button>
                  )}
                  <button
                    onClick={() => document.getElementById('series-episodes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="flex items-center gap-2 rounded bg-white/20 px-6 py-2.5 text-sm font-extrabold text-white transition hover:bg-white/30 sm:text-base"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 6h16M4 12h16M4 18h10" />
                    </svg>
                    Episodes
                  </button>
                </div>
              </div>
            </div>
          </div>

          <main className="-mt-8 space-y-10 px-5 pb-14 sm:px-10 lg:px-14">
            <section id="series-episodes" className="space-y-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-xl font-bold text-white">Episodes</h2>
                {seasons.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {seasons.map(sNum => (
                      <button
                        key={sNum}
                        onClick={() => setActiveSeason(sNum)}
                        className={`rounded border px-4 py-2 text-sm font-bold transition ${
                          activeSeason === sNum
                            ? 'border-white bg-white text-black'
                            : 'border-white/15 bg-[#242424] text-white hover:border-white/40 hover:bg-[#333]'
                        }`}
                      >
                        Season {sNum}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-white/10">
                {isVideosLoading ? (
                  <div className="flex flex-col items-center justify-center py-10 space-y-4">
                    <div className="w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-slate-400 text-sm font-semibold">Loading episodes...</span>
                  </div>
                ) : selectedItemVideos.length === 0 ? (
                  <div className="py-10 text-center">
                    <h4 className="text-slate-200 font-bold">No Episodes Found</h4>
                  </div>
                ) : (
                  <div>
                    {currentSeasonVideos.map((video, idx) => {
                      const progress = getVideoProgress(video.path);
                      const episodeNumber = video.episode || (idx + 1);
                      const episodeMeta = tmdbEpisodeMap[`${activeSeason}-${episodeNumber}`] || {};
                      const episodeImagePath = episodeMeta.still_path || episodeThumbnailPath;
                      return (
                        <button
                          key={idx}
                          onClick={() => handlePlayVideo(video)}
                          className="group relative grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-4 border-b border-white/10 px-0 py-4 text-left transition hover:bg-white/[0.06] sm:grid-cols-[3rem_minmax(9rem,14rem)_1fr_auto] sm:px-3"
                        >
                          <div className="text-center text-lg font-semibold text-neutral-500 group-hover:text-white">
                            {episodeNumber}
                          </div>
                          <div className="hidden aspect-video overflow-hidden rounded bg-neutral-800 sm:block">
                            {episodeImagePath ? (
                              <img
                                src={getPosterUrl(episodeImagePath, 'w500')}
                                alt=""
                                className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-2xl font-black text-red-600">
                                {displayTitle.charAt(0).toUpperCase()}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <h3 className="line-clamp-1 text-sm font-bold text-white sm:text-base">
                                {episodeMeta.name || video.name}
                              </h3>
                              <span className="text-xs font-medium text-neutral-500">{activeSeasonLabel}</span>
                            </div>
                            <p className="line-clamp-2 text-xs leading-relaxed text-neutral-400 sm:text-sm">
                              {episodeMeta.overview || 'Stream from Google Drive. Progress resumes automatically when available.'}
                            </p>
                          </div>
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-black/30 text-white transition group-hover:border-white group-hover:bg-white group-hover:text-black">
                            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </div>

                          {progress > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-neutral-800">
                              <div className="h-full bg-red-600" style={{ width: `${progress}%` }}></div>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="grid grid-cols-1 gap-8 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="space-y-3">
                <h2 className="text-xl font-bold text-white">More Like This Story</h2>
                <p className="max-w-4xl text-sm leading-relaxed text-neutral-300 sm:text-base">
                  {displayOverview}
                </p>
              </div>

              <div className="space-y-3 text-sm leading-relaxed text-neutral-400">
                {cast.length > 0 && (
                  <p>
                    <span className="text-neutral-500">Cast: </span>
                    {cast.slice(0, 5).map(actor => actor.name).join(', ')}
                  </p>
                )}
                {crew.length > 0 && (
                  <p>
                    <span className="text-neutral-500">Creators: </span>
                    {crew.filter(c => ['Director', 'Producer', 'Writer', 'Executive Producer'].includes(c.job)).slice(0, 4).map(member => member.name).join(', ')}
                  </p>
                )}
                <p><span className="text-neutral-500">Source: </span>Google Drive</p>
              </div>
            </section>

            {cast.length > 0 && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-white">Cast</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                  {cast.slice(0, 16).map((actor, idx) => (
                    <div key={idx} className="space-y-2">
                      <div className="aspect-[2/3] overflow-hidden rounded bg-neutral-800">
                        {actor.profile_path ? (
                          <img 
                            src={getPosterUrl(actor.profile_path, 'w185')} 
                            alt={actor.name} 
                            className="w-full h-full object-cover" 
                          />
                        ) : (
                          <span className="text-slate-500 text-xl font-bold">{actor.name.charAt(0)}</span>
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-100 line-clamp-1">{actor.name}</p>
                        <p className="text-xs text-slate-400 line-clamp-1">{actor.character}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {crew.length > 0 && (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-white">Crew</h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {crew.filter(c => ['Director', 'Producer', 'Screenplay', 'Writer', 'Executive Producer'].includes(c.job)).slice(0, 8).map((member, idx) => (
                    <div key={idx} className="border-t border-white/10 py-3">
                      <p className="text-sm font-bold text-slate-100 line-clamp-1">{member.name}</p>
                      <p className="text-xs text-neutral-500 line-clamp-1">{member.job}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {playingVideo && (
        <VideoPlayer 
          playingVideo={playingVideo}
          videoStreamDetails={videoStreamDetails}
          onClose={handleClosePlayer}
          onTimeUpdate={handleVideoTimeUpdate}
          continueWatching={continueWatching}
          getApiUrl={getApiUrl}
        />
      )}
    </>
  );
}
