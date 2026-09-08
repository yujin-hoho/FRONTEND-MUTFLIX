export function installChunkRecovery(browser, buildUrl) {
  // A tab from the previous deployment can still request a removed lazy chunk.
  // Retry once per build and tab; persistent failures must not cause a reload loop.
  browser.addEventListener('vite:preloadError', (event) => {
    if (browser.navigator.onLine === false) return
    const key = 'mutflix.chunk-reload'
    try {
      if (browser.sessionStorage.getItem(key) === buildUrl) return
      browser.sessionStorage.setItem(key, buildUrl)
    } catch {
      return
    }
    event.preventDefault()
    browser.location.reload()
  })
}
