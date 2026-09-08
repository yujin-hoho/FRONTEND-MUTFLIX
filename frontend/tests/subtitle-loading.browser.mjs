// Requires Vite on :5179 and Chrome launched with --remote-debugging-port=9223.
import assert from 'node:assert/strict'
const pages = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = pages.find((entry) => entry.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let id = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
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
try {
  await send('Page.navigate', { url: 'http://127.0.0.1:5179/tests/subtitle-loading.html' })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await evaluate('Boolean(document.querySelector(".watch-subtitles"))')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const before = await evaluate('({text:document.querySelector(".watch-subtitles")?.textContent, requests:window.subtitleRequests, loads:window.playerLoads})')
  assert.equal(before.text, 'Continuous test caption')
  const after = await evaluate(`new Promise((resolve) => {
    window.renderSameVideo();
    setTimeout(() => resolve({text:document.querySelector('.watch-subtitles')?.textContent || '', requests:window.subtitleRequests, loads:window.playerLoads}), 100);
  })`)
  console.log(JSON.stringify({ before, after }, null, 2))
  assert.equal(after.text, before.text, 'same-video metadata update must not blank the caption')
  assert.equal(after.requests, before.requests, 'same-video metadata update must not reload subtitles')
  assert.equal(after.loads, before.loads, 'same-video metadata update must not reload the player')
} finally {
  socket.close()
}
