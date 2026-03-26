import { Play, BookmarkPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTMDBInfo, TMDB_GENRES } from '../services/api';

const MovieCard = ({ item, tag, isFirst, isLast }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [tmdbData, setTmdbData] = useState(null);
  const hoverTimeoutRef = useRef(null);
  const navigate = useNavigate();
  
  const folderName = item?.folder_name || item?.name || '';
  const mediaType = item?.type || 'movie';
  const handleNavigate = () => navigate(`/detail/${encodeURIComponent(folderName)}?type=${mediaType}`);
  
  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setIsHovered(true), 350);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHovered(false);
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
  const poster = rawPoster 
    ? (rawPoster.startsWith('http') ? rawPoster : `https://image.tmdb.org/t/p/w500${rawPoster}`) 
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
      className="relative flex-none w-[150px] md:w-[185px] group cursor-pointer transition-all duration-300 shrink-0"
      style={{ zIndex: isHovered ? 50 : 1 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Poster Container */}
      <div onClick={handleNavigate} className="w-full aspect-[2/3] rounded overflow-hidden bg-[#1b1d22] relative border border-transparent group-hover:border-white/20 transition-colors duration-300">
        <img src={poster} alt={title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
        
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
          <span className="text-white text-[11px] font-medium tracking-wide">{bottomText}</span>
        </div>
      </div>

      {/* Title Below Poster */}
      <div className="mt-2 px-0.5">
        <h3 className="text-[#e2e2e2] text-[15px] font-medium line-clamp-2 md:line-clamp-1 group-hover:text-[#00dc41] transition-colors">{title}</h3>
      </div>

      {/* Hover Popup Effect for details on large screens */}
      {isHovered && (
        <div 
          className={`absolute top-1/2 -translate-y-[45%] w-[320px] bg-[#1a1c22] rounded-lg shadow-[0_20px_60px_rgba(0,0,0,0.95)] border border-white/10 hidden lg:block pb-1 z-[100] transform transition-all duration-300 animate-popup ${
            isFirst ? 'left-0 origin-left' : isLast ? 'right-0 origin-right' : 'left-1/2 -translate-x-1/2 origin-center'
          }`}
          onClick={handleNavigate}
        >
          <div className="relative w-full h-[180px] rounded-t-lg overflow-hidden">
            <img src={poster} className="w-full h-full object-cover object-top" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#1a1c22] via-[#1a1c22]/40 to-transparent"></div>
            
            <button 
              className="absolute bottom-3 right-14 bg-white/10 backdrop-blur text-white border border-white/20 rounded-full p-2 shadow-lg hover:bg-white/20 transition"
              onClick={(e) => { e.stopPropagation(); /* Add to List Action */ }}
            >
              <BookmarkPlus size={18} />
            </button>
            <button 
              className="absolute bottom-3 right-3 bg-[#00dc41] text-black rounded-full p-2 shadow-[0_0_15px_rgba(0,220,65,0.4)] hover:scale-105 hover:bg-[#00f048] transition"
              onClick={(e) => { e.stopPropagation(); /* Play Action */ }}
            >
              <Play fill="black" size={18} className="ml-0.5" />
            </button>
          </div>
          
          <div className="p-4 pt-2">
            <h3 className="text-white font-bold text-[17px] mb-1.5 line-clamp-1">{title}</h3>
            <div className="flex items-center gap-1.5 text-[11px] text-gray-400 mb-2.5 font-medium">
              <span className="text-[#00dc41] font-bold text-[13px]">★ {rating > 0 ? Number(rating).toFixed(1) : 'NR'}</span>
              <span className="px-0.5">|</span>
              <span className="border border-gray-600 px-1 rounded-sm text-[10px]">13+</span>
              <span className="px-0.5">|</span>
              <span>{year}</span>
              <span className="px-0.5">|</span>
              <span>{isSeries ? '30 Episodes' : 'Movie'}</span>
            </div>
            
            <div className="flex items-center gap-1.5 text-[10px] text-gray-400 mb-3 font-semibold">
              {genres.map((g, i) => (
                <span key={i} className="bg-white/5 py-1 px-1.5 rounded hover:text-white transition cursor-pointer">{g}</span>
              ))}
            </div>
            
            <p className="text-[#a0a0a0] text-xs line-clamp-2 leading-relaxed">
              {overview}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

const MovieCarousel = ({ title, items, tagType }) => {
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
    <div className="mb-10 px-6 md:px-[60px] w-full relative group/carousel flex flex-col items-center">
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
          className="absolute -left-5 md:-left-12 lg:-left-12 top-[40%] -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110"
        >
          <ChevronLeft size={30} strokeWidth={2.5} />
        </button>

        {/* Right Arrow Navigation */}
        <button 
          onClick={scrollRight}
          className="absolute -right-5 md:-right-12 lg:-right-12 top-[40%] -translate-y-1/2 z-40 bg-[#16181db3] hover:bg-[#1a1c22f2] text-white/50 hover:text-white p-2 md:p-3 rounded-full opacity-0 group-hover/carousel:opacity-100 transition-all duration-300 hidden sm:flex items-center justify-center shadow-2xl backdrop-blur-md hover:scale-110"
        >
          <ChevronRight size={30} strokeWidth={2.5} />
        </button>

        {/* Scrollable Track */}
        <div 
          ref={scrollRef}
          className="flex gap-3 md:gap-4 overflow-x-auto overflow-y-visible no-scrollbar pb-6 scroll-smooth snap-x active:cursor-grabbing w-full"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {items?.length > 0 ? (
            items.map((item, idx) => (
              <div key={item.id || item.folder_name || item.name || idx} className="snap-start shrink-0">
                 <MovieCard 
                   item={item} 
                   tag={tagType === 'free' ? 'Free' : tagType === 'original' ? 'Original' : tagType === 'top' ? 'TOP 10' : null}
                   isFirst={idx === 0}
                   isLast={idx === items.length - 1}
                 />
              </div>
            ))
          ) : (
            [...Array(8)].map((_, i) => (
              <div key={i} className="snap-start shrink-0 w-[150px] md:w-[185px] group cursor-wait">
                 <div className="w-full aspect-[2/3] bg-[#22252b]/60 rounded-md animate-pulse border border-white/5"></div>
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
export { MovieCard };
