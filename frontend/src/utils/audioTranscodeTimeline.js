export function resolveAudioTranscodeTimeline(data, requestedStart) {
  const readTime = (value) => value === null || value === undefined || value === '' ? NaN : Number(value)
  const streamStartSeconds = readTime(data.stream_start_seconds)
  const timelineOffsetSeconds = readTime(data.timeline_offset_seconds)
  if (data.timeline_offset_ready === false
    || !Number.isFinite(streamStartSeconds) || streamStartSeconds < 0 || streamStartSeconds > requestedStart
    || !Number.isFinite(timelineOffsetSeconds) || timelineOffsetSeconds < 0 || timelineOffsetSeconds > requestedStart) return null

  return { streamStartSeconds, timelineOffsetSeconds, timelineOffsetReady: true }
}
