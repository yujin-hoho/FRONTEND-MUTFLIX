import { Play, BookmarkPlus, Pencil } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const HeroBanner = ({ items, isAdmin, onEditPoster }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const navigate = useNavigate();
  const scrollRef = useRef(null);

  // Auto rotate
  useEffect(() => {
    if (!items || items.length <= 1) return;
    const interval = setInterval(() => {
      const nextIndex = (currentIndex + 1) % items.length;
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          left: nextIndex * scrollRef.current.offsetWidth,
          behavior: 'smooth'
        });
      }
      setCurrentIndex(nextIndex);
    }, 10000); // Slower rotation (10s) to enjoy the zoom
    return () => clearInterval(interval);
  }, [items, currentIndex]);

  const handleScroll = (e) => {
    const scrollLeft = e.target.scrollLeft;
    const width = e.target.offsetWidth;
    const newIndex = Math.round(scrollLeft / width);
    if (newIndex !== currentIndex && newIndex < items.length) {
      setCurrentIndex(newIndex);
    }
  };

  const scrollToBanner = (index) => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        left: index * scrollRef.current.offsetWidth,
        behavior: 'smooth'
      });
    }
    setCurrentIndex(index);
  };

  if (!items || items.length === 0) return <div className="h-[90vh] bg-[#0a0c10] animate-pulse w-full"></div>;

  return (
    <div className="relative w-full h-[75vh] md:h-[95vh] bg-[#0a0c10] overflow-hidden">
      {/* Scrollable Container */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex w-full h-full overflow-x-auto no-scrollbar snap-x snap-mandatory scroll-smooth"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {items.map((item, index) => {
          const rawPoster = item.tmdb_backdrop_path || item.tmdb_poster_path || item.poster;
          const bgImage = rawPoster
            ? (rawPoster.startsWith('http') ? rawPoster : `https://image.tmdb.org/t/p/original${rawPoster}`)
            : 'https://images.unsplash.com/photo-1542204165-65bf26472b9b?q=80&w=1974&auto=format&fit=crop';

          const title = item.tmdb_title || item.folder_name || item.name || "Title";
          const rating = item.tmdb_rating;
          const overview = item.tmdb_overview || "Explore this amazing title on Mutflix.";
          const year = (item.release_date || item.first_air_date || "2024").substring(0, 4);
          const isActive = index === currentIndex;

          return (
            <div
              key={item.folder_name || index}
              className="relative shrink-0 w-full h-full snap-center overflow-hidden group"
            >
              {/* Image Layer with Ken Burns Effect */}
              <div className="absolute inset-0 w-full h-full overflow-hidden">
                {isAdmin && onEditPoster && (item.folder_name || item.name) && (
                  <button
                    type="button"
                    title="Edit poster (TMDB)"
                    onClick={(e) => {
                      e.stopPropagation();
                      const fn = item.folder_name || item.name;
                      onEditPoster({ ...item, name: item.name || item.folder_name, folder_name: fn });
                    }}
                    className="absolute top-4 right-4 md:top-6 md:right-8 z-[40] p-2 rounded-lg bg-black/60 hover:bg-black/85 text-white border border-white/15 opacity-90 hover:opacity-100 transition-opacity"
                  >
                    <Pencil size={18} strokeWidth={2.5} />
                  </button>
                )}
                <img
                  src={bgImage}
                  alt={title}
                  {...(index === 0
                    ? { loading: 'eager', fetchPriority: 'high', decoding: 'async' }
                    : { loading: 'lazy', decoding: 'async' })}
                  className={`w-full h-full object-cover object-[center_top] transition-opacity duration-1000 ${isActive ? 'opacity-100 animate-ken-burns' : 'opacity-0'}`}
                />

                {/* Visual Depth Masks */}
                <div className="absolute inset-x-0 bottom-0 h-[60%] bg-gradient-to-t from-[#0a0c10] via-[#0a0c10]/40 to-transparent"></div>
                <div className="absolute inset-y-0 left-0 w-[50%] bg-gradient-to-r from-[#0a0c10]/80 via-[#0a0c10]/20 to-transparent"></div>
                <div className="absolute inset-0 bg-black/20"></div>
              </div>

              {/* Content Layer with Staggered Animations */}
              <div
                className={`relative z-10 flex flex-col justify-center h-full px-8 md:px-16 pt-20 pb-12 md:pb-32 max-w-[850px] transition-all duration-700 ${isActive ? 'translate-x-0 opacity-100' : '-translate-x-12 opacity-0'}`}
              >
                {/* Badge */}
                <div className={`mb-4 w-max animate-reveal-right delay-100 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  <div className="bg-brand/90 backdrop-blur-sm text-black text-[10px] md:text-[11px] font-black px-2.5 py-1 rounded-sm uppercase tracking-widest shadow-[0_0_20px_rgba(0,220,65,0.3)]">
                    EXCLUSIVE FEATURED
                  </div>
                </div>

                {/* Title */}
                <h1 className={`text-4xl md:text-7xl font-black text-white mb-6 leading-[0.9] tracking-tighter drop-shadow-[0_10px_30px_rgba(0,0,0,0.5)] animate-reveal-right delay-200 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  {title}
                </h1>

                {/* Meta Info */}
                <div className={`flex items-center gap-4 mb-8 animate-reveal-right delay-300 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[#00dc41] font-black text-xl drop-shadow-[0_0_8px_rgba(0,220,65,0.4)]">★ {rating > 0 ? Number(rating).toFixed(1) : '8.5'}</span>
                  </div>
                  <div className="w-[1px] h-4 bg-white/20"></div>
                  <span className="text-white font-bold text-sm tracking-widest uppercase">{year}</span>
                  <div className="w-[1px] h-4 bg-white/20"></div>
                  <span className="border border-white/40 px-2 py-0.5 rounded text-[10px] text-white font-black uppercase tracking-widest">Ultra HD</span>
                  <div className="w-[1px] h-4 bg-white/20"></div>
                  <span className="text-gray-300 font-bold text-sm">
                    {item.media_type === 'tv' || item.type === 'series' || item.episodes ? 'TV Series' : 'Movie'}
                  </span>
                </div>

                {/* Description */}
                <p className={`text-white/80 text-[15px] md:text-[17px] mb-12 line-clamp-3 md:line-clamp-2 leading-relaxed max-w-2xl font-medium pr-8 drop-shadow-md animate-reveal-right delay-400 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  {overview}
                </p>

                {/* Actions */}
                <div className={`flex items-center gap-4 animate-reveal-right delay-500 ${isActive ? 'opacity-100' : 'opacity-0'}`}>
                  <button
                    onClick={() => navigate(`/detail/${encodeURIComponent(item.folder_name || title)}?type=${item.media_type === 'tv' || item.type === 'series' || item.episodes ? 'series' : 'movie'}`)}
                    className="flex items-center gap-3 bg-brand hover:bg-[#00f04a] text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest transition-all hover:scale-105 active:scale-95 group/play"
                  >
                    <Play fill="white" size={20} className="group-hover/play:scale-110 transition-transform" />
                    Watch Now
                  </button>

                  <button className="flex items-center gap-3 bg-white/5 hover:bg-white/10 backdrop-blur-xl text-white px-8 py-4 rounded-xl border border-white/10 font-black text-sm uppercase tracking-widest transition-all hover:scale-105 active:scale-95">
                    <BookmarkPlus size={20} />
                    My List
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Rotation Indicators */}
      {items && items.length > 1 && (
        <div className="absolute bottom-12 left-0 right-0 z-20 flex justify-center px-8">

          {/* Hapus class background di div ini, sisa flex gap-3 aja */}
          <div className="flex gap-3">
            {items.map((_, idx) => (
              <div
                key={idx}
                onClick={() => scrollToBanner(idx)}
                className={`h-1 cursor-pointer transition-all duration-[500ms] rounded-full shrink-0 ${idx === currentIndex ? 'w-12 bg-brand' : 'w-4 bg-white/20 hover:bg-white/40'
                  }`}
              />
            ))}
          </div>

        </div>
      )}
    </div>
  );
};

export default HeroBanner;
