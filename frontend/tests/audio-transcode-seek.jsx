import { createRoot } from 'react-dom/client'
import WatchPage from '../src/pages/watchpage'

// Real React/DOM lifecycle with deterministic, progressively arriving MP4 data.
// No media account or production backend is contacted.
const state = { source: '', time: 0, end: 0, ready: 0, paused: true, error: null, duration: Infinity }
const calls = { loads: [], seeks: [], unsafeSeeks: [], starts: [], closes: 0 }
let heldProbe = null
let holdProbe = false
let partialDuration = false
window.fetch = async (input, options = {}) => {
  const url = new URL(String(input), location.origin)
  let data = {}
  if (url.pathname.includes('gdrive-stream-details')) {
    data = {
      audio_transcode_required: true, audio_probe_status: 'ok', duration_ms: 600000,
      audio_transcode_url: '/fixture-transcode', audio_transcode_start_url: '/fixture-start',
      stream_url: '/fixture-original', audio_streams: [],
    }
  } else if (url.pathname === '/fixture-start') {
    const target = Number(url.searchParams.get('start_seconds'))
    calls.starts.push(target)
    if (holdProbe) await new Promise((resolve, reject) => {
      heldProbe = resolve
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
    data = { stream_start_seconds: target, timeline_offset_seconds: Math.floor(target / 10) * 10, timeline_offset_ready: true }
  }
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
const emit = (name) => document.querySelector('video').dispatchEvent(new Event(name))
const ranges = () => ({ length: state.end > 0 ? 1 : 0, start: () => 0, end: () => state.end })
Object.defineProperties(HTMLMediaElement.prototype, {
  src: { configurable: true, get: () => state.source, set: (value) => { state.source = value } },
  currentSrc: { configurable: true, get: () => state.source },
  duration: { configurable: true, get: () => state.duration },
  readyState: { configurable: true, get: () => state.ready },
  buffered: { configurable: true, get: ranges },
  seekable: { configurable: true, get: ranges },
  error: { configurable: true, get: () => state.error },
  paused: { configurable: true, get: () => state.paused },
  currentTime: {
    configurable: true, get: () => state.time,
    set(value) {
      calls.seeks.push(value)
      if (value >= state.end || state.ready < 2) {
        calls.unsafeSeeks.push(value)
        return
      }
      state.time = value
      const source = state.source
      queueMicrotask(() => {
        if (source !== state.source) return
        emit('seeking')
        emit('seeked')
        emit('timeupdate')
      })
    },
  },
})
const removeAttribute = HTMLMediaElement.prototype.removeAttribute
HTMLMediaElement.prototype.removeAttribute = function (name) {
  if (name === 'src') { state.source = ''; calls.closes += 1 }
  removeAttribute.call(this, name)
}
HTMLMediaElement.prototype.load = function () {
  state.time = 0; state.end = 0; state.ready = 0; state.error = null; state.paused = true
  state.duration = partialDuration ? 0.5 : Infinity
  if (!state.source) return
  calls.loads.push(Number(new URL(state.source).searchParams.get('start_seconds')))
  const source = state.source
  queueMicrotask(() => {
    if (source !== state.source) return
    state.ready = 1
    emit('loadedmetadata')
  })
}
HTMLMediaElement.prototype.play = function () {
  state.paused = false
  emit('play')
  if (state.ready >= 3) emit('playing')
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function () { state.paused = true; emit('pause') }

window.transcodeTest = {
  calls,
  bufferTo(end) {
    state.end = end; state.ready = 4
    if (partialDuration) state.duration = end
    emit('progress'); emit('loadeddata'); emit('canplay')
    if (!state.paused) emit('playing')
  },
  seek(target) {
    const slider = document.querySelector('.watch-seek')
    slider.value = String(target)
    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  },
  skip() { document.querySelector('[aria-label="Forward 10 seconds"]').click() },
  pause() { document.querySelector('video').pause() },
  holdProbe() { holdProbe = true },
  releaseProbe() { holdProbe = false; heldProbe?.() },
  partialDuration() { partialDuration = true },
  fail(code = 2) { state.error = { code }; emit('error') },
  snapshot() { return { ...state, target: Number(document.querySelector('.watch-seek')?.value), ...calls } },
}
const noop = () => {}
const video = { path: 'gdrive/fixture', name: 'Seek test.mkv' }
const resumeSeconds = Number(new URLSearchParams(location.search).get('resume'))
createRoot(document.getElementById('root')).render(
  <WatchPage authToken="test" item={{ path: 'test-movie', title: 'Test', media_type: 'movie' }}
    video={video} videos={[video]} resumeEntry={{ position_ms: resumeSeconds * 1000 }}
    profileId="test" onBack={noop} onOpenVideo={noop} onSaveProgress={async () => {}} />,
)
