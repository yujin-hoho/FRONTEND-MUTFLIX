import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Captions,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import {
  fetchPlaybackMarkers,
  fetchPlaybackSource,
  fetchSubtitleTrack,
} from '../services/api'
import { getItemPath, getMediaType, getTitle } from '../utils/media'

const SAVE_INTERVAL_MS = 10000
const CONTROLS_HIDE_DELAY_MS = 2600

function WatchPage({
  authToken,
  item,
  onBack,
  onOpenVideo,
  onSaveProgress,
  profileId,
  resumeEntry,
  video,
  videos,
}) {
  const playerRef = useRef(null)
  const shellRef = useRef(null)
  const controlsTimeoutRef = useRef(null)
  const lastSavedAtRef = useRef(0)
  const lastSavedPositionRef = useRef(-1)
  const restoredPositionRef = useRef(false)
  const progressContextRef = useRef(null)
  const [streamUrl, setStreamUrl] = useState('')
  const [subtitleUrl, setSubtitleUrl] = useState('')
  const [markers, setMarkers] = useState({ introEndSeconds: 0, outroStartSeconds: 0 })
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isBuffering, setIsBuffering] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isCaptionsEnabled, setIsCaptionsEnabled] = useState(true)
  const [showControls, setShowControls] = useState(true)
  const [playerError, setPlayerError] = useState('')

  const queue = useMemo(() => videos?.length ? videos : [video], [video, videos])
  const currentIndex = queue.findIndex((entry) => entry.path === video.path)
  const nextVideo = currentIndex >= 0 ? queue[currentIndex + 1] : null
  const markerFolderName = item.folder_name || item.name || getItemPath(item)
  const videoName = video.name || ''
  const videoOriginalName = video.original_name || ''
  const videoPath = video.path
  const subtitlePath = video.subtitle_path || ''
  const isHlsVideo = /\.m3u8(?:$|\?)/i.test(videoOriginalName || videoName || videoPath)
  const isSeries = getMediaType(item) !== 'movie'
  const episodeLabel = isSeries
    ? `Season ${video.season || 1} · Episode ${video.episode || currentIndex + 1}`
    : 'Movie'
  const showSkipIntro = markers.introEndSeconds > 0
    && currentTime < markers.introEndSeconds
    && markers.introEndSeconds - currentTime > 1
  const showNextEpisode = nextVideo && duration > 0 && (
    (markers.outroStartSeconds > 0 && currentTime >= duration - markers.outroStartSeconds)
    || currentTime >= duration - 2
  )

  const persistProgress = useCallback(({ complete = false, force = false } = {}) => {
    const player = playerRef.current
    const context = progressContextRef.current
    if (!player || !context || !Number.isFinite(player.duration) || player.duration <= 0) {
      return Promise.resolve()
    }

    const positionMs = Math.round((complete ? player.duration : player.currentTime) * 1000)
    const durationMs = Math.round(player.duration * 1000)
    const now = Date.now()
    if (!force && now - lastSavedAtRef.current < SAVE_INTERVAL_MS) return Promise.resolve()
    if (!force && Math.abs(positionMs - lastSavedPositionRef.current) < SAVE_INTERVAL_MS) return Promise.resolve()

    lastSavedAtRef.current = now
    lastSavedPositionRef.current = positionMs
    return onSaveProgress(createHistoryPayload(context, positionMs, durationMs)).catch(() => {
      // Playback must continue even if a background progress sync fails.
    })
  }, [onSaveProgress])

  const revealControls = useCallback(() => {
    setShowControls(true)
    window.clearTimeout(controlsTimeoutRef.current)
    if (isPlaying) {
      controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
    }
  }, [isPlaying])

  const seekBy = useCallback((seconds) => {
    const player = playerRef.current
    if (!player || !Number.isFinite(player.duration)) return
    player.currentTime = Math.min(player.duration, Math.max(0, player.currentTime + seconds))
    setCurrentTime(player.currentTime)
    revealControls()
  }, [revealControls])

  const togglePlay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (player.paused) {
      player.play().catch(() => setShowControls(true))
    } else {
      player.pause()
    }
  }, [])

  const toggleMute = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    player.muted = !player.muted
    setIsMuted(player.muted)
    revealControls()
  }, [revealControls])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await shellRef.current?.requestFullscreen()
      }
    } catch {
      setShowControls(true)
    }
  }, [])

  const toggleCaptions = useCallback(() => {
    const shouldEnable = !isCaptionsEnabled
    if (!setTextTrackMode(playerRef.current, shouldEnable ? 'showing' : 'hidden')) return
    setIsCaptionsEnabled(shouldEnable)
    revealControls()
  }, [isCaptionsEnabled, revealControls])

  useEffect(() => {
    progressContextRef.current = { item, profileId, video }
  }, [item, profileId, video])

  useEffect(() => {
    let ignore = false
    let nextSubtitleUrl = ''

    fetchPlaybackSource(authToken, videoPath, { name: videoName, original_name: videoOriginalName })
      .then((url) => {
        if (!ignore) setStreamUrl(url)
      })
      .catch((error) => {
        if (!ignore) {
          setPlayerError(error.message)
          setIsBuffering(false)
        }
      })

    fetchPlaybackMarkers(authToken, markerFolderName).then((nextMarkers) => {
      if (!ignore) setMarkers(nextMarkers)
    })

    fetchSubtitleTrack(subtitlePath).then((url) => {
      nextSubtitleUrl = url
      if (!ignore) setSubtitleUrl(url)
    })

    return () => {
      ignore = true
      if (nextSubtitleUrl) URL.revokeObjectURL(nextSubtitleUrl)
    }
  }, [authToken, markerFolderName, subtitlePath, videoName, videoOriginalName, videoPath])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !streamUrl) return undefined

    let hls
    let ignore = false

    async function attachStream() {
      if (!isHlsVideo) {
        player.src = streamUrl
        player.load()
        return
      }

      const { default: Hls } = await import('hls.js')
      if (ignore) return
      if (!Hls.isSupported()) {
        player.src = streamUrl
        player.load()
        return
      }

      hls = new Hls()
      hls.loadSource(streamUrl)
      hls.attachMedia(player)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setPlayerError('The HLS stream could not be loaded.')
          setIsBuffering(false)
        }
      })
    }

    attachStream().catch(() => {
      setPlayerError('The HLS stream could not be loaded.')
      setIsBuffering(false)
    })

    return () => {
      ignore = true
      hls?.destroy()
      player.removeAttribute('src')
      player.load()
    }
  }, [isHlsVideo, streamUrl])

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  useEffect(() => {
    const flushProgress = () => persistProgress({ force: true })
    window.addEventListener('pagehide', flushProgress)
    return () => {
      window.removeEventListener('pagehide', flushProgress)
      persistProgress({ force: true })
    }
  }, [persistProgress, video.path])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return
      if (event.key === ' ') {
        event.preventDefault()
        togglePlay()
      } else if (event.key === 'ArrowLeft') {
        seekBy(-10)
      } else if (event.key === 'ArrowRight') {
        seekBy(10)
      } else if (event.key.toLowerCase() === 'f') {
        toggleFullscreen()
      } else if (event.key.toLowerCase() === 'm') {
        toggleMute()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [seekBy, toggleFullscreen, toggleMute, togglePlay])

  useEffect(() => {
    window.clearTimeout(controlsTimeoutRef.current)
    if (isPlaying) {
      controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
    }
    return () => window.clearTimeout(controlsTimeoutRef.current)
  }, [isPlaying])

  function handleLoadedMetadata() {
    const player = playerRef.current
    if (!player) return

    setDuration(player.duration || 0)
    setIsBuffering(false)
    if (!restoredPositionRef.current) {
      const resumeSeconds = Number(resumeEntry?.position_ms || 0) / 1000
      if (resumeSeconds > 0 && resumeSeconds < player.duration - 2) {
        player.currentTime = resumeSeconds
        setCurrentTime(resumeSeconds)
      }
      restoredPositionRef.current = true
    }
    if (subtitleUrl) setTextTrackMode(player, 'showing')
    player.play().catch(() => setShowControls(true))
  }

  function handleTimeUpdate() {
    const player = playerRef.current
    if (!player) return
    setCurrentTime(player.currentTime)
    setDuration(player.duration || 0)
    persistProgress()
  }

  function handleSeek(event) {
    const player = playerRef.current
    if (!player) return
    player.currentTime = Number(event.target.value)
    setCurrentTime(player.currentTime)
  }

  function handleVolume(event) {
    const player = playerRef.current
    if (!player) return
    const nextVolume = Number(event.target.value)
    player.volume = nextVolume
    player.muted = nextVolume === 0
    setVolume(nextVolume)
    setIsMuted(player.muted)
  }

  function handlePlaybackRate(event) {
    if (playerRef.current) playerRef.current.playbackRate = Number(event.target.value)
  }

  function handleOpenNext() {
    if (!nextVideo) return
    persistProgress({ complete: true, force: true })
    onOpenVideo(nextVideo)
  }

  function handleBack() {
    persistProgress({ force: true })
    onBack()
  }

  return (
    <main
      className={`watch-page ${showControls ? 'controls-visible' : ''}`}
      onMouseMove={revealControls}
      onTouchStart={revealControls}
      ref={shellRef}
    >
      <video
        autoPlay
        className="watch-video"
        onClick={togglePlay}
        onEnded={() => {
          setIsPlaying(false)
          persistProgress({ complete: true, force: true })
          setShowControls(true)
        }}
        onError={() => {
          if (streamUrl) setPlayerError('The browser could not play this video format.')
          setIsBuffering(false)
        }}
        onLoadedMetadata={handleLoadedMetadata}
        onPause={() => {
          setIsPlaying(false)
          persistProgress({ force: true })
        }}
        onPlay={() => {
          setIsPlaying(true)
          setIsBuffering(false)
        }}
        onPlaying={() => setIsBuffering(false)}
        onTimeUpdate={handleTimeUpdate}
        onWaiting={() => setIsBuffering(true)}
        playsInline
        preload="metadata"
        ref={playerRef}
      >
        {subtitleUrl && <track default kind="subtitles" label="Subtitle" src={subtitleUrl} srcLang="id" />}
      </video>

      <div className="watch-topbar">
        <button aria-label="Back" className="watch-icon-button" onClick={handleBack} type="button">
          <ArrowLeft size={24} />
        </button>
        <div>
          <p>{episodeLabel}</p>
          <h1>{isSeries ? getTitle(item) : video.name || getTitle(item)}</h1>
          {isSeries && <span>{video.name}</span>}
        </div>
      </div>

      {isBuffering && !playerError && (
        <div className="watch-center-state" aria-label="Loading video">
          <Loader2 className="spinner" size={44} />
        </div>
      )}
      {playerError && (
        <div className="watch-center-state watch-error" role="alert">
          <p>{playerError}</p>
          <button onClick={handleBack} type="button">Back to details</button>
        </div>
      )}

      <div className="watch-floating-actions">
        {showSkipIntro && (
          <button onClick={() => {
            if (playerRef.current) playerRef.current.currentTime = markers.introEndSeconds
          }} type="button">
            Skip intro
            <SkipForward size={18} />
          </button>
        )}
        {showNextEpisode && (
          <button onClick={handleOpenNext} type="button">
            Next episode
            <SkipForward size={18} />
          </button>
        )}
      </div>

      <div className="watch-controls">
        <input
          aria-label="Seek video"
          className="watch-seek"
          max={duration || 0}
          min="0"
          onChange={handleSeek}
          step="0.1"
          type="range"
          value={Math.min(currentTime, duration || 0)}
        />
        <div className="watch-controls-row">
          <div className="watch-controls-group">
            <button aria-label={isPlaying ? 'Pause' : 'Play'} className="watch-icon-button" onClick={togglePlay} type="button">
              {isPlaying ? <Pause fill="currentColor" size={22} /> : <Play fill="currentColor" size={22} />}
            </button>
            <button aria-label="Rewind 10 seconds" className="watch-icon-button" onClick={() => seekBy(-10)} type="button">
              <RotateCcw size={20} />
            </button>
            <button aria-label="Forward 10 seconds" className="watch-icon-button" onClick={() => seekBy(10)} type="button">
              <RotateCw size={20} />
            </button>
            <button aria-label={isMuted ? 'Unmute' : 'Mute'} className="watch-icon-button" onClick={toggleMute} type="button">
              {isMuted ? <VolumeX size={21} /> : <Volume2 size={21} />}
            </button>
            <input
              aria-label="Volume"
              className="watch-volume"
              max="1"
              min="0"
              onChange={handleVolume}
              step="0.05"
              type="range"
              value={isMuted ? 0 : volume}
            />
            <span className="watch-time">{formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration)}</span>
          </div>
          <div className="watch-controls-group">
            {subtitleUrl && (
              <button
                aria-label={isCaptionsEnabled ? 'Disable subtitles' : 'Enable subtitles'}
                className={`watch-icon-button ${isCaptionsEnabled ? 'active' : ''}`}
                onClick={toggleCaptions}
                type="button"
              >
                <Captions size={22} />
              </button>
            )}
            <label className="watch-speed">
              <span>Speed</span>
              <select aria-label="Playback speed" defaultValue="1" onChange={handlePlaybackRate}>
                <option value="0.75">0.75x</option>
                <option value="1">1x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
              </select>
            </label>
            <button aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} className="watch-icon-button" onClick={toggleFullscreen} type="button">
              {isFullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}

function createHistoryPayload({ item, profileId, video }, positionMs, durationMs) {
  const isMovie = getMediaType(item) === 'movie'
  return {
    profile_id: profileId,
    media_path: video.path,
    media_title: isMovie ? getTitle(item) : video.name,
    series_title: isMovie ? null : getTitle(item),
    source: video.source || item.source || '',
    still_path: video.still_path || item.tmdb_backdrop_path || item.backdrop_path || item.tmdb_poster_path || item.poster_path || '',
    subtitle_path: video.subtitle_path || '',
    season: video.season || 1,
    episode: video.episode || 1,
    position_ms: positionMs,
    duration_ms: durationMs,
  }
}

function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const roundedSeconds = Math.floor(seconds)
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const remainingSeconds = roundedSeconds % 60
  const segments = hours > 0 ? [hours, minutes, remainingSeconds] : [minutes, remainingSeconds]
  return segments.map((segment) => String(segment).padStart(2, '0')).join(':')
}

function setTextTrackMode(player, mode) {
  const track = player?.textTracks?.[0]
  if (!track) return false
  track.mode = mode
  return true
}

export default WatchPage
