import React from 'react'
import { createRoot } from 'react-dom/client'
import WatchPage from '../src/pages/watchpage'

// Exercise real React effects and DOM rendering without a remote media account.
// Media events are deterministic; the subtitle response intentionally takes time.
window.subtitleRequests = 0
window.playerLoads = 0
window.fetch = async (input) => {
  if (String(input).includes('fixture.vtt')) {
    window.subtitleRequests += 1
    await new Promise((resolve) => setTimeout(resolve, 350))
    return new Response('WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nContinuous test caption\n\n')
  }
  return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
}
const positions = new WeakMap()
const paused = new WeakMap()
Object.defineProperties(HTMLMediaElement.prototype, {
  src: { configurable: true, get() { return this.dataset.source || '' }, set(value) { this.dataset.source = value } },
  duration: { configurable: true, get() { return 600 } },
  readyState: { configurable: true, get() { return 4 } },
  currentTime: { configurable: true, get() { return positions.get(this) || 1 }, set(value) { positions.set(this, value) } },
  paused: { configurable: true, get() { return paused.get(this) ?? true } },
})
HTMLMediaElement.prototype.load = function () {
  window.playerLoads += 1
  queueMicrotask(() => {
    this.dispatchEvent(new Event('loadedmetadata'))
    this.dispatchEvent(new Event('loadeddata'))
    this.dispatchEvent(new Event('timeupdate'))
  })
}
HTMLMediaElement.prototype.play = function () {
  paused.set(this, false)
  this.dispatchEvent(new Event('playing'))
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function () { paused.set(this, true) }

const root = createRoot(document.getElementById('root'))
const video = { path: 'https://media.invalid/test.mp4', name: 'Test', subtitle_path: '/fixture.vtt' }
const item = { path: 'test-movie', title: 'Test', media_type: 'movie' }
const noop = () => {}
const onSaveProgress = async () => {}
window.renderSameVideo = () => root.render(
  <WatchPage authToken="test" item={{ ...item }} video={video} videos={[video]}
    profileId="test" onBack={noop} onOpenVideo={noop} onSaveProgress={onSaveProgress} />,
)
window.renderSameVideo()
