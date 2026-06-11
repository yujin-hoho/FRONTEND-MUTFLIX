import { memo, useEffect, useState } from 'react'
import { hasLoadedImageUrl, rememberLoadedImageUrl } from '../utils/imageLoadCache'

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
  const shouldRenderImage = renderImageState !== 'error'

  useEffect(() => {
    setUseFallback(false)
    setImageState(getInitialImageState(src || fallbackSrc))
  }, [fallbackSrc, src])

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

export default LoadableImage
