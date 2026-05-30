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
        const path = selectedItem.source || selectedItem.path || `gdrive_folder/${selectedItem.name}`;
        const response = await fetch(getApiUrl(`/api/videos/${encodeURIComponent(path)}`), {
          headers: { 'x-access-token': session.token }
        });
        if (response.ok) {
          const data = await response.json();
          setSelectedItemVideos(data.videos || []);
          if (data.videos && data.videos.length > 0) {
            const seasons = data.videos.map(v => v.season).filter(s => s !== undefined && s !== null);
            if (seasons.length > 0) {
              setActiveSeason(Math.min(...seasons));
            } else {
              setActiveSeason(1);
            }
          }
        }
      } catch (err) {
      } finally {
        setIsVideosLoading(false);
      }
    };
    fetchVideos();
  }, [selectedItem, session.token]);

  useEffect(() => {
    const fetchTmdbId = async () => {
      if (!selectedItem) return;
      try {
        const queryName = selectedItem.name || selectedItem.tmdb_title;
        const res = await fetch(getApiUrl(`/api/tmdb-meta/tv?name=${encodeURIComponent(queryName)}`), {
          headers: { 'x-access-token': session.token }
        });
        if (!res.ok) return;
        const data = await res.json();
        const id = data?.tmdb_id || data?.payload?.tmdb_id || null;
        setTmdbId(id);
      } catch (_) {}
    };
    fetchTmdbId();
  }, [selectedItem, session.token]);

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
              nextMap[`${seasonNum}-${ep.episode_number}`] = ep.name;
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
            series_title: selectedItem.name,
            source: playingVideo.source || selectedItem.source || 'Google Drive',
            still_path: selectedItem.tmdb_poster_path || null,
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

  if (!selectedItem) return <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center font-bold">Loading...</div>;

  const cast = selectedItem.tmdb_credits?.cast || [];
  const crew = selectedItem.tmdb_credits?.crew || [];

  return (
    <>
      <div className="min-h-screen bg-[#141414] text-slate-100 flex flex-col animate-fadeIn">
        {/* Top Header */}
        <div className="sticky top-0 z-30 bg-gradient-to-b from-black/90 to-black/20 backdrop-blur-sm px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button 
              onClick={onClose}
              className="text-slate-400 hover:text-white p-2 rounded-full hover:bg-slate-900 transition-all outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <span className="font-extrabold text-xl tracking-tight text-green-500 font-mono">MUTFLIX</span>
          </div>
          <div className="text-sm font-semibold text-slate-400 capitalize">
            TV Series Detail
          </div>
        </div>

        <div className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 space-y-10">
          {/* Scaled-down Cinematic Hero Area */}
          <div className="relative overflow-hidden bg-black h-[58vh] min-h-[420px] max-h-[700px] rounded-lg shadow-2xl group">
            {selectedItem.tmdb_backdrop_path || selectedItem.tmdb_poster_path ? (
              <div 
                className="absolute inset-0 bg-cover bg-center transition-transform duration-1000 group-hover:scale-105"
                style={{ backgroundImage: `url(${getPosterUrl(selectedItem.tmdb_backdrop_path || selectedItem.tmdb_poster_path, 'original')})` }}
              ></div>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-900 to-slate-950 flex flex-col items-center justify-center">
                <span className="text-green-500 text-6xl font-black mb-2 select-none">
                  {selectedItem.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            
            <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-[#141414]/45 to-transparent"></div>
            <div className="absolute inset-0 bg-gradient-to-r from-[#141414] via-[#141414]/30 to-transparent"></div>

            {/* Title & Info */}
            <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-8 space-y-3">
              <h2 className="text-2xl sm:text-4xl font-black text-white tracking-tight drop-shadow-md">
                {selectedItem.tmdb_title || selectedItem.name}
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm text-slate-300">
                {selectedItem.tmdb_rating !== undefined && (
                  <span className="flex items-center gap-1 bg-yellow-500/15 border border-yellow-500/30 text-yellow-500 px-2 py-0.5 rounded-md font-extrabold">
                    ★ {selectedItem.tmdb_rating.toFixed(1)}
                  </span>
                )}
                <span className="bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700">
                  TV Series
                </span>
                <span className="bg-green-500/10 border border-green-500/20 text-green-400 px-2 py-0.5 rounded font-extrabold uppercase tracking-wider">
                  Google Drive
                </span>
              </div>

              <div className="flex flex-wrap gap-3 pt-1">
                {selectedItemVideos.length > 0 ? (
                  <button
                    onClick={() => handlePlayVideo(selectedItemVideos[0])}
                    className="py-2.5 px-5 bg-white hover:bg-white/90 text-black font-bold rounded-md transition-all flex items-center gap-2 outline-none active:scale-95 cursor-pointer text-sm"
                  >
                    <svg className="w-4 h-4 fill-white" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Play Episode 1
                  </button>
                ) : (
                  <button
                    disabled
                    className="py-2.5 px-5 bg-white/25 text-white/70 font-bold rounded-md flex items-center gap-2 cursor-not-allowed text-sm"
                  >
                    No playable files
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Grid Layout: Left Column Synopsis, Right Column Episodes selector (in place of Movie's Cast & Crew position) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Column: Synopsis */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-[#181818] border border-white/10 p-6 rounded-lg space-y-4">
                <h3 className="text-lg font-bold text-white border-b border-slate-800 pb-2">Synopsis</h3>
                <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
                  {selectedItem.tmdb_overview || 'Detailed synopsis is currently unavailable. The video remains fully playable.'}
                </p>
              </div>
            </div>

            {/* Right Column: Episode Selector (Occupying the Cast & Crew equivalent column in layout) */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-[#181818] border border-white/10 p-6 rounded-lg space-y-6">
                <h3 className="text-lg font-bold text-white border-b border-slate-800 pb-2">Episodes</h3>
                {isVideosLoading ? (
                  <div className="flex flex-col items-center justify-center py-10 space-y-4">
                    <div className="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-slate-400 text-sm font-semibold">Loading episodes...</span>
                  </div>
                ) : selectedItemVideos.length === 0 ? (
                  <div className="text-center py-10 space-y-2">
                    <h4 className="text-slate-200 font-bold">No Episodes Found</h4>
                  </div>
                ) : (
                  <>
                    {/* Season tabs */}
                    {seasons.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-4">
                        {seasons.map(sNum => (
                          <button
                            key={sNum}
                            onClick={() => setActiveSeason(sNum)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all outline-none ${
                              activeSeason === sNum 
                                ? 'bg-green-600 text-white shadow-lg shadow-green-950/20' 
                                : 'bg-slate-900 text-slate-400 hover:bg-slate-800/80 hover:text-white'
                            }`}
                          >
                            Season {sNum}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Video files list */}
                    <div className="space-y-3 max-h-[350px] overflow-y-auto pr-2">
                      {currentSeasonVideos.map((video, idx) => {
                        const progress = getVideoProgress(video.path);
                        return (
                          <div 
                            key={idx}
                            onClick={() => handlePlayVideo(video)}
                            className="group flex items-center justify-between p-4 bg-slate-950 hover:bg-slate-900 border border-slate-900 hover:border-slate-800 rounded-xl gap-4 transition-all cursor-pointer relative overflow-hidden"
                          >
                            <div className="flex items-center gap-4 flex-1">
                              <div className="w-8 h-8 rounded-lg bg-slate-900 text-slate-500 group-hover:text-green-500 flex items-center justify-center font-bold font-mono transition-colors">
                                {video.episode || (idx + 1)}
                              </div>
                              <div className="space-y-1 text-left">
                                <h4 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors line-clamp-1">
                                  {tmdbEpisodeMap[`${activeSeason}-${video.episode || (idx + 1)}`] || video.name}
                                </h4>
                                <span className="text-[11px] text-slate-500 font-medium font-mono">
                                  Google Drive Source
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-3">
                              <button className="w-8 h-8 rounded-full bg-slate-900 group-hover:bg-green-600 text-slate-400 group-hover:text-white flex items-center justify-center transition-all shadow-md">
                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                  <path d="M8 5v14l11-7z" />
                                </svg>
                              </button>
                            </div>

                            {progress > 0 && (
                              <div className="absolute bottom-0 left-0 right-0 h-1 bg-slate-800">
                                <div className="h-full bg-green-500" style={{ width: `${progress}%` }}></div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Cast & Crew Section - Placed lower down in Series layout */}
          <div className="space-y-8 pt-4">
            {/* Cast List */}
            {cast.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-xl font-bold text-white border-b border-slate-900 pb-2">Series Cast</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                  {cast.slice(0, 16).map((actor, idx) => (
                    <div key={idx} className="bg-slate-900/40 border border-slate-900/60 rounded-xl p-3 flex flex-col items-center text-center space-y-2 hover:border-slate-800 transition-all">
                      <div className="w-16 h-16 rounded-full overflow-hidden bg-slate-800 flex items-center justify-center">
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
                      <div className="space-y-0.5">
                        <p className="text-xs font-bold text-slate-200 line-clamp-1">{actor.name}</p>
                        <p className="text-[10px] text-slate-400 line-clamp-1">{actor.character}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Crew List */}
            {crew.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-xl font-bold text-white border-b border-slate-900 pb-2">Series Crew</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                  {crew.filter(c => ['Director', 'Producer', 'Screenplay', 'Writer', 'Executive Producer'].includes(c.job)).slice(0, 8).map((member, idx) => (
                    <div key={idx} className="bg-slate-900/40 border border-slate-900/60 rounded-xl p-3 flex flex-col items-center text-center space-y-2">
                      <div className="w-16 h-16 rounded-full overflow-hidden bg-slate-800 flex items-center justify-center">
                        {member.profile_path ? (
                          <img 
                            src={getPosterUrl(member.profile_path, 'w185')} 
                            alt={member.name} 
                            className="w-full h-full object-cover" 
                          />
                        ) : (
                          <span className="text-slate-500 text-xl font-bold">{member.name.charAt(0)}</span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-xs font-bold text-slate-200 line-clamp-1">{member.name}</p>
                        <p className="text-[10px] text-green-400 font-semibold line-clamp-1">{member.job}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

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
