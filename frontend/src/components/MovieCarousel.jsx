import { Play, BookmarkPlus, ChevronLeft, ChevronRight, X, Pencil } from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTMDBInfo, TMDB_GENRES, fetchVideos } from '../services/api';
import { detailTypeOfItem, isSeriesLike } from '../utils/mediaType';
import { preloadContentDetailRoute, preloadWatchPageRoute } from '../utils/routePreload';
import { cleanTitleOutsideParentheses } from '../utils/cleanTitle';

const tmdbOptsFromItem = (item) => {
  if (!item?.tmdb_query) return {};
  const o = {
    query: item.tmdb_query,
    mediaType: item.tmdb_override_media_type === 'movie' ? 'movie' : 'tv',
  };
  if (item.override_year != null && item.override_year !== '') o.year = Number(item.override_year);
  if (item.override_region) o.region = item.override_region;
  if (item.include_adult) o.includeAdult = true;
  return o;
};

export const MovieCard = ({ item, tag, isFirst, isLast, progress, variant = 'vertical', onDelete, isRemoving, delay = 0, isAdmin, onEditPoster, posterFadeIn }) => {
  const isHorizontal = variant === 'horizontal';
  const [isHovered, setIsHovered] = useState(false);
  const [tmdbData, setTmdbData] = useState(null);
  const [posterLoaded, setPosterLoaded] = useState(false);
  const hoverTimeoutRef = useRef(null);
  const imgRef = useRef(null);
  const navigate = useNavigate();
  const cardWidth = isHorizontal ? 260 : 190;
  const posterHeight = isHorizontal ? 165 : 285;

  const tmdbImageUrl = (path, size = 'w500') => {
    if (!path || typeof path !== 'string') return '';
    if (path.startsWith('http')) return path;
    const p = path.startsWith('/') ? path : `/${path}`;
    return `https://image.tmdb.org/t/p/${size}${p}`;
  };

  const folderName = item?.folder_name || item?.name || '';
  const handleNavigate = async () => {
    if (progress !== undefined) {
      void preloadWatchPageRoute();
      let ep = item.episode ?? 1;
      let s = item.season ?? 1;
      if (item.media_path && folderName && (item.season == null || item.episode == null)) {
        try {
          const resp = await fetchVideos(decodeURIComponent(folderName));
          const hit = (resp?.videos || []).find((v) => v.path === item.media_path);
          if (hit) {
            ep = hit.episode ?? ep;
            s = hit.season ?? s;
          }
        } catch {
          /* keep defaults */
        }
      }
      const type = detailTypeOfItem(item);
      navigate(`/watch/${encodeURIComponent(folderName)}?ep=${ep}&s=${s}&type=${type}`);
    } else {
      void preloadContentDetailRoute();
      navigate(`/detail/${encodeURIComponent(folderName)}?type=${detailTypeOfItem(item)}`);
    }
  };

  const handleMouseEnter = () => {
    // Warm route chunk to reduce click->detail delay.
    void preloadContentDetailRoute();
  };

  const handleMouseLeave = () => {
    // Detail popup removed per user request
  };

  const rawTitle = item?.tmdb_title || item?.folder_name || item?.name || 'Loading...';
  const title = cleanTitleOutsideParentheses(rawTitle) || 'Loading...';

  /** Berubah saat admin edit query TMDB — harus refetch, jangan pakai tmdbData lama */
  const tmdbFetchSignature = [
    item?.tmdb_query ?? '',
    item?.tmdb_override_media_type ?? '',
    item?.override_year ?? '',
    item?.override_region ?? '',
    item?.include_adult ? '1' : '0',
    item?.name ?? '',
    item?.folder_name ?? '',
  ].join('|');

  useEffect(() => {
    if (title === 'Loading...') return;
    if (item.tmdb_poster_path || item.poster_path || item.poster) {
      setTmdbData(null);
      return;
    }
    setTmdbData(null);
    let cancelled = false;
    const searchTitle = item.tmdb_query || title;
    getTMDBInfo(searchTitle, { ...tmdbOptsFromItem(item), light: true }).then((data) => {
      if (!cancelled && data) setTmdbData(data);
    });
    return () => {
      cancelled = true;
    };
  }, [title, tmdbFetchSignature, item.tmdb_poster_path, item.poster_path, item.poster]);

  const rawPoster = item?.poster_path || item?.tmdb_poster_path || item?.poster || tmdbData?.poster_path || tmdbData?.backdrop_path;
  const posterPath = typeof rawPoster === 'string' ? rawPoster : '';
  const poster = posterPath ? tmdbImageUrl(posterPath, 'w500') : 'https://images.unsplash.com/photo-1485846234645-a62644f84728?q=80&w=2059&auto=format&fit=crop';

  useEffect(() => {
    setPosterLoaded(false);
  }, [poster]);

  // Safety net: some browsers/cached images may skip load event.
  // If image is already complete, mark as loaded so grayscale/opacity won't get stuck.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) {
      setPosterLoaded(true);
    }
  }, [poster]);

  const rating = item?.tmdb_rating || tmdbData?.rating || 0;
  const overview = item?.tmdb_overview || tmdbData?.overview || "A thrilling story awaits in this masterpiece.";
  const year = (tmdbData?.date || "2024").substring(0, 4);

  const isSeries = isSeriesLike(item);
  const episodesCount = item?.episodes ? `${item.episodes} Episodes` : (isSeries ? "24 Episodes" : "Movie");
  const bottomText = rating > 0 && tag !== 'Free' ? `★ ${Number(rating).toFixed(1)}` : episodesCount;

  const genres = tmdbData?.genre_ids && tmdbData.genre_ids.length > 0
    ? tmdbData.genre_ids.slice(0, 3).map(id => TMDB_GENRES[id]).filter(Boolean)
    : ["South Korea", "Romance", "Drama"];

  return (
    <div
      className={`relative flex-none transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] 
        ${isRemoving ? 'opacity-0 scale-75 translate-y-4 !w-0 !mr-[-1rem] pointer-events-none' : 'opacity-100 scale-100 translate-y-0'}
        ${posterFadeIn ? '' : 'animate-poster-reveal'} group cursor-pointer shrink-0`}
      style={{ 
        zIndex: isHovered ? 50 : 1, 
        width: `${cardWidth}px`, 
        minWidth: `${cardWidth}px`,
        animationDelay: posterFadeIn ? undefined : `${delay * 105}ms`
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Poster Container */}
      <div
        onClick={handleNavigate}
        className="w-full rounded overflow-hidden bg-[#1b1d22] relative border border-transparent group-hover:border-white/20 transition-colors duration-300"
        style={{ height: `${posterHeight}px` }}
      >
        <img 
          ref={imgRef}
          src={poster} 
          alt={title} 
          loading="lazy" 
          decoding="async" 
          onLoad={() => posterFadeIn && setPosterLoaded(true)}
          onError={() => posterFadeIn && setPosterLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-500 transition-transform duration-500 group-hover:scale-105 ${
            posterFadeIn && rawPoster
              ? posterLoaded
                ? 'opacity-100'
                : 'opacity-30 grayscale'
              : !rawPoster
                ? 'opacity-30 grayscale'
                : 'opacity-100'
          }`} 
        />
        
        {!rawPoster && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
            <span className="text-gray-400 text-sm font-bold line-clamp-3">{title}</span>
          </div>
        )}

        {/* Top Right Tag - Free */}
        {tag === 'Free' && (
          <div className="absolute top-0 right-0 bg-[#00d639] text-white text-[11px] font-bold px-1.5 py-0.5 rounded-bl-sm z-10 shadow-sm">
            Free
          </div>
        )}

        {/* Top Right Tag - iQIYI Only */}
        {tag === 'Original' && (
          <div className="absolute top-0 right-0 bg-[#00d639] text-white text-[11px] font-bold px-1.5 py-0.5 rounded-bl-sm z-10 shadow-sm">
            iQIYI Only
          </div>
        )}

        {/* Top Right Tag - TOP 10 */}
        {tag === 'TOP 10' && (
          <div className="absolute top-0 right-0 bg-[#00d639] text-white text-[11px] font-bold px-1.5 py-0.5 rounded-bl-sm z-10 flex items-center shadow-sm">
            TOP <span className="text-black font-black ml-1">10</span>
          </div>
        )}

        {isAdmin && onEditPoster && progress === undefined && folderName && (
          <button
            type="button"
            title="Edit poster (TMDB)"
            onClick={(e) => {
              e.stopPropagation();
              onEditPoster({ ...item, name: item.name || item.folder_name, folder_name: folderName });
            }}
            className={`absolute z-[32] p-1.5 rounded-md bg-black/70 hover:bg-black/90 text-white/90 border border-white/15 opacity-0 group-hover:opacity-100 transition-opacity ${tag === 'TOP 10' ? 'top-9 right-2' : 'top-2 right-2'}`}
          >
            <Pencil size={14} strokeWidth={2.5} />
          </button>
        )}

        {/* Bottom text inside poster (episodes/rating) */}
        <div className="absolute bottom-0 left-0 w-full pt-8 pb-1.5 px-2 bg-gradient-to-t from-black/90 via-black/40 to-transparent">
          {progress !== undefined && (
            <div className="w-full bg-white/20 h-[3px] rounded-full mb-1.5 overflow-hidden">
              <div 
                className="bg-[#00dc41] h-full" 
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              ></div>
            </div>
          )}
          {!isHorizontal && <span className="text-white text-[11px] font-medium tracking-wide">{bottomText}</span>}
        </div>

        {/* Delete button (X) for Continue Watching / Horizontal variant */}
        {isHorizontal && onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(item);
            }}
            className="absolute top-2 right-2 bg-black/60 hover:bg-black/90 text-white/70 hover:text-white p-1 rounded-full backdrop-blur-md border border-white/10 opacity-0 group-hover:opacity-100 transition-all z-20"
            title="Remove from history"
          >
            <X size={14} strokeWidth={3} />
          </button>
        )}
      </div>

      {/* Title Below Poster */}
      <div className="mt-2 px-0.5">
        <h3 className="text-white text-[15px] font-bold line-clamp-2 transition-colors">{title}</h3>
      </div>

      {/* Detail popup removed per user request */}
    </div>
  );
};

const MovieCarousel = ({ title, items, tagType, variant = 'vertical', onDelete, removingId, isAdmin, onEditPoster }) => {
  const isHorizontal = variant === 'horizontal';
  const scrollRef = useRef(null);

  const scrollLeft = () => {
    if (scrollRef.current) {
      const { scrollLeft, clientWidth } = scrollRef.current;
      scrollRef.current.scrollTo({ left: scrollLeft - clientWidth * 0.8, behavior: 'smooth' });
    }
  };

  const scrollRight = () => {
    if (scrollRef.current) {
      const { scrollLeft, clientWidth } = scrollRef.current;
      scrollRef.current.scrollTo({ left: scrollLeft + clientWidth * 0.8, behavior: 'smooth' });
    }
  };

  return (
    <div className={`${isHorizontal ? 'mb-6' : 'mb-10'} px-6 md:px-[60px] w-full relative group/carousel flex flex-col items-start transition-all`}>
      <div className="w-full flex items-center justify-between mb-4">
        <h2 className="text-[20px] md:text-[22px] font-bold text-[#f5f5f5] tracking-wide">{title}</h2>
        {/* Only show 'More' if not TOP 10 section to match image closely */}
        {tagType !== 'top' && tagType !== 'free' && (
          <button className="text-gray-400 hover:text-[#00dc41] text-[13px] font-medium opacity-0 group-hover/carousel:opacity-100 transition duration-300">More &gt;</button>
        )}
      </div>

      {/* Container for absolute arrows and scrollable track */}
      <div className="relative w-full">
        {/* Left Arrow Navigation */}
        <button
          onClick={scrollLeft}
          className={`absolute -left-5 md:-left-12 lg:-left-12 ${isHorizontal ? 'top-[35%]' : 'top-[40%]'} -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110`}
        >
          <ChevronLeft size={isHorizontal ? 24 : 30} strokeWidth={2.5} />
        </button>

        {/* Right Arrow Navigation */}
        <button
          onClick={scrollRight}
          className={`absolute -right-5 md:-right-12 lg:-right-12 ${isHorizontal ? 'top-[35%]' : 'top-[40%]'} -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110`}
        >
          <ChevronRight size={isHorizontal ? 24 : 30} strokeWidth={2.5} />
        </button>

        <div
          ref={scrollRef}
          className="flex flex-nowrap items-start gap-3 md:gap-4 no-scrollbar py-2 pb-4 px-1 w-full overflow-x-auto scroll-smooth snap-x"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {items?.length > 0 ? (
            items.map((item, idx) => (
              <div
                key={item.folder_name || item.name || item.media_path || `row-${idx}`}
                className="snap-start shrink-0"
              >
                <MovieCard
                  item={item}
                  tag={tagType === 'top' ? 'TOP 10' : null}
                  isFirst={idx === 0}
                  isLast={idx === items.length - 1}
                  progress={item.progress}
                  variant={variant}
                  onDelete={variant === 'horizontal' ? (item) => onDelete && onDelete(item) : null}
                  isRemoving={variant === 'horizontal' && !!removingId && removingId === item.media_path}
                  delay={idx}
                  isAdmin={isAdmin}
                  onEditPoster={onEditPoster}
                />
              </div>
            ))
          ) : (
            [...Array(8)].map((_, i) => (
              <div
                key={i}
                className="snap-start shrink-0 group cursor-wait"
                style={{ width: `${isHorizontal ? 260 : 190}px`, minWidth: `${isHorizontal ? 260 : 190}px` }}
              >
                <div
                  className="w-full bg-[#22252b]/60 rounded-md animate-pulse border border-white/5"
                  style={{ height: `${isHorizontal ? 165 : 285}px` }}
                ></div>
                <div className="mt-2.5 h-4 w-3/4 bg-[#22252b]/60 rounded animate-pulse"></div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default MovieCarousel;
