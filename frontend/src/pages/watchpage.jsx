import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  Captions,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  fetchAudioTranscodeStart,
  fetchEmbeddedSubtitleWindow,
  fetchEmbeddedSubtitleTracks,
  fetchPlaybackMarkers,
  fetchPlaybackSource,
  fetchSubtitleTrack,
  getTimestampedAudioTranscodeUrl,
} from '../services/api'
import { getEpisodeHistoryLabel, getItemPath, getMediaType, getTitle } from '../utils/media'

const SAVE_INTERVAL_MS = 10000
const FORCED_SAVE_DEDUP_WINDOW_MS = 1500
const CONTROLS_HIDE_DELAY_MS = 2600
const STREAM_STALL_FALLBACK_DELAY_MS = 10000
const SEEK_STALL_FALLBACK_DELAY_MS = 16000
const AUDIO_TRANSCODE_SEEK_DEBOUNCE_MS = 120
const SUBTITLE_DELAY_LIMIT_SECONDS = 50
const SUBTITLE_DELAY_STEP_SECONDS = 0.5
const SUBTITLE_FONT_SIZE_MAX_PX = 48
const SUBTITLE_FONT_SIZE_MIN_PX = 14
const SUBTITLE_OUTLINE_MAX_PX = 5
const SUBTITLE_OUTLINE_MIN_PX = 0
const SUBTITLE_POSITION_MIN_PERCENT = 8
const SUBTITLE_POSITION_MAX_PERCENT = 90
const EMBEDDED_SUBTITLE_WINDOW_SECONDS = 180
const EMBEDDED_SUBTITLE_WINDOW_LOOKBEHIND_SECONDS = 10
const EMBEDDED_SUBTITLE_PREFETCH_LEAD_SECONDS = 30
const SUBTITLE_SETTINGS_STORAGE_KEY = 'mutflix.subtitle-settings'
const DEFAULT_SUBTITLE_SETTINGS = {
  background: 'translucent',
  color: 'white',
  delaySeconds: 0,
  enabled: true,
  fontFamily: 'sans',
  fontSizePx: 26,
  fontStyle: 'normal',
  outlineWidth: 2,
  positionPercent: 82,
}

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
  const streamStallTimeoutRef = useRef(null)
  const fallbackStreamUrlRef = useRef('')
  const fallbackPositionRef = useRef(null)
  const sourceDurationRef = useRef(0)
  const playbackSourceRequestRef = useRef(0)
  const playbackSourceRef = useRef(null)
  const audioTracksRef = useRef([])
  const selectedAudioStreamIndexRef = useRef(null)
  const audioTranscodeBaseUrlRef = useRef('')
  const audioTranscodeOffsetRef = useRef(0)
  const audioTranscodeStartUrlRef = useRef('')
  const audioTranscodeStartRequestRef = useRef({ controller: null, id: 0 })
  const audioTranscodeStartTimeoutRef = useRef(null)
  const pendingAudioTranscodeOffsetRef = useRef(0)
  const pendingAudioTranscodeTargetRef = useRef(null)
  const pendingAudioTranscodeAutoplayRef = useRef(null)
  const seekPreviewTimeoutRef = useRef(null)
  const isSeekBarActiveRef = useRef(false)
  const embeddedSubtitleTracksRef = useRef([])
  const embeddedSubtitleTrackUrlRef = useRef('')
  const embeddedSubtitleWindowRequestsRef = useRef(new Set())
  const externalSubtitleCuesRef = useRef([])
  const selectedSubtitleIdRef = useRef('')
  const hasUsedStreamFallbackRef = useRef(false)
  const isSeekingRef = useRef(false)
  const pendingInitialSeekRef = useRef(false)
  const requestedSeekPositionRef = useRef(null)
  const lastSavedAtRef = useRef(0)
  const lastSavedPositionRef = useRef(-1)
  const lastForcedSaveRef = useRef({ positionMs: -1, savedAt: 0 })
  const restoredPositionRef = useRef(false)
  const initialResumePositionRef = useRef(Number(resumeEntry?.position_ms || 0) / 1000)
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
  const [needsAudioTranscode, setNeedsAudioTranscode] = useState(false)
  const [audioCodecLabel, setAudioCodecLabel] = useState('')
  const [audioTracks, setAudioTracks] = useState([])
  const [selectedAudioId, setSelectedAudioId] = useState('')
  const [isAudioPanelOpen, setIsAudioPanelOpen] = useState(false)
  const [subtitleSettings, setSubtitleSettings] = useState(readSubtitleSettings)
  const [subtitleDelayInput, setSubtitleDelayInput] = useState(() => formatSubtitleDelay(subtitleSettings.delaySeconds))
  const [subtitleCues, setSubtitleCues] = useState([])
  const [embeddedSubtitleTracks, setEmbeddedSubtitleTracks] = useState([])
  const [embeddedSubtitleTrackUrl, setEmbeddedSubtitleTrackUrl] = useState('')
  const [selectedSubtitleId, setSelectedSubtitleId] = useState('')
  const [isSubtitlePanelOpen, setIsSubtitlePanelOpen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [seekPreviewTime, setSeekPreviewTime] = useState(null)
  const [heldFrameUrl, setHeldFrameUrl] = useState('')
  const [playerError, setPlayerError] = useState('')

  const queue = useMemo(() => videos?.length ? videos : [video], [video, videos])
  const currentIndex = queue.findIndex((entry) => entry.path === video.path)
  const previousVideo = currentIndex > 0 ? queue[currentIndex - 1] : null
  const nextVideo = currentIndex >= 0 ? queue[currentIndex + 1] : null
  const markerFolderName = item.folder_name || item.name || getItemPath(item)
  const videoName = video.name || ''
  const videoOriginalName = video.original_name || ''
  const videoPath = video.path
  const subtitlePath = video.subtitle_path || ''
  const isCaptionsEnabled = subtitleSettings.enabled
  const subtitleTracks = useMemo(() => [
    ...(subtitleUrl ? [{ id: 'external', label: 'Eksternal' }] : []),
    ...embeddedSubtitleTracks.map((track) => ({
      id: getEmbeddedSubtitleTrackId(track),
      label: getEmbeddedSubtitleTrackLabel(track),
    })),
  ], [embeddedSubtitleTracks, subtitleUrl])
  const hasSubtitleTrack = subtitleTracks.length > 0
  const selectedAudioTrack = useMemo(
    () => audioTracks.find((track) => getAudioTrackId(track) === selectedAudioId) || null,
    [audioTracks, selectedAudioId],
  )
  const hasAudioTrackChoices = audioTracks.length > 1
  const selectedAudioLabel = selectedAudioTrack
    ? getAudioTrackDisplayLabel(selectedAudioTrack, { includeCodec: false })
    : audioCodecLabel
  const selectedAudioNoticeLabel = selectedAudioTrack
    ? getAudioTrackDisplayLabel(selectedAudioTrack, { includeCodec: true })
    : audioCodecLabel
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
  const isAudioTranscodeStream = Boolean(
    streamUrl && audioTranscodeBaseUrlRef.current && streamUrl.startsWith(audioTranscodeBaseUrlRef.current),
  )
  const visiblePlaybackTime = seekPreviewTime ?? currentTime
  const subtitlePlaybackTime = Number.isFinite(seekPreviewTime) ? seekPreviewTime : currentTime
  const activeSubtitleCues = useMemo(
    () => isCaptionsEnabled
      ? subtitleCues.filter((cue) => (
          cue.startTime <= subtitlePlaybackTime + subtitleSettings.delaySeconds
          && cue.endTime > subtitlePlaybackTime + subtitleSettings.delaySeconds
        ))
      : [],
    [isCaptionsEnabled, subtitleCues, subtitlePlaybackTime, subtitleSettings.delaySeconds],
  )
  const subtitleCueStyle = useMemo(() => createSubtitleCueStyle(subtitleSettings), [subtitleSettings])
  const subtitlePositionStyle = useMemo(
    () => ({ top: `${subtitleSettings.positionPercent}%` }),
    [subtitleSettings.positionPercent],
  )
  const shouldHideCursor = isPlaying && !showControls && !isSubtitlePanelOpen && !isAudioPanelOpen && !isBuffering && !playerError

  const persistProgress = useCallback(({ complete = false, force = false } = {}) => {
    const player = playerRef.current
    const context = progressContextRef.current
    const playbackDuration = getPlaybackDuration(player?.duration, sourceDurationRef.current, audioTranscodeOffsetRef.current)
    if (!player || !context || playbackDuration <= 0) {
      return Promise.resolve()
    }

    const positionMs = Math.round((complete ? playbackDuration : getPlaybackPosition(player, audioTranscodeOffsetRef.current)) * 1000)
    const durationMs = Math.round(playbackDuration * 1000)
    const now = Date.now()
    if (
      force
      && positionMs === lastForcedSaveRef.current.positionMs
      && now - lastForcedSaveRef.current.savedAt < FORCED_SAVE_DEDUP_WINDOW_MS
    ) {
      return Promise.resolve()
    }
    if (!force && now - lastSavedAtRef.current < SAVE_INTERVAL_MS) return Promise.resolve()
    if (!force && Math.abs(positionMs - lastSavedPositionRef.current) < SAVE_INTERVAL_MS) return Promise.resolve()

    if (force) lastForcedSaveRef.current = { positionMs, savedAt: now }
    lastSavedAtRef.current = now
    lastSavedPositionRef.current = positionMs
    return onSaveProgress(createHistoryPayload(context, positionMs, durationMs)).catch(() => {
      // Playback must continue even if a background progress sync fails.
    })
  }, [onSaveProgress])

  const revealControls = useCallback(() => {
    setShowControls(true)
    window.clearTimeout(controlsTimeoutRef.current)
    if (isPlaying && !isSubtitlePanelOpen && !isAudioPanelOpen) {
      controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
    }
  }, [isAudioPanelOpen, isPlaying, isSubtitlePanelOpen])

  const toggleControls = useCallback(() => {
    window.clearTimeout(controlsTimeoutRef.current)
    if (isSubtitlePanelOpen || isAudioPanelOpen) {
      setIsAudioPanelOpen(false)
      setIsSubtitlePanelOpen(false)
      setShowControls(true)
      if (isPlaying) {
        controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
      }
      return
    }

    if (showControls) {
      setShowControls(false)
      return
    }

    setShowControls(true)
    if (isPlaying && !isSubtitlePanelOpen && !isAudioPanelOpen) {
      controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
    }
  }, [isAudioPanelOpen, isPlaying, isSubtitlePanelOpen, showControls])

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
    if (!hasSubtitleTrack) return
    setSubtitleSettings((currentSettings) => ({
      ...currentSettings,
      enabled: !currentSettings.enabled,
    }))
    revealControls()
  }, [hasSubtitleTrack, revealControls])

  const setSubtitleTrackRef = useCallback((element) => {
    if (element?.track) element.track.mode = 'hidden'
  }, [])

  const selectSubtitleTrack = useCallback((subtitleId, tracks = embeddedSubtitleTracksRef.current) => {
    selectedSubtitleIdRef.current = subtitleId
    setSelectedSubtitleId(subtitleId)
    embeddedSubtitleWindowRequestsRef.current.clear()

    if (subtitleId === 'external') {
      embeddedSubtitleTrackUrlRef.current = ''
      setEmbeddedSubtitleTrackUrl('')
      setSubtitleCues(externalSubtitleCuesRef.current)
      return
    }

    const selectedTrack = tracks.find((track) => getEmbeddedSubtitleTrackId(track) === subtitleId)
    const trackUrl = selectedTrack?.url || ''
    embeddedSubtitleTrackUrlRef.current = trackUrl
    setEmbeddedSubtitleTrackUrl(trackUrl)
    setSubtitleCues([])
  }, [])

  const clearStreamStallTimeout = useCallback(() => {
    window.clearTimeout(streamStallTimeoutRef.current)
    streamStallTimeoutRef.current = null
  }, [])

  const cancelAudioTranscodeStartRequest = useCallback(() => {
    const request = audioTranscodeStartRequestRef.current
    window.clearTimeout(audioTranscodeStartTimeoutRef.current)
    audioTranscodeStartTimeoutRef.current = null
    request.controller?.abort()
    audioTranscodeStartRequestRef.current = { controller: null, id: request.id + 1 }
  }, [])

  const holdCurrentFrame = useCallback(() => {
    const snapshotUrl = captureVideoFrame(playerRef.current)
    if (snapshotUrl) setHeldFrameUrl(snapshotUrl)
  }, [])

  const clearHeldFrame = useCallback(() => {
    setHeldFrameUrl('')
  }, [])

  const clearSeekPreview = useCallback(() => {
    window.clearTimeout(seekPreviewTimeoutRef.current)
    seekPreviewTimeoutRef.current = null
    isSeekBarActiveRef.current = false
    setSeekPreviewTime(null)
  }, [])

  const restartAudioTranscodeAt = useCallback((targetSeconds, { autoplay, fastTimeline = false, immediate = false } = {}) => {
    const audioTranscodeUrl = audioTranscodeBaseUrlRef.current
    if (!audioTranscodeUrl) return false

    const player = playerRef.current
    const sourceDuration = sourceDurationRef.current
    const boundedTarget = Math.min(
      sourceDuration > 0 ? Math.max(0, sourceDuration - 0.1) : Number.MAX_SAFE_INTEGER,
      Math.max(0, Number(targetSeconds) || 0),
    )
    pendingAudioTranscodeAutoplayRef.current = autoplay
      ?? pendingAudioTranscodeAutoplayRef.current
      ?? !player?.paused
    holdCurrentFrame()
    player?.pause()
    cancelAudioTranscodeStartRequest()
    const requestId = audioTranscodeStartRequestRef.current.id
    const controller = new AbortController()
    audioTranscodeStartRequestRef.current = { controller, id: requestId }
    pendingAudioTranscodeOffsetRef.current = 0
    pendingAudioTranscodeTargetRef.current = boundedTarget
    isSeekBarActiveRef.current = false
    isSeekingRef.current = false
    pendingInitialSeekRef.current = false
    requestedSeekPositionRef.current = null
    restoredPositionRef.current = true
    clearStreamStallTimeout()
    setPlayerError('')
    setSeekPreviewTime(boundedTarget)
    setCurrentTime(boundedTarget)
    setIsBuffering(true)
    const resolveStreamStart = () => {
      audioTranscodeStartTimeoutRef.current = null
      if (fastTimeline) {
        pendingAudioTranscodeOffsetRef.current = boundedTarget
        setStreamUrl(getTimestampedAudioTranscodeUrl(audioTranscodeUrl, boundedTarget, requestId))
        return
      }
      fetchAudioTranscodeStart(audioTranscodeStartUrlRef.current, boundedTarget, { signal: controller.signal })
        .catch((error) => error.name === 'AbortError'
          ? null
          : { streamStartSeconds: boundedTarget, timelineOffsetSeconds: boundedTarget })
        .then((start) => {
          if (start === null || audioTranscodeStartRequestRef.current.id !== requestId) return
          pendingAudioTranscodeOffsetRef.current = start.timelineOffsetSeconds
          setCurrentTime(boundedTarget)
          setStreamUrl(getTimestampedAudioTranscodeUrl(audioTranscodeUrl, start.streamStartSeconds, requestId))
        })
    }
    if (immediate) {
      resolveStreamStart()
    } else {
      audioTranscodeStartTimeoutRef.current = window.setTimeout(resolveStreamStart, AUDIO_TRANSCODE_SEEK_DEBOUNCE_MS)
    }
    return true
  }, [cancelAudioTranscodeStartRequest, clearStreamStallTimeout, holdCurrentFrame])

  const applyPlaybackSource = useCallback((playbackSource, { autoplay = true, fastAudioSwitch = false, startSeconds = 0 } = {}) => {
    const {
      audioCodecLabel: nextAudioCodecLabel,
      audioProbeStatus,
      audioTracks: nextAudioTracks = [],
      audioTranscodeStartUrl,
      audioTranscodeUrl,
      durationMs,
      fallbackUrl,
      selectedAudioStreamIndex,
      url,
    } = playbackSource
    const sourceDurationSeconds = Number(durationMs || 0) / 1000
    const selectedTrack = getSelectedAudioTrack(nextAudioTracks, selectedAudioStreamIndex)

    playbackSourceRef.current = playbackSource
    sourceDurationRef.current = sourceDurationSeconds
    audioTranscodeBaseUrlRef.current = audioTranscodeUrl
    audioTranscodeStartUrlRef.current = audioTranscodeStartUrl
    fallbackStreamUrlRef.current = fallbackUrl
    audioTracksRef.current = nextAudioTracks
    selectedAudioStreamIndexRef.current = selectedTrack?.index ?? null

    setAudioTracks(nextAudioTracks)
    setSelectedAudioId(selectedTrack ? getAudioTrackId(selectedTrack) : '')
    setNeedsAudioTranscode(Boolean(audioTranscodeUrl))
    setAudioCodecLabel(nextAudioCodecLabel || formatAudioProbeStatus(audioProbeStatus))
    if (sourceDurationSeconds > 0) setDuration(sourceDurationSeconds)
    if (audioTranscodeUrl) {
      restartAudioTranscodeAt(startSeconds, { autoplay, fastTimeline: fastAudioSwitch, immediate: true })
      return
    }

    pendingAudioTranscodeAutoplayRef.current = autoplay
    fallbackPositionRef.current = startSeconds > 0 ? startSeconds : null
    restoredPositionRef.current = false
    setStreamUrl(url)
  }, [restartAudioTranscodeAt])

  const loadPlaybackSource = useCallback((audioStreamIndex, { autoplay = true, fastAudioSwitch = false, startSeconds = 0 } = {}) => {
    const requestId = playbackSourceRequestRef.current + 1
    playbackSourceRequestRef.current = requestId
    setPlayerError('')
    setIsBuffering(true)

    return fetchPlaybackSource(
      authToken,
      videoPath,
      { name: videoName, original_name: videoOriginalName },
      { audioStreamIndex },
    ).then((playbackSource) => {
      if (playbackSourceRequestRef.current !== requestId) return null
      const nextPlaybackSource = audioStreamIndex === null
        ? getInitialPlaybackSourceForItem(playbackSource, item)
        : playbackSource
      applyPlaybackSource(nextPlaybackSource, { autoplay, fastAudioSwitch, startSeconds })
      return nextPlaybackSource
    }).catch((error) => {
      if (playbackSourceRequestRef.current === requestId) {
        setPlayerError(error.message)
        setIsBuffering(false)
      }
      return null
    })
  }, [applyPlaybackSource, authToken, item, videoName, videoOriginalName, videoPath])

  const seekToPlaybackTime = useCallback((targetSeconds) => {
    const player = playerRef.current
    if (!player) return false

    const boundedTarget = Math.max(0, Number(targetSeconds) || 0)
    if (restartAudioTranscodeAt(boundedTarget)) return true
    if (!Number.isFinite(player.duration)) return false

    player.currentTime = Math.min(player.duration, boundedTarget)
    setCurrentTime(getPlaybackPosition(player, audioTranscodeOffsetRef.current))
    return true
  }, [restartAudioTranscodeAt])

  const seekBy = useCallback((seconds) => {
    const player = playerRef.current
    if (!player) return
    const targetSeconds = Math.max(0, getPlaybackPosition(player, audioTranscodeOffsetRef.current) + seconds)
    if (!seekToPlaybackTime(targetSeconds)) return
    revealControls()
  }, [revealControls, seekToPlaybackTime])

  const switchToFallbackStream = useCallback(() => {
    const fallbackUrl = fallbackStreamUrlRef.current
    if (!fallbackUrl || fallbackUrl === streamUrl || hasUsedStreamFallbackRef.current) return false

    const player = playerRef.current
    fallbackPositionRef.current = Number.isFinite(pendingAudioTranscodeTargetRef.current)
      ? pendingAudioTranscodeTargetRef.current
      : Number.isFinite(requestedSeekPositionRef.current)
        ? requestedSeekPositionRef.current
        : player ? getPlaybackPosition(player, audioTranscodeOffsetRef.current) : null
    audioTranscodeBaseUrlRef.current = ''
    audioTranscodeStartUrlRef.current = ''
    cancelAudioTranscodeStartRequest()
    pendingAudioTranscodeOffsetRef.current = 0
    pendingAudioTranscodeTargetRef.current = null
    clearStreamStallTimeout()
    hasUsedStreamFallbackRef.current = true
    isSeekingRef.current = false
    pendingInitialSeekRef.current = false
    restoredPositionRef.current = false
    holdCurrentFrame()
    setPlayerError('')
    setIsBuffering(true)
    setStreamUrl(fallbackUrl)
    return true
  }, [cancelAudioTranscodeStartRequest, clearStreamStallTimeout, holdCurrentFrame, streamUrl])

  const armStreamStallFallback = useCallback((delayMs = STREAM_STALL_FALLBACK_DELAY_MS) => {
    clearStreamStallTimeout()
    if (!fallbackStreamUrlRef.current || hasUsedStreamFallbackRef.current) return

    streamStallTimeoutRef.current = window.setTimeout(() => {
      switchToFallbackStream()
    }, delayMs)
  }, [clearStreamStallTimeout, switchToFallbackStream])

  const handleBuffering = useCallback(() => {
    setIsBuffering(true)
    armStreamStallFallback(isSeekingRef.current ? SEEK_STALL_FALLBACK_DELAY_MS : STREAM_STALL_FALLBACK_DELAY_MS)
  }, [armStreamStallFallback])

  const handleSeeking = useCallback(() => {
    const player = playerRef.current
    isSeekingRef.current = true
    requestedSeekPositionRef.current = player ? getPlaybackPosition(player, audioTranscodeOffsetRef.current) : null
    clearStreamStallTimeout()
    setIsBuffering(true)
  }, [clearStreamStallTimeout])

  const handleSeeked = useCallback(() => {
    const player = playerRef.current
    isSeekingRef.current = false
    requestedSeekPositionRef.current = null
    clearStreamStallTimeout()
    if (!player) return

    setCurrentTime(getPlaybackPosition(player, audioTranscodeOffsetRef.current))
    setIsBuffering(!player.paused && player.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
    if (!Number.isFinite(pendingAudioTranscodeTargetRef.current)) clearSeekPreview()
    if (pendingInitialSeekRef.current) {
      pendingInitialSeekRef.current = false
      player.play().catch(() => setShowControls(true))
    }
  }, [clearSeekPreview, clearStreamStallTimeout])

  const handlePlaying = useCallback(() => {
    clearStreamStallTimeout()
    isSeekingRef.current = false
    pendingInitialSeekRef.current = false
    requestedSeekPositionRef.current = null
    pendingAudioTranscodeTargetRef.current = null
    pendingAudioTranscodeAutoplayRef.current = null
    clearSeekPreview()
    clearHeldFrame()
    setIsBuffering(false)
  }, [clearHeldFrame, clearSeekPreview, clearStreamStallTimeout])

  useEffect(() => {
    progressContextRef.current = { item, profileId, video }
  }, [item, profileId, video])

  useEffect(() => clearStreamStallTimeout, [clearStreamStallTimeout])

  useEffect(() => () => window.clearTimeout(seekPreviewTimeoutRef.current), [])

  useEffect(() => {
    writeSubtitleSettings(subtitleSettings)
  }, [subtitleSettings])

  useEffect(() => {
    let ignore = false
    let nextSubtitleUrl = ''

    clearStreamStallTimeout()
    fallbackStreamUrlRef.current = ''
    fallbackPositionRef.current = null
    playbackSourceRef.current = null
    sourceDurationRef.current = 0
    audioTranscodeBaseUrlRef.current = ''
    audioTranscodeOffsetRef.current = 0
    audioTranscodeStartUrlRef.current = ''
    cancelAudioTranscodeStartRequest()
    pendingAudioTranscodeOffsetRef.current = 0
    pendingAudioTranscodeTargetRef.current = null
    pendingAudioTranscodeAutoplayRef.current = null
    hasUsedStreamFallbackRef.current = false
    isSeekingRef.current = false
    pendingInitialSeekRef.current = false
    requestedSeekPositionRef.current = null
    restoredPositionRef.current = false
    queueMicrotask(() => {
      if (!ignore) {
        setStreamUrl('')
        setNeedsAudioTranscode(false)
        setAudioCodecLabel('')
        setAudioTracks([])
        setSelectedAudioId('')
        setIsAudioPanelOpen(false)
        clearHeldFrame()
        clearSeekPreview()
        setSubtitleCues([])
        setSubtitleUrl('')
        setEmbeddedSubtitleTracks([])
        setEmbeddedSubtitleTrackUrl('')
        setSelectedSubtitleId('')
      }
    })
    audioTracksRef.current = []
    selectedAudioStreamIndexRef.current = null
    embeddedSubtitleTracksRef.current = []
    embeddedSubtitleTrackUrlRef.current = ''
    embeddedSubtitleWindowRequestsRef.current.clear()
    externalSubtitleCuesRef.current = []
    selectedSubtitleIdRef.current = ''

    const playbackSourcePromise = loadPlaybackSource(null, {
      autoplay: true,
      startSeconds: initialResumePositionRef.current,
    })

    fetchPlaybackMarkers(authToken, markerFolderName).then((nextMarkers) => {
      if (!ignore) setMarkers(nextMarkers)
    })

    async function loadExternalSubtitleTrack() {
      try {
        const externalTrack = await fetchSubtitleTrack(subtitlePath)
        if (ignore) {
          if (externalTrack.url) URL.revokeObjectURL(externalTrack.url)
          return
        }
        nextSubtitleUrl = externalTrack.url
        externalSubtitleCuesRef.current = createSubtitleCues(externalTrack.cues)
        setSubtitleUrl(externalTrack.url)
        if (externalTrack.url && !selectedSubtitleIdRef.current) {
          selectSubtitleTrack('external')
        }
      } catch {
        // Embedded subtitle discovery continues when an external track is unavailable.
      }
    }

    const externalSubtitlePromise = loadExternalSubtitleTrack()

    async function loadEmbeddedSubtitleTracks() {
      const playbackSource = await playbackSourcePromise
      const tracks = await fetchEmbeddedSubtitleTracks(playbackSource?.embeddedSubtitlesUrl)
      await externalSubtitlePromise
      if (ignore) return

      embeddedSubtitleTracksRef.current = tracks
      setEmbeddedSubtitleTracks(tracks)
      if (!selectedSubtitleIdRef.current && tracks.length) {
        selectSubtitleTrack(getEmbeddedSubtitleTrackId(getPreferredEmbeddedSubtitleTrack(tracks)), tracks)
      }
    }

    loadEmbeddedSubtitleTracks().catch(() => {
      // External subtitles remain usable if embedded track discovery fails.
    })

    return () => {
      ignore = true
      playbackSourceRequestRef.current += 1
      cancelAudioTranscodeStartRequest()
      if (nextSubtitleUrl) URL.revokeObjectURL(nextSubtitleUrl)
    }
  }, [authToken, cancelAudioTranscodeStartRequest, clearHeldFrame, clearSeekPreview, clearStreamStallTimeout, loadPlaybackSource, markerFolderName, selectSubtitleTrack, subtitlePath])

  useEffect(() => {
    if (!embeddedSubtitleTrackUrl) return

    const windows = [getEmbeddedSubtitleWindow(currentTime)]
    const activeBucketStart = Math.floor(Math.max(0, currentTime) / EMBEDDED_SUBTITLE_WINDOW_SECONDS) * EMBEDDED_SUBTITLE_WINDOW_SECONDS
    if (currentTime - activeBucketStart >= EMBEDDED_SUBTITLE_WINDOW_SECONDS - EMBEDDED_SUBTITLE_PREFETCH_LEAD_SECONDS) {
      windows.push(getEmbeddedSubtitleWindow(activeBucketStart + EMBEDDED_SUBTITLE_WINDOW_SECONDS))
    }

    windows.forEach(({ durationSeconds, startSeconds }) => {
      const requestKey = `${embeddedSubtitleTrackUrl}:${startSeconds}:${durationSeconds}`
      if (embeddedSubtitleWindowRequestsRef.current.has(requestKey)) return
      embeddedSubtitleWindowRequestsRef.current.add(requestKey)

      fetchEmbeddedSubtitleWindow(embeddedSubtitleTrackUrl, startSeconds, durationSeconds, {
        onCues: (cues) => {
          if (embeddedSubtitleTrackUrlRef.current === embeddedSubtitleTrackUrl) {
            setSubtitleCues((currentCues) => mergeSubtitleCues(currentCues, createSubtitleCues(cues)))
          }
        },
      }).then(({ cues }) => {
        if (embeddedSubtitleTrackUrlRef.current === embeddedSubtitleTrackUrl) {
          setSubtitleCues((currentCues) => mergeSubtitleCues(currentCues, createSubtitleCues(cues)))
        }
      }).catch(() => {
        embeddedSubtitleWindowRequestsRef.current.delete(requestKey)
      })
    })
  }, [currentTime, embeddedSubtitleTrackUrl])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !streamUrl) return undefined

    let hls
    let ignore = false

    async function attachStream() {
      if (!isHlsVideo) {
        audioTranscodeOffsetRef.current = audioTranscodeBaseUrlRef.current
          ? pendingAudioTranscodeOffsetRef.current
          : 0
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

      hls = new Hls({
        backBufferLength: 30,
        maxBufferLength: 90,
        maxBufferSize: 120 * 1000 * 1000,
        maxMaxBufferLength: 180,
      })
      hls.loadSource(streamUrl)
      hls.attachMedia(player)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal && !switchToFallbackStream()) {
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
      clearStreamStallTimeout()
    }
  }, [clearStreamStallTimeout, isHlsVideo, streamUrl, switchToFallbackStream])

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
    if (isPlaying && !isSubtitlePanelOpen && !isAudioPanelOpen) {
      controlsTimeoutRef.current = window.setTimeout(() => setShowControls(false), CONTROLS_HIDE_DELAY_MS)
    }
    return () => window.clearTimeout(controlsTimeoutRef.current)
  }, [isAudioPanelOpen, isPlaying, isSubtitlePanelOpen])

  function handleLoadedMetadata() {
    const player = playerRef.current
    if (!player) return

    clearStreamStallTimeout()
    const playbackDuration = getPlaybackDuration(player.duration, sourceDurationRef.current, audioTranscodeOffsetRef.current)
    setDuration(playbackDuration)
    const pendingTranscodeTarget = pendingAudioTranscodeTargetRef.current
    if (Number.isFinite(pendingTranscodeTarget) && audioTranscodeBaseUrlRef.current) {
      const fragmentTarget = pendingTranscodeTarget - audioTranscodeOffsetRef.current
      const hasFragmentDuration = Number.isFinite(player.duration) && player.duration > 0
      const boundedFragmentTarget = hasFragmentDuration
        ? Math.min(Math.max(0, player.duration - 0.05), Math.max(0, fragmentTarget))
        : Math.max(0, fragmentTarget)
      if (boundedFragmentTarget > 0.05) {
        isSeekingRef.current = true
        pendingInitialSeekRef.current = pendingAudioTranscodeAutoplayRef.current !== false
        requestedSeekPositionRef.current = pendingTranscodeTarget
        player.currentTime = boundedFragmentTarget
        setCurrentTime(pendingTranscodeTarget)
        setIsBuffering(true)
        setTextTracksHidden(player)
        return
      }
    }
    if (!restoredPositionRef.current) {
      const fallbackSeconds = fallbackPositionRef.current
      const targetSeconds = Number.isFinite(fallbackSeconds)
        ? fallbackSeconds
        : Number(resumeEntry?.position_ms || 0) / 1000
      if (targetSeconds > 0 && targetSeconds < playbackDuration - 2) {
        if (restartAudioTranscodeAt(targetSeconds, { autoplay: true, immediate: true })) return
        isSeekingRef.current = true
        pendingInitialSeekRef.current = true
        requestedSeekPositionRef.current = targetSeconds
        player.currentTime = targetSeconds
        setCurrentTime(targetSeconds)
        setIsBuffering(true)
        fallbackPositionRef.current = null
        restoredPositionRef.current = true
        setTextTracksHidden(player)
        return
      }
      fallbackPositionRef.current = null
      restoredPositionRef.current = true
    }
    if (!heldFrameUrl) setIsBuffering(false)
    setTextTracksHidden(player)
    const shouldAutoplay = pendingAudioTranscodeAutoplayRef.current
    if (shouldAutoplay !== false) player.play().catch(() => setShowControls(true))
  }

  function handleTimeUpdate() {
    const player = playerRef.current
    if (!player) return
    const playbackDuration = getPlaybackDuration(player.duration, sourceDurationRef.current, audioTranscodeOffsetRef.current)
    setDuration(playbackDuration)

    const pendingTranscodeTarget = pendingAudioTranscodeTargetRef.current
    if (Number.isFinite(pendingTranscodeTarget)) {
      setCurrentTime(pendingTranscodeTarget)
      return
    }
    if (isSeekBarActiveRef.current || Number.isFinite(seekPreviewTime)) {
      return
    }

    setCurrentTime(getPlaybackPosition(player, audioTranscodeOffsetRef.current))
    persistProgress()
  }

  function handleSeekInput(event) {
    const targetSeconds = clampPlaybackSeekTime(event.target.value, duration)
    window.clearTimeout(seekPreviewTimeoutRef.current)
    setSeekPreviewTime(targetSeconds)
    setCurrentTime(targetSeconds)
  }

  function handleSeek(event) {
    if (isSeekBarActiveRef.current) {
      handleSeekInput(event)
      return
    }
    commitSeekBarTime(event.target.value)
  }

  function handleSeekPointerDown(event) {
    isSeekBarActiveRef.current = true
    setSeekPreviewTime(clampPlaybackSeekTime(event.currentTarget.value, duration))
  }

  function handleSeekPointerUp(event) {
    commitSeekBarTime(event.currentTarget.value)
  }

  function handleSeekPointerCancel() {
    isSeekBarActiveRef.current = false
    if (!Number.isFinite(pendingAudioTranscodeTargetRef.current)) {
      seekPreviewTimeoutRef.current = window.setTimeout(() => setSeekPreviewTime(null), 250)
    }
  }

  function commitSeekBarTime(value) {
    const targetSeconds = clampPlaybackSeekTime(value, duration)
    isSeekBarActiveRef.current = false
    window.clearTimeout(seekPreviewTimeoutRef.current)
    setSeekPreviewTime(targetSeconds)
    setCurrentTime(targetSeconds)
    if (!seekToPlaybackTime(targetSeconds)) {
      seekPreviewTimeoutRef.current = window.setTimeout(() => setSeekPreviewTime(null), 250)
      return
    }
    revealControls()
    if (!audioTranscodeBaseUrlRef.current) {
      seekPreviewTimeoutRef.current = window.setTimeout(() => setSeekPreviewTime(null), 250)
    }
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

  function handleSubtitleSetting(event) {
    const { name, value } = event.target
    setSubtitleSettings((currentSettings) => ({ ...currentSettings, [name]: value }))
  }

  function handleSubtitleTrackChange(event) {
    selectSubtitleTrack(event.target.value)
  }

  function handleAudioTrackChange(event) {
    const audioId = event.target.value
    const selectedTrack = audioTracksRef.current.find((track) => getAudioTrackId(track) === audioId)
    if (!selectedTrack || selectedTrack.index === selectedAudioStreamIndexRef.current) return

    const player = playerRef.current
    const switchPosition = player
      ? getPlaybackPosition(player, audioTranscodeOffsetRef.current)
      : currentTime
    const shouldResume = player ? !player.paused : isPlaying

    if (!audioTranscodeBaseUrlRef.current && selectNativeAudioTrack(player, selectedTrack, audioTracksRef.current)) {
      selectedAudioStreamIndexRef.current = selectedTrack.index
      if (playbackSourceRef.current) {
        playbackSourceRef.current = {
          ...playbackSourceRef.current,
          audioCodec: String(selectedTrack.codec || ''),
          audioCodecLabel: getAudioTrackCodecLabel(selectedTrack),
          audioTranscodeStartUrl: '',
          audioTranscodeUrl: '',
          browserAudioSupported: true,
          selectedAudioStreamIndex: selectedTrack.index,
          url: playbackSourceRef.current.directUrl || playbackSourceRef.current.url,
        }
      }
      setSelectedAudioId(audioId)
      setAudioCodecLabel(getAudioTrackCodecLabel(selectedTrack))
      setNeedsAudioTranscode(false)
      revealControls()
      return
    }

    selectedAudioStreamIndexRef.current = selectedTrack.index
    setSelectedAudioId(audioId)
    holdCurrentFrame()
    player?.pause()
    cancelAudioTranscodeStartRequest()
    clearStreamStallTimeout()
    hasUsedStreamFallbackRef.current = false
    pendingAudioTranscodeOffsetRef.current = 0
    pendingAudioTranscodeTargetRef.current = null
    pendingAudioTranscodeAutoplayRef.current = shouldResume
    fallbackPositionRef.current = switchPosition
    restoredPositionRef.current = false
    setSeekPreviewTime(switchPosition)
    setCurrentTime(switchPosition)
    setIsBuffering(true)
    setPlayerError('')
    const cachedPlaybackSource = playbackSourceRef.current
    const nextPlaybackSource = createPlaybackSourceForAudioTrack(cachedPlaybackSource, selectedTrack)
    if (nextPlaybackSource) {
      applyPlaybackSource(nextPlaybackSource, {
        autoplay: shouldResume,
        startSeconds: switchPosition,
      })
    } else {
      loadPlaybackSource(selectedTrack.index, {
        autoplay: shouldResume,
        startSeconds: switchPosition,
      })
    }
    revealControls()
  }

  function handleSubtitlePosition(event) {
    const positionPercent = clampSubtitlePosition(event.target.value)
    setSubtitleSettings((currentSettings) => ({ ...currentSettings, positionPercent }))
  }

  function handleSubtitleDelayInput(event) {
    const rawValue = event.target.value
    setSubtitleDelayInput(rawValue)
    if (rawValue === '') return

    const numericValue = Number(rawValue)
    if (!Number.isFinite(numericValue)) return

    const nextDelay = clampSubtitleDelay(numericValue)
    setSubtitleSettings((currentSettings) => ({ ...currentSettings, delaySeconds: nextDelay }))
    if (nextDelay !== numericValue) setSubtitleDelayInput(formatSubtitleDelay(nextDelay))
  }

  function handleSubtitleDelayBlur() {
    setSubtitleDelay(subtitleSettings.delaySeconds)
  }

  function setSubtitleDelay(value) {
    const nextDelay = clampSubtitleDelay(value)
    setSubtitleDelayInput(formatSubtitleDelay(nextDelay))
    setSubtitleSettings((currentSettings) => ({ ...currentSettings, delaySeconds: nextDelay }))
  }

  function handleOpenEpisode(nextEpisode, { complete = false } = {}) {
    if (!nextEpisode) return
    persistProgress({ complete, force: true })
    onOpenVideo(nextEpisode)
  }

  function handleBack() {
    persistProgress({ force: true })
    onBack()
  }

  return (
    <main
      className={`watch-page ${showControls ? 'controls-visible' : ''} ${shouldHideCursor ? 'cursor-hidden' : ''}`}
      onMouseDown={revealControls}
      onMouseMove={revealControls}
      ref={shellRef}
    >
      <video
        className="watch-video"
        crossOrigin={isAudioTranscodeStream ? 'anonymous' : undefined}
        onClick={toggleControls}
        onEnded={() => {
          clearHeldFrame()
          setIsPlaying(false)
          persistProgress({ complete: true, force: true })
          setShowControls(true)
        }}
        onError={() => {
          clearHeldFrame()
          if (switchToFallbackStream()) return
          if (streamUrl) setPlayerError('The browser could not play this video format.')
          setIsBuffering(false)
        }}
        onLoadedData={() => {
          if (Number.isFinite(pendingAudioTranscodeTargetRef.current)) return
          clearHeldFrame()
          setIsBuffering(false)
        }}
        onLoadedMetadata={handleLoadedMetadata}
        onLoadStart={handleBuffering}
        onPause={() => {
          setIsPlaying(false)
          persistProgress({ force: true })
        }}
        onPlay={() => {
          setIsPlaying(true)
          if (!Number.isFinite(pendingAudioTranscodeTargetRef.current)) {
            setIsBuffering(false)
          }
        }}
        onPlaying={handlePlaying}
        onSeeked={handleSeeked}
        onSeeking={handleSeeking}
        onTimeUpdate={handleTimeUpdate}
        onWaiting={handleBuffering}
        playsInline
        preload="auto"
        ref={playerRef}
      >
        {subtitleUrl && selectedSubtitleId === 'external' && (
          <track
            key={subtitleUrl}
            kind="subtitles"
            label="Eksternal"
            ref={setSubtitleTrackRef}
            src={subtitleUrl}
            srcLang="id"
          />
        )}
      </video>

      {heldFrameUrl && isBuffering && !playerError && (
        <img alt="" aria-hidden="true" className="watch-held-frame" src={heldFrameUrl} />
      )}

      {activeSubtitleCues.length > 0 && (
        <div
          aria-hidden="true"
          className="watch-subtitles"
          style={subtitlePositionStyle}
        >
          {activeSubtitleCues.map((cue) => (
            <p className="watch-subtitle-cue" key={`${cue.startTime}-${cue.endTime}-${cue.text}`} style={subtitleCueStyle}>
              {cue.lines.map((line, index) => <span className="watch-subtitle-line" key={`${line}-${index}`}>{line}</span>)}
            </p>
          ))}
        </div>
      )}

      <div className="watch-topbar">
        <button aria-label="Back" className="watch-icon-button" onClick={handleBack} type="button">
          <ArrowLeft size={24} />
        </button>
        <div>
          <p>{episodeLabel}</p>
          <div className="watch-title-row">
            <h1>{isSeries ? getTitle(item) : video.name || getTitle(item)}</h1>
            {needsAudioTranscode && (
              <aside className="watch-transcode-notice">
                <AlertTriangle aria-hidden="true" size={15} />
                <span>{selectedAudioNoticeLabel ? `${selectedAudioNoticeLabel} perlu ditranscode.` : 'Audio video ini perlu ditranscode.'}</span>
              </aside>
            )}
            {selectedAudioLabel && !needsAudioTranscode && (
              <span className="watch-audio-codec">Audio: {selectedAudioLabel}</span>
            )}
          </div>
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
          <button onClick={() => seekToPlaybackTime(markers.introEndSeconds)} type="button">
            Skip intro
            <SkipForward size={18} />
          </button>
        )}
        {showNextEpisode && (
          <button onClick={() => handleOpenEpisode(nextVideo, { complete: true })} type="button">
            Next episode
            <SkipForward size={18} />
          </button>
        )}
      </div>

      <div className="watch-controls">
        {isAudioPanelOpen && (
          <section aria-label="Audio settings" className="watch-subtitle-panel watch-audio-panel" id="audio-settings">
            <div className="watch-subtitle-panel-header">
              <div>
                <h2>Audio</h2>
                <p>{selectedAudioTrack ? getAudioTrackMetaLabel(selectedAudioTrack) : 'No audio track metadata is available.'}</p>
              </div>
              <button
                aria-label="Close audio settings"
                className="watch-subtitle-close"
                onClick={() => setIsAudioPanelOpen(false)}
                type="button"
              >
                <X size={18} />
              </button>
            </div>
            <label className="watch-subtitle-setting watch-audio-select">
              <span>Track</span>
              <select aria-label="Audio track" onChange={handleAudioTrackChange} value={selectedAudioId}>
                {audioTracks.map((track) => (
                  <option key={getAudioTrackId(track)} value={getAudioTrackId(track)}>
                    {getAudioTrackOptionLabel(track)}
                  </option>
                ))}
              </select>
            </label>
            <div className="watch-audio-track-list">
              {audioTracks.map((track) => {
                const audioId = getAudioTrackId(track)
                const isSelected = audioId === selectedAudioId
                return (
                  <button
                    aria-pressed={isSelected}
                    className={`watch-audio-track ${isSelected ? 'active' : ''}`}
                    key={audioId}
                    onClick={() => handleAudioTrackChange({ target: { value: audioId } })}
                    type="button"
                  >
                    <span className="watch-audio-track-title">{getAudioTrackDisplayLabel(track, { includeCodec: false })}</span>
                    <span className="watch-audio-track-meta">{getAudioTrackMetaLabel(track)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )}
        {isSubtitlePanelOpen && (
          <section aria-label="Subtitle settings" className="watch-subtitle-panel" id="subtitle-settings">
            <div className="watch-subtitle-panel-header">
              <div>
                <h2>Subtitle settings</h2>
                <p>{hasSubtitleTrack ? 'Customize subtitle display and timing.' : 'No subtitle is available for this video.'}</p>
              </div>
              <button
                aria-label="Close subtitle settings"
                className="watch-subtitle-close"
                onClick={() => setIsSubtitlePanelOpen(false)}
                type="button"
              >
                <X size={18} />
              </button>
            </div>
            <label className="watch-subtitle-toggle">
              <input checked={hasSubtitleTrack && isCaptionsEnabled} disabled={!hasSubtitleTrack} onChange={toggleCaptions} type="checkbox" />
              <span>Show subtitles</span>
            </label>
            <div className="watch-subtitle-settings-grid">
              <label className="watch-subtitle-setting">
                <span>Subtitle</span>
                <select aria-label="Subtitle track" onChange={handleSubtitleTrackChange} value={selectedSubtitleId}>
                  {subtitleTracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}
                </select>
              </label>
              <div className="watch-subtitle-setting watch-subtitle-delay-setting">
                <span>Sync delay</span>
                <div className="watch-subtitle-delay">
                  <button aria-label="Slow down subtitles by 0.5 seconds" onClick={() => setSubtitleDelay(subtitleSettings.delaySeconds - SUBTITLE_DELAY_STEP_SECONDS)} type="button">-</button>
                  <label>
                    <input
                      aria-label="Subtitle sync delay in seconds"
                      max={SUBTITLE_DELAY_LIMIT_SECONDS}
                      min={-SUBTITLE_DELAY_LIMIT_SECONDS}
                      onBlur={handleSubtitleDelayBlur}
                      onChange={handleSubtitleDelayInput}
                      step="0.1"
                      type="number"
                      value={subtitleDelayInput}
                    />
                    <span>s</span>
                  </label>
                  <button aria-label="Speed up subtitles by 0.5 seconds" onClick={() => setSubtitleDelay(subtitleSettings.delaySeconds + SUBTITLE_DELAY_STEP_SECONDS)} type="button">+</button>
                </div>
                <small>- slower, + faster. Maximum 50 seconds.</small>
              </div>
              <label className="watch-subtitle-setting">
                <span>Font</span>
                <select name="fontFamily" onChange={handleSubtitleSetting} value={subtitleSettings.fontFamily}>
                  <option value="sans">Arial</option>
                  <option value="system">System UI</option>
                  <option value="verdana">Verdana</option>
                  <option value="helvetica">Helvetica</option>
                  <option value="tahoma">Tahoma</option>
                  <option value="serif">Serif</option>
                  <option value="times">Times New Roman</option>
                  <option value="mono">Monospace</option>
                  <option value="rounded">Rounded</option>
                  <option value="condensed">Condensed</option>
                </select>
              </label>
              <label className="watch-subtitle-setting watch-subtitle-range-setting">
                <span>Font size: {subtitleSettings.fontSizePx}px</span>
                <input
                  max={SUBTITLE_FONT_SIZE_MAX_PX}
                  min={SUBTITLE_FONT_SIZE_MIN_PX}
                  name="fontSizePx"
                  onChange={handleSubtitleSetting}
                  step="1"
                  type="range"
                  value={subtitleSettings.fontSizePx}
                />
              </label>
              <label className="watch-subtitle-setting">
                <span>Font style</span>
                <select name="fontStyle" onChange={handleSubtitleSetting} value={subtitleSettings.fontStyle}>
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                  <option value="italic">Italic</option>
                  <option value="bold-italic">Bold italic</option>
                </select>
              </label>
              <label className="watch-subtitle-setting">
                <span>Text color</span>
                <select name="color" onChange={handleSubtitleSetting} value={subtitleSettings.color}>
                  <option value="white">White</option>
                  <option value="yellow">Yellow</option>
                  <option value="green">Green</option>
                  <option value="cyan">Cyan</option>
                </select>
              </label>
              <label className="watch-subtitle-setting">
                <span>Background</span>
                <select name="background" onChange={handleSubtitleSetting} value={subtitleSettings.background}>
                  <option value="none">None</option>
                  <option value="translucent">Translucent</option>
                  <option value="solid">Solid</option>
                </select>
              </label>
              <label className="watch-subtitle-setting watch-subtitle-range-setting">
                <span>Outline thickness: {subtitleSettings.outlineWidth}px</span>
                <input
                  max={SUBTITLE_OUTLINE_MAX_PX}
                  min={SUBTITLE_OUTLINE_MIN_PX}
                  name="outlineWidth"
                  onChange={handleSubtitleSetting}
                  step="0.5"
                  type="range"
                  value={subtitleSettings.outlineWidth}
                />
              </label>
              <label className="watch-subtitle-setting watch-subtitle-range-setting">
                <span>Vertical position: {subtitleSettings.positionPercent}%</span>
                <input
                  max={SUBTITLE_POSITION_MAX_PERCENT}
                  min={SUBTITLE_POSITION_MIN_PERCENT}
                  onChange={handleSubtitlePosition}
                  step="1"
                  type="range"
                  value={subtitleSettings.positionPercent}
                />
              </label>
            </div>
          </section>
        )}
        <input
          aria-label="Seek video"
          className="watch-seek"
          max={duration || 0}
          min="0"
          onChange={handleSeek}
          onInput={handleSeekInput}
          onPointerCancel={handleSeekPointerCancel}
          onPointerDown={handleSeekPointerDown}
          onPointerUp={handleSeekPointerUp}
          step="0.1"
          type="range"
          value={Math.min(visiblePlaybackTime, duration || 0)}
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
            <span className="watch-time">{formatPlaybackTime(visiblePlaybackTime)} / {formatPlaybackTime(duration)}</span>
          </div>
          <div className="watch-controls-group">
            <button
              aria-label="Previous episode"
              className="watch-icon-button"
              disabled={!previousVideo}
              onClick={() => handleOpenEpisode(previousVideo)}
              type="button"
            >
              <SkipBack size={20} />
            </button>
            <button
              aria-label="Next episode"
              className="watch-icon-button"
              disabled={!nextVideo}
              onClick={() => handleOpenEpisode(nextVideo, { complete: true })}
              type="button"
            >
              <SkipForward size={20} />
            </button>
            {hasAudioTrackChoices && (
              <button
                aria-controls="audio-settings"
                aria-expanded={isAudioPanelOpen}
                aria-label="Audio settings"
                className={`watch-icon-button ${isAudioPanelOpen ? 'active' : ''}`}
                onClick={() => {
                  setIsAudioPanelOpen((isOpen) => !isOpen)
                  setIsSubtitlePanelOpen(false)
                }}
                type="button"
              >
                <AudioLines size={22} />
              </button>
            )}
            {hasSubtitleTrack && (
              <button
                aria-controls="subtitle-settings"
                aria-expanded={isSubtitlePanelOpen}
                aria-label="Subtitle settings"
                className={`watch-icon-button ${isCaptionsEnabled ? 'active' : ''}`}
                onClick={() => {
                  setIsSubtitlePanelOpen((isOpen) => !isOpen)
                  setIsAudioPanelOpen(false)
                }}
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
  const episodeTitle = getEpisodeHistoryLabel({
    ...video,
    media_path: video.path,
    media_title: video.title || video.name,
  })
  return {
    profile_id: profileId,
    media_path: video.path,
    media_title: isMovie ? getTitle(item) : episodeTitle,
    series_title: isMovie ? null : getTitle(item),
    series_path: isMovie ? null : getItemPath(item),
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

function formatAudioProbeStatus(status) {
  const normalizedStatus = String(status || '').trim()
  if (!normalizedStatus || normalizedStatus === 'no-audio' || normalizedStatus === 'ok') return ''
  return `Probe ${normalizedStatus}`
}

function clampPlaybackSeekTime(seconds, duration = 0) {
  const numericSeconds = Number(seconds)
  if (!Number.isFinite(numericSeconds)) return 0
  const maxDuration = Number(duration)
  const upperBound = Number.isFinite(maxDuration) && maxDuration > 0
    ? Math.max(0, maxDuration - 0.1)
    : Number.MAX_SAFE_INTEGER
  return Math.min(upperBound, Math.max(0, numericSeconds))
}

function getPlaybackDuration(playerDuration, sourceDuration, sourceOffset = 0) {
  const numericPlayerDuration = Number(playerDuration)
  const durations = [Number(sourceDuration)]
    .filter((value) => Number.isFinite(value) && value > 0)
  if (Number.isFinite(numericPlayerDuration) && numericPlayerDuration > 0) {
    durations.push(numericPlayerDuration + Math.max(0, Number(sourceOffset) || 0))
  }
  return durations.length ? Math.max(...durations) : 0
}

function getPlaybackPosition(player, sourceOffset = 0) {
  const playerTime = Number(player?.currentTime)
  return Math.max(0, (Number.isFinite(playerTime) ? playerTime : 0) + (Number(sourceOffset) || 0))
}

function captureVideoFrame(player) {
  const videoWidth = Number(player?.videoWidth) || 0
  const videoHeight = Number(player?.videoHeight) || 0
  if (!player || player.readyState < 2 || videoWidth <= 0 || videoHeight <= 0) return ''

  const scale = Math.min(1, 1280 / videoWidth, 720 / videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(videoWidth * scale))
  canvas.height = Math.max(1, Math.round(videoHeight * scale))

  try {
    const context = canvas.getContext('2d')
    if (!context) return ''
    context.drawImage(player, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    return ''
  }
}

function clampSubtitleDelay(seconds) {
  const numericSeconds = Number(seconds)
  if (!Number.isFinite(numericSeconds)) return 0
  return Math.min(SUBTITLE_DELAY_LIMIT_SECONDS, Math.max(-SUBTITLE_DELAY_LIMIT_SECONDS, numericSeconds))
}

function formatSubtitleDelay(seconds) {
  return String(Number(clampSubtitleDelay(seconds).toFixed(1)))
}

function clampSubtitlePosition(positionPercent) {
  const numericPosition = Number(positionPercent)
  if (!Number.isFinite(numericPosition)) return DEFAULT_SUBTITLE_SETTINGS.positionPercent
  return Math.min(SUBTITLE_POSITION_MAX_PERCENT, Math.max(SUBTITLE_POSITION_MIN_PERCENT, numericPosition))
}

function clampSubtitleOutline(outlineWidth) {
  const numericOutlineWidth = Number(outlineWidth)
  if (!Number.isFinite(numericOutlineWidth)) return DEFAULT_SUBTITLE_SETTINGS.outlineWidth
  return Math.min(SUBTITLE_OUTLINE_MAX_PX, Math.max(SUBTITLE_OUTLINE_MIN_PX, numericOutlineWidth))
}

function clampSubtitleFontSize(fontSizePx) {
  const numericFontSize = Number(fontSizePx)
  if (!Number.isFinite(numericFontSize)) return DEFAULT_SUBTITLE_SETTINGS.fontSizePx
  return Math.min(SUBTITLE_FONT_SIZE_MAX_PX, Math.max(SUBTITLE_FONT_SIZE_MIN_PX, numericFontSize))
}

function readSubtitleSettings() {
  try {
    const storedSettings = JSON.parse(window.localStorage.getItem(SUBTITLE_SETTINGS_STORAGE_KEY) || '{}')
    const legacyPositionPercent = {
      top: 16,
      middle: 50,
      bottom: DEFAULT_SUBTITLE_SETTINGS.positionPercent,
    }[storedSettings.position]
    const legacyOutlineWidth = {
      none: 0,
      raised: 2,
      shadow: 2,
      uniform: DEFAULT_SUBTITLE_SETTINGS.outlineWidth,
    }[storedSettings.outline]
    const legacyFontSizePx = {
      small: 20,
      medium: DEFAULT_SUBTITLE_SETTINGS.fontSizePx,
      large: 34,
      'extra-large': 42,
    }[storedSettings.fontSize]
    return {
      ...DEFAULT_SUBTITLE_SETTINGS,
      ...storedSettings,
      delaySeconds: clampSubtitleDelay(storedSettings.delaySeconds),
      fontSizePx: clampSubtitleFontSize(storedSettings.fontSizePx ?? legacyFontSizePx),
      outlineWidth: clampSubtitleOutline(storedSettings.outlineWidth ?? legacyOutlineWidth),
      positionPercent: clampSubtitlePosition(storedSettings.positionPercent ?? legacyPositionPercent),
    }
  } catch {
    return DEFAULT_SUBTITLE_SETTINGS
  }
}

function writeSubtitleSettings(settings) {
  try {
    window.localStorage.setItem(SUBTITLE_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Playback settings remain usable if local storage is unavailable.
  }
}

function getPreferredEmbeddedSubtitleTrack(tracks) {
  return tracks.find((track) => track.default)
    || tracks.find((track) => ['id', 'ind', 'indonesian'].includes(String(track.language || '').toLowerCase()))
    || tracks.find((track) => ['en', 'eng', 'english'].includes(String(track.language || '').toLowerCase()))
    || tracks[0]
}

function getInitialPlaybackSourceForItem(playbackSource, item) {
  const preferredTrack = getPreferredRegionalAudioTrack(playbackSource?.audioTracks, item)
  if (!preferredTrack) return playbackSource

  const selectedTrack = getSelectedAudioTrack(playbackSource.audioTracks, playbackSource.selectedAudioStreamIndex)
  if (!selectedTrack || Number(selectedTrack.index) === Number(preferredTrack.index)) return playbackSource
  if (playbackSource.isHlsStream) return playbackSource

  const preferredPlaybackSource = createPlaybackSourceForAudioTrack(playbackSource, preferredTrack)
  if (!preferredPlaybackSource) return playbackSource
  if (preferredPlaybackSource.audioTranscodeUrl && !playbackSource.audioTranscodeUrl) return playbackSource
  return preferredPlaybackSource
}

function getSelectedAudioTrack(tracks, selectedAudioStreamIndex) {
  const hasSelectedIndex = selectedAudioStreamIndex !== null
    && selectedAudioStreamIndex !== undefined
    && selectedAudioStreamIndex !== ''
  const numericSelectedIndex = Number(selectedAudioStreamIndex)
  return (hasSelectedIndex && Number.isFinite(numericSelectedIndex)
    ? tracks.find((track) => Number(track.index) === numericSelectedIndex)
    : null)
    || tracks.find((track) => track.default)
    || tracks[0]
    || null
}

function createPlaybackSourceForAudioTrack(playbackSource, track) {
  if (!playbackSource || !track) return null

  const selectedAudioStreamIndex = normalizeAudioStreamIndex(track.index)
  if (selectedAudioStreamIndex === null) return null

  const defaultAudioStreamIndex = normalizeAudioStreamIndex(playbackSource.defaultAudioStreamIndex)
  const selectedNonDefaultAudio = defaultAudioStreamIndex !== null && selectedAudioStreamIndex !== defaultAudioStreamIndex
  const needsAudioTranscode = !playbackSource.isHlsStream && (
    track.browserSupported === false || selectedNonDefaultAudio
  )
  const baseAudioTranscodeUrl = playbackSource.baseAudioTranscodeUrl || playbackSource.audioTranscodeUrl || ''
  const baseAudioTranscodeStartUrl = playbackSource.baseAudioTranscodeStartUrl || playbackSource.audioTranscodeStartUrl || ''
  const audioTranscodeUrl = needsAudioTranscode
    ? getAudioStreamUrl(baseAudioTranscodeUrl, selectedAudioStreamIndex)
    : ''
  const audioTranscodeStartUrl = needsAudioTranscode
    ? getAudioStreamUrl(baseAudioTranscodeStartUrl, selectedAudioStreamIndex)
    : ''

  if (needsAudioTranscode && (!audioTranscodeUrl || !audioTranscodeStartUrl)) return null

  return {
    ...playbackSource,
    audioCodec: String(track.codec || ''),
    audioCodecLabel: getAudioTrackCodecLabel(track),
    audioProbeStatus: playbackSource.audioProbeStatus || '',
    audioTranscodeStartUrl,
    audioTranscodeUrl,
    browserAudioSupported: track.browserSupported !== false,
    fallbackUrl: playbackSource.isHlsStream || selectedNonDefaultAudio ? '' : playbackSource.fallbackUrl,
    selectedAudioStreamIndex,
    url: audioTranscodeUrl || playbackSource.directUrl || playbackSource.url,
  }
}

function selectNativeAudioTrack(player, selectedTrack, audioTracks) {
  const nativeTracks = player?.audioTracks
  const nativeTrackCount = Number(nativeTracks?.length || 0)
  const metadataTrackCount = Array.isArray(audioTracks) ? audioTracks.length : 0
  if (!nativeTrackCount || !selectedTrack) return false

  const selectedOrder = Number(selectedTrack.audioOrder)
  let targetIndex = Number.isInteger(selectedOrder)
    && selectedOrder >= 0
    && selectedOrder < nativeTrackCount
    && nativeTrackCount === metadataTrackCount
    ? selectedOrder
    : null

  if (targetIndex === null) {
    const selectedLanguages = getAudioTrackLanguageCodes(selectedTrack)
    const matches = []
    for (let index = 0; index < nativeTrackCount; index += 1) {
      const nativeTrack = nativeTracks[index]
      const nativeId = normalizeAudioStreamIndex(nativeTrack.id)
      const nativeLanguage = normalizeAudioLanguageCode(nativeTrack.language)
      const nativeLabel = normalizeAudioLabel(`${nativeTrack.label || ''} ${nativeTrack.language || ''}`)
      const titleLabel = normalizeAudioLabel(selectedTrack.title)
      if (
        nativeId === selectedTrack.index
        || (nativeLanguage && selectedLanguages.includes(nativeLanguage))
        || (titleLabel && nativeLabel.includes(titleLabel))
      ) {
        matches.push(index)
      }
    }
    if (matches.length !== 1) return false
    targetIndex = matches[0]
  }

  for (let index = 0; index < nativeTrackCount; index += 1) {
    nativeTracks[index].enabled = index === targetIndex
  }
  return true
}

function getAudioStreamUrl(url, streamIndex) {
  if (!url) return ''
  try {
    const parsedUrl = new URL(url, window.location.origin)
    parsedUrl.searchParams.set('audio_stream_index', String(streamIndex))
    return parsedUrl.toString()
  } catch {
    return url
  }
}

function normalizeAudioStreamIndex(value) {
  if (value === null || value === undefined || value === '') return null
  const numericValue = Number(value)
  return Number.isInteger(numericValue) ? numericValue : null
}

function getAudioTrackId(track) {
  return `audio:${track.index}`
}

function getAudioTrackOptionLabel(track) {
  return getAudioTrackDisplayLabel(track, { includeCodec: true })
}

function getAudioTrackDisplayLabel(track, { includeCodec = true } = {}) {
  const languageLabel = getAudioLanguageLabel(track.language)
  const title = String(track.title || '').trim()
  const kindLabel = getAudioTrackKindLabel(track)
  const parts = []
  if (languageLabel) parts.push(languageLabel)
  if (title && !isDuplicateAudioLabel(title, languageLabel)) {
    parts.push(title)
  } else if (kindLabel) {
    parts.push(kindLabel)
  }
  if (includeCodec) parts.push(getAudioTrackCodecLabel(track))
  if (track.default) parts.push('Default')
  return uniqueLabels(parts).join(' - ') || `Audio ${track.index}`
}

function getAudioTrackMetaLabel(track) {
  const parts = [
    getAudioTrackCodecLabel(track),
    getAudioTrackKindLabel(track),
    track.default ? 'Default' : '',
    track.browserSupported ? '' : 'Transcode',
  ]
  return uniqueLabels(parts).join(' - ') || 'Audio track'
}

function getAudioTrackCodecLabel(track) {
  const label = String(track.codecLabel || '').trim()
  if (label) return label

  const codec = String(track.codec || '').trim().toUpperCase() || 'Audio'
  const channels = Number(track.channels || 0)
  return channels > 0 ? `${codec} ${channels}ch` : codec
}

function getAudioTrackKindLabel(track) {
  const text = `${track.title || ''} ${track.language || ''}`.toLowerCase()
  if (/(commentary|komentar|director|commentator)/.test(text)) return 'Commentary'
  if (/(descriptive|description|audio description|deskripsi|sdh)/.test(text)) return 'Audio description'
  return track.nonPrimary ? 'Alternate' : ''
}

function getPreferredRegionalAudioTrack(tracks, item) {
  if (!Array.isArray(tracks) || !tracks.length) return null

  const preferredLanguages = getPreferredAudioLanguageCodes(item)
  if (!preferredLanguages.length) return null

  const languageRank = new Map(preferredLanguages.map((language, index) => [language, index]))
  const candidates = tracks.flatMap((track, index) => {
    if (track.nonPrimary) return []
    const matchedRanks = getAudioTrackLanguageCodes(track)
      .map((language) => languageRank.get(language))
      .filter((rank) => rank !== undefined)
    if (!matchedRanks.length) return []
    return [{
      index,
      rank: Math.min(...matchedRanks),
      score: (Math.min(...matchedRanks) * 10)
        + (track.default ? 0 : 1)
        + (track.browserSupported === false ? 2 : 0),
      track,
    }]
  })

  candidates.sort((left, right) => left.score - right.score || left.index - right.index)
  return candidates[0]?.track || null
}

function getPreferredAudioLanguageCodes(item = {}) {
  const languages = []
  const addLanguage = (language) => {
    const normalizedLanguage = normalizeAudioLanguageCode(language)
    if (normalizedLanguage && !languages.includes(normalizedLanguage)) languages.push(normalizedLanguage)
  }

  getCountryCodesForItem(item).forEach((countryCode) => {
    ;(COUNTRY_AUDIO_LANGUAGE_CODES[countryCode] || []).forEach(addLanguage)
  })
  addLanguage(item.tmdb_original_language || item.original_language)
  addLanguage(item.override_language)

  return languages
}

function getCountryCodesForItem(item = {}) {
  const countryCodes = []
  const addCountry = (country) => {
    const countryCode = getCountryCode(country)
    if (countryCode && !countryCodes.includes(countryCode)) countryCodes.push(countryCode)
  }

  addCountry(item.override_region)
  addCountry(item.region)
  ;(Array.isArray(item.origin_country) ? item.origin_country : [item.origin_country]).forEach(addCountry)
  ;(Array.isArray(item.production_countries) ? item.production_countries : [item.production_countries]).forEach(addCountry)
  addCountry(item.country)

  return countryCodes
}

function getCountryCode(country) {
  if (!country) return ''
  if (typeof country === 'string') return country.trim().toUpperCase()
  return String(country.iso_3166_1 || country.code || country.name || '').trim().toUpperCase()
}

function getAudioTrackLanguageCodes(track) {
  const candidates = new Set()
  const addCandidate = (value) => {
    const language = normalizeAudioLanguageCode(value)
    if (language) candidates.add(language)
  }
  addCandidate(track.language)

  const label = normalizeAudioLabel(`${track.title || ''} ${track.language || ''}`)
  Object.entries(AUDIO_LANGUAGE_LABEL_ALIASES).forEach(([alias, language]) => {
    if (label.includes(alias)) candidates.add(language)
  })
  return [...candidates]
}

function normalizeAudioLanguageCode(language) {
  const normalizedLanguage = String(language || '').trim().toLowerCase()
  if (!normalizedLanguage || normalizedLanguage === 'und' || normalizedLanguage === 'unknown') return ''
  return AUDIO_LANGUAGE_CODE_ALIASES[normalizedLanguage] || normalizedLanguage
}

function getAudioLanguageLabel(language) {
  const normalizedLanguage = normalizeAudioLanguageCode(language)
  if (!normalizedLanguage || normalizedLanguage === 'und' || normalizedLanguage === 'unknown') return ''
  const languageLabels = {
    ar: 'Arabic',
    ara: 'Arabic',
    chi: 'Chinese',
    cmn: 'Mandarin',
    de: 'German',
    deu: 'German',
    eng: 'English',
    en: 'English',
    es: 'Spanish',
    spa: 'Spanish',
    fr: 'French',
    fra: 'French',
    fre: 'French',
    hi: 'Hindi',
    hin: 'Hindi',
    id: 'Indonesian',
    ind: 'Indonesian',
    it: 'Italian',
    ita: 'Italian',
    ja: 'Japanese',
    jpn: 'Japanese',
    ko: 'Korean',
    kor: 'Korean',
    ms: 'Malay',
    msa: 'Malay',
    pt: 'Portuguese',
    por: 'Portuguese',
    ru: 'Russian',
    rus: 'Russian',
    th: 'Thai',
    tha: 'Thai',
    vi: 'Vietnamese',
    vie: 'Vietnamese',
    zh: 'Chinese',
    zho: 'Chinese',
  }
  return languageLabels[normalizedLanguage] || normalizedLanguage.toUpperCase()
}

const COUNTRY_AUDIO_LANGUAGE_CODES = {
  AR: ['es'],
  AU: ['en'],
  BR: ['pt'],
  CA: ['en', 'fr'],
  CN: ['zh'],
  DE: ['de'],
  ES: ['es'],
  FR: ['fr'],
  GB: ['en'],
  HK: ['zh'],
  ID: ['id'],
  IN: ['hi'],
  IT: ['it'],
  JP: ['ja'],
  KR: ['ko'],
  MX: ['es'],
  MY: ['ms'],
  PH: ['en'],
  PT: ['pt'],
  RU: ['ru'],
  SG: ['en', 'zh', 'ms'],
  TH: ['th'],
  TR: ['tr'],
  TW: ['zh'],
  US: ['en'],
  VN: ['vi'],
}

const AUDIO_LANGUAGE_CODE_ALIASES = {
  ara: 'ar',
  arabic: 'ar',
  chi: 'zh',
  chinese: 'zh',
  cmn: 'zh',
  de: 'de',
  deu: 'de',
  dutch: 'nl',
  eng: 'en',
  english: 'en',
  fre: 'fr',
  french: 'fr',
  ger: 'de',
  german: 'de',
  hin: 'hi',
  hindi: 'hi',
  id: 'id',
  ind: 'id',
  indonesia: 'id',
  indonesian: 'id',
  ita: 'it',
  italian: 'it',
  ja: 'ja',
  japanese: 'ja',
  jpn: 'ja',
  ko: 'ko',
  kor: 'ko',
  korean: 'ko',
  may: 'ms',
  malay: 'ms',
  msa: 'ms',
  por: 'pt',
  portuguese: 'pt',
  ru: 'ru',
  rus: 'ru',
  russian: 'ru',
  spa: 'es',
  spanish: 'es',
  tha: 'th',
  thai: 'th',
  tur: 'tr',
  turkish: 'tr',
  vi: 'vi',
  vie: 'vi',
  vietnamese: 'vi',
  zh: 'zh',
  zho: 'zh',
}

const AUDIO_LANGUAGE_LABEL_ALIASES = Object.fromEntries(
  Object.entries(AUDIO_LANGUAGE_CODE_ALIASES).map(([alias, language]) => [normalizeAudioLabel(alias), language]),
)

function isDuplicateAudioLabel(candidate, existingLabel) {
  const normalizedCandidate = normalizeAudioLabel(candidate)
  const normalizedExistingLabel = normalizeAudioLabel(existingLabel)
  return Boolean(normalizedCandidate && normalizedExistingLabel && (
    normalizedCandidate === normalizedExistingLabel
    || normalizedCandidate.includes(normalizedExistingLabel)
    || normalizedExistingLabel.includes(normalizedCandidate)
  ))
}

function normalizeAudioLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function uniqueLabels(labels) {
  const seenLabels = new Set()
  return labels
    .map((label) => String(label || '').trim())
    .filter((label) => {
      const key = normalizeAudioLabel(label)
      if (!key || seenLabels.has(key)) return false
      seenLabels.add(key)
      return true
    })
}

function getEmbeddedSubtitleTrackId(track) {
  return `embedded:${track.stream_index}`
}

function getEmbeddedSubtitleTrackLabel(track) {
  const languageLabel = getAudioLanguageLabel(track.language)
  const title = String(track.label || '').trim()
  const titleLanguageLabel = getAudioLanguageLabel(title)
  const displayTitle = titleLanguageLabel || title
  const parts = []

  if (languageLabel) parts.push(languageLabel)
  if (displayTitle && !isDuplicateAudioLabel(displayTitle, languageLabel)) parts.push(displayTitle)

  return uniqueLabels(parts).join(' - ') || `Subtitle ${track.stream_index}`
}

function setTextTracksHidden(player) {
  Array.from(player?.textTracks || []).forEach((track) => {
    track.mode = 'hidden'
  })
}

function createSubtitleCues(cues) {
  return Array.from(cues || [], (cue) => {
    const text = cue.text
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim()
    return {
      endTime: cue.endTime,
      lines: text.split(/\r?\n/),
      startTime: cue.startTime,
      text,
    }
  }).filter((cue) => cue.text)
}

function getEmbeddedSubtitleWindow(playheadSeconds) {
  const numericPlayhead = Number.isFinite(playheadSeconds) ? Math.max(0, playheadSeconds) : 0
  const bucketStart = Math.floor(numericPlayhead / EMBEDDED_SUBTITLE_WINDOW_SECONDS) * EMBEDDED_SUBTITLE_WINDOW_SECONDS
  return {
    durationSeconds: EMBEDDED_SUBTITLE_WINDOW_SECONDS + EMBEDDED_SUBTITLE_WINDOW_LOOKBEHIND_SECONDS,
    startSeconds: Math.max(0, bucketStart - EMBEDDED_SUBTITLE_WINDOW_LOOKBEHIND_SECONDS),
  }
}

function mergeSubtitleCues(currentCues, incomingCues) {
  if (!incomingCues.length) return currentCues

  const cuesByKey = new Map()
  Array.from(currentCues || []).forEach((cue) => {
    cuesByKey.set(`${cue.startTime}:${cue.endTime}:${cue.text}`, cue)
  })
  incomingCues.forEach((cue) => {
    cuesByKey.set(`${cue.startTime}:${cue.endTime}:${cue.text}`, cue)
  })
  return Array.from(cuesByKey.values()).sort((left, right) => left.startTime - right.startTime)
}

function createSubtitleCueStyle(settings) {
  const fontFamilies = {
    condensed: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
    helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    mono: '"Courier New", monospace',
    rounded: '"Trebuchet MS", Arial, sans-serif',
    sans: 'Arial, Helvetica, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    tahoma: 'Tahoma, Verdana, sans-serif',
    times: '"Times New Roman", Times, serif',
    verdana: 'Verdana, Geneva, sans-serif',
  }
  const colors = {
    cyan: '#67e8f9',
    green: '#86efac',
    white: '#ffffff',
    yellow: '#fde047',
  }
  const backgrounds = {
    none: 'transparent',
    solid: 'rgba(0, 0, 0, 0.96)',
    translucent: 'rgba(0, 0, 0, 0.64)',
  }
  const isBold = settings.fontStyle === 'bold' || settings.fontStyle === 'bold-italic'
  const isItalic = settings.fontStyle === 'italic' || settings.fontStyle === 'bold-italic'

  return {
    background: backgrounds[settings.background] || backgrounds.translucent,
    color: colors[settings.color] || colors.white,
    fontFamily: fontFamilies[settings.fontFamily] || fontFamilies.sans,
    fontSize: `${clampSubtitleFontSize(settings.fontSizePx)}px`,
    fontStyle: isItalic ? 'italic' : 'normal',
    fontWeight: isBold ? 800 : 600,
    textShadow: createSubtitleOutline(settings.outlineWidth),
  }
}

function createSubtitleOutline(outlineWidth) {
  const width = clampSubtitleOutline(outlineWidth)
  if (!width) return 'none'

  const shadows = []
  for (let degrees = 0; degrees < 360; degrees += 30) {
    const radians = degrees * Math.PI / 180
    shadows.push(`${(Math.cos(radians) * width).toFixed(2)}px ${(Math.sin(radians) * width).toFixed(2)}px 0 #000000`)
  }
  return shadows.join(', ')
}

export default WatchPage
