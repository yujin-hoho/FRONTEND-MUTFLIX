import { memo, useEffect, useRef, useState } from 'react'
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
  const imgRef = useRef(null)

  useEffect(() => {
    setUseFallback(false)
    setImageState(getInitialImageState(src || fallbackSrc))
  }, [fallbackSrc, src])

  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current?.naturalWidth > 0) {
      rememberLoadedImageUrl(resolvedSrc)
      setImageState('loaded')
    }
  }, [resolvedSrc])

  if (!resolvedSrc) {
    return shimmerOnError
      ? <span className="image-shimmer" aria-hidden="true" />
      : null
  }

  const showShimmer = imageState === 'loading' || (imageState === 'error' && shimmerOnError)
  const shouldRenderImage = imageState !== 'error' && Boolean(resolvedSrc)

  return (
    <>
      {showShimmer && <span className="image-shimmer" aria-hidden="true" />}
      {shouldRenderImage && (
        <img
          alt={alt}
          className={`${className} ${imageState === 'loaded' ? 'image-loaded' : 'image-loading'}`.trim()}
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
          ref={(node) => {
            imgRef.current = node
            if (node?.complete && node?.naturalWidth > 0) {
              rememberLoadedImageUrl(resolvedSrc)
              if (imageState !== 'loaded') {
                setImageState('loaded')
              }
            }
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
