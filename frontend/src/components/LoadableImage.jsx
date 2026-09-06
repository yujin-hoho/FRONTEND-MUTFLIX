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
  const containerRef = useRef(null)
  const [proximity, setProximity] = useState(0)
  const isPriority = fetchPriority === 'high' || loading === 'eager'

  useEffect(() => {
    if (isPriority) return
    const target = containerRef.current?.parentElement
    if (!target) return
    if (typeof IntersectionObserver === 'undefined') {
      setProximity(2)
      return
    }
    const nearby = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setProximity((current) => Math.max(current, 1))
    }, { rootMargin: '900px 300px' })
    const visible = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setProximity(2)
    })
    nearby.observe(target)
    visible.observe(target)
    return () => { nearby.disconnect(); visible.disconnect() }
  }, [isPriority, resolvedSrc])

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

  // Start nearby artwork through the shared queue; visible artwork gets priority.
  useEffect(() => {
    if (!resolvedSrc || imageState === 'loaded' || imageState === 'error') return
    if (isPriority) return // Let browser handle priority images natively
    if (!proximity) return

    let cancelled = false
    requestImageLoad(resolvedSrc, { priority: proximity === 2 })
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
  }, [resolvedSrc, isPriority, fallbackSrc, proximity]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // For non-priority images managed by the queue:
  // don't set src on the img element until the queue has resolved,
  // so the browser doesn't bypass the queue by starting its own parallel load.
  const useQueuedSrc = !isPriority
  const imgSrc = useQueuedSrc ? (imageState === 'loaded' ? resolvedSrc : '') : resolvedSrc

  return (
    <span ref={containerRef} style={{ display: 'contents' }}>
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
          loading="eager"
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
    </span>
  )
})

function getInitialImageState(src) {
  return hasLoadedImageUrl(src) ? 'loaded' : 'loading'
}

export default LoadableImage
