import { memo, useEffect, useRef, useState } from 'react'
import { hasLoadedImageUrl, rememberLoadedImageUrl } from '../utils/imageLoadCache'
import { requestImageLoad } from '../utils/imageQueue'

const LoadableImage = memo(function LoadableImage({
  alt = '',
  className = '',
  fallbackSrc = '',
  fetchPriority,
  loading = 'lazy',
  showFallbackWhileLoading = false,
  shimmerOnError = true,
  src,
}) {
  const [useFallback, setUseFallback] = useState(false)
  const resolvedSrc = useFallback || !src ? fallbackSrc : src
  const [imageState, setImageState] = useState(() => getInitialImageState(src || fallbackSrc))
  const imgRef = useRef(null)
  const isPriority = fetchPriority === 'high' || loading === 'eager'

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

  // For non-priority GDrive images, pre-load via queue so we don't
  // blast the server with 30+ simultaneous requests
  useEffect(() => {
    if (!resolvedSrc || imageState === 'loaded' || imageState === 'error') return
    if (isPriority) return // Let browser handle priority images natively

    let cancelled = false
    requestImageLoad(resolvedSrc, { priority: false })
      .then(() => {
        if (!cancelled) {
          rememberLoadedImageUrl(resolvedSrc)
          setImageState('loaded')
        }
      })
      .catch(() => {
        if (!cancelled) {
          if (fallbackSrc && resolvedSrc !== fallbackSrc) {
            setUseFallback(true)
            setImageState(getInitialImageState(fallbackSrc))
          } else {
            setImageState('error')
          }
        }
      })

    return () => { cancelled = true }
  }, [resolvedSrc, isPriority, fallbackSrc]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!resolvedSrc) {
    return shimmerOnError
      ? <span className="image-shimmer" aria-hidden="true" />
      : null
  }

  const showLoadingFallback = Boolean(
    showFallbackWhileLoading
    && !useFallback
    && imageState === 'loading'
    && fallbackSrc
    && fallbackSrc !== resolvedSrc,
  )
  const showShimmer = (imageState === 'loading' && !showLoadingFallback) || (imageState === 'error' && shimmerOnError)
  const shouldRenderImage = imageState !== 'error' && Boolean(resolvedSrc)

  // For non-priority GDrive images managed by the queue:
  // don't set src on the img element until the queue has resolved,
  // so the browser doesn't bypass the queue by starting its own parallel load.
  const isGdrive = resolvedSrc.includes('/api/gdrive-poster')
  const useQueuedSrc = !isPriority && isGdrive
  const imgSrc = useQueuedSrc ? (imageState === 'loaded' ? resolvedSrc : '') : resolvedSrc

  return (
    <>
      {showShimmer && <span className="image-shimmer" aria-hidden="true" />}
      {showLoadingFallback && (
        <img
          alt=""
          aria-hidden="true"
          className={`${className} image-loaded image-loading-fallback`.trim()}
          decoding="async"
          loading="eager"
          src={fallbackSrc}
        />
      )}
      {shouldRenderImage && imgSrc && (
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
          key={imgSrc}
          src={imgSrc}
        />
      )}
    </>
  )
})

function getInitialImageState(src) {
  return hasLoadedImageUrl(src) ? 'loaded' : 'loading'
}

export default LoadableImage
