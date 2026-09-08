import assert from 'node:assert/strict'
import test from 'node:test'
import { installChunkRecovery } from './chunkRecovery.js'

test('a removed lazy chunk reloads once per build without looping', () => {
  const values = new Map()
  let handleError
  let reloads = 0
  let prevented = 0
  const browser = {
    addEventListener: (_, handler) => { handleError = handler },
    navigator: { onLine: true },
    sessionStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    location: { reload: () => { reloads += 1 } },
  }
  const event = { preventDefault: () => { prevented += 1 } }
  installChunkRecovery(browser, '/assets/app-v1.js')
  handleError(event)
  installChunkRecovery(browser, '/assets/app-v1.js')
  handleError(event)
  assert.equal(reloads, 1)
  assert.equal(prevented, 1)
  installChunkRecovery(browser, '/assets/app-v2.js')
  handleError(event)
  assert.equal(reloads, 2)
  browser.navigator.onLine = false
  installChunkRecovery(browser, '/assets/app-v3.js')
  handleError(event)
  assert.equal(reloads, 2)
})

test('storage restrictions leave the error visible instead of risking a reload loop', () => {
  let handleError
  installChunkRecovery({
    addEventListener: (_, handler) => { handleError = handler },
    navigator: { onLine: true },
    sessionStorage: { getItem() { throw new Error('Storage blocked') } },
    location: { reload() { assert.fail('Unexpected reload') } },
  }, '/assets/app.js')
  handleError({ preventDefault() { assert.fail('Error must remain visible') } })
})
