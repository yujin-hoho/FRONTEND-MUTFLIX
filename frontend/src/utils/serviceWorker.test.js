import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')

function worker(cached, response) {
  const state = { deleted: 0, stored: [], fetches: [] }
  const cache = {
    match: async () => cached,
    delete: async () => { state.deleted += 1 },
    put: async (_, value) => { state.stored.push(value) },
  }
  const context = vm.createContext({
    self: { addEventListener() {} },
    caches: { open: async () => cache },
    fetch: async (_, options) => { state.fetches.push(options); return response },
  })
  vm.runInContext(source, context)
  return { state, cacheFirst: vm.runInContext('cacheFirst', context) }
}

test('evicts an HTML response poisoned under a JavaScript URL and refetches', async () => {
  const { state, cacheFirst } = worker(
    new Response('<html>Old fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('export default 1', { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }),
  )
  const result = await cacheFirst({ destination: 'script' }, 'static')
  assert.equal(await result.text(), 'export default 1')
  assert.equal(state.deleted, 1)
  assert.equal(state.stored.length, 1)
  assert.equal(state.fetches[0].cache, 'reload')
})

test('does not cache a successful HTML fallback as JS, CSS, or a font', async () => {
  for (const destination of ['script', 'style', 'font']) {
    const { state, cacheFirst } = worker(undefined,
      new Response('<html>Fallback</html>', { headers: { 'Content-Type': 'text/html' } }))
    await cacheFirst({ destination }, 'static')
    assert.equal(state.stored.length, 0)
  }
})

test('valid cached JavaScript remains available without a network request', async () => {
  const { state, cacheFirst } = worker(
    new Response('export default 1', { headers: { 'Content-Type': 'application/javascript' } }), undefined)
  assert.equal(await (await cacheFirst({ destination: 'script' }, 'static')).text(), 'export default 1')
  assert.equal(state.fetches.length, 0)
})

test('SPA routing excludes missing assets but keeps client routes', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
  const fallback = config.rewrites.find((route) => route.destination === '/index.html')
  const pattern = new RegExp(`^${fallback.source}$`)
  for (const path of ['/assets/missing.js', '/src/main.jsx', '/sw.js', '/missing.css']) assert.equal(pattern.test(path), false)
  for (const path of ['/', '/watch', '/profile/settings']) assert.equal(pattern.test(path), true)
  assert.equal(config.outputDirectory, 'dist')
})
