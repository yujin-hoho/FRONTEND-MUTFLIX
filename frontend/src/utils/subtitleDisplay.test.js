import assert from 'node:assert/strict'
import test from 'node:test'
import { selectSubtitleCues, subscribeSubtitleFrames } from './subtitleDisplay.js'

const cue = (startTime, endTime, text = 'Caption') => ({ startTime, endTime, text })

test('a known tiny gap does not blink blank or reveal the next line early', () => {
  const first = cue(1, 2)
  const second = cue(2.08, 3, 'Next')
  assert.deepEqual(selectSubtitleCues([first, second], 2.04), [first])
  assert.deepEqual(selectSubtitleCues([first, second], 2.08), [second])
  assert.deepEqual(selectSubtitleCues([first, second], 3), [])
})

test('real pauses, missing windows, and seeks never leave a stale caption', () => {
  const first = cue(1, 2)
  const second = cue(4, 5)
  assert.deepEqual(selectSubtitleCues([first, second], 2.05), [])
  assert.deepEqual(selectSubtitleCues([first], 2.05), [])
  assert.deepEqual(selectSubtitleCues([first, second], 0), [])
  assert.deepEqual(selectSubtitleCues([first, second], 100), [])
  assert.deepEqual(selectSubtitleCues([first, second], NaN), [])
})

test('overlapping cues survive and a late batch does not remove an active line', () => {
  const first = cue(1, 3)
  const overlapping = cue(2, 4)
  const future = cue(10, 12)
  assert.deepEqual(selectSubtitleCues([first, overlapping, future], 2.5), [first, overlapping])
  assert.deepEqual(selectSubtitleCues([first, overlapping, future], 3.1), [overlapping])
})

function environment(videoFrames = true) {
  let nextId = 0
  const frames = new Map()
  const animations = new Map()
  const listeners = new Map()
  const scheduler = {
    requestAnimationFrame: (callback) => { animations.set(++nextId, callback); return nextId },
    cancelAnimationFrame: (id) => animations.delete(id),
  }
  const player = {
    currentTime: 1, readyState: 4, seeking: false, paused: false, ended: false,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    ...(videoFrames ? {
      requestVideoFrameCallback: (callback) => { frames.set(++nextId, callback); return nextId },
      cancelVideoFrameCallback: (id) => frames.delete(id),
    } : {}),
  }
  function tick(callbacks, mediaTime) {
    const [id, callback] = callbacks.entries().next().value
    callbacks.delete(id)
    callback(0, { mediaTime })
  }
  return { player, scheduler, frames, animations, listeners, tick }
}

test('subtitle clock follows displayed frames between coarse progress updates', () => {
  const env = environment()
  const times = []
  const dispose = subscribeSubtitleFrames(env.player, (time) => times.push(time), env.scheduler)
  env.tick(env.animations)
  env.tick(env.frames, 1.04)
  env.tick(env.frames, 1.08)
  assert.deepEqual(times, [1, 1.04, 1.08])
  assert.equal(env.player.currentTime, 1)
  dispose()
  assert.equal(env.frames.size + env.animations.size + env.listeners.size, 0)
})

test('source changes reset frame requests and a paused seek refreshes the caption', () => {
  const env = environment()
  const times = []
  const dispose = subscribeSubtitleFrames(env.player, (time) => times.push(time), env.scheduler)
  env.tick(env.animations)
  env.player.readyState = 0
  env.listeners.get('emptied')({ type: 'emptied' })
  assert.equal(times.at(-1), null)
  assert.equal(env.frames.size, 1)
  env.player.readyState = 4
  env.player.paused = true
  env.player.currentTime = 20
  env.listeners.get('seeked')({ type: 'seeked' })
  assert.equal(times.at(-1), 20)
  dispose()
})

test('animation fallback stops polling when paused and resumes on playback', () => {
  const env = environment(false)
  const times = []
  const dispose = subscribeSubtitleFrames(env.player, (time) => times.push(time), env.scheduler)
  env.tick(env.animations)
  env.player.currentTime = 1.04
  env.tick(env.animations)
  assert.equal(times.at(-1), 1.04)
  env.player.paused = true
  env.tick(env.animations)
  assert.equal(env.animations.size, 0)
  env.player.paused = false
  env.listeners.get('playing')({ type: 'playing' })
  assert.equal(env.animations.size, 1)
  dispose()
  assert.equal(env.animations.size + env.listeners.size, 0)
})
