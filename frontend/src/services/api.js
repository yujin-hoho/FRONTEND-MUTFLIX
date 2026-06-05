import { API_BASE_URL, CLOUDFLARE_STREAM_PROXY_URL } from '../config'
import {
  getBackdropUrl,
  getCatalogIdentityKey,
  getGenres,
  getItemPath,
  getMediaType,
  getOverview,
  normalizeMediaPath,
  normalizeWatchHistory,
  getPosterUrl,
} from '../utils/media'

const EMBEDDED_SUBTITLE_CACHE_VERSION = 'v4'
const AUDIO_TRANSCODE_START_RETRY_DELAYS_MS = [900]

export function createEmptyCredits() {
  return { cast: [], crew: [], meta: null, recommendations: [], trailerId: '' }
}

export async function authenticate({ accessToken, isRegister, password, rememberMe, username }) {
  const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login'
  const payload = isRegister
    ? {
        username: username.trim(),
        password,
        token: accessToken.trim(),
      }
    : {
        username: username.trim(),
        password,
        remember_me: rememberMe,
      }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.detail || data.message || `${isRegister ? 'Registration' : 'Login'} failed.`)
  }

  return data
}

export async function fetchProfiles(authToken) {
  const response = await fetch(`${API_BASE_URL}/api/profiles`, {
    headers: { 'x-access-token': authToken },
  })
  const data = await response.json().catch(() => [])

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Failed to load profiles.')
  }

  return Array.isArray(data) ? data : []
}

export async function addProfile(authToken, profile) {
  const response = await fetch(`${API_BASE_URL}/api/profiles/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-token': authToken,
    },
    body: JSON.stringify(profile),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Failed to add profile.')
  }
}

export async function editProfile(authToken, profile) {
  const response = await fetch(`${API_BASE_URL}/api/profiles/edit`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-access-token': authToken,
    },
    body: JSON.stringify(profile),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.message || data.error || 'Failed to update profile.')
  }
}

export async function fetchDashboardData(authToken, profileId) {
  const headers = { 'x-access-token': authToken }
  const [historyResponse, catalogResponse] = await Promise.all([
    fetch(`${API_BASE_URL}/api/history/get/${encodeURIComponent(profileId)}?include_hidden=true&limit=100`, { headers }),
    fetch(`${API_BASE_URL}/api/folders`, { headers }),
  ])
  const historyData = await historyResponse.json().catch(() => [])
  const catalog = await catalogResponse.json().catch(() => ({}))

  if (!historyResponse.ok) {
    throw new Error(historyData.message || historyData.error || 'Failed to load profile data.')
  }

  if (!catalogResponse.ok) {
    throw new Error(catalog.message || catalog.error || 'Failed to load catalog.')
  }

  const movies = Array.isArray(catalog.movies)
    ? catalog.movies.map((item) => ({ ...item, media_type: 'movie', type: 'movie' }))
    : []
  const series = Array.isArray(catalog.series)
    ? catalog.series.map((item) => ({ ...item, media_type: 'tv', type: 'series' }))
    : []

  return { history: normalizeWatchHistory(historyData), movies, series }
}

export async function fetchMyList(authToken, profileId, { status } = {}) {
  const params = new URLSearchParams({ profile_id: profileId })
  if (status) params.set('status', status)

  const response = await fetch(`${API_BASE_URL}/api/mylist?${params.toString()}`, {
    headers: { 'x-access-token': authToken },
  })
  const data = await response.json().catch(() => [])
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to load My List.')
  return Array.isArray(data) ? data.map(normalizeMyListItem) : []
}

export async function fetchMyListCounts(authToken, profileId) {
  const params = new URLSearchParams({ profile_id: profileId })
  const response = await fetch(`${API_BASE_URL}/api/mylist/counts?${params.toString()}`, {
    headers: { 'x-access-token': authToken },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to load My List counts.')
  return {
    completed: Number(data.completed || 0),
    plan_to_watch: Number(data.plan_to_watch || 0),
  }
}

export async function saveMyListItemStatus(authToken, { item, profileId, status = 'completed' }) {
  const folderName = getItemPath(item)
  if (!folderName || !profileId) throw new Error('Missing item or profile.')

  const response = await fetch(`${API_BASE_URL}/api/mylist/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-token': authToken,
    },
    body: JSON.stringify({
      folder_name: folderName,
      media_type: getMediaType(item),
      meta: item,
      profile_id: profileId,
      status,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to update My List.')

  return normalizeMyListItem({
    folder_name: folderName,
    media_type: getMediaType(item),
    meta_json: item,
    status,
  })
}

export async function fetchCatalogSearch(authToken, query, { signal } = {}) {
  const normalizedQuery = String(query || '').trim()
  if (!normalizedQuery) return []

  const response = await fetch(`${API_BASE_URL}/api/search?q=${encodeURIComponent(normalizedQuery)}`, {
    headers: { 'x-access-token': authToken },
    signal,
  })
  const data = await response.json().catch(() => [])
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to search the catalog.')
  return Array.isArray(data) ? data : []
}

export async function fetchPlaybackSource(authToken, mediaPath, video = {}, options = {}) {
  if (!mediaPath) throw new Error('No media file was selected.')
  if (/^https?:\/\//i.test(mediaPath)) return { fallbackUrl: '', url: mediaPath }
  if (!mediaPath.startsWith('gdrive/')) {
    throw new Error('This media source is not available in the web player.')
  }

  const searchParams = new URLSearchParams()
  if (video.original_name) searchParams.set('file_name', video.original_name)
  const requestedAudioStreamIndex = normalizeAudioStreamIndex(options.audioStreamIndex)
  if (requestedAudioStreamIndex !== null) {
    searchParams.set('audio_stream_index', String(requestedAudioStreamIndex))
  }
  const queryString = searchParams.toString()
  const response = await fetch(`${API_BASE_URL}/api/gdrive-stream-details/${encodeServerPath(mediaPath)}${queryString ? `?${queryString}` : ''}`, {
    headers: { 'x-access-token': authToken },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to prepare the video stream.')

  const fileName = video.original_name || data.file_name || video.name || mediaPath
  const isHlsStream = /\.m3u8(?:$|\?)/i.test(fileName)
  const probedBrowserAudioSupported = typeof data.browser_audio_supported === 'boolean'
    ? data.browser_audio_supported
    : null
  const serverAudioTranscodeRequired = typeof data.audio_transcode_required === 'boolean'
    ? data.audio_transcode_required
    : null
  const needsAudioTranscode = !isHlsStream && (
    serverAudioTranscodeRequired === true
    || (
      serverAudioTranscodeRequired === null
      && (
        probedBrowserAudioSupported === false
        || (probedBrowserAudioSupported === null && hasUnsupportedBrowserAudio(fileName))
      )
    )
  )
  const gdriveToken = String(data.headers?.Authorization || '').replace(/^Bearer\s+/i, '')
  const fileId = mediaPath.split('/', 2)[1]
  const baseAudioTranscodeUrl = data.audio_transcode_url
    ? stripAudioStreamIndex(resolveApiPath(data.audio_transcode_url))
    : ''
  const baseAudioTranscodeStartUrl = data.audio_transcode_start_url
    ? stripAudioStreamIndex(resolveApiPath(data.audio_transcode_start_url))
    : ''
  const audioTranscodeUrl = needsAudioTranscode && data.audio_transcode_url
    ? resolveApiPath(data.audio_transcode_url)
    : ''
  const audioTranscodeStartUrl = needsAudioTranscode && data.audio_transcode_start_url
    ? resolveApiPath(data.audio_transcode_start_url)
    : ''
  const directStreamPath = isHlsStream
    ? data.hls_manifest_url
    : gdriveToken && fileId
      ? `${CLOUDFLARE_STREAM_PROXY_URL}/${encodeURIComponent(fileId)}?token=${encodeURIComponent(gdriveToken)}`
      : data.stream_url
  const streamPath = audioTranscodeUrl || directStreamPath
  const selectedAudioStreamIndex = normalizeAudioStreamIndex(data.selected_audio_stream_index)
  const defaultAudioStreamIndex = normalizeAudioStreamIndex(data.default_audio_stream_index)
  const selectedNonDefaultAudio = requestedAudioStreamIndex !== null
    && selectedAudioStreamIndex !== null
    && defaultAudioStreamIndex !== null
    && selectedAudioStreamIndex !== defaultAudioStreamIndex
  const fallbackPath = isHlsStream || selectedNonDefaultAudio ? '' : data.stream_url
  if (!streamPath) throw new Error('The server did not return a playable stream.')
  return {
    audioTranscodeStartUrl,
    audioTranscodeUrl,
    baseAudioTranscodeStartUrl,
    baseAudioTranscodeUrl,
    audioCodec: String(data.audio_codec || ''),
    audioCodecLabel: getAudioCodecLabel(data),
    audioProbeStatus: String(data.audio_probe_status || ''),
    audioTracks: normalizeAudioTracks(data.audio_streams),
    browserAudioSupported: probedBrowserAudioSupported,
    defaultAudioStreamIndex,
    directUrl: directStreamPath ? resolvePublicPath(directStreamPath) : '',
    durationMs: Number(data.duration_ms || 0),
    embeddedSubtitlesUrl: data.embedded_subtitles_url ? resolveApiPath(data.embedded_subtitles_url) : '',
    fallbackUrl: fallbackPath ? resolvePublicPath(fallbackPath) : '',
    isHlsStream,
    selectedAudioStreamIndex,
    url: resolvePublicPath(streamPath),
  }
}

function normalizeAudioTracks(audioStreams) {
  return (Array.isArray(audioStreams) ? audioStreams : [])
    .map((stream, audioOrder) => {
      const streamIndex = normalizeAudioStreamIndex(stream.index)
      if (streamIndex === null) return null
      return {
        audioOrder,
        bitRate: Number(stream.bit_rate || 0),
        browserSupported: stream.browser_supported !== false,
        channelLayout: String(stream.channel_layout || ''),
        channels: Number(stream.channels || 0),
        codec: String(stream.codec || ''),
        codecLabel: String(stream.codec_label || ''),
        default: Boolean(stream.default),
        index: streamIndex,
        language: String(stream.language || ''),
        nonPrimary: Boolean(stream.non_primary),
        profile: String(stream.profile || ''),
        title: String(stream.title || ''),
      }
    })
    .filter(Boolean)
}

function normalizeAudioStreamIndex(value) {
  if (value === null || value === undefined || value === '') return null
  const numericValue = Number(value)
  return Number.isInteger(numericValue) ? numericValue : null
}

export async function fetchAudioTranscodeStart(audioTranscodeStartUrl, startSeconds, { signal } = {}) {
  const requestedStart = Math.max(0, Number(startSeconds) || 0)
  if (!audioTranscodeStartUrl || requestedStart <= 0) {
    return { streamStartSeconds: requestedStart, timelineOffsetReady: true, timelineOffsetSeconds: requestedStart }
  }

  const url = new URL(audioTranscodeStartUrl, window.location.origin)
  url.searchParams.set('start_seconds', String(requestedStart))

  const retryDelays = [0, ...AUDIO_TRANSCODE_START_RETRY_DELAYS_MS]
  for (let attemptIndex = 0; attemptIndex < retryDelays.length; attemptIndex += 1) {
    const retryDelayMs = retryDelays[attemptIndex]
    if (retryDelayMs > 0) await waitForRetry(retryDelayMs, signal)

    const response = await fetch(url, { cache: 'no-store', signal })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.message || data.error || 'Failed to prepare the playback position.')

    const start = {
      streamStartSeconds: Math.max(0, Number(data.stream_start_seconds) || requestedStart),
      timelineOffsetReady: data.timeline_offset_ready !== false,
      timelineOffsetSeconds: Math.min(requestedStart, Math.max(0, Number(data.timeline_offset_seconds) || 0)),
      timelineOffsetSource: String(data.timeline_offset_source || ''),
    }
    if (start.timelineOffsetReady || attemptIndex === retryDelays.length - 1) {
      return start
    }
  }

  return { streamStartSeconds: requestedStart, timelineOffsetReady: false, timelineOffsetSeconds: requestedStart }
}

function getAudioCodecLabel(data) {
  const label = String(data.audio_codec_label || '').trim()
  if (label) return label

  const codec = String(data.audio_codec || '').trim()
  if (codec) return codec.toUpperCase()

  const status = String(data.audio_probe_status || '').trim()
  if (status && status !== 'no-audio') return `Probe ${status}`
  return ''
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError())

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, delayMs)

    function handleAbort() {
      window.clearTimeout(timeoutId)
      reject(createAbortError())
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

function createAbortError() {
  try {
    return new DOMException('Aborted', 'AbortError')
  } catch {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
  }
}

export function getTimestampedAudioTranscodeUrl(audioTranscodeUrl, startSeconds, requestId = 0) {
  const url = new URL(audioTranscodeUrl, window.location.origin)
  url.searchParams.set('start_seconds', String(Math.max(0, Number(startSeconds) || 0)))
  if (requestId) url.searchParams.set('stream_request', String(requestId))
  return url.toString()
}

export async function fetchPlaybackMarkers(authToken, folderName) {
  if (!folderName) return { introEndSeconds: 0, outroStartSeconds: 0 }
  const headers = { 'x-access-token': authToken }

  try {
    const [introResponse, outroResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/intro-markers/${encodeServerPath(folderName)}`, { headers }),
      fetch(`${API_BASE_URL}/api/outro-markers/${encodeServerPath(folderName)}`, { headers }),
    ])
    const [intro, outro] = await Promise.all([
      introResponse.json().catch(() => ({})),
      outroResponse.json().catch(() => ({})),
    ])

    return {
      introEndSeconds: introResponse.ok ? Number(intro.intro_end_seconds || 0) : 0,
      outroStartSeconds: outroResponse.ok ? Number(outro.outro_start_seconds || 0) : 0,
    }
  } catch {
    return { introEndSeconds: 0, outroStartSeconds: 0 }
  }
}

export async function fetchSubtitleTrack(subtitlePath) {
  if (!subtitlePath) return { cues: [], url: '' }

  const response = await fetch(
    /^https?:\/\//i.test(subtitlePath)
      ? subtitlePath
      : `${API_BASE_URL}/subtitle/${encodeServerPath(subtitlePath)}`,
  )
  if (!response.ok) return { cues: [], url: '' }

  const subtitleText = decodeSubtitleText(await response.arrayBuffer())
  const webVtt = normalizeSubtitleToWebVtt(subtitleText, subtitlePath)
  const cues = parseSubtitleCues(webVtt)
  if (!cues.length) return { cues: [], url: '' }

  return {
    cues,
    url: URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' })),
  }
}

export async function fetchEmbeddedSubtitleTracks(embeddedSubtitlesUrl) {
  if (!embeddedSubtitlesUrl) return []

  for (const delayMs of [0, 1500, 3000, 5000, 8000, 12000, 20000, 20000, 20000, 20000, 20000]) {
    if (delayMs) await new Promise((resolve) => window.setTimeout(resolve, delayMs))

    const response = await fetch(embeddedSubtitlesUrl)
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return []

    const tracks = (Array.isArray(data.tracks) ? data.tracks : [])
      .filter((track) => track.url)
      .map((track) => ({ ...track, url: resolveApiPath(track.url) }))
    if (tracks.length) return tracks
    if (!data.probing) return []
  }

  return []
}

export async function fetchEmbeddedSubtitleWindow(subtitleTrackUrl, startSeconds, durationSeconds, { onCues } = {}) {
  if (!subtitleTrackUrl) return { cues: [], url: '' }

  const subtitleUrl = new URL(subtitleTrackUrl, window.location.origin)
  subtitleUrl.searchParams.set('start_seconds', String(startSeconds))
  subtitleUrl.searchParams.set('duration_seconds', String(durationSeconds))
  subtitleUrl.searchParams.set('subtitle_cache_v', EMBEDDED_SUBTITLE_CACHE_VERSION)
  return fetchProgressiveSubtitleTrack(subtitleUrl.toString(), {
    createObjectUrl: false,
    cueOffsetMode: 'response-header',
    cueOffsetSeconds: startSeconds,
    onCues,
  })
}

async function fetchProgressiveSubtitleTrack(
  subtitlePath,
  { createObjectUrl = true, cueOffsetMode = 'always', cueOffsetSeconds = 0, onCues } = {},
) {
  const response = await fetch(subtitlePath)
  if (!response.ok) return { cues: [], url: '' }
  const resolvedCueOffsetSeconds = getSubtitleCueOffset(response, cueOffsetSeconds, cueOffsetMode)
  if (!response.body) {
    const subtitleText = decodeSubtitleText(await response.arrayBuffer())
    const webVtt = normalizeSubtitleToWebVtt(subtitleText, subtitlePath)
    const cues = offsetSubtitleCues(parseSubtitleCues(webVtt), resolvedCueOffsetSeconds)
    if (!cues.length) return { cues: [], url: '' }
    return {
      cues,
      url: createObjectUrl ? URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' })) : '',
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let subtitleText = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    subtitleText += decoder.decode(value, { stream: true })
    const cues = offsetSubtitleCues(
      parseSubtitleCues(normalizeSubtitleToWebVtt(subtitleText, subtitlePath)),
      resolvedCueOffsetSeconds,
    )
    if (cues.length) onCues?.(cues)
  }

  subtitleText += decoder.decode()
  const webVtt = normalizeSubtitleToWebVtt(subtitleText, subtitlePath)
  const cues = offsetSubtitleCues(parseSubtitleCues(webVtt), resolvedCueOffsetSeconds)
  if (!cues.length) return { cues: [], url: '' }
  onCues?.(cues)
  return {
    cues,
    url: createObjectUrl ? URL.createObjectURL(new Blob([webVtt], { type: 'text/vtt' })) : '',
  }
}

function offsetSubtitleCues(cues, offsetSeconds) {
  if (!offsetSeconds) return cues
  return cues.map((cue) => ({
    ...cue,
    endTime: cue.endTime + offsetSeconds,
    startTime: cue.startTime + offsetSeconds,
  }))
}

function getSubtitleCueOffset(response, fallbackOffsetSeconds, mode) {
  const fallbackOffset = Number(fallbackOffsetSeconds) || 0
  if (!fallbackOffset) return 0
  if (mode !== 'response-header') return fallbackOffset

  const timeline = String(response.headers.get('X-Mutflix-Subtitle-Timeline') || '').toLowerCase()
  if (timeline === 'absolute') return 0

  const headerOffset = Number(response.headers.get('X-Mutflix-Subtitle-Cue-Offset'))
  if (timeline === 'relative' && Number.isFinite(headerOffset)) return headerOffset
  return fallbackOffset
}

function decodeSubtitleText(subtitleBytes) {
  const bytes = new Uint8Array(subtitleBytes)
  if (!bytes.length) return ''

  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  if (looksLikeUtf16(bytes, 0)) return new TextDecoder('utf-16be').decode(bytes)
  if (looksLikeUtf16(bytes, 1)) return new TextDecoder('utf-16le').decode(bytes)

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function looksLikeUtf16(bytes, zeroByteOffset) {
  const sampleLength = Math.min(bytes.length, 80)
  let checkedBytes = 0
  let zeroBytes = 0
  for (let index = zeroByteOffset; index < sampleLength; index += 2) {
    checkedBytes += 1
    if (bytes[index] === 0) zeroBytes += 1
  }
  return checkedBytes >= 4 && zeroBytes / checkedBytes >= 0.6
}

function normalizeSubtitleToWebVtt(subtitleText, subtitlePath) {
  const normalizedText = subtitleText.replace(/^\uFEFF/, '')
  if (/^\s*WEBVTT/i.test(normalizedText)) return normalizedText

  const extension = String(subtitlePath || '').toLowerCase().match(/\.[a-z0-9]+(?:$|\?)/)?.[0]?.replace('?', '')
  if (extension === '.ass' || extension === '.ssa' || /^\s*\[Script Info\]/im.test(normalizedText)) {
    return subtitleCuesToWebVtt(parseAssSubtitleCues(normalizedText))
  }

  return `WEBVTT\n\n${normalizedText.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}`
}

function parseAssSubtitleCues(subtitleText) {
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  let isEventsSection = false

  return subtitleText
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')
    .flatMap((line) => {
      const trimmedLine = line.trim()
      if (/^\[Events\]$/i.test(trimmedLine)) {
        isEventsSection = true
        return []
      }
      if (/^\[.+\]$/.test(trimmedLine)) {
        isEventsSection = false
        return []
      }
      if (!isEventsSection) return []
      if (/^Format\s*:/i.test(trimmedLine)) {
        fields = trimmedLine.slice(trimmedLine.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase())
        return []
      }
      if (!/^Dialogue\s*:/i.test(trimmedLine)) return []

      const values = splitAssFields(trimmedLine.slice(trimmedLine.indexOf(':') + 1), fields.length)
      const cue = Object.fromEntries(fields.map((field, index) => [field, values[index] || '']))
      const startTime = parseSubtitleTimestamp(cue.start)
      const endTime = parseSubtitleTimestamp(cue.end)
      const text = cue.text
        .replace(/\\N/gi, '\n')
        .replace(/\\h/gi, ' ')
        .replace(/\{\\[^}]*\}/g, '')
        .trim()
      return Number.isFinite(startTime) && Number.isFinite(endTime) && text
        ? [{ endTime, startTime, text }]
        : []
    })
}

function splitAssFields(line, fieldCount) {
  const fields = []
  let remaining = line
  for (let index = 1; index < fieldCount; index += 1) {
    const separatorIndex = remaining.indexOf(',')
    if (separatorIndex < 0) break
    fields.push(remaining.slice(0, separatorIndex).trim())
    remaining = remaining.slice(separatorIndex + 1)
  }
  fields.push(remaining.trim())
  return fields
}

function subtitleCuesToWebVtt(cues) {
  const blocks = cues.map((cue, index) => (
    `${index + 1}\n${formatWebVttTimestamp(cue.startTime)} --> ${formatWebVttTimestamp(cue.endTime)}\n${cue.text}`
  ))
  return `WEBVTT\n\n${blocks.join('\n\n')}`
}

function formatWebVttTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000))
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const remainingSeconds = Math.floor((milliseconds % 60000) / 1000)
  const remainingMilliseconds = milliseconds % 1000
  return [hours, minutes, remainingSeconds]
    .map((segment) => String(segment).padStart(2, '0'))
    .join(':') + `.${String(remainingMilliseconds).padStart(3, '0')}`
}

function parseSubtitleCues(webVtt) {
  const lines = webVtt
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .split('\n')
  const cues = []

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('-->')) continue

    const [startTimestamp, endTimestampWithSettings] = lines[index].split('-->')
    const startTime = parseSubtitleTimestamp(startTimestamp)
    const endTime = parseSubtitleTimestamp(endTimestampWithSettings?.trim().split(/\s+/, 1)[0])
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) continue

    const textLines = []
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line.trim()) break
      if (line.includes('-->')) {
        index -= 1
        break
      }
      if (lines[index + 1]?.includes('-->') && /^\s*\d+\s*$/.test(line)) break
      textLines.push(line)
    }
    const text = textLines.join('\n').trim()
    if (text) cues.push({ endTime, startTime, text })
  }

  return cues
}

function parseSubtitleTimestamp(timestamp) {
  const segments = String(timestamp || '').trim().replace(',', '.').split(':').map(Number)
  if (segments.length === 3) return segments[0] * 3600 + segments[1] * 60 + segments[2]
  if (segments.length === 2) return segments[0] * 60 + segments[1]
  return Number.NaN
}

export async function saveWatchProgress(authToken, payload) {
  const normalizedPayload = { ...payload, media_path: normalizeMediaPath(payload.media_path) }
  const response = await fetch(`${API_BASE_URL}/api/history/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-token': authToken,
    },
    body: JSON.stringify(normalizedPayload),
    keepalive: true,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to save watch progress.')
  return normalizedPayload
}

export async function hideWatchHistory(authToken, payload) {
  const normalizedPayload = { ...payload, media_path: normalizeMediaPath(payload.media_path) }
  const response = await fetch(`${API_BASE_URL}/api/history/hide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-token': authToken,
    },
    body: JSON.stringify(normalizedPayload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to hide watch history.')
  return normalizedPayload
}

export async function enrichCatalogMetadata(authToken, catalog, maxItemsPerType = Infinity, { batchSize = 20, onProgress } = {}) {
  let movies = catalog.movies
  let series = catalog.series
  const headers = { 'x-access-token': authToken }
  const itemsNeedingMetadata = [
    ...getItemsNeedingMetadata(movies, 'movie', maxItemsPerType),
    ...getItemsNeedingMetadata(series, 'tv', maxItemsPerType),
  ]

  for (let index = 0; index < itemsNeedingMetadata.length; index += batchSize) {
    const metadataMap = await fetchMetadataBatch(headers, itemsNeedingMetadata.slice(index, index + batchSize))
    if (!metadataMap.size) continue

    movies = mergeCatalogWithMetadata(movies, metadataMap, 'movie')
    series = mergeCatalogWithMetadata(series, metadataMap, 'tv')
    onProgress?.({ ...catalog, movies, series })
  }

  return { ...catalog, movies, series }
}

export function mergeCatalogMetadataUpdates(catalog, updates) {
  return {
    ...catalog,
    movies: mergeItemsByKey(catalog.movies, updates.movies),
    series: mergeItemsByKey(catalog.series, updates.series),
  }
}

export async function fetchDetailData(authToken, item) {
  const detailItem = { ...item, media_type: getMediaType(item) }
  const itemPath = getItemPath(detailItem)
  if (!itemPath || !navigator.onLine) {
    return { item: detailItem, videos: [], credits: createEmptyCredits() }
  }

  const headers = { 'x-access-token': authToken }
  const response = await fetch(`${API_BASE_URL}/api/videos/${encodeURIComponent(itemPath)}`, {
    cache: 'no-store',
    headers,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to load title details.')

  const [videos, credits] = await Promise.all([
    enrichEpisodesFromServer(detailItem, Array.isArray(data.videos) ? data.videos : [], headers),
    getCreditsFromServer(detailItem, headers),
  ])

  return {
    item: mergeMeaningfulValues(
      detailItem,
      data.catalog_item || {},
      getCatalogMetadataFromTmdb(credits.meta),
      { media_type: detailItem.media_type },
    ),
    videos,
    credits,
  }
}

export async function fetchVideoQueue(authToken, item) {
  const detailItem = { ...item, media_type: getMediaType(item) }
  const itemPath = getItemPath(detailItem)
  if (!itemPath || !navigator.onLine) return { item: detailItem, videos: [] }

  const headers = { 'x-access-token': authToken }
  const response = await fetch(`${API_BASE_URL}/api/videos/${encodeURIComponent(itemPath)}`, {
    cache: 'no-store',
    headers,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || 'Failed to load video queue.')
  const mergedItem = mergeMeaningfulValues(
    detailItem,
    data.catalog_item || {},
    { media_type: detailItem.media_type },
  )

  return {
    item: mergedItem,
    videos: await enrichEpisodesFromServer(mergedItem, Array.isArray(data.videos) ? data.videos : [], headers),
  }
}

async function enrichEpisodesFromServer(item, videos, headers) {
  if (getMediaType(item) === 'movie' || !videos.length) return videos

  const folderName = item.folder_name || item.name || getItemPath(item)
  if (!folderName) return videos

  try {
    const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/tv?folder_name=${encodeURIComponent(folderName)}`, { headers })
    const meta = await metaResponse.json().catch(() => ({}))
    const tmdbId = metaResponse.ok ? meta.id : null
    if (!tmdbId) return videos

    const seasons = [...new Set(videos.map((video) => Number(video.season || 1)))]
    const seasonResponses = await Promise.all(seasons.map(async (season) => {
      const response = await fetch(`${API_BASE_URL}/api/tmdb/tv/${tmdbId}/season/${season}`, { headers })
      const data = await response.json().catch(() => ({}))
      return response.ok && Array.isArray(data.episodes) ? data.episodes : []
    }))
    const episodeMap = new Map()
    seasonResponses.flat().forEach((episode) => {
      episodeMap.set(`${episode.season_number}:${episode.episode_number}`, episode)
    })

    return videos.map((video) => {
      const episode = episodeMap.get(`${Number(video.season || 1)}:${Number(video.episode || 0)}`)
      if (!episode) return video
      return {
        ...video,
        name: episode.name || video.name,
        overview: episode.overview || '',
        still_path: episode.still_path || '',
      }
    })
  } catch {
    return videos
  }
}

async function getCreditsFromServer(item, headers) {
  const mediaType = getMediaType(item) === 'movie' ? 'movie' : 'tv'
  const folderName = item.folder_name || item.name || getItemPath(item)
  if (!folderName) return createEmptyCredits()

  try {
    const metaResponse = await fetch(`${API_BASE_URL}/api/tmdb-meta/${mediaType}?folder_name=${encodeURIComponent(folderName)}`, { headers })
    const meta = await metaResponse.json().catch(() => ({}))
    if (!metaResponse.ok || !meta.id) return createEmptyCredits()

    const [creditsResponse, recommendationsResponse, videosResponse] = await Promise.all([
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/credits`, { headers }),
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/recommendations`, { headers }),
      fetch(`${API_BASE_URL}/api/tmdb/${mediaType}/${meta.id}/videos`, { headers }),
    ])
    const [credits, recommendations, videos] = await Promise.all([
      creditsResponse.json().catch(() => ({})),
      recommendationsResponse.json().catch(() => ({})),
      videosResponse.json().catch(() => ({})),
    ])
    const trailers = videosResponse.ok && Array.isArray(videos.results)
      ? videos.results.filter((video) => video.site === 'YouTube' && video.type === 'Trailer')
      : []
    const trailer = trailers.find((video) => video.official) || trailers[0]

    const crewJobs = new Set(['Director', 'Producer', 'Writer', 'Screenplay'])
    const crew = Array.isArray(credits.crew)
      ? credits.crew
        .filter((person) => crewJobs.has(person.job))
        .filter((person, index, people) => people.findIndex((candidate) => (
          candidate.id === person.id && candidate.job === person.job
        )) === index)
        .slice(0, 8)
      : []

    return {
      cast: Array.isArray(credits.cast) ? credits.cast.slice(0, 5) : [],
      crew,
      meta,
      recommendations: recommendationsResponse.ok && Array.isArray(recommendations.results)
        ? recommendations.results.slice(0, 16)
        : [],
      trailerId: trailer?.key || '',
    }
  } catch {
    return createEmptyCredits()
  }
}

function mergeCatalogWithMetadata(items, metadataMap, mediaType) {
  return items.map((item) => {
    const folderName = item.folder_name || item.name
    const metadata = metadataMap.get(`${mediaType}:${folderName}`)
    if (!metadata) return item

    return {
      ...item,
      tmdb_metadata_resolved: true,
      tmdb_title: item.tmdb_title || metadata.title || metadata.name,
      tmdb_poster_path: item.tmdb_poster_path || metadata.poster_path,
      tmdb_backdrop_path: item.tmdb_backdrop_path || metadata.backdrop_path,
      tmdb_overview: item.tmdb_overview || metadata.overview,
      tmdb_rating: item.tmdb_rating || metadata.vote_average,
      tmdb_genres: item.tmdb_genres?.length ? item.tmdb_genres : metadata.genres || [],
      tmdb_original_language: item.tmdb_original_language || metadata.original_language,
      origin_country: item.origin_country?.length ? item.origin_country : metadata.origin_country || [],
      production_countries: item.production_countries?.length ? item.production_countries : metadata.production_countries || [],
      media_type: mediaType,
    }
  })
}

function getItemsNeedingMetadata(items, mediaType, maxItems) {
  return items
    .filter((item) => !item.tmdb_metadata_resolved && (!getPosterUrl(item) || !getBackdropUrl(item) || !getOverview(item) || !getGenres(item).length))
    .slice(0, maxItems)
    .map((item) => ({ media_type: mediaType, folder_name: item.folder_name || item.name }))
    .filter((item) => item.folder_name)
}

async function fetchMetadataBatch(headers, items) {
  if (!items.length) return new Map()

  try {
    const response = await fetch(`${API_BASE_URL}/api/tmdb-meta/bulk`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !Array.isArray(data.results)) return new Map()

    const metadataMap = new Map()
    data.results.forEach((result) => {
      if (!result.media_type || !result.folder_name) return
      if (result.status === 404) {
        metadataMap.set(`${result.media_type}:${result.folder_name}`, {})
        return
      }
      if (result.status !== 200 || !result.payload) return
      metadataMap.set(`${result.media_type}:${result.folder_name}`, result.payload)
    })
    return metadataMap
  } catch {
    // Metadata is optional. Keep catalog items visible with local fallbacks.
    return new Map()
  }
}

function mergeItemsByKey(items, updates) {
  const updatesByKey = new Map(updates.map((item) => [getCatalogIdentityKey(item), item]))
  return items.map((item) => {
    const update = updatesByKey.get(getCatalogIdentityKey(item))
    return update ? mergeMeaningfulValues(item, update) : item
  })
}

function getCatalogMetadataFromTmdb(meta) {
  if (!meta) return {}

  return {
    tmdb_title: meta.title || meta.name,
    tmdb_poster_path: meta.poster_path,
    tmdb_backdrop_path: meta.backdrop_path,
    tmdb_overview: meta.overview,
    tmdb_rating: meta.vote_average,
    tmdb_genres: meta.genres,
    tmdb_original_language: meta.original_language,
    origin_country: meta.origin_country,
    production_countries: meta.production_countries,
  }
}

function mergeMeaningfulValues(...sources) {
  return sources.reduce((merged, source) => {
    Object.entries(source).forEach(([key, value]) => {
      if (isMeaningfulValue(value)) merged[key] = value
    })
    return merged
  }, {})
}

function isMeaningfulValue(value) {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function encodeServerPath(path) {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function resolvePublicPath(path) {
  if (/^(?:https?:|blob:)/i.test(path)) return path
  return path.startsWith('/') ? path : `/${path}`
}

function resolveApiPath(path) {
  if (/^(?:https?:|blob:)/i.test(path)) return path
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

function stripAudioStreamIndex(url) {
  try {
    const parsedUrl = new URL(url, window.location.origin)
    parsedUrl.searchParams.delete('audio_stream_index')
    return parsedUrl.toString()
  } catch {
    return url
  }
}

const AUDIO_TAG_BOUNDARY = String.raw`(?:^|[.\s_[\]()-])`
const AUDIO_TAG_END = String.raw`(?:[.\s_[\]()-]|$)`
const AUDIO_CHANNEL_TAG = String.raw`(?:2[\s._-]*0|5[\s._-]*1|7[\s._-]*1|atmos)`
const UNSUPPORTED_BROWSER_AUDIO_PATTERNS = [
  new RegExp(`${AUDIO_TAG_BOUNDARY}e[\\s._-]*a[\\s._-]*c[\\s._-]*3${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}a[\\s._-]*c[\\s._-]*3${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}d[\\s._-]*d[\\s._-]*p(?:[\\s._-]*${AUDIO_CHANNEL_TAG})?${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}d[\\s._-]*d[\\s._-]*${AUDIO_CHANNEL_TAG}${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}dolby[\\s._-]+digital(?:[\\s._-]+plus)?${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}true[\\s._-]*hd${AUDIO_TAG_END}`, 'i'),
  new RegExp(`${AUDIO_TAG_BOUNDARY}dts(?:[\\s._-]*(?:hd|x|ma))?${AUDIO_TAG_END}`, 'i'),
]

function hasUnsupportedBrowserAudio(fileName) {
  const normalizedFileName = String(fileName || '')
  return UNSUPPORTED_BROWSER_AUDIO_PATTERNS.some((pattern) => pattern.test(normalizedFileName))
}

function normalizeMyListItem(item) {
  const metadata = item.meta_json && typeof item.meta_json === 'object' ? item.meta_json : {}
  const mediaType = String(item.media_type || metadata.media_type || metadata.type || '').toLowerCase()
  const isMovie = mediaType === 'movie'

  return {
    ...metadata,
    folder_name: item.folder_name || metadata.folder_name || metadata.name || '',
    media_type: isMovie ? 'movie' : 'tv',
    my_list_status: item.status || 'plan_to_watch',
    type: isMovie ? 'movie' : 'series',
  }
}
