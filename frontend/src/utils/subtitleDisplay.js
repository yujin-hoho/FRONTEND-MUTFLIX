// Bridge only tiny, known gaps; never hold a caption through missing data or silence.
const MAX_CUE_GAP_SECONDS = 0.12

export function selectSubtitleCues(cues, time) {
  if (!Number.isFinite(time)) return []
  const active = []
  let previousEnd = -Infinity
  let nextStart = Infinity
  for (const cue of cues) {
    if (cue.startTime <= time && cue.endTime > time) active.push(cue)
    if (cue.endTime <= time) previousEnd = Math.max(previousEnd, cue.endTime)
    if (cue.startTime > time) nextStart = Math.min(nextStart, cue.startTime)
  }
  if (active.length) return active
  if (nextStart - previousEnd > MAX_CUE_GAP_SECONDS + 1e-6) return []
  return cues.filter((cue) => cue.endTime === previousEnd)
}

export function subscribeSubtitleFrames(player, onTime, scheduler = window) {
  let disposed = false
  let frameId = null
  let animationId = null
  const useVideoFrames = typeof player.requestVideoFrameCallback === 'function'
    && typeof player.cancelVideoFrameCallback === 'function'

  function publish(time = player.currentTime) {
    if (!disposed && !player.seeking) onTime(player.readyState >= 2 && !player.ended ? time : null)
  }

  function schedule() {
    if (disposed) return
    if (useVideoFrames) {
      if (frameId !== null) return
      frameId = player.requestVideoFrameCallback((_, metadata) => {
        frameId = null
        publish(metadata.mediaTime)
        schedule()
      })
    } else if (animationId === null && !player.paused && !player.ended) {
      animationId = scheduler.requestAnimationFrame(() => {
        animationId = null
        publish()
        schedule()
      })
    }
  }

  function refresh(event) {
    if (event?.type === 'emptied' && frameId !== null) {
      player.cancelVideoFrameCallback(frameId)
      frameId = null
    }
    publish()
    schedule()
  }

  // New cues must also appear while paused, without clearing the previous batch.
  animationId = scheduler.requestAnimationFrame(() => {
    animationId = null
    refresh()
  })
  const events = ['loadeddata', 'seeked', 'playing', 'pause', 'ended', 'emptied']
  events.forEach((event) => player.addEventListener(event, refresh))
  return () => {
    disposed = true
    if (frameId !== null) player.cancelVideoFrameCallback(frameId)
    if (animationId !== null) scheduler.cancelAnimationFrame(animationId)
    events.forEach((event) => player.removeEventListener(event, refresh))
  }
}
