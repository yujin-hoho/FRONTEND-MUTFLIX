import { useEffect, useState } from 'react'
import { getSubtitleTime } from '../utils/subtitleTiming'
import { selectSubtitleCues, subscribeSubtitleFrames } from '../utils/subtitleDisplay'

export default function SubtitleOverlay({ playerRef, offsetRef, cues, rate, delaySeconds, cueStyle, positionStyle }) {
  const [activeCues, setActiveCues] = useState([])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return undefined
    let lastCues = null
    return subscribeSubtitleFrames(player, (mediaTime) => {
      const time = mediaTime === null ? NaN : getSubtitleTime(mediaTime + offsetRef.current, rate, delaySeconds)
      const nextCues = selectSubtitleCues(cues, time)
      if (lastCues && nextCues.length === lastCues.length && nextCues.every((cue, index) => cue === lastCues[index])) return
      lastCues = nextCues
      setActiveCues(nextCues)
    })
  }, [cues, delaySeconds, offsetRef, playerRef, rate])

  if (!activeCues.length) return null
  return (
    <div aria-hidden="true" className="watch-subtitles" style={positionStyle}>
      {activeCues.map((cue) => (
        <p className="watch-subtitle-cue" key={`${cue.startTime}-${cue.endTime}-${cue.text}`} style={cueStyle}>
          {cue.lines.map((line, index) => <span className="watch-subtitle-line" key={`${line}-${index}`}>{line}</span>)}
        </p>
      ))}
    </div>
  )
}
