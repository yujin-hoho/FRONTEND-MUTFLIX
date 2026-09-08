// Only reuse data the browser has both downloaded and marked as seekable.
// A live fragmented MP4 may report an infinite duration or a wide seekable range.
export function getBufferedSeekTime(player, targetSeconds, timelineOffset = 0) {
  if (!player || player.readyState < 2 || !Number.isFinite(targetSeconds) || !Number.isFinite(timelineOffset)) return null

  const target = targetSeconds - timelineOffset
  if (target < 0) return null

  let seekable = false
  for (let index = 0; index < player.seekable.length; index += 1) {
    if (target >= player.seekable.start(index) && target <= player.seekable.end(index)) {
      seekable = true
      break
    }
  }
  if (!seekable) return null

  const headroom = 0.5 * Math.max(1, Number(player.playbackRate) || 1)
  for (let index = 0; index < player.buffered.length; index += 1) {
    const end = player.buffered.end(index)
    const requiredEnd = Number.isFinite(player.duration)
      ? Math.min(player.duration, target + headroom)
      : target + headroom
    if (target >= player.buffered.start(index) && target < end && requiredEnd <= end) return target
  }
  return null
}
