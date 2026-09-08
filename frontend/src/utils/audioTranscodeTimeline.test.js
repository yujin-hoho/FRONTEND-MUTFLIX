import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAudioTranscodeTimeline } from './audioTranscodeTimeline.js'
import { getSubtitleTime } from './subtitleTiming.js'

test('resume and audio switches use the actual keyframe, not the requested seek time', () => {
  const start = resolveAudioTranscodeTimeline({
    stream_start_seconds: 607,
    timeline_offset_seconds: 600,
    timeline_offset_ready: true,
  }, 607)
  assert.equal(start.timelineOffsetSeconds, 600)
  const fragmentSeekTime = 607 - start.timelineOffsetSeconds
  assert.equal(fragmentSeekTime, 7)
  assert.equal(getSubtitleTime(fragmentSeekTime + start.timelineOffsetSeconds), 607)
  assert.equal(getSubtitleTime(fragmentSeekTime + 3 + start.timelineOffsetSeconds), 610)
})

test('a resolved origin of zero remains zero for seeks within the first GOP', () => {
  assert.deepEqual(resolveAudioTranscodeTimeline({
    stream_start_seconds: 0, timeline_offset_seconds: 0, timeline_offset_ready: true,
  }, 7), { streamStartSeconds: 0, timelineOffsetSeconds: 0, timelineOffsetReady: true })
})

test('an unconfirmed or malformed timeline cannot silently move the subtitle clock', () => {
  assert.equal(resolveAudioTranscodeTimeline({
    stream_start_seconds: 607, timeline_offset_seconds: 607, timeline_offset_ready: false,
  }, 607), null)
  for (const value of [undefined, null, '', -1, Infinity, NaN, 608]) {
    assert.equal(resolveAudioTranscodeTimeline({ stream_start_seconds: 607, timeline_offset_seconds: value }, 607), null)
    assert.equal(resolveAudioTranscodeTimeline({ stream_start_seconds: value, timeline_offset_seconds: 600 }, 607), null)
  }
})
