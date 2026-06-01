export const DESKTOP_MIN_WIDTH_PX = 1024
const DESKTOP_VIEWPORT_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`

export function isDesktopViewport() {
  return window.matchMedia(DESKTOP_VIEWPORT_QUERY).matches
}

export function subscribeToDesktopViewport(callback) {
  const mediaQuery = window.matchMedia(DESKTOP_VIEWPORT_QUERY)
  mediaQuery.addEventListener('change', callback)
  return () => mediaQuery.removeEventListener('change', callback)
}
