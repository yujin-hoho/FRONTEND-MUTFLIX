import assert from 'node:assert/strict'
import test from 'node:test'
import { getBufferedSeekTime } from './playbackBuffer.js'

function ranges(...entries) {
  return { length: entries.length, start: (index) => entries[index][0], end: (index) => entries[index][1] }
}

function player(overrides = {}) {
  return { readyState: 4, duration: Infinity, playbackRate: 1, buffered: ranges([0, 30]), seekable: ranges([0, 30]), ...overrides }
}

test('seeks inside the existing transcode buffer using the fragment timeline', () => {
  assert.equal(getBufferedSeekTime(player(), 620, 600), 20)
  assert.equal(getBufferedSeekTime(player(), 600, 600), 0)
  assert.equal(getBufferedSeekTime(player(), 590, 600), null)
})

test('requires downloaded data, not just a server seekable range', () => {
  assert.equal(getBufferedSeekTime(player({ seekable: ranges([0, 3600]) }), 100), null)
  assert.equal(getBufferedSeekTime(player({ seekable: ranges() }), 10), null)
  assert.equal(getBufferedSeekTime(player({ buffered: ranges([0, 5], [10, 30]) }), 7), null)
  assert.equal(getBufferedSeekTime(player({ buffered: ranges([0, 5], [10, 30]) }), 15), 15)
})

test('keeps playback headroom at the buffer edge, accounting for playback speed', () => {
  assert.equal(getBufferedSeekTime(player(), 29.8), null)
  assert.equal(getBufferedSeekTime(player(), 29.5), 29.5)
  assert.equal(getBufferedSeekTime(player({ playbackRate: 2 }), 29.5), null)
  assert.equal(getBufferedSeekTime(player({ duration: 30 }), 29.8), 29.8)
  assert.equal(getBufferedSeekTime(player({ duration: 30 }), 30), null)
})

test('does not reuse stale ranges while a replacement stream loads', () => {
  assert.equal(getBufferedSeekTime(player({ readyState: 0 }), 10), null)
  assert.equal(getBufferedSeekTime(player({ readyState: 1 }), 10), null)
  assert.equal(getBufferedSeekTime(null, 10), null)
  assert.equal(getBufferedSeekTime(player(), NaN), null)
})
