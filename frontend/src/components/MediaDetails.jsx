import React, { useState, useEffect } from 'react';

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
              <div className="w-14"></div> {/* spacer */}
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
              {/* Progress Seekbar */}
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

              {/* Action Buttons Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Play/Pause */}
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

                  {/* Volume Control */}
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
                  {/* Fullscreen */}
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

export default function MediaDetails({
  selectedItem,
  onClose,
  selectedItemVideos,
  isVideosLoading,
  activeSeason,
  setActiveSeason,
  handlePlayVideo,
  playingVideo,
  videoStreamDetails,
  handleClosePlayer,
  handleVideoTimeUpdate,
  continueWatching,
  getPosterUrl,
  getApiUrl
}) {
  const seasons = React.useMemo(() => {
    const sSet = new Set();
    selectedItemVideos.forEach(v => {
      if (v.season !== undefined && v.season !== null) {
        sSet.add(v.season);
      }
    });
    return Array.from(sSet).sort((a, b) => a - b);
  }, [selectedItemVideos]);

  const currentSeasonVideos = React.useMemo(() => {
    if (!selectedItem) return [];
    if (selectedItem.type !== 'series') return selectedItemVideos;
    return selectedItemVideos.filter(v => (v.season || 1) === activeSeason);
  }, [selectedItemVideos, activeSeason, selectedItem]);

  const getVideoProgress = (videoPath) => {
    const hist = continueWatching.find(h => h.media_path === videoPath);
    if (hist && hist.duration_ms > 0) {
      return (hist.position_ms / hist.duration_ms) * 100;
    }
    return 0;
  };

  return (
    <>
      <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950 text-slate-100 flex flex-col animate-fadeIn">
        {/* Top header bar */}
        <div className="sticky top-0 z-30 bg-slate-950/80 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-slate-900">
          <div className="flex items-center gap-3">
            <button 
              onClick={onClose}
              className="text-slate-400 hover:text-white p-2 rounded-full hover:bg-slate-900 transition-all outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <span className="font-extrabold text-xl tracking-tight text-white font-mono">MUTFLIX</span>
          </div>
          <div className="text-sm font-semibold text-slate-400 capitalize">
            {selectedItem.type === 'series' ? 'TV Series' : 'Movie'} Detail
          </div>
        </div>

        <div className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 space-y-8">
          {/* Cinematic Hero Area */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-[16/9] md:aspect-[21/9] shadow-2xl group border border-slate-800">
            {selectedItem.tmdb_backdrop_path || selectedItem.tmdb_poster_path ? (
              <div 
                className="absolute inset-0 bg-cover bg-center transition-transform duration-1000 group-hover:scale-105"
                style={{ backgroundImage: `url(${getPosterUrl(selectedItem.tmdb_backdrop_path || selectedItem.tmdb_poster_path)})` }}
              ></div>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-900 to-slate-950 flex flex-col items-center justify-center">
                <span className="text-green-500 text-8xl font-black mb-2 select-none">
                  {selectedItem.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            {/* Linear Gradients overlaying */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent"></div>
            <div className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/20 to-transparent"></div>

            {/* Title & Fast Action overlay */}
            <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-10 space-y-4">
              <h2 className="text-3xl sm:text-5xl font-black text-white tracking-tight drop-shadow-md">
                {selectedItem.tmdb_title || selectedItem.name}
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm text-slate-300">
                {selectedItem.tmdb_rating !== undefined && (
                  <span className="flex items-center gap-1 bg-yellow-500/15 border border-yellow-500/30 text-yellow-500 px-2 py-0.5 rounded-md font-extrabold">
                    ★ {selectedItem.tmdb_rating.toFixed(1)}
                  </span>
                )}
                <span className="bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700">
                  {selectedItem.type === 'series' ? 'TV Series' : 'Movie'}
                </span>
                <span className="bg-green-500/10 border border-green-500/20 text-green-400 px-2 py-0.5 rounded font-extrabold uppercase tracking-wider">
                  Google Drive
                </span>
              </div>

              <div className="flex flex-wrap gap-3 pt-2">
                {selectedItemVideos.length > 0 ? (
                  <button
                    onClick={() => handlePlayVideo(selectedItemVideos[0])}
                    className="py-3 px-6 bg-green-600 hover:bg-green-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-green-950/20 flex items-center gap-2 outline-none active:scale-95 cursor-pointer"
                  >
                    <svg className="w-5 h-5 fill-white" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    {selectedItem.type === 'series' ? 'Play Episode 1' : 'Play Now'}
                  </button>
                ) : (
                  <button
                    disabled
                    className="py-3 px-6 bg-slate-800 text-slate-500 font-bold rounded-xl flex items-center gap-2 cursor-not-allowed"
                  >
                    No playable files
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Split Grid: Details vs Seasons/Videos */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left Column: Synopsis & details */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-slate-900/40 border border-slate-900 p-6 rounded-2xl space-y-4">
                <h3 className="text-lg font-bold text-white border-b border-slate-800 pb-2">Synopsis</h3>
                <p className="text-slate-300 text-sm sm:text-base leading-relaxed">
                  {selectedItem.tmdb_overview || 'Detailed synopsis is currently unavailable. The video remains fully playable.'}
                </p>
              </div>
            </div>

            {/* Right Column: Episode Selector */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-slate-900/40 border border-slate-900 p-6 rounded-2xl space-y-6">
                {isVideosLoading ? (
                  <div className="flex flex-col items-center justify-center py-20 space-y-4">
                    <div className="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-slate-400 text-sm font-semibold">Loading files...</span>
                  </div>
                ) : selectedItemVideos.length === 0 ? (
                  <div className="text-center py-20 space-y-2">
                    <svg className="w-12 h-12 text-slate-700 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h4 className="text-slate-200 font-bold">No Playable Files Found</h4>
                    <p className="text-slate-500 text-xs">There are no playable stream items linked to this listing.</p>
                  </div>
                ) : (
                  <>
                    {/* For Series: Render Season tabs */}
                    {selectedItem.type === 'series' && seasons.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-4">
                        {seasons.map(sNum => (
                          <button
                            key={sNum}
                            onClick={() => setActiveSeason(sNum)}
                            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all outline-none ${
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
                    <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
                      {currentSeasonVideos.map((video, idx) => {
                        const progress = getVideoProgress(video.path);
                        return (
                          <div 
                            key={idx}
                            onClick={() => handlePlayVideo(video)}
                            className="group flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 bg-slate-950 hover:bg-slate-900 border border-slate-900 hover:border-slate-800 rounded-xl gap-4 transition-all cursor-pointer relative overflow-hidden"
                          >
                            {/* Left details */}
                            <div className="flex items-center gap-4 flex-1">
                              <div className="w-8 h-8 rounded-lg bg-slate-900 text-slate-500 group-hover:text-green-500 flex items-center justify-center font-bold font-mono transition-colors">
                                {selectedItem.type === 'series' ? video.episode || (idx + 1) : (idx + 1)}
                              </div>
                              <div className="space-y-1 text-left">
                                <h4 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors line-clamp-1">
                                  {video.name}
                                </h4>
                                <span className="text-[11px] text-slate-500 font-medium font-mono">
                                  Google Drive Source
                                </span>
                              </div>
                            </div>

                            {/* Right play control / visual indicator */}
                            <div className="flex items-center gap-3 self-end sm:self-auto">
                              <button className="w-8 h-8 rounded-full bg-slate-900 group-hover:bg-green-600 text-slate-400 group-hover:text-white flex items-center justify-center transition-all shadow-md">
                                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                  <path d="M8 5v14l11-7z" />
                                </svg>
                              </button>
                            </div>

                            {/* Watch history progress bar at the very bottom of the card */}
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
        </div>
      </div>

      {/* 5. FULL-SCREEN VIDEO PLAYER OVERLAY */}
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
