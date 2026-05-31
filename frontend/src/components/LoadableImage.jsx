import { memo, useState } from 'react'

const LoadableImage = memo(function LoadableImage({
  alt = '',
  className = '',
  fallbackSrc = '',
  fetchPriority,
  loading = 'lazy',
  shimmerOnError = true,
  src,
}) {
  const [imageState, setImageState] = useState('loading')
  const [useFallback, setUseFallback] = useState(false)
  const resolvedSrc = useFallback || !src ? fallbackSrc : src
  const showShimmer = imageState === 'loading' || (imageState === 'error' && shimmerOnError)
  const shimmerClassName = loading === 'lazy' || imageState === 'error'
    ? 'image-shimmer image-shimmer-static'
    : 'image-shimmer'

  if (!resolvedSrc) return shimmerOnError ? <span className="image-shimmer image-shimmer-static" aria-hidden="true" /> : null

  return (
    <>
      {showShimmer && <span className={shimmerClassName} aria-hidden="true" />}
      {imageState !== 'error' && (
        <img
          alt={alt}
          className={`${className} ${imageState === 'loaded' ? 'image-loaded' : 'image-loading'}`.trim()}
          decoding="async"
          fetchPriority={fetchPriority}
          loading={loading}
          onError={() => {
            if (fallbackSrc && resolvedSrc !== fallbackSrc) {
              setUseFallback(true)
              setImageState('loading')
              return
            }
            setImageState('error')
          }}
          onLoad={() => setImageState('loaded')}
          src={resolvedSrc}
        />
      )}
    </>
  )
})

export default LoadableImage
