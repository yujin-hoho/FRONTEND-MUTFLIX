const FILM_FPS = 24000 / 1001
const WINDOW_SECONDS = 180
const LOOKBEHIND_SECONDS = 10
const PREFETCH_LEAD_SECONDS = 30

export const SUBTITLE_SPEED_PRESETS = [
  { label: 'Normal (100%)', rate: 1 },
  { label: '23.976 → 25 FPS', rate: 25 / FILM_FPS },
  { label: '25 → 23.976 FPS', rate: FILM_FPS / 25 },
  { label: '24 → 25 FPS', rate: 25 / 24 },
  { label: '25 → 24 FPS', rate: 24 / 25 },
  { label: '23.976 → 24 FPS', rate: 24 / FILM_FPS },
  { label: '24 → 23.976 FPS', rate: FILM_FPS / 24 },
]

export function normalizeSubtitleRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1
}

export function getSubtitleTime(videoTime, rate = 1, delaySeconds = 0) {
  // Positive delay advances subtitles; delay remains measured in video seconds.
  // Use the absolute video timeline, including any transcode fragment offset.
  return (videoTime + delaySeconds) * normalizeSubtitleRate(rate)
}

export function getSubtitleWindows(subtitleTime, rate = 1) {
  const playhead = Number.isFinite(subtitleTime) ? Math.max(0, subtitleTime) : 0
  const bucketStart = Math.floor(playhead / WINDOW_SECONDS) * WINDOW_SECONDS
  const starts = [bucketStart]
  if (playhead - bucketStart >= WINDOW_SECONDS - PREFETCH_LEAD_SECONDS * normalizeSubtitleRate(rate)) {
    starts.push(bucketStart + WINDOW_SECONDS)
  }
  return starts.map((start) => ({
    durationSeconds: WINDOW_SECONDS + LOOKBEHIND_SECONDS,
    startSeconds: Math.max(0, start - LOOKBEHIND_SECONDS),
  }))
}
