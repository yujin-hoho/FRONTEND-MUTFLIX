import assert from 'node:assert/strict'
import test from 'node:test'
import { getSubtitleTime, getSubtitleWindows, normalizeSubtitleRate, SUBTITLE_SPEED_PRESETS } from './subtitleTiming.js'

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`)
}

test('normal speed preserves existing delay direction and cue boundaries', () => {
  assert.equal(getSubtitleTime(10), 10)
  assert.equal(getSubtitleTime(10, 1, 2), 12)
  assert.equal(getSubtitleTime(10, 1, -2), 8)
  const cue = { startTime: 10, endTime: 12 }
  const visible = (time) => cue.startTime <= time && cue.endTime > time
  assert.equal(visible(getSubtitleTime(8, 1, 2)), true)
  assert.equal(visible(getSubtitleTime(10, 1, 2)), false)
})

test('FPS presets align the same frame at the beginning and end of a movie', () => {
  const pairs = [
    [24000 / 1001, 25], [25, 24000 / 1001],
    [24, 25], [25, 24], [24000 / 1001, 24], [24, 24000 / 1001],
  ]
  pairs.forEach(([sourceFps, videoFps], index) => {
    const { rate } = SUBTITLE_SPEED_PRESETS[index + 1]
    for (const frame of [2400, 86400, 172800]) {
      closeTo(getSubtitleTime(frame / videoFps, rate), frame / sourceFps)
    }
  })
})

test('custom speed corrects growing drift while delay stays in video seconds', () => {
  closeTo(getSubtitleTime(600, 1.02), 612)
  closeTo(getSubtitleTime(3600, 1.02), 3672)
  closeTo(getSubtitleTime(98, 1.02, 2), 102)
  closeTo(getSubtitleTime(102, 1.02, -2), 102)
  // A seek or transcode restart uses the absolute playhead without accumulating drift.
  assert.equal(getSubtitleTime(3600, 0.96), getSubtitleTime(3500 + 100, 0.96))
  closeTo(getSubtitleTime(120, 0.96), 115.2)
})

test('invalid rates cannot freeze or reverse the subtitle clock', () => {
  for (const rate of [undefined, null, '', NaN, Infinity, -1, 0, 0.49, 2.01, 'invalid']) {
    assert.equal(normalizeSubtitleRate(rate), 1)
  }
  assert.equal(normalizeSubtitleRate('1.04'), 1.04)
  assert.equal(normalizeSubtitleRate(0.5), 0.5)
  assert.equal(normalizeSubtitleRate(2), 2)
})

test('embedded windows follow corrected time even when drift crosses several windows', () => {
  const time = getSubtitleTime(3600, 1.1, 50)
  const [window] = getSubtitleWindows(time, 1.1)
  assert.equal(window.startSeconds, 3950)
  assert.ok(window.startSeconds <= time && window.startSeconds + window.durationSeconds > time)
  assert.equal(getSubtitleWindows(getSubtitleTime(10, 1, -50))[0].startSeconds, 0)
  assert.equal(getSubtitleWindows(getSubtitleTime(180, 1, -50))[0].startSeconds, 0)
  assert.equal(getSubtitleWindows(getSubtitleTime(180, 1, 50))[0].startSeconds, 170)
})

test('prefetch keeps thirty video seconds of lead at faster and slower subtitle speeds', () => {
  assert.deepEqual(getSubtitleWindows(149), [{ startSeconds: 0, durationSeconds: 190 }])
  assert.equal(getSubtitleWindows(150).length, 2)
  assert.equal(getSubtitleWindows(120, 2).length, 2)
  assert.equal(getSubtitleWindows(164, 0.5).length, 1)
  assert.equal(getSubtitleWindows(165, 0.5).length, 2)
  assert.deepEqual(getSubtitleWindows(180), [{ startSeconds: 170, durationSeconds: 190 }])
})
