import { Play, BookmarkPlus, ChevronLeft, ChevronRight, X } from 'lucide-react';
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTMDBInfo, TMDB_GENRES } from '../services/api';

export const MovieCard = ({ item, tag, isFirst, isLast, progress, variant = 'vertical', onDelete, isRemoving, delay = 0 }) => {
  const isHorizontal = variant === 'horizontal';
  const [isHovered, setIsHovered] = useState(false);
  const [tmdbData, setTmdbData] = useState(null);
  const hoverTimeoutRef = useRef(null);
  const navigate = useNavigate();
  const cardWidth = isHorizontal ? 260 : 190;
  const posterHeight = isHorizontal ? 165 : 285;

  const folderName = item?.folder_name || item?.name || '';
  const mediaType = item?.type || 'movie';
  
  const handleNavigate = () => {
    if (progress !== undefined) {
      // It's a Continue Watching card, go directly to WatchPage
      const ep = item.episode || 1;
      const s = item.season || 1;
      const type = item.series_title ? 'series' : 'movie';
      navigate(`/watch/${encodeURIComponent(folderName)}?ep=${ep}&s=${s}&type=${type}`);
    } else {
      navigate(`/detail/${encodeURIComponent(folderName)}?type=${mediaType}`);
    }
  };

  const handleMouseEnter = () => {
    // Detail popup removed per user request
  };

  const handleMouseLeave = () => {
    // Detail popup removed per user request
  };

  const title = item?.tmdb_title || item?.folder_name || item?.name || 'Loading...';

  useEffect(() => {
    // Only fetch if original poster is missing
    if (title !== 'Loading...' && !item.tmdb_poster_path && !item.poster && !tmdbData) {
      getTMDBInfo(title).then(data => {
        if (data) setTmdbData(data);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, title]);

  const rawPoster = item?.tmdb_poster_path || item?.poster || tmdbData?.poster_path || tmdbData?.backdrop_path;
  const posterPath = typeof rawPoster === 'string' ? rawPoster : '';
  const poster = posterPath
    ? (posterPath.startsWith('http') ? posterPath : `https://image.tmdb.org/t/p/w500${posterPath}`)
    : 'https://images.unsplash.com/photo-1485846234645-a62644f84728?q=80&w=2059&auto=format&fit=crop';

  const rating = item?.tmdb_rating || tmdbData?.rating || 0;
  const overview = item?.tmdb_overview || tmdbData?.overview || "A thrilling story awaits in this masterpiece.";
  const year = (tmdbData?.date || "2024").substring(0, 4);

  const isSeries = mediaType === 'series' || item?.media_type === 'tv' || item?.episodes;
  const episodesCount = item?.episodes ? `${item.episodes} Episodes` : (isSeries ? "24 Episodes" : "Movie");
  const bottomText = rating > 0 && tag !== 'Free' ? `★ ${Number(rating).toFixed(1)}` : episodesCount;

  const genres = tmdbData?.genre_ids && tmdbData.genre_ids.length > 0
    ? tmdbData.genre_ids.slice(0, 3).map(id => TMDB_GENRES[id]).filter(Boolean)
    : ["South Korea", "Romance", "Drama"];

  return (
    <div
      className={`relative flex-none transition-all duration-[400ms] ease-[cubic-bezier(0.4,0,0.2,1)] 
        ${isRemoving ? 'opacity-0 scale-75 translate-y-4 !w-0 !mr-[-1rem] pointer-events-none' : 'opacity-100 scale-100 translate-y-0'}
        animate-poster-reveal group cursor-pointer shrink-0`}
      style={{ 
        zIndex: isHovered ? 50 : 1, 
        width: `${cardWidth}px`, 
        minWidth: `${cardWidth}px`,
        animationDelay: `${delay * 105}ms`
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
          src={poster} 
          alt={title} 
          loading="lazy" 
          decoding="async" 
          className={`w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 ${!rawPoster ? 'opacity-30 grayscale' : 'opacity-100'}`} 
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

const MovieCarousel = ({ title, items, tagType, variant = 'vertical', onDelete, removingId }) => {
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
              <div key={idx} className="snap-start shrink-0">
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
