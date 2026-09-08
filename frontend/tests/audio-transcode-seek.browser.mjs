// Requires Vite on :5180 and a disposable Chrome with --remote-debugging-port=9224.
import assert from 'node:assert/strict'
const pages = await (await fetch('http://127.0.0.1:9224/json')).json()
const socket = new WebSocket(pages.find((entry) => entry.type === 'page').webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let id = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
async function until(expression) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out: ${expression}\n${JSON.stringify(await evaluate('transcodeTest.snapshot()'))}`)
}
try {
  await send('Page.navigate', { url: 'http://127.0.0.1:5180/tests/audio-transcode-seek.html' })
  await until('window.transcodeTest?.calls.loads.length === 1')
  await evaluate('transcodeTest.bufferTo(3)')
  await until('transcodeTest.snapshot().paused === false')

  await evaluate('transcodeTest.seek(67)')
  await until('transcodeTest.calls.loads.at(-1) === 67')
  assert.deepEqual(await evaluate('transcodeTest.calls.unsafeSeeks'), [], 'metadata must not seek beyond downloaded data')
  await evaluate('transcodeTest.bufferTo(2)')
  assert.equal(await evaluate('transcodeTest.snapshot().target'), 67)
  assert.equal(await evaluate('transcodeTest.snapshot().paused'), true)
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7 && !transcodeTest.snapshot().paused')
  assert.equal(await evaluate('transcodeTest.snapshot().target'), 67)
  console.log('PASS: out-of-buffer seek waits for keyframe preroll data, then resumes at the exact target')

  const loads = await evaluate('transcodeTest.calls.loads.length')
  await evaluate('transcodeTest.seek(65)')
  await until('transcodeTest.snapshot().time === 5')
  assert.equal(await evaluate('transcodeTest.calls.loads.length'), loads)
  console.log('PASS: buffered backward seek reuses the current stream')

  await evaluate('transcodeTest.pause(); transcodeTest.seek(127)')
  await until('transcodeTest.calls.loads.at(-1) === 127')
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7')
  assert.equal(await evaluate('transcodeTest.snapshot().paused'), true)
  const pausedLoads = await evaluate('transcodeTest.calls.loads.length')
  await evaluate('transcodeTest.seek(125)')
  await until('transcodeTest.snapshot().time === 5')
  assert.equal(await evaluate('transcodeTest.calls.loads.length'), pausedLoads, 'paused seek must finish and release the pending target')
  console.log('PASS: paused seek finishes and supports another buffered seek without restarting')

  await evaluate('transcodeTest.seek(187)')
  await until('transcodeTest.calls.loads.at(-1) === 187')
  await evaluate('transcodeTest.fail()')
  await until('transcodeTest.calls.loads.filter(value => value === 187).length === 2')
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7')
  console.log('PASS: a media error retries the requested position, including keyframe preroll')

  await evaluate('transcodeTest.fail(); transcodeTest.seek(247); transcodeTest.skip(); transcodeTest.skip()')
  await until('transcodeTest.calls.loads.at(-1) === 267')
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7')
  await new Promise((resolve) => setTimeout(resolve, 1600))
  assert.equal(await evaluate('transcodeTest.calls.loads.at(-1)'), 267, 'stale recovery must not overwrite a later skip')
  console.log('PASS: rapid skips accumulate and cancel recovery of the previous position')

  await evaluate('transcodeTest.holdProbe(); transcodeTest.seek(327)')
  await until('transcodeTest.calls.starts.at(-1) === 327')
  assert.equal(await evaluate('transcodeTest.snapshot().source'), '', 'release the old transcoder while resolving the new position')
  await evaluate('transcodeTest.releaseProbe()')
  await until('transcodeTest.calls.loads.at(-1) === 327')
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7')
  assert.deepEqual(await evaluate('transcodeTest.calls.unsafeSeeks'), [])
  console.log('PASS: the previous media request closes before the next probe finishes')

  await evaluate('transcodeTest.partialDuration(); transcodeTest.seek(367)')
  await until('transcodeTest.calls.loads.at(-1) === 367')
  assert.equal(await evaluate('transcodeTest.snapshot().target'), 367)
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7')
  assert.deepEqual(await evaluate('transcodeTest.calls.unsafeSeeks'), [])
  console.log('PASS: a partial MP4 duration never clamps the requested seek to the first fragment')

  await send('Page.navigate', { url: 'http://127.0.0.1:5180/tests/audio-transcode-seek.html?resume=67' })
  await until('window.transcodeTest?.calls.loads.length === 1 && transcodeTest.calls.loads[0] === 67')
  await evaluate('transcodeTest.bufferTo(2)')
  assert.equal(await evaluate('transcodeTest.snapshot().paused'), true)
  await evaluate('transcodeTest.bufferTo(10)')
  await until('transcodeTest.snapshot().time === 7 && !transcodeTest.snapshot().paused')
  assert.deepEqual(await evaluate('transcodeTest.calls.unsafeSeeks'), [])
  console.log('PASS: Continue Watching restores the absolute position after buffering')
} finally {
  socket.close()
}
