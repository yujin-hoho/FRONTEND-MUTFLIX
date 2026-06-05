import { memo, useEffect, useState } from 'react'
import { hasLoadedImageUrl, rememberLoadedImageUrl } from '../utils/imageLoadCache'

const MAX_CONCURRENT_LAZY_IMAGE_LOADS = 4

let activeLazyImageLoads = 0
const lazyImageQueue = []

const LoadableImage = memo(function LoadableImage({
  alt = '',
  className = '',
  fallbackSrc = '',
  fetchPriority,
  loading = 'lazy',
  shimmerOnError = true,
  src,
}) {
  const [useFallback, setUseFallback] = useState(false)
  const resolvedSrc = useFallback || !src ? fallbackSrc : src
  const [imageState, setImageState] = useState(() => getInitialImageState(src || fallbackSrc))
  const renderImageState = imageState
  const showShimmer = renderImageState === 'loading' || (renderImageState === 'error' && shimmerOnError)
  const shimmerClassName = renderImageState === 'error'
    ? 'image-shimmer image-shimmer-static'
    : 'image-shimmer'
  const queueLazyLoad = loading === 'lazy' && !fetchPriority
  const shouldRenderImage = renderImageState !== 'error' && (!queueLazyLoad || renderImageState === 'loaded' || hasLoadedImageUrl(resolvedSrc))

  useEffect(() => {
    setUseFallback(false)
    setImageState(getInitialImageState(src || fallbackSrc))
  }, [fallbackSrc, src])

  useEffect(() => {
    if (!queueLazyLoad || !resolvedSrc || hasLoadedImageUrl(resolvedSrc)) return undefined

    setImageState('loading')
    return enqueueLazyImageLoad(resolvedSrc, {
      onError: () => {
        if (fallbackSrc && resolvedSrc !== fallbackSrc) {
          setUseFallback(true)
          setImageState(getInitialImageState(fallbackSrc))
          return
        }
        setImageState('error')
      },
      onLoad: () => {
        rememberLoadedImageUrl(resolvedSrc)
        setImageState('loaded')
      },
    })
  }, [fallbackSrc, queueLazyLoad, resolvedSrc])

  if (!resolvedSrc) {
    return shimmerOnError
      ? <span className={renderImageState === 'error' ? 'image-shimmer image-shimmer-static' : 'image-shimmer'} aria-hidden="true" />
      : null
  }

  return (
    <>
      {showShimmer && <span className={shimmerClassName} aria-hidden="true" />}
      {shouldRenderImage && (
        <img
          alt={alt}
          className={`${className} ${renderImageState === 'loaded' ? 'image-loaded' : 'image-loading'}`.trim()}
          decoding="async"
          fetchPriority={fetchPriority}
          loading={loading}
          onError={() => {
            if (fallbackSrc && resolvedSrc !== fallbackSrc) {
              setUseFallback(true)
              setImageState(getInitialImageState(fallbackSrc))
              return
            }
            setImageState('error')
          }}
          onLoad={() => {
            rememberLoadedImageUrl(resolvedSrc)
            setImageState('loaded')
          }}
          src={resolvedSrc}
        />
      )}
    </>
  )
})

function getInitialImageState(src) {
  return hasLoadedImageUrl(src) ? 'loaded' : 'loading'
}

function enqueueLazyImageLoad(src, { onError, onLoad }) {
  const task = {
    canceled: false,
    onError,
    onLoad,
    src,
  }
  lazyImageQueue.push(task)
  pumpLazyImageQueue()

  return () => {
    task.canceled = true
  }
}

function pumpLazyImageQueue() {
  while (activeLazyImageLoads < MAX_CONCURRENT_LAZY_IMAGE_LOADS && lazyImageQueue.length > 0) {
    const task = lazyImageQueue.shift()
    if (!task || task.canceled) continue

    activeLazyImageLoads += 1
    loadQueuedImage(task)
  }
}

function loadQueuedImage(task) {
  if (typeof Image === 'undefined') {
    finishLazyImageLoad(task, 'load')
    return
  }

  const image = new Image()
  image.decoding = 'async'
  image.onload = () => finishLazyImageLoad(task, 'load')
  image.onerror = () => finishLazyImageLoad(task, 'error')
  image.src = task.src
}

function finishLazyImageLoad(task, result) {
  activeLazyImageLoads = Math.max(0, activeLazyImageLoads - 1)
  if (!task.canceled) {
    if (result === 'load') task.onLoad()
    else task.onError()
  }
  pumpLazyImageQueue()
}

export default LoadableImage
