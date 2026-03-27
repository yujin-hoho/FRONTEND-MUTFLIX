import { Play, BookmarkPlus } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const HeroBanner = ({ items }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const navigate = useNavigate();

  const scrollRef = useRef(null);

  // Auto rotate sync with native scroll
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
    }, 8000);
    return () => clearInterval(interval);
  }, [items, currentIndex]);

  // Handle manual scroll to update index
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

  if (!items || items.length === 0) return <div className="h-[90vh] bg-darkBG animate-pulse w-full"></div>;

  return (
    <div className="relative w-full h-[85vh] md:h-[95vh] bg-darkBG overflow-hidden group">
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
          const overview = item.tmdb_overview || "Description...";
          const year = (item.release_date || item.first_air_date || "2024").substring(0, 4);

          return (
            <div 
              key={item.id || index}
              className="relative shrink-0 w-full h-full snap-center overflow-hidden"
            >
              {/* Image Layer */}
              <div className="absolute inset-0 w-full h-full">
                <img 
                  src={bgImage} 
                  alt={title} 
                  className="w-full h-full object-cover object-[center_top]"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-[#111319]/80 via-[#111319]/20 to-transparent"></div>
                <div className="absolute inset-x-0 bottom-0 h-[50%] bg-gradient-to-t from-[#111319] via-[#111319]/40 to-transparent"></div>
              </div>
              
              {/* Content Layer */}
              <div className="relative z-10 flex flex-col justify-center h-full px-8 md:px-16 pt-20 pb-12 md:pb-32 max-w-[800px]">
                <h1 className="text-4xl md:text-6xl font-black text-white mb-4 leading-tight tracking-tight drop-shadow-2xl">
                  {title}
                </h1>
                
                <div className="flex flex-col gap-4 mb-6">
                  <div className="bg-brand text-black text-[11px] font-black px-2 py-0.5 rounded-sm w-max uppercase tracking-wider">
                    Featured
                  </div>
                  
                  <div className="flex items-center gap-3 text-sm text-gray-300 font-medium tracking-wide">
                    <span className="text-[#00dc41] font-bold text-lg">★ {rating > 0 ? Number(rating).toFixed(1) : 'NR'}</span>
                    <span className="text-gray-600">|</span>
                    <span>{year}</span>
                    <span className="text-gray-600">|</span>
                    <span>17+</span>
                    <span className="text-gray-600">|</span>
                    <span>{item.media_type === 'tv' || item.type === 'series' || item.episodes ? 'Episodes' : 'Movie'}</span>
                  </div>
                </div>
                
                <p className="text-white/90 text-[15px] mb-10 line-clamp-3 md:line-clamp-2 leading-relaxed max-w-xl pr-4 drop-shadow-lg">
                  "{overview}"
                </p>
                
                <div className="flex gap-4">
                  <button 
                    onClick={() => navigate(`/detail/${encodeURIComponent(title)}?type=${item.media_type === 'tv' || item.type === 'series' || item.episodes ? 'series' : 'movie'}`)}
                    className="bg-brand hover:brightness-[1.15] text-white rounded-full h-[54px] w-[54px] flex items-center justify-center transition-all hover:scale-110 active:scale-95 shadow-[0_0_25px_rgba(0,220,65,0.5)]"
                  >
                    <Play fill="black" size={26} className="ml-1 text-black" />
                  </button>
                  <button className="bg-white/10 hover:bg-white/20 backdrop-blur-md text-white rounded-full h-[54px] w-[54px] border border-white/20 flex items-center justify-center transition-all hover:scale-110 active:scale-95">
                    <BookmarkPlus size={26} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Rotation Indicators - Centered and Scrollable if needed */}
      {items && items.length > 1 && (
        <div className="absolute bottom-10 left-0 right-0 z-20 flex justify-center px-8">
          <div className="flex gap-2.5 overflow-x-auto no-scrollbar max-w-full pb-1">
            {items.map((_, idx) => (
              <div 
                key={idx} 
                onClick={() => scrollToBanner(idx)}
                className={`h-1.5 cursor-pointer transition-all duration-[400ms] rounded-full shrink-0 ${
                  idx === currentIndex ? 'w-10 bg-brand shadow-[0_0_10px_rgba(0,220,65,0.6)]' : 'w-5 bg-white/20 hover:bg-white/40'
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
